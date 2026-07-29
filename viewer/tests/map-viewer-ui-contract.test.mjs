import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewerSource = await readFile(
  new URL("../app/map-viewer.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("canvas exposes an accessible right-click highlight menu", () => {
  assert.match(viewerSource, /onContextMenu=\{handleContextMenu\}/);
  assert.match(
    viewerSource,
    /const handleContextMenu[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(viewerSource, /role="menu"/);
  assert.match(viewerSource, /role="menuitem"/);
  assert.match(viewerSource, /Agregar highlight rápido/);
  assert.match(viewerSource, /Otro nombre…/);
  assert.match(
    viewerSource,
    /quickHighlightPresetNames\.map\([\s\S]*?saveQuickHighlight\(title\)/,
  );
  assert.match(
    viewerSource,
    /selectedHighlightPresetNames\.map\([\s\S]*?updateSelectedHighlight\(\{ title \}\)/,
  );
});

test("atlas renders every highlight as a compact overview dot", () => {
  const renderStart = viewerSource.indexOf(
    "for (const highlight of renderedHighlights)",
  );
  const renderEnd = viewerSource.indexOf("if (areaPreview)", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderBlock = viewerSource.slice(renderStart, renderEnd);

  assert.match(
    viewerSource,
    /const renderedHighlights = atlasMode \? highlights : scopedHighlights/,
  );
  assert.match(
    renderBlock,
    /if \(atlasMode\)[\s\S]*?screenAtWorld\(highlight\.x, highlight\.z\)[\s\S]*?fillRect\([\s\S]*?3,\s*3,[\s\S]*?continue;[\s\S]*?if \(compactHighlights\)/,
  );
  assert.ok(
    renderBlock.indexOf("if (!highlight.visible) continue") <
      renderBlock.indexOf("if (atlasMode)"),
  );
  assert.ok(
    renderBlock.indexOf("if (atlasMode)") <
      renderBlock.indexOf('highlight.type === "area"'),
  );
  assert.match(
    viewerSource,
    /const selected = !atlasMode && highlight\.id === selectedHighlightId/,
  );
  assert.match(
    viewerSource,
    /const hitHighlight[\s\S]*?return \[\.\.\.scopedHighlights\]/,
  );
});

test("exploration header hides by default and reveals by proximity or focus", () => {
  assert.match(viewerSource, /isExploring \? "is-exploring" : ""/);
  assert.match(viewerSource, /onPointerMoveCapture=\{handleShellPointerMove\}/);
  assert.match(
    styles,
    /\.atlas-shell\.is-exploring \.topbar > \*[\s\S]*?opacity:\s*0/,
  );
  assert.match(
    styles,
    /\.atlas-shell\.is-exploring\.is-topbar-revealed \.topbar > \*/,
  );
  assert.match(
    styles,
    /\.atlas-shell\.is-exploring \.topbar:focus-within > \*/,
  );
  assert.match(styles, /\.topbar-touch-toggle/);
});

test("floating side and lower-right panels use the compact layout", () => {
  assert.match(
    styles,
    /\.side-drawer[\s\S]*?width:\s*clamp\(360px,\s*29vw,\s*398px\)/,
  );
  assert.match(
    styles,
    /\.exploration-navigation[\s\S]*?width:\s*204px/,
  );
  assert.match(styles, /\.zoom-stack[\s\S]*?width:\s*46px/);
});

test("bottom controls omit the dimension teaser and never overlap", () => {
  assert.doesNotMatch(viewerSource, /dimension-pill/);
  assert.doesNotMatch(viewerSource, /Nether y End próximamente/);
  assert.doesNotMatch(styles, /\.dimension-pill/);
  assert.match(
    styles,
    /\.atlas-shell\.is-exploring \.fallback-badge\s*\{[\s\S]*?bottom:\s*231px/,
  );
});

test("exploration drawer omits the duplicated navigation pad", () => {
  assert.doesNotMatch(viewerSource, /direction-pad-inline/);
  assert.doesNotMatch(viewerSource, /Mover a una celda vecina/);
  assert.doesNotMatch(styles, /\.direction-pad-inline/);
  assert.doesNotMatch(styles, /\.direction-pad-hint/);
  assert.match(
    viewerSource,
    /className="exploration-navigation glass-card"[\s\S]*?aria-label="Navegación por celdas"[\s\S]*?className="direction-pad"/,
  );
});

test("visited cells use verified green while the active cell stays clear", () => {
  const paletteStart = viewerSource.indexOf(
    "const EXPLORATION_CELL_VISUALS",
  );
  const paletteEnd = viewerSource.indexOf(
    "const LEGACY_HIGHLIGHT_STORAGE_KEY",
    paletteStart,
  );
  const palette = viewerSource.slice(paletteStart, paletteEnd);

  assert.ok(paletteStart >= 0 && paletteEnd > paletteStart);
  assert.match(
    palette,
    /"current-reviewed":\s*\{[\s\S]*?fill:\s*"rgba\(0, 0, 0, 0\)"[\s\S]*?stroke:\s*"rgba\(74, 222, 128, 0\.98\)"[\s\S]*?glow:\s*"rgba\(74, 222, 128, 0\.92\)"/,
  );
  assert.match(
    palette,
    /reviewed:\s*\{[\s\S]*?fill:\s*"rgba\(34, 197, 94, 0\.18\)"[\s\S]*?stroke:\s*"rgba\(74, 222, 128, 0\.84\)"/,
  );
  assert.doesNotMatch(palette, /rgba\(98, 168, 255, 0\.20\)/);
  assert.match(
    viewerSource,
    /const visual = EXPLORATION_CELL_VISUALS\[appearance\][\s\S]*?context\.fillStyle = visual\.fill[\s\S]*?context\.strokeStyle = visual\.stroke/,
  );
  assert.match(
    viewerSource,
    /if \(visual\.glow\) \{[\s\S]*?context\.shadowColor = visual\.glow[\s\S]*?context\.shadowBlur = 16/,
  );
});
