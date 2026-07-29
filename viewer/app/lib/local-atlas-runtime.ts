import {
  deserializeExplorationState,
  serializeExplorationState,
  type WorldBounds,
} from "./exploration-grid.ts";
import {
  parseCoverageSelection,
  type OverworldCoverageSelection,
} from "./overworld-coverage.ts";
import { isHighlightRegionKey } from "./highlights.ts";

export const LOCAL_ATLAS_WORKSPACE_SCHEMA_VERSION = 1 as const;
const MAX_REGION_REQUESTS_PER_SECOND = 16;
const MAX_REGION_COOLDOWN_SECONDS = 15 * 60;
const RATE_METRIC_TOLERANCE = 0.001;
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

export type LocalGlobalDownloadStatus =
  | "running"
  | "complete"
  | "fallback_complete"
  | "stopped"
  | "incomplete"
  | "error";

export interface LocalGlobalDownloadProgress {
  readonly status: LocalGlobalDownloadStatus;
  readonly processedRequests: number;
  readonly plannedRequests: number;
  readonly completeTiles: number;
  readonly absentTiles: number;
  readonly corruptTiles: number;
  readonly failedTiles: number;
  readonly pendingTiles: number;
  readonly progressPercent: number;
  readonly dataBytes: number | null;
  readonly tilesPerSecond: number | null;
  readonly megabytesPerSecond: number | null;
  readonly etaSeconds: number | null;
  readonly effectiveRequestsPerSecond: number | null;
  readonly updatedAt: string;
  readonly fallback: boolean;
  readonly scope: {
    readonly dimensions: readonly ("overworld" | "nether" | "end")[];
    readonly layers: readonly ("base" | "overlay" | "newchunks")[];
    readonly lods: readonly number[];
  };
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
  readonly globalDownload: LocalGlobalDownloadProgress | null;
  readonly job: LocalRegionJob | null;
}

export interface LocalAtlasXaeroDimensionSummary {
  readonly existing: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly alreadyAbsent: number;
  readonly conflicts: number;
  readonly final: number;
}

export type LocalAtlasXaeroOperation = "export" | "remove";

export type LocalAtlasXaeroScope =
  | { readonly kind: "all" }
  | {
      readonly kind: "exploration";
      readonly explorationId: string;
    };

export interface LocalAtlasXaeroRequest {
  readonly operation: LocalAtlasXaeroOperation;
  readonly scope: LocalAtlasXaeroScope;
}

export interface LocalAtlasXaeroPreview {
  readonly version: 1;
  readonly previewId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly operation: LocalAtlasXaeroOperation;
  readonly scope: LocalAtlasXaeroScope["kind"];
  readonly explorationId: string | null;
  readonly regionName: string | null;
  readonly minecraftOpen: boolean;
  readonly canExport: boolean;
  readonly hasChanges: boolean;
  readonly sourceHighlights: number;
  readonly exportableHighlights: number;
  readonly selectedHighlights: number;
  readonly managedHighlights: number;
  readonly removableHighlights: number;
  readonly skippedAreas: number;
  readonly notesNotExported: number;
  readonly duplicateNames: number;
  readonly conflicts: number;
  readonly overworld: LocalAtlasXaeroDimensionSummary;
  readonly nether: LocalAtlasXaeroDimensionSummary;
}

export interface LocalAtlasXaeroResult extends LocalAtlasXaeroPreview {
  readonly committed: true;
  readonly exportedAt: string;
  readonly backupId: string;
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
    readonly currentCellPreviouslyReviewed: boolean;
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

const GLOBAL_DOWNLOAD_STATUSES = new Set<LocalGlobalDownloadStatus>([
  "running",
  "complete",
  "fallback_complete",
  "stopped",
  "incomplete",
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
    !(
      value.regionKey === undefined ||
      value.regionKey === null ||
      isHighlightRegionKey(value.regionKey)
    ) ||
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
    ...(value.regionKey !== undefined
      ? { regionKey: value.regionKey as string | null }
      : {}),
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
      value.request.requestsPerSecond > MAX_REGION_REQUESTS_PER_SECOND
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
    const optionalFiniteMetrics = [
      "elapsedSeconds",
      "tilesPerSecond",
      "bytesPerSecond",
    ] as const;
    const rawProgress = value.progress as Record<string, unknown>;
    const effectiveRps = value.progress.effectiveRps;
    const targetRps = value.progress.targetRps;
    const cooldownSeconds = value.progress.cooldownSeconds;
    const expectedTargetRps = request?.requestsPerSecond;
    const networkRequested = value.progress.networkRequested;
    const networkProcessed = value.progress.networkProcessed;
    const resolvedPerSecond = value.progress.resolvedPerSecond;
    const networkTilesPerSecond = value.progress.networkTilesPerSecond;
    const achievedRps = value.progress.achievedRps;
    if (
      (value.progress.requestAttempts !== undefined &&
        !nonNegativeSafeInteger(value.progress.requestAttempts)) ||
      optionalFiniteMetrics.some((key) => {
        const metric = rawProgress[key];
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
          (expectedTargetRps !== undefined &&
            Math.abs(targetRps - expectedTargetRps) >
              RATE_METRIC_TOLERANCE))) ||
      (effectiveRps !== undefined &&
        (typeof effectiveRps !== "number" ||
          !Number.isFinite(effectiveRps) ||
          effectiveRps < 0 ||
          effectiveRps > MAX_REGION_REQUESTS_PER_SECOND ||
          effectiveRps >
            (targetRps ??
              expectedTargetRps ??
              MAX_REGION_REQUESTS_PER_SECOND) +
              RATE_METRIC_TOLERANCE)) ||
      (cooldownSeconds !== undefined &&
        (typeof cooldownSeconds !== "number" ||
          !Number.isFinite(cooldownSeconds) ||
          cooldownSeconds < 0 ||
          cooldownSeconds > MAX_REGION_COOLDOWN_SECONDS)) ||
      (value.progress.cooldownUntil !== undefined &&
        value.progress.cooldownUntil !== null &&
        !canonicalTimestamp(value.progress.cooldownUntil)) ||
      (networkRequested !== undefined &&
        networkRequested !== null &&
        (!nonNegativeSafeInteger(networkRequested) ||
          networkRequested > value.progress.requested)) ||
      (networkProcessed !== undefined &&
        (!nonNegativeSafeInteger(networkProcessed) ||
          networkProcessed > value.progress.processed ||
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
      (typeof value.progress.tilesPerSecond === "number" &&
        typeof resolvedPerSecond === "number" &&
        Math.abs(
          value.progress.tilesPerSecond - resolvedPerSecond,
        ) > RATE_METRIC_TOLERANCE) ||
      (typeof resolvedPerSecond === "number" &&
        typeof networkTilesPerSecond === "number" &&
        networkTilesPerSecond >
          resolvedPerSecond + RATE_METRIC_TOLERANCE) ||
      (typeof achievedRps === "number" &&
        typeof networkTilesPerSecond === "number" &&
        networkTilesPerSecond > achievedRps + RATE_METRIC_TOLERANCE) ||
      (value.progress.etaSeconds !== undefined &&
        value.progress.etaSeconds !== null &&
        (typeof value.progress.etaSeconds !== "number" ||
          !Number.isFinite(value.progress.etaSeconds) ||
          value.progress.etaSeconds < 0))
    ) {
      return undefined;
    }
    const parsedProgress =
      value.progress as unknown as LocalRegionJobProgress;
    progress = {
      requested: parsedProgress.requested,
      processed: parsedProgress.processed,
      complete: parsedProgress.complete,
      absent: parsedProgress.absent,
      failed: parsedProgress.failed,
      reused: parsedProgress.reused,
      reusedAbsent: parsedProgress.reusedAbsent,
      downloadedBytes: parsedProgress.downloadedBytes,
      percent: parsedProgress.percent,
      status: parsedProgress.status,
      ...(parsedProgress.requestAttempts !== undefined
        ? { requestAttempts: parsedProgress.requestAttempts }
        : {}),
      ...(parsedProgress.elapsedSeconds !== undefined
        ? { elapsedSeconds: parsedProgress.elapsedSeconds }
        : {}),
      ...(parsedProgress.tilesPerSecond !== undefined
        ? { tilesPerSecond: parsedProgress.tilesPerSecond }
        : {}),
      ...(parsedProgress.bytesPerSecond !== undefined
        ? { bytesPerSecond: parsedProgress.bytesPerSecond }
        : {}),
      ...(parsedProgress.etaSeconds !== undefined
        ? { etaSeconds: parsedProgress.etaSeconds }
        : {}),
      ...(parsedProgress.effectiveRps !== undefined
        ? { effectiveRps: parsedProgress.effectiveRps }
        : {}),
      ...(parsedProgress.targetRps !== undefined
        ? { targetRps: parsedProgress.targetRps }
        : {}),
      ...(parsedProgress.cooldownSeconds !== undefined
        ? { cooldownSeconds: parsedProgress.cooldownSeconds }
        : {}),
      ...(parsedProgress.cooldownUntil !== undefined
        ? { cooldownUntil: parsedProgress.cooldownUntil }
        : {}),
      ...(parsedProgress.networkRequested !== undefined
        ? { networkRequested: parsedProgress.networkRequested }
        : {}),
      ...(parsedProgress.networkProcessed !== undefined
        ? { networkProcessed: parsedProgress.networkProcessed }
        : {}),
      ...(parsedProgress.resolvedPerSecond !== undefined
        ? { resolvedPerSecond: parsedProgress.resolvedPerSecond }
        : {}),
      ...(parsedProgress.networkTilesPerSecond !== undefined
        ? { networkTilesPerSecond: parsedProgress.networkTilesPerSecond }
        : {}),
      ...(parsedProgress.achievedRps !== undefined
        ? { achievedRps: parsedProgress.achievedRps }
        : {}),
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

function readGlobalDownload(
  value: unknown,
): LocalGlobalDownloadProgress | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !isRecord(value.scope)) return undefined;
  const dimensions = value.scope.dimensions;
  const layers = value.scope.layers;
  const lods = value.scope.lods;
  if (
    typeof value.status !== "string" ||
    !GLOBAL_DOWNLOAD_STATUSES.has(value.status as LocalGlobalDownloadStatus) ||
    !nonNegativeSafeInteger(value.processedRequests) ||
    !nonNegativeSafeInteger(value.plannedRequests) ||
    value.processedRequests > value.plannedRequests ||
    !nonNegativeSafeInteger(value.completeTiles) ||
    !nonNegativeSafeInteger(value.absentTiles) ||
    !nonNegativeSafeInteger(value.corruptTiles) ||
    !nonNegativeSafeInteger(value.failedTiles) ||
    !nonNegativeSafeInteger(value.pendingTiles) ||
    typeof value.progressPercent !== "number" ||
    !Number.isFinite(value.progressPercent) ||
    value.progressPercent < 0 ||
    value.progressPercent > 100 ||
    !(value.dataBytes === null || nonNegativeSafeInteger(value.dataBytes)) ||
    !nullableNumber(value.tilesPerSecond) ||
    (value.tilesPerSecond !== null && value.tilesPerSecond < 0) ||
    !nullableNumber(value.megabytesPerSecond) ||
    (value.megabytesPerSecond !== null &&
      value.megabytesPerSecond < 0) ||
    !nullableNumber(value.etaSeconds) ||
    (value.etaSeconds !== null && value.etaSeconds < 0) ||
    !nullableNumber(value.effectiveRequestsPerSecond) ||
    (value.effectiveRequestsPerSecond !== null &&
      (value.effectiveRequestsPerSecond < 0 ||
        value.effectiveRequestsPerSecond > 16)) ||
    !canonicalTimestamp(value.updatedAt) ||
    typeof value.fallback !== "boolean" ||
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    dimensions.length > 3 ||
    !dimensions.every(
      (dimension) =>
        dimension === "overworld" ||
        dimension === "nether" ||
        dimension === "end",
    ) ||
    new Set(dimensions).size !== dimensions.length ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    layers.length > 3 ||
    !layers.every(
      (layer) =>
        layer === "base" ||
        layer === "overlay" ||
        layer === "newchunks",
    ) ||
    new Set(layers).size !== layers.length ||
    !Array.isArray(lods) ||
    lods.length === 0 ||
    lods.length > 11 ||
    !lods.every(
      (lod) =>
        Number.isSafeInteger(lod) &&
        Number(lod) >= 0 &&
        Number(lod) <= 10,
    ) ||
    new Set(lods).size !== lods.length
  ) {
    return undefined;
  }
  return {
    status: value.status as LocalGlobalDownloadStatus,
    processedRequests: value.processedRequests,
    plannedRequests: value.plannedRequests,
    completeTiles: value.completeTiles,
    absentTiles: value.absentTiles,
    corruptTiles: value.corruptTiles,
    failedTiles: value.failedTiles,
    pendingTiles: value.pendingTiles,
    progressPercent: value.progressPercent,
    dataBytes: value.dataBytes,
    tilesPerSecond: value.tilesPerSecond,
    megabytesPerSecond: value.megabytesPerSecond,
    etaSeconds: value.etaSeconds,
    effectiveRequestsPerSecond: value.effectiveRequestsPerSecond,
    updatedAt: value.updatedAt,
    fallback: value.fallback,
    scope: {
      dimensions:
        dimensions as LocalGlobalDownloadProgress["scope"]["dimensions"],
      layers: layers as LocalGlobalDownloadProgress["scope"]["layers"],
      lods: lods as readonly number[],
    },
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
  const globalDownload = readGlobalDownload(value.globalDownload);
  const persistence = value.persistence;
  if (
    job === undefined ||
    globalDownload === undefined ||
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
    globalDownload,
    job,
  };
}

function readXaeroDimensionSummary(
  value: unknown,
): LocalAtlasXaeroDimensionSummary | null {
  if (!isRecord(value)) return null;
  const fields = [
    "existing",
    "added",
    "updated",
    "unchanged",
    "removed",
    "alreadyAbsent",
    "conflicts",
    "final",
  ] as const;
  if (
    fields.some(
      (field) =>
        typeof value[field] !== "number" ||
        !Number.isSafeInteger(value[field]) ||
        Number(value[field]) < 0,
    )
  ) {
    return null;
  }
  const summary = {
    existing: value.existing as number,
    added: value.added as number,
    updated: value.updated as number,
    unchanged: value.unchanged as number,
    removed: value.removed as number,
    alreadyAbsent: value.alreadyAbsent as number,
    conflicts: value.conflicts as number,
    final: value.final as number,
  };
  if (
    summary.removed > summary.existing ||
    summary.final !== summary.existing + summary.added - summary.removed
  ) {
    return null;
  }
  return summary;
}

export function parseLocalAtlasXaeroPreview(
  value: unknown,
): LocalAtlasXaeroPreview | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.previewId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.previewId) ||
    typeof value.workspaceId !== "string" ||
    !LOCAL_ATLAS_UUID_PATTERN.test(value.workspaceId) ||
    typeof value.workspaceRevision !== "number" ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    value.workspaceRevision < 0 ||
    (value.operation !== "export" && value.operation !== "remove") ||
    (value.scope !== "all" && value.scope !== "exploration") ||
    typeof value.minecraftOpen !== "boolean" ||
    typeof value.canExport !== "boolean" ||
    typeof value.hasChanges !== "boolean"
  ) {
    return null;
  }
  const countFields = [
    "sourceHighlights",
    "exportableHighlights",
    "selectedHighlights",
    "managedHighlights",
    "removableHighlights",
    "skippedAreas",
    "notesNotExported",
    "duplicateNames",
    "conflicts",
  ] as const;
  if (
    countFields.some(
      (field) =>
        typeof value[field] !== "number" ||
        !Number.isSafeInteger(value[field]) ||
        Number(value[field]) < 0,
    )
  ) {
    return null;
  }
  const sourceHighlights = value.sourceHighlights as number;
  const exportableHighlights = value.exportableHighlights as number;
  const selectedHighlights = value.selectedHighlights as number;
  const managedHighlights = value.managedHighlights as number;
  const removableHighlights = value.removableHighlights as number;
  const skippedAreas = value.skippedAreas as number;
  const notesNotExported = value.notesNotExported as number;
  const duplicateNames = value.duplicateNames as number;
  const conflicts = value.conflicts as number;
  const overworld = readXaeroDimensionSummary(value.overworld);
  const nether = readXaeroDimensionSummary(value.nether);
  const operation = value.operation as LocalAtlasXaeroOperation;
  const scope = value.scope as LocalAtlasXaeroScope["kind"];
  const validScopeMetadata =
    scope === "all"
      ? value.explorationId === null && value.regionName === null
      : typeof value.explorationId === "string" &&
        value.explorationId.length > 0 &&
        value.explorationId.length <= 200 &&
        typeof value.regionName === "string" &&
        value.regionName.trim().length > 0 &&
        value.regionName.length <= 200;
  if (
    !overworld ||
    !nether ||
    !validScopeMetadata ||
    conflicts < Math.max(overworld.conflicts, nether.conflicts) ||
    conflicts > overworld.conflicts + nether.conflicts ||
    removableHighlights > managedHighlights ||
    (operation === "export" &&
      (selectedHighlights > sourceHighlights ||
        managedHighlights > selectedHighlights ||
        overworld.removed !== 0 ||
        nether.removed !== 0 ||
        overworld.alreadyAbsent !== 0 ||
        nether.alreadyAbsent !== 0 ||
        overworld.added + overworld.updated + overworld.unchanged !==
          exportableHighlights ||
        nether.added + nether.updated + nether.unchanged !==
          exportableHighlights)) ||
    (operation === "remove" &&
      (overworld.added !== 0 ||
        nether.added !== 0 ||
        overworld.removed > managedHighlights ||
        nether.removed > managedHighlights ||
        overworld.alreadyAbsent > managedHighlights ||
        nether.alreadyAbsent > managedHighlights)) ||
    notesNotExported > sourceHighlights ||
    duplicateNames > sourceHighlights ||
    (value.minecraftOpen && value.canExport) ||
    (!value.hasChanges && value.canExport)
  ) {
    return null;
  }
  return {
    version: 1,
    previewId: value.previewId,
    workspaceId: value.workspaceId,
    workspaceRevision: value.workspaceRevision,
    operation,
    scope,
    explorationId:
      scope === "exploration" ? (value.explorationId as string) : null,
    regionName: scope === "exploration" ? (value.regionName as string) : null,
    minecraftOpen: value.minecraftOpen,
    canExport: value.canExport,
    hasChanges: value.hasChanges,
    sourceHighlights,
    exportableHighlights,
    selectedHighlights,
    managedHighlights,
    removableHighlights,
    skippedAreas,
    notesNotExported,
    duplicateNames,
    conflicts,
    overworld,
    nether,
  };
}

export function parseLocalAtlasXaeroResult(
  value: unknown,
): LocalAtlasXaeroResult | null {
  const preview = parseLocalAtlasXaeroPreview(value);
  if (
    !preview ||
    !isRecord(value) ||
    value.committed !== true ||
    !canonicalTimestamp(value.exportedAt) ||
    typeof value.backupId !== "string" ||
    value.backupId.length < 36 ||
    value.backupId.length > 100
  ) {
    return null;
  }
  return {
    ...preview,
    committed: true,
    exportedAt: value.exportedAt,
    backupId: value.backupId,
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

export async function readLocalAtlasXaeroPreview(
  request: LocalAtlasXaeroRequest = {
    operation: "export",
    scope: { kind: "all" },
  },
  signal?: AbortSignal,
): Promise<LocalAtlasXaeroPreview> {
  const query = new URLSearchParams({
    operation: request.operation,
    scope: request.scope.kind,
  });
  if (request.scope.kind === "exploration") {
    query.set("explorationId", request.scope.explorationId);
  }
  const response = await fetch(
    `/api/local-atlas/xaero-export/preview?${query}`,
    {
      cache: "no-store",
      signal,
    },
  );
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo previsualizar la exportación a Xaero",
    );
  }
  const preview = parseLocalAtlasXaeroPreview(payload);
  if (!preview) {
    throw new Error("El runtime devolvió una previsualización Xaero inválida");
  }
  if (
    response.headers.get("ETag") !==
    `"atlas-${preview.workspaceId}-${preview.workspaceRevision}"`
  ) {
    throw new Error(
      "La previsualización Xaero no coincide con la revisión de LuisA",
    );
  }
  if (
    preview.operation !== request.operation ||
    preview.scope !== request.scope.kind ||
    (request.scope.kind === "exploration" &&
      preview.explorationId !== request.scope.explorationId)
  ) {
    throw new Error(
      "La previsualización Xaero no coincide con el alcance solicitado",
    );
  }
  return preview;
}

export async function applyLocalAtlasXaeroPreview(
  runtime: LocalAtlasRuntime,
  preview: LocalAtlasXaeroPreview,
  signal?: AbortSignal,
): Promise<LocalAtlasXaeroResult> {
  const writeId = crypto.randomUUID();
  const send = () =>
    fetch("/api/local-atlas/xaero-export", {
      method: "POST",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"atlas-${preview.workspaceId}-${preview.workspaceRevision}"`,
        "X-Atlas-Token": runtime.mutationToken,
        "X-Atlas-Write-Id": writeId,
      },
      body: JSON.stringify({
        previewId: preview.previewId,
        operation: preview.operation,
        scope: preview.scope,
        ...(preview.explorationId
          ? { explorationId: preview.explorationId }
          : {}),
      }),
    });
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (signal?.aborted) throw error;
    // A lost HTTP response must not make a second click duplicate waypoints.
    // The server persists this write ID with the committed manifest.
    response = await send();
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : preview.operation === "remove"
          ? "No se pudieron retirar los marcadores Atlas de Xaero"
          : "No se pudo exportar a Xaero",
    );
  }
  const result = parseLocalAtlasXaeroResult(payload);
  if (!result) {
    throw new Error("El runtime devolvió un resultado Xaero inválido");
  }
  if (
    response.headers.get("ETag") !==
    `"atlas-${result.workspaceId}-${result.workspaceRevision}"`
  ) {
    throw new Error("El resultado Xaero no coincide con la revisión de LuisA");
  }
  if (
    result.operation !== preview.operation ||
    result.scope !== preview.scope ||
    result.explorationId !== preview.explorationId
  ) {
    throw new Error(
      "El resultado Xaero no coincide con la operación previsualizada",
    );
  }
  return result;
}

export async function exportLocalAtlasHighlightsToXaero(
  runtime: LocalAtlasRuntime,
  preview: LocalAtlasXaeroPreview,
  signal?: AbortSignal,
): Promise<LocalAtlasXaeroResult> {
  if (preview.operation !== "export") {
    throw new Error("La previsualización no corresponde a una exportación");
  }
  return applyLocalAtlasXaeroPreview(runtime, preview, signal);
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
