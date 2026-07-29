import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  stat,
  statfs,
} from "node:fs/promises";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Plugin } from "vite";
import { OVERWORLD_LOD3_AVAILABLE_BANDS } from "../app/lib/overworld-coverage-data.ts";
import {
  AtlasWorkspaceError,
  LocalAtlasWorkspaceStore,
  MAX_ATLAS_WORKSPACE_BYTES,
  atlasWorkspaceEtag,
  parseAtlasWorkspaceEtag,
} from "./local-atlas-workspace.ts";
import {
  LocalAtlasXaeroExporter,
  XaeroExportError,
  type XaeroExportSelection,
} from "./local-atlas-xaero.ts";

const STATUS_ENDPOINT = "/api/local-atlas/status";
const COVERAGE_ENDPOINT = "/api/local-atlas/coverage";
const REGION_STATUS_ENDPOINT = "/api/local-atlas/region-status";
const DOWNLOAD_ENDPOINT = "/api/local-atlas/download";
const STOP_ENDPOINT = "/api/local-atlas/stop";
const WORKSPACE_ENDPOINT = "/api/local-atlas/workspace";
const XAERO_PREVIEW_ENDPOINT = "/api/local-atlas/xaero-export/preview";
const XAERO_EXPORT_ENDPOINT = "/api/local-atlas/xaero-export";
const TILE_ENDPOINT = "/api/tile";
const TILE_SIZE_PIXELS = 512;
const TILES_PER_SHARD = 32;
const WORLD_BORDER_BLOCKS = 30_000_000;
const MAX_REQUEST_BODY_BYTES = 32_768;
const MAX_TILE_BYTES = 16 * 1024 * 1024;
const MAX_REGION_CELLS = 1_048_576;
const MAX_REGION_TILES = MAX_REGION_CELLS * 3;
const MAX_REGION_REQUESTS_PER_SECOND = 16;
const MAX_REGION_COOLDOWN_SECONDS = 15 * 60;
const RATE_METRIC_TOLERANCE = 0.001;
const DEFAULT_ESTIMATED_TILE_BYTES = 512 * 1024;
const MIN_ESTIMATED_TILE_BYTES = 64 * 1024;
const MAX_ESTIMATED_TILE_BYTES = 2 * 1024 * 1024;
const STOP_GRACE_PERIOD_MS = 15_000;
const ALLOWED_LAYERS = new Set(["base", "overlay", "newchunks"]);
const CANONICAL_LAYERS = ["base", "overlay", "newchunks"] as const;
const INTEGER_PATTERN = /^[+-]?\d+$/;
const LOCAL_COVERAGE_QUERY = String.raw`
import json
import sqlite3
import sys

database_paths = json.loads(sys.argv[1])
lod = int(sys.argv[2])
target_runs = json.loads(sys.argv[3])
tile_span = 512 * (2 ** lod)
sector_tiles = 32768 // tile_span
grid_min_tile = -540672 // tile_span
grid_max_tile = grid_min_tile + (33 * sector_tiles)
runs_by_lod = {}
for (
    target_lod,
    min_tile_z,
    max_tile_z_exclusive,
    min_tile_x,
    max_tile_x_exclusive,
) in target_runs:
    runs_by_lod.setdefault(int(target_lod), []).append(
        (
            int(min_tile_z),
            int(max_tile_z_exclusive),
            int(min_tile_x),
            int(max_tile_x_exclusive),
        )
    )

def is_target_tile(target_lod, tile_x, tile_z):
    return any(
        min_tile_z <= tile_z < max_tile_z_exclusive
        and min_tile_x <= tile_x < max_tile_x_exclusive
        for (
            min_tile_z,
            max_tile_z_exclusive,
            min_tile_x,
            max_tile_x_exclusive,
        ) in runs_by_lod.get(target_lod, ())
    )

pending_statuses = {
    "pending",
    "downloading",
    "retry",
    "running",
}
counts_by_cell = {}

# An absent ancestor prunes its entire descendant branch, so those finer rows
# are intentionally never materialized. Project every non-shadowed 404 into
# target-LOD tile equivalents and deduplicate stale nested absences.
absent_by_lod = {
    ancestor_lod: set()
    for ancestor_lod in range(lod, 4)
}
seen_catalog_tiles = set()

def consume_row(row):
    target_lod, tile_x, tile_z, status = row
    target_lod = int(target_lod)
    tile_x = int(tile_x)
    tile_z = int(tile_z)
    key = (target_lod, tile_x, tile_z)
    if key in seen_catalog_tiles:
        return
    seen_catalog_tiles.add(key)
    if not is_target_tile(target_lod, tile_x, tile_z):
        return
    if target_lod == lod:
        column = (tile_x - grid_min_tile) // sector_tiles
        row_index = (tile_z - grid_min_tile) // sector_tiles
        if 0 <= row_index < 33 and 0 <= column < 33:
            counts = counts_by_cell.setdefault(
                (row_index, column),
                {
                    "completeCount": 0,
                    "queuedCount": 0,
                    "failedCount": 0,
                },
            )
            if status == "complete":
                counts["completeCount"] += 1
            elif status in pending_statuses:
                counts["queuedCount"] += 1
            elif status != "absent":
                counts["failedCount"] += 1
    if status == "absent":
        absent_by_lod[target_lod].add((tile_x, tile_z))

# Catalogs are ordered primary -> regional. Read them in reverse so the first
# row seen for an exact tile identity is the authoritative regional row. Only
# higher-priority overlays need their full LOD range materialized; the large
# primary catalog is reduced by indexed queries to the requested LOD plus its
# sparse 404 ancestors.
for catalog_index in range(len(database_paths) - 1, -1, -1):
    database_path = database_paths[catalog_index]
    connection = sqlite3.connect(
        f"file:{database_path}?mode=ro",
        uri=True,
        timeout=2.5,
    )
    connection.execute("PRAGMA query_only = ON")
    if catalog_index > 0:
        rows = connection.execute(
            """
            SELECT lod, tile_x, tile_z, status
            FROM tiles
            WHERE dimension = 'overworld'
              AND layer = 'base'
              AND lod >= ?
              AND lod <= 3
            """,
            (lod,),
        )
        for row in rows:
            consume_row(row)
    else:
        rows = connection.execute(
            """
            SELECT lod, tile_x, tile_z, status
            FROM tiles
            WHERE dimension = 'overworld'
              AND layer = 'base'
              AND lod = ?
            """,
            (lod,),
        )
        for row in rows:
            consume_row(row)
        absent_rows = connection.execute(
            """
            SELECT lod, tile_x, tile_z, status
            FROM tiles
            WHERE dimension = 'overworld'
              AND layer = 'base'
              AND lod >= ?
              AND lod <= 3
              AND status = 'absent'
            """,
            (lod,),
        )
        for row in absent_rows:
            consume_row(row)
    connection.close()

excluded_by_cell = {}
for ancestor_lod in range(3, lod - 1, -1):
    descendant_scale = 2 ** (ancestor_lod - lod)
    excluded_weight = descendant_scale * descendant_scale
    for tile_x, tile_z in absent_by_lod[ancestor_lod]:
        shadowed = any(
            (
                tile_x // (2 ** (parent_lod - ancestor_lod)),
                tile_z // (2 ** (parent_lod - ancestor_lod)),
            )
            in absent_by_lod[parent_lod]
            for parent_lod in range(ancestor_lod + 1, 4)
        )
        if shadowed:
            continue
        target_tile_x = tile_x * descendant_scale
        target_tile_z = tile_z * descendant_scale
        column = (target_tile_x - grid_min_tile) // sector_tiles
        row = (target_tile_z - grid_min_tile) // sector_tiles
        if 0 <= row < 33 and 0 <= column < 33:
            key = (row, column)
            excluded_by_cell[key] = (
                excluded_by_cell.get(key, 0) + excluded_weight
            )

cells = []
for row, column in sorted(set(counts_by_cell) | set(excluded_by_cell)):
    counts = counts_by_cell.get(
        (row, column),
        {
            "completeCount": 0,
            "queuedCount": 0,
            "failedCount": 0,
        },
    )
    cells.append(
        {
            "row": row,
            "column": column,
            **counts,
            "absentCount": excluded_by_cell.get((row, column), 0),
        }
    )
print(json.dumps(cells, separators=(",", ":")))
`;
const MAX_LOCAL_COVERAGE_BYTES = 512 * 1024;
const LOCAL_COVERAGE_QUERY_TIMEOUT_MS = 15_000;
const MAX_LOCAL_REGION_STATUS_BYTES = 64 * 1024 * 1024;
const LOCAL_REGION_STATUS_QUERY_TIMEOUT_MS = 120_000;
const MAX_LOCAL_ARCHIVE_BYTES_OUTPUT = 64;
const LOCAL_ARCHIVE_BYTES_QUERY_TIMEOUT_MS = 15_000;

const LOCAL_ARCHIVE_BYTES_QUERY = String.raw`
import sqlite3
import sys

database_path = sys.argv[1]
connection = sqlite3.connect(
    f"file:{database_path}?mode=ro",
    uri=True,
    timeout=5,
)
connection.execute("PRAGMA query_only = ON")
row = connection.execute(
    """
    SELECT SUM(size_bytes)
    FROM tiles
    WHERE status = 'complete'
    """
).fetchone()
connection.close()
value = 0 if row is None or row[0] is None else row[0]
if isinstance(value, bool) or not isinstance(value, int) or value < 0:
    raise ValueError("invalid archive byte total")
print(value)
`;

const LOCAL_REGION_STATUS_QUERY = String.raw`
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

database_path = sys.argv[1]
tile_root = Path(sys.argv[2]).resolve()
min_tile_x = int(sys.argv[3])
min_tile_z = int(sys.argv[4])
max_tile_x_exclusive = int(sys.argv[5])
max_tile_z_exclusive = int(sys.argv[6])
layers = json.loads(sys.argv[7])
maximum_tile_bytes = int(sys.argv[8])

placeholders = ",".join("?" for _ in layers)
connection = sqlite3.connect(
    f"file:{database_path}?mode=ro",
    uri=True,
    timeout=5,
)
connection.execute("PRAGMA query_only = ON")
rows = connection.execute(
    f"""
    SELECT
      layer,
      tile_x,
      tile_z,
      status,
      relative_path,
      size_bytes,
      http_code,
      sha256
    FROM tiles
    WHERE dimension = 'overworld'
      AND lod = 0
      AND layer IN ({placeholders})
      AND tile_x >= ?
      AND tile_x < ?
      AND tile_z >= ?
      AND tile_z < ?
    ORDER BY tile_z, tile_x, layer
    """,
    (
      *layers,
      min_tile_x,
      max_tile_x_exclusive,
      min_tile_z,
      max_tile_z_exclusive,
    ),
).fetchall()
connection.close()

pending_statuses = {
    "pending",
    "downloading",
    "retry",
    "running",
}
complete_count = 0
absent_count = 0
pending_count = 0
failed_count = 0
missing_complete_count = 0
valid_complete_bytes = 0
absent_cells = []
row_count = 0

def validate_complete(relative_path, expected_size, expected_sha256):
    if (
        not isinstance(expected_size, int)
        or expected_size < 12
        or expected_size > maximum_tile_bytes
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
    ):
        return ("failed", 0)
    try:
        bytes.fromhex(expected_sha256)
    except ValueError:
        return ("failed", 0)
    try:
        candidate = (tile_root / str(relative_path)).resolve()
        candidate.relative_to(tile_root)
    except (OSError, ValueError):
        return ("failed", 0)
    try:
        metadata = candidate.stat()
    except FileNotFoundError:
        return ("missing", 0)
    except OSError:
        return ("failed", 0)
    if (
        not candidate.is_file()
        or metadata.st_size < 12
        or metadata.st_size > maximum_tile_bytes
        or expected_size != metadata.st_size
    ):
        return ("failed", 0)
    try:
        with candidate.open("rb") as handle:
            header = handle.read(12)
            digest = hashlib.sha256()
            digest.update(header)
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        after_metadata = candidate.stat()
    except OSError:
        return ("failed", 0)
    if (
        len(header) != 12
        or header[:4] != b"RIFF"
        or header[8:12] != b"WEBP"
        or int.from_bytes(header[4:8], "little") + 8 != metadata.st_size
        or digest.hexdigest().lower() != expected_sha256.lower()
        or after_metadata.st_size != metadata.st_size
        or after_metadata.st_mtime_ns != metadata.st_mtime_ns
        or after_metadata.st_ino != metadata.st_ino
    ):
        return ("failed", 0)
    return ("complete", metadata.st_size)

def validate_absent(relative_path, http_code):
    if http_code != 404:
        return False
    try:
        candidate = (tile_root / str(relative_path)).resolve()
        candidate.relative_to(tile_root)
    except (OSError, ValueError):
        return False
    try:
        candidate.stat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False

for (
    layer,
    tile_x,
    tile_z,
    status,
    relative_path,
    size_bytes,
    http_code,
    sha256,
) in rows:
    row_count += 1
    if status == "complete":
        file_status, file_size = validate_complete(
            relative_path,
            size_bytes,
            sha256,
        )
        if file_status == "complete":
            complete_count += 1
            valid_complete_bytes += file_size
        elif file_status == "missing":
            missing_complete_count += 1
        else:
            failed_count += 1
    elif status == "absent" and validate_absent(relative_path, http_code):
        absent_count += 1
        if layer == "base":
            absent_cells.append(
                {
                    "tileX": int(tile_x),
                    "tileZ": int(tile_z),
                }
            )
    elif status in pending_statuses:
        pending_count += 1
    else:
        failed_count += 1

connection.close()
print(
    json.dumps(
        {
            "rowCount": row_count,
            "completeCount": complete_count,
            "absentCount": absent_count,
            "pendingCount": pending_count,
            "failedCount": failed_count,
            "missingCompleteCount": missing_complete_count,
            "validCompleteBytes": valid_complete_bytes,
            "absentCells": absent_cells,
        },
        separators=(",", ":"),
    )
)
`;

function localCoverageTargetRuns(
  lod: number,
): readonly (readonly [
  targetLod: number,
  minTileZ: number,
  maxTileZExclusive: number,
  minTileX: number,
  maxTileXExclusive: number,
])[] {
  return Array.from({ length: 4 - lod }, (_, offset) => lod + offset).flatMap(
    (targetLod) => {
      const scale = 2 ** (3 - targetLod);
      return OVERWORLD_LOD3_AVAILABLE_BANDS.flatMap((band) =>
        band.xRuns.map(
          ([minTileX, maxTileXExclusive]) =>
            [
              targetLod,
              band.minTileZ * scale,
              band.maxTileZExclusive * scale,
              minTileX * scale,
              maxTileXExclusive * scale,
            ] as const,
        ),
      );
    },
  );
}

type MiddlewareNext = (error?: unknown) => void;

export interface LocalAtlasOptions {
  readonly tileRoot?: string;
  readonly regionalTileRoot?: string;
  readonly backingRoot?: string;
  readonly minecraftRoot?: string;
  readonly minecraftOpenProbe?: (lockPath: string) => Promise<boolean>;
  readonly pythonBin?: string;
  readonly projectRoot?: string;
  readonly overworldRequirementBytes?: number;
}

export interface RegionDownloadRequest {
  readonly xMin: number;
  readonly zMin: number;
  readonly xMaxExclusive: number;
  readonly zMaxExclusive: number;
  readonly lod: 0;
  readonly layers: readonly ("base" | "overlay" | "newchunks")[];
  readonly requestsPerSecond: number;
}

export interface LocalRegionStatusRequest {
  readonly bounds: {
    readonly minX: number;
    readonly minZ: number;
    readonly maxXExclusive: number;
    readonly maxZExclusive: number;
  };
  readonly lod: 0;
  readonly layers: readonly ("base" | "overlay" | "newchunks")[];
}

export interface LocalRegionStatusResult {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly lod: 0;
  readonly bounds: LocalRegionStatusRequest["bounds"];
  readonly layers: LocalRegionStatusRequest["layers"];
  readonly totalCount: number;
  readonly resolvedCount: number;
  readonly completeCount: number;
  readonly absentCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  readonly missingCount: number;
  readonly percent: number;
  readonly ready: boolean;
  readonly databaseUpdatedAt: string | null;
  readonly absentCells: readonly {
    readonly tileX: number;
    readonly tileZ: number;
  }[];
}

interface LocalRegionStatusInventory {
  readonly result: LocalRegionStatusResult;
  readonly validCompleteBytes: number;
}

interface LocalRegionStatusQueryPayload {
  readonly rowCount: number;
  readonly completeCount: number;
  readonly absentCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  readonly missingCompleteCount: number;
  readonly validCompleteBytes: number;
  readonly absentCells: readonly {
    readonly tileX: number;
    readonly tileZ: number;
  }[];
}

type JobStatus =
  | "running"
  | "stopping"
  | "complete"
  | "stopped"
  | "error";

interface LocalJobProgress {
  readonly requested: number;
  readonly processed: number;
  readonly complete: number;
  readonly absent: number;
  readonly failed: number;
  readonly reused: number;
  readonly reusedAbsent: number;
  readonly downloadedBytes: number;
  readonly percent: number;
  readonly status: "running" | "complete" | "error" | "interrupted";
  readonly requestAttempts?: number;
  readonly elapsedSeconds?: number;
  readonly tilesPerSecond?: number;
  readonly bytesPerSecond?: number;
  readonly etaSeconds?: number | null;
  readonly effectiveRps?: number;
  readonly targetRps?: number;
  readonly cooldownSeconds?: number;
  readonly cooldownUntil?: string | null;
  readonly networkRequested?: number | null;
  readonly networkProcessed?: number;
  readonly resolvedPerSecond?: number;
  readonly networkTilesPerSecond?: number;
  readonly achievedRps?: number;
}

interface LocalJob {
  readonly id: string;
  status: JobStatus;
  readonly request: RegionDownloadRequest;
  readonly startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  message: string;
  progress: LocalJobProgress;
}

interface RuntimeState {
  job: LocalJob | null;
  child: ChildProcess | null;
  stopTimer: NodeJS.Timeout | null;
}

interface LocalCoverageResult {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly layer: "base";
  readonly lod: number;
  readonly databaseUpdatedAt: string;
  readonly cells: readonly {
    readonly row: number;
    readonly column: number;
    readonly completeCount: number;
    readonly queuedCount: number;
    readonly failedCount: number;
    readonly absentCount: number;
  }[];
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", String(body.byteLength));
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(body);
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end();
}

function writeWorkspaceError(
  response: ServerResponse,
  error: unknown,
): void {
  if (error instanceof RangeError) {
    writeJson(response, 413, { error: error.message });
    return;
  }
  if (error instanceof TypeError) {
    writeJson(response, 400, { error: error.message });
    return;
  }
  if (!(error instanceof AtlasWorkspaceError)) {
    writeJson(response, 500, {
      error: "No se pudo acceder al workspace local",
    });
    return;
  }

  const statusCode =
    error.code === "WORKSPACE_CONFLICT"
      ? 412
      : error.code === "WORKSPACE_TOO_LARGE"
        ? 413
        : error.code === "WORKSPACE_LOCKED"
          ? 423
          : error.code === "INVALID_WORKSPACE"
            ? 400
            : 503;
  writeJson(
    response,
    statusCode,
    {
      error: error.message,
      code: error.code,
      ...(error.current
        ? {
            currentRevision: error.current.revision,
            current: error.current,
          }
        : {}),
    },
    error.current
      ? {
          ETag: atlasWorkspaceEtag(
            error.current.workspaceId,
            error.current.revision,
          ),
        }
      : undefined,
  );
}

function writeXaeroError(
  response: ServerResponse,
  error: unknown,
): void {
  if (error instanceof RangeError) {
    writeJson(response, 413, { error: error.message });
    return;
  }
  if (error instanceof TypeError) {
    writeJson(response, 400, { error: error.message });
    return;
  }
  if (!(error instanceof XaeroExportError)) {
    writeJson(response, 500, {
      error: "No se pudo preparar la exportación a Xaero",
    });
    return;
  }
  const statusCode =
    error.code === "XAERO_MINECRAFT_OPEN" ||
    error.code === "XAERO_LOCKED"
      ? 423
      : error.code === "XAERO_STALE_PREVIEW"
        ? 409
        : error.code === "XAERO_NO_CHANGES"
          ? 409
          : error.code === "XAERO_INVALID_FILE" ||
              error.code === "XAERO_MANIFEST_INVALID"
            ? 422
            : error.code === "XAERO_RECOVERY_CONFLICT"
              ? 409
              : 503;
  writeJson(response, statusCode, {
    error: error.message,
    code: error.code,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(address) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)
  );
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHost(parsed.host) &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}

function requestPath(request: IncomingMessage): string | null {
  if (!request.url) return null;
  try {
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function parseXaeroSelection(
  operationValue: unknown,
  scopeValue: unknown,
  explorationIdValue: unknown,
): XaeroExportSelection {
  const operation =
    operationValue === undefined ? "export" : operationValue;
  const scope =
    scopeValue === undefined ? "all" : scopeValue;
  if (!(operation === "export" || operation === "remove")) {
    throw new TypeError("operation debe ser export o remove");
  }
  if (!(scope === "all" || scope === "exploration")) {
    throw new TypeError("scope debe ser all o exploration");
  }
  if (scope === "all") {
    if (
      explorationIdValue !== undefined &&
      explorationIdValue !== null &&
      explorationIdValue !== ""
    ) {
      throw new TypeError(
        "explorationId no corresponde al alcance global",
      );
    }
    return { operation, scope };
  }
  if (
    typeof explorationIdValue !== "string" ||
    explorationIdValue.length === 0 ||
    explorationIdValue.length > 100
  ) {
    throw new TypeError(
      "explorationId es obligatorio para el alcance regional",
    );
  }
  return {
    operation,
    scope,
    explorationId: explorationIdValue,
  };
}

function parseXaeroPreviewSelection(
  requestUrl: string | undefined,
): XaeroExportSelection {
  if (!requestUrl) {
    return { operation: "export", scope: "all" };
  }
  const parsed = new URL(requestUrl, "http://localhost");
  const allowed = new Set([
    "operation",
    "scope",
    "explorationId",
  ]);
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      throw new TypeError(
        "La previsualización Xaero contiene filtros inválidos",
      );
    }
  }
  return parseXaeroSelection(
    parsed.searchParams.get("operation") ?? undefined,
    parsed.searchParams.get("scope") ?? undefined,
    parsed.searchParams.get("explorationId") ?? undefined,
  );
}

function requireLocalRequest(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (
    !isLoopbackAddress(request.socket.remoteAddress) ||
    !isLoopbackHost(request.headers.host) ||
    !isAllowedOrigin(request.headers.origin, request.headers.host)
  ) {
    writeJson(response, 403, { error: "Disponible solo desde localhost" });
    return false;
  }
  return true;
}

function safeInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${name} no es un entero válido`);
  }
  return value;
}

function canonicalRegionLayers(
  value: unknown,
): LocalRegionStatusRequest["layers"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Selecciona al menos una capa");
  }
  const requested = new Set(value);
  if (
    requested.size > ALLOWED_LAYERS.size ||
    [...requested].some(
      (layer) => typeof layer !== "string" || !ALLOWED_LAYERS.has(layer),
    )
  ) {
    throw new TypeError("Las capas solicitadas no son válidas");
  }
  if (!requested.has("base")) {
    throw new TypeError("La descarga regional siempre incluye la capa base");
  }
  return CANONICAL_LAYERS.filter((layer) => requested.has(layer));
}

function validateLod0Region(
  minXValue: unknown,
  minZValue: unknown,
  maxXExclusiveValue: unknown,
  maxZExclusiveValue: unknown,
): {
  readonly bounds: LocalRegionStatusRequest["bounds"];
  readonly cellCount: number;
} {
  const minX = safeInteger(
    minXValue,
    "minX",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const minZ = safeInteger(
    minZValue,
    "minZ",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const maxXExclusive = safeInteger(
    maxXExclusiveValue,
    "maxXExclusive",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const maxZExclusive = safeInteger(
    maxZExclusiveValue,
    "maxZExclusive",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  if (maxXExclusive <= minX || maxZExclusive <= minZ) {
    throw new TypeError("La región debe tener ancho y alto positivos");
  }
  if (
    minX % TILE_SIZE_PIXELS !== 0 ||
    minZ % TILE_SIZE_PIXELS !== 0 ||
    maxXExclusive % TILE_SIZE_PIXELS !== 0 ||
    maxZExclusive % TILE_SIZE_PIXELS !== 0
  ) {
    throw new TypeError("La región debe estar alineada con su rejilla de tiles");
  }
  const columns = (maxXExclusive - minX) / TILE_SIZE_PIXELS;
  const rows = (maxZExclusive - minZ) / TILE_SIZE_PIXELS;
  const cellCount = columns * rows;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > MAX_REGION_CELLS
  ) {
    throw new TypeError(
      `Una región local admite como máximo ${MAX_REGION_CELLS.toLocaleString("en-US")} celdas LOD 0`,
    );
  }
  return {
    bounds: {
      minX,
      minZ,
      maxXExclusive,
      maxZExclusive,
    },
    cellCount,
  };
}

export function parseRegionDownloadRequest(
  value: unknown,
): RegionDownloadRequest {
  if (!isRecord(value)) {
    throw new TypeError("La solicitud debe ser un objeto JSON");
  }

  const requestedLod = safeInteger(value.lod, "lod", 0, 10);
  if (requestedLod !== 0) {
    throw new TypeError("La descarga regional usa únicamente LOD 0");
  }
  const lod = 0 as const;
  const { bounds, cellCount } = validateLod0Region(
    value.xMin,
    value.zMin,
    value.xMaxExclusive,
    value.zMaxExclusive,
  );
  const layers = canonicalRegionLayers(value.layers);

  const requestsPerSecond = value.requestsPerSecond;
  if (
    typeof requestsPerSecond !== "number" ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond < 0.25 ||
    requestsPerSecond > MAX_REGION_REQUESTS_PER_SECOND
  ) {
    throw new TypeError(
      `El ritmo debe estar entre 0.25 y ${MAX_REGION_REQUESTS_PER_SECOND} solicitudes por segundo`,
    );
  }

  const tileCount = cellCount * layers.length;
  if (tileCount > MAX_REGION_TILES) {
    throw new TypeError(
      `Una operación local admite como máximo ${MAX_REGION_TILES.toLocaleString("en-US")} tiles`,
    );
  }

  return {
    xMin: bounds.minX,
    zMin: bounds.minZ,
    xMaxExclusive: bounds.maxXExclusive,
    zMaxExclusive: bounds.maxZExclusive,
    lod,
    layers,
    requestsPerSecond,
  };
}

export function parseLocalRegionStatusRequest(
  url: string | undefined,
): LocalRegionStatusRequest | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname !== REGION_STATUS_ENDPOINT) return null;
    const expectedParameters = new Set([
      "xMin",
      "zMin",
      "xMaxExclusive",
      "zMaxExclusive",
      "lod",
      "layers",
    ]);
    if (
      [...parsed.searchParams.keys()].some(
        (parameter) => !expectedParameters.has(parameter),
      ) ||
      [...expectedParameters].some(
        (parameter) => parsed.searchParams.getAll(parameter).length !== 1,
      )
    ) {
      return null;
    }
    const readInteger = (name: string): number | null => {
      const value = parsed.searchParams.get(name);
      if (value === null || !INTEGER_PATTERN.test(value)) return null;
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : null;
    };
    const lod = readInteger("lod");
    if (lod !== 0) return null;
    const minX = readInteger("xMin");
    const minZ = readInteger("zMin");
    const maxXExclusive = readInteger("xMaxExclusive");
    const maxZExclusive = readInteger("zMaxExclusive");
    if (
      minX === null ||
      minZ === null ||
      maxXExclusive === null ||
      maxZExclusive === null
    ) {
      return null;
    }
    const layersText = parsed.searchParams.get("layers");
    if (layersText === null) return null;
    const layers = canonicalRegionLayers(layersText.split(","));
    const { bounds } = validateLod0Region(
      minX,
      minZ,
      maxXExclusive,
      maxZExclusive,
    );
    return { bounds, lod: 0, layers };
  } catch {
    return null;
  }
}

export function parseLocalCoverageRequest(
  url: string | undefined,
): { readonly lod: number } | null {
  if (!url) return null;
  const parsed = new URL(url, "http://localhost");
  if (parsed.pathname !== COVERAGE_ENDPOINT) return null;
  const lodText = parsed.searchParams.get("lod");
  if (
    lodText === null ||
    !/^\d$/.test(lodText) ||
    parsed.searchParams.get("layer") !== "base"
  ) {
    return null;
  }
  const lod = Number(lodText);
  return lod >= 0 && lod <= 3 ? { lod } : null;
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw new TypeError("Content-Type debe ser application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) {
      throw new RangeError("La solicitud supera el tamaño permitido");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("La solicitud no contiene JSON válido");
  }
}

async function readLegacyArchiveBytes(tileRoot: string): Promise<number> {
  try {
    const value = JSON.parse(
      await readFile(resolve(tileRoot, "progress.json"), "utf8"),
    ) as unknown;
    if (isRecord(value)) {
      for (const field of ["space_used_bytes", "data_downloaded_bytes"]) {
        const bytes = value[field];
        if (
          typeof bytes === "number" &&
          Number.isSafeInteger(bytes) &&
          bytes >= 0
        ) {
          return bytes;
        }
      }
    }
  } catch {
    // A capacity snapshot can still be useful without legacy size metadata.
  }
  return 0;
}

async function queryLocalArchiveBytes(
  tileRoot: string,
  pythonBin: string,
): Promise<number> {
  const databasePath = resolve(tileRoot, "tiles.sqlite3");
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(
      pythonBin,
      ["-c", LOCAL_ARCHIVE_BYTES_QUERY, databasePath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          VIRTUAL_ENV: process.env.VIRTUAL_ENV,
          PYTHONUNBUFFERED: "1",
        },
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        rejectPromise(
          new Error("La lectura del almacenamiento local superó el tiempo límite"),
        ),
      );
    }, LOCAL_ARCHIVE_BYTES_QUERY_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_LOCAL_ARCHIVE_BYTES_OUTPUT) {
        child.kill("SIGTERM");
        finish(() =>
          rejectPromise(
            new Error("La métrica de almacenamiento local no es válida"),
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(error));
    });
    child.once("exit", (code) => {
      finish(() => {
        if (code !== 0) {
          rejectPromise(
            new Error(
              stderr.trim() ||
                "No se pudo calcular el almacenamiento del catálogo local",
            ),
          );
          return;
        }
        const output = Buffer.concat(stdout).toString("utf8").trim();
        if (!/^\d+$/.test(output)) {
          rejectPromise(
            new Error("La métrica de almacenamiento local no es válida"),
          );
          return;
        }
        const bytes = Number(output);
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          rejectPromise(
            new Error("La métrica de almacenamiento local no es segura"),
          );
          return;
        }
        resolvePromise(bytes);
      });
    });
  });
}

async function readLocalCatalogSnapshot(
  tileRoot: string,
): Promise<{
  readonly fingerprint: string;
  readonly updatedAt: string;
} | null> {
  const databasePath = resolve(tileRoot, "tiles.sqlite3");
  let databaseStat: Awaited<ReturnType<typeof stat>>;
  try {
    databaseStat = await stat(databasePath);
  } catch {
    return null;
  }
  if (!databaseStat.isFile()) {
    throw new Error("El catálogo local de tiles no es un archivo");
  }
  let walStat: Awaited<ReturnType<typeof stat>> | null;
  try {
    walStat = await stat(`${databasePath}-wal`);
  } catch {
    walStat = null;
  }
  const updatedAtMs = Math.max(
    databaseStat.mtimeMs,
    walStat?.mtimeMs ?? 0,
  );
  return {
    fingerprint: [
      `${databaseStat.size}:${databaseStat.mtimeMs}`,
      walStat ? `${walStat.size}:${walStat.mtimeMs}` : "missing",
    ].join("|"),
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

function isCoverageCell(value: unknown): value is LocalCoverageResult["cells"][number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.row === "number" &&
    Number.isSafeInteger(value.row) &&
    value.row >= 0 &&
    value.row < 33 &&
    typeof value.column === "number" &&
    Number.isSafeInteger(value.column) &&
    value.column >= 0 &&
    value.column < 33 &&
    typeof value.completeCount === "number" &&
    Number.isSafeInteger(value.completeCount) &&
    value.completeCount >= 0 &&
    typeof value.queuedCount === "number" &&
    Number.isSafeInteger(value.queuedCount) &&
    value.queuedCount >= 0 &&
    typeof value.failedCount === "number" &&
    Number.isSafeInteger(value.failedCount) &&
    value.failedCount >= 0 &&
    typeof value.absentCount === "number" &&
    Number.isSafeInteger(value.absentCount) &&
    value.absentCount >= 0
  );
}

async function queryLocalCoverage(
  catalogRoots: readonly string[],
  pythonBin: string,
  lod: number,
  databaseUpdatedAt: string,
): Promise<LocalCoverageResult> {
  const catalogs = await Promise.all(
    catalogRoots.map(async (catalogRoot) => {
      const databasePath = resolve(catalogRoot, "tiles.sqlite3");
      const databaseStat = await stat(databasePath);
      if (!databaseStat.isFile()) {
        throw new Error("El catálogo local de tiles no es un archivo");
      }
      return { databasePath, databaseStat };
    }),
  );
  if (catalogs.length === 0) {
    throw new Error("No hay catálogos locales de tiles");
  }

  const cells = await new Promise<LocalCoverageResult["cells"]>(
    (resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(
        pythonBin,
        [
          "-c",
          LOCAL_COVERAGE_QUERY,
          JSON.stringify(
            catalogs.map((catalog) => catalog.databasePath),
          ),
          String(lod),
          JSON.stringify(localCoverageTargetRuns(lod)),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            VIRTUAL_ENV: process.env.VIRTUAL_ENV,
            SSL_CERT_FILE: process.env.SSL_CERT_FILE,
            REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            NO_PROXY: process.env.NO_PROXY,
            PYTHONUNBUFFERED: "1",
          },
        },
      );
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const finish = (
        callback: () => void,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          rejectPromise(
            new Error("La lectura de cobertura local superó el tiempo límite"),
          ),
        );
      }, LOCAL_COVERAGE_QUERY_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_LOCAL_COVERAGE_BYTES) {
          child.kill("SIGTERM");
          finish(() =>
            rejectPromise(
              new Error("La cobertura local supera el tamaño permitido"),
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4_096) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        finish(() => rejectPromise(error));
      });
      child.once("exit", (code) => {
        finish(() => {
          if (code !== 0) {
            rejectPromise(
              new Error(
                stderr.trim() || "No se pudo leer el catálogo local de tiles",
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(stdout).toString("utf8"),
            ) as unknown;
            if (!Array.isArray(parsed) || !parsed.every(isCoverageCell)) {
              throw new Error("La cobertura local no tiene un formato válido");
            }
            resolvePromise(Object.freeze(parsed));
          } catch (error) {
            rejectPromise(
              error instanceof Error
                ? error
                : new Error("La cobertura local no contiene JSON válido"),
            );
          }
        });
      });
    },
  );

  return Object.freeze({
    version: 1,
    dimension: "overworld",
    layer: "base",
    lod,
    databaseUpdatedAt,
    cells,
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseLocalRegionStatusQueryPayload(
  value: unknown,
  request: LocalRegionStatusRequest,
  totalCount: number,
): LocalRegionStatusQueryPayload {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.rowCount) ||
    !isNonNegativeSafeInteger(value.completeCount) ||
    !isNonNegativeSafeInteger(value.absentCount) ||
    !isNonNegativeSafeInteger(value.pendingCount) ||
    !isNonNegativeSafeInteger(value.failedCount) ||
    !isNonNegativeSafeInteger(value.missingCompleteCount) ||
    !isNonNegativeSafeInteger(value.validCompleteBytes) ||
    !Array.isArray(value.absentCells)
  ) {
    throw new Error("El estado regional local no tiene un formato válido");
  }
  const classifiedRows =
    value.completeCount +
    value.absentCount +
    value.pendingCount +
    value.failedCount +
    value.missingCompleteCount;
  if (
    value.rowCount > totalCount ||
    classifiedRows !== value.rowCount ||
    value.validCompleteBytes > value.completeCount * MAX_TILE_BYTES
  ) {
    throw new Error("El estado regional local contiene contadores inválidos");
  }
  const seenAbsentCells = new Set<string>();
  const absentCells: Array<{ readonly tileX: number; readonly tileZ: number }> =
    [];
  const minTileX = request.bounds.minX / TILE_SIZE_PIXELS;
  const minTileZ = request.bounds.minZ / TILE_SIZE_PIXELS;
  const maxTileXExclusive =
    request.bounds.maxXExclusive / TILE_SIZE_PIXELS;
  const maxTileZExclusive =
    request.bounds.maxZExclusive / TILE_SIZE_PIXELS;
  for (const cell of value.absentCells) {
    if (
      !isRecord(cell) ||
      typeof cell.tileX !== "number" ||
      !Number.isSafeInteger(cell.tileX) ||
      typeof cell.tileZ !== "number" ||
      !Number.isSafeInteger(cell.tileZ) ||
      cell.tileX < minTileX ||
      cell.tileX >= maxTileXExclusive ||
      cell.tileZ < minTileZ ||
      cell.tileZ >= maxTileZExclusive
    ) {
      throw new Error("El estado regional contiene una ausencia fuera de rango");
    }
    const key = `${cell.tileX}:${cell.tileZ}`;
    if (seenAbsentCells.has(key)) {
      throw new Error("El estado regional contiene ausencias duplicadas");
    }
    seenAbsentCells.add(key);
    absentCells.push({ tileX: cell.tileX, tileZ: cell.tileZ });
  }
  if (absentCells.length > value.absentCount) {
    throw new Error("El estado regional contiene demasiadas ausencias base");
  }
  return {
    rowCount: value.rowCount,
    completeCount: value.completeCount,
    absentCount: value.absentCount,
    pendingCount: value.pendingCount,
    failedCount: value.failedCount,
    missingCompleteCount: value.missingCompleteCount,
    validCompleteBytes: value.validCompleteBytes,
    absentCells: Object.freeze(absentCells),
  };
}

function emptyLocalRegionStatus(
  request: LocalRegionStatusRequest,
): LocalRegionStatusInventory {
  const columns =
    (request.bounds.maxXExclusive - request.bounds.minX) / TILE_SIZE_PIXELS;
  const rows =
    (request.bounds.maxZExclusive - request.bounds.minZ) / TILE_SIZE_PIXELS;
  const totalCount = columns * rows * request.layers.length;
  return Object.freeze({
    result: Object.freeze({
      version: 1,
      dimension: "overworld",
      lod: 0,
      bounds: request.bounds,
      layers: request.layers,
      totalCount,
      resolvedCount: 0,
      completeCount: 0,
      absentCount: 0,
      pendingCount: 0,
      failedCount: 0,
      missingCount: totalCount,
      percent: 0,
      ready: false,
      databaseUpdatedAt: null,
      absentCells: Object.freeze([]),
    }),
    validCompleteBytes: 0,
  });
}

async function queryLocalRegionStatus(
  tileRoot: string,
  pythonBin: string,
  request: LocalRegionStatusRequest,
  databaseUpdatedAt: string,
): Promise<LocalRegionStatusInventory> {
  const databasePath = resolve(tileRoot, "tiles.sqlite3");
  const minTileX = request.bounds.minX / TILE_SIZE_PIXELS;
  const minTileZ = request.bounds.minZ / TILE_SIZE_PIXELS;
  const maxTileXExclusive =
    request.bounds.maxXExclusive / TILE_SIZE_PIXELS;
  const maxTileZExclusive =
    request.bounds.maxZExclusive / TILE_SIZE_PIXELS;
  const columns = maxTileXExclusive - minTileX;
  const rows = maxTileZExclusive - minTileZ;
  const totalCount = columns * rows * request.layers.length;
  const payload = await new Promise<LocalRegionStatusQueryPayload>(
    (resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(
        pythonBin,
        [
          "-c",
          LOCAL_REGION_STATUS_QUERY,
          databasePath,
          tileRoot,
          String(minTileX),
          String(minTileZ),
          String(maxTileXExclusive),
          String(maxTileZExclusive),
          JSON.stringify(request.layers),
          String(MAX_TILE_BYTES),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            VIRTUAL_ENV: process.env.VIRTUAL_ENV,
            SSL_CERT_FILE: process.env.SSL_CERT_FILE,
            REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            NO_PROXY: process.env.NO_PROXY,
            PYTHONUNBUFFERED: "1",
          },
        },
      );
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          rejectPromise(
            new Error("La lectura regional local superó el tiempo límite"),
          ),
        );
      }, LOCAL_REGION_STATUS_QUERY_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_LOCAL_REGION_STATUS_BYTES) {
          child.kill("SIGTERM");
          finish(() =>
            rejectPromise(
              new Error("El estado regional local supera el tamaño permitido"),
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4_096) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        finish(() => rejectPromise(error));
      });
      child.once("exit", (code) => {
        finish(() => {
          if (code !== 0) {
            rejectPromise(
              new Error(
                stderr.trim() ||
                  "No se pudo leer el estado regional del catálogo local",
              ),
            );
            return;
          }
          try {
            resolvePromise(
              parseLocalRegionStatusQueryPayload(
                JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown,
                request,
                totalCount,
              ),
            );
          } catch (error) {
            rejectPromise(
              error instanceof Error
                ? error
                : new Error("El estado regional local no contiene JSON válido"),
            );
          }
        });
      });
    },
  );

  const missingCount =
    totalCount - payload.rowCount + payload.missingCompleteCount;
  const resolvedCount = payload.completeCount + payload.absentCount;
  const percent = (resolvedCount / totalCount) * 100;
  const result: LocalRegionStatusResult = Object.freeze({
    version: 1,
    dimension: "overworld",
    lod: 0,
    bounds: request.bounds,
    layers: request.layers,
    totalCount,
    resolvedCount,
    completeCount: payload.completeCount,
    absentCount: payload.absentCount,
    pendingCount: payload.pendingCount,
    failedCount: payload.failedCount,
    missingCount,
    percent,
    ready:
      resolvedCount === totalCount &&
      payload.pendingCount === 0 &&
      payload.failedCount === 0 &&
      missingCount === 0,
    databaseUpdatedAt,
    absentCells: payload.absentCells,
  });
  return Object.freeze({
    result,
    validCompleteBytes: payload.validCompleteBytes,
  });
}

function estimateRegionDownloadBytes(
  inventory: LocalRegionStatusInventory,
): number {
  const { result, validCompleteBytes } = inventory;
  const unresolvedCount =
    result.pendingCount + result.failedCount + result.missingCount;
  if (unresolvedCount === 0) return 0;
  const observedAverage =
    result.completeCount > 0
      ? Math.ceil(validCompleteBytes / result.completeCount)
      : DEFAULT_ESTIMATED_TILE_BYTES;
  const estimatedTileBytes = Math.min(
    MAX_ESTIMATED_TILE_BYTES,
    Math.max(MIN_ESTIMATED_TILE_BYTES, observedAverage),
  );
  return Math.ceil(unresolvedCount * estimatedTileBytes * 1.2);
}

async function readCapacity(
  tileRoot: string | undefined,
  backingRoot: string | undefined,
  requirementOverrideBytes: number | undefined,
  readArchiveBytes: (tileRoot: string) => Promise<number>,
) {
  // On-demand mode has no whole-world storage target. Keep these legacy
  // fields in the response contract so older clients remain parseable.
  const requirementBytes = requirementOverrideBytes ?? 0;
  if (!tileRoot) {
    return {
      configured: false,
      volume: "LuisA",
      totalBytes: null,
      freeBytes: null,
      archiveBytes: null,
      availableForAtlasBytes: null,
      overworldRequirementBytes: requirementBytes,
      marginBytes: null,
      fits: null,
    };
  }

  try {
    const tileStats = await statfs(tileRoot);
    const tileTotalBytes = Number(tileStats.blocks) * Number(tileStats.bsize);
    const tileFreeBytes = Number(tileStats.bavail) * Number(tileStats.bsize);
    let effectiveFreeBytes = tileFreeBytes;
    if (backingRoot) {
      const backingStats = await statfs(backingRoot);
      effectiveFreeBytes = Math.min(
        effectiveFreeBytes,
        Number(backingStats.bavail) * Number(backingStats.bsize),
      );
    }
    const archiveBytes = await readArchiveBytes(tileRoot);
    const availableForAtlasBytes = effectiveFreeBytes;
    const marginBytes = availableForAtlasBytes - requirementBytes;
    return {
      configured: true,
      volume: "LuisA",
      totalBytes: tileTotalBytes,
      freeBytes: effectiveFreeBytes,
      archiveBytes,
      availableForAtlasBytes,
      overworldRequirementBytes: requirementBytes,
      marginBytes,
      fits: marginBytes >= 0,
    };
  } catch {
    return {
      configured: false,
      volume: "LuisA",
      totalBytes: null,
      freeBytes: null,
      archiveBytes: null,
      availableForAtlasBytes: null,
      overworldRequirementBytes: requirementBytes,
      marginBytes: null,
      fits: null,
    };
  }
}

function publicJob(job: LocalJob | null) {
  if (!job) return null;
  const cooldownUntilMs = job.progress.cooldownUntil
    ? Date.parse(job.progress.cooldownUntil)
    : null;
  const progress =
    cooldownUntilMs === null
      ? job.progress
      : {
          ...job.progress,
          cooldownSeconds: Math.max(
            0,
            (cooldownUntilMs - Date.now()) / 1_000,
          ),
        };
  return {
    id: job.id,
    status: job.status,
    request: job.request,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    message: job.message,
    progress,
  };
}

function parseJobProgressLine(
  line: string,
  expectedRequested: number,
  expectedTargetRps: number,
): LocalJobProgress | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.type !== "region-download" ||
    value.version !== 1 ||
    value.requested !== expectedRequested ||
    !isNonNegativeSafeInteger(value.processed) ||
    !isNonNegativeSafeInteger(value.complete) ||
    !isNonNegativeSafeInteger(value.absent) ||
    !isNonNegativeSafeInteger(value.failed) ||
    !isNonNegativeSafeInteger(value.reused) ||
    !isNonNegativeSafeInteger(value.reusedAbsent) ||
    !isNonNegativeSafeInteger(value.downloadedBytes) ||
    typeof value.percent !== "number" ||
    !Number.isFinite(value.percent) ||
    value.percent < 0 ||
    value.percent > 100 ||
    (value.status !== "running" &&
      value.status !== "complete" &&
      value.status !== "error" &&
    value.status !== "interrupted") ||
    value.processed > expectedRequested ||
    value.complete + value.absent + value.failed > expectedRequested ||
    value.reused > value.complete ||
    value.reusedAbsent > value.absent
  ) {
    return null;
  }
  const unboundedFiniteMetrics = [
    "elapsedSeconds",
    "tilesPerSecond",
    "bytesPerSecond",
  ] as const;
  const effectiveRps = value.effectiveRps;
  const targetRps = value.targetRps;
  const cooldownSeconds = value.cooldownSeconds;
  const networkRequested = value.networkRequested;
  const networkProcessed = value.networkProcessed;
  const resolvedPerSecond = value.resolvedPerSecond;
  const networkTilesPerSecond = value.networkTilesPerSecond;
  const achievedRps = value.achievedRps;
  if (
    (value.requestAttempts !== undefined &&
      !isNonNegativeSafeInteger(value.requestAttempts)) ||
    unboundedFiniteMetrics.some((key) => {
      const metric = value[key];
      return (
        metric !== undefined &&
        (typeof metric !== "number" ||
          !Number.isFinite(metric) ||
          metric < 0)
      );
    }) ||
    (targetRps !== undefined &&
      (typeof targetRps !== "number" ||
        !Number.isFinite(targetRps) ||
        targetRps < 0.25 ||
        targetRps > MAX_REGION_REQUESTS_PER_SECOND ||
        Math.abs(targetRps - expectedTargetRps) >
          RATE_METRIC_TOLERANCE)) ||
    (effectiveRps !== undefined &&
      (typeof effectiveRps !== "number" ||
        !Number.isFinite(effectiveRps) ||
        effectiveRps < 0 ||
        effectiveRps > MAX_REGION_REQUESTS_PER_SECOND ||
        effectiveRps >
          (targetRps ?? expectedTargetRps) + RATE_METRIC_TOLERANCE)) ||
    (cooldownSeconds !== undefined &&
      (typeof cooldownSeconds !== "number" ||
        !Number.isFinite(cooldownSeconds) ||
        cooldownSeconds < 0 ||
        cooldownSeconds > MAX_REGION_COOLDOWN_SECONDS)) ||
    (networkRequested !== undefined &&
      networkRequested !== null &&
      (!isNonNegativeSafeInteger(networkRequested) ||
        networkRequested > expectedRequested)) ||
    (networkProcessed !== undefined &&
      (!isNonNegativeSafeInteger(networkProcessed) ||
        networkProcessed > value.processed ||
        (typeof networkRequested === "number" &&
          networkProcessed > networkRequested))) ||
    [resolvedPerSecond, networkTilesPerSecond, achievedRps].some(
      (metric) =>
        metric !== undefined &&
        (typeof metric !== "number" ||
          !Number.isFinite(metric) ||
          metric < 0 ||
          metric > Number.MAX_SAFE_INTEGER),
    ) ||
    (typeof value.tilesPerSecond === "number" &&
      typeof resolvedPerSecond === "number" &&
      Math.abs(value.tilesPerSecond - resolvedPerSecond) >
        RATE_METRIC_TOLERANCE) ||
    (typeof resolvedPerSecond === "number" &&
      typeof networkTilesPerSecond === "number" &&
      networkTilesPerSecond >
        resolvedPerSecond + RATE_METRIC_TOLERANCE) ||
    (typeof achievedRps === "number" &&
      typeof networkTilesPerSecond === "number" &&
      networkTilesPerSecond > achievedRps + RATE_METRIC_TOLERANCE) ||
    (value.etaSeconds !== undefined &&
      value.etaSeconds !== null &&
      (typeof value.etaSeconds !== "number" ||
        !Number.isFinite(value.etaSeconds) ||
        value.etaSeconds < 0))
  ) {
    return null;
  }
  const cooldownUntil =
    cooldownSeconds === undefined
      ? undefined
      : cooldownSeconds > 0
        ? new Date(Date.now() + cooldownSeconds * 1_000).toISOString()
        : null;
  const parsed = value as unknown as LocalJobProgress;
  return Object.freeze({
    requested: expectedRequested,
    processed: parsed.processed,
    complete: parsed.complete,
    absent: parsed.absent,
    failed: parsed.failed,
    reused: parsed.reused,
    reusedAbsent: parsed.reusedAbsent,
    downloadedBytes: parsed.downloadedBytes,
    percent: parsed.percent,
    status: parsed.status,
    ...(parsed.requestAttempts !== undefined
      ? { requestAttempts: parsed.requestAttempts }
      : {}),
    ...(parsed.elapsedSeconds !== undefined
      ? { elapsedSeconds: parsed.elapsedSeconds }
      : {}),
    ...(parsed.tilesPerSecond !== undefined
      ? { tilesPerSecond: parsed.tilesPerSecond }
      : {}),
    ...(parsed.bytesPerSecond !== undefined
      ? { bytesPerSecond: parsed.bytesPerSecond }
      : {}),
    ...(parsed.etaSeconds !== undefined
      ? { etaSeconds: parsed.etaSeconds }
      : {}),
    ...(parsed.effectiveRps !== undefined
      ? { effectiveRps: parsed.effectiveRps }
      : {}),
    ...(parsed.targetRps !== undefined
      ? { targetRps: parsed.targetRps }
      : {}),
    ...(parsed.cooldownSeconds !== undefined
      ? { cooldownSeconds: parsed.cooldownSeconds }
      : {}),
    ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
    ...(parsed.networkRequested !== undefined
      ? { networkRequested: parsed.networkRequested }
      : {}),
    ...(parsed.networkProcessed !== undefined
      ? { networkProcessed: parsed.networkProcessed }
      : {}),
    ...(parsed.resolvedPerSecond !== undefined
      ? { resolvedPerSecond: parsed.resolvedPerSecond }
      : {}),
    ...(parsed.networkTilesPerSecond !== undefined
      ? { networkTilesPerSecond: parsed.networkTilesPerSecond }
      : {}),
    ...(parsed.achievedRps !== undefined
      ? { achievedRps: parsed.achievedRps }
      : {}),
  });
}

function startRegionJob(
  state: RuntimeState,
  request: RegionDownloadRequest,
  options: Required<
    Pick<LocalAtlasOptions, "tileRoot" | "pythonBin" | "projectRoot">
  >,
) {
  const tileCount =
    ((request.xMaxExclusive - request.xMin) / TILE_SIZE_PIXELS) *
    ((request.zMaxExclusive - request.zMin) / TILE_SIZE_PIXELS) *
    request.layers.length;
  const job: LocalJob = {
    id: randomUUID(),
    status: "running",
    request,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    message: "Descargando la región seleccionada",
    progress: {
      requested: tileCount,
      processed: 0,
      complete: 0,
      absent: 0,
      failed: 0,
      reused: 0,
      reusedAbsent: 0,
      downloadedBytes: 0,
      percent: 0,
      status: "running",
      requestAttempts: 0,
      elapsedSeconds: 0,
      tilesPerSecond: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      effectiveRps: Math.min(4, request.requestsPerSecond),
      targetRps: request.requestsPerSecond,
      cooldownSeconds: 0,
      cooldownUntil: null,
      networkRequested: null,
      networkProcessed: 0,
      resolvedPerSecond: 0,
      networkTilesPerSecond: 0,
      achievedRps: 0,
    },
  };
  const script = resolve(options.projectRoot, "download_region_2b2t.py");
  const workers =
    request.requestsPerSecond <= 2
      ? 2
      : request.requestsPerSecond <= 8
        ? 4
        : 8;
  const child = spawn(
    options.pythonBin,
    [
      script,
      "--x-min",
      String(request.xMin),
      "--z-min",
      String(request.zMin),
      "--x-max",
      String(request.xMaxExclusive),
      "--z-max",
      String(request.zMaxExclusive),
      "--dimension",
      "overworld",
      "--lod",
      String(request.lod),
      "--layers",
      request.layers.join(","),
      "--out",
      options.tileRoot,
      "--workers",
      String(workers),
      "--requests-per-second",
      String(request.requestsPerSecond),
      "--retries",
      "3",
      "--max-tiles",
      String(tileCount),
      "--progress-jsonl",
    ],
    {
      cwd: options.projectRoot,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        VIRTUAL_ENV: process.env.VIRTUAL_ENV,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  state.job = job;
  state.child = child;

  let stdoutBuffer = "";
  const consumeProgressLine = (line: string) => {
    const progress = parseJobProgressLine(
      line,
      tileCount,
      request.requestsPerSecond,
    );
    if (
      !progress ||
      progress.processed < job.progress.processed ||
      progress.complete < job.progress.complete ||
      progress.absent < job.progress.absent ||
      progress.failed < job.progress.failed ||
      progress.reused < job.progress.reused ||
      progress.reusedAbsent < job.progress.reusedAbsent ||
      progress.downloadedBytes < job.progress.downloadedBytes ||
      (progress.networkProcessed !== undefined &&
        job.progress.networkProcessed !== undefined &&
        progress.networkProcessed < job.progress.networkProcessed) ||
      (typeof progress.networkRequested === "number" &&
        typeof job.progress.networkRequested === "number" &&
        progress.networkRequested !== job.progress.networkRequested)
    ) {
      return;
    }
    job.progress = progress;
    if (job.status === "running") {
      job.message =
        progress.processed === 0
          ? "Preparando la descarga regional"
          : `Descargando región · ${progress.percent.toFixed(1)}% · ${progress.achievedRps?.toFixed(1) ?? "—"} req/s logradas · setpoint ${progress.effectiveRps?.toFixed(1) ?? "—"}/${progress.targetRps?.toFixed(0) ?? "—"}`;
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > 128 * 1024) {
      stdoutBuffer = stdoutBuffer.slice(-64 * 1024);
    }
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      consumeProgressLine(stdoutBuffer.slice(0, newline).trim());
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  // Drain stderr so verbose human diagnostics can never block the process.
  child.stderr.resume();
  child.once("error", () => {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.message = "No se pudo iniciar el descargador regional";
    job.progress = { ...job.progress, status: "error" };
    state.child = null;
  });
  child.once("exit", (code, signal) => {
    if (stdoutBuffer.trim()) consumeProgressLine(stdoutBuffer.trim());
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (job.status === "stopping" || code === 130 || signal === "SIGINT") {
      job.status = "stopped";
      job.message = "Descarga regional detenida de forma segura";
      job.progress = { ...job.progress, status: "interrupted" };
    } else if (code === 0) {
      job.status = "complete";
      job.message = "Región disponible en la biblioteca local";
      job.progress = { ...job.progress, status: "complete" };
    } else {
      job.status = "error";
      job.message = "La descarga regional terminó con errores";
      job.progress = { ...job.progress, status: "error" };
    }
    state.child = null;
  });
  return job;
}

function parseTileRequest(url: string | undefined) {
  if (!url) return null;
  const parsed = new URL(url, "http://localhost");
  if (parsed.pathname !== TILE_ENDPOINT) return null;
  const layer = parsed.searchParams.get("layer");
  const lodText = parsed.searchParams.get("lod");
  const dimension = parsed.searchParams.get("dimension");
  const tileXText = parsed.searchParams.get("tileX");
  const tileZText = parsed.searchParams.get("tileZ");
  if (
    !layer ||
    !ALLOWED_LAYERS.has(layer) ||
    dimension !== "0" ||
    !lodText ||
    !tileXText ||
    !tileZText ||
    !INTEGER_PATTERN.test(lodText) ||
    !INTEGER_PATTERN.test(tileXText) ||
    !INTEGER_PATTERN.test(tileZText)
  ) {
    return null;
  }
  const lod = Number(lodText);
  const tileX = Number(tileXText);
  const tileZ = Number(tileZText);
  if (
    !Number.isSafeInteger(lod) ||
    lod < 0 ||
    lod > 10 ||
    !Number.isSafeInteger(tileX) ||
    !Number.isSafeInteger(tileZ)
  ) {
    return null;
  }
  const maximum =
    Math.ceil(WORLD_BORDER_BLOCKS / (TILE_SIZE_PIXELS * 2 ** lod)) + 1;
  if (Math.abs(tileX) > maximum || Math.abs(tileZ) > maximum) return null;
  return {
    layer,
    lod,
    tileX,
    tileZ,
  };
}

async function hasWebpHeader(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(12);
    const result = await handle.read(header, 0, header.length, 0);
    return (
      result.bytesRead === 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    );
  } finally {
    await handle?.close();
  }
}

async function tryServeLocalTile(
  request: IncomingMessage,
  response: ServerResponse,
  tileRoot: string,
): Promise<"served" | "missing" | "invalid"> {
  const tile = parseTileRequest(request.url);
  if (!tile) return "invalid";
  const shardX = Math.trunc(tile.tileX / TILES_PER_SHARD);
  const shardZ = Math.trunc(tile.tileZ / TILES_PER_SHARD);
  const path = resolve(
    tileRoot,
    tile.layer,
    String(tile.lod),
    "overworld",
    String(shardX),
    String(shardZ),
    `t.${tile.tileX}.${tile.tileZ}.webp`,
  );

  try {
    const metadata = await stat(path);
    if (
      !metadata.isFile() ||
      metadata.size < 12 ||
      metadata.size > MAX_TILE_BYTES ||
      !(await hasWebpHeader(path))
    ) {
      return "missing";
    }
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "image/webp");
    response.setHeader("Content-Length", String(metadata.size));
    response.setHeader("X-Atlas-Tile-Source", "local");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(path).pipe(response);
    }
    return "served";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "missing";
  }
}

export function createLocalAtlasMiddleware(options: LocalAtlasOptions) {
  const tileRoot = options.tileRoot?.trim()
    ? resolve(options.tileRoot)
    : undefined;
  const regionalTileRoot = options.regionalTileRoot?.trim()
    ? resolve(options.regionalTileRoot)
    : tileRoot;
  const backingRoot = options.backingRoot?.trim()
    ? resolve(options.backingRoot)
    : undefined;
  const minecraftRoot = options.minecraftRoot?.trim()
    ? resolve(options.minecraftRoot)
    : undefined;
  const requirementOverrideBytes =
    options.overworldRequirementBytes &&
    Number.isSafeInteger(options.overworldRequirementBytes) &&
    options.overworldRequirementBytes > 0
      ? options.overworldRequirementBytes
      : undefined;
  const projectRoot = resolve(options.projectRoot ?? "..");
  const defaultVenvPython = resolve(projectRoot, ".venv", "bin", "python");
  const pythonBin =
    options.pythonBin?.trim() ||
    (existsSync(defaultVenvPython) ? defaultVenvPython : "python3");
  const state: RuntimeState = { job: null, child: null, stopTimer: null };
  const mutationToken = randomUUID();
  const workspaceStore = backingRoot
    ? new LocalAtlasWorkspaceStore(backingRoot)
    : null;
  const xaeroExporter =
    backingRoot && minecraftRoot
      ? new LocalAtlasXaeroExporter({
          backingRoot,
          minecraftRoot,
          minecraftOpenProbe: options.minecraftOpenProbe,
        })
      : null;
  const coverageCache = new Map<
    number,
    { readonly fingerprint: string; readonly result: LocalCoverageResult }
  >();
  const coverageQueries = new Map<string, Promise<LocalCoverageResult>>();
  const regionStatusCache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly inventory: LocalRegionStatusInventory;
    }
  >();
  const regionStatusQueries = new Map<
    string,
    Promise<LocalRegionStatusInventory>
  >();
  const archiveBytesCache = new Map<
    string,
    { readonly fingerprint: string; readonly bytes: number }
  >();
  const archiveBytesQueries = new Map<string, Promise<number>>();

  const readCachedArchiveBytes = async (
    catalogRoot: string,
  ): Promise<number> => {
    let snapshot: Awaited<ReturnType<typeof readLocalCatalogSnapshot>>;
    try {
      snapshot = await readLocalCatalogSnapshot(catalogRoot);
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const cached = archiveBytesCache.get(catalogRoot);
      if (cached?.fingerprint === snapshot.fingerprint) {
        return cached.bytes;
      }
      const queryKey = `${catalogRoot}:${snapshot.fingerprint}`;
      let query = archiveBytesQueries.get(queryKey);
      if (!query) {
        query = queryLocalArchiveBytes(catalogRoot, pythonBin)
          .then((bytes) => {
            archiveBytesCache.set(catalogRoot, {
              fingerprint: snapshot.fingerprint,
              bytes,
            });
            return bytes;
          })
          .finally(() => {
            archiveBytesQueries.delete(queryKey);
          });
        archiveBytesQueries.set(queryKey, query);
      }
      try {
        return await query;
      } catch {
        // An absent, incompatible, or transiently locked catalog can still
        // expose the last trustworthy legacy progress metric.
      }
    }
    return await readLegacyArchiveBytes(catalogRoot);
  };

  const readCachedLocalCoverage = async (
    lod: number,
  ): Promise<LocalCoverageResult> => {
    const configuredRoots = [tileRoot, regionalTileRoot].filter(
      (catalogRoot, index, roots): catalogRoot is string =>
        Boolean(catalogRoot) &&
        roots.indexOf(catalogRoot) === index,
    );
    if (configuredRoots.length === 0) {
      throw new Error("La biblioteca local no está configurada");
    }
    const snapshots = await Promise.all(
      configuredRoots.map(async (catalogRoot) => ({
        catalogRoot,
        snapshot: await readLocalCatalogSnapshot(catalogRoot),
      })),
    );
    const availableCatalogs = snapshots.filter(
      (
        entry,
      ): entry is {
        readonly catalogRoot: string;
        readonly snapshot: NonNullable<
          Awaited<ReturnType<typeof readLocalCatalogSnapshot>>
        >;
      } => entry.snapshot !== null,
    );
    if (availableCatalogs.length === 0) {
      throw new Error("No hay catálogos locales de tiles");
    }
    const fingerprint = snapshots
      .map(
        ({ catalogRoot, snapshot }) =>
          `${catalogRoot}:${snapshot?.fingerprint ?? "missing"}`,
      )
      .join("|");
    const cached = coverageCache.get(lod);
    if (cached?.fingerprint === fingerprint) return cached.result;
    const queryKey = `${lod}:${fingerprint}`;
    const existingQuery = coverageQueries.get(queryKey);
    if (existingQuery) return existingQuery;
    const databaseUpdatedAt = new Date(
      Math.max(
        ...availableCatalogs.map(({ snapshot }) =>
          Date.parse(snapshot.updatedAt),
        ),
      ),
    ).toISOString();
    const query = queryLocalCoverage(
      availableCatalogs.map(({ catalogRoot }) => catalogRoot),
      pythonBin,
      lod,
      databaseUpdatedAt,
    )
      .then((result) => {
        coverageCache.set(lod, { fingerprint, result });
        return result;
      })
      .finally(() => {
        coverageQueries.delete(queryKey);
      });
    coverageQueries.set(queryKey, query);
    return query;
  };

  const readCachedLocalRegionStatus = async (
    catalogRoot: string,
    request: LocalRegionStatusRequest,
  ): Promise<LocalRegionStatusInventory> => {
    const requestKey = [
      catalogRoot,
      request.bounds.minX,
      request.bounds.minZ,
      request.bounds.maxXExclusive,
      request.bounds.maxZExclusive,
      request.layers.join(","),
    ].join(":");
    const snapshot = await readLocalCatalogSnapshot(catalogRoot);
    if (!snapshot) return emptyLocalRegionStatus(request);
    const cached = regionStatusCache.get(requestKey);
    if (cached?.fingerprint === snapshot.fingerprint) {
      return cached.inventory;
    }
    const queryKey = `${requestKey}:${snapshot.fingerprint}`;
    const existingQuery = regionStatusQueries.get(queryKey);
    if (existingQuery) return existingQuery;
    const query = queryLocalRegionStatus(
      catalogRoot,
      pythonBin,
      request,
      snapshot.updatedAt,
    )
      .then((inventory) => {
        regionStatusCache.set(requestKey, {
          fingerprint: snapshot.fingerprint,
          inventory,
        });
        return inventory;
      })
      .finally(() => {
        regionStatusQueries.delete(queryKey);
      });
    regionStatusQueries.set(queryKey, query);
    return query;
  };

  const readPreferredLocalRegionStatus = async (
    request: LocalRegionStatusRequest,
  ): Promise<LocalRegionStatusInventory> => {
    if (!regionalTileRoot) {
      throw new Error("La biblioteca local no está configurada");
    }
    const regionalInventory = await readCachedLocalRegionStatus(
      regionalTileRoot,
      request,
    );
    if (
      regionalInventory.result.ready ||
      !tileRoot ||
      tileRoot === regionalTileRoot
    ) {
      return regionalInventory;
    }
    const primaryInventory = await readCachedLocalRegionStatus(
      tileRoot,
      request,
    );
    return primaryInventory.result.ready
      ? primaryInventory
      : regionalInventory;
  };

  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: MiddlewareNext,
  ) => {
    const path = requestPath(request);
    if (
      path !== STATUS_ENDPOINT &&
      path !== COVERAGE_ENDPOINT &&
      path !== REGION_STATUS_ENDPOINT &&
      path !== DOWNLOAD_ENDPOINT &&
      path !== STOP_ENDPOINT &&
      path !== WORKSPACE_ENDPOINT &&
      path !== XAERO_PREVIEW_ENDPOINT &&
      path !== XAERO_EXPORT_ENDPOINT &&
      path !== TILE_ENDPOINT
    ) {
      next();
      return;
    }

    if (!requireLocalRequest(request, response)) return;

    if (path === XAERO_PREVIEW_ENDPOINT && request.method === "GET") {
      if (!workspaceStore || !xaeroExporter) {
        writeJson(response, 503, {
          error: "La exportación local a Xaero no está configurada",
        });
        return;
      }
      try {
        const { workspace } = await workspaceStore.read();
        const selection = parseXaeroPreviewSelection(request.url);
        writeJson(
          response,
          200,
          await xaeroExporter.preview(workspace, selection),
          {
            ETag: atlasWorkspaceEtag(
              workspace.workspaceId,
              workspace.revision,
            ),
          },
        );
      } catch (error) {
        writeXaeroError(response, error);
      }
      return;
    }

    if (path === XAERO_EXPORT_ENDPOINT && request.method === "POST") {
      if (request.headers["x-atlas-token"] !== mutationToken) {
        writeJson(response, 403, {
          error: "Token local inválido; recarga el visor",
        });
        return;
      }
      if (!workspaceStore || !xaeroExporter) {
        writeJson(response, 503, {
          error: "La exportación local a Xaero no está configurada",
        });
        return;
      }
      const expected = parseAtlasWorkspaceEtag(
        request.headers["if-match"],
      );
      if (!expected) {
        writeJson(response, 428, {
          error: "If-Match es obligatorio para exportar a Xaero",
        });
        return;
      }
      const writeId = request.headers["x-atlas-write-id"];
      if (
        typeof writeId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          writeId,
        )
      ) {
        writeJson(response, 400, {
          error: "X-Atlas-Write-Id es obligatorio para exportar a Xaero",
        });
        return;
      }
      try {
        const body = await readRequestBody(request);
        const allowedBodyKeys = new Set([
          "previewId",
          "operation",
          "scope",
          "explorationId",
        ]);
        if (
          !isRecord(body) ||
          Object.keys(body).some((key) => !allowedBodyKeys.has(key)) ||
          typeof body.previewId !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.previewId)
        ) {
          throw new TypeError(
            "La exportación necesita una previsualización válida",
          );
        }
        const selection = parseXaeroSelection(
          body.operation,
          body.scope,
          body.explorationId,
        );
        const { workspace } = await workspaceStore.read();
        if (
          workspace.workspaceId !== expected.workspaceId ||
          workspace.revision !== expected.revision
        ) {
          writeJson(
            response,
            412,
            {
              error:
                "El workspace cambió; vuelve a previsualizar la exportación",
              code: "WORKSPACE_CONFLICT",
              currentRevision: workspace.revision,
            },
            {
              ETag: atlasWorkspaceEtag(
                workspace.workspaceId,
                workspace.revision,
              ),
            },
          );
          return;
        }
        writeJson(
          response,
          200,
          await xaeroExporter.commit(
            workspace,
            body.previewId,
            writeId,
            selection,
          ),
          {
            ETag: atlasWorkspaceEtag(
              workspace.workspaceId,
              workspace.revision,
            ),
          },
        );
      } catch (error) {
        writeXaeroError(response, error);
      }
      return;
    }

    if (path === REGION_STATUS_ENDPOINT && request.method === "GET") {
      const regionRequest = parseLocalRegionStatusRequest(request.url);
      if (!regionRequest) {
        writeJson(response, 400, {
          error:
            "Usa bounds LOD 0 alineados y layers=base[,overlay,newchunks]",
        });
        return;
      }
      if (!regionalTileRoot) {
        writeJson(response, 503, {
          error: "La biblioteca local no está configurada",
        });
        return;
      }
      try {
        const inventory =
          await readPreferredLocalRegionStatus(regionRequest);
        writeJson(response, 200, inventory.result);
      } catch {
        writeJson(response, 503, {
          error: "No se pudo leer el estado regional del catálogo local",
        });
      }
      return;
    }

    if (path === COVERAGE_ENDPOINT && request.method === "GET") {
      const coverageRequest = parseLocalCoverageRequest(request.url);
      if (!coverageRequest) {
        writeJson(response, 400, {
          error: "Usa layer=base y un LOD entre 0 y 3",
        });
        return;
      }
      if (!tileRoot && !regionalTileRoot) {
        writeJson(response, 503, {
          error: "La biblioteca local no está configurada",
        });
        return;
      }
      try {
        writeJson(
          response,
          200,
          await readCachedLocalCoverage(coverageRequest.lod),
        );
      } catch {
        writeJson(response, 503, {
          error: "No se pudo leer la cobertura del catálogo local",
        });
      }
      return;
    }

    if (
      path === TILE_ENDPOINT &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const parsedTile = parseTileRequest(request.url);
      if (!parsedTile) {
        next();
        return;
      }
      if (regionalTileRoot) {
        const result = await tryServeLocalTile(
          request,
          response,
          regionalTileRoot,
        );
        if (result === "served") return;
      }
      if (tileRoot && tileRoot !== regionalTileRoot) {
        const result = await tryServeLocalTile(request, response, tileRoot);
        if (result === "served") return;
      }
      writeEmpty(response, 404);
      return;
    }

    if (path === STATUS_ENDPOINT && request.method === "GET") {
      const [capacity, persistence] = await Promise.all([
        readCapacity(
          regionalTileRoot,
          backingRoot,
          requirementOverrideBytes,
          readCachedArchiveBytes,
        ),
        workspaceStore
          ? workspaceStore.availability()
          : Promise.resolve({
              configured: false as const,
              writable: false,
              volume: "LuisA" as const,
              revision: null,
              updatedAt: null,
            }),
      ]);
      writeJson(response, 200, {
        localOnly: true,
        mutationToken,
        capacity,
        persistence,
        // Kept for wire compatibility. Global downloading is deliberately
        // disabled; only user-selected regional jobs can consume bandwidth.
        globalDownload: null,
        job: publicJob(state.job),
      });
      return;
    }

    if (path === WORKSPACE_ENDPOINT && request.method === "GET") {
      if (!workspaceStore) {
        writeJson(response, 503, {
          error: "La persistencia en LuisA no está configurada",
        });
        return;
      }
      try {
        const result = await workspaceStore.read();
        writeJson(response, 200, result.workspace, {
          ETag: atlasWorkspaceEtag(
            result.workspace.workspaceId,
            result.workspace.revision,
          ),
          ...(result.recoveredFromBackup
            ? { "X-Atlas-Recovered-From-Backup": "1" }
            : {}),
        });
      } catch (error) {
        writeWorkspaceError(response, error);
      }
      return;
    }

    if (path === WORKSPACE_ENDPOINT && request.method === "PUT") {
      if (request.headers["x-atlas-token"] !== mutationToken) {
        writeJson(response, 403, {
          error: "Token local inválido; recarga el visor",
        });
        return;
      }
      if (!workspaceStore) {
        writeJson(response, 503, {
          error: "La persistencia en LuisA no está configurada",
        });
        return;
      }
      const ifMatch = request.headers["if-match"];
      if (ifMatch === undefined) {
        writeJson(response, 428, {
          error: "If-Match es obligatorio para guardar el workspace",
        });
        return;
      }
      const expectedWorkspace = parseAtlasWorkspaceEtag(ifMatch);
      if (expectedWorkspace === null) {
        writeJson(response, 400, {
          error: "If-Match no contiene una revisión válida",
        });
        return;
      }
      const writeId = request.headers["x-atlas-write-id"];
      if (typeof writeId !== "string") {
        writeJson(response, 400, {
          error: "X-Atlas-Write-Id es obligatorio",
        });
        return;
      }
      try {
        const result = await workspaceStore.write(
          await readRequestBody(request, MAX_ATLAS_WORKSPACE_BYTES),
          expectedWorkspace,
          writeId,
        );
        writeJson(response, 200, result.workspace, {
          ETag: atlasWorkspaceEtag(
            result.workspace.workspaceId,
            result.workspace.revision,
          ),
        });
      } catch (error) {
        writeWorkspaceError(response, error);
      }
      return;
    }

    if (path === DOWNLOAD_ENDPOINT && request.method === "POST") {
      if (request.headers["x-atlas-token"] !== mutationToken) {
        writeJson(response, 403, {
          error: "Token local inválido; recarga el visor",
        });
        return;
      }
      if (!regionalTileRoot) {
        writeJson(response, 503, {
          error: "La biblioteca local no está configurada",
        });
        return;
      }
      if (
        state.child &&
        (state.job?.status === "running" || state.job?.status === "stopping")
      ) {
        writeJson(response, 409, {
          error: "Ya hay una descarga regional en curso",
          job: publicJob(state.job),
        });
        return;
      }
      try {
        const region = parseRegionDownloadRequest(
          await readRequestBody(request),
        );
        await mkdir(regionalTileRoot, { recursive: true });
        const capacity = await readCapacity(
          regionalTileRoot,
          backingRoot,
          requirementOverrideBytes,
          readCachedArchiveBytes,
        );
        let inventory: LocalRegionStatusInventory;
        try {
          inventory = await readCachedLocalRegionStatus(
            regionalTileRoot,
            {
              bounds: {
                minX: region.xMin,
                minZ: region.zMin,
                maxXExclusive: region.xMaxExclusive,
                maxZExclusive: region.zMaxExclusive,
              },
              lod: 0,
              layers: region.layers,
            },
          );
        } catch {
          writeJson(response, 503, {
            error: "No se pudo comprobar el inventario regional local",
          });
          return;
        }
        const estimatedRequiredBytes =
          estimateRegionDownloadBytes(inventory);
        if (
          estimatedRequiredBytes > 0 &&
          (capacity.freeBytes === null ||
            capacity.freeBytes < estimatedRequiredBytes)
        ) {
          writeJson(response, 507, {
            error: "No hay espacio verificado para esta región",
            requiredBytes: estimatedRequiredBytes,
            unresolvedCount:
              inventory.result.pendingCount +
              inventory.result.failedCount +
              inventory.result.missingCount,
          });
          return;
        }
        const job = startRegionJob(state, region, {
          tileRoot: regionalTileRoot,
          pythonBin,
          projectRoot,
        });
        writeJson(response, 202, { job: publicJob(job) });
      } catch (error) {
        writeJson(response, error instanceof RangeError ? 413 : 400, {
          error:
            error instanceof Error
              ? error.message
              : "No se pudo validar la región",
        });
      }
      return;
    }

    if (path === STOP_ENDPOINT && request.method === "POST") {
      if (request.headers["x-atlas-token"] !== mutationToken) {
        writeJson(response, 403, {
          error: "Token local inválido; recarga el visor",
        });
        return;
      }
      if (
        !state.child ||
        !state.job ||
        (state.job.status !== "running" && state.job.status !== "stopping")
      ) {
        writeJson(response, 409, {
          error: "No hay una descarga regional activa",
        });
        return;
      }
      if (request.headers["x-atlas-job-id"] !== state.job.id) {
        writeJson(response, 409, {
          error: "La descarga activa cambió; actualiza el estado",
          job: publicJob(state.job),
        });
        return;
      }
      state.job.status = "stopping";
      state.job.message = "Deteniendo al terminar las solicitudes activas";
      if (!state.child.kill("SIGINT")) {
        state.job.status = "error";
        state.job.finishedAt = new Date().toISOString();
        state.job.message = "No se pudo enviar la señal de detención";
        state.child = null;
        writeJson(response, 503, { job: publicJob(state.job) });
        return;
      }
      state.stopTimer = setTimeout(() => {
        state.child?.kill("SIGTERM");
      }, STOP_GRACE_PERIOD_MS);
      writeJson(response, 202, { job: publicJob(state.job) });
      return;
    }

    writeJson(response, 405, { error: "Método no permitido" });
  };

  return {
    middleware,
    close() {
      coverageCache.clear();
      coverageQueries.clear();
      regionStatusCache.clear();
      regionStatusQueries.clear();
      archiveBytesCache.clear();
      archiveBytesQueries.clear();
      if (state.stopTimer) clearTimeout(state.stopTimer);
      if (state.child) state.child.kill("SIGINT");
    },
  };
}

/**
 * Local-only Vite bridge for durable workspace state, disk capacity, bounded
 * regional downloads, and local-first tile reads. It never accepts paths or
 * commands from the browser.
 */
export function localAtlas(options: LocalAtlasOptions = {}): Plugin {
  let close: (() => void) | null = null;
  return {
    name: "obsidian-atlas-local-runtime",
    apply: "serve",
    configureServer(server) {
      const runtime = createLocalAtlasMiddleware(options);
      close = runtime.close;
      server.middlewares.use(runtime.middleware);
      server.httpServer?.once("close", runtime.close);
    },
    closeBundle() {
      close?.();
    },
  };
}
