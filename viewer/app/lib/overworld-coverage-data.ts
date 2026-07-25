/**
 * Exact row-run mask for locally archived Overworld `base` tiles at LOD 3.
 *
 * This compact representation was derived from:
 *
 *   2b2t_tiles/tiles.sqlite3
 *   SHA-256 8891d3f5e9e38c1b06489a9d1f4557701d4299e07a0f3e0f8abaa14ff6593e1f
 *
 * with the immutable/read-only query:
 *
 *   SELECT tile_z, tile_x
 *   FROM tiles
 *   WHERE dimension='overworld' AND layer='base'
 *     AND lod=3 AND status='complete'
 *   ORDER BY tile_z, tile_x;
 *
 * The catalog completed this selected archive at
 * 2026-07-24T20:27:11.719325+00:00. There are exactly 66,464 available
 * LOD-3 tiles. Bounds and runs are half-open.
 */

export const OVERWORLD_MASK_LOD = 3 as const;
export const OVERWORLD_MASK_TILE_BLOCKS = 4_096 as const;
export const OVERWORLD_MASK_AVAILABLE_TILE_COUNT = 66_464 as const;
export const OVERWORLD_MASK_DATABASE_SHA256 =
  "8891d3f5e9e38c1b06489a9d1f4557701d4299e07a0f3e0f8abaa14ff6593e1f" as const;
export const OVERWORLD_MASK_CATALOG_UPDATED_AT =
  "2026-07-24T20:27:11.719325+00:00" as const;

export type TileXRun = readonly [
  minTileX: number,
  maxTileXExclusive: number,
];

export interface TileZRunBand {
  readonly minTileZ: number;
  readonly maxTileZExclusive: number;
  readonly xRuns: readonly TileXRun[];
}

/**
 * Bands are disjoint, sorted by Z and cover every complete LOD-3 base tile
 * exactly once. A band may contain multiple X runs when the published
 * footprint has an interior gap.
 */
export const OVERWORLD_LOD3_AVAILABLE_BANDS: readonly TileZRunBand[] =
  Object.freeze([
    Object.freeze({
      minTileZ: -132,
      maxTileZExclusive: -130,
      xRuns: Object.freeze([Object.freeze([-130, -124] as const)]),
    }),
    Object.freeze({
      minTileZ: -130,
      maxTileZExclusive: -129,
      xRuns: Object.freeze([
        Object.freeze([-130, 4] as const),
        Object.freeze([37, 68] as const),
      ]),
    }),
    Object.freeze({
      minTileZ: -129,
      maxTileZExclusive: -124,
      xRuns: Object.freeze([Object.freeze([-130, 132] as const)]),
    }),
    Object.freeze({
      minTileZ: -124,
      maxTileZExclusive: -63,
      xRuns: Object.freeze([Object.freeze([-130, 125] as const)]),
    }),
    Object.freeze({
      minTileZ: -63,
      maxTileZExclusive: 124,
      xRuns: Object.freeze([Object.freeze([-130, 126] as const)]),
    }),
    Object.freeze({
      minTileZ: 124,
      maxTileZExclusive: 129,
      xRuns: Object.freeze([Object.freeze([-132, 126] as const)]),
    }),
    Object.freeze({
      minTileZ: 129,
      maxTileZExclusive: 130,
      xRuns: Object.freeze([Object.freeze([-68, 126] as const)]),
    }),
    Object.freeze({
      minTileZ: 130,
      maxTileZExclusive: 131,
      xRuns: Object.freeze([Object.freeze([60, 126] as const)]),
    }),
  ]);

export function isObservedLod3TileAvailable(
  tileX: number,
  tileZ: number,
): boolean {
  if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileZ)) {
    return false;
  }
  for (const band of OVERWORLD_LOD3_AVAILABLE_BANDS) {
    if (tileZ < band.minTileZ) return false;
    if (tileZ >= band.maxTileZExclusive) continue;
    return band.xRuns.some(
      ([minTileX, maxTileXExclusive]) =>
        tileX >= minTileX && tileX < maxTileXExclusive,
    );
  }
  return false;
}

export function countObservedLod3Tiles(): number {
  let count = 0;
  for (const band of OVERWORLD_LOD3_AVAILABLE_BANDS) {
    const rows = band.maxTileZExclusive - band.minTileZ;
    for (const [minTileX, maxTileXExclusive] of band.xRuns) {
      count += rows * (maxTileXExclusive - minTileX);
    }
  }
  return count;
}
