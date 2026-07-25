import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
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

const STATUS_ENDPOINT = "/api/local-atlas/status";
const COVERAGE_ENDPOINT = "/api/local-atlas/coverage";
const DOWNLOAD_ENDPOINT = "/api/local-atlas/download";
const STOP_ENDPOINT = "/api/local-atlas/stop";
const WORKSPACE_ENDPOINT = "/api/local-atlas/workspace";
const TILE_ENDPOINT = "/api/tile";
const TILE_SIZE_PIXELS = 512;
const TILES_PER_SHARD = 32;
const WORLD_BORDER_BLOCKS = 30_000_000;
const MAX_REQUEST_BODY_BYTES = 32_768;
const MAX_TILE_BYTES = 16 * 1024 * 1024;
const MAX_JOB_TILES = 64;
const DEFAULT_OVERWORLD_REQUIREMENT_BYTES = 1_458_909_433_254;
const STOP_GRACE_PERIOD_MS = 15_000;
const ALLOWED_LAYERS = new Set(["base", "overlay", "newchunks"]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const LOCAL_COVERAGE_QUERY = String.raw`
import json
import sqlite3
import sys

database_path = sys.argv[1]
lod = int(sys.argv[2])
target_runs = json.loads(sys.argv[3])
tile_span = 512 * (2 ** lod)
sector_tiles = 32768 // tile_span
grid_min_tile = -540672 // tile_span
grid_max_tile = grid_min_tile + (33 * sector_tiles)
run_placeholders = ",".join("(?, ?, ?, ?, ?)" for _ in target_runs)
run_parameters = [
    coordinate
    for target_run in target_runs
    for coordinate in target_run
]

connection = sqlite3.connect(
    f"file:{database_path}?mode=ro",
    uri=True,
    timeout=2.5,
)
connection.execute("PRAGMA query_only = ON")
rows = connection.execute(
    f"""
    WITH target_runs(
      target_lod,
      min_tile_z,
      max_tile_z_exclusive,
      min_tile_x,
      max_tile_x_exclusive
    ) AS (
      VALUES {run_placeholders}
    )
    SELECT
      CAST((tile_z - ?) / ? AS INTEGER) AS sector_row,
      CAST((tile_x - ?) / ? AS INTEGER) AS sector_column,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete_count,
      SUM(
        CASE
          WHEN status IN ('pending', 'downloading', 'retry', 'running')
          THEN 1 ELSE 0
        END
      ) AS queued_count,
      SUM(
        CASE
          WHEN status NOT IN (
            'complete',
            'absent',
            'pending',
            'downloading',
            'retry',
            'running'
          )
          THEN 1 ELSE 0
        END
      ) AS failed_count,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count
    FROM tiles AS tile
    INNER JOIN target_runs AS target
      ON tile.lod = target.target_lod
      AND tile.tile_z >= target.min_tile_z
      AND tile.tile_z < target.max_tile_z_exclusive
      AND tile.tile_x >= target.min_tile_x
      AND tile.tile_x < target.max_tile_x_exclusive
    WHERE tile.dimension = 'overworld'
      AND tile.layer = 'base'
      AND tile.lod = ?
      AND tile.tile_x >= ?
      AND tile.tile_x < ?
      AND tile.tile_z >= ?
      AND tile.tile_z < ?
    GROUP BY sector_row, sector_column
    ORDER BY sector_row, sector_column
    """,
    (
      *run_parameters,
      grid_min_tile,
      sector_tiles,
      grid_min_tile,
      sector_tiles,
      lod,
      grid_min_tile,
      grid_max_tile,
      grid_min_tile,
      grid_max_tile,
    ),
).fetchall()
absent_rows = connection.execute(
    f"""
    WITH target_runs(
      target_lod,
      min_tile_z,
      max_tile_z_exclusive,
      min_tile_x,
      max_tile_x_exclusive
    ) AS (
      VALUES {run_placeholders}
    )
    SELECT tile.lod, tile.tile_x, tile.tile_z
    FROM tiles AS tile
    INNER JOIN target_runs AS target
      ON tile.lod = target.target_lod
      AND tile.tile_z >= target.min_tile_z
      AND tile.tile_z < target.max_tile_z_exclusive
      AND tile.tile_x >= target.min_tile_x
      AND tile.tile_x < target.max_tile_x_exclusive
    WHERE tile.dimension = 'overworld'
      AND tile.layer = 'base'
      AND tile.lod >= ?
      AND tile.lod <= 3
      AND tile.status = 'absent'
    """,
    (*run_parameters, lod),
).fetchall()
connection.close()

counts_by_cell = {
    (int(row), int(column)): {
        "completeCount": int(complete_count or 0),
        "queuedCount": int(queued_count or 0),
        "failedCount": int(failed_count or 0),
    }
    for (
        row,
        column,
        complete_count,
        queued_count,
        failed_count,
        absent_count,
    ) in rows
    if 0 <= row < 33 and 0 <= column < 33
}

# An absent ancestor prunes its entire descendant branch, so those finer rows
# are intentionally never materialized. Project every non-shadowed 404 into
# target-LOD tile equivalents and deduplicate stale nested absences.
absent_by_lod = {
    ancestor_lod: set()
    for ancestor_lod in range(lod, 4)
}
for ancestor_lod, tile_x, tile_z in absent_rows:
    absent_by_lod[int(ancestor_lod)].add((int(tile_x), int(tile_z)))

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
const LOCAL_COVERAGE_QUERY_TIMEOUT_MS = 5_000;

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
  readonly backingRoot?: string;
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

type JobStatus =
  | "running"
  | "stopping"
  | "complete"
  | "stopped"
  | "error";

interface LocalJob {
  readonly id: string;
  status: JobStatus;
  readonly request: RegionDownloadRequest;
  readonly startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  message: string;
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

export function parseRegionDownloadRequest(
  value: unknown,
): RegionDownloadRequest {
  if (!isRecord(value)) {
    throw new TypeError("La solicitud debe ser un objeto JSON");
  }

  const xMin = safeInteger(
    value.xMin,
    "xMin",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const zMin = safeInteger(
    value.zMin,
    "zMin",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const xMaxExclusive = safeInteger(
    value.xMaxExclusive,
    "xMaxExclusive",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const zMaxExclusive = safeInteger(
    value.zMaxExclusive,
    "zMaxExclusive",
    -WORLD_BORDER_BLOCKS,
    WORLD_BORDER_BLOCKS,
  );
  const requestedLod = safeInteger(value.lod, "lod", 0, 10);
  if (requestedLod !== 0) {
    throw new TypeError("La descarga regional usa únicamente LOD 0");
  }
  const lod = 0 as const;
  if (xMaxExclusive <= xMin || zMaxExclusive <= zMin) {
    throw new TypeError("La región debe tener ancho y alto positivos");
  }

  if (!Array.isArray(value.layers) || value.layers.length === 0) {
    throw new TypeError("Selecciona al menos una capa");
  }
  const layers = [...new Set(value.layers)];
  if (
    layers.length > ALLOWED_LAYERS.size ||
    layers.some(
      (layer) => typeof layer !== "string" || !ALLOWED_LAYERS.has(layer),
    )
  ) {
    throw new TypeError("Las capas solicitadas no son válidas");
  }
  if (!layers.includes("base")) {
    throw new TypeError("La descarga regional siempre incluye la capa base");
  }

  const requestsPerSecond = value.requestsPerSecond;
  if (
    typeof requestsPerSecond !== "number" ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond < 0.25 ||
    requestsPerSecond > 2
  ) {
    throw new TypeError(
      "El ritmo debe estar entre 0.25 y 2 solicitudes por segundo",
    );
  }

  const tileSpan = TILE_SIZE_PIXELS * 2 ** lod;
  if (
    xMin % tileSpan !== 0 ||
    zMin % tileSpan !== 0 ||
    xMaxExclusive % tileSpan !== 0 ||
    zMaxExclusive % tileSpan !== 0
  ) {
    throw new TypeError("La región debe estar alineada con su rejilla de tiles");
  }
  const tileCount =
    ((xMaxExclusive - xMin) / tileSpan) *
    ((zMaxExclusive - zMin) / tileSpan) *
    layers.length;
  if (tileCount > MAX_JOB_TILES) {
    throw new TypeError(
      `Una operación local admite como máximo ${MAX_JOB_TILES} tiles`,
    );
  }

  return {
    xMin,
    zMin,
    xMaxExclusive,
    zMaxExclusive,
    lod,
    layers: layers as RegionDownloadRequest["layers"],
    requestsPerSecond,
  };
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

async function readArchiveBytes(tileRoot: string): Promise<number> {
  try {
    const value = JSON.parse(
      await readFile(resolve(tileRoot, "progress.json"), "utf8"),
    ) as unknown;
    if (
      isRecord(value) &&
      typeof value.space_used_bytes === "number" &&
      Number.isSafeInteger(value.space_used_bytes) &&
      value.space_used_bytes >= 0
    ) {
      return value.space_used_bytes;
    }
  } catch {
    // A capacity snapshot can still be useful without legacy size metadata.
  }
  return 0;
}

async function optionalFileFingerprint(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    return `${metadata.size}:${metadata.mtimeMs}`;
  } catch {
    return "missing";
  }
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
  tileRoot: string,
  pythonBin: string,
  lod: number,
): Promise<LocalCoverageResult> {
  const databasePath = resolve(tileRoot, "tiles.sqlite3");
  const databaseStat = await stat(databasePath);
  if (!databaseStat.isFile()) {
    throw new Error("El catálogo local de tiles no es un archivo");
  }

  const cells = await new Promise<LocalCoverageResult["cells"]>(
    (resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(
        pythonBin,
        [
          "-c",
          LOCAL_COVERAGE_QUERY,
          databasePath,
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
    databaseUpdatedAt: databaseStat.mtime.toISOString(),
    cells,
  });
}

async function readCapacity(
  tileRoot: string | undefined,
  backingRoot: string | undefined,
  requirementBytes: number,
) {
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
    // Compare against free bytes alone. This is deliberately stronger than
    // crediting the existing mixed archive toward the Overworld reference.
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
  return {
    id: job.id,
    status: job.status,
    request: job.request,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    message: job.message,
  };
}

function startRegionJob(
  state: RuntimeState,
  request: RegionDownloadRequest,
  options: Required<
    Pick<LocalAtlasOptions, "tileRoot" | "pythonBin" | "projectRoot">
  >,
) {
  const job: LocalJob = {
    id: randomUUID(),
    status: "running",
    request,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    message: "Descargando la celda seleccionada",
  };
  const script = resolve(options.projectRoot, "download_region_2b2t.py");
  const tileSpan = TILE_SIZE_PIXELS * 2 ** request.lod;
  const tileCount =
    ((request.xMaxExclusive - request.xMin) / tileSpan) *
    ((request.zMaxExclusive - request.zMin) / tileSpan) *
    request.layers.length;
  const workers = Math.max(
    1,
    Math.min(4, Math.ceil(request.requestsPerSecond)),
  );
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

  // Drain both pipes so a verbose Python failure can never block the process.
  child.stdout.resume();
  child.stderr.resume();
  child.once("error", () => {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.message = "No se pudo iniciar el descargador regional";
    state.child = null;
  });
  child.once("exit", (code, signal) => {
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (job.status === "stopping" || code === 130 || signal === "SIGINT") {
      job.status = "stopped";
      job.message = "Descarga regional detenida de forma segura";
    } else if (code === 0) {
      job.status = "complete";
      job.message = "Celda disponible en la biblioteca local";
    } else {
      job.status = "error";
      job.message = "La descarga regional terminó con errores";
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
  const backingRoot = options.backingRoot?.trim()
    ? resolve(options.backingRoot)
    : undefined;
  const requirementBytes =
    options.overworldRequirementBytes &&
    Number.isSafeInteger(options.overworldRequirementBytes) &&
    options.overworldRequirementBytes > 0
      ? options.overworldRequirementBytes
      : DEFAULT_OVERWORLD_REQUIREMENT_BYTES;
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
  const coverageCache = new Map<
    number,
    { readonly fingerprint: string; readonly result: LocalCoverageResult }
  >();
  const coverageQueries = new Map<string, Promise<LocalCoverageResult>>();

  const readCachedLocalCoverage = async (
    lod: number,
  ): Promise<LocalCoverageResult> => {
    if (!tileRoot) {
      throw new Error("La biblioteca local no está configurada");
    }
    const databasePath = resolve(tileRoot, "tiles.sqlite3");
    const fingerprint = [
      await optionalFileFingerprint(databasePath),
      await optionalFileFingerprint(`${databasePath}-wal`),
    ].join("|");
    const cached = coverageCache.get(lod);
    if (cached?.fingerprint === fingerprint) return cached.result;
    const queryKey = `${lod}:${fingerprint}`;
    const existingQuery = coverageQueries.get(queryKey);
    if (existingQuery) return existingQuery;
    const query = queryLocalCoverage(tileRoot, pythonBin, lod)
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

  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: MiddlewareNext,
  ) => {
    const path = requestPath(request);
    if (
      path !== STATUS_ENDPOINT &&
      path !== COVERAGE_ENDPOINT &&
      path !== DOWNLOAD_ENDPOINT &&
      path !== STOP_ENDPOINT &&
      path !== WORKSPACE_ENDPOINT &&
      path !== TILE_ENDPOINT
    ) {
      next();
      return;
    }

    if (!requireLocalRequest(request, response)) return;

    if (path === COVERAGE_ENDPOINT && request.method === "GET") {
      const coverageRequest = parseLocalCoverageRequest(request.url);
      if (!coverageRequest) {
        writeJson(response, 400, {
          error: "Usa layer=base y un LOD entre 0 y 3",
        });
        return;
      }
      if (!tileRoot) {
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
      if (tileRoot) {
        const result = await tryServeLocalTile(request, response, tileRoot);
        if (result === "served") return;
      }
      writeEmpty(response, 404);
      return;
    }

    if (path === STATUS_ENDPOINT && request.method === "GET") {
      const [capacity, persistence] = await Promise.all([
        readCapacity(tileRoot, backingRoot, requirementBytes),
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
      if (!tileRoot) {
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
        const capacity = await readCapacity(
          tileRoot,
          backingRoot,
          requirementBytes,
        );
        const tileSpan = TILE_SIZE_PIXELS * 2 ** region.lod;
        const jobTiles =
          ((region.xMaxExclusive - region.xMin) / tileSpan) *
          ((region.zMaxExclusive - region.zMin) / tileSpan) *
          region.layers.length;
        const strictJobUpperBound = Math.ceil(
          jobTiles * MAX_TILE_BYTES * 1.2,
        );
        if (
          capacity.freeBytes === null ||
          capacity.freeBytes < strictJobUpperBound
        ) {
          writeJson(response, 507, {
            error: "No hay espacio verificado para esta celda",
            requiredBytes: strictJobUpperBound,
          });
          return;
        }
        const job = startRegionJob(state, region, {
          tileRoot,
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
