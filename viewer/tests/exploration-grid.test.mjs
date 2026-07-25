import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXPLORATION_CELLS,
  cardinalNeighbor,
  cellForIndex,
  cellIndexAtSerpentinePosition,
  cellIndexAtWorld,
  createExplorationRegion,
  createExplorationState,
  deserializeExplorationState,
  isCellReviewed,
  moveCurrentCardinal,
  moveCurrentSerpentine,
  serpentineNeighbor,
  serpentinePositionForCellIndex,
  serializeExplorationState,
  withCellReviewed,
  withCurrentCellReviewed,
  withCurrentIndex,
  worldBlockToExplorationTile,
} from "../app/lib/exploration-grid.ts";

function region(overrides = {}) {
  return createExplorationRegion({
    id: "negative-origin",
    name: "Región de prueba",
    bounds: {
      minX: -513,
      minZ: -1,
      maxXExclusive: 513,
      maxZExclusive: 1024,
    },
    lod: 0,
    scale: 1,
    ...overrides,
  });
}

test("aligns half-open negative bounds with Math.floor", () => {
  const grid = region();

  assert.equal(worldBlockToExplorationTile(-1, 0), -1);
  assert.equal(worldBlockToExplorationTile(-512, 0), -1);
  assert.equal(worldBlockToExplorationTile(-513, 0), -2);
  assert.deepEqual(grid.bounds, {
    minX: -1024,
    minZ: -512,
    maxXExclusive: 1024,
    maxZExclusive: 1024,
  });
  assert.equal(grid.minTileX, -2);
  assert.equal(grid.maxTileXExclusive, 2);
  assert.equal(grid.minTileZ, -1);
  assert.equal(grid.maxTileZExclusive, 2);
  assert.equal(grid.columns, 4);
  assert.equal(grid.rows, 3);
  assert.equal(grid.cellCount, 12);
});

test("does not add a tile when a half-open maximum is an exact boundary", () => {
  const grid = region({
    bounds: {
      minX: -1024,
      minZ: -512,
      maxXExclusive: 0,
      maxZExclusive: 512,
    },
  });

  assert.deepEqual(grid.bounds, {
    minX: -1024,
    minZ: -512,
    maxXExclusive: 0,
    maxZExclusive: 512,
  });
  assert.equal(grid.columns, 2);
  assert.equal(grid.rows, 2);
  assert.equal(cellIndexAtWorld(grid, -1, -1), 1);
  assert.equal(cellIndexAtWorld(grid, 0, -1), null);
  assert.equal(cellIndexAtWorld(grid, -1024, -512), 0);
  assert.equal(cellIndexAtWorld(grid, -1025, -512), null);
});

test("exposes exact half-open cell bounds and tile coordinates", () => {
  const grid = region();
  const cell = cellForIndex(grid, 5);

  assert.deepEqual(cell, {
    index: 5,
    row: 1,
    column: 1,
    tileX: -1,
    tileZ: 0,
    bounds: {
      minX: -512,
      minZ: 0,
      maxXExclusive: 0,
      maxZExclusive: 512,
    },
  });
  assert.throws(() => cellForIndex(grid, 12), /fuera de rango/);
});

test("rejects invalid LOD/scale pairs and oversized regions before allocation", () => {
  assert.throws(
    () => region({ lod: 2, scale: 1 }),
    /corresponde a LOD 0, no a LOD 2/,
  );
  assert.throws(
    () =>
      region({
        bounds: {
          minX: 0,
          minZ: 0,
          maxXExclusive: 2_001 * 512,
          maxZExclusive: 2_000 * 512,
        },
      }),
    (error) =>
      error?.code === "TOO_MANY_CELLS" &&
      error.message.includes(MAX_EXPLORATION_CELLS.toLocaleString("en-US")),
  );
});

test("cardinal navigation respects every edge", () => {
  const grid = region({
    bounds: {
      minX: 0,
      minZ: 0,
      maxXExclusive: 3 * 512,
      maxZExclusive: 2 * 512,
    },
  });

  assert.equal(cardinalNeighbor(grid, 0, "north"), null);
  assert.equal(cardinalNeighbor(grid, 0, "west"), null);
  assert.equal(cardinalNeighbor(grid, 0, "east"), 1);
  assert.equal(cardinalNeighbor(grid, 0, "south"), 3);
  assert.equal(cardinalNeighbor(grid, 5, "east"), null);
  assert.equal(cardinalNeighbor(grid, 5, "south"), null);

  let state = createExplorationState(grid);
  state = moveCurrentCardinal(state, "east");
  state = moveCurrentCardinal(state, "south");
  assert.equal(state.currentIndex, 4);
  assert.equal(moveCurrentCardinal(state, "south"), state);
});

test("next and previous follow a reversible serpentine route", () => {
  const grid = region({
    bounds: {
      minX: 0,
      minZ: 0,
      maxXExclusive: 3 * 512,
      maxZExclusive: 3 * 512,
    },
  });
  const expected = [0, 1, 2, 5, 4, 3, 6, 7, 8];

  assert.deepEqual(
    Array.from(
      { length: grid.cellCount },
      (_, position) => cellIndexAtSerpentinePosition(grid, position),
    ),
    expected,
  );
  expected.forEach((index, position) => {
    assert.equal(serpentinePositionForCellIndex(grid, index), position);
  });
  assert.equal(serpentineNeighbor(grid, 0, -1), null);
  assert.equal(serpentineNeighbor(grid, 8, 1), null);

  let state = createExplorationState(grid);
  for (const expectedIndex of expected.slice(1)) {
    state = moveCurrentSerpentine(state, 1);
    assert.equal(state.currentIndex, expectedIndex);
  }
  assert.equal(moveCurrentSerpentine(state, 1), state);
  for (const expectedIndex of [...expected].reverse().slice(1)) {
    state = moveCurrentSerpentine(state, -1);
    assert.equal(state.currentIndex, expectedIndex);
  }
});

test("reviewed cells use an immutable compact bitset and stable count", () => {
  const initial = createExplorationState(region());
  const first = withCellReviewed(initial, 0);
  const distant = withCellReviewed(first, 11);
  const unchanged = withCellReviewed(distant, 11);
  const cleared = withCellReviewed(distant, 0, false);

  assert.equal(initial.reviewed.byteLength, 2);
  assert.equal(initial.reviewedCount, 0);
  assert.equal(isCellReviewed(initial, 0), false);
  assert.equal(isCellReviewed(first, 0), true);
  assert.equal(isCellReviewed(first, 11), false);
  assert.equal(isCellReviewed(distant, 11), true);
  assert.equal(distant.reviewedCount, 2);
  assert.equal(unchanged, distant);
  assert.equal(cleared.reviewedCount, 1);
  assert.equal(isCellReviewed(cleared, 0), false);
  assert.equal(isCellReviewed(cleared, 11), true);

  const atFive = withCurrentIndex(initial, 5);
  const reviewedCurrent = withCurrentCellReviewed(atFive);
  assert.equal(reviewedCurrent.currentIndex, 5);
  assert.equal(isCellReviewed(reviewedCurrent, 5), true);
});

test("serialization round-trips region, fixed scale, cursor, and bitset", () => {
  let state = createExplorationState(region());
  state = withCurrentIndex(state, 7);
  state = withCellReviewed(state, 0);
  state = withCellReviewed(state, 7);
  state = withCellReviewed(state, 11);

  const serialized = serializeExplorationState(state);
  const restored = deserializeExplorationState(serialized);

  assert.deepEqual(restored.region, state.region);
  assert.equal(restored.currentIndex, 7);
  assert.equal(restored.reviewedCount, 3);
  assert.deepEqual(restored.reviewed, state.reviewed);
  assert.equal(serializeExplorationState(restored), serialized);
});

test("deserialization rejects tampering, noncanonical bounds, and unsafe input", () => {
  let state = createExplorationState(region());
  state = withCellReviewed(state, 11);
  const payload = JSON.parse(serializeExplorationState(state));

  const wrongCount = structuredClone(payload);
  wrongCount.reviewedCount = 2;
  assert.throws(
    () => deserializeExplorationState(JSON.stringify(wrongCount)),
    /contador exportado no coincide/,
  );

  const noncanonicalBounds = structuredClone(payload);
  noncanonicalBounds.region.bounds.minX += 1;
  assert.throws(
    () => deserializeExplorationState(JSON.stringify(noncanonicalBounds)),
    /límites exportados no están alineados/,
  );

  const trailingBits = structuredClone(payload);
  // Twelve cells need two bytes; "_" sets forbidden high bits in byte two.
  trailingBits.reviewedBits = "AP8";
  trailingBits.reviewedCount = 8;
  assert.throws(
    () => deserializeExplorationState(JSON.stringify(trailingBits)),
    /bits fuera de la región/,
  );

  assert.throws(() => deserializeExplorationState("{broken"), /JSON válido/);
  assert.throws(
    () => deserializeExplorationState("x".repeat(1_000_001)),
    /tamaño inválido/,
  );
});
