const TILE_LAYERS = new Set(["base", "overlay", "newchunks"]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const WORLD_BORDER_BLOCKS = 30_000_000;
const TILE_SIZE_PIXELS = 512;

function errorResponse(message: string) {
  return Response.json(
    { error: message },
    {
      status: 400,
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

export function GET(request: Request) {
  let layer: string;
  let lod: number;
  let dimension: number;
  let tileX: number;
  let tileZ: number;
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
    );
  }

  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Atlas-Tile-Source": "local-miss",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
