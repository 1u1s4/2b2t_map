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
const highlightRouteWorkerSource = await readFile(
  new URL(
    "../app/lib/highlight-route.worker.ts",
    import.meta.url,
  ),
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

test("exploration magnifier uses a passive circular tile render and the L shortcut", () => {
  assert.match(
    viewerSource,
    /\(event\.key === "l" \|\| event\.key === "L"\)[\s\S]*?!event\.altKey[\s\S]*?!event\.ctrlKey[\s\S]*?!event\.metaKey[\s\S]*?!event\.shiftKey[\s\S]*?isExploring[\s\S]*?toggleMagnifier\(\)/,
  );
  assert.match(
    viewerSource,
    /const interactiveTarget[\s\S]*?if \(interactiveTarget\)[\s\S]*?return;[\s\S]*?event\.key === "l"/,
  );
  assert.match(viewerSource, /aria-keyshortcuts="L"/);
  assert.match(viewerSource, /aria-pressed=\{magnifierEnabled\}/);
  assert.match(viewerSource, /id="map-magnifier-help"/);
  assert.match(
    viewerSource,
    /className="map-magnifier"[\s\S]*?ref=\{magnifierCanvasRef\}/,
  );
  assert.match(
    viewerSource,
    /const drawMapTile[\s\S]*?context\.drawImage\([\s\S]*?record\.bitmap/,
  );
  assert.match(
    viewerSource,
    /const destinationSize = tileSpan \* magnifierRenderScale[\s\S]*?drawMapTile\(context, key, destination, destinationSize\)/,
  );
  assert.match(
    viewerSource,
    /MAGNIFIER_MAX_RENDER_SCALE = MAX_SCALE \* MAGNIFIER_SCALE_FACTOR[\s\S]*?Math\.min\(\s*MAGNIFIER_MAX_RENDER_SCALE/,
  );
  assert.match(
    viewerSource,
    /scheduleMagnifierPosition[\s\S]*?requestAnimationFrame[\s\S]*?lensX: clamp\([\s\S]*?lensY: clamp\(/,
  );
  assert.match(
    viewerSource,
    /canvas\.width !== backingSize[\s\S]*?canvas\.width = backingSize/,
  );
  assert.match(
    viewerSource,
    /visibleWorldBounds[\s\S]*?drawHighlightRouteSegments\([\s\S]*?visibleWorldBounds[\s\S]*?renderMargin/,
  );
  assert.match(
    viewerSource,
    /left: magnifierPosition\.lensX[\s\S]*?top: magnifierPosition\.lensY/,
  );
  assert.match(
    styles,
    /\.map-magnifier\s*\{[\s\S]*?border-radius:\s*50%[\s\S]*?pointer-events:\s*none/,
  );
  assert.match(
    viewerSource,
    /magnifierEnabled && isExploring \? "is-magnifier-active" : ""/,
  );
  assert.match(
    styles,
    /\.atlas-shell\.is-magnifier-active \.map-canvas,[\s\S]*?cursor:\s*none/,
  );
  assert.doesNotMatch(viewerSource, /map-magnifier-reticle/);
  assert.doesNotMatch(styles, /\.map-magnifier-reticle/);
  assert.match(
    viewerSource,
    /const toggleMagnifier[\s\S]*?lastMagnifierPositionRef\.current \?\?[\s\S]*?scheduleMagnifierPosition/,
  );
  assert.match(
    viewerSource,
    /lastMagnifierPositionRef\.current =[\s\S]*?if \(magnifierEnabled && isExploring\)/,
  );
  assert.match(viewerSource, /onPointerLeave=\{leaveMagnifier\}/);
  assert.match(
    viewerSource,
    /event\.key === "m" \|\| event\.key === "M"[\s\S]*?beginMarkMode\("pin"\)/,
  );
  assert.match(
    viewerSource,
    /<Shortcut keys="L" label="Activar o desactivar lupa" \/>/,
  );
});

test("sparse layers never stretch an ancestor tile over missing detail", () => {
  const rendererStart = viewerSource.indexOf("const drawMapTile");
  const rendererEnd = viewerSource.indexOf(
    "useEffect(() => {",
    rendererStart,
  );
  const renderer = viewerSource.slice(rendererStart, rendererEnd);

  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  assert.match(
    viewerSource,
    /allowsAncestorTileFallback,[\s\S]*?from "\.\/lib\/local-tile-source"/,
  );
  assert.match(
    renderer,
    /if \(!allowsAncestorTileFallback\(key\.layer\)\) \{\s*return null;\s*\}[\s\S]*?for \([\s\S]*?fallbackLod/,
  );
  assert.match(
    renderer,
    /fallbackLod <= MAX_TILE_LOD[\s\S]*?resolveAncestorTileCrop\(key, fallbackLod\)/,
  );
  assert.match(
    viewerSource,
    /className="fallback-badge glass-card"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
  );
});

test("highlight analysis is non-blocking with a selectable start and labeled exports", () => {
  assert.match(
    highlightRouteWorkerSource,
    /planHighlightRoute\(request\.points,\s*request\.bounds,[\s\S]*?startHighlightId: request\.startHighlightId/,
  );
  assert.doesNotMatch(viewerSource, /planHighlightRoute\(/);
  assert.match(
    viewerSource,
    /new Worker\([\s\S]*?highlight-route\.worker\.ts[\s\S]*?worker\.terminate\(\)/,
  );
  assert.match(
    viewerSource,
    /if \(highlightRouteRequestMatchesCurrent\) return;[\s\S]*?new Worker\(/,
  );
  assert.match(
    viewerSource,
    /scopedHighlights\.map\(\(\{ id, x, z \}\) => \(\{ id, x, z \}\)\)/,
  );
  assert.match(
    viewerSource,
    /Calculando en segundo plano…[\s\S]*?Puedes seguir usando el mapa/,
  );
  assert.match(
    viewerSource,
    /Filtrar por nombre, ID o coordenadas[\s\S]*?id="highlight-route-start"[\s\S]*?value=\{validHighlightRouteStartId \?\? ""\}[\s\S]*?<option value="">[\s\S]*?Automático · esquina superior izquierda[\s\S]*?highlightRouteStartOptions\.map/,
  );
  assert.doesNotMatch(viewerSource, /__auto__/);
  assert.match(
    viewerSource,
    /MAX_HIGHLIGHT_ROUTE_START_OPTIONS = 200[\s\S]*?options\.length >= MAX_HIGHLIGHT_ROUTE_START_OPTIONS/,
  );
  assert.match(
    viewerSource,
    /coordinateCounts[\s\S]*?coordinateCount > 1[\s\S]*?offsetDistance/,
  );
  assert.match(
    viewerSource,
    /drawHighlightRouteSegments\([\s\S]*?drawHighlightRouteMarkers\(/,
  );
  assert.match(
    viewerSource,
    /highlight-route-card[\s\S]*?Calcular y superponer ruta/,
  );
  assert.match(
    viewerSource,
    /createHighlightRouteExport\(highlightRoute\)[\s\S]*?obsidian-atlas-ruta-highlights\.json/,
  );
  assert.match(
    viewerSource,
    /toBlob\([\s\S]*?obsidian-atlas-ruta-vista\.png/,
  );
  assert.match(
    viewerSource,
    /const prepareHighlightRouteXaeroExport[\s\S]*?const activeRegionScopeId = highlightRegionScopeId\([\s\S]*?highlightRegionKey\(activeExplorationRegion\.bounds\)[\s\S]*?operation: "export"[\s\S]*?explorationId: activeRegionScopeId[\s\S]*?prepareXaeroOperation\(request\)/,
  );
  assert.match(
    viewerSource,
    /const routeWaypointTitles = new Map\([\s\S]*?stop\.highlight\.type === "pin"[\s\S]*?highlightRouteWaypointTitle\([\s\S]*?stop\.order,[\s\S]*?stop\.highlight\.title/,
  );
  assert.match(
    viewerSource,
    /const nextContent: LocalAtlasWorkspaceContent =[\s\S]*?highlights: renamedHighlights[\s\S]*?workspaceContentRef\.current = nextContent[\s\S]*?journalWorkspace\(nextContent\)[\s\S]*?setHighlights\(renamedHighlights\)[\s\S]*?prepareXaeroOperation\(request\)/,
  );
  assert.doesNotMatch(viewerSource, /const activeXaeroRegion\s*=/);
  assert.match(
    viewerSource,
    /if \(activeExplorationRegion && activeHighlightRegionKey\)[\s\S]*?optionsByRegionKey\.set\(activeHighlightRegionKey,[\s\S]*?id: highlightRegionScopeId\(activeHighlightRegionKey\)[\s\S]*?name: activeExplorationRegion\.name/,
  );
  assert.match(
    viewerSource,
    /if \(!activeHighlightRegionKey\) return;[\s\S]*?const explorationId = highlightRegionScopeId\(activeHighlightRegionKey\)[\s\S]*?chooseXaeroScope\(\{ kind: "exploration", explorationId \}\)[\s\S]*?invalidateXaeroPreview\(\)/,
  );
  assert.match(
    viewerSource,
    /preview\.operation !== request\.operation[\s\S]*?preview\.scope !== request\.scope\.kind[\s\S]*?preview\.explorationId !== expectedExplorationId[\s\S]*?alcance distinto al solicitado/,
  );
  assert.match(
    viewerSource,
    /const previewRequestId = xaeroPreviewRequestIdRef\.current \+ 1[\s\S]*?xaeroPreviewRequestIdRef\.current !== previewRequestId[\s\S]*?readLocalAtlasXaeroPreview\(request\)[\s\S]*?xaeroPreviewRequestIdRef\.current !== previewRequestId/,
  );
  assert.match(
    viewerSource,
    /Ver ruta completa[\s\S]*?Renombrar y exportar a Xaero[\s\S]*?Atlas guardará los puntos como A · Nombre, B ·[\s\S]*?abrirá la vista previa de Xaero/,
  );
  assert.match(
    styles,
    /\.highlight-route-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*auto/,
  );
});

test("exploration can fit the active region without loading every LOD 0 cell", () => {
  assert.match(
    viewerSource,
    /const explorationUsesOverviewTiles[\s\S]*?scale < explorationMinimumScale/,
  );
  assert.match(
    viewerSource,
    /const lod =[\s\S]*?explorationUsesOverviewTiles[\s\S]*?MAX_TILE_LOD[\s\S]*?explorationState\.region\.lod/,
  );
  assert.match(
    viewerSource,
    /const fitActiveExploration[\s\S]*?setDrawer\(null\)[\s\S]*?mode: "overview"/,
  );
  assert.match(
    viewerSource,
    /aria-label="Encuadrar región activa"[\s\S]*?onClick=\{fitActiveExploration\}/,
  );
  assert.match(
    viewerSource,
    /if \(explorationOverview\)[\s\S]*?strokeRect\([\s\S]*?currentCell[\s\S]*?else \{[\s\S]*?cellIndexAtTile/,
  );
  assert.match(
    viewerSource,
    /const magnifierLod = explorationState\.region\.lod[\s\S]*?lod: magnifierLod/,
  );
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

test("Atlas sectors expose durable Minecraft completion with a blue overlay", () => {
  assert.match(
    viewerSource,
    /const \[minecraftExploredSectorIds, setMinecraftExploredSectorIds\][\s\S]*?useState<readonly string\[\]>/,
  );
  assert.match(
    viewerSource,
    /const workspaceContent = useMemo<LocalAtlasWorkspaceContent>[\s\S]*?minecraftExploredSectorIds/,
  );
  assert.match(
    viewerSource,
    /setMinecraftExploredSectorIds\(\[[\s\S]*?canonical\.minecraftExploredSectorIds/,
  );
  assert.match(
    viewerSource,
    /if \(localId === currentId\)[\s\S]*?minecraftExploredSectorIds:[\s\S]*?localCanonical\.minecraftExploredSectorIds/,
  );

  const toggleStart = viewerSource.indexOf(
    "const toggleFocusedMinecraftExploredSector",
  );
  const toggleEnd = viewerSource.indexOf("const fitAtlasView", toggleStart);
  const toggleBlock = viewerSource.slice(toggleStart, toggleEnd);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  assert.match(
    toggleBlock,
    /withMinecraftExploredSector\([\s\S]*?minecraftExploredSectorIds: nextSectorIds[\s\S]*?workspaceContentRef\.current = nextContent[\s\S]*?journalWorkspace\(nextContent\)[\s\S]*?setMinecraftExploredSectorIds/,
  );

  assert.match(
    viewerSource,
    /const exploredInMinecraft =[\s\S]*?minecraftExploredSectorIdSet\.has\(cell\.id\)[\s\S]*?if \(exploredInMinecraft\)[\s\S]*?rgba\(37, 99, 235, 0\.38\)[\s\S]*?fillText\("✓"/,
  );
  assert.match(
    viewerSource,
    /className=\{`atlas-minecraft-toggle[\s\S]*?aria-pressed=\{atlasFocusedMinecraftExplored\}[\s\S]*?onClick=\{toggleFocusedMinecraftExploredSector\}[\s\S]*?Marcar explorado en Minecraft/,
  );
  assert.match(
    styles,
    /\.atlas-sector-actions \.atlas-minecraft-toggle[\s\S]*?grid-column:\s*1 \/ -1/,
  );
  assert.match(
    styles,
    /\.atlas-sector-actions \.atlas-minecraft-toggle\.minecraft-explored[\s\S]*?rgba\(37, 99, 235, 0\.32\)/,
  );
});
