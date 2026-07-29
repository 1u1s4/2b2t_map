import assert from "node:assert/strict";
import test from "node:test";

import {
  HIGHLIGHT_NAME_PRESETS,
  highlightRegionKey,
  highlightsForRegion,
  inferLegacyHighlightRegionKey,
  isHighlightRegionKey,
  nextHighlightPresetName,
  normalizeHighlightName,
} from "../app/lib/highlights.ts";

const regionA = {
  minX: 0,
  minZ: 0,
  maxXExclusive: 512,
  maxZExclusive: 512,
};
const regionB = {
  minX: 512,
  minZ: 0,
  maxXExclusive: 1024,
  maxZExclusive: 512,
};

test("region keys depend on geographic bounds rather than session ids", () => {
  assert.equal(highlightRegionKey(regionA), "0:0:512:512");
  assert.equal(
    highlightRegionKey({ ...regionA }),
    highlightRegionKey(regionA),
  );
  assert.notEqual(highlightRegionKey(regionA), highlightRegionKey(regionB));
  assert.equal(isHighlightRegionKey("-1024:0:1024:512"), true);
  assert.equal(isHighlightRegionKey("region-session-id"), false);
});

test("highlights stay isolated even when scoped points overlap", () => {
  const regionAKey = highlightRegionKey(regionA);
  const overlappingRegion = {
    minX: -256,
    minZ: -256,
    maxXExclusive: 768,
    maxZExclusive: 768,
  };
  const overlappingRegionKey = highlightRegionKey(overlappingRegion);
  const highlights = [
    { id: "a", x: 100, z: 100, regionKey: regionAKey },
    {
      id: "overlap",
      x: 100,
      z: 100,
      regionKey: overlappingRegionKey,
    },
    { id: "global", x: 100, z: 100, regionKey: null },
  ];

  assert.deepEqual(
    highlightsForRegion(highlights, regionA).map(({ id }) => id),
    ["a"],
  );
  assert.deepEqual(
    highlightsForRegion(highlights, overlappingRegion).map(({ id }) => id),
    ["overlap"],
  );
  assert.deepEqual(
    highlightsForRegion(highlights, null).map(({ id }) => id),
    ["global"],
  );
});

test("legacy highlights infer the saved region once and otherwise stay global", () => {
  const inside = { x: 128, z: 256 };
  const outside = { x: -128, z: 256 };

  assert.equal(
    inferLegacyHighlightRegionKey(inside, [regionA]),
    highlightRegionKey(regionA),
  );
  assert.equal(inferLegacyHighlightRegionKey(outside, [regionA]), null);
  assert.equal(
    inferLegacyHighlightRegionKey(
      { ...inside, regionKey: highlightRegionKey(regionB) },
      [regionA],
    ),
    highlightRegionKey(regionB),
  );
});

test("quick highlight names expose presets and validate custom text", () => {
  assert.deepEqual(HIGHLIGHT_NAME_PRESETS, ["Base", "Base D", "Mapa"]);
  assert.equal(normalizeHighlightName("  Portal norte  "), "Portal norte");
  assert.equal(normalizeHighlightName("   "), null);
  assert.equal(normalizeHighlightName("x".repeat(200)), "x".repeat(200));
  assert.equal(normalizeHighlightName("x".repeat(201)), null);
});

test("preset names start at one and advance existing numeric suffixes", () => {
  const regionAKey = highlightRegionKey(regionA);
  const highlights = [
    { title: "Mapa 1", regionKey: regionAKey },
    { title: "Mapa 2", regionKey: regionAKey },
    { title: "Base 7", regionKey: regionAKey },
    { title: "Base D 3", regionKey: regionAKey },
  ];

  assert.equal(nextHighlightPresetName("Mapa", [], regionAKey), "Mapa 1");
  assert.equal(
    nextHighlightPresetName("Mapa", highlights, regionAKey),
    "Mapa 3",
  );
  assert.equal(
    nextHighlightPresetName("Base", highlights, regionAKey),
    "Base 8",
  );
  assert.equal(
    nextHighlightPresetName("Base D", highlights, regionAKey),
    "Base D 4",
  );
});

test("preset numbering only counts highlights in the requested scope", () => {
  const regionAKey = highlightRegionKey(regionA);
  const regionBKey = highlightRegionKey(regionB);
  const highlights = [
    { title: "Mapa 2", regionKey: regionAKey },
    { title: "Mapa 9", regionKey: regionBKey },
    { title: "Mapa 12", regionKey: null },
    { title: "Mapa 15" },
  ];

  assert.equal(
    nextHighlightPresetName("Mapa", highlights, regionAKey),
    "Mapa 3",
  );
  assert.equal(
    nextHighlightPresetName("Mapa", highlights, regionBKey),
    "Mapa 10",
  );
  assert.equal(nextHighlightPresetName("Mapa", highlights, null), "Mapa 16");
  assert.equal(
    nextHighlightPresetName("Mapa", highlights, undefined),
    "Mapa 16",
  );
});

test("preset matching is anchored and accepts legacy unnumbered names", () => {
  const regionAKey = highlightRegionKey(regionA);
  assert.equal(
    nextHighlightPresetName(
      "Mapa",
      [{ title: "Mapa", regionKey: regionAKey }],
      regionAKey,
    ),
    "Mapa 2",
  );

  const highlights = [
    { title: "Mapa", regionKey: regionAKey },
    { title: " mapa 04 ", regionKey: regionAKey },
    { title: "Mapa 3 revisado", regionKey: regionAKey },
    { title: "Mapa -8", regionKey: regionAKey },
    { title: "Base 20", regionKey: regionAKey },
    { title: "Base D 11", regionKey: regionAKey },
  ];

  assert.equal(
    nextHighlightPresetName("Mapa", highlights, regionAKey),
    "Mapa 5",
  );
  assert.equal(
    nextHighlightPresetName("Base", highlights, regionAKey),
    "Base 21",
  );
  assert.equal(
    nextHighlightPresetName("Base D", highlights, regionAKey),
    "Base D 12",
  );
});

test("preset numbering advances past gaps and is shared by pins and areas", () => {
  const regionAKey = highlightRegionKey(regionA);
  const highlights = [
    { title: "Base 2", regionKey: regionAKey, type: "pin" },
    { title: "Base 7", regionKey: regionAKey, type: "area" },
  ];

  assert.equal(
    nextHighlightPresetName("Base", highlights, regionAKey),
    "Base 8",
  );
});
