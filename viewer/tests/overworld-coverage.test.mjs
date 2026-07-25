import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERWORLD_COMPLETE_CORE_BOUNDS,
  OVERWORLD_MASK_AVAILABLE_TILE_COUNT,
  OVERWORLD_OBSERVED_DATA_BOUNDS,
  OVERWORLD_OVERVIEW_CELL_BLOCKS,
  OVERWORLD_OVERVIEW_CELL_COUNT,
  OVERWORLD_OVERVIEW_COLUMNS,
  OVERWORLD_OVERVIEW_GRID_BOUNDS,
  OVERWORLD_OVERVIEW_ROWS,
  OVERWORLD_OVERVIEW_TILE_COUNT,
  coverageSelectionAtWorld,
  coverageSelectionBetweenCells,
  coverageSelectionForWorldBounds,
  createCoverageSelection,
  fitCoverageScale,
  isObservedLod3TileAvailable,
  overviewCellAt,
  overviewCellAtWorld,
  overviewCellForIndex,
  parseCoverageSelection,
} from "../app/lib/overworld-coverage.ts";

test("separates the 33x33 UX envelope from the observed irregular bounds", () => {
  assert.deepEqual(OVERWORLD_OVERVIEW_GRID_BOUNDS, {
    minX: -540_672,
    minZ: -540_672,
    maxXExclusive: 540_672,
    maxZExclusive: 540_672,
  });
  assert.deepEqual(OVERWORLD_OBSERVED_DATA_BOUNDS, {
    minX: -540_672,
    minZ: -540_672,
    maxXExclusive: 540_672,
    maxZExclusive: 536_576,
  });
  assert.deepEqual(OVERWORLD_COMPLETE_CORE_BOUNDS, {
    minX: -512_000,
    minZ: -512_000,
    maxXExclusive: 512_000,
    maxZExclusive: 512_000,
  });
  assert.equal(OVERWORLD_OVERVIEW_COLUMNS, 33);
  assert.equal(OVERWORLD_OVERVIEW_ROWS, 33);
  assert.equal(OVERWORLD_OVERVIEW_CELL_COUNT, 33 * 33);
  assert.equal(OVERWORLD_OVERVIEW_TILE_COUNT, 64);
});

test("preserves the exact 66,464-tile LOD3 mask including its interior gap", () => {
  let count = 0;
  for (let tileZ = -132; tileZ < 132; tileZ += 1) {
    for (let tileX = -132; tileX < 132; tileX += 1) {
      if (isObservedLod3TileAvailable(tileX, tileZ)) count += 1;
    }
  }
  assert.equal(count, OVERWORLD_MASK_AVAILABLE_TILE_COUNT);
  assert.equal(count, 66_464);

  assert.equal(isObservedLod3TileAvailable(-130, -132), true);
  assert.equal(isObservedLod3TileAvailable(-131, -132), false);
  assert.equal(isObservedLod3TileAvailable(3, -130), true);
  assert.equal(isObservedLod3TileAvailable(4, -130), false);
  assert.equal(isObservedLod3TileAvailable(36, -130), false);
  assert.equal(isObservedLod3TileAvailable(37, -130), true);
  assert.equal(isObservedLod3TileAvailable(125, 130), true);
  assert.equal(isObservedLod3TileAvailable(126, 130), false);
  assert.equal(isObservedLod3TileAvailable(0, 131), false);
  assert.equal(isObservedLod3TileAvailable(0.5, 0), false);
});

test("aggregates exact tile counts into partial and full overview sectors", () => {
  const first = overviewCellForIndex(0);
  const center = overviewCellAt(16, 16);
  const last = overviewCellForIndex(OVERWORLD_OVERVIEW_CELL_COUNT - 1);

  assert.equal(first.id, "ow-r01-c01");
  assert.deepEqual(first.bounds, {
    minX: -540_672,
    minZ: -540_672,
    maxXExclusive: -507_904,
    maxZExclusive: -507_904,
  });
  assert.equal(first.coverageStatus, "partial");
  assert.equal(first.availableTileCount, 48);
  assert.equal(first.tileCount, 64);

  assert.deepEqual(center.bounds, {
    minX: -16_384,
    minZ: -16_384,
    maxXExclusive: 16_384,
    maxZExclusive: 16_384,
  });
  assert.equal(center.coverageStatus, "full");
  assert.equal(center.availableTileCount, 64);

  assert.equal(last.bounds.maxXExclusive, 540_672);
  assert.equal(last.bounds.maxZExclusive, 540_672);
  assert.equal(last.coverageStatus, "partial");
  assert.equal(last.availableTileCount, 14);
});

test("uses half-open boundaries when mapping world points to sectors", () => {
  assert.equal(overviewCellAtWorld(-540_672, -540_672)?.index, 0);
  assert.equal(overviewCellAtWorld(-507_904, -540_672)?.column, 1);
  assert.equal(overviewCellAtWorld(540_672, 0), null);
  assert.equal(overviewCellAtWorld(0, 540_672), null);
  assert.equal(overviewCellAtWorld(Number.NaN, 0), null);
});

test("summarizes full rectangular selections without treating the envelope as full", () => {
  const interior = coverageSelectionBetweenCells(
    overviewCellAt(10, 12),
    overviewCellAt(8, 9),
  );
  assert.equal(interior.minRow, 8);
  assert.equal(interior.minColumn, 9);
  assert.equal(interior.maxRowExclusive, 11);
  assert.equal(interior.maxColumnExclusive, 13);
  assert.equal(interior.rows, 3);
  assert.equal(interior.columns, 4);
  assert.equal(interior.cellCount, 12);
  assert.equal(interior.availableCellCount, 12);
  assert.equal(interior.partialCellCount, 0);
  assert.equal(interior.fullCellCount, 12);
  assert.equal(interior.availableTileCount, 12 * 64);
  assert.equal(interior.tileCount, 12 * 64);

  const global = createCoverageSelection(0, 0, 33, 33);
  assert.equal(global.availableCellCount, 1_089);
  assert.equal(global.partialCellCount, 128);
  assert.equal(global.fullCellCount, 961);
  assert.equal(global.emptyCellCount, 0);
  assert.equal(global.availableTileCount, 66_464);
  assert.equal(global.tileCount, 1_089 * 64);
});

test("keeps edge sectors selectable and exposes their partial density", () => {
  const topRow = createCoverageSelection(0, 0, 1, 33);
  assert.equal(topRow.availableCellCount, 33);
  assert.equal(topRow.partialCellCount, 33);
  assert.equal(topRow.fullCellCount, 0);
  assert.equal(topRow.availableTileCount, 1_487);

  const finalStrip = coverageSelectionForWorldBounds({
    minX: 0,
    minZ: 536_576,
    maxXExclusive: 1,
    maxZExclusive: 540_672,
  });
  assert.equal(finalStrip.minRow, 32);
  assert.equal(finalStrip.maxRowExclusive, 33);
  assert.equal(finalStrip.availableCellCount, 1);
  assert.equal(finalStrip.partialCellCount, 1);
});

test("snaps arbitrary bounds outward, clamps, and rejects no-grid selections", () => {
  const selection = coverageSelectionForWorldBounds({
    minX: -600_000,
    minZ: -20_000,
    maxXExclusive: -500_000,
    maxZExclusive: 20_000,
  });
  assert.deepEqual(selection.bounds, {
    minX: -540_672,
    minZ: -49_152,
    maxXExclusive: -475_136,
    maxZExclusive: 49_152,
  });
  assert.ok(selection.availableCellCount > 0);

  assert.throws(
    () =>
      coverageSelectionForWorldBounds({
        minX: 700_000,
        minZ: 700_000,
        maxXExclusive: 800_000,
        maxZExclusive: 800_000,
      }),
    /no intersecta/,
  );
  assert.throws(
    () => createCoverageSelection(0, 0, 0, 1),
    /rectángulo válido/,
  );
});

test("selects the sector containing a point with coverage metadata", () => {
  const selection = coverageSelectionAtWorld(0, 0);
  assert.equal(selection.cellCount, 1);
  assert.equal(selection.availableCellCount, 1);
  assert.equal(selection.fullCellCount, 1);
  assert.deepEqual(selection.bounds, {
    minX: -16_384,
    minZ: -16_384,
    maxXExclusive: 16_384,
    maxZExclusive: 16_384,
  });
});

test("parses only canonical persisted selections including coverage summaries", () => {
  const selection = createCoverageSelection(2, 3, 5, 7);
  assert.deepEqual(
    parseCoverageSelection(JSON.parse(JSON.stringify(selection))),
    selection,
  );

  const tamperedBounds = JSON.parse(JSON.stringify(selection));
  tamperedBounds.bounds.minX += OVERWORLD_OVERVIEW_CELL_BLOCKS;
  assert.equal(parseCoverageSelection(tamperedBounds), null);

  const tamperedCount = JSON.parse(JSON.stringify(selection));
  tamperedCount.availableTileCount -= 1;
  assert.equal(parseCoverageSelection(tamperedCount), null);

  assert.equal(parseCoverageSelection({ ...selection, version: 999 }), null);
});

test("fits the full overview grid inside the requested viewport padding", () => {
  const scale = fitCoverageScale(1_224, 800, 72);
  const side =
    OVERWORLD_OVERVIEW_GRID_BOUNDS.maxXExclusive -
    OVERWORLD_OVERVIEW_GRID_BOUNDS.minX;
  assert.ok(side * scale <= 1_224 - 144 + 1e-9);
  assert.ok(side * scale <= 800 - 144 + 1e-9);
  assert.throws(() => fitCoverageScale(100, 100, 72), /viewport/);
});
