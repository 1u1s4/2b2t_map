import type { WorldBounds } from "./exploration-grid.ts";
import {
  OVERWORLD_LOD3_AVAILABLE_BANDS,
  OVERWORLD_MASK_AVAILABLE_TILE_COUNT,
  OVERWORLD_MASK_TILE_BLOCKS,
  countObservedLod3Tiles,
  isObservedLod3TileAvailable,
} from "./overworld-coverage-data.ts";

/**
 * UX overview of the exact archived LOD-3 footprint.
 *
 * The 33 × 33 grid is an aggregation layer, not a claim that its rectangular
 * envelope is fully published. Every overview sector covers 8 × 8 LOD-3
 * source tiles and reports how many of those 64 tiles really exist.
 */
export const OVERWORLD_COVERAGE_VERSION = 1 as const;
export const OVERWORLD_COVERAGE_ID =
  "2b2t-place-overworld-2026-07-24-lod3" as const;
export const OVERWORLD_OVERVIEW_CELL_BLOCKS = 32_768;
export const OVERWORLD_OVERVIEW_COLUMNS = 33;
export const OVERWORLD_OVERVIEW_ROWS = 33;
export const OVERWORLD_OVERVIEW_CELL_COUNT =
  OVERWORLD_OVERVIEW_COLUMNS * OVERWORLD_OVERVIEW_ROWS;
export const OVERWORLD_OVERVIEW_TILES_PER_SIDE =
  OVERWORLD_OVERVIEW_CELL_BLOCKS / OVERWORLD_MASK_TILE_BLOCKS;
export const OVERWORLD_OVERVIEW_TILE_COUNT =
  OVERWORLD_OVERVIEW_TILES_PER_SIDE ** 2;

/**
 * Rectangle needed to lay out all 33 × 33 UX sectors. It includes gaps and a
 * final empty 4,096-block strip on the positive-Z edge; use cell coverage
 * metadata rather than interpreting this rectangle as available map data.
 */
export const OVERWORLD_OVERVIEW_GRID_BOUNDS: WorldBounds = Object.freeze({
  minX: -540_672,
  minZ: -540_672,
  maxXExclusive: 540_672,
  maxZExclusive: 540_672,
});

/** Bounding box of complete local LOD-3 base tiles, not a filled rectangle. */
export const OVERWORLD_OBSERVED_DATA_BOUNDS: WorldBounds = Object.freeze({
  minX: -540_672,
  minZ: -540_672,
  maxXExclusive: 540_672,
  maxZExclusive: 536_576,
});

/** Official 1,024,000² release core recorded in discovery.json. */
export const OVERWORLD_COMPLETE_CORE_BOUNDS: WorldBounds = Object.freeze({
  minX: -512_000,
  minZ: -512_000,
  maxXExclusive: 512_000,
  maxZExclusive: 512_000,
});

export type OverworldCoverageStatus = "empty" | "partial" | "full";

export interface OverworldOverviewCell {
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly id: string;
  readonly bounds: WorldBounds;
  readonly coverageStatus: OverworldCoverageStatus;
  /** Complete local base tiles at LOD 3 inside this sector. */
  readonly availableTileCount: number;
  /** Always 64 for the current 8 × 8 aggregation. */
  readonly tileCount: number;
}

export interface OverworldCoverageSelection {
  readonly version: typeof OVERWORLD_COVERAGE_VERSION;
  readonly coverageId: typeof OVERWORLD_COVERAGE_ID;
  readonly minRow: number;
  readonly minColumn: number;
  readonly maxRowExclusive: number;
  readonly maxColumnExclusive: number;
  readonly rows: number;
  readonly columns: number;
  readonly cellCount: number;
  /** Sectors containing at least one complete local LOD-3 tile. */
  readonly availableCellCount: number;
  readonly partialCellCount: number;
  readonly fullCellCount: number;
  readonly emptyCellCount: number;
  readonly availableTileCount: number;
  readonly tileCount: number;
  readonly bounds: WorldBounds;
}

export class OverworldCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverworldCoverageError";
  }
}

function fail(message: string): never {
  throw new OverworldCoverageError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteBounds(value: unknown): value is WorldBounds {
  if (!isRecord(value)) return false;
  return (
    typeof value.minX === "number" &&
    Number.isFinite(value.minX) &&
    typeof value.minZ === "number" &&
    Number.isFinite(value.minZ) &&
    typeof value.maxXExclusive === "number" &&
    Number.isFinite(value.maxXExclusive) &&
    typeof value.maxZExclusive === "number" &&
    Number.isFinite(value.maxZExclusive) &&
    value.minX < value.maxXExclusive &&
    value.minZ < value.maxZExclusive
  );
}

function assertOverviewIndex(index: number): void {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= OVERWORLD_OVERVIEW_CELL_COUNT
  ) {
    fail(`Índice global fuera de rango: ${String(index)}`);
  }
}

function assertOverviewCoordinate(
  value: number,
  maximumExclusive: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= maximumExclusive
  ) {
    fail(`${label} global fuera de rango`);
  }
}

function coverageStatusForCount(count: number): OverworldCoverageStatus {
  if (count === 0) return "empty";
  return count === OVERWORLD_OVERVIEW_TILE_COUNT ? "full" : "partial";
}

function countAvailableTilesInSector(row: number, column: number): number {
  const minTileX =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minX / OVERWORLD_MASK_TILE_BLOCKS +
    column * OVERWORLD_OVERVIEW_TILES_PER_SIDE;
  const minTileZ =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ / OVERWORLD_MASK_TILE_BLOCKS +
    row * OVERWORLD_OVERVIEW_TILES_PER_SIDE;
  let count = 0;
  for (
    let tileZ = minTileZ;
    tileZ < minTileZ + OVERWORLD_OVERVIEW_TILES_PER_SIDE;
    tileZ += 1
  ) {
    for (
      let tileX = minTileX;
      tileX < minTileX + OVERWORLD_OVERVIEW_TILES_PER_SIDE;
      tileX += 1
    ) {
      if (isObservedLod3TileAvailable(tileX, tileZ)) count += 1;
    }
  }
  return count;
}

const AVAILABLE_TILES_BY_OVERVIEW_CELL = Object.freeze(
  Array.from({ length: OVERWORLD_OVERVIEW_CELL_COUNT }, (_, index) => {
    const row = Math.floor(index / OVERWORLD_OVERVIEW_COLUMNS);
    const column = index % OVERWORLD_OVERVIEW_COLUMNS;
    return countAvailableTilesInSector(row, column);
  }),
);

const aggregatedAvailableTiles = AVAILABLE_TILES_BY_OVERVIEW_CELL.reduce(
  (total, count) => total + count,
  0,
);
if (
  countObservedLod3Tiles() !== OVERWORLD_MASK_AVAILABLE_TILE_COUNT ||
  aggregatedAvailableTiles !== OVERWORLD_MASK_AVAILABLE_TILE_COUNT
) {
  throw new Error("La máscara local del Overworld no supera su control de integridad");
}

export function overviewCellForIndex(index: number): OverworldOverviewCell {
  assertOverviewIndex(index);
  return overviewCellAt(
    Math.floor(index / OVERWORLD_OVERVIEW_COLUMNS),
    index % OVERWORLD_OVERVIEW_COLUMNS,
  );
}

export function overviewCellAt(
  row: number,
  column: number,
): OverworldOverviewCell {
  assertOverviewCoordinate(row, OVERWORLD_OVERVIEW_ROWS, "Fila");
  assertOverviewCoordinate(column, OVERWORLD_OVERVIEW_COLUMNS, "Columna");
  const index = row * OVERWORLD_OVERVIEW_COLUMNS + column;
  const minX =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minX +
    column * OVERWORLD_OVERVIEW_CELL_BLOCKS;
  const minZ =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ +
    row * OVERWORLD_OVERVIEW_CELL_BLOCKS;
  const availableTileCount = AVAILABLE_TILES_BY_OVERVIEW_CELL[index];

  return Object.freeze({
    index,
    row,
    column,
    id: `ow-r${String(row + 1).padStart(2, "0")}-c${String(column + 1).padStart(2, "0")}`,
    bounds: Object.freeze({
      minX,
      minZ,
      maxXExclusive: minX + OVERWORLD_OVERVIEW_CELL_BLOCKS,
      maxZExclusive: minZ + OVERWORLD_OVERVIEW_CELL_BLOCKS,
    }),
    coverageStatus: coverageStatusForCount(availableTileCount),
    availableTileCount,
    tileCount: OVERWORLD_OVERVIEW_TILE_COUNT,
  });
}

/**
 * Resolve a point to its UX sector. Partial sectors remain selectable because
 * the sector itself contains archived data even when the exact pointer falls
 * over one of its gaps.
 */
export function overviewCellAtWorld(
  x: number,
  z: number,
): OverworldOverviewCell | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    x < OVERWORLD_OVERVIEW_GRID_BOUNDS.minX ||
    x >= OVERWORLD_OVERVIEW_GRID_BOUNDS.maxXExclusive ||
    z < OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ ||
    z >= OVERWORLD_OVERVIEW_GRID_BOUNDS.maxZExclusive
  ) {
    return null;
  }
  const column = Math.floor(
    (x - OVERWORLD_OVERVIEW_GRID_BOUNDS.minX) /
      OVERWORLD_OVERVIEW_CELL_BLOCKS,
  );
  const row = Math.floor(
    (z - OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ) /
      OVERWORLD_OVERVIEW_CELL_BLOCKS,
  );
  const cell = overviewCellAt(row, column);
  return cell.coverageStatus === "empty" ? null : cell;
}

export function createCoverageSelection(
  minRow: number,
  minColumn: number,
  maxRowExclusive: number,
  maxColumnExclusive: number,
): OverworldCoverageSelection {
  if (
    !Number.isSafeInteger(minRow) ||
    !Number.isSafeInteger(minColumn) ||
    !Number.isSafeInteger(maxRowExclusive) ||
    !Number.isSafeInteger(maxColumnExclusive) ||
    minRow < 0 ||
    minColumn < 0 ||
    maxRowExclusive > OVERWORLD_OVERVIEW_ROWS ||
    maxColumnExclusive > OVERWORLD_OVERVIEW_COLUMNS ||
    minRow >= maxRowExclusive ||
    minColumn >= maxColumnExclusive
  ) {
    fail("La selección global no forma un rectángulo válido");
  }

  let availableCellCount = 0;
  let partialCellCount = 0;
  let fullCellCount = 0;
  let availableTileCount = 0;
  for (let row = minRow; row < maxRowExclusive; row += 1) {
    for (let column = minColumn; column < maxColumnExclusive; column += 1) {
      const cell = overviewCellAt(row, column);
      availableTileCount += cell.availableTileCount;
      if (cell.coverageStatus === "empty") continue;
      availableCellCount += 1;
      if (cell.coverageStatus === "full") {
        fullCellCount += 1;
      } else {
        partialCellCount += 1;
      }
    }
  }
  if (availableCellCount === 0) {
    fail("La selección no intersecta datos disponibles del Overworld");
  }

  const rows = maxRowExclusive - minRow;
  const columns = maxColumnExclusive - minColumn;
  const cellCount = rows * columns;
  return Object.freeze({
    version: OVERWORLD_COVERAGE_VERSION,
    coverageId: OVERWORLD_COVERAGE_ID,
    minRow,
    minColumn,
    maxRowExclusive,
    maxColumnExclusive,
    rows,
    columns,
    cellCount,
    availableCellCount,
    partialCellCount,
    fullCellCount,
    emptyCellCount: cellCount - availableCellCount,
    availableTileCount,
    tileCount: cellCount * OVERWORLD_OVERVIEW_TILE_COUNT,
    bounds: Object.freeze({
      minX:
        OVERWORLD_OVERVIEW_GRID_BOUNDS.minX +
        minColumn * OVERWORLD_OVERVIEW_CELL_BLOCKS,
      minZ:
        OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ +
        minRow * OVERWORLD_OVERVIEW_CELL_BLOCKS,
      maxXExclusive:
        OVERWORLD_OVERVIEW_GRID_BOUNDS.minX +
        maxColumnExclusive * OVERWORLD_OVERVIEW_CELL_BLOCKS,
      maxZExclusive:
        OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ +
        maxRowExclusive * OVERWORLD_OVERVIEW_CELL_BLOCKS,
    }),
  });
}

/**
 * Converts the Atlas cell in focus into the single-sector selection used by
 * downloads and exploration. Empty overview cells deliberately clear the
 * operational selection instead of leaving an older region active.
 */
export function coverageSelectionForOverviewCellIndex(
  index: number,
): OverworldCoverageSelection | null {
  const cell = overviewCellForIndex(index);
  if (cell.coverageStatus === "empty") return null;
  return createCoverageSelection(
    cell.row,
    cell.column,
    cell.row + 1,
    cell.column + 1,
  );
}

export function coverageSelectionBetweenCells(
  first: Pick<OverworldOverviewCell, "row" | "column">,
  second: Pick<OverworldOverviewCell, "row" | "column">,
): OverworldCoverageSelection {
  return createCoverageSelection(
    Math.min(first.row, second.row),
    Math.min(first.column, second.column),
    Math.max(first.row, second.row) + 1,
    Math.max(first.column, second.column) + 1,
  );
}

/**
 * Snap arbitrary half-open bounds outward to overview sectors. Input outside
 * the 33 × 33 layout is clamped; a rectangle with no available sector fails.
 */
export function coverageSelectionForWorldBounds(
  bounds: WorldBounds,
): OverworldCoverageSelection {
  if (!isFiniteBounds(bounds)) {
    fail("Los límites globales no son válidos");
  }
  const minX = Math.max(bounds.minX, OVERWORLD_OVERVIEW_GRID_BOUNDS.minX);
  const minZ = Math.max(bounds.minZ, OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ);
  const maxXExclusive = Math.min(
    bounds.maxXExclusive,
    OVERWORLD_OVERVIEW_GRID_BOUNDS.maxXExclusive,
  );
  const maxZExclusive = Math.min(
    bounds.maxZExclusive,
    OVERWORLD_OVERVIEW_GRID_BOUNDS.maxZExclusive,
  );
  if (minX >= maxXExclusive || minZ >= maxZExclusive) {
    fail("La selección no intersecta la rejilla observada del Overworld");
  }
  const minColumn = Math.floor(
    (minX - OVERWORLD_OVERVIEW_GRID_BOUNDS.minX) /
      OVERWORLD_OVERVIEW_CELL_BLOCKS,
  );
  const minRow = Math.floor(
    (minZ - OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ) /
      OVERWORLD_OVERVIEW_CELL_BLOCKS,
  );
  const maxColumnExclusive =
    Math.floor(
      (maxXExclusive - 1 - OVERWORLD_OVERVIEW_GRID_BOUNDS.minX) /
        OVERWORLD_OVERVIEW_CELL_BLOCKS,
    ) + 1;
  const maxRowExclusive =
    Math.floor(
      (maxZExclusive - 1 - OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ) /
        OVERWORLD_OVERVIEW_CELL_BLOCKS,
    ) + 1;
  return createCoverageSelection(
    minRow,
    minColumn,
    maxRowExclusive,
    maxColumnExclusive,
  );
}

export function coverageSelectionAtWorld(
  x: number,
  z: number,
): OverworldCoverageSelection {
  const cell = overviewCellAtWorld(x, z);
  if (!cell) fail("El punto está fuera de los sectores con datos del Overworld");
  return createCoverageSelection(
    cell.row,
    cell.column,
    cell.row + 1,
    cell.column + 1,
  );
}

export function parseCoverageSelection(
  value: unknown,
): OverworldCoverageSelection | null {
  if (
    !isRecord(value) ||
    value.version !== OVERWORLD_COVERAGE_VERSION ||
    value.coverageId !== OVERWORLD_COVERAGE_ID ||
    typeof value.minRow !== "number" ||
    typeof value.minColumn !== "number" ||
    typeof value.maxRowExclusive !== "number" ||
    typeof value.maxColumnExclusive !== "number"
  ) {
    return null;
  }
  try {
    const canonical = createCoverageSelection(
      value.minRow,
      value.minColumn,
      value.maxRowExclusive,
      value.maxColumnExclusive,
    );
    const scalarFields: Array<keyof OverworldCoverageSelection> = [
      "rows",
      "columns",
      "cellCount",
      "availableCellCount",
      "partialCellCount",
      "fullCellCount",
      "emptyCellCount",
      "availableTileCount",
      "tileCount",
    ];
    if (
      scalarFields.some((field) => value[field] !== canonical[field]) ||
      !isRecord(value.bounds) ||
      value.bounds.minX !== canonical.bounds.minX ||
      value.bounds.minZ !== canonical.bounds.minZ ||
      value.bounds.maxXExclusive !== canonical.bounds.maxXExclusive ||
      value.bounds.maxZExclusive !== canonical.bounds.maxZExclusive
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

export function fitCoverageScale(
  viewportWidth: number,
  viewportHeight: number,
  padding = 72,
): number {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(padding) ||
    viewportWidth <= padding * 2 ||
    viewportHeight <= padding * 2 ||
    padding < 0
  ) {
    fail("El viewport no permite encuadrar la rejilla global");
  }
  const worldWidth =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.maxXExclusive -
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minX;
  const worldHeight =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.maxZExclusive -
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minZ;
  return Math.min(
    (viewportWidth - padding * 2) / worldWidth,
    (viewportHeight - padding * 2) / worldHeight,
  );
}

export {
  OVERWORLD_LOD3_AVAILABLE_BANDS,
  OVERWORLD_MASK_AVAILABLE_TILE_COUNT,
  isObservedLod3TileAvailable,
};
