import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMapZoom,
  resolveAtlasExitView,
  resolveExplorationFocusView,
} from "../app/lib/exploration-camera.ts";
import {
  createMaxDetailExplorationState,
  minimumSafeExplorationScale,
  withVisitedIndex,
} from "../app/lib/exploration-grid.ts";

function exploration() {
  return createMaxDetailExplorationState({
    id: "camera-navigation",
    name: "Navegación con zoom",
    bounds: {
      minX: 0,
      minZ: 0,
      maxXExclusive: 3 * 512,
      maxZExclusive: 2 * 512,
    },
  });
}

test("navigation preserves the exact user zoom while recentering", () => {
  const state = withVisitedIndex(exploration(), 1);
  const view = resolveExplorationFocusView(
    state,
    { width: 1_440, height: 900 },
    { mode: "preserve", scale: 1.7612 },
  );

  assert.equal(view.scale, 1.7612);
  assert.deepEqual(view.camera, { x: 768, z: 256 });
});

test("initial activation still fits desktop and mobile viewports", () => {
  const state = exploration();
  const desktop = resolveExplorationFocusView(
    state,
    { width: 1_440, height: 900 },
    { mode: "fit" },
  );
  const mobile = resolveExplorationFocusView(
    state,
    { width: 640, height: 480 },
    { mode: "fit" },
  );

  assert.equal(desktop.scale, 1);
  assert.deepEqual(desktop.camera, { x: 256, z: 256 });
  assert.equal(mobile.scale, 260 / 512);
  assert.deepEqual(mobile.camera, { x: 256, z: 256 });
});

test("preserved exploration zoom remains inside safe limits", () => {
  const state = exploration();
  const viewport = { width: 1_440, height: 900 };
  const minimum = minimumSafeExplorationScale(
    state.region.tileSpan,
    viewport,
  );

  assert.equal(
    resolveExplorationFocusView(
      state,
      viewport,
      { mode: "preserve", scale: 100 },
    ).scale,
    8,
  );
  assert.equal(
    resolveExplorationFocusView(
      state,
      viewport,
      { mode: "preserve", scale: 0.00001 },
    ).scale,
    minimum,
  );
  assert.throws(
    () =>
      resolveExplorationFocusView(
        state,
        viewport,
        { mode: "preserve", scale: Number.NaN },
      ),
    /must be positive/,
  );
});

test("leaving the initial atlas restores a useful detailed view", () => {
  const fallback = {
    camera: { x: -85_181, z: 168_232 },
    scale: 2.9423,
  };
  assert.deepEqual(resolveAtlasExitView(null, false, fallback), fallback);
  assert.equal(resolveAtlasExitView(null, true, fallback), null);
  assert.deepEqual(
    resolveAtlasExitView(
      {
        camera: { x: -146_742, z: 148_203 },
        scale: 1.7612,
      },
      false,
      fallback,
    ),
    {
      camera: { x: -146_742, z: 148_203 },
      scale: 1.7612,
    },
  );
});

test("zoom labels keep sub-percent scales visible", () => {
  assert.equal(formatMapZoom(1.7612), "1.76");
  assert.equal(formatMapZoom(0.0054), "0.005");
  assert.equal(formatMapZoom(1 / 1_500), "0.0007");
  assert.equal(formatMapZoom(Number.NaN), "—");
});
