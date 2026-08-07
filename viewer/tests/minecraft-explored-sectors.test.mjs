import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMinecraftExploredSectorIds,
  withMinecraftExploredSector,
} from "../app/lib/minecraft-explored-sectors.ts";
import {
  OVERWORLD_OVERVIEW_CELL_COUNT,
  overviewCellForIndex,
} from "../app/lib/overworld-coverage.ts";

test("Minecraft-explored sectors are canonical, reversible, and independent", () => {
  const first = overviewCellForIndex(0).id;
  const middle = overviewCellForIndex(500).id;
  const last = overviewCellForIndex(
    OVERWORLD_OVERVIEW_CELL_COUNT - 1,
  ).id;

  assert.deepEqual(
    parseMinecraftExploredSectorIds([last, first, middle]),
    [first, middle, last],
  );

  const marked = withMinecraftExploredSector([], middle, true);
  assert.deepEqual(marked, [middle]);
  assert.deepEqual(
    withMinecraftExploredSector(marked, middle, false),
    [],
  );
  assert.deepEqual(
    withMinecraftExploredSector(marked, middle, true),
    marked,
  );
});

test("Minecraft-explored sector parsing rejects unknown or duplicate IDs", () => {
  const first = overviewCellForIndex(0).id;
  assert.equal(parseMinecraftExploredSectorIds([first, first]), null);
  assert.equal(parseMinecraftExploredSectorIds(["ow-r99-c99"]), null);
  assert.equal(parseMinecraftExploredSectorIds(null), null);
  assert.throws(
    () => withMinecraftExploredSector([], "ow-r99-c99", true),
    /no existe/,
  );
});
