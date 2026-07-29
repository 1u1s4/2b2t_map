import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OVERWORLD_OVERVIEW_COLUMNS,
  coverageSelectionForOverviewCellIndex,
  overviewCellForIndex,
} from "../app/lib/overworld-coverage.ts";

const viewerSource = await readFile(
  new URL("../app/map-viewer.tsx", import.meta.url),
  "utf8",
);

test("moving to the adjacent Atlas sector resolves a new operational selection", () => {
  const row = 21;
  const leftIndex = row * OVERWORLD_OVERVIEW_COLUMNS + 13;
  const rightIndex = leftIndex + 1;
  const left = coverageSelectionForOverviewCellIndex(leftIndex);
  const right = coverageSelectionForOverviewCellIndex(rightIndex);

  assert.ok(left);
  assert.ok(right);
  assert.equal(left.bounds.maxXExclusive, right.bounds.minX);
  assert.notDeepEqual(right.bounds, left.bounds);
  assert.deepEqual(
    right.bounds,
    overviewCellForIndex(rightIndex).bounds,
  );
});

test("every current Atlas overview cell resolves to its own selection", () => {
  for (
    let index = 0;
    index < OVERWORLD_OVERVIEW_COLUMNS ** 2;
    index += 1
  ) {
    const selection = coverageSelectionForOverviewCellIndex(index);
    assert.ok(selection);
    assert.deepEqual(selection.bounds, overviewCellForIndex(index).bounds);
  }
});

test("every explicit Atlas navigation path commits the focused cell", () => {
  const selectStart = viewerSource.indexOf("const selectAtlasCell");
  const selectEnd = viewerSource.indexOf("const fitAtlasView", selectStart);
  const selectBlock = viewerSource.slice(selectStart, selectEnd);
  const searchStart = viewerSource.indexOf("const goToSearch");
  const searchEnd = viewerSource.indexOf(
    "const moveExplorationCardinal",
    searchStart,
  );
  const searchBlock = viewerSource.slice(searchStart, searchEnd);
  const cardinalStart = viewerSource.indexOf(
    "const moveAtlasFocusCardinal",
  );
  const cardinalEnd = viewerSource.indexOf("useEffect(", cardinalStart);
  const cardinalBlock = viewerSource.slice(cardinalStart, cardinalEnd);
  const keyboardStart = viewerSource.indexOf(
    'atlasMode && event.key === "Enter"',
  );
  const keyboardEnd = viewerSource.indexOf(
    "const updateLayer",
    keyboardStart,
  );
  const keyboardBlock = viewerSource.slice(keyboardStart, keyboardEnd);
  const controlsStart = viewerSource.indexOf(
    'className="atlas-next-pending"',
  );
  const controlsEnd = viewerSource.indexOf(
    'className={markMode === "coverage"',
    controlsStart,
  );
  const controlsBlock = viewerSource.slice(controlsStart, controlsEnd);

  for (const [start, end] of [
    [selectStart, selectEnd],
    [searchStart, searchEnd],
    [cardinalStart, cardinalEnd],
    [keyboardStart, keyboardEnd],
    [controlsStart, controlsEnd],
  ]) {
    assert.ok(start >= 0 && end > start);
  }
  assert.match(
    selectBlock,
    /const selectAtlasCell = useCallback\([\s\S]*?coverageSelectionForOverviewCellIndex\(index\)[\s\S]*?commitCoverageSelection\(selection, index\)/,
  );
  assert.match(
    cardinalBlock,
    /selectAtlasCell\([\s\S]*?nextRow \* OVERWORLD_OVERVIEW_COLUMNS \+ nextColumn/,
  );
  assert.match(
    searchBlock,
    /if \(atlasMode\)[\s\S]*?if \(selectAtlasCell\(cell\.index\)\)[\s\S]*?seleccionado en el mapa general/,
  );
  assert.match(
    keyboardBlock,
    /event\.shiftKey[\s\S]*?commitCoverageSelection\(selection, nextIndex\)[\s\S]*?else \{[\s\S]*?selectAtlasCell\(nextIndex\)/,
  );
  assert.match(
    controlsBlock,
    /className="atlas-next-pending"[\s\S]*?selectAtlasCell\(atlasNextPending\.index\)/,
  );
  assert.match(
    controlsBlock,
    /Anterior[\s\S]*?selectAtlasCell\([\s\S]*?atlasFocusedCellIndex \+ 1/,
  );
  assert.match(
    controlsBlock,
    /onClick=\{\(\) => selectAtlasCell\(atlasFocusedCellIndex\)\}[\s\S]*?Elegir sector/,
  );
});
