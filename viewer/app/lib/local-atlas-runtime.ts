import {
  deserializeExplorationState,
  serializeExplorationState,
  type WorldBounds,
} from "./exploration-grid.ts";
import {
  parseCoverageSelection,
  type OverworldCoverageSelection,
} from "./overworld-coverage.ts";

export const LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION = 1 as const;
const LOCAL_ATLAS_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalJobStatus =
  | "running"
  | "stopping"
  | "complete"
  | "stopped"
  | "error";

export interface LocalRegionJobRequest {
  readonly xMin: number;
  readonly zMin: number;
  readonly xMaxExclusive: number;
  readonly zMaxExclusive: number;
  readonly lod: number;
  readonly layers: readonly ("base" | "overlay" | "newchunks")[];
  readonly requestsPerSecond: number;
}

export interface LocalCapacitySnapshot {
  readonly configured: boolean;
  readonly volume: string;
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly archiveBytes: number | null;
  readonly availableForAtlasBytes: number | null;
  readonly overworldRequirementBytes: number;
  readonly marginBytes: number | null;
  readonly fits: boolean | null;
}

export interface LocalRegionJob {
  readonly id: string;
  readonly status: LocalJobStatus;
  readonly request: LocalRegionJobRequest | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly message: string;
  readonly progress?: LocalRegionJobProgress;
}

export interface LocalRegionJobProgress {
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
}

export type LocalAtlasTileLayer = "base" | "overlay" | "newchunks";

export interface LocalAtlasRegionStatus {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly lod: 0;
  readonly bounds: WorldBounds;
  readonly layers: readonly LocalAtlasTileLayer[];
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
  /** LOD 0 base cells that the source has durably confirmed as HTTP 404. */
  readonly absentCells: readonly {
    readonly tileX: number;
    readonly tileZ: number;
  }[];
}

export interface LocalAtlasRuntime {
  readonly localOnly: true;
  readonly mutationToken: string;
  readonly capacity: LocalCapacitySnapshot;
  readonly persistence: {
    readonly configured: boolean;
    readonly writable: boolean;
    readonly volume: string;
    readonly revision: number | null;
    readonly updatedAt: string | null;
  };
  readonly job: LocalRegionJob | null;
}

export function isCompletedBaseCellRequest(
  job: LocalRegionJob | null,
  bounds: WorldBounds,
  lod: number,
): boolean {
  const request = job?.request;
  return Boolean(
    job?.status === "complete" &&
      job.exitCode === 0 &&
      request &&
      request.lod === lod &&
      request.layers.includes("base") &&
      request.xMin <= bounds.minX &&
      request.zMin <= bounds.minZ &&
      request.xMaxExclusive >= bounds.maxXExclusive &&
      request.zMaxExclusive >= bounds.maxZExclusive,
  );
}

export function regionJobMatchesBounds(
  job: LocalRegionJob | null,
  bounds: WorldBounds,
): boolean {
  const request = job?.request;
  return Boolean(
    request &&
      request.lod === 0 &&
      request.xMin === bounds.minX &&
      request.zMin === bounds.minZ &&
      request.xMaxExclusive === bounds.maxXExclusive &&
      request.zMaxExclusive === bounds.maxZExclusive,
  );
}

export interface LocalAtlasCoverageCell {
  readonly row: number;
  readonly column: number;
  readonly completeCount: number;
  readonly queuedCount: number;
  readonly failedCount: number;
  /** Target-LOD tiles excluded by confirmed 404s at this or an ancestor LOD. */
  readonly absentCount: number;
}

export interface LocalAtlasCoverageSnapshot {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly layer: "base";
  readonly lod: number;
  readonly databaseUpdatedAt: string;
  readonly cells: readonly LocalAtlasCoverageCell[];
}

export interface LocalAtlasWorkspaceExploration {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: {
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
    readonly reviewedCount: number;
    readonly reviewedBits: string;
    readonly skippedCount: number;
    readonly skippedBits: string;
  };
}

export interface LocalAtlasWorkspaceHighlight {
  readonly id: string;
  readonly type: "pin" | "area";
  readonly title: string;
  readonly note: string;
  readonly color: string;
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

export interface LocalAtlasWorkspaceContent {
  readonly schemaVersion: typeof LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION;
  readonly activeExplorationId: string | null;
  readonly explorations: readonly LocalAtlasWorkspaceExploration[];
  readonly highlights: readonly LocalAtlasWorkspaceHighlight[];
  readonly coverageSelection: OverworldCoverageSelection | null;
}

export interface LocalAtlasWorkspace extends LocalAtlasWorkspaceContent {
  readonly workspaceId: string;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly lastWriteId: string | null;
}

export type LocalAtlasWorkspacePrecondition = Pick<
  LocalAtlasWorkspace,
  "workspaceId" | "revision"
>;

export class LocalAtlasWorkspaceConflictError extends Error {
  readonly current: LocalAtlasWorkspace | null;

  constructor(message: string, current: LocalAtlasWorkspace | null) {
    super(message);
    this.name = "LocalAtlasWorkspaceConflictError";
    this.current = current;
  }
}

const JOB_STATUSES = new Set<LocalJobStatus>([
  "running",
  "stopping",
  "complete",
  "stopped",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function safeMapCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 30_000_000
  );
}

function readWorkspaceExploration(
  value: unknown,
): LocalAtlasWorkspaceExploration | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !canonicalTimestamp(value.createdAt) ||
    !canonicalTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return null;
  }
  try {
    const restored = deserializeExplorationState(JSON.stringify(value.state));
    const state = JSON.parse(
      serializeExplorationState(restored),
    ) as LocalAtlasWorkspaceExploration["state"];
    if (value.id !== state.region.id) return null;
    return {
      id: value.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      state,
    };
  } catch {
    return null;
  }
}

export function parseLocalAtlasWorkspaceExplorations(
  value: unknown,
): LocalAtlasWorkspaceExploration[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const explorations: LocalAtlasWorkspaceExploration[] = [];
  const explorationIds = new Set<string>();
  for (const item of value) {
    const exploration = readWorkspaceExploration(item);
    if (!exploration || explorationIds.has(exploration.id)) return null;
    explorationIds.add(exploration.id);
    explorations.push(exploration);
  }
  return explorations;
}

function readWorkspaceHighlight(
  value: unknown,
): LocalAtlasWorkspaceHighlight | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 100 ||
    (value.type !== "pin" && value.type !== "area") ||
    typeof value.title !== "string" ||
    value.title.length > 200 ||
    typeof value.note !== "string" ||
    value.note.length > 20_000 ||
    typeof value.color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(value.color) ||
    !safeMapCoordinate(value.x) ||
    !safeMapCoordinate(value.z) ||
    typeof value.visible !== "boolean" ||
    !canonicalTimestamp(value.createdAt)
  ) {
    return null;
  }
  let bounds: LocalAtlasWorkspaceHighlight["bounds"];
  if (value.type === "area") {
    if (
      !isRecord(value.bounds) ||
      !safeMapCoordinate(value.bounds.x1) ||
      !safeMapCoordinate(value.bounds.z1) ||
      !safeMapCoordinate(value.bounds.x2) ||
      !safeMapCoordinate(value.bounds.z2) ||
      Math.abs(value.bounds.x2 - value.bounds.x1) < 2 ||
      Math.abs(value.bounds.z2 - value.bounds.z1) < 2
    ) {
      return null;
    }
    bounds = {
      x1: value.bounds.x1,
      z1: value.bounds.z1,
      x2: value.bounds.x2,
      z2: value.bounds.z2,
    };
  }
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    note: value.note,
    color: value.color.toLowerCase(),
    x: value.x,
    z: value.z,
    ...(bounds ? { bounds } : {}),
    visible: value.visible,
    createdAt: value.createdAt,
  };
}

function readJob(value: unknown): LocalRegionJob | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    !JOB_STATUSES.has(value.status as LocalJobStatus) ||
    typeof value.startedAt !== "string" ||
    !(value.finishedAt === null || typeof value.finishedAt === "string") ||
    !nullableNumber(value.exitCode) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  let request: LocalRegionJobRequest | null = null;
  if (value.request !== undefined) {
    if (
      !isRecord(value.request) ||
      !safeMapCoordinate(value.request.xMin) ||
      !safeMapCoordinate(value.request.zMin) ||
      !safeMapCoordinate(value.request.xMaxExclusive) ||
      !safeMapCoordinate(value.request.zMaxExclusive) ||
      value.request.xMaxExclusive <= value.request.xMin ||
      value.request.zMaxExclusive <= value.request.zMin ||
      typeof value.request.lod !== "number" ||
      !Number.isSafeInteger(value.request.lod) ||
      value.request.lod < 0 ||
      value.request.lod > 10 ||
      !Array.isArray(value.request.layers) ||
      value.request.layers.length < 1 ||
      value.request.layers.length > 3 ||
      !value.request.layers.every(
        (layer) =>
          layer === "base" ||
          layer === "overlay" ||
          layer === "newchunks",
      ) ||
      new Set(value.request.layers).size !== value.request.layers.length ||
      typeof value.request.requestsPerSecond !== "number" ||
      !Number.isFinite(value.request.requestsPerSecond) ||
      value.request.requestsPerSecond < 0.25 ||
      value.request.requestsPerSecond > 2
    ) {
      return undefined;
    }
    request = {
      xMin: value.request.xMin,
      zMin: value.request.zMin,
      xMaxExclusive: value.request.xMaxExclusive,
      zMaxExclusive: value.request.zMaxExclusive,
      lod: value.request.lod,
      layers: value.request.layers,
      requestsPerSecond: value.request.requestsPerSecond,
    };
  }
  let progress: LocalRegionJobProgress | undefined;
  if (value.progress !== undefined) {
    if (
      !isRecord(value.progress) ||
      !nonNegativeSafeInteger(value.progress.requested) ||
      !nonNegativeSafeInteger(value.progress.processed) ||
      !nonNegativeSafeInteger(value.progress.complete) ||
      !nonNegativeSafeInteger(value.progress.absent) ||
      !nonNegativeSafeInteger(value.progress.failed) ||
      !nonNegativeSafeInteger(value.progress.reused) ||
      !nonNegativeSafeInteger(value.progress.reusedAbsent) ||
      !nonNegativeSafeInteger(value.progress.downloadedBytes) ||
      typeof value.progress.percent !== "number" ||
      !Number.isFinite(value.progress.percent) ||
      value.progress.percent < 0 ||
      value.progress.percent > 100 ||
      (value.progress.status !== "running" &&
        value.progress.status !== "complete" &&
        value.progress.status !== "error" &&
        value.progress.status !== "interrupted") ||
      value.progress.processed > value.progress.requested ||
      value.progress.complete +
          value.progress.absent +
          value.progress.failed >
        value.progress.requested ||
      value.progress.reused > value.progress.complete ||
      value.progress.reusedAbsent > value.progress.absent
    ) {
      return undefined;
    }
    progress = {
      requested: value.progress.requested,
      processed: value.progress.processed,
      complete: value.progress.complete,
      absent: value.progress.absent,
      failed: value.progress.failed,
      reused: value.progress.reused,
      reusedAbsent: value.progress.reusedAbsent,
      downloadedBytes: value.progress.downloadedBytes,
      percent: value.progress.percent,
      status: value.progress.status,
    };
  }
  return {
    id: value.id,
    status: value.status as LocalJobStatus,
    request,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    exitCode: value.exitCode,
    message: value.message,
    ...(progress ? { progress } : {}),
  };
}

export function parseLocalAtlasRuntime(
  value: unknown,
): LocalAtlasRuntime | null {
  if (
    !isRecord(value) ||
    value.localOnly !== true ||
    typeof value.mutationToken !== "string" ||
    value.mutationToken.length < 16 ||
    !isRecord(value.capacity)
  ) {
    return null;
  }
  const capacity = value.capacity;
  const job = readJob(value.job);
  const persistence = value.persistence;
  if (
    job === undefined ||
    typeof capacity.configured !== "boolean" ||
    typeof capacity.volume !== "string" ||
    !nullableNumber(capacity.totalBytes) ||
    !nullableNumber(capacity.freeBytes) ||
    !nullableNumber(capacity.archiveBytes) ||
    !nullableNumber(capacity.availableForAtlasBytes) ||
    typeof capacity.overworldRequirementBytes !== "number" ||
    !Number.isFinite(capacity.overworldRequirementBytes) ||
    !nullableNumber(capacity.marginBytes) ||
    !(
      capacity.fits === null ||
      typeof capacity.fits === "boolean"
    ) ||
    !(
      persistence === undefined ||
      (isRecord(persistence) &&
        typeof persistence.configured === "boolean" &&
        typeof persistence.writable === "boolean" &&
        typeof persistence.volume === "string" &&
        (persistence.revision === null ||
          (typeof persistence.revision === "number" &&
            Number.isSafeInteger(persistence.revision) &&
            persistence.revision >= 0)) &&
        (persistence.updatedAt === null ||
          canonicalTimestamp(persistence.updatedAt)))
    )
  ) {
    return null;
  }
  return {
    localOnly: true,
    mutationToken: value.mutationToken,
    capacity: {
      configured: capacity.configured,
      volume: capacity.volume,
      totalBytes: capacity.totalBytes,
      freeBytes: capacity.freeBytes,
      archiveBytes: capacity.archiveBytes,
      availableForAtlasBytes: capacity.availableForAtlasBytes,
      overworldRequirementBytes: capacity.overworldRequirementBytes,
      marginBytes: capacity.marginBytes,
      fits: capacity.fits,
    },
    persistence:
      persistence && isRecord(persistence)
        ? {
            configured: persistence.configured as boolean,
            writable: persistence.writable as boolean,
            volume: persistence.volume as string,
            revision: persistence.revision as number | null,
            updatedAt: persistence.updatedAt as string | null,
          }
        : {
            configured: false,
            writable: false,
            volume: "LuisA",
            revision: null,
            updatedAt: null,
          },
    job,
  };
}

export function parseLocalAtlasWorkspaceContent(
  value: unknown,
): LocalAtlasWorkspaceContent | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION ||
    !Array.isArray(value.explorations) ||
    value.explorations.length > 128 ||
    !Array.isArray(value.highlights) ||
    value.highlights.length > 10_000
  ) {
    return null;
  }

  const explorations = parseLocalAtlasWorkspaceExplorations(
    value.explorations,
  );
  if (!explorations) return null;
  const explorationIds = new Set(
    explorations.map((exploration) => exploration.id),
  );
  const highlights: LocalAtlasWorkspaceHighlight[] = [];
  const highlightIds = new Set<string>();
  for (const item of value.highlights) {
    const highlight = readWorkspaceHighlight(item);
    if (!highlight || highlightIds.has(highlight.id)) return null;
    highlightIds.add(highlight.id);
    highlights.push(highlight);
  }
  if (
    value.activeExplorationId !== null &&
    (typeof value.activeExplorationId !== "string" ||
      !explorationIds.has(value.activeExplorationId))
  ) {
    return null;
  }
  const coverageSelection =
    value.coverageSelection === null
      ? null
      : parseCoverageSelection(value.coverageSelection);
  if (value.coverageSelection !== null && !coverageSelection) return null;

  return {
    schemaVersion: LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION,
    activeExplorationId: value.activeExplorationId,
    explorations,
    highlights,
    coverageSelection,
  };
}

export function parseLocalAtlasWorkspace(
  value: unknown,
): LocalAtlasWorkspace | null {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== "string" ||
    !LOCAL_ATLAS_UUID_PATTERN.test(value.workspaceId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }
  if (
    value.revision === 0
      ? value.updatedAt !== null || value.lastWriteId !== null
      : !canonicalTimestamp(value.updatedAt) ||
        typeof value.lastWriteId !== "string" ||
        !LOCAL_ATLAS_UUID_PATTERN.test(value.lastWriteId)
  ) {
    return null;
  }
  const content = parseLocalAtlasWorkspaceContent(value);
  if (!content) return null;
  return {
    ...content,
    workspaceId: value.workspaceId,
    revision: value.revision,
    updatedAt: value.updatedAt as string | null,
    lastWriteId: value.lastWriteId as string | null,
  };
}

export function localAtlasWorkspaceContent(
  workspace: LocalAtlasWorkspace,
): LocalAtlasWorkspaceContent {
  return {
    schemaVersion: LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION,
    activeExplorationId: workspace.activeExplorationId,
    explorations: workspace.explorations,
    highlights: workspace.highlights,
    coverageSelection: workspace.coverageSelection,
  };
}

export function parseLocalAtlasCoverage(
  value: unknown,
): LocalAtlasCoverageSnapshot | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.dimension !== "overworld" ||
    value.layer !== "base" ||
    typeof value.lod !== "number" ||
    !Number.isSafeInteger(value.lod) ||
    value.lod < 0 ||
    value.lod > 3 ||
    !canonicalTimestamp(value.databaseUpdatedAt) ||
    !Array.isArray(value.cells) ||
    value.cells.length > 1_089
  ) {
    return null;
  }
  const cells: LocalAtlasCoverageCell[] = [];
  const indexes = new Set<number>();
  for (const cell of value.cells) {
    if (
      !isRecord(cell) ||
      typeof cell.row !== "number" ||
      !Number.isSafeInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= 33 ||
      typeof cell.column !== "number" ||
      !Number.isSafeInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= 33 ||
      typeof cell.completeCount !== "number" ||
      !Number.isSafeInteger(cell.completeCount) ||
      cell.completeCount < 0 ||
      typeof cell.queuedCount !== "number" ||
      !Number.isSafeInteger(cell.queuedCount) ||
      cell.queuedCount < 0 ||
      typeof cell.failedCount !== "number" ||
      !Number.isSafeInteger(cell.failedCount) ||
      cell.failedCount < 0 ||
      typeof cell.absentCount !== "number" ||
      !Number.isSafeInteger(cell.absentCount) ||
      cell.absentCount < 0
    ) {
      return null;
    }
    const index = cell.row * 33 + cell.column;
    if (indexes.has(index)) return null;
    indexes.add(index);
    cells.push({
      row: cell.row,
      column: cell.column,
      completeCount: cell.completeCount,
      queuedCount: cell.queuedCount,
      failedCount: cell.failedCount,
      absentCount: cell.absentCount,
    });
  }
  return {
    version: 1,
    dimension: "overworld",
    layer: "base",
    lod: value.lod,
    databaseUpdatedAt: value.databaseUpdatedAt,
    cells,
  };
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function parseLocalAtlasRegionStatus(
  value: unknown,
): LocalAtlasRegionStatus | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.dimension !== "overworld" ||
    value.lod !== 0 ||
    !isRecord(value.bounds) ||
    !safeMapCoordinate(value.bounds.minX) ||
    !safeMapCoordinate(value.bounds.minZ) ||
    !safeMapCoordinate(value.bounds.maxXExclusive) ||
    !safeMapCoordinate(value.bounds.maxZExclusive) ||
    value.bounds.maxXExclusive <= value.bounds.minX ||
    value.bounds.maxZExclusive <= value.bounds.minZ ||
    !Array.isArray(value.layers) ||
    value.layers.length < 1 ||
    value.layers.length > 3 ||
    !value.layers.every(
      (layer) =>
        layer === "base" ||
        layer === "overlay" ||
        layer === "newchunks",
    ) ||
    new Set(value.layers).size !== value.layers.length ||
    !nonNegativeSafeInteger(value.totalCount) ||
    !nonNegativeSafeInteger(value.resolvedCount) ||
    !nonNegativeSafeInteger(value.completeCount) ||
    !nonNegativeSafeInteger(value.absentCount) ||
    !nonNegativeSafeInteger(value.pendingCount) ||
    !nonNegativeSafeInteger(value.failedCount) ||
    !nonNegativeSafeInteger(value.missingCount) ||
    typeof value.percent !== "number" ||
    !Number.isFinite(value.percent) ||
    value.percent < 0 ||
    value.percent > 100 ||
    typeof value.ready !== "boolean" ||
    !(
      value.databaseUpdatedAt === null ||
      canonicalTimestamp(value.databaseUpdatedAt)
    ) ||
    !Array.isArray(value.absentCells)
  ) {
    return null;
  }
  if (
    value.totalCount !==
      value.completeCount +
        value.absentCount +
        value.pendingCount +
        value.failedCount +
        value.missingCount ||
    value.resolvedCount !== value.completeCount + value.absentCount ||
    value.resolvedCount > value.totalCount ||
    value.ready !==
      (value.resolvedCount === value.totalCount &&
        value.pendingCount === 0 &&
        value.failedCount === 0 &&
        value.missingCount === 0)
  ) {
    return null;
  }
  const expectedPercent =
    value.totalCount === 0
      ? 100
      : (value.resolvedCount / value.totalCount) * 100;
  if (Math.abs(value.percent - expectedPercent) > 0.01) return null;

  const absentCells: Array<{ tileX: number; tileZ: number }> = [];
  const absentKeys = new Set<string>();
  for (const cell of value.absentCells) {
    if (
      !isRecord(cell) ||
      typeof cell.tileX !== "number" ||
      typeof cell.tileZ !== "number" ||
      !Number.isSafeInteger(cell.tileX) ||
      !Number.isSafeInteger(cell.tileZ) ||
      Math.abs(cell.tileX) > 30_000_000 ||
      Math.abs(cell.tileZ) > 30_000_000
    ) {
      return null;
    }
    const key = `${cell.tileX}:${cell.tileZ}`;
    if (absentKeys.has(key)) return null;
    absentKeys.add(key);
    absentCells.push({ tileX: cell.tileX, tileZ: cell.tileZ });
  }
  if (absentCells.length > value.absentCount) return null;

  return {
    version: 1,
    dimension: "overworld",
    lod: 0,
    bounds: {
      minX: value.bounds.minX,
      minZ: value.bounds.minZ,
      maxXExclusive: value.bounds.maxXExclusive,
      maxZExclusive: value.bounds.maxZExclusive,
    },
    layers: value.layers as LocalAtlasTileLayer[],
    totalCount: value.totalCount,
    resolvedCount: value.resolvedCount,
    completeCount: value.completeCount,
    absentCount: value.absentCount,
    pendingCount: value.pendingCount,
    failedCount: value.failedCount,
    missingCount: value.missingCount,
    percent: value.percent,
    ready: value.ready,
    databaseUpdatedAt: value.databaseUpdatedAt as string | null,
    absentCells,
  };
}

export async function readLocalAtlasRuntime(
  signal?: AbortSignal,
): Promise<LocalAtlasRuntime | null> {
  const response = await fetch("/api/local-atlas/status", {
    cache: "no-store",
    signal,
  });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error("No se pudo leer el runtime local");
  return parseLocalAtlasRuntime(await response.json());
}

export async function readLocalAtlasCoverage(
  lod: number,
  signal?: AbortSignal,
): Promise<LocalAtlasCoverageSnapshot | null> {
  if (!Number.isSafeInteger(lod) || lod < 0 || lod > 3) {
    throw new RangeError("La cobertura local solo admite LOD 0 a 3");
  }
  const response = await fetch(
    `/api/local-atlas/coverage?layer=base&lod=${lod}`,
    {
      cache: "no-store",
      signal,
    },
  );
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    throw new Error("No se pudo leer la cobertura del mapa local");
  }
  const coverage = parseLocalAtlasCoverage(await response.json());
  if (!coverage || coverage.lod !== lod) {
    throw new Error("El catálogo devolvió una cobertura local no válida");
  }
  return coverage;
}

export async function readLocalAtlasRegionStatus(
  bounds: WorldBounds,
  layers: readonly LocalAtlasTileLayer[],
  signal?: AbortSignal,
): Promise<LocalAtlasRegionStatus | null> {
  const query = new URLSearchParams({
    xMin: String(bounds.minX),
    zMin: String(bounds.minZ),
    xMaxExclusive: String(bounds.maxXExclusive),
    zMaxExclusive: String(bounds.maxZExclusive),
    lod: "0",
    layers: [...layers].join(","),
  });
  const response = await fetch(`/api/local-atlas/region-status?${query}`, {
    cache: "no-store",
    signal,
  });
  if (response.status === 204 || response.status === 404) return null;
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo comprobar la descarga completa de la región",
    );
  }
  const status = parseLocalAtlasRegionStatus(payload);
  if (!status) {
    throw new Error("El catálogo devolvió un estado regional no válido");
  }
  return status;
}

export async function readLocalAtlasWorkspace(
  signal?: AbortSignal,
): Promise<LocalAtlasWorkspace | null> {
  const response = await fetch("/api/local-atlas/workspace", {
    cache: "no-store",
    signal,
  });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo leer el workspace de LuisA",
    );
  }
  const workspace = parseLocalAtlasWorkspace(await response.json());
  if (!workspace) {
    throw new Error("LuisA devolvió un workspace no válido");
  }
  if (
    response.headers.get("ETag") !==
    `"atlas-${workspace.workspaceId}-${workspace.revision}"`
  ) {
    throw new Error("La revisión del workspace no coincide con su ETag");
  }
  return workspace;
}

export async function writeLocalAtlasWorkspace(
  runtime: LocalAtlasRuntime,
  content: LocalAtlasWorkspaceContent,
  expected: LocalAtlasWorkspacePrecondition,
  options: { readonly writeId?: string; readonly signal?: AbortSignal } = {},
): Promise<LocalAtlasWorkspace> {
  const writeId = options.writeId ?? crypto.randomUUID();
  const response = await fetch("/api/local-atlas/workspace", {
    method: "PUT",
    cache: "no-store",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      "If-Match": `"atlas-${expected.workspaceId}-${expected.revision}"`,
      "X-Atlas-Token": runtime.mutationToken,
      "X-Atlas-Write-Id": writeId,
    },
    body: JSON.stringify(content),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (response.status === 412) {
    const current =
      isRecord(payload) && "current" in payload
        ? parseLocalAtlasWorkspace(payload.current)
        : null;
    throw new LocalAtlasWorkspaceConflictError(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "El workspace cambió en otra pestaña",
      current,
    );
  }
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo guardar el workspace en LuisA",
    );
  }
  const workspace = parseLocalAtlasWorkspace(payload);
  if (!workspace) {
    throw new Error("LuisA devolvió un workspace no válido");
  }
  if (
    response.headers.get("ETag") !==
    `"atlas-${workspace.workspaceId}-${workspace.revision}"`
  ) {
    throw new Error("La revisión guardada no coincide con su ETag");
  }
  return workspace;
}

export async function downloadExplorationRegion(
  runtime: LocalAtlasRuntime,
  bounds: WorldBounds,
  layers: readonly LocalAtlasTileLayer[],
  requestsPerSecond: number,
): Promise<LocalRegionJob> {
  const response = await fetch("/api/local-atlas/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Atlas-Token": runtime.mutationToken,
    },
    body: JSON.stringify({
      xMin: bounds.minX,
      zMin: bounds.minZ,
      xMaxExclusive: bounds.maxXExclusive,
      zMaxExclusive: bounds.maxZExclusive,
      lod: 0,
      layers,
      requestsPerSecond,
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo iniciar la descarga regional",
    );
  }
  const job =
    isRecord(payload) && "job" in payload ? readJob(payload.job) : undefined;
  if (!job) {
    throw new Error("El runtime no devolvió una descarga regional válida");
  }
  return job;
}

/** @deprecated Use the mandatory full-region workflow instead. */
export async function downloadExplorationCell(
  runtime: LocalAtlasRuntime,
  bounds: WorldBounds,
  layers: readonly LocalAtlasTileLayer[],
  requestsPerSecond: number,
): Promise<void> {
  await downloadExplorationRegion(
    runtime,
    bounds,
    layers,
    requestsPerSecond,
  );
}

export async function stopLocalRegionJob(
  runtime: LocalAtlasRuntime,
): Promise<void> {
  if (!runtime.job) return;
  const response = await fetch("/api/local-atlas/stop", {
    method: "POST",
    headers: {
      "X-Atlas-Token": runtime.mutationToken,
      "X-Atlas-Job-Id": runtime.job.id,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo detener la descarga regional",
    );
  }
}
