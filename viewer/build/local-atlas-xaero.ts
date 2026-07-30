import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AtlasWorkspaceDocument,
  AtlasWorkspaceHighlight,
} from "./local-atlas-workspace.ts";
import {
  highlightIsInsideRegionScope,
  highlightRegionBounds,
  highlightRegionDisplayName,
  highlightRegionKey,
  highlightRegionKeyFromScopeId,
} from "../app/lib/highlights.ts";

const execFileAsync = promisify(execFile);

export const XAERO_EXPORT_SCHEMA_VERSION = 1 as const;
export const XAERO_SERVER_DIRECTORY = "Multiplayer_2b2t.org";
export const XAERO_WAYPOINT_FILENAME = "mw$default_1.txt";
export const XAERO_EXPORT_MANIFEST_FILENAME =
  "xaero-export-manifest.v1.json";
export const XAERO_EXPORT_JOURNAL_FILENAME =
  ".xaero-export-transaction.v1.json";
export const XAERO_EXPORT_LOCK_FILENAME = ".xaero-export.lock";

const MAX_WAYPOINT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 10_000;
const XAERO_SET = "gui.xaero_default";
const XAERO_SUFFIX = " - Atlas";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BOOLEAN_PATTERN = /^(?:true|false)$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIMENSIONS = ["overworld", "nether"] as const;

type XaeroDimension = (typeof DIMENSIONS)[number];

export type XaeroExportOperation = "export" | "remove";
export type XaeroExportScope = "all" | "exploration";

export interface XaeroExportSelection {
  readonly operation: XaeroExportOperation;
  readonly scope: XaeroExportScope;
  readonly explorationId?: string;
}

export type XaeroExportErrorCode =
  | "XAERO_UNAVAILABLE"
  | "XAERO_UNSAFE_PATH"
  | "XAERO_INVALID_FILE"
  | "XAERO_MANIFEST_INVALID"
  | "XAERO_MINECRAFT_OPEN"
  | "XAERO_STALE_PREVIEW"
  | "XAERO_NO_CHANGES"
  | "XAERO_LOCKED"
  | "XAERO_RECOVERY_CONFLICT";

export class XaeroExportError extends Error {
  readonly code: XaeroExportErrorCode;

  constructor(message: string, code: XaeroExportErrorCode) {
    super(message);
    this.name = "XaeroExportError";
    this.code = code;
  }
}

export interface XaeroDimensionSummary {
  readonly existing: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly alreadyAbsent: number;
  readonly conflicts: number;
  readonly final: number;
}

export interface XaeroExportPreview {
  readonly version: typeof XAERO_EXPORT_SCHEMA_VERSION;
  readonly previewId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly operation: XaeroExportOperation;
  readonly scope: XaeroExportScope;
  readonly explorationId: string | null;
  readonly regionName: string | null;
  readonly minecraftOpen: boolean;
  readonly canExport: boolean;
  readonly hasChanges: boolean;
  readonly sourceHighlights: number;
  readonly selectedHighlights: number;
  readonly managedHighlights: number;
  readonly removableHighlights: number;
  readonly exportableHighlights: number;
  readonly skippedAreas: number;
  readonly notesNotExported: number;
  readonly duplicateNames: number;
  readonly conflicts: number;
  readonly overworld: XaeroDimensionSummary;
  readonly nether: XaeroDimensionSummary;
}

export interface XaeroExportResult extends XaeroExportPreview {
  readonly committed: true;
  readonly exportedAt: string;
  readonly backupId: string;
}

interface XaeroManifestTarget {
  readonly line: string;
  readonly lineHash: string;
}

interface XaeroManifestEntry {
  readonly highlightId: string;
  readonly overworld?: XaeroManifestTarget;
  readonly nether?: XaeroManifestTarget;
}

interface XaeroStoredExport {
  readonly writeId: string;
  readonly previewId: string;
  readonly result: XaeroExportResult;
}

interface XaeroManifest {
  readonly schemaVersion: typeof XAERO_EXPORT_SCHEMA_VERSION;
  readonly server: typeof XAERO_SERVER_DIRECTORY;
  readonly updatedAt: string | null;
  readonly entries: readonly XaeroManifestEntry[];
  readonly lastExport: XaeroStoredExport | null;
}

interface XaeroTransactionJournal {
  readonly schemaVersion: typeof XAERO_EXPORT_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly backupId: string;
  readonly before: {
    readonly overworld: string;
    readonly nether: string;
    readonly manifest: string | null;
  };
  readonly after: {
    readonly overworld: string;
    readonly nether: string;
    readonly manifest: string;
  };
}

interface XaeroExportLockOwner {
  readonly pid: number;
  readonly nonce: string;
  readonly startedAt: string;
}

interface TextDocument {
  readonly lines: readonly string[];
  readonly eol: "\n" | "\r\n";
  readonly trailingEol: boolean;
}

interface XaeroFileSnapshot {
  readonly dimension: XaeroDimension;
  readonly path: string;
  readonly bytes: Buffer;
  readonly hash: string;
  readonly mode: number;
  readonly document: TextDocument;
  readonly waypointCount: number;
}

interface ManifestSnapshot {
  readonly manifest: XaeroManifest;
  readonly bytes: Buffer | null;
  readonly hash: string | null;
  readonly mode: number;
}

interface DimensionPlan {
  readonly text: string;
  readonly hash: string;
  readonly summary: XaeroDimensionSummary;
}

interface XaeroExportPlan {
  readonly preview: XaeroExportPreview;
  readonly snapshots: Readonly<Record<XaeroDimension, XaeroFileSnapshot>>;
  readonly manifestSnapshot: ManifestSnapshot;
  readonly manifest: XaeroManifest;
  readonly manifestBytes: Buffer;
  readonly manifestHash: string;
  readonly dimensions: Readonly<Record<XaeroDimension, DimensionPlan>>;
}

interface ResolvedXaeroExportSelection {
  readonly operation: XaeroExportOperation;
  readonly scope: XaeroExportScope;
  readonly explorationId: string | null;
  readonly regionName: string | null;
  readonly bounds: {
    readonly minX: number;
    readonly minZ: number;
    readonly maxXExclusive: number;
    readonly maxZExclusive: number;
  } | null;
}

export interface LocalAtlasXaeroExporterOptions {
  readonly minecraftRoot: string;
  readonly backingRoot: string;
  readonly minecraftOpenProbe?: (lockPath: string) => Promise<boolean>;
  readonly now?: () => Date;
}

const ATLAS_COLOR_TO_XAERO = new Map<string, number>([
  ["#ff5f57", 12],
  ["#ffbd4a", 6],
  ["#26d9c7", 3],
  ["#62a8ff", 17],
  ["#c58cff", 13],
]);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathIsInside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return (
    difference.length === 0 ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !difference.startsWith(sep))
  );
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

function resolveExportSelection(
  workspace: AtlasWorkspaceDocument,
  selection?: XaeroExportSelection,
): ResolvedXaeroExportSelection {
  const operation = selection?.operation ?? "export";
  const scope = selection?.scope ?? "all";
  if (!(operation === "export" || operation === "remove")) {
    throw new TypeError("La operación Xaero debe ser export o remove");
  }
  if (!(scope === "all" || scope === "exploration")) {
    throw new TypeError("El alcance Xaero debe ser all o exploration");
  }
  if (scope === "all") {
    if (
      selection?.explorationId !== undefined &&
      selection.explorationId !== ""
    ) {
      throw new TypeError(
        "explorationId no corresponde al alcance global",
      );
    }
    return {
      operation,
      scope,
      explorationId: null,
      regionName: null,
      bounds: null,
    };
  }
  const explorationId = selection?.explorationId;
  if (
    typeof explorationId !== "string" ||
    explorationId.length === 0 ||
    explorationId.length > 100
  ) {
    throw new TypeError(
      "El alcance regional necesita un explorationId válido",
    );
  }
  const exploration = workspace.explorations.find(
    (candidate) => candidate.id === explorationId,
  );
  if (exploration) {
    return {
      operation,
      scope,
      explorationId,
      regionName: exploration.state.region.name,
      bounds: exploration.state.region.bounds,
    };
  }
  const regionKey = highlightRegionKeyFromScopeId(explorationId);
  const bounds = regionKey ? highlightRegionBounds(regionKey) : null;
  if (!regionKey || !bounds) {
    throw new TypeError("La región elegida ya no existe en el workspace");
  }
  return {
    operation,
    scope,
    explorationId,
    regionName: highlightRegionDisplayName(regionKey),
    bounds,
  };
}

function pointIsInsideSelection(
  x: number,
  z: number,
  selection: ResolvedXaeroExportSelection,
): boolean {
  const { bounds } = selection;
  return (
    bounds === null ||
    (x >= bounds.minX &&
      x < bounds.maxXExclusive &&
      z >= bounds.minZ &&
      z < bounds.maxZExclusive)
  );
}

function highlightIsInsideSelection(
  highlight: AtlasWorkspaceHighlight,
  selection: ResolvedXaeroExportSelection,
): boolean {
  if (selection.bounds === null) return true;
  return highlightIsInsideRegionScope(
    highlight,
    highlightRegionKey(selection.bounds),
  );
}

function manifestOverworldPoint(
  entry: XaeroManifestEntry,
): { readonly x: number; readonly z: number } | null {
  const line = entry.overworld?.line;
  if (!line) return null;
  const fields = line.split(":");
  const x = Number(fields[3]);
  const z = Number(fields[5]);
  return Number.isSafeInteger(x) && Number.isSafeInteger(z)
    ? { x, z }
    : null;
}

function normalizeWaypointTitle(title: string): string {
  if (title.includes("§§")) {
    throw new TypeError(
      "Un nombre contiene el token reservado §§ de Xaero",
    );
  }
  let base = title || "Highlight";
  while (base.endsWith(XAERO_SUFFIX)) {
    base = base.slice(0, -XAERO_SUFFIX.length);
  }
  return `${base || "Highlight"}${XAERO_SUFFIX}`;
}

function xaeroSafe(value: string): string {
  return value.replaceAll(":", "§§");
}

function waypointInitials(title: string): string {
  const words = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).find((character) => /[\p{L}\p{N}]/u.test(character)))
    .filter((character): character is string => Boolean(character));
  const initials =
    words.length >= 2
      ? `${words[0]}${words[1]}`
      : words[0] ??
        Array.from(title).find((character) => /[\p{L}\p{N}]/u.test(character)) ??
        "A";
  return xaeroSafe(initials.toLocaleUpperCase("es-GT").slice(0, 2));
}

export function netherCoordinate(overworldCoordinate: number): number {
  if (!Number.isSafeInteger(overworldCoordinate)) {
    throw new TypeError("La coordenada del Overworld debe ser entera");
  }
  return Math.floor(overworldCoordinate / 8);
}

export function xaeroColorIndex(color: string): number {
  return ATLAS_COLOR_TO_XAERO.get(color.toLowerCase()) ?? 11;
}

export function xaeroWaypointLine(
  highlight: AtlasWorkspaceHighlight,
  dimension: XaeroDimension,
): string {
  if (highlight.type !== "pin") {
    throw new TypeError("Xaero solo admite highlights de punto");
  }
  const x =
    dimension === "nether" ? netherCoordinate(highlight.x) : highlight.x;
  const z =
    dimension === "nether" ? netherCoordinate(highlight.z) : highlight.z;
  const title = xaeroSafe(normalizeWaypointTitle(highlight.title));
  const initials = waypointInitials(highlight.title);
  return [
    "waypoint",
    title,
    initials,
    String(x),
    "~",
    String(z),
    String(xaeroColorIndex(highlight.color)),
    String(!highlight.visible),
    "0",
    XAERO_SET,
    "false",
    "0",
    "0",
    "false",
  ].join(":");
}

function parseTextDocument(text: string): TextDocument {
  const containsCrLf = text.includes("\r\n");
  const withoutCrLf = text.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) {
    throw new XaeroExportError(
      "El archivo de Xaero mezcla finales de línea incompatibles",
      "XAERO_INVALID_FILE",
    );
  }
  const eol = containsCrLf ? "\r\n" : "\n";
  const trailingEol = text.endsWith(eol);
  const lines = text.split(eol);
  if (trailingEol) lines.pop();
  return { lines, eol, trailingEol };
}

function renderTextDocument(document: TextDocument): string {
  return `${document.lines.join(document.eol)}${
    document.trailingEol ? document.eol : ""
  }`;
}

function isXaeroBooleanOrVisibility(value: string): boolean {
  return (
    BOOLEAN_PATTERN.test(value) ||
    (INTEGER_PATTERN.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= 0)
  );
}

function validateWaypointLine(line: string): void {
  const fields = line.split(":");
  if (
    fields.length !== 14 ||
    fields[0] !== "waypoint" ||
    fields[1].length === 0 ||
    fields[2].length === 0 ||
    !INTEGER_PATTERN.test(fields[3]) ||
    !(fields[4] === "~" || INTEGER_PATTERN.test(fields[4])) ||
    !INTEGER_PATTERN.test(fields[5]) ||
    !INTEGER_PATTERN.test(fields[6]) ||
    Number(fields[6]) < 0 ||
    Number(fields[6]) > 20 ||
    !BOOLEAN_PATTERN.test(fields[7]) ||
    !INTEGER_PATTERN.test(fields[8]) ||
    fields[9].length === 0 ||
    !BOOLEAN_PATTERN.test(fields[10]) ||
    !INTEGER_PATTERN.test(fields[11]) ||
    !isXaeroBooleanOrVisibility(fields[12]) ||
    !BOOLEAN_PATTERN.test(fields[13])
  ) {
    throw new XaeroExportError(
      "El archivo de Xaero contiene un waypoint no válido",
      "XAERO_INVALID_FILE",
    );
  }
  for (const coordinate of [fields[3], fields[5]]) {
    if (!Number.isSafeInteger(Number(coordinate))) {
      throw new XaeroExportError(
        "El archivo de Xaero contiene coordenadas inseguras",
        "XAERO_INVALID_FILE",
      );
    }
  }
}

function validateWaypointDocument(document: TextDocument): number {
  let waypointCount = 0;
  let sawHeader = false;
  for (const line of document.lines) {
    if (
      line ===
      "#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination"
    ) {
      sawHeader = true;
      continue;
    }
    if (line.length === 0 || line.startsWith("#") || line.startsWith("sets:")) {
      continue;
    }
    validateWaypointLine(line);
    waypointCount += 1;
  }
  if (!sawHeader) {
    throw new XaeroExportError(
      "El archivo no usa el encabezado esperado de Xaero 26.4.2",
      "XAERO_INVALID_FILE",
    );
  }
  return waypointCount;
}

function serializeManifest(manifest: XaeroManifest): Buffer {
  const entries = [...manifest.entries].sort((left, right) =>
    left.highlightId.localeCompare(right.highlightId),
  );
  return Buffer.from(
    `${JSON.stringify({ ...manifest, entries }, null, 2)}\n`,
    "utf8",
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseStoredDimensionSummary(
  value: unknown,
): XaeroDimensionSummary {
  const removed = isRecord(value)
    ? value.removed === undefined
      ? 0
      : value.removed
    : undefined;
  const alreadyAbsent = isRecord(value)
    ? value.alreadyAbsent === undefined
      ? 0
      : value.alreadyAbsent
    : undefined;
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.existing) ||
    !isNonNegativeSafeInteger(value.added) ||
    !isNonNegativeSafeInteger(value.updated) ||
    !isNonNegativeSafeInteger(value.unchanged) ||
    !isNonNegativeSafeInteger(removed) ||
    !isNonNegativeSafeInteger(alreadyAbsent) ||
    !isNonNegativeSafeInteger(value.conflicts) ||
    !isNonNegativeSafeInteger(value.final) ||
    value.final !== value.existing + value.added - removed
  ) {
    throw new XaeroExportError(
      "El último resultado Xaero contiene métricas inválidas",
      "XAERO_MANIFEST_INVALID",
    );
  }
  return {
    existing: value.existing,
    added: value.added,
    updated: value.updated,
    unchanged: value.unchanged,
    removed,
    alreadyAbsent,
    conflicts: value.conflicts,
    final: value.final,
  };
}

function parseStoredExport(value: unknown): XaeroStoredExport | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.writeId !== "string" ||
    !UUID_PATTERN.test(value.writeId) ||
    typeof value.previewId !== "string" ||
    !HASH_PATTERN.test(value.previewId) ||
    !isRecord(value.result)
  ) {
    throw new XaeroExportError(
      "El último resultado Xaero no es válido",
      "XAERO_MANIFEST_INVALID",
    );
  }
  const result = value.result;
  const overworld = parseStoredDimensionSummary(result.overworld);
  const nether = parseStoredDimensionSummary(result.nether);
  const operation =
    result.operation === undefined ? "export" : result.operation;
  const scope = result.scope === undefined ? "all" : result.scope;
  const explorationId =
    result.explorationId === undefined ? null : result.explorationId;
  const regionName =
    result.regionName === undefined ? null : result.regionName;
  const selectedHighlights =
    result.selectedHighlights === undefined
      ? result.sourceHighlights
      : result.selectedHighlights;
  const managedHighlights =
    result.managedHighlights === undefined ? 0 : result.managedHighlights;
  const removableHighlights =
    result.removableHighlights === undefined
      ? 0
      : result.removableHighlights;
  if (
    result.version !== XAERO_EXPORT_SCHEMA_VERSION ||
    result.previewId !== value.previewId ||
    typeof result.workspaceId !== "string" ||
    !UUID_PATTERN.test(result.workspaceId) ||
    !isNonNegativeSafeInteger(result.workspaceRevision) ||
    !(operation === "export" || operation === "remove") ||
    !(scope === "all" || scope === "exploration") ||
    !(
      explorationId === null ||
      (typeof explorationId === "string" &&
        explorationId.length > 0 &&
        explorationId.length <= 100)
    ) ||
    (scope === "all" && explorationId !== null) ||
    (scope === "exploration" && explorationId === null) ||
    !(
      regionName === null ||
      (typeof regionName === "string" && regionName.length <= 200)
    ) ||
    result.minecraftOpen !== false ||
    result.canExport !== false ||
    result.hasChanges !== false ||
    !isNonNegativeSafeInteger(result.sourceHighlights) ||
    !isNonNegativeSafeInteger(selectedHighlights) ||
    !isNonNegativeSafeInteger(managedHighlights) ||
    !isNonNegativeSafeInteger(removableHighlights) ||
    !isNonNegativeSafeInteger(result.exportableHighlights) ||
    !isNonNegativeSafeInteger(result.skippedAreas) ||
    !isNonNegativeSafeInteger(result.notesNotExported) ||
    !isNonNegativeSafeInteger(result.duplicateNames) ||
    !isNonNegativeSafeInteger(result.conflicts) ||
    result.conflicts < Math.max(overworld.conflicts, nether.conflicts) ||
    result.conflicts > overworld.conflicts + nether.conflicts ||
    result.committed !== true ||
    typeof result.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(result.exportedAt)) ||
    typeof result.backupId !== "string" ||
    result.backupId.length > 160 ||
    !UUID_PATTERN.test(result.backupId.slice(-36))
  ) {
    throw new XaeroExportError(
      "El último resultado Xaero no coincide con el manifiesto",
      "XAERO_MANIFEST_INVALID",
    );
  }
  return {
    writeId: value.writeId,
    previewId: value.previewId,
    result: {
      version: XAERO_EXPORT_SCHEMA_VERSION,
      previewId: result.previewId,
      workspaceId: result.workspaceId,
      workspaceRevision: result.workspaceRevision,
      operation,
      scope,
      explorationId,
      regionName,
      minecraftOpen: false,
      canExport: false,
      hasChanges: false,
      sourceHighlights: result.sourceHighlights,
      selectedHighlights,
      managedHighlights,
      removableHighlights,
      exportableHighlights: result.exportableHighlights,
      skippedAreas: result.skippedAreas,
      notesNotExported: result.notesNotExported,
      duplicateNames: result.duplicateNames,
      conflicts: result.conflicts,
      overworld,
      nether,
      committed: true,
      exportedAt: result.exportedAt,
      backupId: result.backupId,
    },
  };
}

function parseManifest(value: unknown): XaeroManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== XAERO_EXPORT_SCHEMA_VERSION ||
    value.server !== XAERO_SERVER_DIRECTORY ||
    !(
      value.updatedAt === null ||
      (typeof value.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.updatedAt)))
    ) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_MANIFEST_ENTRIES
  ) {
    throw new XaeroExportError(
      "El manifiesto de exportación Xaero no es válido",
      "XAERO_MANIFEST_INVALID",
    );
  }
  const ids = new Set<string>();
  const entries = value.entries.map((candidate): XaeroManifestEntry => {
    if (
      !isRecord(candidate) ||
      typeof candidate.highlightId !== "string" ||
      candidate.highlightId.length === 0 ||
      candidate.highlightId.length > 100 ||
      ids.has(candidate.highlightId)
    ) {
      throw new XaeroExportError(
        "El manifiesto Xaero contiene identificadores inválidos",
        "XAERO_MANIFEST_INVALID",
      );
    }
    ids.add(candidate.highlightId);
    const readTarget = (
      target: unknown,
    ): XaeroManifestTarget | undefined => {
      if (target === undefined) return undefined;
      if (
        !isRecord(target) ||
        typeof target.line !== "string" ||
        !target.line.startsWith("waypoint:") ||
        typeof target.lineHash !== "string" ||
        !HASH_PATTERN.test(target.lineHash) ||
        sha256(target.line) !== target.lineHash
      ) {
        throw new XaeroExportError(
          "El manifiesto Xaero contiene una fila inválida",
          "XAERO_MANIFEST_INVALID",
        );
      }
      validateWaypointLine(target.line);
      return { line: target.line, lineHash: target.lineHash };
    };
    const overworld = readTarget(candidate.overworld);
    const nether = readTarget(candidate.nether);
    if (!overworld && !nether) {
      throw new XaeroExportError(
        "El manifiesto Xaero contiene una entrada vacía",
        "XAERO_MANIFEST_INVALID",
      );
    }
    return {
      highlightId: candidate.highlightId,
      ...(overworld ? { overworld } : {}),
      ...(nether ? { nether } : {}),
    };
  });
  return {
    schemaVersion: XAERO_EXPORT_SCHEMA_VERSION,
    server: XAERO_SERVER_DIRECTORY,
    updatedAt: value.updatedAt as string | null,
    entries,
    lastExport: parseStoredExport(value.lastExport),
  };
}

function emptyManifest(): XaeroManifest {
  return {
    schemaVersion: XAERO_EXPORT_SCHEMA_VERSION,
    server: XAERO_SERVER_DIRECTORY,
    updatedAt: null,
    entries: [],
    lastExport: null,
  };
}

async function fileHash(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeDurableExclusive(
  path: string,
  bytes: Buffer | string,
  mode = 0o600,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function atomicReplace(
  path: string,
  bytes: Buffer,
  mode: number,
  expectedHash?: string | null,
): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(
    directory,
    `.${path.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode & 0o777);
    await handle.close();
    handle = undefined;
    if (
      expectedHash !== undefined &&
      (await fileHash(path)) !== expectedHash
    ) {
      throw new XaeroExportError(
        "Xaero cambió después de la previsualización",
        "XAERO_STALE_PREVIEW",
      );
    }
    await rename(temporary, path);
    await fsyncDirectory(directory);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function defaultMinecraftOpenProbe(lockPath: string): Promise<boolean> {
  const pgrepPath = existsSync("/usr/bin/pgrep") ? "/usr/bin/pgrep" : "pgrep";
  try {
    await execFileAsync(
      pgrepPath,
      [
        "-f",
        "net\\.minecraft\\.client\\.main\\.Main|net\\.fabricmc\\.loader\\.impl\\.launch\\.knot\\.KnotClient",
      ],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return true;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code !== 1) {
      throw new XaeroExportError(
        "No se pudo comprobar si Minecraft está abierto",
        "XAERO_UNAVAILABLE",
      );
    }
  }
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const lsofPath = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  try {
    const { stdout } = await execFileAsync(
      lsofPath,
      ["-F", "p", lockPath],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return stdout.split(/\r?\n/).some((line) => /^p\d+$/.test(line));
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return false;
    throw new XaeroExportError(
      "No se pudo comprobar si Minecraft está abierto",
      "XAERO_UNAVAILABLE",
    );
  }
}

export class LocalAtlasXaeroExporter {
  readonly minecraftRoot: string;
  readonly backingRoot: string;
  readonly stateDirectory: string;
  readonly backupRoot: string;
  readonly manifestPath: string;
  readonly journalPath: string;
  readonly exportLockPath: string;
  readonly lockPath: string;
  readonly overworldPath: string;
  readonly netherPath: string;

  private readonly minecraftOpenProbe: (
    lockPath: string,
  ) => Promise<boolean>;
  private readonly now: () => Date;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: LocalAtlasXaeroExporterOptions) {
    if (
      typeof options.minecraftRoot !== "string" ||
      options.minecraftRoot.trim().length === 0 ||
      typeof options.backingRoot !== "string" ||
      options.backingRoot.trim().length === 0
    ) {
      throw new XaeroExportError(
        "Minecraft y LuisA deben estar configurados",
        "XAERO_UNAVAILABLE",
      );
    }
    this.minecraftRoot = resolve(options.minecraftRoot);
    this.backingRoot = resolve(options.backingRoot);
    this.stateDirectory = resolve(
      this.backingRoot,
      "ObsidianAtlas",
      "state",
    );
    this.backupRoot = resolve(
      this.backingRoot,
      "ObsidianAtlas",
      "backups",
      "xaero",
    );
    this.manifestPath = resolve(
      this.stateDirectory,
      XAERO_EXPORT_MANIFEST_FILENAME,
    );
    this.journalPath = resolve(
      this.stateDirectory,
      XAERO_EXPORT_JOURNAL_FILENAME,
    );
    this.exportLockPath = resolve(
      this.stateDirectory,
      XAERO_EXPORT_LOCK_FILENAME,
    );
    this.lockPath = resolve(
      this.minecraftRoot,
      "xaero",
      "world-map",
      XAERO_SERVER_DIRECTORY,
      "null",
      "mw$default",
      ".lock",
    );
    const waypointRoot = resolve(
      this.minecraftRoot,
      "xaero",
      "minimap",
      XAERO_SERVER_DIRECTORY,
    );
    this.overworldPath = resolve(
      waypointRoot,
      "dim%0",
      XAERO_WAYPOINT_FILENAME,
    );
    this.netherPath = resolve(
      waypointRoot,
      "dim%-1",
      XAERO_WAYPOINT_FILENAME,
    );
    for (const target of [
      this.stateDirectory,
      this.backupRoot,
      this.manifestPath,
      this.journalPath,
      this.exportLockPath,
    ]) {
      if (!pathIsInside(this.backingRoot, target)) {
        throw new XaeroExportError(
          "La exportación intentó salir de LuisA",
          "XAERO_UNSAFE_PATH",
        );
      }
    }
    for (const target of [
      this.lockPath,
      this.overworldPath,
      this.netherPath,
    ]) {
      if (!pathIsInside(this.minecraftRoot, target)) {
        throw new XaeroExportError(
          "La exportación intentó salir de Minecraft",
          "XAERO_UNSAFE_PATH",
        );
      }
    }
    this.minecraftOpenProbe =
      options.minecraftOpenProbe ?? defaultMinecraftOpenProbe;
    this.now = options.now ?? (() => new Date());
  }

  async preview(
    workspace: AtlasWorkspaceDocument,
    selection?: XaeroExportSelection,
  ): Promise<XaeroExportPreview> {
    return this.enqueue(async () => {
      await this.ensureDirectories();
      return this.withExportLock(async () => {
        const minecraftOpen = await this.minecraftOpenProbe(this.lockPath);
        if (!minecraftOpen) await this.recoverPendingTransaction();
        const plan = await this.buildPlan(
          workspace,
          minecraftOpen,
          resolveExportSelection(workspace, selection),
        );
        return plan.preview;
      });
    });
  }

  async commit(
    workspace: AtlasWorkspaceDocument,
    expectedPreviewId: string,
    writeId: string,
    selection?: XaeroExportSelection,
  ): Promise<XaeroExportResult> {
    return this.enqueue(async () => {
      await this.ensureDirectories();
      return this.withExportLock(async () => {
        if (!UUID_PATTERN.test(writeId)) {
          throw new TypeError("X-Atlas-Write-Id debe ser un UUID válido");
        }
        const previousExport = (await this.readManifest()).manifest.lastExport;
        const resolvedSelection = resolveExportSelection(
          workspace,
          selection,
        );
        if (previousExport?.writeId === writeId) {
          if (
            previousExport.previewId !== expectedPreviewId ||
            previousExport.result.workspaceId !== workspace.workspaceId ||
            previousExport.result.workspaceRevision !== workspace.revision ||
            previousExport.result.operation !==
              resolvedSelection.operation ||
            previousExport.result.scope !== resolvedSelection.scope ||
            previousExport.result.explorationId !==
              resolvedSelection.explorationId
          ) {
            throw new XaeroExportError(
              "X-Atlas-Write-Id ya pertenece a otra exportación",
              "XAERO_STALE_PREVIEW",
            );
          }
          return previousExport.result;
        }
        if (await this.minecraftOpenProbe(this.lockPath)) {
          throw new XaeroExportError(
            "Cierra Minecraft antes de exportar a Xaero",
            "XAERO_MINECRAFT_OPEN",
          );
        }
        await this.recoverPendingTransaction();
        const plan = await this.buildPlan(
          workspace,
          false,
          resolvedSelection,
        );
        if (
          typeof expectedPreviewId !== "string" ||
          expectedPreviewId !== plan.preview.previewId
        ) {
          throw new XaeroExportError(
            "La previsualización ya no coincide con Atlas o Xaero",
            "XAERO_STALE_PREVIEW",
          );
        }
        if (!plan.preview.hasChanges) {
          throw new XaeroExportError(
            resolvedSelection.operation === "remove"
              ? "No hay highlights Atlas removibles en este alcance"
              : "Xaero ya contiene esta versión de los highlights",
            "XAERO_NO_CHANGES",
          );
        }

        const transactionId = randomUUID();
        const committedAt = this.now();
        const backupId = `${safeTimestamp(committedAt)}-${transactionId}`;
        const backupDirectory = resolve(this.backupRoot, backupId);
        const result: XaeroExportResult = {
          ...plan.preview,
          minecraftOpen: false,
          canExport: false,
          hasChanges: false,
          committed: true,
          exportedAt: committedAt.toISOString(),
          backupId,
        };
        const committedManifest: XaeroManifest = {
          ...plan.manifest,
          lastExport: {
            writeId,
            previewId: expectedPreviewId,
            result,
          },
        };
        const committedManifestBytes = serializeManifest(committedManifest);
        const committedPlan: XaeroExportPlan = {
          ...plan,
          manifest: committedManifest,
          manifestBytes: committedManifestBytes,
          manifestHash: sha256(committedManifestBytes),
        };
        const journal: XaeroTransactionJournal = {
          schemaVersion: XAERO_EXPORT_SCHEMA_VERSION,
          transactionId,
          backupId,
          before: {
            overworld: plan.snapshots.overworld.hash,
            nether: plan.snapshots.nether.hash,
            manifest: plan.manifestSnapshot.hash,
          },
          after: {
            overworld: plan.dimensions.overworld.hash,
            nether: plan.dimensions.nether.hash,
            manifest: committedPlan.manifestHash,
          },
        };

        let installedTargets = 0;
        try {
          await this.createBackup(
            backupDirectory,
            workspace,
            committedPlan,
          );
          await this.createJournal(journal);
          await this.assertMinecraftClosed(
            "Minecraft se abrió antes de instalar Overworld; no se aplicaron cambios",
          );
          await atomicReplace(
            this.overworldPath,
            Buffer.from(plan.dimensions.overworld.text, "utf8"),
            plan.snapshots.overworld.mode,
            plan.snapshots.overworld.hash,
          );
          installedTargets = 1;
          await this.assertMinecraftClosed(
            "Minecraft se abrió durante la instalación de Overworld; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await this.assertMinecraftClosed(
            "Minecraft se abrió antes de instalar Nether; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await atomicReplace(
            this.netherPath,
            Buffer.from(plan.dimensions.nether.text, "utf8"),
            plan.snapshots.nether.mode,
            plan.snapshots.nether.hash,
          );
          installedTargets = 2;
          await this.assertMinecraftClosed(
            "Minecraft se abrió durante la instalación de Nether; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await this.assertMinecraftClosed(
            "Minecraft se abrió antes de guardar el manifiesto; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await atomicReplace(
            this.manifestPath,
            committedPlan.manifestBytes,
            plan.manifestSnapshot.mode,
            plan.manifestSnapshot.hash,
          );
          await this.assertMinecraftClosed(
            "Minecraft se abrió mientras se guardaba el manifiesto; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await this.verifyCommitted(committedPlan);
          await this.assertMinecraftClosed(
            "Minecraft se abrió antes de finalizar la exportación; la recuperación continuará cuando vuelva a estar cerrado",
          );
          await unlink(this.journalPath);
          await fsyncDirectory(this.stateDirectory);
        } catch (error) {
          // Never write either Xaero target while Minecraft may be using it.
          // The durable journal and backup allow the next closed-state preview
          // or commit to recover the pair safely.
          if (
            installedTargets === 0 &&
            error instanceof XaeroExportError &&
            error.code === "XAERO_STALE_PREVIEW"
          ) {
            // The first compare-and-swap rejected an external edit before
            // Atlas renamed either target. Preserve that edit and release only
            // this transaction's journal.
            await unlink(this.journalPath);
            await fsyncDirectory(this.stateDirectory);
            throw error;
          }
          let minecraftClosed = false;
          try {
            minecraftClosed = !(await this.minecraftOpenProbe(this.lockPath));
          } catch {
            minecraftClosed = false;
          }
          if (minecraftClosed) {
            await this.rollbackKnownTransaction(
              journal,
              backupDirectory,
            ).catch(() => undefined);
          }
          throw error;
        }
        return result;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release: () => void = () => undefined;
    this.operationTail = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(release);
  }

  private async assertMinecraftClosed(message: string): Promise<void> {
    if (await this.minecraftOpenProbe(this.lockPath)) {
      throw new XaeroExportError(message, "XAERO_MINECRAFT_OPEN");
    }
  }

  private async withExportLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner: XaeroExportLockOwner = {
      pid: process.pid,
      nonce: randomUUID(),
      startedAt: this.now().toISOString(),
    };
    await this.acquireExportLock(owner);
    try {
      return await operation();
    } finally {
      await this.releaseExportLock(owner);
    }
  }

  private async acquireExportLock(
    owner: XaeroExportLockOwner,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await writeDurableExclusive(
          this.exportLockPath,
          `${JSON.stringify(owner)}\n`,
        );
        await fsyncDirectory(this.stateDirectory);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = await this.readExportLock();
      if (this.processIsAlive(existing.pid)) {
        throw new XaeroExportError(
          "Otra instancia de Atlas está usando la exportación Xaero",
          "XAERO_LOCKED",
        );
      }
      const stalePath = `${this.exportLockPath}.stale.${existing.pid}.${randomUUID()}`;
      try {
        await rename(this.exportLockPath, stalePath);
        await fsyncDirectory(this.stateDirectory);
        await rm(stalePath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new XaeroExportError(
      "No se pudo adquirir el bloqueo seguro de Xaero",
      "XAERO_LOCKED",
    );
  }

  private async releaseExportLock(
    owner: XaeroExportLockOwner,
  ): Promise<void> {
    const existing = await this.readExportLock();
    if (
      existing.pid !== owner.pid ||
      existing.nonce !== owner.nonce
    ) {
      throw new XaeroExportError(
        "El bloqueo de Xaero cambió durante la operación",
        "XAERO_LOCKED",
      );
    }
    await unlink(this.exportLockPath);
    await fsyncDirectory(this.stateDirectory);
  }

  private async readExportLock(): Promise<XaeroExportLockOwner> {
    let metadata;
    let value: unknown;
    try {
      metadata = await lstat(this.exportLockPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size <= 0 ||
        metadata.size > 4_096
      ) {
        throw new Error("invalid");
      }
      value = JSON.parse(await readFile(this.exportLockPath, "utf8")) as unknown;
    } catch {
      throw new XaeroExportError(
        "El bloqueo de exportación Xaero no es seguro",
        "XAERO_LOCKED",
      );
    }
    if (
      !isRecord(value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.nonce !== "string" ||
      !UUID_PATTERN.test(value.nonce) ||
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt))
    ) {
      throw new XaeroExportError(
        "El bloqueo de exportación Xaero no es válido",
        "XAERO_LOCKED",
      );
    }
    return {
      pid: value.pid,
      nonce: value.nonce,
      startedAt: value.startedAt,
    };
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async ensureDirectories(): Promise<void> {
    await this.ensurePrivateDirectory(this.stateDirectory);
    await this.ensurePrivateDirectory(
      resolve(this.backingRoot, "ObsidianAtlas", "backups"),
    );
    await this.ensurePrivateDirectory(this.backupRoot);
    const [realMinecraftRoot, realBackingRoot] = await Promise.all([
      realpath(this.minecraftRoot),
      realpath(this.backingRoot),
    ]).catch(() => {
      throw new XaeroExportError(
        "Minecraft o LuisA no están disponibles",
        "XAERO_UNAVAILABLE",
      );
    });
    for (const target of [this.overworldPath, this.netherPath]) {
      let metadata;
      let realTarget;
      try {
        [metadata, realTarget] = await Promise.all([
          lstat(target),
          realpath(target),
        ]);
      } catch {
        throw new XaeroExportError(
          "No se encontraron los waypoints activos de Xaero para 2b2t",
          "XAERO_UNAVAILABLE",
        );
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        !pathIsInside(realMinecraftRoot, realTarget)
      ) {
        throw new XaeroExportError(
          "La ruta de waypoints de Xaero no es segura",
          "XAERO_UNSAFE_PATH",
        );
      }
    }
    const [realStateDirectory, realBackupRoot] = await Promise.all([
      realpath(this.stateDirectory),
      realpath(this.backupRoot),
    ]);
    if (
      !pathIsInside(realBackingRoot, realStateDirectory) ||
      !pathIsInside(realBackingRoot, realBackupRoot)
    ) {
      throw new XaeroExportError(
        "Las carpetas de estado o respaldo de Xaero salen de LuisA",
        "XAERO_UNSAFE_PATH",
      );
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new XaeroExportError(
        "La carpeta de exportación Xaero no es segura",
        "XAERO_UNSAFE_PATH",
      );
    }
    await chmod(path, 0o700);
  }

  private async readXaeroFile(
    dimension: XaeroDimension,
    path: string,
  ): Promise<XaeroFileSnapshot> {
    const metadata = await stat(path);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_WAYPOINT_FILE_BYTES
    ) {
      throw new XaeroExportError(
        "El archivo de waypoints Xaero tiene un tamaño inválido",
        "XAERO_INVALID_FILE",
      );
    }
    const bytes = await readFile(path);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new XaeroExportError(
        "El archivo de waypoints Xaero no es UTF-8 válido",
        "XAERO_INVALID_FILE",
      );
    }
    const document = parseTextDocument(text);
    return {
      dimension,
      path,
      bytes,
      hash: sha256(bytes),
      mode: metadata.mode & 0o777,
      document,
      waypointCount: validateWaypointDocument(document),
    };
  }

  private async readManifest(): Promise<ManifestSnapshot> {
    try {
      const metadata = await lstat(this.manifestPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size <= 0 ||
        metadata.size > MAX_MANIFEST_BYTES
      ) {
        throw new XaeroExportError(
          "El manifiesto Xaero no es un archivo seguro",
          "XAERO_MANIFEST_INVALID",
        );
      }
      const bytes = await readFile(this.manifestPath);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
      } catch {
        throw new XaeroExportError(
          "El manifiesto Xaero no contiene JSON UTF-8 válido",
          "XAERO_MANIFEST_INVALID",
        );
      }
      return {
        manifest: parseManifest(value),
        bytes,
        hash: sha256(bytes),
        mode: metadata.mode & 0o777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        manifest: emptyManifest(),
        bytes: null,
        hash: null,
        mode: 0o600,
      };
    }
  }

  private async buildPlan(
    workspace: AtlasWorkspaceDocument,
    minecraftOpen: boolean,
    selection: ResolvedXaeroExportSelection,
  ): Promise<XaeroExportPlan> {
    const [overworld, nether, manifestSnapshot] = await Promise.all([
      this.readXaeroFile("overworld", this.overworldPath),
      this.readXaeroFile("nether", this.netherPath),
      this.readManifest(),
    ]);
    const snapshots = { overworld, nether } as const;
    const lines = {
      overworld: [...overworld.document.lines],
      nether: [...nether.document.lines],
    };
    const counts = {
      overworld: {
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        alreadyAbsent: 0,
        conflicts: 0,
      },
      nether: {
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        alreadyAbsent: 0,
        conflicts: 0,
      },
    };
    const manifestEntries = new Map(
      manifestSnapshot.manifest.entries.map((entry) => [
        entry.highlightId,
        entry,
      ]),
    );
    const selectedHighlights = workspace.highlights.filter((highlight) =>
      highlightIsInsideSelection(highlight, selection),
    );
    const selectedPins = selectedHighlights.filter(
      (highlight): highlight is AtlasWorkspaceHighlight & {
        readonly type: "pin";
      } => highlight.type === "pin",
    );
    const selectedAreas = selectedHighlights.filter(
      (highlight) => highlight.type === "area",
    );
    let conflicts = 0;
    let managedHighlights = 0;
    let removableHighlights = 0;

    if (selection.operation === "export") {
      managedHighlights = selectedPins.filter((highlight) =>
        manifestEntries.has(highlight.id),
      ).length;
      const desired = selectedPins.flatMap((highlight) => {
        try {
          return [{
            highlight,
            overworld: xaeroWaypointLine(highlight, "overworld"),
            nether: xaeroWaypointLine(highlight, "nether"),
          }];
        } catch (error) {
          if (error instanceof TypeError) return [];
          throw error;
        }
      });
      const formatConflicts = selectedPins.length - desired.length;
      conflicts = formatConflicts;
      for (const dimension of DIMENSIONS) {
        counts[dimension].conflicts += formatConflicts;
      }
      const duplicateDesiredIds = new Set<string>();
      const desiredPairs = new Map<string, string>();
      for (const item of desired) {
        const key = `${item.overworld}\u0000${item.nether}`;
        const previous = desiredPairs.get(key);
        if (previous !== undefined) {
          duplicateDesiredIds.add(previous);
          duplicateDesiredIds.add(item.highlight.id);
        } else {
          desiredPairs.set(key, item.highlight.id);
        }
      }

      for (const item of desired) {
        const existingEntry = manifestEntries.get(item.highlight.id);
        if (
          existingEntry &&
          DIMENSIONS.every((dimension) => {
            const target = existingEntry[dimension];
            return (
              target !== undefined &&
              lines[dimension].filter(
                (line) => line === target.line,
              ).length === 1
            );
          })
        ) {
          removableHighlights += 1;
        }
        const operations = Object.fromEntries(
          DIMENSIONS.map((dimension) => {
            const desiredLine = item[dimension];
            const oldTarget = existingEntry?.[dimension];
            const currentLines = lines[dimension];
            if (!oldTarget) {
              return [
                dimension,
                currentLines.includes(desiredLine)
                  ? ({ kind: "conflict" } as const)
                  : ({ kind: "add", desiredLine } as const),
              ] as const;
            }
            const oldIndices = currentLines
              .map((line, index) =>
                line === oldTarget.line ? index : -1,
              )
              .filter((index) => index >= 0);
            if (oldIndices.length !== 1) {
              return [
                dimension,
                { kind: "conflict" } as const,
              ] as const;
            }
            if (oldTarget.line === desiredLine) {
              return [
                dimension,
                { kind: "unchanged", desiredLine } as const,
              ] as const;
            }
            return [
              dimension,
              {
                kind: "update",
                index: oldIndices[0],
                desiredLine,
              } as const,
            ] as const;
          }),
        ) as Readonly<
          Record<
            XaeroDimension,
            | { readonly kind: "conflict" }
            | { readonly kind: "add"; readonly desiredLine: string }
            | {
                readonly kind: "unchanged";
                readonly desiredLine: string;
              }
            | {
                readonly kind: "update";
                readonly index: number;
                readonly desiredLine: string;
              }
          >
        >;
        if (
          duplicateDesiredIds.has(item.highlight.id) ||
          DIMENSIONS.some(
            (dimension) => operations[dimension].kind === "conflict",
          )
        ) {
          conflicts += 1;
          for (const dimension of DIMENSIONS) {
            counts[dimension].conflicts += 1;
          }
          continue;
        }
        const nextTargets: Partial<
          Record<XaeroDimension, XaeroManifestTarget>
        > = {};
        for (const dimension of DIMENSIONS) {
          const operation = operations[dimension];
          if (operation.kind === "conflict") {
            throw new XaeroExportError(
              "La planificación Xaero cambió de forma inesperada",
              "XAERO_STALE_PREVIEW",
            );
          }
          if (operation.kind === "add") {
            lines[dimension].push(operation.desiredLine);
            counts[dimension].added += 1;
          } else if (operation.kind === "update") {
            lines[dimension][operation.index] =
              operation.desiredLine;
            counts[dimension].updated += 1;
          } else {
            counts[dimension].unchanged += 1;
          }
          nextTargets[dimension] = {
            line: operation.desiredLine,
            lineHash: sha256(operation.desiredLine),
          };
        }
        manifestEntries.set(item.highlight.id, {
          highlightId: item.highlight.id,
          overworld: nextTargets.overworld,
          nether: nextTargets.nether,
        });
      }
    } else {
      const scopedEntries = [...manifestEntries.values()].filter(
        (entry) => {
          if (selection.bounds === null) return true;
          const point = manifestOverworldPoint(entry);
          return (
            point !== null &&
            pointIsInsideSelection(point.x, point.z, selection)
          );
        },
      );
      managedHighlights = scopedEntries.length;
      for (const entry of scopedEntries) {
        const matchingIndices = (
          dimension: XaeroDimension,
        ): readonly number[] => {
          const target = entry[dimension];
          return target
            ? lines[dimension]
                .map((line, index) =>
                  line === target.line ? index : -1,
                )
                .filter((index) => index >= 0)
            : [];
        };
        const matches: Readonly<
          Record<XaeroDimension, readonly number[]>
        > = {
          overworld: matchingIndices("overworld"),
          nether: matchingIndices("nether"),
        };
        const entryHasConflict = DIMENSIONS.some(
          (dimension) => matches[dimension].length > 1,
        );
        if (entryHasConflict) {
          conflicts += 1;
          for (const dimension of DIMENSIONS) {
            const target = entry[dimension];
            if (!target || matches[dimension].length === 0) {
              counts[dimension].alreadyAbsent += 1;
            } else if (matches[dimension].length > 1) {
              counts[dimension].conflicts += 1;
            } else {
              counts[dimension].unchanged += 1;
            }
          }
          continue;
        }
        let entryHasRemovableRow = false;
        for (const dimension of DIMENSIONS) {
          const target = entry[dimension];
          if (!target) {
            counts[dimension].alreadyAbsent += 1;
            continue;
          }
          if (matches[dimension].length === 0) {
            counts[dimension].alreadyAbsent += 1;
            continue;
          }
          entryHasRemovableRow = true;
          lines[dimension].splice(matches[dimension][0], 1);
          counts[dimension].removed += 1;
        }
        if (entryHasRemovableRow) removableHighlights += 1;
        manifestEntries.delete(entry.highlightId);
      }
    }

    const candidateManifest: XaeroManifest = {
      schemaVersion: XAERO_EXPORT_SCHEMA_VERSION,
      server: XAERO_SERVER_DIRECTORY,
      updatedAt: workspace.updatedAt ?? new Date(0).toISOString(),
      entries: [...manifestEntries.values()],
      lastExport: manifestSnapshot.manifest.lastExport,
    };
    const entriesChanged =
      JSON.stringify(
        [...candidateManifest.entries].sort((left, right) =>
          left.highlightId.localeCompare(right.highlightId),
        ),
      ) !==
      JSON.stringify(
        [...manifestSnapshot.manifest.entries].sort((left, right) =>
          left.highlightId.localeCompare(right.highlightId),
        ),
      );
    const manifest =
      !entriesChanged && manifestSnapshot.bytes
        ? manifestSnapshot.manifest
        : candidateManifest;
    const manifestBytes =
      !entriesChanged && manifestSnapshot.bytes
        ? manifestSnapshot.bytes
        : serializeManifest(manifest);
    const manifestHash = sha256(manifestBytes);
    const dimensions = Object.fromEntries(
      DIMENSIONS.map((dimension) => {
        const snapshot = snapshots[dimension];
        const document = { ...snapshot.document, lines: lines[dimension] };
        const text = renderTextDocument(document);
        const summary: XaeroDimensionSummary = {
          existing: snapshot.waypointCount,
          ...counts[dimension],
          final: validateWaypointDocument(document),
        };
        return [
          dimension,
          { text, hash: sha256(Buffer.from(text, "utf8")), summary },
        ];
      }),
    ) as unknown as Readonly<Record<XaeroDimension, DimensionPlan>>;
    const hasChanges =
      DIMENSIONS.some(
        (dimension) =>
          dimensions[dimension].summary.added > 0 ||
          dimensions[dimension].summary.updated > 0 ||
          dimensions[dimension].summary.removed > 0,
      ) || entriesChanged;
    const normalizedNames = selectedPins.flatMap((highlight) => {
      try {
        return [normalizeWaypointTitle(highlight.title)];
      } catch (error) {
        if (error instanceof TypeError) return [];
        throw error;
      }
    });
    const duplicateNames =
      normalizedNames.length - new Set(normalizedNames).size;
    const previewSeed = JSON.stringify({
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.revision,
      overworldBefore: overworld.hash,
      netherBefore: nether.hash,
      manifestBefore: manifestSnapshot.hash,
      overworldAfter: dimensions.overworld.hash,
      netherAfter: dimensions.nether.hash,
      manifestAfter: manifestHash,
      operation: selection.operation,
      scope: selection.scope,
      explorationId: selection.explorationId,
    });
    const preview: XaeroExportPreview = {
      version: XAERO_EXPORT_SCHEMA_VERSION,
      previewId: sha256(previewSeed),
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.revision,
      operation: selection.operation,
      scope: selection.scope,
      explorationId: selection.explorationId,
      regionName: selection.regionName,
      minecraftOpen,
      canExport: !minecraftOpen && hasChanges,
      hasChanges,
      sourceHighlights: workspace.highlights.length,
      selectedHighlights: selectedHighlights.length,
      managedHighlights,
      removableHighlights,
      exportableHighlights:
        selection.operation === "export"
          ? selectedPins.length - conflicts
          : removableHighlights,
      skippedAreas: selectedAreas.length,
      notesNotExported: selectedPins.filter(
        (highlight) => highlight.note.trim().length > 0,
      ).length,
      duplicateNames,
      conflicts,
      overworld: dimensions.overworld.summary,
      nether: dimensions.nether.summary,
    };
    return {
      preview,
      snapshots,
      manifestSnapshot,
      manifest,
      manifestBytes,
      manifestHash,
      dimensions,
    };
  }

  private async createBackup(
    backupDirectory: string,
    workspace: AtlasWorkspaceDocument,
    plan: XaeroExportPlan,
  ): Promise<void> {
    if (!pathIsInside(this.backupRoot, backupDirectory)) {
      throw new XaeroExportError(
        "La ruta de respaldo Xaero no es segura",
        "XAERO_UNSAFE_PATH",
      );
    }
    await mkdir(backupDirectory, { mode: 0o700 });
    await Promise.all([
      writeDurableExclusive(
        resolve(backupDirectory, "overworld.before.txt"),
        plan.snapshots.overworld.bytes,
      ),
      writeDurableExclusive(
        resolve(backupDirectory, "nether.before.txt"),
        plan.snapshots.nether.bytes,
      ),
      plan.manifestSnapshot.bytes
        ? writeDurableExclusive(
            resolve(backupDirectory, "manifest.before.json"),
            plan.manifestSnapshot.bytes,
          )
        : Promise.resolve(),
      writeDurableExclusive(
        resolve(backupDirectory, "metadata.json"),
        `${JSON.stringify(
          {
            schemaVersion: XAERO_EXPORT_SCHEMA_VERSION,
            workspaceId: workspace.workspaceId,
            workspaceRevision: workspace.revision,
            operation: plan.preview.operation,
            scope: plan.preview.scope,
            explorationId: plan.preview.explorationId,
            createdAt: this.now().toISOString(),
            before: {
              overworld: plan.snapshots.overworld.hash,
              nether: plan.snapshots.nether.hash,
              manifest: plan.manifestSnapshot.hash,
            },
            after: {
              overworld: plan.dimensions.overworld.hash,
              nether: plan.dimensions.nether.hash,
              manifest: plan.manifestHash,
            },
          },
          null,
          2,
        )}\n`,
      ),
    ]);
    await fsyncDirectory(backupDirectory);
    await fsyncDirectory(this.backupRoot);
  }

  private async createJournal(
    journal: XaeroTransactionJournal,
  ): Promise<void> {
    try {
      const handle = await open(this.journalPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(this.stateDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new XaeroExportError(
          "Otra exportación Xaero está en curso",
          "XAERO_LOCKED",
        );
      }
      throw error;
    }
  }

  private async readJournal(): Promise<XaeroTransactionJournal | null> {
    let bytes: Buffer;
    try {
      const metadata = await lstat(this.journalPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size <= 0 ||
        metadata.size > 64 * 1024
      ) {
        throw new XaeroExportError(
          "La transacción Xaero pendiente no es segura",
          "XAERO_RECOVERY_CONFLICT",
        );
      }
      bytes = await readFile(this.journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new XaeroExportError(
        "La transacción Xaero pendiente está dañada",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    if (
      !isRecord(value) ||
      value.schemaVersion !== XAERO_EXPORT_SCHEMA_VERSION ||
      typeof value.transactionId !== "string" ||
      !UUID_PATTERN.test(value.transactionId) ||
      typeof value.backupId !== "string" ||
      !value.backupId.endsWith(value.transactionId) ||
      !isRecord(value.before) ||
      !isRecord(value.after)
    ) {
      throw new XaeroExportError(
        "La transacción Xaero pendiente no es válida",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    const beforeManifest = value.before.manifest;
    if (
      !HASH_PATTERN.test(String(value.before.overworld)) ||
      !HASH_PATTERN.test(String(value.before.nether)) ||
      !(
        beforeManifest === null ||
        (typeof beforeManifest === "string" &&
          HASH_PATTERN.test(beforeManifest))
      ) ||
      !HASH_PATTERN.test(String(value.after.overworld)) ||
      !HASH_PATTERN.test(String(value.after.nether)) ||
      !HASH_PATTERN.test(String(value.after.manifest))
    ) {
      throw new XaeroExportError(
        "La transacción Xaero pendiente contiene hashes inválidos",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    return value as unknown as XaeroTransactionJournal;
  }

  private async recoverPendingTransaction(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal) return;
    const current = {
      overworld: await fileHash(this.overworldPath),
      nether: await fileHash(this.netherPath),
      manifest: await fileHash(this.manifestPath),
    };
    const beforeMatches =
      current.overworld === journal.before.overworld &&
      current.nether === journal.before.nether &&
      current.manifest === journal.before.manifest;
    const afterMatches =
      current.overworld === journal.after.overworld &&
      current.nether === journal.after.nether &&
      current.manifest === journal.after.manifest;
    if (beforeMatches || afterMatches) {
      await unlink(this.journalPath);
      await fsyncDirectory(this.stateDirectory);
      return;
    }
    const known =
      [journal.before.overworld, journal.after.overworld].includes(
        current.overworld ?? "",
      ) &&
      [journal.before.nether, journal.after.nether].includes(
        current.nether ?? "",
      ) &&
      [journal.before.manifest, journal.after.manifest].includes(
        current.manifest,
      );
    if (!known) {
      throw new XaeroExportError(
        "Xaero cambió durante una recuperación pendiente; no se tocó ningún archivo",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    const backupDirectory = resolve(this.backupRoot, journal.backupId);
    await this.rollbackKnownTransaction(journal, backupDirectory);
  }

  private async rollbackKnownTransaction(
    journal: XaeroTransactionJournal,
    backupDirectory: string,
  ): Promise<void> {
    if (!pathIsInside(this.backupRoot, backupDirectory)) {
      throw new XaeroExportError(
        "El respaldo pendiente sale de LuisA",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    const current = {
      overworld: await fileHash(this.overworldPath),
      nether: await fileHash(this.netherPath),
      manifest: await fileHash(this.manifestPath),
    };
    const known =
      [journal.before.overworld, journal.after.overworld].includes(
        current.overworld ?? "",
      ) &&
      [journal.before.nether, journal.after.nether].includes(
        current.nether ?? "",
      ) &&
      [journal.before.manifest, journal.after.manifest].includes(
        current.manifest,
      );
    if (!known) {
      throw new XaeroExportError(
        "Xaero cambió fuera de Atlas; el respaldo queda disponible para revisión",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    const [overworldBytes, netherBytes] = await Promise.all([
      readFile(resolve(backupDirectory, "overworld.before.txt")),
      readFile(resolve(backupDirectory, "nether.before.txt")),
    ]);
    if (
      sha256(overworldBytes) !== journal.before.overworld ||
      sha256(netherBytes) !== journal.before.nether
    ) {
      throw new XaeroExportError(
        "El respaldo pendiente no coincide con sus hashes",
        "XAERO_RECOVERY_CONFLICT",
      );
    }
    const currentOverworld = await stat(this.overworldPath);
    const currentNether = await stat(this.netherPath);
    await atomicReplace(
      this.overworldPath,
      overworldBytes,
      currentOverworld.mode & 0o777,
    );
    await atomicReplace(
      this.netherPath,
      netherBytes,
      currentNether.mode & 0o777,
    );
    if (journal.before.manifest === null) {
      await rm(this.manifestPath, { force: true });
    } else {
      const manifestBytes = await readFile(
        resolve(backupDirectory, "manifest.before.json"),
      );
      if (sha256(manifestBytes) !== journal.before.manifest) {
        throw new XaeroExportError(
          "El manifiesto de respaldo no coincide con su hash",
          "XAERO_RECOVERY_CONFLICT",
        );
      }
      await atomicReplace(this.manifestPath, manifestBytes, 0o600);
    }
    await rm(this.journalPath, { force: true });
    await fsyncDirectory(this.stateDirectory);
  }

  private async verifyCommitted(plan: XaeroExportPlan): Promise<void> {
    const [overworld, nether, manifest] = await Promise.all([
      this.readXaeroFile("overworld", this.overworldPath),
      this.readXaeroFile("nether", this.netherPath),
      this.readManifest(),
    ]);
    if (
      overworld.hash !== plan.dimensions.overworld.hash ||
      nether.hash !== plan.dimensions.nether.hash ||
      manifest.hash !== plan.manifestHash
    ) {
      throw new XaeroExportError(
        "La validación posterior de Xaero no coincidió",
        "XAERO_INVALID_FILE",
      );
    }
  }
}
