import { randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  deserializeExplorationState,
  serializeExplorationState,
  type WorldBounds,
} from "../app/lib/exploration-grid.ts";
import {
  parseCoverageSelection,
  type OverworldCoverageSelection,
} from "../app/lib/overworld-coverage.ts";
import { isHighlightRegionKey } from "../app/lib/highlights.ts";
import { consolidateSingleWorkspaceContent } from "../app/lib/single-workspace-session.ts";

export const ATLAS_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const MAX_ATLAS_WORKSPACE_BYTES = 16 * 1024 * 1024;
/** Legacy v1 readers remain permissive so existing multi-session data migrates. */
export const MAX_WORKSPACE_EXPLORATIONS = 128;
export const MAX_CANONICAL_WORKSPACE_EXPLORATIONS = 1;
export const MAX_WORKSPACE_HIGHLIGHTS = 10_000;
export const ATLAS_WORKSPACE_RELATIVE_DIRECTORY = [
  "ObsidianAtlas",
  "state",
] as const;
export const ATLAS_WORKSPACE_BACKUP_RELATIVE_DIRECTORY = [
  "ObsidianAtlas",
  "backups",
] as const;
export const ATLAS_WORKSPACE_FILENAME = "atlas-workspace.v1.json";

const MAX_HIGHLIGHT_ID_LENGTH = 100;
const MAX_HIGHLIGHT_TITLE_LENGTH = 200;
const MAX_HIGHLIGHT_NOTE_LENGTH = 20_000;
const MAX_TIMESTAMP_LENGTH = 40;
const WORLD_BORDER_BLOCKS = 30_000_000;
const LOCK_STALE_AFTER_MS = 60_000;
const LOCK_REAPER_STALE_AFTER_MS = 5_000;
const LOCK_RETRY_COUNT = 80;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RELEASE_RETRY_COUNT = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_TRANSIENT_PATTERN =
  /^(?:\.atlas-workspace\.v1\.json\.\d+\.[0-9a-f-]{36}\.tmp|\.atlas-workspace\.lock(?:-reaper)?\.stale\.\d+\.[0-9a-f-]{36})$/i;
const abandonedLockNonces = new Map<string, Set<string>>();

export interface SerializedExplorationWorkspaceState {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly region: {
    readonly id: string;
    readonly name: string;
    readonly bounds: WorldBounds;
    readonly lod: number;
    readonly scale: number;
  };
  readonly currentIndex: number;
  readonly currentCellPreviouslyReviewed: boolean;
  readonly reviewedCount: number;
  readonly reviewedBits: string;
  readonly skippedCount: number;
  readonly skippedBits: string;
}

export interface AtlasWorkspaceExploration {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: SerializedExplorationWorkspaceState;
}

export interface AtlasWorkspaceHighlight {
  readonly id: string;
  readonly type: "pin" | "area";
  readonly title: string;
  readonly note: string;
  readonly color: string;
  readonly regionKey?: string | null;
  readonly x: number;
  readonly z: number;
  readonly bounds?: {
    readonly x1: number;
    readonly z1: number;
    readonly x2: number;
    readonly z2: number;
  };
  readonly visible: boolean;
  readonly createdAt: string;
}

export interface AtlasWorkspaceContent {
  readonly schemaVersion: typeof ATLAS_WORKSPACE_SCHEMA_VERSION;
  readonly activeExplorationId: string | null;
  readonly explorations: readonly AtlasWorkspaceExploration[];
  readonly highlights: readonly AtlasWorkspaceHighlight[];
  readonly coverageSelection: OverworldCoverageSelection | null;
}

export interface AtlasWorkspaceDocument extends AtlasWorkspaceContent {
  readonly workspaceId: string;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly lastWriteId: string | null;
}

export interface AtlasWorkspaceReadResult {
  readonly workspace: AtlasWorkspaceDocument;
  readonly recoveredFromBackup: boolean;
}

export interface AtlasWorkspaceAvailability {
  readonly configured: true;
  readonly writable: boolean;
  readonly volume: "LuisA";
  readonly revision: number | null;
  readonly updatedAt: string | null;
}

export type AtlasWorkspaceErrorCode =
  | "INVALID_WORKSPACE"
  | "WORKSPACE_TOO_LARGE"
  | "WORKSPACE_CONFLICT"
  | "WORKSPACE_CORRUPT"
  | "WORKSPACE_LOCKED"
  | "WORKSPACE_UNAVAILABLE"
  | "UNSAFE_WORKSPACE_PATH";

export class AtlasWorkspaceError extends Error {
  readonly code: AtlasWorkspaceErrorCode;
  readonly current?: AtlasWorkspaceDocument;

  constructor(
    message: string,
    code: AtlasWorkspaceErrorCode,
    options: { cause?: unknown; current?: AtlasWorkspaceDocument } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AtlasWorkspaceError";
    this.code = code;
    this.current = options.current;
  }
}

interface FileReadResult {
  readonly kind: "missing" | "valid" | "invalid";
  readonly workspace?: AtlasWorkspaceDocument;
  readonly error?: unknown;
}

interface LockMetadata {
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface HeldFileLock {
  readonly nonce: string;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH
  ) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeMapCoordinate(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > WORLD_BORDER_BLOCKS
  ) {
    throw new AtlasWorkspaceError(
      `${label} no es una coordenada válida del Overworld`,
      "INVALID_WORKSPACE",
    );
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  maximumLength: number,
  options: { allowNewlines?: boolean } = {},
): string {
  const forbidden = options.allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    forbidden.test(value)
  ) {
    throw new AtlasWorkspaceError(
      `${label} no es válido`,
      "INVALID_WORKSPACE",
    );
  }
  return value;
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new TypeError("El workspace no se puede serializar");
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    throw new AtlasWorkspaceError(
      "El workspace no contiene JSON serializable",
      "INVALID_WORKSPACE",
      { cause: error },
    );
  }
}

function canonicalExplorationState(
  value: unknown,
): SerializedExplorationWorkspaceState {
  try {
    const state = deserializeExplorationState(JSON.stringify(value));
    return JSON.parse(
      serializeExplorationState(state),
    ) as SerializedExplorationWorkspaceState;
  } catch (error) {
    throw new AtlasWorkspaceError(
      "Una sesión de exploración no es válida",
      "INVALID_WORKSPACE",
      { cause: error },
    );
  }
}

function canonicalExploration(value: unknown): AtlasWorkspaceExploration {
  if (!isRecord(value)) {
    throw new AtlasWorkspaceError(
      "Cada exploración debe ser un objeto",
      "INVALID_WORKSPACE",
    );
  }
  const state = canonicalExplorationState(value.state);
  if (value.id !== state.region.id) {
    throw new AtlasWorkspaceError(
      "El id de exploración no coincide con su región",
      "INVALID_WORKSPACE",
    );
  }
  if (
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new AtlasWorkspaceError(
      "Las fechas de exploración no son válidas",
      "INVALID_WORKSPACE",
    );
  }
  return {
    id: state.region.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    state,
  };
}

function canonicalHighlightBounds(
  value: unknown,
): NonNullable<AtlasWorkspaceHighlight["bounds"]> {
  if (!isRecord(value)) {
    throw new AtlasWorkspaceError(
      "Un highlight de área necesita límites",
      "INVALID_WORKSPACE",
    );
  }
  const bounds = {
    x1: safeMapCoordinate(value.x1, "bounds.x1"),
    z1: safeMapCoordinate(value.z1, "bounds.z1"),
    x2: safeMapCoordinate(value.x2, "bounds.x2"),
    z2: safeMapCoordinate(value.z2, "bounds.z2"),
  };
  if (
    Math.abs(bounds.x2 - bounds.x1) < 2 ||
    Math.abs(bounds.z2 - bounds.z1) < 2
  ) {
    throw new AtlasWorkspaceError(
      "El área de un highlight es demasiado pequeña",
      "INVALID_WORKSPACE",
    );
  }
  return bounds;
}

function canonicalHighlight(value: unknown): AtlasWorkspaceHighlight {
  if (!isRecord(value)) {
    throw new AtlasWorkspaceError(
      "Cada highlight debe ser un objeto",
      "INVALID_WORKSPACE",
    );
  }
  const id = boundedText(
    value.id,
    "El id de highlight",
    MAX_HIGHLIGHT_ID_LENGTH,
  );
  if (id.length === 0) {
    throw new AtlasWorkspaceError(
      "El id de highlight no puede estar vacío",
      "INVALID_WORKSPACE",
    );
  }
  if (value.type !== "pin" && value.type !== "area") {
    throw new AtlasWorkspaceError(
      "El tipo de highlight no es válido",
      "INVALID_WORKSPACE",
    );
  }
  if (
    typeof value.color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(value.color)
  ) {
    throw new AtlasWorkspaceError(
      "El color de highlight no es válido",
      "INVALID_WORKSPACE",
    );
  }
  if (
    !(
      value.regionKey === undefined ||
      value.regionKey === null ||
      isHighlightRegionKey(value.regionKey)
    )
  ) {
    throw new AtlasWorkspaceError(
      "La región del highlight no es válida",
      "INVALID_WORKSPACE",
    );
  }
  if (typeof value.visible !== "boolean") {
    throw new AtlasWorkspaceError(
      "La visibilidad de highlight no es válida",
      "INVALID_WORKSPACE",
    );
  }
  if (!isCanonicalTimestamp(value.createdAt)) {
    throw new AtlasWorkspaceError(
      "La fecha del highlight no es válida",
      "INVALID_WORKSPACE",
    );
  }
  const common = {
    id,
    type: value.type,
    title: boundedText(
      value.title,
      "El título de highlight",
      MAX_HIGHLIGHT_TITLE_LENGTH,
    ),
    note: boundedText(
      value.note,
      "La nota de highlight",
      MAX_HIGHLIGHT_NOTE_LENGTH,
      { allowNewlines: true },
    ),
    color: value.color.toLowerCase(),
    ...(value.regionKey !== undefined
      ? { regionKey: value.regionKey as string | null }
      : {}),
    x: safeMapCoordinate(value.x, "highlight.x"),
    z: safeMapCoordinate(value.z, "highlight.z"),
    visible: value.visible,
    createdAt: value.createdAt,
  } as const;
  return value.type === "area"
    ? { ...common, bounds: canonicalHighlightBounds(value.bounds) }
    : common;
}

export function parseAtlasWorkspaceContent(
  value: unknown,
): AtlasWorkspaceContent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== ATLAS_WORKSPACE_SCHEMA_VERSION ||
    !Array.isArray(value.explorations) ||
    !Array.isArray(value.highlights)
  ) {
    throw new AtlasWorkspaceError(
      "El workspace no usa el esquema esperado",
      "INVALID_WORKSPACE",
    );
  }
  if (serializedBytes(value) > MAX_ATLAS_WORKSPACE_BYTES) {
    throw new AtlasWorkspaceError(
      "El workspace supera 16 MiB",
      "WORKSPACE_TOO_LARGE",
    );
  }
  if (value.explorations.length > MAX_WORKSPACE_EXPLORATIONS) {
    throw new AtlasWorkspaceError(
      `El workspace admite como máximo ${MAX_WORKSPACE_EXPLORATIONS} exploraciones`,
      "INVALID_WORKSPACE",
    );
  }
  if (value.highlights.length > MAX_WORKSPACE_HIGHLIGHTS) {
    throw new AtlasWorkspaceError(
      `El workspace admite como máximo ${MAX_WORKSPACE_HIGHLIGHTS} highlights`,
      "INVALID_WORKSPACE",
    );
  }

  const explorationIds = new Set<string>();
  const explorations = value.explorations.map((item) => {
    const exploration = canonicalExploration(item);
    if (explorationIds.has(exploration.id)) {
      throw new AtlasWorkspaceError(
        "El workspace contiene ids de exploración duplicados",
        "INVALID_WORKSPACE",
      );
    }
    explorationIds.add(exploration.id);
    return exploration;
  });
  const highlightIds = new Set<string>();
  const highlights = value.highlights.map((item) => {
    const highlight = canonicalHighlight(item);
    if (highlightIds.has(highlight.id)) {
      throw new AtlasWorkspaceError(
        "El workspace contiene ids de highlight duplicados",
        "INVALID_WORKSPACE",
      );
    }
    highlightIds.add(highlight.id);
    return highlight;
  });

  const activeExplorationId = value.activeExplorationId;
  if (
    activeExplorationId !== null &&
    (typeof activeExplorationId !== "string" ||
      !explorationIds.has(activeExplorationId))
  ) {
    throw new AtlasWorkspaceError(
      "La exploración activa no existe",
      "INVALID_WORKSPACE",
    );
  }
  const coverageSelection =
    value.coverageSelection === null
      ? null
      : parseCoverageSelection(value.coverageSelection);
  if (value.coverageSelection !== null && coverageSelection === null) {
    throw new AtlasWorkspaceError(
      "La selección de cobertura no es válida",
      "INVALID_WORKSPACE",
    );
  }

  const content: AtlasWorkspaceContent = {
    schemaVersion: ATLAS_WORKSPACE_SCHEMA_VERSION,
    activeExplorationId,
    explorations,
    highlights,
    coverageSelection,
  };
  if (serializedBytes(content) > MAX_ATLAS_WORKSPACE_BYTES) {
    throw new AtlasWorkspaceError(
      "El workspace canónico supera 16 MiB",
      "WORKSPACE_TOO_LARGE",
    );
  }
  return content;
}

export function parseAtlasWorkspaceDocument(
  value: unknown,
): AtlasWorkspaceDocument {
  if (
    !isRecord(value) ||
    !isValidUuid(value.workspaceId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !isValidUuid(value.lastWriteId)
  ) {
    throw new AtlasWorkspaceError(
      "Los metadatos del workspace no son válidos",
      "INVALID_WORKSPACE",
    );
  }
  return {
    ...parseAtlasWorkspaceContent(value),
    workspaceId: value.workspaceId,
    revision: value.revision,
    updatedAt: value.updatedAt,
    lastWriteId: value.lastWriteId,
  };
}

export interface AtlasWorkspacePrecondition {
  readonly workspaceId: string;
  readonly revision: number;
}

export function atlasWorkspaceEtag(
  workspaceId: string,
  revision: number,
): string {
  if (
    !isValidUuid(workspaceId) ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new TypeError("La identidad o revisión no es válida");
  }
  return `"atlas-${workspaceId}-${revision}"`;
}

export function parseAtlasWorkspaceEtag(
  value: unknown,
): AtlasWorkspacePrecondition | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^"atlas-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(0|[1-9]\d*)"$/i,
  );
  if (!match) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision)
    ? { workspaceId: match[1], revision }
    : null;
}

function emptyWorkspace(workspaceId: string): AtlasWorkspaceDocument {
  return {
    schemaVersion: ATLAS_WORKSPACE_SCHEMA_VERSION,
    workspaceId,
    revision: 0,
    updatedAt: null,
    lastWriteId: null,
    activeExplorationId: null,
    explorations: [],
    highlights: [],
    coverageSelection: null,
  };
}

function serializeDocument(workspace: AtlasWorkspaceDocument): string {
  const serialized = `${JSON.stringify(workspace)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ATLAS_WORKSPACE_BYTES) {
    throw new AtlasWorkspaceError(
      "El workspace supera 16 MiB",
      "WORKSPACE_TOO_LARGE",
    );
  }
  return serialized;
}

function documentContent(
  workspace: AtlasWorkspaceDocument,
): AtlasWorkspaceContent {
  return {
    schemaVersion: ATLAS_WORKSPACE_SCHEMA_VERSION,
    activeExplorationId: workspace.activeExplorationId,
    explorations: workspace.explorations,
    highlights: workspace.highlights,
    coverageSelection: workspace.coverageSelection,
  };
}

function sameExplorationRegion(
  left: AtlasWorkspaceExploration,
  right: AtlasWorkspaceExploration,
): boolean {
  const leftBounds = left.state.region.bounds;
  const rightBounds = right.state.region.bounds;
  return (
    left.state.dimension === right.state.dimension &&
    left.state.region.lod === right.state.region.lod &&
    leftBounds.minX === rightBounds.minX &&
    leftBounds.minZ === rightBounds.minZ &&
    leftBounds.maxXExclusive === rightBounds.maxXExclusive &&
    leftBounds.maxZExclusive === rightBounds.maxZExclusive
  );
}

function reviewProgressWouldRegress(
  current: AtlasWorkspaceDocument,
  candidate: AtlasWorkspaceContent,
): boolean {
  const currentExploration = current.explorations[0];
  const candidateExploration = candidate.explorations[0];
  if (
    !currentExploration ||
    !candidateExploration ||
    !sameExplorationRegion(currentExploration, candidateExploration)
  ) {
    return false;
  }
  const currentState = deserializeExplorationState(
    JSON.stringify(currentExploration.state),
  );
  const candidateState = deserializeExplorationState(
    JSON.stringify(candidateExploration.state),
  );
  return currentState.reviewed.some(
    (byte, index) => (byte & ~candidateState.reviewed[index]) !== 0,
  );
}

function pathIsInside(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) &&
      childRelative !== ".." &&
      !isAbsolute(childRelative))
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class LocalAtlasWorkspaceStore {
  readonly backingRoot: string;
  readonly stateDirectory: string;
  readonly migrationBackupDirectory: string;
  readonly replacementBackupDirectory: string;
  readonly workspacePath: string;
  readonly backupPath: string;
  readonly lockPath: string;
  readonly lockReaperPath: string;

  private readonly emptyWorkspaceId = randomUUID();
  private operationTail: Promise<void> = Promise.resolve();
  private lastKnownRevision: number | null = null;
  private lastKnownUpdatedAt: string | null = null;

  constructor(backingRoot: string) {
    if (typeof backingRoot !== "string" || backingRoot.trim().length === 0) {
      throw new AtlasWorkspaceError(
        "LuisA no está configurada",
        "WORKSPACE_UNAVAILABLE",
      );
    }
    this.backingRoot = resolve(backingRoot);
    this.stateDirectory = resolve(
      this.backingRoot,
      ...ATLAS_WORKSPACE_RELATIVE_DIRECTORY,
    );
    this.migrationBackupDirectory = resolve(
      this.backingRoot,
      ...ATLAS_WORKSPACE_BACKUP_RELATIVE_DIRECTORY,
    );
    this.replacementBackupDirectory = resolve(
      this.migrationBackupDirectory,
      "workspace-replacements",
    );
    if (!pathIsInside(this.backingRoot, this.stateDirectory)) {
      throw new AtlasWorkspaceError(
        "La ruta de estado sale de LuisA",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    if (!pathIsInside(this.backingRoot, this.migrationBackupDirectory)) {
      throw new AtlasWorkspaceError(
        "La ruta de respaldos sale de LuisA",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    if (
      !pathIsInside(
        this.migrationBackupDirectory,
        this.replacementBackupDirectory,
      )
    ) {
      throw new AtlasWorkspaceError(
        "La ruta de reemplazos sale de los respaldos",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    this.workspacePath = resolve(
      this.stateDirectory,
      ATLAS_WORKSPACE_FILENAME,
    );
    this.backupPath = `${this.workspacePath}.bak`;
    this.lockPath = resolve(this.stateDirectory, ".atlas-workspace.lock");
    this.lockReaperPath = resolve(
      this.stateDirectory,
      ".atlas-workspace.lock-reaper",
    );
  }

  async read(): Promise<AtlasWorkspaceReadResult> {
    const result = await this.enqueue(() =>
      this.withFileLock(() => this.readUnderLock()),
    );
    this.remember(result.workspace);
    return result;
  }

  async availability(): Promise<AtlasWorkspaceAvailability> {
    try {
      await this.ensureStateDirectory();
      await access(
        this.stateDirectory,
        fileSystemConstants.R_OK | fileSystemConstants.W_OK,
      );
      return {
        configured: true,
        writable: true,
        volume: "LuisA",
        revision: this.lastKnownRevision,
        updatedAt: this.lastKnownUpdatedAt,
      };
    } catch {
      return {
        configured: true,
        writable: false,
        volume: "LuisA",
        revision: this.lastKnownRevision,
        updatedAt: this.lastKnownUpdatedAt,
      };
    }
  }

  async write(
    content: unknown,
    expected: AtlasWorkspacePrecondition,
    writeId: string,
  ): Promise<AtlasWorkspaceReadResult> {
    if (
      !isRecord(expected) ||
      !isValidUuid(expected.workspaceId) ||
      !Number.isSafeInteger(expected.revision) ||
      expected.revision < 0
    ) {
      throw new AtlasWorkspaceError(
        "La identidad o revisión esperada no es válida",
        "INVALID_WORKSPACE",
      );
    }
    if (!isValidUuid(writeId)) {
      throw new AtlasWorkspaceError(
        "X-Atlas-Write-Id no es un UUID válido",
        "INVALID_WORKSPACE",
      );
    }
    const legacyContent = parseAtlasWorkspaceContent(content);
    const canonicalContent = consolidateSingleWorkspaceContent(
      legacyContent,
    ) as AtlasWorkspaceContent;
    if (
      canonicalContent.explorations.length >
      MAX_CANONICAL_WORKSPACE_EXPLORATIONS
    ) {
      throw new AtlasWorkspaceError(
        "El workspace canónico admite una sola sesión",
        "INVALID_WORKSPACE",
      );
    }
    const result = await this.enqueue(() =>
      this.withFileLock(async () => {
        const currentResult = await this.readUnderLock();
        const current = currentResult.workspace;
        this.remember(current);
        if (current.lastWriteId === writeId) {
          if (
            JSON.stringify(documentContent(current)) ===
            JSON.stringify(canonicalContent)
          ) {
            return currentResult;
          }
          throw new AtlasWorkspaceError(
            "X-Atlas-Write-Id ya se usó con otro contenido",
            "WORKSPACE_CONFLICT",
            { current },
          );
        }
        if (
          current.workspaceId !== expected.workspaceId ||
          current.revision !== expected.revision
        ) {
          throw new AtlasWorkspaceError(
            "El workspace cambió en otra pestaña",
            "WORKSPACE_CONFLICT",
            { current },
          );
        }
        if (current.revision === Number.MAX_SAFE_INTEGER) {
          throw new AtlasWorkspaceError(
            "El workspace agotó el rango seguro de revisiones",
            "WORKSPACE_UNAVAILABLE",
            { current },
          );
        }
        if (reviewProgressWouldRegress(current, canonicalContent)) {
          throw new AtlasWorkspaceError(
            "La escritura intentó reducir el avance de la misma región; reanuda la sesión guardada",
            "WORKSPACE_CONFLICT",
            { current },
          );
        }

        if (
          current.explorations.length >
            MAX_CANONICAL_WORKSPACE_EXPLORATIONS ||
          legacyContent.explorations.length >
            MAX_CANONICAL_WORKSPACE_EXPLORATIONS
        ) {
          await this.archiveMultiSessionMigration(
            current,
            legacyContent,
            canonicalContent,
          );
        }
        const currentSessionId =
          current.explorations.length === 1
            ? current.explorations[0].id
            : null;
        const candidateSessionId =
          canonicalContent.explorations.length === 1
            ? canonicalContent.explorations[0].id
            : null;
        if (
          currentSessionId !== null &&
          candidateSessionId !== null &&
          currentSessionId !== candidateSessionId
        ) {
          await this.archiveWorkspaceReplacement(
            current,
            legacyContent,
            currentSessionId,
            candidateSessionId,
            writeId,
          );
        }

        const next: AtlasWorkspaceDocument = {
          ...canonicalContent,
          workspaceId: current.workspaceId,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          lastWriteId: writeId,
        };
        const nextSerialized = serializeDocument(next);
        // On the first write, seed the backup with the same durable document.
        // If the following primary rename fails, the next read can still
        // recover the idempotent write by its lastWriteId.
        await this.atomicWrite(
          this.backupPath,
          current.revision > 0
            ? serializeDocument(current)
            : nextSerialized,
        );
        await this.atomicWrite(this.workspacePath, nextSerialized);
        return { workspace: next, recoveredFromBackup: false };
      }),
    );
    this.remember(result.workspace);
    return result;
  }

  private remember(workspace: AtlasWorkspaceDocument): void {
    this.lastKnownRevision = workspace.revision;
    this.lastKnownUpdatedAt = workspace.updatedAt;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureStateDirectory(): Promise<void> {
    let backingRealPath: string;
    try {
      backingRealPath = await realpath(this.backingRoot);
    } catch (error) {
      throw new AtlasWorkspaceError(
        "La unidad LuisA no está disponible",
        "WORKSPACE_UNAVAILABLE",
        { cause: error },
      );
    }
    let current = this.backingRoot;
    for (const component of ATLAS_WORKSPACE_RELATIVE_DIRECTORY) {
      current = resolve(current, component);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new AtlasWorkspaceError(
            "La ruta de estado contiene un enlace o archivo inseguro",
            "UNSAFE_WORKSPACE_PATH",
          );
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirError;
          }
        }
      }
    }
    const stateRealPath = await realpath(this.stateDirectory);
    if (!pathIsInside(backingRealPath, stateRealPath)) {
      throw new AtlasWorkspaceError(
        "La ruta de estado no pertenece a LuisA",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
  }

  private async ensureMigrationBackupDirectory(): Promise<void> {
    await this.ensureStateDirectory();
    const atlasDirectory = resolve(this.backingRoot, "ObsidianAtlas");
    for (const directory of [
      atlasDirectory,
      this.migrationBackupDirectory,
    ]) {
      try {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new AtlasWorkspaceError(
            "La ruta de respaldos contiene un enlace o archivo inseguro",
            "UNSAFE_WORKSPACE_PATH",
          );
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirError;
          }
        }
      }
    }
    const backingRealPath = await realpath(this.backingRoot);
    const backupRealPath = await realpath(this.migrationBackupDirectory);
    if (!pathIsInside(backingRealPath, backupRealPath)) {
      throw new AtlasWorkspaceError(
        "La ruta de respaldos no pertenece a LuisA",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
  }

  private async ensureReplacementBackupDirectory(): Promise<void> {
    await this.ensureMigrationBackupDirectory();
    try {
      const metadata = await lstat(this.replacementBackupDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new AtlasWorkspaceError(
          "La ruta de reemplazos contiene un enlace o archivo inseguro",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(this.replacementBackupDirectory, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
    }
    const backupRealPath = await realpath(this.migrationBackupDirectory);
    const replacementRealPath = await realpath(
      this.replacementBackupDirectory,
    );
    if (!pathIsInside(backupRealPath, replacementRealPath)) {
      throw new AtlasWorkspaceError(
        "La ruta de reemplazos no pertenece a los respaldos",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
  }

  private async writeMigrationArchiveFile(
    directory: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    const path = resolve(directory, name);
    if (!pathIsInside(directory, path)) {
      throw new AtlasWorkspaceError(
        "La ruta del respaldo no es segura",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeWorkspaceReplacementArchiveFile(
    directory: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await this.writeMigrationArchiveFile(directory, name, value);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new AtlasWorkspaceError(
        "El respaldo de reemplazo contiene un destino inseguro",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    if ((await readFile(path, "utf8")) !== serialized) {
      throw new AtlasWorkspaceError(
        "El respaldo de reemplazo existente no coincide con la operación",
        "WORKSPACE_UNAVAILABLE",
      );
    }
  }

  private async ensureWorkspaceReplacementArchiveDirectory(
    directory: string,
  ): Promise<void> {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new AtlasWorkspaceError(
          "El respaldo de reemplazo contiene un destino inseguro",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
    }
    const replacementRealPath = await realpath(
      this.replacementBackupDirectory,
    );
    const archiveRealPath = await realpath(directory);
    if (!pathIsInside(replacementRealPath, archiveRealPath)) {
      throw new AtlasWorkspaceError(
        "El respaldo de reemplazo sale de su directorio",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
  }

  private async archiveMultiSessionMigration(
    current: AtlasWorkspaceDocument,
    incoming: AtlasWorkspaceContent,
    canonical: AtlasWorkspaceContent,
  ): Promise<void> {
    try {
      await this.ensureMigrationBackupDirectory();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveDirectory = resolve(
        this.migrationBackupDirectory,
        `single-session-${timestamp}-${randomUUID()}`,
      );
      if (
        !pathIsInside(this.migrationBackupDirectory, archiveDirectory)
      ) {
        throw new AtlasWorkspaceError(
          "La ruta del respaldo no es segura",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
      await mkdir(archiveDirectory, { mode: 0o700 });
      await this.writeMigrationArchiveFile(
        archiveDirectory,
        "workspace-before.json",
        current,
      );
      await this.writeMigrationArchiveFile(
        archiveDirectory,
        "workspace-candidate.json",
        incoming,
      );
      await this.writeMigrationArchiveFile(
        archiveDirectory,
        "manifest.json",
        {
          version: 1,
          reason: "single-session-migration",
          createdAt: new Date().toISOString(),
          workspaceId: current.workspaceId,
          revision: current.revision,
          currentSessionCount: current.explorations.length,
          candidateSessionCount: incoming.explorations.length,
          selectedSessionId: canonical.activeExplorationId,
        },
      );
      const directoryHandle = await open(archiveDirectory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (error instanceof AtlasWorkspaceError) throw error;
      throw new AtlasWorkspaceError(
        "No se pudo respaldar el workspace antes de sanearlo",
        "WORKSPACE_UNAVAILABLE",
        { cause: error },
      );
    }
  }

  private async archiveWorkspaceReplacement(
    current: AtlasWorkspaceDocument,
    incoming: AtlasWorkspaceContent,
    currentSessionId: string,
    candidateSessionId: string,
    writeId: string,
  ): Promise<void> {
    try {
      await this.ensureReplacementBackupDirectory();
      const archiveDirectory = resolve(
        this.replacementBackupDirectory,
        `replacement-${writeId}`,
      );
      if (
        !pathIsInside(this.replacementBackupDirectory, archiveDirectory)
      ) {
        throw new AtlasWorkspaceError(
          "La ruta del respaldo de reemplazo no es segura",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
      await this.ensureWorkspaceReplacementArchiveDirectory(
        archiveDirectory,
      );
      await this.writeWorkspaceReplacementArchiveFile(
        archiveDirectory,
        "workspace-before.json",
        current,
      );
      await this.writeWorkspaceReplacementArchiveFile(
        archiveDirectory,
        "workspace-candidate.json",
        incoming,
      );
      const manifestCore = {
        version: 1,
        reason: "single-session-replacement",
        workspaceId: current.workspaceId,
        revision: current.revision,
        writeId,
        currentSessionId,
        candidateSessionId,
      };
      try {
        await this.writeMigrationArchiveFile(
          archiveDirectory,
          "manifest.json",
          {
            ...manifestCore,
            createdAt: new Date().toISOString(),
          },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const manifestPath = resolve(archiveDirectory, "manifest.json");
        const metadata = await lstat(manifestPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new AtlasWorkspaceError(
            "El manifiesto de reemplazo contiene un destino inseguro",
            "UNSAFE_WORKSPACE_PATH",
          );
        }
        const existingManifest = JSON.parse(
          await readFile(manifestPath, "utf8"),
        ) as unknown;
        if (
          !isRecord(existingManifest) ||
          !isCanonicalTimestamp(existingManifest.createdAt) ||
          Object.entries(manifestCore).some(
            ([key, value]) => existingManifest[key] !== value,
          )
        ) {
          throw new AtlasWorkspaceError(
            "El manifiesto de reemplazo existente no coincide con la operación",
            "WORKSPACE_UNAVAILABLE",
          );
        }
      }
      const directoryHandle = await open(archiveDirectory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (error instanceof AtlasWorkspaceError) throw error;
      throw new AtlasWorkspaceError(
        "No se pudo respaldar el workspace antes de reemplazarlo",
        "WORKSPACE_UNAVAILABLE",
        { cause: error },
      );
    }
  }

  private async assertSafeFile(path: string): Promise<void> {
    if (!pathIsInside(this.stateDirectory, path)) {
      throw new AtlasWorkspaceError(
        "La ruta del workspace no es segura",
        "UNSAFE_WORKSPACE_PATH",
      );
    }
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new AtlasWorkspaceError(
          "El workspace contiene un enlace o destino inseguro",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async readWorkspaceFile(path: string): Promise<FileReadResult> {
    try {
      await this.assertSafeFile(path);
      const metadata = await stat(path);
      if (
        !metadata.isFile() ||
        metadata.size <= 0 ||
        metadata.size > MAX_ATLAS_WORKSPACE_BYTES
      ) {
        return {
          kind: "invalid",
          error: new Error("Tamaño de workspace inválido"),
        };
      }
      const serialized = await readFile(path, "utf8");
      return {
        kind: "valid",
        workspace: parseAtlasWorkspaceDocument(
          JSON.parse(serialized) as unknown,
        ),
      };
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      if (
        error instanceof AtlasWorkspaceError &&
        error.code === "UNSAFE_WORKSPACE_PATH"
      ) {
        throw error;
      }
      return { kind: "invalid", error };
    }
  }

  private async readUnderLock(): Promise<AtlasWorkspaceReadResult> {
    const primary = await this.readWorkspaceFile(this.workspacePath);
    if (primary.kind === "valid" && primary.workspace) {
      return {
        workspace: primary.workspace,
        recoveredFromBackup: false,
      };
    }

    const backup = await this.readWorkspaceFile(this.backupPath);
    if (backup.kind === "valid" && backup.workspace) {
      // A rollback must start a new lineage. Keeping the old workspaceId
      // would allow a stale client holding the same revision number to pass
      // CAS after the recovered state is written forward again (ABA).
      const recoveredWorkspace: AtlasWorkspaceDocument = {
        ...backup.workspace,
        workspaceId: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      await this.atomicWrite(
        this.workspacePath,
        serializeDocument(recoveredWorkspace),
      );
      return {
        workspace: recoveredWorkspace,
        recoveredFromBackup: true,
      };
    }
    if (primary.kind === "missing" && backup.kind === "missing") {
      return {
        workspace: emptyWorkspace(this.emptyWorkspaceId),
        recoveredFromBackup: false,
      };
    }
    throw new AtlasWorkspaceError(
      "El workspace y su respaldo no se pueden validar",
      "WORKSPACE_CORRUPT",
      { cause: primary.error ?? backup.error },
    );
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    await this.assertSafeFile(path);
    const temporaryPath = resolve(
      this.stateDirectory,
      `.${ATLAS_WORKSPACE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      await this.syncDirectory();
    } catch (error) {
      throw new AtlasWorkspaceError(
        "No se pudo guardar el workspace en LuisA",
        "WORKSPACE_UNAVAILABLE",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async syncDirectory(): Promise<void> {
    let directory;
    try {
      directory = await open(this.stateDirectory, "r");
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS") {
        throw error;
      }
      // Some exFAT implementations explicitly reject fsync on a directory.
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  private async withFileLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureStateDirectory();
    const lock = await this.acquireFileLock();
    try {
      await this.cleanupAbandonedTransientFiles();
      return await operation();
    } finally {
      await this.releaseFileLock(lock);
    }
  }

  private async acquireFileLock(): Promise<HeldFileLock> {
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      const nonce = randomUUID();
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        const metadata: LockMetadata = {
          pid: process.pid,
          nonce,
          createdAt: new Date().toISOString(),
        };
        await handle.writeFile(JSON.stringify(metadata), "utf8");
        await handle.sync();
        const lockHandle = handle;
        return {
          nonce,
          close: () => lockHandle.close(),
        };
      } catch (error) {
        if (handle) {
          const failedHandle = handle;
          await this.releaseFileLock({
            nonce,
            close: () => failedHandle.close(),
          });
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AtlasWorkspaceError(
            "No se pudo bloquear el workspace",
            "WORKSPACE_UNAVAILABLE",
            { cause: error },
          );
        }
        if (await this.removeKnownAbandonedLock()) continue;
        if (await this.removeStaleLock()) continue;
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }
    throw new AtlasWorkspaceError(
      "El workspace está ocupado por otro proceso",
      "WORKSPACE_LOCKED",
    );
  }

  private async releaseFileLock(lock: HeldFileLock): Promise<void> {
    await lock.close().catch(() => undefined);
    for (
      let attempt = 0;
      attempt < LOCK_RELEASE_RETRY_COUNT;
      attempt += 1
    ) {
      try {
        const raw = JSON.parse(
          await readFile(this.lockPath, "utf8"),
        ) as unknown;
        if (!isRecord(raw) || raw.nonce !== lock.nonce) {
          this.forgetAbandonedLock(lock.nonce);
          return;
        }
        await unlink(this.lockPath);
        this.forgetAbandonedLock(lock.nonce);
        return;
      } catch (error) {
        if (isMissing(error)) {
          this.forgetAbandonedLock(lock.nonce);
          return;
        }
        if (attempt + 1 < LOCK_RELEASE_RETRY_COUNT) {
          await delay(LOCK_RETRY_DELAY_MS);
        }
      }
    }
    let nonces = abandonedLockNonces.get(this.lockPath);
    if (!nonces) {
      nonces = new Set<string>();
      abandonedLockNonces.set(this.lockPath, nonces);
    }
    nonces.add(lock.nonce);
  }

  private forgetAbandonedLock(nonce: string): void {
    const nonces = abandonedLockNonces.get(this.lockPath);
    if (!nonces) return;
    nonces.delete(nonce);
    if (nonces.size === 0) abandonedLockNonces.delete(this.lockPath);
  }

  private async removeKnownAbandonedLock(): Promise<boolean> {
    const nonces = abandonedLockNonces.get(this.lockPath);
    if (!nonces || nonces.size === 0) return false;
    try {
      const raw = JSON.parse(
        await readFile(this.lockPath, "utf8"),
      ) as unknown;
      if (
        !isRecord(raw) ||
        raw.pid !== process.pid ||
        typeof raw.nonce !== "string" ||
        !nonces.has(raw.nonce)
      ) {
        if (isRecord(raw) && typeof raw.nonce === "string") {
          abandonedLockNonces.delete(this.lockPath);
        }
        return false;
      }
      await unlink(this.lockPath);
      this.forgetAbandonedLock(raw.nonce);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        abandonedLockNonces.delete(this.lockPath);
        return true;
      }
      return false;
    }
  }

  private async cleanupAbandonedTransientFiles(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.stateDirectory);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => WORKSPACE_TRANSIENT_PATTERN.test(name))
        .map((name) =>
          rm(resolve(this.stateDirectory, name), { force: true }).catch(
            () => undefined,
          ),
        ),
    );
  }

  private async removeStaleLock(): Promise<boolean> {
    let reaper: FileHandle | undefined;
    let reaperNonce: string | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          reaper = await open(this.lockReaperPath, "wx", 0o600);
          reaperNonce = randomUUID();
          const metadata: LockMetadata = {
            pid: process.pid,
            nonce: reaperNonce,
            createdAt: new Date().toISOString(),
          };
          await reaper.writeFile(JSON.stringify(metadata), "utf8");
          await reaper.sync();
          break;
        } catch (error) {
          await reaper?.close().catch(() => undefined);
          reaper = undefined;
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await this.retireStaleReaper())) return false;
        }
      }
      if (!reaper || !reaperNonce) return false;
      const metadata = await lstat(this.lockPath);
      if (metadata.isSymbolicLink()) {
        throw new AtlasWorkspaceError(
          "El lock del workspace es un enlace inseguro",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
      if (Date.now() - metadata.mtimeMs < LOCK_STALE_AFTER_MS) return false;
      let ownerPid: number | null = null;
      try {
        const value = JSON.parse(
          await readFile(this.lockPath, "utf8"),
        ) as unknown;
        if (
          isRecord(value) &&
          typeof value.pid === "number" &&
          Number.isSafeInteger(value.pid) &&
          value.pid > 0
        ) {
          ownerPid = value.pid;
        }
      } catch {
        // An old malformed lock can be retired.
      }
      if (ownerPid !== null) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
        }
      }
      const stalePath = `${this.lockPath}.stale.${process.pid}.${randomUUID()}`;
      await rename(this.lockPath, stalePath);
      try {
        return true;
      } finally {
        await rm(stalePath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (isMissing(error)) return true;
      if (error instanceof AtlasWorkspaceError) throw error;
      return false;
    } finally {
      await reaper?.close().catch(() => undefined);
      if (reaperNonce) {
        try {
          const raw = JSON.parse(
            await readFile(this.lockReaperPath, "utf8"),
          ) as unknown;
          if (isRecord(raw) && raw.nonce === reaperNonce) {
            await unlink(this.lockReaperPath);
          }
        } catch {
          // A missing or externally replaced transient reaper is not user data.
        }
      }
    }
  }

  private async retireStaleReaper(): Promise<boolean> {
    let initial;
    try {
      initial = await lstat(this.lockReaperPath);
      if (initial.isSymbolicLink() || !initial.isFile()) {
        throw new AtlasWorkspaceError(
          "El reaper del workspace es un destino inseguro",
          "UNSAFE_WORKSPACE_PATH",
        );
      }
      const ageMs = Date.now() - initial.mtimeMs;
      if (ageMs < LOCK_REAPER_STALE_AFTER_MS) return false;

      let ownerPid: number | null = null;
      let expectedNonce: string | null = null;
      try {
        const value = JSON.parse(
          await readFile(this.lockReaperPath, "utf8"),
        ) as unknown;
        if (isRecord(value)) {
          if (isValidUuid(value.nonce)) expectedNonce = value.nonce;
          if (
            typeof value.pid === "number" &&
            Number.isSafeInteger(value.pid) &&
            value.pid > 0
          ) {
            ownerPid = value.pid;
          }
        }
      } catch {
        // A stale malformed reaper can be quarantined below.
      }
      if (ownerPid !== null) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
        }
      }

      const current = await lstat(this.lockReaperPath);
      if (
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        current.mtimeMs !== initial.mtimeMs
      ) {
        return false;
      }
      if (expectedNonce !== null) {
        try {
          const currentValue = JSON.parse(
            await readFile(this.lockReaperPath, "utf8"),
          ) as unknown;
          if (!isRecord(currentValue) || currentValue.nonce !== expectedNonce) {
            return false;
          }
        } catch {
          return false;
        }
      }

      const stalePath =
        `${this.lockReaperPath}.stale.${process.pid}.${randomUUID()}`;
      await rename(this.lockReaperPath, stalePath);
      try {
        const quarantined = await lstat(stalePath);
        if (
          quarantined.dev !== initial.dev ||
          quarantined.ino !== initial.ino
        ) {
          await rename(stalePath, this.lockReaperPath).catch(() => undefined);
          return false;
        }
        await rm(stalePath, { force: true });
        return true;
      } finally {
        await rm(stalePath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (isMissing(error)) return true;
      if (error instanceof AtlasWorkspaceError) throw error;
      return false;
    }
  }
}
