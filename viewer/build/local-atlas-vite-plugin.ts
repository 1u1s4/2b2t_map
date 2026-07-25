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
import { basename, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Plugin } from "vite";

const STATUS_ENDPOINT = "/api/local-atlas/status";
const DOWNLOAD_ENDPOINT = "/api/local-atlas/download";
const STOP_ENDPOINT = "/api/local-atlas/stop";
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
  readonly lod: number;
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

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end();
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
  const lod = safeInteger(value.lod, "lod", 0, 10);
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

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw new TypeError("Content-Type debe ser application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
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
    online: parsed.searchParams.get("online") === "1",
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

function createMiddleware(options: LocalAtlasOptions) {
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

  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: MiddlewareNext,
  ) => {
    const path = requestPath(request);
    if (
      path !== STATUS_ENDPOINT &&
      path !== DOWNLOAD_ENDPOINT &&
      path !== STOP_ENDPOINT &&
      path !== TILE_ENDPOINT
    ) {
      next();
      return;
    }

    if (!requireLocalRequest(request, response)) return;

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
      if (!parsedTile.online) {
        writeEmpty(response, 404);
        return;
      }
      next();
      return;
    }

    if (path === STATUS_ENDPOINT && request.method === "GET") {
      writeJson(response, 200, {
        localOnly: true,
        mutationToken,
        capacity: await readCapacity(
          tileRoot,
          backingRoot,
          requirementBytes,
        ),
        job: publicJob(state.job),
      });
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
      if (state.stopTimer) clearTimeout(state.stopTimer);
      if (state.child) state.child.kill("SIGINT");
    },
  };
}

/**
 * Local-only Vite bridge for disk capacity, bounded regional downloads, and
 * local-first tile reads. It never accepts paths or commands from the browser.
 */
export function localAtlas(options: LocalAtlasOptions = {}): Plugin {
  let close: (() => void) | null = null;
  return {
    name: "obsidian-atlas-local-runtime",
    apply: "serve",
    configureServer(server) {
      const runtime = createMiddleware(options);
      close = runtime.close;
      server.middlewares.use(runtime.middleware);
      server.httpServer?.once("close", runtime.close);
    },
    closeBundle() {
      close?.();
    },
  };
}
