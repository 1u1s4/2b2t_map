import type { WorldBounds } from "./exploration-grid";

export type LocalJobStatus =
  | "running"
  | "stopping"
  | "complete"
  | "stopped"
  | "error";

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
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly message: string;
}

export interface LocalAtlasRuntime {
  readonly localOnly: true;
  readonly mutationToken: string;
  readonly capacity: LocalCapacitySnapshot;
  readonly job: LocalRegionJob | null;
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
  return {
    id: value.id,
    status: value.status as LocalJobStatus,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    exitCode: value.exitCode,
    message: value.message,
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
    job,
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

export async function downloadExplorationCell(
  runtime: LocalAtlasRuntime,
  bounds: WorldBounds,
  lod: number,
  layers: readonly ("base" | "overlay" | "newchunks")[],
  requestsPerSecond: number,
): Promise<void> {
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
      lod,
      layers,
      requestsPerSecond,
    }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    throw new Error(
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No se pudo iniciar la descarga regional",
    );
  }
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
