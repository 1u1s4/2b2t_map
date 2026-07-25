const TILE_ORIGIN = "https://2b2t.place";
const TILE_LAYERS = new Set(["base", "overlay", "newchunks"]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const UPSTREAM_TIMEOUT_MS = 10_000;
const WORLD_BORDER_BLOCKS = 30_000_000;
const TILE_SIZE_PIXELS = 512;

const TILE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000";
const MISSING_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function errorResponse(message: string, status: 400 | 502) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function readRequiredParam(params: URLSearchParams, name: string) {
  const value = params.get(name);

  if (value === null || value === "") {
    throw new Error(`Missing required query parameter: ${name}`);
  }

  return value;
}

function parseInteger(value: string, name: string) {
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }

  return parsed;
}

function isWebpContentType(value: string | null) {
  return value?.split(";", 1)[0].trim().toLowerCase() === "image/webp";
}

function hasWebpMagic(buffer: ArrayBuffer) {
  if (buffer.byteLength < 12) return false;

  const bytes = new Uint8Array(buffer, 0, 12);
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

export async function GET(request: Request) {
  let layer: string;
  let lod: number;
  let dimension: number;
  let tileX: number;
  let tileZ: number;
  let online: boolean;

  try {
    const params = new URL(request.url).searchParams;
    layer = readRequiredParam(params, "layer");
    lod = parseInteger(readRequiredParam(params, "lod"), "lod");
    dimension = parseInteger(
      readRequiredParam(params, "dimension"),
      "dimension",
    );
    tileX = parseInteger(readRequiredParam(params, "tileX"), "tileX");
    tileZ = parseInteger(readRequiredParam(params, "tileZ"), "tileZ");
    online = params.get("online") === "1";

    if (!TILE_LAYERS.has(layer)) {
      throw new Error("layer must be one of: base, overlay, newchunks");
    }
    if (lod < 0 || lod > 10) {
      throw new Error("lod must be between 0 and 10");
    }
    if (dimension !== 0) {
      throw new Error("dimension must be 0 (Overworld)");
    }

    const maxTileCoordinate =
      Math.ceil(WORLD_BORDER_BLOCKS / (TILE_SIZE_PIXELS * 2 ** lod)) + 1;
    if (
      Math.abs(tileX) > maxTileCoordinate ||
      Math.abs(tileZ) > maxTileCoordinate
    ) {
      throw new Error(
        `tileX and tileZ must be within ±${maxTileCoordinate} at lod ${lod}`,
      );
    }
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid query parameters",
      400,
    );
  }

  if (!online) {
    return new Response(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Atlas-Tile-Source": "local-miss",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const shardX = Math.trunc(tileX / 32);
  const shardZ = Math.trunc(tileZ / 32);
  const upstreamUrl =
    `${TILE_ORIGIN}/tiles/${layer}/${lod}/${dimension}/` +
    `${shardX}/${shardZ}/t.${tileX}.${tileZ}.webp`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort("2b2t.place tile request timed out"),
    UPSTREAM_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "image/webp,image/*;q=0.8,*/*;q=0.5",
        "User-Agent":
          "2b2t-map-viewer/1.0 (read-only Overworld tile proxy)",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (upstream.status === 404) {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, {
        status: 404,
        headers: {
          "Cache-Control": MISSING_CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(
        `The 2b2t.place tile service returned HTTP ${upstream.status}`,
        502,
      );
    }

    if (!isWebpContentType(upstream.headers.get("Content-Type"))) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(
        "The 2b2t.place tile service returned a non-WebP content type",
        502,
      );
    }

    const body = await upstream.arrayBuffer();
    if (!hasWebpMagic(body)) {
      return errorResponse(
        "The 2b2t.place tile service returned an invalid WebP payload",
        502,
      );
    }

    const headers = new Headers({
      "Cache-Control": TILE_CACHE_CONTROL,
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
    });

    const etag = upstream.headers.get("ETag");
    const lastModified = upstream.headers.get("Last-Modified");
    if (etag) headers.set("ETag", etag);
    if (lastModified) headers.set("Last-Modified", lastModified);

    return new Response(body, {
      status: upstream.status,
      headers,
    });
  } catch {
    return errorResponse(
      controller.signal.aborted
        ? "The 2b2t.place tile service timed out"
        : "Unable to reach the 2b2t.place tile service",
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
