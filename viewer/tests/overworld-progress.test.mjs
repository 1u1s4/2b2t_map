import assert from "node:assert/strict";
import test from "node:test";

import {
  createExplorationRegion,
  createExplorationState,
  withCellReviewed,
} from "../app/lib/exploration-grid.ts";
import {
  OVERWORLD_OVERVIEW_CELL_BLOCKS,
  OVERWORLD_OVERVIEW_CELL_COUNT,
  overviewCellForIndex,
} from "../app/lib/overworld-coverage.ts";
import { isObservedLod3TileAvailable } from "../app/lib/overworld-coverage-data.ts";
import {
  summarizeLocalCoverage,
  summarizeReviewProgress,
} from "../app/lib/overworld-progress.ts";

function explorationForSector(index, lod = 0) {
  const sector = overviewCellForIndex(index);
  const region = createExplorationRegion({
    id: `sector-${index}-lod-${lod}`,
    name: `Sector ${index}`,
    bounds: sector.bounds,
    lod,
    scale: lod === 0 ? 1 : 1 / 2 ** lod,
  });
  return createExplorationState(region);
}

function progressExploration(state, active = false) {
  return {
    id: state.region.id,
    name: state.region.name,
    updatedAt: "2026-07-25T00:00:00.000Z",
    active,
    state,
  };
}

test("local LOD0 reports complete, in-progress, and pending sectors separately", () => {
  const completeSector = overviewCellForIndex(544);
  const partialSector = overviewCellForIndex(0);
  const completeExpected = completeSector.availableTileCount * 64;

  const summary = summarizeLocalCoverage(
    {
      version: 1,
      dimension: "overworld",
      layer: "base",
      lod: 0,
      databaseUpdatedAt: "2026-07-25T00:00:00.000Z",
      cells: [
        {
          row: completeSector.row,
          column: completeSector.column,
          completeCount: completeExpected,
          queuedCount: 0,
          failedCount: 0,
          absentCount: 0,
        },
        {
          row: partialSector.row,
          column: partialSector.column,
          completeCount: 1,
          queuedCount: 0,
          failedCount: 0,
          absentCount: 0,
        },
      ],
    },
    0,
  );

  assert.ok(summary);
  assert.equal(summary.sectors[completeSector.index].status, "complete");
  assert.equal(summary.sectors[partialSector.index].status, "in-progress");
  assert.equal(summary.completeSectorCount, 1);
  assert.equal(summary.inProgressSectorCount, 1);
  assert.equal(
    summary.pendingSectorCount,
    OVERWORLD_OVERVIEW_CELL_COUNT - 2,
  );
});

test("LOD3 treats every available sector as complete when the exact mask is local", () => {
  const cells = Array.from(
    { length: OVERWORLD_OVERVIEW_CELL_COUNT },
    (_, index) => {
      const sector = overviewCellForIndex(index);
      return {
        row: sector.row,
        column: sector.column,
        completeCount: sector.availableTileCount,
        queuedCount: 0,
        failedCount: 0,
        absentCount: 0,
      };
    },
  );
  const summary = summarizeLocalCoverage(
    {
      version: 1,
      dimension: "overworld",
      layer: "base",
      lod: 3,
      databaseUpdatedAt: "2026-07-25T00:00:00.000Z",
      cells,
    },
    3,
  );

  assert.ok(summary);
  assert.equal(summary.completeSectorCount, OVERWORLD_OVERVIEW_CELL_COUNT);
  assert.equal(summary.inProgressSectorCount, 0);
  assert.equal(summary.pendingSectorCount, 0);
  assert.equal(summary.percent, 100);
});

test("confirmed finer-LOD 404s leave a reachable completion target", () => {
  const sector = overviewCellForIndex(544);
  const provisionalExpected = sector.availableTileCount * 4;
  const absentCount = 190;
  const summary = summarizeLocalCoverage(
    {
      version: 1,
      dimension: "overworld",
      layer: "base",
      lod: 2,
      databaseUpdatedAt: "2026-07-25T00:00:00.000Z",
      cells: [
        {
          row: sector.row,
          column: sector.column,
          completeCount: provisionalExpected - absentCount,
          queuedCount: 0,
          failedCount: 0,
          absentCount,
        },
      ],
    },
    2,
  );

  assert.ok(summary);
  assert.equal(
    summary.sectors[sector.index].expectedCount,
    provisionalExpected - absentCount,
  );
  assert.equal(summary.sectors[sector.index].excludedCount, absentCount);
  assert.equal(summary.sectors[sector.index].status, "complete");
  assert.equal(summary.sectors[sector.index].percent, 100);
});

test("review progress unions overlapping cells and ignores coarser work at LOD0", () => {
  const sector = overviewCellForIndex(544);
  let first = explorationForSector(sector.index, 0);
  let second = explorationForSector(sector.index, 0);
  first = withCellReviewed(first, 0);
  second = withCellReviewed(second, 0);
  let coarse = explorationForSector(sector.index, 3);
  coarse = withCellReviewed(coarse, 0);

  const summary = summarizeReviewProgress(
    [
      progressExploration(first),
      progressExploration(second),
      progressExploration(coarse),
    ],
    0,
  );

  assert.equal(summary.sectors[sector.index].completeCount, 1);
  assert.equal(summary.sectors[sector.index].status, "in-progress");
});

test("coarser-only sessions remain pending at a finer target LOD", () => {
  const sector = overviewCellForIndex(544);
  let coarse = explorationForSector(sector.index, 3);
  coarse = withCellReviewed(coarse, 0);

  const summary = summarizeReviewProgress(
    [progressExploration(coarse)],
    0,
  );

  assert.equal(summary.sectors[sector.index].completeCount, 0);
  assert.equal(summary.sectors[sector.index].status, "pending");
  assert.equal(summary.completedExplorationCount, 0);
  assert.equal(summary.inProgressExplorationCount, 0);
  assert.equal(summary.pendingExplorationCount, 0);
});

test("a fully reviewed LOD3 region completes its sector at LOD3", () => {
  const sector = overviewCellForIndex(544);
  let state = explorationForSector(sector.index, 3);
  for (let index = 0; index < state.region.cellCount; index += 1) {
    state = withCellReviewed(state, index);
  }
  const summary = summarizeReviewProgress(
    [progressExploration(state, true)],
    3,
  );

  assert.equal(
    summary.sectors[sector.index].expectedCount,
    sector.availableTileCount,
  );
  assert.equal(
    summary.sectors[sector.index].completeCount,
    sector.availableTileCount,
  );
  assert.equal(summary.sectors[sector.index].status, "complete");
  assert.equal(summary.sectors[sector.index].percent, 100);
  assert.equal(summary.completedExplorationCount, 1);
  assert.equal(summary.sectors[sector.index].activeExploration, true);
});

test("a partial edge sector completes after reviewing only published tiles", () => {
  const sector = overviewCellForIndex(0);
  let state = explorationForSector(sector.index, 3);
  for (let index = 0; index < state.region.cellCount; index += 1) {
    const row = Math.floor(index / state.region.columns);
    const column = index % state.region.columns;
    const tileX = state.region.minTileX + column;
    const tileZ = state.region.minTileZ + row;
    if (isObservedLod3TileAvailable(tileX, tileZ)) {
      state = withCellReviewed(state, index);
    }
  }

  const summary = summarizeReviewProgress(
    [progressExploration(state)],
    3,
  );

  assert.equal(state.reviewedCount, sector.availableTileCount);
  assert.equal(
    summary.sectors[sector.index].completeCount,
    sector.availableTileCount,
  );
  assert.equal(
    summary.sectors[sector.index].expectedCount,
    sector.availableTileCount,
  );
  assert.equal(summary.sectors[sector.index].status, "complete");
  assert.equal(summary.sectors[sector.index].percent, 100);
});

test("finer review work is a precise fractional tile at a coarser target LOD", () => {
  const sector = overviewCellForIndex(544);
  let state = explorationForSector(sector.index, 0);
  state = withCellReviewed(state, 0);

  const summary = summarizeReviewProgress(
    [progressExploration(state)],
    3,
  );

  assert.equal(
    summary.sectors[sector.index].expectedCount,
    sector.availableTileCount,
  );
  assert.equal(summary.sectors[sector.index].completeCount, 1 / 64);
  assert.equal(
    summary.sectors[sector.index].percent,
    (1 / (sector.availableTileCount * 64)) * 100,
  );
  assert.equal(summary.sectors[sector.index].status, "in-progress");
});

test("a planned but untouched sector is in progress rather than silently pending", () => {
  const sector = overviewCellForIndex(544);
  const state = explorationForSector(sector.index, 0);
  const summary = summarizeReviewProgress(
    [progressExploration(state)],
    0,
  );

  assert.equal(summary.sectors[sector.index].completeCount, 0);
  assert.equal(summary.sectors[sector.index].status, "in-progress");
  assert.equal(summary.pendingExplorationCount, 1);
});

test("sector geometry remains aligned to the 32,768-block overview grid", () => {
  const first = overviewCellForIndex(0);
  const second = overviewCellForIndex(1);
  assert.equal(
    second.bounds.minX - first.bounds.minX,
    OVERWORLD_OVERVIEW_CELL_BLOCKS,
  );
});
