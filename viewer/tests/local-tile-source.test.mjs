import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsAncestorTileFallback,
  resolveAncestorTileCrop,
  TILE_LAYERS,
} from "../app/lib/local-tile-source.ts";

test("only the continuous base layer allows ancestor tile fallback", () => {
  assert.deepEqual(
    Object.fromEntries(
      TILE_LAYERS.map((layer) => [
        layer,
        allowsAncestorTileFallback(layer),
      ]),
    ),
    {
      base: true,
      overlay: false,
      newchunks: false,
    },
  );
});

test("ancestor crops preserve negative tile geometry through the maximum LOD", () => {
  const key = {
    layer: "base",
    lod: 0,
    dimension: "overworld",
    tileX: -129,
    tileZ: 330,
  };
  assert.deepEqual(resolveAncestorTileCrop(key, 1), {
    lod: 1,
    tileX: -65,
    tileZ: 165,
    sourceX: 256,
    sourceZ: 0,
    sourceSize: 256,
  });
  assert.deepEqual(resolveAncestorTileCrop(key, 10), {
    lod: 10,
    tileX: -1,
    tileZ: 0,
    sourceX: 447.5,
    sourceZ: 165,
    sourceSize: 0.5,
  });
  assert.throws(() => resolveAncestorTileCrop(key, 0), /greater than 0/);
  assert.throws(() => resolveAncestorTileCrop(key, 11), /at most 10/);
});
