import type { ExplorationState, WorldBounds } from "./exploration-grid.ts";
import {
  OVERWORLD_OVERVIEW_CELL_COUNT,
  OVERWORLD_OVERVIEW_COLUMNS,
  OVERWORLD_OVERVIEW_ROWS,
  OVERWORLD_OVERVIEW_TILES_PER_SIDE,
  overviewCellForIndex,
} from "./overworld-coverage.ts";
import {
  OVERWORLD_MASK_TILE_BLOCKS,
  isObservedLod3TileAvailable,
} from "./overworld-coverage-data.ts";

export const OVERWORLD_PROGRESS_VERSION = 1 as const;
export const MIN_PROGRESS_LOD = 0;
export const MAX_PROGRESS_LOD = 3;
export const LOD0_TILE_BLOCKS = 512;
export const LOD0_TILES_PER_OVERVIEW_SIDE = 64;
export const LOD0_OVERVIEW_ATOM_COUNT =
  LOD0_TILES_PER_OVERVIEW_SIDE ** 2;
export const OVERWORLD_PROGRESS_ATOM_COLUMNS =
  OVERWORLD_OVERVIEW_COLUMNS * LOD0_TILES_PER_OVERVIEW_SIDE;
export const OVERWORLD_PROGRESS_ATOM_ROWS =
  OVERWORLD_OVERVIEW_ROWS * LOD0_TILES_PER_OVERVIEW_SIDE;
export const OVERWORLD_PROGRESS_ATOM_COUNT =
  OVERWORLD_PROGRESS_ATOM_COLUMNS * OVERWORLD_PROGRESS_ATOM_ROWS;

export type OverworldProgressStatus =
  | "complete"
  | "in-progress"
  | "pending";

export interface OverworldProgressExploration {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly active: boolean;
  readonly state: ExplorationState;
}

export interface OverworldSectorProgress {
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly status: OverworldProgressStatus;
  /** Tiles at the selected LOD. Review coverage can be a fractional equivalent. */
  readonly expectedCount: number;
  readonly completeCount: number;
  readonly queuedCount: number;
  readonly failedCount: number;
  /** Confirmed finer-LOD 404s removed from the provisional source envelope. */
  readonly excludedCount: number;
  readonly percent: number;
  readonly relatedExplorationIds: readonly string[];
  readonly relatedExplorationCount: number;
  readonly activeExploration: boolean;
}

export interface OverworldProgressSummary {
  readonly version: typeof OVERWORLD_PROGRESS_VERSION;
  readonly lod: number;
  readonly completeSectorCount: number;
  readonly inProgressSectorCount: number;
  readonly pendingSectorCount: number;
  readonly eligibleSectorCount: number;
  /** Tiles at the selected LOD. Review coverage can be a fractional equivalent. */
  readonly completeCount: number;
  readonly expectedCount: number;
  readonly queuedCount: number;
  readonly failedCount: number;
  readonly excludedCount: number;
  readonly percent: number;
  readonly completedExplorationCount: number;
  readonly inProgressExplorationCount: number;
  readonly pendingExplorationCount: number;
  readonly sectors: readonly OverworldSectorProgress[];
}

export interface LocalCoverageCell {
  readonly row: number;
  readonly column: number;
  readonly completeCount: number;
  readonly queuedCount: number;
  readonly failedCount: number;
  readonly absentCount: number;
}

export interface LocalCoverageSnapshot {
  readonly version: 1;
  readonly dimension: "overworld";
  readonly layer: "base";
  readonly lod: number;
  readonly databaseUpdatedAt: string;
  readonly cells: readonly LocalCoverageCell[];
}

function assertProgressLod(lod: number): void {
  if (
    !Number.isSafeInteger(lod) ||
    lod < MIN_PROGRESS_LOD ||
    lod > MAX_PROGRESS_LOD
  ) {
    throw new RangeError(
      `LOD de progreso debe estar entre ${MIN_PROGRESS_LOD} y ${MAX_PROGRESS_LOD}`,
    );
  }
}

function intersects(left: WorldBounds, right: WorldBounds): boolean {
  return (
    left.minX < right.maxXExclusive &&
    left.maxXExclusive > right.minX &&
    left.minZ < right.maxZExclusive &&
    left.maxZExclusive > right.minZ
  );
}

function progressStatus(
  completeCount: number,
  expectedCount: number,
  hasActivity: boolean,
): OverworldProgressStatus {
  if (expectedCount > 0 && completeCount >= expectedCount) return "complete";
  if (completeCount > 0 || hasActivity) return "in-progress";
  return "pending";
}

function percent(completeCount: number, expectedCount: number): number {
  if (expectedCount <= 0) return 0;
  return Math.min(100, (completeCount / expectedCount) * 100);
}

function countStatuses(sectors: readonly OverworldSectorProgress[]) {
  let completeSectorCount = 0;
  let inProgressSectorCount = 0;
  let pendingSectorCount = 0;
  for (const sector of sectors) {
    if (sector.expectedCount === 0) continue;
    if (sector.status === "complete") completeSectorCount += 1;
    if (sector.status === "in-progress") inProgressSectorCount += 1;
    if (sector.status === "pending") pendingSectorCount += 1;
  }
  return {
    completeSectorCount,
    inProgressSectorCount,
    pendingSectorCount,
    eligibleSectorCount:
      completeSectorCount + inProgressSectorCount + pendingSectorCount,
  };
}

function expectedAtomsAtLod(lod: number): number {
  return 4 ** (MAX_PROGRESS_LOD - lod);
}

function createAvailabilityMask(): Uint8Array {
  const mask = new Uint8Array(OVERWORLD_PROGRESS_ATOM_COUNT);
  for (let sectorIndex = 0; sectorIndex < OVERWORLD_OVERVIEW_CELL_COUNT; sectorIndex += 1) {
    const sector = overviewCellForIndex(sectorIndex);
    const sectorAtomX = sector.column * LOD0_TILES_PER_OVERVIEW_SIDE;
    const sectorAtomZ = sector.row * LOD0_TILES_PER_OVERVIEW_SIDE;
    const firstLod3TileX = sector.bounds.minX / OVERWORLD_MASK_TILE_BLOCKS;
    const firstLod3TileZ = sector.bounds.minZ / OVERWORLD_MASK_TILE_BLOCKS;
    for (
      let localTileZ = 0;
      localTileZ < OVERWORLD_OVERVIEW_TILES_PER_SIDE;
      localTileZ += 1
    ) {
      for (
        let localTileX = 0;
        localTileX < OVERWORLD_OVERVIEW_TILES_PER_SIDE;
        localTileX += 1
      ) {
        if (
          !isObservedLod3TileAvailable(
            firstLod3TileX + localTileX,
            firstLod3TileZ + localTileZ,
          )
        ) {
          continue;
        }
        const firstAtomX = sectorAtomX + localTileX * 8;
        const firstAtomZ = sectorAtomZ + localTileZ * 8;
        for (let atomZ = firstAtomZ; atomZ < firstAtomZ + 8; atomZ += 1) {
          const offset = atomZ * OVERWORLD_PROGRESS_ATOM_COLUMNS + firstAtomX;
          mask.fill(1, offset, offset + 8);
        }
      }
    }
  }
  return mask;
}

const AVAILABLE_LOD0_ATOMS = createAvailabilityMask();
const PROGRESS_GRID_MIN_LOD0_TILE =
  overviewCellForIndex(0).bounds.minX / LOD0_TILE_BLOCKS;
const EXPECTED_REVIEW_ATOMS_BY_SECTOR = Object.freeze(
  Array.from(
    { length: OVERWORLD_OVERVIEW_CELL_COUNT },
    (_, index) => overviewCellForIndex(index).availableTileCount * 64,
  ),
);

/**
 * Add one LOD-0-aligned rectangle to the union and update sector totals while
 * the atoms are still hot. This deliberately avoids a second 4.46M-atom pass
 * after every review interaction.
 */
function markReviewedRectangle(
  mask: Uint8Array,
  completeBySector: Uint32Array,
  rawFirstX: number,
  rawFirstZ: number,
  width: number,
  height: number,
): void {
  const firstX = Math.max(0, rawFirstX);
  const firstZ = Math.max(0, rawFirstZ);
  const lastX = Math.min(
    OVERWORLD_PROGRESS_ATOM_COLUMNS,
    rawFirstX + width,
  );
  const lastZ = Math.min(
    OVERWORLD_PROGRESS_ATOM_ROWS,
    rawFirstZ + height,
  );
  if (firstX >= lastX || firstZ >= lastZ) return;

  for (let atomZ = firstZ; atomZ < lastZ; atomZ += 1) {
    const offset = atomZ * OVERWORLD_PROGRESS_ATOM_COLUMNS + firstX;
    const sectorRow = Math.floor(
      atomZ / LOD0_TILES_PER_OVERVIEW_SIDE,
    );
    for (let atomX = firstX; atomX < lastX; atomX += 1) {
      const atomIndex = offset + atomX - firstX;
      if (
        AVAILABLE_LOD0_ATOMS[atomIndex] === 0 ||
        mask[atomIndex] !== 0
      ) {
        continue;
      }
      mask[atomIndex] = 1;
      const sectorColumn = Math.floor(
        atomX / LOD0_TILES_PER_OVERVIEW_SIDE,
      );
      completeBySector[
        sectorRow * OVERWORLD_OVERVIEW_COLUMNS + sectorColumn
      ] += 1;
    }
  }
}

function markReviewedCell(
  mask: Uint8Array,
  completeBySector: Uint32Array,
  state: ExplorationState,
  index: number,
): void {
  const region = state.region;
  const row = Math.floor(index / region.columns);
  const column = index % region.columns;
  const side = 2 ** region.lod;
  markReviewedRectangle(
    mask,
    completeBySector,
    (region.minTileX + column) * side - PROGRESS_GRID_MIN_LOD0_TILE,
    (region.minTileZ + row) * side - PROGRESS_GRID_MIN_LOD0_TILE,
    side,
    side,
  );
}

function markDenseReviewedRuns(
  mask: Uint8Array,
  completeBySector: Uint32Array,
  state: ExplorationState,
): void {
  const { region, reviewed } = state;
  const side = 2 ** region.lod;
  const isReviewed = (index: number) =>
    (reviewed[Math.floor(index / 8)] & (1 << (index % 8))) !== 0;

  for (let row = 0; row < region.rows; row += 1) {
    let column = 0;
    while (column < region.columns) {
      while (
        column < region.columns &&
        !isReviewed(row * region.columns + column)
      ) {
        column += 1;
      }
      const firstColumn = column;
      while (
        column < region.columns &&
        isReviewed(row * region.columns + column)
      ) {
        column += 1;
      }
      if (firstColumn === column) continue;
      markReviewedRectangle(
        mask,
        completeBySector,
        (region.minTileX + firstColumn) * side -
          PROGRESS_GRID_MIN_LOD0_TILE,
        (region.minTileZ + row) * side -
          PROGRESS_GRID_MIN_LOD0_TILE,
        (column - firstColumn) * side,
        side,
      );
    }
  }
}

function reviewedCountsBySector(
  explorations: readonly OverworldProgressExploration[],
  targetLod: number,
): Uint32Array {
  const mask = new Uint8Array(OVERWORLD_PROGRESS_ATOM_COUNT);
  const completeBySector = new Uint32Array(
    OVERWORLD_OVERVIEW_CELL_COUNT,
  );
  for (const exploration of explorations) {
    const state = exploration.state;
    if (state.region.lod > targetLod || state.reviewedCount === 0) continue;

    if (state.reviewedCount === state.region.cellCount) {
      const side = 2 ** state.region.lod;
      markReviewedRectangle(
        mask,
        completeBySector,
        state.region.minTileX * side - PROGRESS_GRID_MIN_LOD0_TILE,
        state.region.minTileZ * side - PROGRESS_GRID_MIN_LOD0_TILE,
        state.region.columns * side,
        state.region.rows * side,
      );
      continue;
    }

    // Dense sessions are normally reviewed in contiguous serpentine runs.
    // Collapsing those runs avoids millions of per-cell rectangle calls near
    // completion while the sparse byte walker remains optimal early on.
    if (state.reviewedCount * 2 >= state.region.cellCount) {
      markDenseReviewedRuns(mask, completeBySector, state);
      continue;
    }

    for (let byteIndex = 0; byteIndex < state.reviewed.length; byteIndex += 1) {
      let bits = state.reviewed[byteIndex];
      while (bits !== 0) {
        const lowestBit = bits & -bits;
        const bitIndex = 31 - Math.clz32(lowestBit);
        const index = byteIndex * 8 + bitIndex;
        if (index < state.region.cellCount) {
          markReviewedCell(mask, completeBySector, state, index);
        }
        bits &= bits - 1;
      }
    }
  }
  return completeBySector;
}

export function summarizeReviewProgress(
  explorations: readonly OverworldProgressExploration[],
  lod: number,
): OverworldProgressSummary {
  assertProgressLod(lod);
  const eligibleExplorations = explorations.filter(
    (exploration) => exploration.state.region.lod <= lod,
  );
  const completeBySector = reviewedCountsBySector(
    eligibleExplorations,
    lod,
  );
  const lod0AtomsPerTargetTile = 4 ** lod;
  const sectors: OverworldSectorProgress[] = [];
  let completeAtomCount = 0;
  let expectedAtomCount = 0;

  for (let index = 0; index < OVERWORLD_OVERVIEW_CELL_COUNT; index += 1) {
    const sector = overviewCellForIndex(index);
    const related = eligibleExplorations.filter((exploration) =>
      intersects(exploration.state.region.bounds, sector.bounds),
    );
    const sectorCompleteAtoms = completeBySector[index];
    const sectorExpectedAtoms = EXPECTED_REVIEW_ATOMS_BY_SECTOR[index];
    const sectorComplete =
      sectorCompleteAtoms / lod0AtomsPerTargetTile;
    const sectorExpected =
      sectorExpectedAtoms / lod0AtomsPerTargetTile;
    completeAtomCount += sectorCompleteAtoms;
    expectedAtomCount += sectorExpectedAtoms;
    sectors.push(
      Object.freeze({
        index,
        row: sector.row,
        column: sector.column,
        status: progressStatus(
          sectorCompleteAtoms,
          sectorExpectedAtoms,
          related.length > 0,
        ),
        expectedCount: sectorExpected,
        completeCount: sectorComplete,
        queuedCount: 0,
        failedCount: 0,
        excludedCount: 0,
        percent: percent(sectorCompleteAtoms, sectorExpectedAtoms),
        relatedExplorationIds: Object.freeze(
          related.map((exploration) => exploration.id),
        ),
        relatedExplorationCount: related.length,
        activeExploration: related.some((exploration) => exploration.active),
      }),
    );
  }

  const statusCounts = countStatuses(sectors);
  let completedExplorationCount = 0;
  let inProgressExplorationCount = 0;
  let pendingExplorationCount = 0;
  for (const exploration of eligibleExplorations) {
    const { reviewedCount, region } = exploration.state;
    if (reviewedCount === region.cellCount) completedExplorationCount += 1;
    else if (reviewedCount > 0) inProgressExplorationCount += 1;
    else pendingExplorationCount += 1;
  }

  return Object.freeze({
    version: OVERWORLD_PROGRESS_VERSION,
    lod,
    ...statusCounts,
    completeCount: completeAtomCount / lod0AtomsPerTargetTile,
    expectedCount: expectedAtomCount / lod0AtomsPerTargetTile,
    queuedCount: 0,
    failedCount: 0,
    excludedCount: 0,
    percent: percent(completeAtomCount, expectedAtomCount),
    completedExplorationCount,
    inProgressExplorationCount,
    pendingExplorationCount,
    sectors: Object.freeze(sectors),
  });
}

export function summarizeLocalCoverage(
  snapshot: LocalCoverageSnapshot | null,
  lod: number,
): OverworldProgressSummary | null {
  assertProgressLod(lod);
  if (!snapshot || snapshot.lod !== lod) return null;
  const byIndex = new Map<number, LocalCoverageCell>();
  for (const cell of snapshot.cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      !Number.isSafeInteger(cell.column) ||
      cell.row < 0 ||
      cell.row >= OVERWORLD_OVERVIEW_ROWS ||
      cell.column < 0 ||
      cell.column >= OVERWORLD_OVERVIEW_COLUMNS
    ) {
      continue;
    }
    byIndex.set(cell.row * OVERWORLD_OVERVIEW_COLUMNS + cell.column, cell);
  }

  const expectedPerLod3 = expectedAtomsAtLod(lod);
  const sectors: OverworldSectorProgress[] = [];
  let completeCount = 0;
  let expectedCount = 0;
  let queuedCount = 0;
  let failedCount = 0;
  let excludedCount = 0;
  for (let index = 0; index < OVERWORLD_OVERVIEW_CELL_COUNT; index += 1) {
    const sector = overviewCellForIndex(index);
    const local = byIndex.get(index);
    const provisionalExpected =
      sector.availableTileCount * expectedPerLod3;
    // The static source mask is exact only at LOD 3. At finer LODs, each
    // published parent is merely a safe search envelope: confirmed 404
    // descendants are outside the real footprint and must not make 100%
    // mathematically impossible after a complete crawl.
    const excluded =
      lod < MAX_PROGRESS_LOD
        ? Math.min(provisionalExpected, local?.absentCount ?? 0)
        : 0;
    const expected = provisionalExpected - excluded;
    const complete = Math.min(expected, local?.completeCount ?? 0);
    const queued = local?.queuedCount ?? 0;
    const failed = local?.failedCount ?? 0;
    const hasActivity =
      complete > 0 ||
      queued > 0 ||
      failed > 0 ||
      excluded > 0;
    completeCount += complete;
    expectedCount += expected;
    queuedCount += queued;
    failedCount += failed;
    excludedCount += excluded;
    sectors.push(
      Object.freeze({
        index,
        row: sector.row,
        column: sector.column,
        status: progressStatus(complete, expected, hasActivity),
        expectedCount: expected,
        completeCount: complete,
        queuedCount: queued,
        failedCount: failed,
        excludedCount: excluded,
        percent: percent(complete, expected),
        relatedExplorationIds: Object.freeze([]),
        relatedExplorationCount: 0,
        activeExploration: false,
      }),
    );
  }
  const statusCounts = countStatuses(sectors);
  return Object.freeze({
    version: OVERWORLD_PROGRESS_VERSION,
    lod,
    ...statusCounts,
    completeCount,
    expectedCount,
    queuedCount,
    failedCount,
    excludedCount,
    percent: percent(completeCount, expectedCount),
    completedExplorationCount: 0,
    inProgressExplorationCount: 0,
    pendingExplorationCount: 0,
    sectors: Object.freeze(sectors),
  });
}
