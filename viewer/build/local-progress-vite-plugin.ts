import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Plugin } from "vite";

const MAX_PROGRESS_FILE_BYTES = 1_000_000;
const MAX_REASON_LENGTH = 2_000;
const ENDPOINT = "/api/local-progress";
const STRING_FIELDS = ["status", "updated_at", "progress_kind"] as const;
const NUMBER_FIELDS = [
  "tiles_completed",
  "tiles_pending",
  "tiles_absent",
  "tiles_corrupt",
  "tiles_failed",
  "planned_requests",
  "processed_requests",
  "remaining_requests",
  "progress_percent",
  "tiles_per_second",
  "megabytes_per_second",
  "data_downloaded_bytes",
  "space_used_bytes",
  "eta_seconds",
  "effective_requests_per_second",
] as const;

type MiddlewareNext = (error?: unknown) => void;

export interface LocalProgressOptions {
  readonly progressFile?: string;
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (
    normalized.length > MAX_REASON_LENGTH ||
    /(?:\/Users\/|\/Volumes\/|\/private\/|[A-Za-z]:\\|resume_command|--out\b)/i.test(
      normalized,
    )
  ) {
    return "El descargador reportó un problema; revisa download.log para ver el detalle local.";
  }
  return normalized;
}

/**
 * Keep machine paths and resume commands out of the browser response. The
 * browser only receives values consumed by DownloadProgressSnapshot.
 */
export function projectProgressPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("progress.json debe contener un objeto JSON");
  }

  const projected: Record<string, unknown> = {};
  for (const field of STRING_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue === "string") projected[field] = fieldValue;
  }
  for (const field of NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      projected[field] = fieldValue;
    }
  }

  const reason = projectReason(value.reason);
  if (reason) projected.reason = reason;

  if (isRecord(value.http_errors)) {
    const httpErrors = Object.fromEntries(
      Object.entries(value.http_errors).filter(
        ([code, count]) =>
          /^[1-5]\d{2}$/.test(code) &&
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0,
      ),
    );
    projected.http_errors = httpErrors;
  }

  return projected;
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

export function isLocalProgressPath(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, "http://localhost").pathname === ENDPOINT;
  } catch {
    return false;
  }
}

function createMiddleware(progressPath: string) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: MiddlewareNext,
  ) => {
    if (!isLocalProgressPath(request.url)) {
      next();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    if (
      !isLoopbackAddress(request.socket.remoteAddress) ||
      !isLoopbackHost(request.headers.host)
    ) {
      writeJson(response, 403, { error: "Disponible solo desde localhost" });
      return;
    }

    try {
      const metadata = await stat(progressPath);
      if (!metadata.isFile()) {
        writeJson(response, 404, { error: "progress.json no existe" });
        return;
      }
      if (metadata.size > MAX_PROGRESS_FILE_BYTES) {
        writeJson(response, 413, {
          error: "progress.json supera el tamaño máximo permitido",
        });
        return;
      }

      const source = await readFile(progressPath);
      if (source.byteLength > MAX_PROGRESS_FILE_BYTES) {
        writeJson(response, 413, {
          error: "progress.json supera el tamaño máximo permitido",
        });
        return;
      }

      let projected: Record<string, unknown>;
      try {
        projected = projectProgressPayload(
          JSON.parse(source.toString("utf8")) as unknown,
        );
      } catch {
        writeJson(response, 503, {
          error: "progress.json no contiene datos válidos",
        });
        return;
      }

      const body = Buffer.from(JSON.stringify(projected));
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader(
        "Content-Type",
        "application/json; charset=utf-8",
      );
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader("Content-Length", String(body.byteLength));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        writeJson(response, 404, {
          error: "La descarga todavía no ha creado progress.json",
        });
        return;
      }
      writeJson(response, 503, {
        error: "No se pudo leer el progreso local",
      });
    }
  };
}

/**
 * Exposes exactly one operator-selected progress.json during local Vite
 * development. It is never included in the deployed Worker runtime.
 */
export function localProgress(options: LocalProgressOptions = {}): Plugin {
  return {
    name: "obsidian-atlas-local-progress",
    apply: "serve",
    configureServer(server) {
      const configuredPath = options.progressFile?.trim();
      if (!configuredPath) return;

      const progressPath = resolve(configuredPath);
      if (basename(progressPath) !== "progress.json") {
        throw new Error(
          "OBSIDIAN_ATLAS_PROGRESS_FILE debe apuntar exactamente a progress.json",
        );
      }

      server.middlewares.use(createMiddleware(progressPath));
    },
  };
}
