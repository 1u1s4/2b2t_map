const MAX_PROGRESS_FILE_BYTES = 1_000_000;
const MAX_REASON_LENGTH = 2_000;
const MAX_STATUS_LENGTH = 64;

export type ProgressPercentSource =
  | "reported"
  | "derived"
  | "completed"
  | null;

export interface DownloadProgressHttpError {
  readonly code: string;
  readonly count: number;
}

export interface DownloadProgressSnapshot {
  readonly status: string;
  readonly updatedAt: string | null;
  readonly updatedAtTimestamp: number | null;
  readonly tilesCompleted: number;
  readonly tilesPending: number;
  readonly tilesAbsent: number;
  readonly tilesCorrupt: number;
  readonly tilesFailed: number;
  readonly plannedRequests: number | null;
  readonly processedRequests: number;
  readonly remainingRequests: number;
  readonly progressPercent: number | null;
  readonly progressPercentSource: ProgressPercentSource;
  readonly progressKind: string | null;
  readonly tilesPerSecond: number | null;
  readonly megabytesPerSecond: number | null;
  readonly downloadedBytes: number | null;
  readonly etaSeconds: number | null;
  readonly effectiveRequestsPerSecond: number | null;
  readonly reason: string | null;
  readonly httpErrors: readonly DownloadProgressHttpError[];
}

export type DownloadProgressReadResult =
  | {
      readonly kind: "ready";
      readonly progress: DownloadProgressSnapshot;
    }
  | {
      readonly kind: "missing";
      readonly message: string;
    }
  | {
      readonly kind: "invalid";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const numeric = finiteNonNegative(value);
  return numeric !== null && Number.isSafeInteger(numeric) ? numeric : null;
}

function readCount(record: Record<string, unknown>, key: string): number {
  return nonNegativeInteger(record[key]) ?? 0;
}

function readShortString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) return null;
  return normalized;
}

function readUpdatedAt(value: unknown): {
  updatedAt: string | null;
  updatedAtTimestamp: number | null;
} {
  const updatedAt = readShortString(value, 100);
  if (updatedAt === null) {
    return { updatedAt: null, updatedAtTimestamp: null };
  }
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return { updatedAt: null, updatedAtTimestamp: null };
  }
  return { updatedAt, updatedAtTimestamp: timestamp };
}

function readHttpErrors(value: unknown): DownloadProgressHttpError[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .flatMap(([code, count]) => {
      const normalizedCount = nonNegativeInteger(count);
      if (!/^[1-5]\d{2}$/.test(code) || normalizedCount === null) return [];
      return [{ code, count: normalizedCount }];
    })
    .sort((left, right) => Number(left.code) - Number(right.code));
}

function isFinishedStatus(status: string): boolean {
  return (
    status === "complete" ||
    status === "fallback_complete" ||
    status === "smoke_test_complete"
  );
}

/**
 * Convert the downloader's intentionally small JSON payload into a stable UI
 * model. Invalid optional fields are ignored instead of poisoning the whole
 * snapshot; a non-object payload is rejected.
 */
export function parseDownloadProgress(
  value: unknown,
): DownloadProgressSnapshot {
  if (!isRecord(value)) {
    throw new TypeError("progress.json debe contener un objeto JSON");
  }

  const status =
    readShortString(value.status, MAX_STATUS_LENGTH)?.toLowerCase() ?? "unknown";
  const tilesCompleted = readCount(value, "tiles_completed");
  const tilesPending = readCount(value, "tiles_pending");
  const tilesAbsent = readCount(value, "tiles_absent");
  const tilesCorrupt = readCount(value, "tiles_corrupt");
  const tilesFailed = readCount(value, "tiles_failed");
  const resolvedFromCounts = [
    tilesCompleted,
    tilesAbsent,
    tilesCorrupt,
    tilesFailed,
  ].reduce(
    (total, count) => Math.min(Number.MAX_SAFE_INTEGER, total + count),
    0,
  );

  const reportedProcessed = nonNegativeInteger(value.processed_requests);
  const processedRequests = reportedProcessed ?? resolvedFromCounts;
  const reportedPlanned = nonNegativeInteger(value.planned_requests);
  const plannedRequests =
    reportedPlanned !== null && reportedPlanned > 0
      ? reportedPlanned
      : tilesPending > 0
        ? Math.max(1, processedRequests + tilesPending)
        : isFinishedStatus(status) && processedRequests > 0
          ? processedRequests
          : null;
  const remainingRequests =
    nonNegativeInteger(value.remaining_requests) ??
    (plannedRequests === null
      ? tilesPending
      : Math.max(0, plannedRequests - processedRequests));

  const reportedPercent = finiteNonNegative(value.progress_percent);
  let progressPercent: number | null = null;
  let progressPercentSource: ProgressPercentSource = null;
  if (reportedPercent !== null && reportedPercent <= 100) {
    progressPercent = reportedPercent;
    progressPercentSource = "reported";
  } else if (plannedRequests !== null) {
    progressPercent = Math.min(
      100,
      (processedRequests / plannedRequests) * 100,
    );
    progressPercentSource = "derived";
  } else if (isFinishedStatus(status)) {
    progressPercent = 100;
    progressPercentSource = "completed";
  }

  const { updatedAt, updatedAtTimestamp } = readUpdatedAt(value.updated_at);
  const dataDownloadedBytes = finiteNonNegative(value.data_downloaded_bytes);
  const spaceUsedBytes = finiteNonNegative(value.space_used_bytes);

  return Object.freeze({
    status,
    updatedAt,
    updatedAtTimestamp,
    tilesCompleted,
    tilesPending,
    tilesAbsent,
    tilesCorrupt,
    tilesFailed,
    plannedRequests,
    processedRequests,
    remainingRequests,
    progressPercent,
    progressPercentSource,
    progressKind: readShortString(value.progress_kind, 64)?.toLowerCase() ?? null,
    tilesPerSecond: finiteNonNegative(value.tiles_per_second),
    megabytesPerSecond: finiteNonNegative(value.megabytes_per_second),
    downloadedBytes: dataDownloadedBytes ?? spaceUsedBytes,
    etaSeconds: finiteNonNegative(value.eta_seconds),
    effectiveRequestsPerSecond: finiteNonNegative(
      value.effective_requests_per_second,
    ),
    reason: readShortString(value.reason, MAX_REASON_LENGTH),
    httpErrors: Object.freeze(readHttpErrors(value.http_errors)),
  });
}

function errorName(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { readonly name?: unknown }).name === "string"
  ) {
    return (error as { readonly name: string }).name;
  }
  return null;
}

/**
 * Read a fresh File on every poll. This is important because the downloader
 * atomically replaces progress.json instead of mutating one open file.
 */
export async function readDownloadProgress(
  directory: Pick<FileSystemDirectoryHandle, "getFileHandle">,
): Promise<DownloadProgressReadResult> {
  try {
    const handle = await directory.getFileHandle("progress.json", {
      create: false,
    });
    const file = await handle.getFile();
    if (file.size > MAX_PROGRESS_FILE_BYTES) {
      return {
        kind: "invalid",
        message: "progress.json supera el tamaño máximo permitido",
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text()) as unknown;
    } catch {
      return {
        kind: "invalid",
        message: "progress.json no contiene JSON válido",
      };
    }

    try {
      return { kind: "ready", progress: parseDownloadProgress(parsed) };
    } catch (error) {
      return {
        kind: "invalid",
        message:
          error instanceof Error
            ? error.message
            : "progress.json tiene un formato incompatible",
      };
    }
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFoundError") {
      return {
        kind: "missing",
        message: "La descarga todavía no ha creado progress.json",
      };
    }
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        kind: "unavailable",
        message: "Chrome retiró el permiso para leer el progreso",
      };
    }
    return {
      kind: "unavailable",
      message: "No se pudo leer progress.json; el mapa seguirá funcionando",
    };
  }
}
