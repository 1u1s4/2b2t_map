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

test("multi-sector drag commits the latest synchronous selection", () => {
  const pointerDownStart = viewerSource.indexOf("const handlePointerDown");
  const pointerMoveStart = viewerSource.indexOf("const handlePointerMove");
  const pointerUpStart = viewerSource.indexOf("const handlePointerUp");
  const pointerCancelStart = viewerSource.indexOf("const handlePointerCancel");
  const wheelStart = viewerSource.indexOf("const handleWheel");

  for (const [start, end] of [
    [pointerDownStart, pointerMoveStart],
    [pointerMoveStart, pointerUpStart],
    [pointerUpStart, pointerCancelStart],
    [pointerCancelStart, wheelStart],
  ]) {
    assert.ok(start >= 0 && end > start);
  }

  const pointerDownBlock = viewerSource.slice(
    pointerDownStart,
    pointerMoveStart,
  );
  const pointerMoveBlock = viewerSource.slice(
    pointerMoveStart,
    pointerUpStart,
  );
  const pointerUpBlock = viewerSource.slice(pointerUpStart, pointerCancelStart);
  const pointerCancelBlock = viewerSource.slice(pointerCancelStart, wheelStart);

  assert.match(
    viewerSource,
    /const coveragePreviewRef = useRef<OverworldCoverageSelection \| null>\(null\)/,
  );
  assert.match(
    pointerDownBlock,
    /const selection = coverageSelectionBetweenCells\(cell, cell\)[\s\S]*?coveragePreviewRef\.current = selection[\s\S]*?setCoveragePreview\(selection\)/,
  );
  assert.match(
    pointerMoveBlock,
    /const selection = coverageSelectionBetweenCells\([\s\S]*?coverageStartRef\.current,[\s\S]*?cell,[\s\S]*?coveragePreviewRef\.current = selection[\s\S]*?setCoveragePreview\(selection\)/,
  );
  assert.match(
    pointerUpBlock,
    /let selection = coveragePreviewRef\.current[\s\S]*?const endCell = overviewCellAtWorld\(point\.x, point\.z\)[\s\S]*?selection = coverageSelectionBetweenCells\(startCell, endCell\)[\s\S]*?coveragePreviewRef\.current = null[\s\S]*?commitCoverageSelection\(selection\)/,
  );
  assert.doesNotMatch(pointerUpBlock, /const selection = coveragePreview;/);
  assert.match(
    pointerCancelBlock,
    /coverageStartRef\.current = null[\s\S]*?coveragePreviewRef\.current = null/,
  );
});

test("Explore starts and activates the committed Atlas selection", () => {
  const start = viewerSource.indexOf("const startCoverageSelection");
  const end = viewerSource.indexOf("const beginMarkMode", start);
  assert.ok(start >= 0 && end > start);
  const block = viewerSource.slice(start, end);

  assert.match(
    block,
    /const plan = startMaxDetailExploration\(coverageSelection\.bounds, name\)/,
  );
  assert.match(
    block,
    /if \(coverageRegionStatus\.ready\) \{[\s\S]*?activateDownloadedExploration\(plan, coverageRegionStatus\)[\s\S]*?\} else \{[\s\S]*?startRegionDownload\(plan\)/,
  );
});

test("manual bounds invalidate an older Atlas selection", () => {
  const clearStart = viewerSource.indexOf(
    "const clearCoverageSelectionForManualRegion",
  );
  const captureStart = viewerSource.indexOf("const captureRegionBounds");
  const applyStart = viewerSource.indexOf(
    "const applyCoverageSelectionToRegion",
  );
  const currentViewStart = viewerSource.indexOf(
    "const useCurrentViewForRegion",
  );
  const explorationStart = viewerSource.indexOf(
    "const startExploration",
    currentViewStart,
  );

  for (const [start, end] of [
    [clearStart, captureStart],
    [captureStart, applyStart],
    [currentViewStart, explorationStart],
  ]) {
    assert.ok(start >= 0 && end > start);
  }

  const clearBlock = viewerSource.slice(clearStart, captureStart);
  const captureBlock = viewerSource.slice(captureStart, applyStart);
  const currentViewBlock = viewerSource.slice(
    currentViewStart,
    explorationStart,
  );

  assert.match(
    clearBlock,
    /setCoverageSelection\(null\)[\s\S]*?coveragePreviewRef\.current = null[\s\S]*?setRegionStatusSnapshot\(null\)/,
  );
  assert.match(
    captureBlock,
    /clearCoverageSelectionForManualRegion\(\)[\s\S]*?setRegionForm/,
  );
  assert.match(
    currentViewBlock,
    /clearCoverageSelectionForManualRegion\(\)[\s\S]*?setRegionForm/,
  );
  assert.match(
    viewerSource,
    /value=\{regionForm\[field\]\}[\s\S]*?onChange=\{\(event\) => \{[\s\S]*?clearCoverageSelectionForManualRegion\(\)[\s\S]*?\[field\]: event\.target\.value/,
  );
});
