"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AreaChart,
  Check,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Grid3X3,
  HardDrive,
  HelpCircle,
  Layers3,
  Link2,
  ListFilter,
  LockKeyhole,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minus,
  MousePointer2,
  Navigation,
  Plus,
  RotateCcw,
  Route,
  Search,
  ScanSearch,
  Sparkles,
  SquareDashedMousePointer,
  SquareMousePointer,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  allowsAncestorTileFallback,
  blocksPerPixelAtLod,
  blocksPerTileAtLod,
  createLocalTileSource,
  getFileSystemAccessSupport,
  LocalTileSource,
  MAX_TILE_LOD,
  pickTileArchiveDirectory,
  resolveAncestorTileCrop,
  type TileKey,
  type TileLayer,
} from "./lib/local-tile-source";
import {
  formatMapZoom,
  resolveAtlasExitView,
  resolveExplorationFocusView,
  type ExplorationFocusRequest,
} from "./lib/exploration-camera";
import { resolveExplorationSelection } from "./lib/exploration-session-selection";
import {
  HIGHLIGHT_NAME_PRESETS,
  highlightRegionKey,
  highlightsForRegion,
  inferLegacyHighlightRegionKey,
  isHighlightRegionKey,
  nextHighlightPresetName,
  normalizeHighlightName,
  pointIsInsideBounds,
} from "./lib/highlights";
import {
  createHighlightRouteExport,
  type HighlightRoutePlan,
  type HighlightRoutePoint,
  type HighlightRouteOverlay,
} from "./lib/highlight-route";
import type {
  HighlightRouteWorkerRequest,
  HighlightRouteWorkerResponse,
} from "./lib/highlight-route-worker-protocol";
import {
  cardinalNeighbor,
  clampCameraToExploration,
  cellForIndex,
  cellIndexAtTile,
  cellIndexAtWorld,
  createMaxDetailExplorationState,
  deserializeExplorationState,
  explorationCellAppearance,
  isCellReviewed,
  isCellSkipped,
  MAX_DETAIL_EXPLORATION_LOD,
  MAX_EXPLORATION_CELLS,
  minimumSafeExplorationScale,
  moveCurrentCardinal,
  serializeExplorationState,
  withCellsSkipped,
  withCurrentCellVisited,
  withVisitedIndex,
  type CardinalDirection,
  type ExplorationCellAppearance,
  type ExplorationState,
  type WorldBounds,
} from "./lib/exploration-grid";
import {
  OVERWORLD_OBSERVED_DATA_BOUNDS,
  OVERWORLD_OVERVIEW_CELL_BLOCKS,
  OVERWORLD_OVERVIEW_CELL_COUNT,
  OVERWORLD_OVERVIEW_COLUMNS,
  OVERWORLD_OVERVIEW_GRID_BOUNDS,
  OVERWORLD_OVERVIEW_ROWS,
  coverageSelectionBetweenCells,
  coverageSelectionForOverviewCellIndex,
  overviewCellAtWorld,
  overviewCellForIndex,
  type OverworldCoverageSelection,
  type OverworldOverviewCell,
} from "./lib/overworld-coverage";
import {
  summarizeLocalCoverage,
  type OverworldProgressStatus,
} from "./lib/overworld-progress";
import {
  applyLocalAtlasXaeroPreview,
  downloadExplorationRegion,
  LocalAtlasWorkspaceConflictError,
  localAtlasWorkspaceContent,
  parseLocalAtlasWorkspaceContent,
  readLocalAtlasCoverage,
  readLocalAtlasRegionStatus,
  readLocalAtlasRuntime,
  readLocalAtlasWorkspace,
  readLocalAtlasXaeroPreview,
  regionJobMatchesBounds,
  stopLocalRegionJob,
  writeLocalAtlasWorkspace,
  type LocalAtlasRegionStatus,
  type LocalAtlasRuntime,
  type LocalAtlasCoverageSnapshot,
  type LocalAtlasWorkspace,
  type LocalAtlasWorkspaceContent,
  type LocalAtlasWorkspaceExploration,
  type LocalAtlasWorkspacePrecondition,
  type LocalAtlasXaeroOperation,
  type LocalAtlasXaeroPreview,
  type LocalAtlasXaeroRequest,
  type LocalAtlasXaeroResult,
  type LocalAtlasXaeroScope,
} from "./lib/local-atlas-runtime";
import {
  consolidateSingleWorkspaceContent,
  mergeMatchingWorkspaceProgress,
  mergeWorkspaceContentCandidates,
} from "./lib/single-workspace-session";
import {
  cancelWorkspaceAutosave,
  scheduleWorkspaceAutosave,
} from "./lib/workspace-autosave";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const INITIAL_CAMERA = { x: -85_181, z: 168_232 };
const INITIAL_SCALE = 2.9423;
const INITIAL_VIEW_SIZE = { width: 1280, height: 760 };
const MIN_SCALE = 1 / 1_500;
const ATLAS_MIN_SCALE = 1 / 10_000;
const MAX_SCALE = 8;
const HIGHLIGHT_COMPACT_SCALE = 1 / 32;
const MAGNIFIER_SIZE = 240;
const MAGNIFIER_SCALE_FACTOR = 5;
const MAGNIFIER_MIN_RENDER_SCALE = 1;
const MAGNIFIER_MAX_RENDER_SCALE = MAX_SCALE * MAGNIFIER_SCALE_FACTOR;
const MAGNIFIER_EDGE_GAP = 10;
const REGIONAL_REQUESTS_PER_SECOND = 16;
const MAX_WORKSPACE_EXPLORATIONS = 1;
const MAX_WORKSPACE_HIGHLIGHTS = 10_000;
const MAX_VISIBLE_ROUTE_STOPS = 500;
const MAX_HIGHLIGHT_ROUTE_START_OPTIONS = 200;
const EXPLORATION_CELL_VISUALS = {
  "current-new": {
    fill: "rgba(0, 0, 0, 0)",
    stroke: "rgba(133, 196, 255, 0.95)",
    label: "rgba(224, 242, 255, 0.98)",
    glow: null,
  },
  "current-reviewed": {
    fill: "rgba(0, 0, 0, 0)",
    stroke: "rgba(74, 222, 128, 0.98)",
    label: "rgba(209, 250, 229, 0.98)",
    glow: "rgba(74, 222, 128, 0.92)",
  },
  reviewed: {
    fill: "rgba(34, 197, 94, 0.18)",
    stroke: "rgba(74, 222, 128, 0.84)",
    label: "rgba(209, 250, 229, 0.92)",
    glow: null,
  },
  pending: {
    fill: "rgba(4, 11, 20, 0.05)",
    stroke: "rgba(255, 255, 255, 0.24)",
    label: "rgba(232, 240, 248, 0.72)",
    glow: null,
  },
} satisfies Record<
  ExplorationCellAppearance,
  { fill: string; stroke: string; label: string; glow: string | null }
>;
const LEGACY_HIGHLIGHT_STORAGE_KEY = "obsidian-atlas-highlights-v1";
const LEGACY_EXPLORATION_STORAGE_KEY = "obsidian-atlas-exploration-v1";
const LEGACY_SAVED_EXPLORATIONS_STORAGE_KEY =
  "obsidian-atlas-saved-explorations-v1";
const WORKSPACE_RECOVERY_STORAGE_KEY =
  "obsidian-atlas-workspace-recovery-v1";
const LEGACY_WORKSPACE_RECOVERY_STORAGE_PREFIX =
  "obsidian-atlas-workspace-recovery-v1:";
const LEGACY_COVERAGE_SELECTION_STORAGE_KEY =
  "obsidian-atlas-overworld-selection-v1";
const COLORS = ["#ff5f57", "#ffbd4a", "#26d9c7", "#62a8ff", "#c58cff"];
const REGIONAL_DOWNLOAD_LAYERS = [
  "base",
  "overlay",
  "newchunks",
] as const satisfies readonly TileLayer[];

type Drawer =
  | "atlas"
  | "layers"
  | "exploration"
  | "highlights"
  | "help"
  | null;
type MarkMode = "pin" | "area" | "region" | "coverage" | null;
type AtlasStatusFilter = "all" | OverworldProgressStatus;

type Camera = {
  x: number;
  z: number;
};

type LayerState = {
  id: TileLayer;
  label: string;
  detail: string;
  visible: boolean;
  opacity: number;
  swatch: string;
};

type Highlight = {
  id: string;
  type: "pin" | "area";
  title: string;
  note: string;
  color: string;
  regionKey?: string | null;
  x: number;
  z: number;
  bounds?: {
    x1: number;
    z1: number;
    x2: number;
    z2: number;
  };
  visible: boolean;
  createdAt: string;
};

type HighlightRouteComputation =
  | { readonly status: "idle" }
  | {
      readonly status: "calculating";
      readonly requestId: number;
      readonly geometryJson: string;
      readonly regionBoundsKey: string;
      readonly requestedStartHighlightId: string | null;
    }
  | {
      readonly status: "ready";
      readonly requestId: number;
      readonly geometryJson: string;
      readonly regionBoundsKey: string;
      readonly requestedStartHighlightId: string | null;
      readonly plan: HighlightRoutePlan<HighlightRoutePoint>;
    }
  | {
      readonly status: "error";
      readonly requestId: number;
      readonly geometryJson: string;
      readonly regionBoundsKey: string;
      readonly requestedStartHighlightId: string | null;
      readonly message: string;
    };

type TileRecord = {
  status: "loading" | "loaded" | "missing" | "error";
  bitmap?: ImageBitmap;
  source?: "local";
};

type TileStats = {
  local: number;
  missing: number;
};

type ExplorationPlan = {
  readonly state: ExplorationState;
  readonly source:
    | "new"
    | "restored"
    | "hydrated"
    | "imported"
    | "legacy";
  readonly reveal: boolean;
};

type RegionStatusSnapshot = {
  readonly key: string;
  readonly status: LocalAtlasRegionStatus;
};

type PersistenceState =
  | "checking"
  | "saving"
  | "saved"
  | "readonly"
  | "offline"
  | "error";

type ActivePointer = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

type MagnifierPosition = {
  readonly x: number;
  readonly y: number;
  readonly lensX: number;
  readonly lensY: number;
  readonly visible: boolean;
};

type QuickHighlightMenu = {
  readonly left: number;
  readonly top: number;
  readonly point: Camera;
  readonly custom: boolean;
  readonly customName: string;
};

type BrowserWorkspaceRecovery = {
  readonly version: 1;
  readonly dirty: true;
  readonly updatedAt: string;
  readonly base: LocalAtlasWorkspacePrecondition | null;
  readonly content: LocalAtlasWorkspaceContent;
  readonly storageKey: string;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function boundsKey(bounds: WorldBounds): string {
  return [
    bounds.minX,
    bounds.minZ,
    bounds.maxXExclusive,
    bounds.maxZExclusive,
  ].join(":");
}

function parseBrowserWorkspaceRecovery(
  value: unknown,
  storageKey: string,
): BrowserWorkspaceRecovery | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.dirty !== true) return null;
  const updatedAt =
    typeof candidate.updatedAt === "string" &&
    Number.isFinite(new Date(candidate.updatedAt).getTime())
      ? candidate.updatedAt
      : "1970-01-01T00:00:00.000Z";
  const content = parseLocalAtlasWorkspaceContent(candidate.content);
  if (!content) return null;
  let base: LocalAtlasWorkspacePrecondition | null = null;
  if (candidate.base !== null) {
    if (
      typeof candidate.base !== "object" ||
      Array.isArray(candidate.base)
    ) {
      return null;
    }
    const rawBase = candidate.base as Record<string, unknown>;
    if (
      typeof rawBase.workspaceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        rawBase.workspaceId,
      ) ||
      typeof rawBase.revision !== "number" ||
      !Number.isSafeInteger(rawBase.revision) ||
      rawBase.revision < 0
    ) {
      return null;
    }
    base = {
      workspaceId: rawBase.workspaceId,
      revision: rawBase.revision,
    };
  }
  return {
    version: 1,
    dirty: true,
    updatedAt,
    base,
    content,
    storageKey,
  };
}

function readRecoveryAtKey(
  storageKey: string,
): BrowserWorkspaceRecovery | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored
      ? parseBrowserWorkspaceRecovery(
          JSON.parse(stored) as unknown,
          storageKey,
        )
      : null;
  } catch {
    return null;
  }
}

function readBrowserWorkspaceRecoveries(): BrowserWorkspaceRecovery[] {
  const candidates: BrowserWorkspaceRecovery[] = [];
  const primary = readRecoveryAtKey(WORKSPACE_RECOVERY_STORAGE_KEY);
  if (primary) candidates.push(primary);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (
        !storageKey ||
        !storageKey.startsWith(LEGACY_WORKSPACE_RECOVERY_STORAGE_PREFIX)
      ) {
        continue;
      }
      const recovery = readRecoveryAtKey(storageKey);
      if (recovery) candidates.push(recovery);
    }
  } catch {
    // The fixed recovery is sufficient when storage enumeration fails.
  }
  return candidates.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function readBrowserWorkspaceRecovery(): BrowserWorkspaceRecovery | null {
  return readBrowserWorkspaceRecoveries()[0] ?? null;
}

function writeBrowserWorkspaceRecovery(
  content: LocalAtlasWorkspaceContent,
  base: LocalAtlasWorkspacePrecondition | null,
): boolean {
  try {
    const recovery = {
      version: 1,
      dirty: true,
      updatedAt: new Date().toISOString(),
      base,
      content,
    } as const;
    window.localStorage.setItem(
      WORKSPACE_RECOVERY_STORAGE_KEY,
      JSON.stringify(recovery),
    );
    return true;
  } catch {
    return false;
  }
}

function clearLegacyBrowserWorkspaceCaches() {
  try {
    const candidateKeys = new Set<string>([WORKSPACE_RECOVERY_STORAGE_KEY]);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (
        storageKey?.startsWith(
          LEGACY_WORKSPACE_RECOVERY_STORAGE_PREFIX,
        )
      ) {
        candidateKeys.add(storageKey);
      }
    }
    for (const storageKey of candidateKeys) {
      window.localStorage.removeItem(storageKey);
    }
    for (const storageKey of [
      LEGACY_HIGHLIGHT_STORAGE_KEY,
      LEGACY_EXPLORATION_STORAGE_KEY,
      LEGACY_SAVED_EXPLORATIONS_STORAGE_KEY,
      LEGACY_COVERAGE_SELECTION_STORAGE_KEY,
    ]) {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // The canonical disk workspace remains safe if browser cleanup is blocked.
  }
}

function clearBrowserWorkspaceRecovery() {
  try {
    window.localStorage.removeItem(WORKSPACE_RECOVERY_STORAGE_KEY);
  } catch {
    // The canonical disk workspace remains safe if browser cleanup is blocked.
  }
}

function formatCoordinate(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function atlasProgressFill(
  status: OverworldProgressStatus,
  dimmed: boolean,
): string {
  if (dimmed) return "rgba(3, 10, 18, 0.48)";
  if (status === "complete") return "rgba(38, 217, 199, 0.28)";
  if (status === "in-progress") return "rgba(255, 189, 74, 0.23)";
  return "rgba(7, 17, 31, 0.34)";
}

function atlasProgressStroke(
  status: OverworldProgressStatus,
  dimmed: boolean,
): string {
  if (dimmed) return "rgba(148, 168, 189, 0.12)";
  if (status === "complete") return "rgba(91, 248, 229, 0.78)";
  if (status === "in-progress") return "rgba(255, 202, 101, 0.82)";
  return "rgba(170, 190, 208, 0.3)";
}

function lodForScale(scale: number) {
  return clamp(Math.floor(Math.log2(1 / scale)), 0, 10);
}

function adaptiveGridStep(scale: number) {
  const targetBlocks = 150 / scale;
  return 2 ** clamp(Math.round(Math.log2(targetBlocks)), 4, 20);
}

function pinIsInsideExploration(
  highlight: Highlight,
  exploration: LocalAtlasWorkspaceExploration,
) {
  if (highlight.type !== "pin") return false;
  const bounds = exploration.state.region.bounds;
  if (highlight.regionKey !== undefined) {
    return highlight.regionKey === highlightRegionKey(bounds);
  }
  return pointIsInsideBounds(highlight, bounds);
}

function parseLocation(
  value: string,
  highlights: Highlight[],
): { x: number; z: number; scale?: number } | null {
  const normalized = value.trim();
  const named = highlights.find(
    (highlight) =>
      highlight.title.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
  );
  if (named) return { x: named.x, z: named.z };

  const atMatch = normalized.match(
    /@?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)(?:\s*[, ]\s*(\d+(?:\.\d+)?))?/,
  );
  if (!atMatch) return null;
  const x = Number(atMatch[1]);
  const z = Number(atMatch[2]);
  const scale = atMatch[3] ? Number(atMatch[3]) : undefined;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x,
    z,
    scale:
      scale && Number.isFinite(scale)
        ? clamp(scale, MIN_SCALE, MAX_SCALE)
        : undefined,
  };
}

function tileCacheKey(key: TileKey) {
  return `${key.layer}:${key.lod}:${key.tileX}:${key.tileZ}`;
}

function localTileUrl(key: TileKey) {
  const params = new URLSearchParams({
    layer: key.layer,
    lod: String(key.lod),
    dimension: "0",
    tileX: String(key.tileX),
    tileZ: String(key.tileZ),
  });
  return `/api/tile?${params.toString()}`;
}

function highlightLabel(index: number, type: Highlight["type"]) {
  return `${type === "pin" ? "Punto" : "Área"} ${String(index + 1).padStart(2, "0")}`;
}

function drawHighlightRouteSegments(
  context: CanvasRenderingContext2D,
  overlay: HighlightRouteOverlay,
  atWorld: (worldX: number, worldZ: number) => {
    readonly x: number;
    readonly y: number;
  },
  visibleBounds?: Readonly<{
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
  }>,
) {
  if (overlay.segments.length === 0) return;
  context.save();
  context.beginPath();
  let hasVisibleSegment = false;
  for (const segment of overlay.segments) {
    if (
      visibleBounds &&
      (Math.max(segment.fromX, segment.toX) < visibleBounds.minX ||
        Math.min(segment.fromX, segment.toX) > visibleBounds.maxX ||
        Math.max(segment.fromZ, segment.toZ) < visibleBounds.minZ ||
        Math.min(segment.fromZ, segment.toZ) > visibleBounds.maxZ)
    ) {
      continue;
    }
    const start = atWorld(segment.fromX, segment.fromZ);
    const end = atWorld(segment.toX, segment.toZ);
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    hasVisibleSegment = true;
  }
  if (!hasVisibleSegment) {
    context.restore();
    return;
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(3, 9, 17, 0.9)";
  context.lineWidth = 7;
  context.stroke();
  context.strokeStyle = "rgba(98, 168, 255, 0.92)";
  context.lineWidth = 2.5;
  context.setLineDash([9, 6]);
  context.stroke();
  context.restore();
}

function drawHighlightRouteMarkers(
  context: CanvasRenderingContext2D,
  overlay: HighlightRouteOverlay,
  atWorld: (worldX: number, worldZ: number) => {
    readonly x: number;
    readonly y: number;
  },
  viewport: Readonly<{ width: number; height: number }>,
  visibleBounds?: Readonly<{
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
  }>,
) {
  const coordinateCounts = new Map<string, number>();
  for (const marker of overlay.markers) {
    const key = `${marker.x}:${marker.z}`;
    coordinateCounts.set(key, (coordinateCounts.get(key) ?? 0) + 1);
  }
  const coordinateIndices = new Map<string, number>();
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "700 10px var(--font-geist-mono), monospace";
  for (const marker of overlay.markers) {
    if (
      visibleBounds &&
      (marker.x < visibleBounds.minX ||
        marker.x > visibleBounds.maxX ||
        marker.z < visibleBounds.minZ ||
        marker.z > visibleBounds.maxZ)
    ) {
      continue;
    }
    const coordinateKey = `${marker.x}:${marker.z}`;
    const coordinateCount = coordinateCounts.get(coordinateKey) ?? 1;
    const coordinateIndex =
      coordinateIndices.get(coordinateKey) ?? 0;
    coordinateIndices.set(coordinateKey, coordinateIndex + 1);
    const sourcePoint = atWorld(marker.x, marker.z);
    const ring = Math.floor(coordinateIndex / 8);
    const firstIndexInRing = ring * 8;
    const ringCount = Math.min(
      8,
      coordinateCount - firstIndexInRing,
    );
    const angle =
      -Math.PI / 2 +
      ((coordinateIndex - firstIndexInRing) / ringCount) *
        Math.PI *
        2;
    const offsetDistance =
      coordinateCount > 1 ? 20 + ring * 34 : 0;
    const point = {
      x: sourcePoint.x + Math.cos(angle) * offsetDistance,
      y: sourcePoint.y + Math.sin(angle) * offsetDistance,
    };
    const radius =
      marker.label.length >= 4
        ? 17
        : marker.label.length === 3
          ? 15
          : 12;
    if (
      point.x < -radius ||
      point.y < -radius ||
      point.x > viewport.width + radius ||
      point.y > viewport.height + radius
    ) {
      continue;
    }
    if (offsetDistance > 0) {
      context.beginPath();
      context.moveTo(sourcePoint.x, sourcePoint.y);
      context.lineTo(point.x, point.y);
      context.strokeStyle = "rgba(255, 255, 255, 0.48)";
      context.lineWidth = 1;
      context.setLineDash([2, 3]);
      context.stroke();
      context.setLineDash([]);
    }
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle =
      marker.order === 1
        ? "rgba(38, 217, 199, 0.98)"
        : "rgba(30, 89, 153, 0.98)";
    context.shadowColor = "rgba(0, 0, 0, 0.72)";
    context.shadowBlur = 9;
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(255, 255, 255, 0.96)";
    context.lineWidth = marker.order === 1 ? 2.5 : 1.5;
    context.stroke();
    context.fillStyle = marker.order === 1 ? "#031413" : "#ffffff";
    context.fillText(marker.label, point.x, point.y + 0.5);
  }
  context.restore();
}

function isSafeMapCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 30_000_000
  );
}

function isValidBounds(value: unknown): value is NonNullable<Highlight["bounds"]> {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Partial<NonNullable<Highlight["bounds"]>>;
  return (
    isSafeMapCoordinate(bounds.x1) &&
    isSafeMapCoordinate(bounds.z1) &&
    isSafeMapCoordinate(bounds.x2) &&
    isSafeMapCoordinate(bounds.z2) &&
    Math.abs(bounds.x2 - bounds.x1) >= 2 &&
    Math.abs(bounds.z2 - bounds.z1) >= 2
  );
}

function isValidHighlight(value: unknown): value is Highlight {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Highlight>;
  const commonFieldsAreValid =
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 100 &&
    (item.type === "pin" || item.type === "area") &&
    typeof item.title === "string" &&
    item.title.length <= 200 &&
    typeof item.note === "string" &&
    item.note.length <= 20_000 &&
    typeof item.color === "string" &&
    /^#[0-9a-f]{6}$/i.test(item.color) &&
    (item.regionKey === undefined ||
      item.regionKey === null ||
      isHighlightRegionKey(item.regionKey)) &&
    isSafeMapCoordinate(item.x) &&
    isSafeMapCoordinate(item.z) &&
    typeof item.visible === "boolean" &&
    typeof item.createdAt === "string" &&
    item.createdAt.length <= 100;

  if (!commonFieldsAreValid) return false;
  return item.type === "pin" || isValidBounds(item.bounds);
}

function readHighlightList(
  value: unknown,
  options: { discardInvalid: boolean },
): Highlight[] | null {
  if (!Array.isArray(value)) return null;
  if (
    value.length > MAX_WORKSPACE_HIGHLIGHTS &&
    !options.discardInvalid
  ) {
    return null;
  }
  const candidates = value.slice(0, MAX_WORKSPACE_HIGHLIGHTS);
  const seen = new Set<string>();
  const result: Highlight[] = [];
  for (const item of candidates) {
    if (!isValidHighlight(item) || seen.has(item.id)) {
      if (options.discardInvalid) continue;
      return null;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function migrateLegacyHighlightScopes(
  highlights: readonly Highlight[],
  explorations: readonly LocalAtlasWorkspaceExploration[],
): Highlight[] {
  const regionBounds = explorations.map(
    (exploration) => exploration.state.region.bounds,
  );
  return highlights.map((highlight) =>
    highlight.regionKey === undefined
      ? highlightWithRegionKey(
          highlight,
          inferLegacyHighlightRegionKey(highlight, regionBounds),
        )
      : highlight,
  );
}

function highlightWithRegionKey(
  highlight: Highlight,
  regionKey: string | null,
): Highlight {
  return {
    id: highlight.id,
    type: highlight.type,
    title: highlight.title,
    note: highlight.note,
    color: highlight.color,
    regionKey,
    x: highlight.x,
    z: highlight.z,
    ...(highlight.bounds ? { bounds: highlight.bounds } : {}),
    visible: highlight.visible,
    createdAt: highlight.createdAt,
  };
}

function locationHash(camera: Camera, scale: number) {
  return `#@${Math.round(camera.x)},${Math.round(camera.z)},${scale.toFixed(4)},0`;
}

function workspaceExplorationFromState(
  state: ExplorationState,
  previous?: LocalAtlasWorkspaceExploration,
): LocalAtlasWorkspaceExploration {
  const serialized = JSON.parse(
    serializeExplorationState(state),
  ) as LocalAtlasWorkspaceExploration["state"];
  if (
    previous &&
    JSON.stringify(previous.state) === JSON.stringify(serialized)
  ) {
    return previous;
  }
  const now = new Date().toISOString();
  return {
    id: state.region.id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    state: serialized,
  };
}

function explorationStateFromWorkspace(
  exploration: LocalAtlasWorkspaceExploration,
): ExplorationState {
  return deserializeExplorationState(JSON.stringify(exploration.state));
}

function upsertWorkspaceExploration(
  items: LocalAtlasWorkspaceExploration[],
  state: ExplorationState,
): LocalAtlasWorkspaceExploration[] {
  const existing = items.find((item) => item.id === state.region.id);
  const next = workspaceExplorationFromState(state, existing);
  if (items.length === 1 && next === existing) return items;
  return [next];
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Chromium can expose Clipboard while denying it. Try a local fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

export function MapViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierFrameRef = useRef<number | null>(null);
  const lastMagnifierPositionRef =
    useRef<MagnifierPosition | null>(null);
  const pendingMagnifierPositionRef =
    useRef<MagnifierPosition | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const explorationImportRef = useRef<HTMLInputElement>(null);
  const fallbackBadgeRef = useRef<HTMLDivElement>(null);
  const fallbackTextRef = useRef<HTMLSpanElement>(null);
  const tileCacheRef = useRef<Map<string, TileRecord>>(new Map());
  const tileGenerationRef = useRef(0);
  const lastTerminalJobRef = useRef<string | null>(null);
  const pointerRef = useRef<{
    id: number;
    pointerType: string;
    atlasCellWasFocused: boolean;
    startX: number;
    startY: number;
    camera: Camera;
    moved: boolean;
    hitId: string | null;
  } | null>(null);
  const activePointersRef = useRef<Map<number, ActivePointer>>(new Map());
  const pinchRef = useRef<{
    anchor: Camera;
    startDistance: number;
    startScale: number;
  } | null>(null);
  const pinStartRef = useRef<{
    id: number;
    point: Camera;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const areaStartRef = useRef<{ x: number; z: number } | null>(null);
  const areaPreviewRef = useRef<Highlight["bounds"]>(undefined);
  const coverageStartRef = useRef<OverworldOverviewCell | null>(null);
  const atlasReturnViewRef = useRef<{
    readonly camera: Camera;
    readonly scale: number;
  } | null>(null);
  const localSourceRef = useRef<LocalTileSource | null>(null);
  const workspaceHydrationTokenRef = useRef<string | null>(null);
  const workspacePreconditionRef =
    useRef<LocalAtlasWorkspacePrecondition | null>(null);
  const workspaceContentRef = useRef<LocalAtlasWorkspaceContent | null>(null);
  const workspaceRuntimeRef = useRef<LocalAtlasRuntime | null>(null);
  const explorationStateRef = useRef<ExplorationState | null>(null);
  const workspaceSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const workspaceSaveTimerRef = useRef<number | null>(null);
  const lastSavedWorkspaceRef = useRef<string | null>(null);
  const xaeroDefaultScopeAppliedRef = useRef(false);
  const xaeroScopeRef = useRef<LocalAtlasXaeroScope>({ kind: "all" });
  const pendingWorkspaceWriteRef = useRef<{
    readonly content: LocalAtlasWorkspaceContent;
    readonly expected: LocalAtlasWorkspacePrecondition;
    readonly signature: string;
    readonly writeId: string;
  } | null>(null);

  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [viewSize, setViewSize] = useState(INITIAL_VIEW_SIZE);
  const [cursor, setCursor] = useState<Camera>(INITIAL_CAMERA);
  const [drawer, setDrawer] = useState<Drawer>("atlas");
  const [atlasStatusFilter, setAtlasStatusFilter] =
    useState<AtlasStatusFilter>("all");
  const [atlasFocusedCellIndex, setAtlasFocusedCellIndex] = useState(
    Math.floor(OVERWORLD_OVERVIEW_CELL_COUNT / 2),
  );
  const [localCoverage, setLocalCoverage] =
    useState<LocalAtlasCoverageSnapshot | null>(null);
  const [localCoverageError, setLocalCoverageError] = useState(false);
  const [markMode, setMarkMode] = useState<MarkMode>(null);
  const [areaPreview, setAreaPreview] = useState<Highlight["bounds"]>();
  const [search, setSearch] = useState("-85181, 168232");
  const [searchError, setSearchError] = useState(false);
  const [layers, setLayers] = useState<LayerState[]>([
    {
      id: "base",
      label: "Mundo",
      detail: "Terreno y construcciones",
      visible: true,
      opacity: 1,
      swatch: "#d9c98e",
    },
    {
      id: "overlay",
      label: "Obsidiana",
      detail: "Estructuras y trazas",
      visible: true,
      opacity: 1,
      swatch: "#b47cff",
    },
    {
      id: "newchunks",
      label: "Chunks nuevos",
      detail: "Actividad reciente",
      visible: false,
      opacity: 0.82,
      swatch: "#25d9c7",
    },
  ]);
  const [showGrid, setShowGrid] = useState(true);
  const [showCoverageGrid, setShowCoverageGrid] = useState(true);
  const [coverageSelection, setCoverageSelection] =
    useState<OverworldCoverageSelection | null>(null);
  const [coveragePreview, setCoveragePreview] =
    useState<OverworldCoverageSelection | null>(null);
  const [coverageSelectionReady, setCoverageSelectionReady] = useState(false);
  const [localSource, setLocalSource] = useState<LocalTileSource | null>(null);
  const [archiveName, setArchiveName] = useState<string | null>(null);
  const [localSupported, setLocalSupported] = useState(false);
  const [tileStats, setTileStats] = useState<TileStats>({
    local: 0,
    missing: 0,
  });
  const [loadedTileKeys, setLoadedTileKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [renderVersion, setRenderVersion] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(
    null,
  );
  const [quickHighlightMenu, setQuickHighlightMenu] =
    useState<QuickHighlightMenu | null>(null);
  const [xaeroPreview, setXaeroPreview] =
    useState<LocalAtlasXaeroPreview | null>(null);
  const [xaeroResult, setXaeroResult] =
    useState<LocalAtlasXaeroResult | null>(null);
  const [xaeroBusy, setXaeroBusy] = useState<
    "preview" | LocalAtlasXaeroOperation | null
  >(null);
  const [xaeroError, setXaeroError] = useState<string | null>(null);
  const [xaeroExpanded, setXaeroExpanded] = useState(false);
  const [xaeroOperation, setXaeroOperation] =
    useState<LocalAtlasXaeroOperation>("export");
  const [xaeroScope, setXaeroScope] = useState<LocalAtlasXaeroScope>({
    kind: "all",
  });
  const [xaeroRemoveConfirmed, setXaeroRemoveConfirmed] = useState(false);
  const [highlightsReady, setHighlightsReady] = useState(false);
  const [explorationState, setExplorationState] =
    useState<ExplorationState | null>(null);
  const [explorationPlan, setExplorationPlan] =
    useState<ExplorationPlan | null>(null);
  const [regionStatusSnapshot, setRegionStatusSnapshot] =
    useState<RegionStatusSnapshot | null>(null);
  const [regionStatusLoading, setRegionStatusLoading] = useState(false);
  const [regionStatusError, setRegionStatusError] = useState<string | null>(
    null,
  );
  const [confirmCloseExploration, setConfirmCloseExploration] =
    useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [explorationReady, setExplorationReady] = useState(false);
  const [savedExplorations, setSavedExplorations] = useState<
    LocalAtlasWorkspaceExploration[]
  >([]);
  const [regionForm, setRegionForm] = useState({
    name: "Región de análisis",
    minX: "-86000",
    minZ: "167500",
    maxXExclusive: "-84000",
    maxZExclusive: "169000",
  });
  const [localRuntime, setLocalRuntime] =
    useState<LocalAtlasRuntime | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [downloadClockMs, setDownloadClockMs] = useState(0);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [persistenceState, setPersistenceState] =
    useState<PersistenceState>("checking");
  const [persistenceMessage, setPersistenceMessage] = useState(
    "Comprobando LuisA…",
  );
  const [toast, setToast] = useState<string | null>(null);
  const [topbarRevealed, setTopbarRevealed] = useState(false);
  const [magnifierEnabled, setMagnifierEnabled] = useState(false);
  const [magnifierPosition, setMagnifierPosition] =
    useState<MagnifierPosition>({
      x: INITIAL_VIEW_SIZE.width / 2,
      y: INITIAL_VIEW_SIZE.height / 2,
      lensX: INITIAL_VIEW_SIZE.width / 2,
      lensY: INITIAL_VIEW_SIZE.height / 2,
      visible: false,
    });
  const [highlightRouteEnabled, setHighlightRouteEnabled] = useState(false);
  const [highlightRouteStartId, setHighlightRouteStartId] = useState<
    string | null
  >(null);
  const [highlightRouteStartSearch, setHighlightRouteStartSearch] =
    useState("");
  const [highlightRouteComputation, setHighlightRouteComputation] =
    useState<HighlightRouteComputation>({ status: "idle" });
  const [highlightRouteRetry, setHighlightRouteRetry] = useState(0);
  const highlightRouteRequestIdRef = useRef(0);
  const scheduleMagnifierPosition = useCallback(
    (position: MagnifierPosition) => {
      pendingMagnifierPositionRef.current = position;
      if (magnifierFrameRef.current !== null) return;
      magnifierFrameRef.current = window.requestAnimationFrame(() => {
        magnifierFrameRef.current = null;
        const pending = pendingMagnifierPositionRef.current;
        pendingMagnifierPositionRef.current = null;
        if (!pending) return;
        setMagnifierPosition((current) =>
          current.x === pending.x &&
          current.y === pending.y &&
          current.lensX === pending.lensX &&
          current.lensY === pending.lensY &&
          current.visible === pending.visible
            ? current
            : pending,
        );
      });
    },
    [],
  );
  const hideMagnifier = useCallback(() => {
    pendingMagnifierPositionRef.current = null;
    if (magnifierFrameRef.current !== null) {
      window.cancelAnimationFrame(magnifierFrameRef.current);
      magnifierFrameRef.current = null;
    }
    setMagnifierPosition((current) =>
      current.visible ? { ...current, visible: false } : current,
    );
  }, []);
  const leaveMagnifier = useCallback(() => {
    lastMagnifierPositionRef.current = null;
    hideMagnifier();
  }, [hideMagnifier]);
  const toggleMagnifier = useCallback(() => {
    const enabled = !magnifierEnabled;
    setMagnifierEnabled(enabled);
    if (!enabled) {
      hideMagnifier();
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    const fallbackX = (rect?.width ?? INITIAL_VIEW_SIZE.width) / 2;
    const fallbackY = (rect?.height ?? INITIAL_VIEW_SIZE.height) / 2;
    scheduleMagnifierPosition({
      ...(lastMagnifierPositionRef.current ?? {
        x: fallbackX,
        y: fallbackY,
        lensX: fallbackX,
        lensY: fallbackY,
        visible: true,
      }),
      visible: true,
    });
  }, [
    hideMagnifier,
    magnifierEnabled,
    scheduleMagnifierPosition,
  ]);
  useEffect(
    () => () => {
      if (magnifierFrameRef.current !== null) {
        window.cancelAnimationFrame(magnifierFrameRef.current);
      }
    },
    [],
  );

  const atlasMode = drawer === "atlas";
  const isExploring = explorationState !== null && !atlasMode;
  const magnifierRenderScale = Math.min(
    MAGNIFIER_MAX_RENDER_SCALE,
    Math.max(MAGNIFIER_MIN_RENDER_SCALE, scale * MAGNIFIER_SCALE_FACTOR),
  );
  const magnifierZoomFactor = magnifierRenderScale / scale;
  const localCoverageState: "loading" | "ready" | "stale" | "error" =
    localCoverageError
      ? localCoverage !== null
        ? "stale"
        : "error"
      : localCoverage !== null
        ? "ready"
        : "loading";
  const lod =
    explorationState && !atlasMode
      ? explorationState.region.lod
      : lodForScale(scale);
  const blocksPerPixel = blocksPerPixelAtLod(lod);
  const gridStep = adaptiveGridStep(scale);
  const compactHighlights = scale <= HIGHLIGHT_COMPACT_SCALE;
  const activeExplorationRegion = explorationState?.region ?? null;
  const activeHighlightRegionKey = activeExplorationRegion
    ? highlightRegionKey(activeExplorationRegion.bounds)
    : null;
  const scopedHighlights = useMemo(
    () =>
      atlasMode
        ? []
        : highlightsForRegion(
            highlights,
            activeExplorationRegion?.bounds ?? null,
          ),
    [activeExplorationRegion, atlasMode, highlights],
  );
  const validHighlightRouteStartId =
    highlightRouteStartId &&
    scopedHighlights.some(
      (highlight) => highlight.id === highlightRouteStartId,
    )
      ? highlightRouteStartId
      : null;
  const highlightRouteStartOptions = useMemo(() => {
    const query = highlightRouteStartSearch.trim().toLocaleLowerCase();
    const options: Highlight[] = [];
    for (const highlight of scopedHighlights) {
      const matches =
        query.length === 0 ||
        `${highlight.title}\n${highlight.id}\n${Math.round(highlight.x)},${Math.round(highlight.z)}`
          .toLocaleLowerCase()
          .includes(query);
      if (matches) options.push(highlight);
      if (options.length >= MAX_HIGHLIGHT_ROUTE_START_OPTIONS) break;
    }
    if (
      validHighlightRouteStartId &&
      !options.some(
        (highlight) => highlight.id === validHighlightRouteStartId,
      )
    ) {
      const selected = scopedHighlights.find(
        (highlight) => highlight.id === validHighlightRouteStartId,
      );
      if (selected) options.unshift(selected);
    }
    return options;
  }, [
    highlightRouteStartSearch,
    scopedHighlights,
    validHighlightRouteStartId,
  ]);
  const highlightRouteGeometryJson = useMemo(
    () =>
      JSON.stringify(
        scopedHighlights.map(({ id, x, z }) => ({ id, x, z })),
      ),
    [scopedHighlights],
  );
  const highlightRouteRegionBoundsKey = activeExplorationRegion
    ? boundsKey(activeExplorationRegion.bounds)
    : "";
  const highlightRouteMinX =
    activeExplorationRegion?.bounds.minX ?? null;
  const highlightRouteMinZ =
    activeExplorationRegion?.bounds.minZ ?? null;
  const highlightRouteMaxXExclusive =
    activeExplorationRegion?.bounds.maxXExclusive ?? null;
  const highlightRouteMaxZExclusive =
    activeExplorationRegion?.bounds.maxZExclusive ?? null;
  const highlightRouteComputationMatchesCurrent =
    highlightRouteComputation.status !== "idle" &&
    highlightRouteComputation.geometryJson ===
      highlightRouteGeometryJson &&
    highlightRouteComputation.regionBoundsKey ===
      highlightRouteRegionBoundsKey &&
    highlightRouteComputation.requestedStartHighlightId ===
      validHighlightRouteStartId;
  const highlightRouteRequestMatchesCurrent =
    highlightRouteComputationMatchesCurrent &&
    highlightRouteComputation.status === "ready";
  const highlightRouteIsCalculating =
    highlightRouteEnabled &&
    (!highlightRouteComputationMatchesCurrent ||
      highlightRouteComputation.status === "calculating" ||
      highlightRouteComputation.status === "idle");
  const highlightRouteError =
    highlightRouteEnabled &&
    highlightRouteComputationMatchesCurrent &&
    highlightRouteComputation.status === "error"
      ? highlightRouteComputation.message
      : null;
  const highlightRoute = useMemo(
    (): HighlightRoutePlan<Highlight> | null => {
      if (
        !highlightRouteEnabled ||
        !highlightRouteRequestMatchesCurrent ||
        highlightRouteComputation.status !== "ready"
      ) {
        return null;
      }
      const highlightsById = new Map(
        scopedHighlights.map((highlight) => [highlight.id, highlight]),
      );
      const stops = highlightRouteComputation.plan.stops.map((stop) => {
        const highlight = highlightsById.get(stop.highlight.id);
        return highlight ? { ...stop, highlight } : null;
      });
      if (stops.some((stop) => stop === null)) return null;
      return {
        ...highlightRouteComputation.plan,
        stops: stops as NonNullable<(typeof stops)[number]>[],
      };
    },
    [
      highlightRouteEnabled,
      highlightRouteComputation,
      highlightRouteRequestMatchesCurrent,
      scopedHighlights,
    ],
  );
  useEffect(() => {
    if (
      !highlightRouteEnabled ||
      atlasMode ||
      highlightRouteMinX === null ||
      highlightRouteMinZ === null ||
      highlightRouteMaxXExclusive === null ||
      highlightRouteMaxZExclusive === null ||
      highlightRouteGeometryJson === "[]"
    ) {
      return;
    }
    if (highlightRouteRequestMatchesCurrent) return;

    const requestId = highlightRouteRequestIdRef.current + 1;
    highlightRouteRequestIdRef.current = requestId;
    const computationIdentity = {
      requestId,
      geometryJson: highlightRouteGeometryJson,
      regionBoundsKey: highlightRouteRegionBoundsKey,
      requestedStartHighlightId: validHighlightRouteStartId,
    };
    setHighlightRouteComputation({
      status: "calculating",
      ...computationIdentity,
    });

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./lib/highlight-route.worker.ts", import.meta.url),
        { type: "module", name: "obsidian-atlas-highlight-route" },
      );
    } catch {
      setHighlightRouteComputation({
        status: "error",
        ...computationIdentity,
        message:
          "Este navegador no pudo iniciar el cálculo en segundo plano.",
      });
      return;
    }

    let active = true;
    const fail = (message: string) => {
      if (!active) return;
      active = false;
      worker.terminate();
      setHighlightRouteComputation({
        status: "error",
        ...computationIdentity,
        message,
      });
    };
    worker.onmessage = (
      event: MessageEvent<HighlightRouteWorkerResponse>,
    ) => {
      const response = event.data;
      if (!active || response.requestId !== requestId) return;
      if (!response.ok) {
        fail(response.error);
        return;
      }
      active = false;
      worker.terminate();
      setHighlightRouteComputation({
        status: "ready",
        ...computationIdentity,
        plan: response.plan,
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail("El cálculo de la ruta falló en segundo plano.");
    };

    const request: HighlightRouteWorkerRequest = {
      requestId,
      points: JSON.parse(
        highlightRouteGeometryJson,
      ) as HighlightRoutePoint[],
      bounds: {
        minX: highlightRouteMinX,
        minZ: highlightRouteMinZ,
        maxXExclusive: highlightRouteMaxXExclusive,
        maxZExclusive: highlightRouteMaxZExclusive,
      },
      startHighlightId: validHighlightRouteStartId,
    };
    try {
      worker.postMessage(request);
    } catch {
      fail("No se pudieron enviar los highlights al planificador.");
    }

    return () => {
      active = false;
      worker.terminate();
    };
  }, [
    atlasMode,
    highlightRouteEnabled,
    highlightRouteGeometryJson,
    highlightRouteMaxXExclusive,
    highlightRouteMaxZExclusive,
    highlightRouteMinX,
    highlightRouteMinZ,
    highlightRouteRegionBoundsKey,
    highlightRouteRequestMatchesCurrent,
    highlightRouteRetry,
    validHighlightRouteStartId,
  ]);
  const renderedHighlights = atlasMode ? highlights : scopedHighlights;
  const selectedHighlight = scopedHighlights.find(
    (highlight) => highlight.id === selectedHighlightId,
  );
  const quickHighlightPresetNames = useMemo(
    () =>
      HIGHLIGHT_NAME_PRESETS.map((preset) => ({
        preset,
        title: nextHighlightPresetName(
          preset,
          highlights,
          activeHighlightRegionKey,
        ),
      })),
    [activeHighlightRegionKey, highlights],
  );
  const selectedHighlightPresetNames = useMemo(() => {
    if (!selectedHighlight) return [];
    const otherHighlights = highlights.filter(
      (highlight) => highlight.id !== selectedHighlight.id,
    );
    return HIGHLIGHT_NAME_PRESETS.map((preset) => ({
      preset,
      title: nextHighlightPresetName(
        preset,
        otherHighlights,
        selectedHighlight.regionKey,
      ),
    }));
  }, [highlights, selectedHighlight]);
  const currentExplorationCell = explorationState
    ? cellForIndex(
        explorationState.region,
        explorationState.currentIndex,
      )
    : null;
  const currentDetailKey =
    explorationState && currentExplorationCell
      ? tileCacheKey({
          layer: "base",
          lod: MAX_DETAIL_EXPLORATION_LOD,
          dimension: "overworld",
          tileX: currentExplorationCell.tileX,
          tileZ: currentExplorationCell.tileZ,
        })
      : null;
  const currentDetailReady =
    explorationState?.region.lod === MAX_DETAIL_EXPLORATION_LOD &&
    currentDetailKey !== null &&
    loadedTileKeys.has(currentDetailKey);
  const activeExplorationIsMaxDetail =
    explorationState?.region.lod === MAX_DETAIL_EXPLORATION_LOD;
  const explorationMinimumScale =
    explorationState && !atlasMode
      ? minimumSafeExplorationScale(explorationState.region.tileSpan, viewSize)
      : MIN_SCALE;
  const currentCellSkipped =
    explorationState !== null &&
    isCellSkipped(explorationState, explorationState.currentIndex);
  const regionStatusBounds =
    explorationPlan?.state.region.bounds ??
    (atlasMode || (!explorationState && drawer === "exploration")
      ? coverageSelection?.bounds ?? null
      : null);
  const regionStatusKey = regionStatusBounds
    ? boundsKey(regionStatusBounds)
    : null;
  const regionStatus =
    regionStatusKey !== null && regionStatusSnapshot?.key === regionStatusKey
      ? regionStatusSnapshot.status
      : null;
  const regionStatusDisplayError =
    regionStatusBounds &&
    runtimeChecked &&
    !localRuntime?.capacity.configured
      ? "La biblioteca local no está disponible"
      : regionStatusError;
  const anyRegionDownloadRunning =
    localRuntime?.job?.status === "running" ||
    localRuntime?.job?.status === "stopping";
  const matchingRegionDownloadRunning =
    Boolean(
      anyRegionDownloadRunning &&
        regionStatusBounds &&
        regionJobMatchesBounds(localRuntime?.job ?? null, regionStatusBounds),
    );
  const matchingRegionDownloadJob = Boolean(
    regionStatusBounds &&
      regionJobMatchesBounds(localRuntime?.job ?? null, regionStatusBounds),
  );
  const activeDownloadProgress = matchingRegionDownloadJob
    ? localRuntime?.job?.progress
    : undefined;
  const displayedRegionPercent =
    matchingRegionDownloadRunning && activeDownloadProgress
      ? activeDownloadProgress.percent
      : (regionStatus?.percent ?? 0);
  const displayedRegionResolved =
    matchingRegionDownloadRunning && activeDownloadProgress
      ? activeDownloadProgress.complete + activeDownloadProgress.absent
      : regionStatus?.resolvedCount;
  const displayedRegionTotal =
    matchingRegionDownloadRunning && activeDownloadProgress
      ? activeDownloadProgress.requested
      : regionStatus?.totalCount;
  const matchingRegionDownloadError =
    matchingRegionDownloadJob && localRuntime?.job?.status === "error"
      ? localRuntime.job.message
      : null;
  const downloadCooldownUntilMs = activeDownloadProgress?.cooldownUntil
    ? Date.parse(activeDownloadProgress.cooldownUntil)
    : null;
  const downloadCooldownSeconds =
    downloadCooldownUntilMs !== null && downloadClockMs > 0
      ? Math.max(0, (downloadCooldownUntilMs - downloadClockMs) / 1_000)
      : (activeDownloadProgress?.cooldownSeconds ?? 0);
  const anotherRegionDownloadRunning =
    anyRegionDownloadRunning && !matchingRegionDownloadRunning;
  const coverageRegionKey = coverageSelection
    ? boundsKey(coverageSelection.bounds)
    : null;
  const coverageRegionStatus =
    coverageRegionKey !== null &&
    regionStatusSnapshot?.key === coverageRegionKey
      ? regionStatusSnapshot.status
      : null;
  const coverageRegionDownloadRunning =
    Boolean(
      anyRegionDownloadRunning &&
        coverageSelection &&
        regionJobMatchesBounds(
          localRuntime?.job ?? null,
          coverageSelection.bounds,
        ),
    );
  const coverageRegionBlockedByOther =
    anyRegionDownloadRunning && !coverageRegionDownloadRunning;
  const reviewableCellCount = explorationState
    ? explorationState.region.cellCount - explorationState.skippedCount
    : 0;

  useEffect(() => {
    if (downloadCooldownUntilMs === null) return;
    let interval: number | null = null;
    const updateClock = () => {
      const now = Date.now();
      setDownloadClockMs(now);
      if (now >= downloadCooldownUntilMs && interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const initialTick = window.setTimeout(updateClock, 0);
    if (downloadCooldownUntilMs > Date.now()) {
      interval = window.setInterval(updateClock, 1_000);
    }
    return () => {
      window.clearTimeout(initialTick);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [downloadCooldownUntilMs]);

  const explorationPercent = explorationState
    ? reviewableCellCount === 0
      ? 100
      : (explorationState.reviewedCount / reviewableCellCount) * 100
    : 0;
  const visibleCoverageSelection = coveragePreview ?? coverageSelection;
  const selectedLod0CellCount = useMemo(() => {
    if (!coverageSelection) return 0;
    const span = blocksPerTileAtLod(MAX_DETAIL_EXPLORATION_LOD);
    return (
      Math.ceil(
        (coverageSelection.bounds.maxXExclusive -
          coverageSelection.bounds.minX) /
          span,
      ) *
      Math.ceil(
        (coverageSelection.bounds.maxZExclusive -
          coverageSelection.bounds.minZ) /
          span,
      )
    );
  }, [coverageSelection]);
  const selectedRegionFileBudget =
    coverageRegionStatus?.totalCount ??
    selectedLod0CellCount * REGIONAL_DOWNLOAD_LAYERS.length;
  const plannedRegionFileBudget =
    regionStatus?.totalCount ??
    (explorationPlan?.state.region.cellCount ?? 0) *
      REGIONAL_DOWNLOAD_LAYERS.length;
  const plannedRegionPendingFiles =
    regionStatus?.pendingCount ?? plannedRegionFileBudget;
  const coverageSelectionTooLarge =
    selectedLod0CellCount > MAX_EXPLORATION_CELLS;
  const workspaceContent = useMemo<LocalAtlasWorkspaceContent>(
    () => ({
      schemaVersion: 1,
      activeExplorationId:
        explorationState?.region.id ??
        (explorationPlan?.source === "hydrated" ||
        explorationPlan?.source === "restored"
          ? explorationPlan.state.region.id
          : null),
      explorations: savedExplorations,
      highlights,
      coverageSelection,
    }),
    [
      coverageSelection,
      explorationPlan,
      explorationState?.region.id,
      highlights,
      savedExplorations,
    ],
  );
  const orderedSavedExplorations = useMemo(
    () =>
      [...savedExplorations].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    [savedExplorations],
  );
  const xaeroRegionOptions = useMemo(
    () =>
      orderedSavedExplorations.map((exploration) => ({
        id: exploration.id,
        name: exploration.state.region.name,
        pinCount: highlights.filter((highlight) =>
          pinIsInsideExploration(highlight, exploration),
        ).length,
      })),
    [highlights, orderedSavedExplorations],
  );
  const selectedXaeroRegion =
    xaeroScope.kind === "exploration"
      ? xaeroRegionOptions.find(
          (region) => region.id === xaeroScope.explorationId,
        ) ?? null
      : null;
  const xaeroSelectionLabel =
    xaeroScope.kind === "all"
      ? `Todo el Atlas · ${highlights.filter((highlight) => highlight.type === "pin").length.toLocaleString("es-GT")} puntos actuales`
      : selectedXaeroRegion
        ? `${selectedXaeroRegion.name} · ${selectedXaeroRegion.pinCount.toLocaleString("es-GT")} puntos actuales`
        : "Región no disponible";
  const atlasProgress = useMemo(
    () => summarizeLocalCoverage(localCoverage, MAX_DETAIL_EXPLORATION_LOD),
    [localCoverage],
  );
  const atlasFocusedCell = overviewCellForIndex(atlasFocusedCellIndex);
  const displayedCoordinate = atlasMode
    ? {
        x:
          (atlasFocusedCell.bounds.minX +
            atlasFocusedCell.bounds.maxXExclusive) /
          2,
        z:
          (atlasFocusedCell.bounds.minZ +
            atlasFocusedCell.bounds.maxZExclusive) /
          2,
      }
    : camera;
  const atlasFocusedProgress =
    atlasProgress?.sectors[atlasFocusedCellIndex] ?? null;
  const atlasNextPending = useMemo(() => {
    if (!atlasProgress) return null;
    for (let offset = 1; offset <= atlasProgress.sectors.length; offset += 1) {
      const index =
        (atlasFocusedCellIndex + offset) % atlasProgress.sectors.length;
      const sector = atlasProgress.sectors[index];
      if (sector.status === "pending") return sector;
    }
    return null;
  }, [atlasFocusedCellIndex, atlasProgress]);
  const atlasFocusedLocalCell =
    localCoverage?.cells.find(
      (cell) =>
        cell.row === atlasFocusedCell.row &&
        cell.column === atlasFocusedCell.column,
    ) ?? null;
  const runtimeMutationToken = localRuntime?.mutationToken ?? null;
  const runtimePersistenceConfigured =
    localRuntime?.persistence.configured ?? false;
  const runtimePersistenceWritable =
    localRuntime?.persistence.writable ?? false;
  const workspaceMutationsBlocked =
    !runtimeChecked ||
    pauseBusy ||
    !runtimePersistenceConfigured ||
    !runtimePersistenceWritable ||
    !workspaceReady;
  const persistenceLabel =
    persistenceState === "checking"
      ? "Comprobando"
      : persistenceState === "saving"
        ? "Guardando"
        : persistenceState === "saved"
          ? "Guardado"
          : persistenceState === "readonly"
            ? "Solo lectura"
            : persistenceState === "offline"
            ? "Sin disco"
              : "Atención";
  const workspaceShieldNeedsAction =
    runtimeChecked &&
    !pauseBusy &&
    (persistenceState === "offline" ||
      persistenceState === "readonly" ||
      persistenceState === "error" ||
      !runtimePersistenceConfigured ||
      !runtimePersistenceWritable);
  const workspaceShieldTitle = pauseBusy
    ? "Guardando sesión"
    : !runtimeChecked || persistenceState === "checking"
      ? "Comprobando LuisA"
      : !runtimePersistenceConfigured || persistenceState === "offline"
        ? "LuisA no está disponible"
        : !runtimePersistenceWritable || persistenceState === "readonly"
          ? "LuisA está en solo lectura"
          : persistenceState === "error"
            ? "No se pudo abrir el workspace"
            : "Sincronizando workspace";
  const workspaceShieldMessage = pauseBusy
    ? "Asegurando una copia antes de pausar…"
    : !runtimeChecked || persistenceState === "checking"
      ? persistenceMessage
      : !runtimePersistenceConfigured || persistenceState === "offline"
        ? "Monta LuisA; Atlas detectará la unidad y recuperará tu sesión automáticamente."
        : !runtimePersistenceWritable || persistenceState === "readonly"
          ? "Habilita escritura en LuisA y vuelve a abrir Atlas para editar con seguridad."
          : persistenceState === "error"
            ? `${persistenceMessage}. Comprueba LuisA y vuelve a abrir Atlas.`
            : persistenceMessage;
  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1_700);
  }, []);

  const journalWorkspace = useCallback(
    (content: LocalAtlasWorkspaceContent | null): boolean => {
      if (!content) return true;
      const existingRecovery = readBrowserWorkspaceRecovery();
      const base =
        workspacePreconditionRef.current ?? existingRecovery?.base ?? null;
      if (!base) return false;
      return writeBrowserWorkspaceRecovery(content, base);
    },
    [],
  );

  const commitExplorationProgress = useCallback(
    (next: ExplorationState) => {
      explorationStateRef.current = next;
      const baseContent = workspaceContentRef.current ?? workspaceContent;
      const nextExplorations = upsertWorkspaceExploration(
        [...baseContent.explorations],
        next,
      );
      const nextContent: LocalAtlasWorkspaceContent = {
        ...baseContent,
        activeExplorationId: next.region.id,
        explorations: nextExplorations,
      };
      workspaceContentRef.current = nextContent;
      const journaled = !workspaceReady || journalWorkspace(nextContent);
      setSavedExplorations(nextExplorations);
      setExplorationState(next);
      if (!journaled) {
        notify("No se pudo actualizar la copia inmediata de recuperación");
      }
    },
    [journalWorkspace, notify, workspaceContent, workspaceReady],
  );

  useEffect(() => {
    if (
      !quickHighlightMenu ||
      !isExploring ||
      workspaceMutationsBlocked
    ) return;
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".highlight-quick-menu")
      ) {
        return;
      }
      setQuickHighlightMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [isExploring, quickHighlightMenu, workspaceMutationsBlocked]);

  const invalidateXaeroPreview = useCallback(() => {
    setXaeroPreview(null);
    setXaeroResult(null);
    setXaeroError(null);
    setXaeroRemoveConfirmed(false);
  }, []);
  const chooseXaeroScope = useCallback((scope: LocalAtlasXaeroScope) => {
    xaeroScopeRef.current = scope;
    setXaeroScope(scope);
  }, []);
  const reconcileXaeroScope = useCallback(
    (explorations: readonly Pick<LocalAtlasWorkspaceExploration, "id">[]) => {
      const current = xaeroScopeRef.current;
      if (
        current.kind === "all" ||
        explorations.some(
          (exploration) => exploration.id === current.explorationId,
        )
      ) {
        return;
      }
      const replacement = explorations[0];
      chooseXaeroScope(
        replacement
          ? { kind: "exploration", explorationId: replacement.id }
          : { kind: "all" },
      );
      invalidateXaeroPreview();
    },
    [chooseXaeroScope, invalidateXaeroPreview],
  );

  const clearTileCache = useCallback(() => {
    tileGenerationRef.current += 1;
    for (const record of tileCacheRef.current.values()) {
      record.bitmap?.close();
    }
    tileCacheRef.current.clear();
    setTileStats({ local: 0, missing: 0 });
    setLoadedTileKeys(new Set());
    setRenderVersion((version) => version + 1);
  }, []);

  const focusExploration = useCallback(
    (
      state: ExplorationState,
      request: ExplorationFocusRequest,
    ) => {
      const next = resolveExplorationFocusView(
        state,
        viewSize,
        request,
      );
      setCamera(next.camera);
      setScale(next.scale);
    },
    [viewSize],
  );

  const constrainActiveExplorationCamera = useCallback(
    (nextCamera: Camera, nextScale: number) => {
      if (!explorationState || atlasMode) return nextCamera;
      return clampCameraToExploration(
        nextCamera,
        explorationState.region.bounds,
        explorationState.region.tileSpan,
        nextScale,
        viewSize,
      );
    },
    [atlasMode, explorationState, viewSize],
  );

  const focusMapPoint = useCallback(
    (x: number, z: number) => {
      if (!explorationState) {
        setCamera({ x, z });
        return true;
      }
      const index = cellIndexAtWorld(explorationState.region, x, z);
      if (index === null) {
        notify("Ese punto queda fuera de la sesión activa");
        return false;
      }
      const next = withVisitedIndex(explorationState, index);
      commitExplorationProgress(next);
      focusExploration(next, { mode: "preserve", scale });
      return true;
    },
    [
      commitExplorationProgress,
      explorationState,
      focusExploration,
      notify,
      scale,
    ],
  );

  const archiveExploration = useCallback((state: ExplorationState) => {
    setSavedExplorations((items) =>
      upsertWorkspaceExploration(items, state),
    );
  }, []);

  const stageExplorationPlan = useCallback(
    (
      requestedState: ExplorationState,
      source: ExplorationPlan["source"],
    ) => {
      const state =
        requestedState.region.lod === MAX_DETAIL_EXPLORATION_LOD
          ? requestedState
          : createMaxDetailExplorationState({
              id: `region-${Date.now().toString(36)}`,
              name: `${requestedState.region.name} · LOD 0`,
              bounds: requestedState.region.bounds,
            });
      reconcileXaeroScope([{ id: state.region.id }]);
      explorationStateRef.current = null;
      setExplorationState(null);
      setExplorationPlan({
        state,
        source:
          requestedState.region.lod === MAX_DETAIL_EXPLORATION_LOD
            ? source
            : "legacy",
        reveal: source !== "hydrated",
      });
      setRegionStatusSnapshot(null);
      setRegionStatusError(null);
      setConfirmCloseExploration(false);
      setMarkMode(null);
      clearTileCache();
      setDrawer(source === "hydrated" ? "atlas" : "exploration");
    },
    [clearTileCache, reconcileXaeroScope],
  );

  const activateDownloadedExploration = useCallback(
    (plan: ExplorationPlan, status: LocalAtlasRegionStatus) => {
      if (!status.ready) return;
      const absentIndexes: number[] = [];
      for (const absent of status.absentCells) {
        const index = cellIndexAtTile(
          plan.state.region,
          absent.tileX,
          absent.tileZ,
        );
        if (index !== null) absentIndexes.push(index);
      }
      let next = withCellsSkipped(plan.state, absentIndexes);
      next = withCurrentCellVisited(next);
      commitExplorationProgress(next);
      setExplorationPlan(null);
      setRegionStatusSnapshot(null);
      setRegionStatusError(null);
      clearTileCache();
      if (plan.reveal) {
        focusExploration(next, { mode: "fit" });
      }
      setDrawer(plan.reveal ? "exploration" : "atlas");
      notify(
        `${next.region.name} lista · la primera celda quedó explorada`,
      );
    },
    [clearTileCache, commitExplorationProgress, focusExploration, notify],
  );

  const startRegionDownload = useCallback(
    async (plan: ExplorationPlan) => {
      if (!localRuntime?.capacity.configured) {
        notify("Inicia el visor con la biblioteca local de LuisA");
        return;
      }
      if (
        localRuntime.job &&
        (localRuntime.job.status === "running" ||
          localRuntime.job.status === "stopping")
      ) {
        notify(
          regionJobMatchesBounds(
            localRuntime.job,
            plan.state.region.bounds,
          )
            ? "Esta región ya se está guardando"
            : "Hay otra región descargándose; espera o detén ese trabajo",
        );
        return;
      }
      setRuntimeBusy(true);
      try {
        await downloadExplorationRegion(
          localRuntime,
          plan.state.region.bounds,
          REGIONAL_DOWNLOAD_LAYERS,
          REGIONAL_REQUESTS_PER_SECOND,
        );
        setLocalRuntime(await readLocalAtlasRuntime());
        notify("Guardado regional iniciado a máxima velocidad");
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : "No se pudo iniciar la descarga regional",
        );
      } finally {
        setRuntimeBusy(false);
      }
    },
    [localRuntime, notify],
  );

  useLayoutEffect(() => {
    workspaceContentRef.current = workspaceContent;
  }, [workspaceContent]);

  useEffect(() => {
    workspaceRuntimeRef.current = localRuntime;
  }, [localRuntime]);

  useLayoutEffect(() => {
    explorationStateRef.current = explorationState;
  }, [explorationState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setLocalSupported(getFileSystemAccessSupport().supported);
      setHighlightsReady(true);
      setCoverageSelectionReady(true);
      setExplorationReady(true);
      const location = parseLocation(window.location.hash, []);
      if (location) {
        atlasReturnViewRef.current = {
          camera: { x: location.x, z: location.z },
          scale: location.scale ?? INITIAL_SCALE,
        };
        const cell = overviewCellAtWorld(location.x, location.z);
        if (cell) setAtlasFocusedCellIndex(cell.index);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (atlasMode) return;
    const timeout = window.setTimeout(() => {
      window.history.replaceState(null, "", locationHash(camera, scale));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [atlasMode, camera, scale]);

  useEffect(() => {
    const onHashChange = () => {
      const location = parseLocation(window.location.hash, []);
      if (!location) return;
      if (atlasMode) {
        const cell = overviewCellAtWorld(location.x, location.z);
        if (cell) setAtlasFocusedCellIndex(cell.index);
        return;
      }
      if (explorationState) {
        const index = cellIndexAtWorld(
          explorationState.region,
          location.x,
          location.z,
        );
        if (index === null) return;
        const next = withVisitedIndex(explorationState, index);
        commitExplorationProgress(next);
        focusExploration(next, {
          mode: "preserve",
          scale: location.scale ?? scale,
        });
        return;
      }
      setCamera({ x: location.x, z: location.z });
      if (location.scale) setScale(location.scale);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [
    atlasMode,
    commitExplorationProgress,
    explorationState,
    focusExploration,
    scale,
  ]);

  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const nextViewSize = {
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      };
      setViewSize(nextViewSize);
      if (explorationState && !atlasMode) {
        const nextScale = clamp(
          scale,
          minimumSafeExplorationScale(
            explorationState.region.tileSpan,
            nextViewSize,
          ),
          MAX_SCALE,
        );
        if (nextScale !== scale) setScale(nextScale);
        setCamera((current) => {
          const next = clampCameraToExploration(
            current,
            explorationState.region.bounds,
            explorationState.region.tileSpan,
            nextScale,
            nextViewSize,
          );
          return next.x === current.x && next.z === current.z ? current : next;
        });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [atlasMode, explorationState, scale]);

  useEffect(() => {
    const cache = tileCacheRef.current;
    return () => {
      tileGenerationRef.current += 1;
      localSourceRef.current?.dispose();
      for (const record of cache.values()) {
        record.bitmap?.close();
      }
      cache.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reading = false;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const runtime = await readLocalAtlasRuntime(controller.signal);
        if (cancelled) return;
        setLocalRuntime(runtime);
        setRuntimeChecked(true);
        const terminalJob =
          runtime?.job &&
          runtime.job.status !== "running" &&
          runtime.job.status !== "stopping"
            ? runtime.job
            : null;
        if (
          terminalJob &&
          lastTerminalJobRef.current !== terminalJob.id
        ) {
          lastTerminalJobRef.current = terminalJob.id;
          clearTileCache();
          if (terminalJob.status === "complete") {
            notify("La región ya está disponible localmente");
          }
        }
      } catch {
        if (!cancelled) {
          setLocalRuntime(null);
          setRuntimeChecked(true);
        }
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        reading = false;
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2_500);
    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearInterval(interval);
    };
  }, [clearTileCache, notify]);

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const coverage = await readLocalAtlasCoverage(
          MAX_DETAIL_EXPLORATION_LOD,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!coverage) {
          setLocalCoverage(null);
          setLocalCoverageError(true);
          return;
        }
        setLocalCoverage(coverage);
        setLocalCoverageError(false);
      } catch {
        if (controller.signal.aborted) return;
        setLocalCoverageError(true);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [localRuntime?.job?.id, localRuntime?.job?.status]);

  useEffect(() => {
    if (!regionStatusBounds || !localRuntime?.capacity.configured) {
      return;
    }
    const key = boundsKey(regionStatusBounds);
    const bounds = { ...regionStatusBounds };
    const controller = new AbortController();
    let reading = false;
    let disposed = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      setRegionStatusLoading(true);
      try {
        const status = await readLocalAtlasRegionStatus(
          bounds,
          REGIONAL_DOWNLOAD_LAYERS,
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return;
        if (!status) {
          throw new Error("La biblioteca no devolvió el estado de la región");
        }
        setRegionStatusSnapshot({ key, status });
        setRegionStatusError(null);
        if (
          status.ready &&
          explorationPlan &&
          boundsKey(explorationPlan.state.region.bounds) === key
        ) {
          activateDownloadedExploration(explorationPlan, status);
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setRegionStatusError(
          error instanceof Error
            ? error.message
            : "No se pudo comprobar la región",
        );
      } finally {
        if (!disposed) setRegionStatusLoading(false);
        reading = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [
    activateDownloadedExploration,
    anyRegionDownloadRunning,
    explorationPlan,
    localRuntime?.capacity.configured,
    localRuntime?.job?.id,
    localRuntime?.job?.status,
    regionStatusBounds,
    regionStatusKey,
  ]);

  const applyWorkspaceSnapshot = useCallback(
    (
      workspace: LocalAtlasWorkspace,
      message: string,
      writable: boolean,
    ) => {
      const canonical = consolidateSingleWorkspaceContent(
        localAtlasWorkspaceContent(workspace),
      ) as LocalAtlasWorkspaceContent;
      const restoredHighlights = readHighlightList(
        canonical.highlights,
        { discardInvalid: false },
      );
      if (!restoredHighlights) {
        throw new Error("Los highlights de LuisA no son válidos");
      }
      const singleton = canonical.explorations[0];
      const scopedHighlights = migrateLegacyHighlightScopes(
        restoredHighlights,
        canonical.explorations,
      );
      const restoredExploration =
        singleton &&
        canonical.activeExplorationId === singleton.id
          ? explorationStateFromWorkspace(singleton)
          : null;

      pendingWorkspaceWriteRef.current = null;
      workspacePreconditionRef.current = {
        workspaceId: workspace.workspaceId,
        revision: workspace.revision,
      };
      lastSavedWorkspaceRef.current = JSON.stringify(canonical);
      workspaceContentRef.current = canonical;
      if (!xaeroDefaultScopeAppliedRef.current && singleton) {
        xaeroDefaultScopeAppliedRef.current = true;
        chooseXaeroScope({
          kind: "exploration",
          explorationId: singleton.id,
        });
      } else {
        reconcileXaeroScope(canonical.explorations);
      }
      setSavedExplorations([...canonical.explorations]);
      invalidateXaeroPreview();
      setHighlights(scopedHighlights);
      setCoverageSelection(canonical.coverageSelection);
      if (canonical.coverageSelection) {
        setAtlasFocusedCellIndex(
          canonical.coverageSelection.minRow *
            OVERWORLD_OVERVIEW_COLUMNS +
            canonical.coverageSelection.minColumn,
        );
      }
      if (restoredExploration) {
        stageExplorationPlan(restoredExploration, "hydrated");
      } else {
        explorationStateRef.current = null;
        setExplorationPlan(null);
        setExplorationState(null);
      }
      setWorkspaceReady(true);
      setPersistenceState(writable ? "saved" : "readonly");
      setPersistenceMessage(message);
    },
    [
      chooseXaeroScope,
      invalidateXaeroPreview,
      reconcileXaeroScope,
      stageExplorationPlan,
    ],
  );

  const flushWorkspace = useCallback(async (): Promise<boolean> => {
    const inFlight = workspaceSavePromiseRef.current;
    if (inFlight) return inFlight;

    const task = (async (): Promise<boolean> => {
      let conflictRetries = 0;
      while (true) {
        const runtime = workspaceRuntimeRef.current;
        const latestContent = workspaceContentRef.current
          ? (consolidateSingleWorkspaceContent(
              workspaceContentRef.current,
            ) as LocalAtlasWorkspaceContent)
          : null;
        if (!runtime?.persistence.configured || !latestContent) {
          setPersistenceState("offline");
          setPersistenceMessage("LuisA no está disponible · edición bloqueada");
          return false;
        }
        if (!runtime.persistence.writable) {
          setPersistenceState("readonly");
          setPersistenceMessage("LuisA está en solo lectura · edición bloqueada");
          return false;
        }
        const latestSignature = JSON.stringify(latestContent);
        if (
          pendingWorkspaceWriteRef.current === null &&
          latestSignature === lastSavedWorkspaceRef.current
        ) {
          setPersistenceState("saved");
          setPersistenceMessage("Todo guardado en LuisA");
          return true;
        }
        const expected = workspacePreconditionRef.current;
        if (!expected && pendingWorkspaceWriteRef.current === null) {
          setPersistenceState("error");
          setPersistenceMessage("Falta la revisión segura del workspace");
          return false;
        }
        const pending =
          pendingWorkspaceWriteRef.current ??
          {
            content: latestContent,
            expected: expected!,
            signature: latestSignature,
            writeId: crypto.randomUUID(),
          };
        pendingWorkspaceWriteRef.current = pending;

        setPersistenceState("saving");
        setPersistenceMessage("Guardando cambios en LuisA…");
        try {
          const saved = await writeLocalAtlasWorkspace(
            runtime,
            pending.content,
            pending.expected,
            { writeId: pending.writeId },
          );
          pendingWorkspaceWriteRef.current = null;
          workspacePreconditionRef.current = {
            workspaceId: saved.workspaceId,
            revision: saved.revision,
          };
          lastSavedWorkspaceRef.current = JSON.stringify(
            localAtlasWorkspaceContent(saved),
          );
          const latestAfterSave = workspaceContentRef.current;
          if (
            latestAfterSave &&
            JSON.stringify(latestAfterSave) !==
              lastSavedWorkspaceRef.current
          ) {
            writeBrowserWorkspaceRecovery(
              latestAfterSave,
              workspacePreconditionRef.current,
            );
          } else {
            clearBrowserWorkspaceRecovery();
          }
          setPersistenceState("saved");
          setPersistenceMessage(
            `Guardado en LuisA · ${new Date(saved.updatedAt ?? Date.now()).toLocaleTimeString("es-GT", {
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          );
        } catch (error) {
          if (
            error instanceof LocalAtlasWorkspaceConflictError &&
            error.current &&
            conflictRetries < 2
          ) {
            conflictRetries += 1;
            const currentContent = localAtlasWorkspaceContent(error.current);
            const localCanonical = consolidateSingleWorkspaceContent(
              workspaceContentRef.current ?? pending.content,
            ) as LocalAtlasWorkspaceContent;
            const currentCanonical = consolidateSingleWorkspaceContent(
              currentContent,
            ) as LocalAtlasWorkspaceContent;
            const localId = localCanonical.explorations[0]?.id ?? null;
            const currentId = currentCanonical.explorations[0]?.id ?? null;
            if (localId !== null && localId === currentId) {
              const merged = consolidateSingleWorkspaceContent(
                mergeWorkspaceContentCandidates([
                  localCanonical,
                  currentCanonical,
                ]),
              ) as LocalAtlasWorkspaceContent;
              workspaceContentRef.current = merged;
              reconcileXaeroScope(merged.explorations);
              setSavedExplorations([...merged.explorations]);
              pendingWorkspaceWriteRef.current = {
                content: merged,
                expected: {
                  workspaceId: error.current.workspaceId,
                  revision: error.current.revision,
                },
                signature: JSON.stringify(merged),
                writeId: crypto.randomUUID(),
              };
              continue;
            }
            clearBrowserWorkspaceRecovery();
            applyWorkspaceSnapshot(
              error.current,
              "LuisA cambió en otra pestaña · se cargó la sesión canónica",
              true,
            );
            return true;
          }
          setPersistenceState("error");
          setPersistenceMessage(
            error instanceof Error
              ? error.message
              : "No se pudo guardar en LuisA",
          );
          return false;
        }

        const latest = workspaceContentRef.current;
        if (
          !latest ||
          JSON.stringify(latest) === lastSavedWorkspaceRef.current
        ) {
          return true;
        }
      }
    })();

    workspaceSavePromiseRef.current = task;
    try {
      return await task;
    } finally {
      if (workspaceSavePromiseRef.current === task) {
        workspaceSavePromiseRef.current = null;
      }
    }
  }, [applyWorkspaceSnapshot, reconcileXaeroScope]);

  useEffect(() => {
    if (
      !highlightsReady ||
      !explorationReady ||
      !coverageSelectionReady
    ) {
      return;
    }
    if (!runtimePersistenceConfigured || !runtimeMutationToken) {
      const timeout = window.setTimeout(() => {
        setPersistenceState("offline");
        setPersistenceMessage("LuisA no está disponible · edición bloqueada");
        setWorkspaceReady(false);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    if (
      workspaceHydrationTokenRef.current === runtimeMutationToken
    ) {
      const timeout = window.setTimeout(() => {
        if (!runtimePersistenceWritable) {
          setWorkspaceReady(true);
          setPersistenceState("readonly");
          setPersistenceMessage("LuisA está en solo lectura · edición bloqueada");
        } else {
          setWorkspaceReady(true);
          const latest = workspaceContentRef.current;
          if (
            latest &&
            JSON.stringify(latest) !== lastSavedWorkspaceRef.current
          ) {
            void flushWorkspace();
          } else {
            setPersistenceState("saved");
            setPersistenceMessage("LuisA conectado · todo guardado");
          }
        }
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    workspaceHydrationTokenRef.current = runtimeMutationToken;
    let cancelled = false;
    let hydrationCompleted = false;

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setWorkspaceReady(false);
      setPersistenceState("checking");
      setPersistenceMessage("Leyendo workspace de LuisA…");
      try {
        const runtime = workspaceRuntimeRef.current;
        if (!runtime?.persistence.configured) {
          throw new Error("La persistencia de LuisA dejó de estar disponible");
        }
        let diskWorkspace = await readLocalAtlasWorkspace();
        if (cancelled || !diskWorkspace) {
          throw new Error("LuisA no devolvió un workspace");
        }
        pendingWorkspaceWriteRef.current = null;
        const initialDiskWorkspace = diskWorkspace;
        const recoveries = readBrowserWorkspaceRecoveries();
        const diskContent = localAtlasWorkspaceContent(initialDiskWorkspace);
        const legacyMigration =
          diskContent.explorations.length > MAX_WORKSPACE_EXPLORATIONS ||
          recoveries.some(
            (recovery) =>
              recovery.content.explorations.length >
              MAX_WORKSPACE_EXPLORATIONS,
          );
        const exactRecovery = recoveries.find(
          (recovery) =>
            recovery.base?.workspaceId === initialDiskWorkspace.workspaceId &&
            recovery.base.revision === initialDiskWorkspace.revision,
        );
        const staleProgressRecovery = exactRecovery
          ? null
          : recoveries.find(
              (recovery) =>
                recovery.base?.workspaceId ===
                  initialDiskWorkspace.workspaceId &&
                recovery.base.revision < initialDiskWorkspace.revision &&
                mergeMatchingWorkspaceProgress(
                  diskContent,
                  recovery.content,
                ) !== null,
            ) ?? null;
        const recoveryCandidate = exactRecovery
          ? exactRecovery.content
          : staleProgressRecovery
            ? mergeMatchingWorkspaceProgress(
                diskContent,
                staleProgressRecovery.content,
              )
            : null;
        const shouldReplayRecovery =
          recoveryCandidate &&
          JSON.stringify(recoveryCandidate) !==
            JSON.stringify(diskContent);

        if (
          runtime.persistence.writable &&
          (legacyMigration || shouldReplayRecovery)
        ) {
          const candidates = legacyMigration
            ? [
                ...recoveries.map((recovery) => recovery.content),
                diskContent,
              ]
            : [recoveryCandidate!, diskContent];
          const migrationCandidate =
            mergeWorkspaceContentCandidates(candidates);
          try {
            diskWorkspace = await writeLocalAtlasWorkspace(
              runtime,
              migrationCandidate,
              {
                workspaceId: diskWorkspace.workspaceId,
                revision: diskWorkspace.revision,
              },
            );
          } catch (error) {
            if (
              !(error instanceof LocalAtlasWorkspaceConflictError) ||
              !error.current
            ) {
              throw error;
            }
            const retryCandidate = mergeWorkspaceContentCandidates([
              ...candidates,
              localAtlasWorkspaceContent(error.current),
            ]);
            diskWorkspace = await writeLocalAtlasWorkspace(
              runtime,
              retryCandidate,
              {
                workspaceId: error.current.workspaceId,
                revision: error.current.revision,
              },
            );
          }
          if (cancelled) return;
          clearLegacyBrowserWorkspaceCaches();
          applyWorkspaceSnapshot(
            diskWorkspace,
            legacyMigration
              ? "Sesión única saneada y guardada en LuisA"
              : "Recuperación aplicada a la sesión única",
            true,
          );
        } else {
          if (runtime.persistence.writable) {
            clearLegacyBrowserWorkspaceCaches();
          }
          applyWorkspaceSnapshot(
            diskWorkspace,
            runtime.persistence.writable
              ? diskWorkspace.updatedAt
                ? `Sesión única restaurada desde LuisA · rev. ${diskWorkspace.revision}`
                : "Sesión única de LuisA lista"
              : "Restaurado desde LuisA · solo lectura",
            runtime.persistence.writable,
          );
        }
        hydrationCompleted = true;
      } catch (error) {
        if (cancelled) return;
        workspaceHydrationTokenRef.current = null;
        setWorkspaceReady(false);
        setPersistenceState("error");
        setPersistenceMessage(
          error instanceof Error
            ? error.message
            : "No se pudo leer LuisA",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (
        !hydrationCompleted &&
        workspaceHydrationTokenRef.current === runtimeMutationToken
      ) {
        workspaceHydrationTokenRef.current = null;
      }
    };
  }, [
    coverageSelectionReady,
    explorationReady,
    applyWorkspaceSnapshot,
    flushWorkspace,
    highlightsReady,
    runtimeMutationToken,
    runtimePersistenceConfigured,
    runtimePersistenceWritable,
    runtimeChecked,
  ]);

  useLayoutEffect(() => {
    if (
      !workspaceReady ||
      JSON.stringify(workspaceContent) === lastSavedWorkspaceRef.current
    ) {
      return;
    }
    const existingRecovery = readBrowserWorkspaceRecovery();
    const stored = writeBrowserWorkspaceRecovery(
      workspaceContent,
      workspacePreconditionRef.current ?? existingRecovery?.base ?? null,
    );
    if (!stored) {
      const timeout = window.setTimeout(
        () => notify("El navegador no pudo actualizar la copia de recuperación"),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [notify, workspaceContent, workspaceReady]);

  useEffect(() => {
    if (
      !workspaceReady ||
      !runtimePersistenceConfigured ||
      !runtimePersistenceWritable ||
      JSON.stringify(workspaceContent) === lastSavedWorkspaceRef.current
    ) {
      return;
    }
    scheduleWorkspaceAutosave(
      workspaceSaveTimerRef,
      () => void flushWorkspace(),
      (callback, delayMs) => window.setTimeout(callback, delayMs),
    );
  }, [
    flushWorkspace,
    runtimePersistenceConfigured,
    runtimePersistenceWritable,
    workspaceContent,
    workspaceReady,
  ]);

  useEffect(() => {
    const preserveLatestWorkspace = () => {
      if (!workspacePreconditionRef.current) return;
      const latest = workspaceContentRef.current;
      if (
        latest &&
        JSON.stringify(latest) !== lastSavedWorkspaceRef.current
      ) {
        journalWorkspace(latest);
        void flushWorkspace();
      }
    };
    const preserveWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        preserveLatestWorkspace();
      }
    };
    window.addEventListener("pagehide", preserveLatestWorkspace);
    document.addEventListener("visibilitychange", preserveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", preserveLatestWorkspace);
      document.removeEventListener("visibilitychange", preserveWhenHidden);
      preserveLatestWorkspace();
      cancelWorkspaceAutosave(
        workspaceSaveTimerRef,
        (timer) => window.clearTimeout(timer),
      );
    };
  }, [flushWorkspace, journalWorkspace]);

  const ensureTile = useCallback(
    (key: TileKey) => {
      const cacheKey = tileCacheKey(key);
      if (tileCacheRef.current.has(cacheKey)) return;
      const generation = tileGenerationRef.current;
      tileCacheRef.current.set(cacheKey, { status: "loading" });

      const finish = (record: TileRecord) => {
        if (generation !== tileGenerationRef.current) {
          record.bitmap?.close();
          return;
        }
        tileCacheRef.current.set(cacheKey, record);
        if (record.status === "loaded" && record.source) {
          setLoadedTileKeys((current) => {
            if (current.has(cacheKey)) return current;
            const next = new Set(current);
            next.add(cacheKey);
            return next;
          });
          setTileStats((stats) => ({
            ...stats,
              [record.source!]: stats[record.source!] + 1,
            }));
        } else if (record.status === "missing") {
          setLoadedTileKeys((current) => {
            if (!current.has(cacheKey)) return current;
            const next = new Set(current);
            next.delete(cacheKey);
            return next;
          });
          setTileStats((stats) => ({ ...stats, missing: stats.missing + 1 }));
        }

        if (tileCacheRef.current.size > 360) {
          const entries = tileCacheRef.current.entries();
          while (tileCacheRef.current.size > 300) {
            const next = entries.next();
            if (next.done) break;
            next.value[1].bitmap?.close();
            tileCacheRef.current.delete(next.value[0]);
          }
        }
        setRenderVersion((version) => version + 1);
      };

      void (async () => {
        try {
          const source = localSourceRef.current;
          if (source) {
            const localBitmap = await source.withTile(key, async (tile) =>
              createImageBitmap(tile.file),
            );
            if (localBitmap) {
              finish({
                status: "loaded",
                bitmap: localBitmap,
                source: "local",
              });
              return;
            }
          }

          const response = await fetch(localTileUrl(key));
          if (response.ok) {
            const bitmap = await createImageBitmap(await response.blob());
            finish({
              status: "loaded",
              bitmap,
              source: "local",
            });
            return;
          }
          if (response.status === 404) {
            finish({ status: "missing" });
            return;
          }
          finish({ status: "missing" });
        } catch {
          finish({ status: "error" });
        }
      })();
    },
    [],
  );

  useEffect(() => {
    if (
      atlasMode ||
      !activeExplorationIsMaxDetail ||
      !currentExplorationCell
    ) {
      return;
    }
    ensureTile({
      layer: "base",
      lod: MAX_DETAIL_EXPLORATION_LOD,
      dimension: "overworld",
      tileX: currentExplorationCell.tileX,
      tileZ: currentExplorationCell.tileZ,
    });
  }, [
    activeExplorationIsMaxDetail,
    atlasMode,
    currentExplorationCell,
    ensureTile,
  ]);

  const worldAtScreen = useCallback(
    (screenX: number, screenY: number) => ({
      x: camera.x + (screenX - viewSize.width / 2) / scale,
      z: camera.z + (screenY - viewSize.height / 2) / scale,
    }),
    [camera, scale, viewSize],
  );

  const screenAtWorld = useCallback(
    (worldX: number, worldZ: number) => ({
      x: viewSize.width / 2 + (worldX - camera.x) * scale,
      y: viewSize.height / 2 + (worldZ - camera.z) * scale,
    }),
    [camera, scale, viewSize],
  );

  const drawMapTile = useCallback(
    (
      context: CanvasRenderingContext2D,
      key: TileKey,
      destination: { readonly x: number; readonly y: number },
      destinationSize: number,
    ): number | null => {
      ensureTile(key);
      const record = tileCacheRef.current.get(tileCacheKey(key));
      if (record?.status === "loaded" && record.bitmap) {
        try {
          context.drawImage(
            record.bitmap,
            destination.x,
            destination.y,
            destinationSize + 0.5,
            destinationSize + 0.5,
          );
          return null;
        } catch {
          record.bitmap.close();
          tileCacheRef.current.delete(tileCacheKey(key));
          ensureTile(key);
        }
      }

      if (!allowsAncestorTileFallback(key.layer)) {
        return null;
      }

      let mayRequestAncestor =
        record?.status === "missing" || record?.status === "error";
      let requestedAncestor = false;
      for (
        let fallbackLod = key.lod + 1;
        fallbackLod <= MAX_TILE_LOD;
        fallbackLod += 1
      ) {
        const crop = resolveAncestorTileCrop(key, fallbackLod);
        const parentKey: TileKey = {
          ...key,
          lod: fallbackLod,
          tileX: crop.tileX,
          tileZ: crop.tileZ,
        };
        const parent = tileCacheRef.current.get(tileCacheKey(parentKey));
        if (parent?.status !== "loaded" || !parent.bitmap) {
          if (!parent && mayRequestAncestor && !requestedAncestor) {
            ensureTile(parentKey);
            requestedAncestor = true;
            mayRequestAncestor = false;
          } else if (
            parent?.status === "missing" ||
            parent?.status === "error"
          ) {
            mayRequestAncestor = true;
          } else if (parent?.status === "loading") {
            mayRequestAncestor = false;
          }
          continue;
        }
        try {
          context.drawImage(
            parent.bitmap,
            crop.sourceX,
            crop.sourceZ,
            crop.sourceSize,
            crop.sourceSize,
            destination.x,
            destination.y,
            destinationSize + 0.5,
            destinationSize + 0.5,
          );
        } catch {
          parent.bitmap.close();
          tileCacheRef.current.delete(tileCacheKey(parentKey));
          ensureTile(parentKey);
          continue;
        }
        return fallbackLod;
      }
      return null;
    },
    [ensureTile],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(viewSize.width * ratio);
    canvas.height = Math.round(viewSize.height * ratio);
    canvas.style.width = `${viewSize.width}px`;
    canvas.style.height = `${viewSize.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, viewSize.width, viewSize.height);
    context.fillStyle = "#07111d";
    context.fillRect(0, 0, viewSize.width, viewSize.height);
    context.imageSmoothingEnabled = false;

    const halfWorldWidth = viewSize.width / (2 * scale);
    const halfWorldHeight = viewSize.height / (2 * scale);
    const minX = camera.x - halfWorldWidth;
    const maxX = camera.x + halfWorldWidth;
    const minZ = camera.z - halfWorldHeight;
    const maxZ = camera.z + halfWorldHeight;
    const tileSpan = blocksPerTileAtLod(lod);
    const minTileX = Math.floor(minX / tileSpan) - 1;
    const maxTileX = Math.floor(maxX / tileSpan) + 1;
    const minTileZ = Math.floor(minZ / tileSpan) - 1;
    const maxTileZ = Math.floor(maxZ / tileSpan) + 1;

    let deepestFallbackLod: number | null = null;
    for (const layer of layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      context.globalAlpha = layer.opacity;
      for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          const key: TileKey = {
            layer: layer.id,
            lod,
            dimension: "overworld",
            tileX,
            tileZ,
          };
          const worldOriginX = tileX * tileSpan;
          const worldOriginZ = tileZ * tileSpan;
          const destination = screenAtWorld(worldOriginX, worldOriginZ);
          const destinationSize = tileSpan * scale;
          const fallbackLod = drawMapTile(
            context,
            key,
            destination,
            destinationSize,
          );
          if (fallbackLod !== null) {
            deepestFallbackLod =
              deepestFallbackLod === null
                ? fallbackLod
                : Math.max(deepestFallbackLod, fallbackLod);
          }
        }
      }
    }
    context.globalAlpha = 1;

    if (showGrid) {
      const gridMinX = Math.floor(minX / gridStep) * gridStep;
      const gridMinZ = Math.floor(minZ / gridStep) * gridStep;
      context.lineWidth = 1;
      context.strokeStyle = "rgba(231, 242, 255, 0.16)";
      context.fillStyle = "rgba(240, 247, 255, 0.74)";
      context.font = "11px var(--font-geist-mono), monospace";
      for (let x = gridMinX; x <= maxX; x += gridStep) {
        const point = screenAtWorld(x, camera.z);
        context.beginPath();
        context.moveTo(Math.round(point.x) + 0.5, 0);
        context.lineTo(Math.round(point.x) + 0.5, viewSize.height);
        context.stroke();
        if (point.x > 56 && point.x < viewSize.width - 100) {
          context.fillText(`X ${Math.round(x)}`, point.x + 6, 24);
        }
      }
      for (let z = gridMinZ; z <= maxZ; z += gridStep) {
        const point = screenAtWorld(camera.x, z);
        context.beginPath();
        context.moveTo(0, Math.round(point.y) + 0.5);
        context.lineTo(viewSize.width, Math.round(point.y) + 0.5);
        context.stroke();
        if (point.y > 52 && point.y < viewSize.height - 70) {
          context.fillText(`Z ${Math.round(z)}`, 12, point.y - 7);
        }
      }
    }

    if (atlasMode || (showCoverageGrid && !explorationState)) {
      const overviewCellSize = OVERWORLD_OVERVIEW_CELL_BLOCKS * scale;
      for (let index = 0; index < OVERWORLD_OVERVIEW_CELL_COUNT; index += 1) {
        const cell = overviewCellForIndex(index);
        if (
          cell.bounds.maxXExclusive < minX ||
          cell.bounds.minX > maxX ||
          cell.bounds.maxZExclusive < minZ ||
          cell.bounds.minZ > maxZ
        ) {
          continue;
        }
        const point = screenAtWorld(cell.bounds.minX, cell.bounds.minZ);
        const selected =
          visibleCoverageSelection !== null &&
          cell.row >= visibleCoverageSelection.minRow &&
          cell.row < visibleCoverageSelection.maxRowExclusive &&
          cell.column >= visibleCoverageSelection.minColumn &&
          cell.column < visibleCoverageSelection.maxColumnExclusive;
        const focused = atlasMode && index === atlasFocusedCellIndex;
        const progress = atlasProgress?.sectors[index] ?? null;
        const progressStatus = progress?.status ?? "pending";
        const filtered =
          atlasMode &&
          atlasStatusFilter !== "all" &&
          progressStatus !== atlasStatusFilter;

        context.globalAlpha = 1;
        context.fillStyle =
          atlasMode
            ? selected
              ? "rgba(98, 168, 255, 0.34)"
              : atlasProgressFill(progressStatus, filtered)
            : selected
              ? "rgba(98, 168, 255, 0.22)"
              : cell.coverageStatus === "full"
                ? "rgba(38, 217, 199, 0.045)"
                : cell.coverageStatus === "partial"
                  ? "rgba(255, 189, 74, 0.09)"
                  : "rgba(2, 8, 15, 0.38)";
        context.fillRect(
          point.x,
          point.y,
          overviewCellSize,
          overviewCellSize,
        );
        if (
          atlasMode &&
          progressStatus === "in-progress" &&
          !filtered &&
          overviewCellSize >= 9
        ) {
          context.save();
          context.beginPath();
          context.rect(
            point.x,
            point.y,
            overviewCellSize,
            overviewCellSize,
          );
          context.clip();
          context.strokeStyle = "rgba(255, 210, 120, 0.22)";
          context.lineWidth = 1;
          for (
            let stripe = -overviewCellSize;
            stripe < overviewCellSize * 2;
            stripe += 7
          ) {
            context.beginPath();
            context.moveTo(point.x + stripe, point.y + overviewCellSize);
            context.lineTo(point.x + stripe + overviewCellSize, point.y);
            context.stroke();
          }
          context.restore();
        }
        context.lineWidth = selected ? 2.5 : focused ? 2 : 1;
        context.strokeStyle = selected
          ? "rgba(133, 196, 255, 0.98)"
          : focused
            ? "rgba(255, 255, 255, 0.92)"
            : atlasMode
              ? atlasProgressStroke(progressStatus, filtered)
              : cell.coverageStatus === "full"
                ? "rgba(94, 242, 219, 0.36)"
                : cell.coverageStatus === "partial"
                  ? "rgba(255, 196, 87, 0.58)"
                  : "rgba(164, 178, 195, 0.16)";
        context.setLineDash(
          selected ||
            focused ||
            (atlasMode && progressStatus !== "pending") ||
            cell.coverageStatus === "full"
            ? []
            : [4, 4],
        );
        context.strokeRect(
          point.x + 0.5,
          point.y + 0.5,
          overviewCellSize - 1,
          overviewCellSize - 1,
        );
        context.setLineDash([]);

        if (overviewCellSize >= 34 && cell.coverageStatus !== "empty") {
          context.font = "600 10px var(--font-geist-mono), monospace";
          context.fillStyle = selected
            ? "rgba(225, 242, 255, 0.98)"
            : "rgba(225, 236, 246, 0.78)";
          context.fillText(
            atlasMode && progress
              ? `${cell.id} · ${Math.round(progress.percent)}%`
              : `${cell.id} · ${cell.availableTileCount}/64`,
            point.x + 8,
            point.y + 17,
          );
        } else if (
          atlasMode &&
          overviewCellSize >= 14 &&
          progressStatus !== "pending" &&
          !filtered
        ) {
          context.fillStyle =
            progressStatus === "complete"
              ? "rgba(153, 255, 241, 0.96)"
              : "rgba(255, 222, 157, 0.96)";
          context.beginPath();
          context.arc(
            point.x + overviewCellSize / 2,
            point.y + overviewCellSize / 2,
            Math.max(2, Math.min(4, overviewCellSize * 0.13)),
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }

      const observedStart = screenAtWorld(
        OVERWORLD_OBSERVED_DATA_BOUNDS.minX,
        OVERWORLD_OBSERVED_DATA_BOUNDS.minZ,
      );
      const observedEnd = screenAtWorld(
        OVERWORLD_OBSERVED_DATA_BOUNDS.maxXExclusive,
        OVERWORLD_OBSERVED_DATA_BOUNDS.maxZExclusive,
      );
      context.lineWidth = 2;
      context.strokeStyle = "rgba(255, 209, 120, 0.78)";
      context.setLineDash([9, 7]);
      context.strokeRect(
        observedStart.x,
        observedStart.y,
        observedEnd.x - observedStart.x,
        observedEnd.y - observedStart.y,
      );
      context.setLineDash([]);
    }

    if (atlasMode && explorationState) {
      const bounds = explorationState.region.bounds;
      const center = screenAtWorld(
        (bounds.minX + bounds.maxXExclusive) / 2,
        (bounds.minZ + bounds.maxZExclusive) / 2,
      );
      context.beginPath();
      context.fillStyle = "#62a8ff";
      context.strokeStyle = "rgba(4, 11, 20, 0.94)";
      context.lineWidth = 3;
      context.arc(center.x, center.y, 6, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    if (explorationState && !atlasMode) {
      const region = explorationState.region;
      const firstTileX = Math.max(
        region.minTileX,
        Math.floor(minX / region.tileSpan),
      );
      const lastTileXExclusive = Math.min(
        region.maxTileXExclusive,
        Math.floor(maxX / region.tileSpan) + 1,
      );
      const firstTileZ = Math.max(
        region.minTileZ,
        Math.floor(minZ / region.tileSpan),
      );
      const lastTileZExclusive = Math.min(
        region.maxTileZExclusive,
        Math.floor(maxZ / region.tileSpan) + 1,
      );
      const cellSize = region.tileSpan * scale;
      context.font = "10px var(--font-geist-mono), monospace";
      context.textBaseline = "top";
      for (
        let tileZ = firstTileZ;
        tileZ < lastTileZExclusive;
        tileZ += 1
      ) {
        for (
          let tileX = firstTileX;
          tileX < lastTileXExclusive;
          tileX += 1
        ) {
          const index = cellIndexAtTile(region, tileX, tileZ);
          if (index === null) continue;
          const point = screenAtWorld(
            tileX * region.tileSpan,
            tileZ * region.tileSpan,
          );
          const current = index === explorationState.currentIndex;
          const reviewed = isCellReviewed(explorationState, index);
          const appearance = explorationCellAppearance(
            explorationState,
            index,
          );
          const visual = EXPLORATION_CELL_VISUALS[appearance];
          context.globalAlpha = 1;
          context.fillStyle = visual.fill;
          context.fillRect(point.x, point.y, cellSize, cellSize);
          context.save();
          context.lineWidth = current ? 3 : reviewed ? 1.5 : 1;
          context.strokeStyle = visual.stroke;
          context.setLineDash(current ? [] : reviewed ? [] : [7, 6]);
          if (visual.glow) {
            context.shadowColor = visual.glow;
            context.shadowBlur = 16;
          }
          context.strokeRect(
            point.x + 0.5,
            point.y + 0.5,
            cellSize - 1,
            cellSize - 1,
          );
          context.restore();
          if (cellSize >= 94) {
            const cell = cellForIndex(region, index);
            context.fillStyle = visual.label;
            context.fillText(
              `F${cell.row + 1} · C${cell.column + 1}`,
              point.x + 9,
              point.y + 9,
            );
          }
        }
      }
      context.textBaseline = "alphabetic";
    }

    if (highlightRoute) {
      drawHighlightRouteSegments(
        context,
        highlightRoute.overlay,
        screenAtWorld,
      );
    }

    for (const highlight of renderedHighlights) {
      if (!highlight.visible) continue;
      const selected = !atlasMode && highlight.id === selectedHighlightId;
      context.strokeStyle = highlight.color;
      context.fillStyle = highlight.color;
      context.lineWidth = selected ? 3 : 2;
      context.shadowColor = "rgba(0,0,0,.5)";
      context.shadowBlur = 10;

      if (atlasMode) {
        const point = screenAtWorld(highlight.x, highlight.z);
        if (
          point.x < -2 ||
          point.y < -2 ||
          point.x > viewSize.width + 2 ||
          point.y > viewSize.height + 2
        ) {
          continue;
        }
        context.globalAlpha = 0.92;
        context.shadowBlur = 0;
        context.fillStyle = highlight.color;
        context.fillRect(
          Math.round(point.x) - 1,
          Math.round(point.y) - 1,
          3,
          3,
        );
        context.globalAlpha = 1;
        continue;
      }

      if (compactHighlights) {
        const point = screenAtWorld(highlight.x, highlight.z);
        const radius = selected ? 3 : 2;
        context.shadowBlur = 3;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
        context.strokeStyle = selected
          ? "rgba(255, 255, 255, 0.98)"
          : "rgba(255, 255, 255, 0.72)";
        context.lineWidth = selected ? 2 : 1;
        context.stroke();
        if (selected) {
          context.beginPath();
          context.arc(point.x, point.y, 5.5, 0, Math.PI * 2);
          context.strokeStyle = highlight.color;
          context.lineWidth = 1.5;
          context.stroke();
        }
        continue;
      }

      if (highlight.type === "area" && highlight.bounds) {
        const start = screenAtWorld(
          Math.min(highlight.bounds.x1, highlight.bounds.x2),
          Math.min(highlight.bounds.z1, highlight.bounds.z2),
        );
        const end = screenAtWorld(
          Math.max(highlight.bounds.x1, highlight.bounds.x2),
          Math.max(highlight.bounds.z1, highlight.bounds.z2),
        );
        context.globalAlpha = 0.17;
        context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.globalAlpha = 0.95;
        context.setLineDash(selected ? [] : [7, 5]);
        context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.setLineDash([]);
      } else {
        const point = screenAtWorld(highlight.x, highlight.z);
        context.beginPath();
        context.arc(point.x, point.y, selected ? 10 : 8, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.stroke();
        context.beginPath();
        context.moveTo(point.x, point.y + 8);
        context.lineTo(point.x, point.y + 18);
        context.strokeStyle = highlight.color;
        context.stroke();
      }

      const labelPoint = screenAtWorld(highlight.x, highlight.z);
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      context.font = "600 12px var(--font-geist-sans), sans-serif";
      const labelWidth = context.measureText(highlight.title).width + 16;
      context.fillStyle = "rgba(5, 13, 24, .88)";
      context.fillRect(
        labelPoint.x + 13,
        labelPoint.y - 14,
        labelWidth,
        24,
      );
      context.fillStyle = "#f8fbff";
      context.fillText(highlight.title, labelPoint.x + 21, labelPoint.y + 2);
    }

    if (highlightRoute) {
      drawHighlightRouteMarkers(
        context,
        highlightRoute.overlay,
        screenAtWorld,
        viewSize,
      );
    }

    if (areaPreview) {
      const start = screenAtWorld(
        Math.min(areaPreview.x1, areaPreview.x2),
        Math.min(areaPreview.z1, areaPreview.z2),
      );
      const end = screenAtWorld(
        Math.max(areaPreview.x1, areaPreview.x2),
        Math.max(areaPreview.z1, areaPreview.z2),
      );
      context.fillStyle = "rgba(38, 217, 199, .15)";
      context.strokeStyle = "#26d9c7";
      context.lineWidth = 2;
      context.setLineDash([6, 5]);
      context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      context.setLineDash([]);
    }

    if (deepestFallbackLod === null) {
      delete canvas.dataset.fallbackLod;
      if (fallbackBadgeRef.current) {
        fallbackBadgeRef.current.dataset.active = "false";
      }
    } else {
      canvas.dataset.fallbackLod = String(deepestFallbackLod);
      if (fallbackBadgeRef.current) {
        fallbackBadgeRef.current.dataset.active = "true";
      }
      if (fallbackTextRef.current) {
        fallbackTextRef.current.textContent = `Hasta LOD ${deepestFallbackLod} · ${blocksPerPixelAtLod(deepestFallbackLod)} bloques/px`;
      }
    }
  }, [
    areaPreview,
    atlasFocusedCellIndex,
    atlasMode,
    atlasProgress,
    atlasStatusFilter,
    camera,
    compactHighlights,
    drawMapTile,
    explorationState,
    gridStep,
    highlightRoute,
    renderedHighlights,
    layers,
    lod,
    renderVersion,
    scale,
    screenAtWorld,
    selectedHighlightId,
    showCoverageGrid,
    showGrid,
    visibleCoverageSelection,
    viewSize,
  ]);

  useEffect(() => {
    if (
      !isExploring ||
      !explorationState ||
      !magnifierEnabled ||
      !magnifierPosition.visible
    ) {
      return;
    }
    const canvas = magnifierCanvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const backingSize = Math.round(MAGNIFIER_SIZE * ratio);
    if (
      canvas.width !== backingSize ||
      canvas.height !== backingSize
    ) {
      canvas.width = backingSize;
      canvas.height = backingSize;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    context.setLineDash([]);
    context.clearRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    context.fillStyle = "#07111d";
    context.fillRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    context.imageSmoothingEnabled = false;

    const center = worldAtScreen(
      magnifierPosition.x,
      magnifierPosition.y,
    );
    const halfWorldSize = MAGNIFIER_SIZE / (2 * magnifierRenderScale);
    const minX = center.x - halfWorldSize;
    const maxX = center.x + halfWorldSize;
    const minZ = center.z - halfWorldSize;
    const maxZ = center.z + halfWorldSize;
    const visibleWorldBounds = { minX, minZ, maxX, maxZ };
    const tileSpan = blocksPerTileAtLod(lod);
    const minTileX = Math.floor(minX / tileSpan) - 1;
    const maxTileX = Math.floor(maxX / tileSpan) + 1;
    const minTileZ = Math.floor(minZ / tileSpan) - 1;
    const maxTileZ = Math.floor(maxZ / tileSpan) + 1;
    const lensAtWorld = (worldX: number, worldZ: number) => ({
      x:
        MAGNIFIER_SIZE / 2 +
        (worldX - center.x) * magnifierRenderScale,
      y:
        MAGNIFIER_SIZE / 2 +
        (worldZ - center.z) * magnifierRenderScale,
    });

    for (const layer of layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      context.globalAlpha = layer.opacity;
      for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          const key: TileKey = {
            layer: layer.id,
            lod,
            dimension: "overworld",
            tileX,
            tileZ,
          };
          const destination = lensAtWorld(
            tileX * tileSpan,
            tileZ * tileSpan,
          );
          const destinationSize = tileSpan * magnifierRenderScale;
          drawMapTile(context, key, destination, destinationSize);
        }
      }
    }
    context.globalAlpha = 1;

    const region = explorationState.region;
    const firstTileX = Math.max(
      region.minTileX,
      Math.floor(minX / region.tileSpan),
    );
    const lastTileXExclusive = Math.min(
      region.maxTileXExclusive,
      Math.floor(maxX / region.tileSpan) + 1,
    );
    const firstTileZ = Math.max(
      region.minTileZ,
      Math.floor(minZ / region.tileSpan),
    );
    const lastTileZExclusive = Math.min(
      region.maxTileZExclusive,
      Math.floor(maxZ / region.tileSpan) + 1,
    );
    const cellSize = region.tileSpan * magnifierRenderScale;
    context.font = "10px var(--font-geist-mono), monospace";
    context.textBaseline = "top";
    for (
      let tileZ = firstTileZ;
      tileZ < lastTileZExclusive;
      tileZ += 1
    ) {
      for (
        let tileX = firstTileX;
        tileX < lastTileXExclusive;
        tileX += 1
      ) {
        const index = cellIndexAtTile(region, tileX, tileZ);
        if (index === null) continue;
        const point = lensAtWorld(
          tileX * region.tileSpan,
          tileZ * region.tileSpan,
        );
        const current = index === explorationState.currentIndex;
        const reviewed = isCellReviewed(explorationState, index);
        const appearance = explorationCellAppearance(
          explorationState,
          index,
        );
        const visual = EXPLORATION_CELL_VISUALS[appearance];
        context.fillStyle = visual.fill;
        context.fillRect(point.x, point.y, cellSize, cellSize);
        context.save();
        context.lineWidth = current ? 3 : reviewed ? 1.5 : 1;
        context.strokeStyle = visual.stroke;
        context.setLineDash(current || reviewed ? [] : [7, 6]);
        if (visual.glow) {
          context.shadowColor = visual.glow;
          context.shadowBlur = 16;
        }
        context.strokeRect(
          point.x + 0.5,
          point.y + 0.5,
          cellSize - 1,
          cellSize - 1,
        );
        context.restore();
        if (cellSize >= 94) {
          const cell = cellForIndex(region, index);
          context.fillStyle = visual.label;
          context.fillText(
            `F${cell.row + 1} · C${cell.column + 1}`,
            point.x + 9,
            point.y + 9,
          );
        }
      }
    }
    context.textBaseline = "alphabetic";

    if (highlightRoute) {
      drawHighlightRouteSegments(
        context,
        highlightRoute.overlay,
        lensAtWorld,
        visibleWorldBounds,
      );
    }

    for (const highlight of renderedHighlights) {
      if (!highlight.visible) continue;
      const renderMargin = 24 / magnifierRenderScale;
      if (highlight.type === "area" && highlight.bounds) {
        if (
          Math.max(highlight.bounds.x1, highlight.bounds.x2) <
            minX - renderMargin ||
          Math.min(highlight.bounds.x1, highlight.bounds.x2) >
            maxX + renderMargin ||
          Math.max(highlight.bounds.z1, highlight.bounds.z2) <
            minZ - renderMargin ||
          Math.min(highlight.bounds.z1, highlight.bounds.z2) >
            maxZ + renderMargin
        ) {
          continue;
        }
      } else if (
        highlight.x < minX - renderMargin ||
        highlight.x > maxX + renderMargin ||
        highlight.z < minZ - renderMargin ||
        highlight.z > maxZ + renderMargin
      ) {
        continue;
      }
      const selected = highlight.id === selectedHighlightId;
      context.strokeStyle = highlight.color;
      context.fillStyle = highlight.color;
      context.lineWidth = selected ? 3 : 2;
      context.shadowColor = "rgba(0,0,0,.5)";
      context.shadowBlur = 8;
      if (highlight.type === "area" && highlight.bounds) {
        const start = lensAtWorld(
          Math.min(highlight.bounds.x1, highlight.bounds.x2),
          Math.min(highlight.bounds.z1, highlight.bounds.z2),
        );
        const end = lensAtWorld(
          Math.max(highlight.bounds.x1, highlight.bounds.x2),
          Math.max(highlight.bounds.z1, highlight.bounds.z2),
        );
        context.globalAlpha = 0.17;
        context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.globalAlpha = 0.95;
        context.setLineDash(selected ? [] : [7, 5]);
        context.strokeRect(
          start.x,
          start.y,
          end.x - start.x,
          end.y - start.y,
        );
        context.setLineDash([]);
      } else {
        const point = lensAtWorld(highlight.x, highlight.z);
        if (
          point.x < -24 ||
          point.y < -24 ||
          point.x > MAGNIFIER_SIZE + 24 ||
          point.y > MAGNIFIER_SIZE + 24
        ) {
          continue;
        }
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(point.x, point.y, selected ? 10 : 8, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.stroke();
      }
    }
    if (highlightRoute) {
      drawHighlightRouteMarkers(
        context,
        highlightRoute.overlay,
        lensAtWorld,
        { width: MAGNIFIER_SIZE, height: MAGNIFIER_SIZE },
        visibleWorldBounds,
      );
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
  }, [
    drawMapTile,
    explorationState,
    highlightRoute,
    isExploring,
    layers,
    lod,
    magnifierEnabled,
    magnifierPosition,
    magnifierRenderScale,
    renderedHighlights,
    renderVersion,
    selectedHighlightId,
    worldAtScreen,
  ]);

  const zoomAt = useCallback(
    (factor: number, screenX = viewSize.width / 2, screenY = viewSize.height / 2) => {
      const anchor = worldAtScreen(screenX, screenY);
      const nextScale = clamp(
        scale * factor,
        atlasMode
          ? ATLAS_MIN_SCALE
          : explorationState
            ? explorationMinimumScale
            : MIN_SCALE,
        MAX_SCALE,
      );
      setCamera(
        constrainActiveExplorationCamera(
          {
            x: anchor.x - (screenX - viewSize.width / 2) / nextScale,
            z: anchor.z - (screenY - viewSize.height / 2) / nextScale,
          },
          nextScale,
        ),
      );
      setScale(nextScale);
    },
    [
      atlasMode,
      constrainActiveExplorationCamera,
      explorationMinimumScale,
      explorationState,
      scale,
      viewSize,
      worldAtScreen,
    ],
  );

  const hitHighlight = useCallback(
    (screenX: number, screenY: number) => {
      return [...scopedHighlights]
        .reverse()
        .find((highlight) => {
          if (!highlight.visible) return false;
          if (
            !compactHighlights &&
            highlight.type === "area" &&
            highlight.bounds
          ) {
            const start = screenAtWorld(
              Math.min(highlight.bounds.x1, highlight.bounds.x2),
              Math.min(highlight.bounds.z1, highlight.bounds.z2),
            );
            const end = screenAtWorld(
              Math.max(highlight.bounds.x1, highlight.bounds.x2),
              Math.max(highlight.bounds.z1, highlight.bounds.z2),
            );
            return (
              screenX >= start.x &&
              screenX <= end.x &&
              screenY >= start.y &&
              screenY <= end.y
            );
          }
          const point = screenAtWorld(highlight.x, highlight.z);
          return (
            Math.hypot(point.x - screenX, point.y - screenY) <=
            (compactHighlights ? 10 : 18)
          );
        });
    },
    [compactHighlights, scopedHighlights, screenAtWorld],
  );

  const addPin = useCallback(
    (
      point: Camera,
      options: { title?: string; openEditor?: boolean } = {},
    ) => {
      if (highlights.length >= MAX_WORKSPACE_HIGHLIGHTS) {
        setMarkMode(null);
        notify("El workspace alcanzó el límite de 10,000 highlights");
        return;
      }
      const id = crypto.randomUUID();
      const title =
        (options.title ? normalizeHighlightName(options.title) : null) ??
        highlightLabel(highlights.length, "pin");
      const highlight: Highlight = {
        id,
        type: "pin",
        title,
        note: "",
        color: COLORS[highlights.length % COLORS.length],
        regionKey: explorationState
          ? highlightRegionKey(explorationState.region.bounds)
          : null,
        x: Math.round(point.x),
        z: Math.round(point.z),
        visible: true,
        createdAt: new Date().toISOString(),
      };
      invalidateXaeroPreview();
      setHighlights((items) => [...items, highlight]);
      if (options.openEditor === false) {
        setSelectedHighlightId(null);
      } else {
        setSelectedHighlightId(id);
        setDrawer("highlights");
      }
      setMarkMode(null);
      notify(`${title} guardado`);
    },
    [
      explorationState,
      highlights.length,
      invalidateXaeroPreview,
      notify,
    ],
  );

  const addArea = useCallback(
    (bounds: NonNullable<Highlight["bounds"]>) => {
      if (highlights.length >= MAX_WORKSPACE_HIGHLIGHTS) {
        areaPreviewRef.current = undefined;
        setAreaPreview(undefined);
        setMarkMode(null);
        notify("El workspace alcanzó el límite de 10,000 highlights");
        return;
      }
      const x1 = Math.round(bounds.x1);
      const z1 = Math.round(bounds.z1);
      const x2 = Math.round(bounds.x2);
      const z2 = Math.round(bounds.z2);
      if (Math.abs(x2 - x1) < 2 || Math.abs(z2 - z1) < 2) return;
      const id = crypto.randomUUID();
      const highlight: Highlight = {
        id,
        type: "area",
        title: highlightLabel(highlights.length, "area"),
        note: "",
        color: COLORS[highlights.length % COLORS.length],
        regionKey: explorationState
          ? highlightRegionKey(explorationState.region.bounds)
          : null,
        x: Math.round((x1 + x2) / 2),
        z: Math.round((z1 + z2) / 2),
        bounds: { x1, z1, x2, z2 },
        visible: true,
        createdAt: new Date().toISOString(),
      };
      invalidateXaeroPreview();
      setHighlights((items) => [...items, highlight]);
      setSelectedHighlightId(id);
      setDrawer("highlights");
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      setMarkMode(null);
      notify("Área guardada");
    },
    [
      explorationState,
      highlights.length,
      invalidateXaeroPreview,
      notify,
    ],
  );

  const captureRegionBounds = useCallback(
    (bounds: NonNullable<Highlight["bounds"]>) => {
      const minX = Math.floor(Math.min(bounds.x1, bounds.x2));
      const minZ = Math.floor(Math.min(bounds.z1, bounds.z2));
      const maxXExclusive = Math.ceil(Math.max(bounds.x1, bounds.x2));
      const maxZExclusive = Math.ceil(Math.max(bounds.z1, bounds.z2));
      if (maxXExclusive - minX < 2 || maxZExclusive - minZ < 2) return;
      setRegionForm((current) => ({
        ...current,
        minX: String(minX),
        minZ: String(minZ),
        maxXExclusive: String(maxXExclusive),
        maxZExclusive: String(maxZExclusive),
      }));
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      setMarkMode(null);
      setDrawer("exploration");
      notify("Región capturada; revisa sus límites");
    },
    [notify],
  );

  const applyCoverageSelectionToRegion = useCallback(
    (selection: OverworldCoverageSelection) => {
      setRegionForm((current) => ({
        ...current,
        name:
          selection.cellCount === 1
            ? `Sector F${selection.minRow + 1} · C${selection.minColumn + 1}`
            : `Región ${selection.rows}×${selection.columns}`,
        minX: String(selection.bounds.minX),
        minZ: String(selection.bounds.minZ),
        maxXExclusive: String(selection.bounds.maxXExclusive),
        maxZExclusive: String(selection.bounds.maxZExclusive),
      }));
    },
    [],
  );

  const commitCoverageSelection = useCallback(
    (
      selection: OverworldCoverageSelection,
      focusedCellIndex =
        selection.minRow * OVERWORLD_OVERVIEW_COLUMNS +
        selection.minColumn,
    ) => {
      const nextKey = boundsKey(selection.bounds);
      setExplorationPlan((current) =>
        current && boundsKey(current.state.region.bounds) === nextKey
          ? current
          : null,
      );
      setRegionStatusSnapshot((current) =>
        current?.key === nextKey ? current : null,
      );
      setRegionStatusError(null);
      setCoverageSelection(selection);
      setCoveragePreview(null);
      applyCoverageSelectionToRegion(selection);
      setAtlasFocusedCellIndex(focusedCellIndex);
      setDrawer(atlasMode ? "atlas" : "exploration");
      notify(
        `${selection.availableCellCount.toLocaleString("es-GT")} sectores con datos seleccionados`,
      );
    },
    [applyCoverageSelectionToRegion, atlasMode, notify],
  );

  const selectAtlasCell = useCallback(
    (index: number) => {
      const selection = coverageSelectionForOverviewCellIndex(index);
      if (!selection) {
        setExplorationPlan(null);
        setRegionStatusSnapshot(null);
        setRegionStatusError(null);
        setCoverageSelection(null);
        setCoveragePreview(null);
        setAtlasFocusedCellIndex(index);
        notify("Ese sector no contiene datos publicados del Overworld");
        return false;
      }
      commitCoverageSelection(selection, index);
      return true;
    },
    [commitCoverageSelection, notify],
  );

  const fitAtlasView = useCallback(() => {
    const bounds = OVERWORLD_OVERVIEW_GRID_BOUNDS;
    const leftInset = 515;
    const rightInset = 28;
    const topInset = 96;
    const bottomInset = 72;
    const availableWidth = Math.max(
      120,
      viewSize.width - leftInset - rightInset,
    );
    const availableHeight = Math.max(
      120,
      viewSize.height - topInset - bottomInset,
    );
    const worldWidth = bounds.maxXExclusive - bounds.minX;
    const worldHeight = bounds.maxZExclusive - bounds.minZ;
    const nextScale = Math.min(
      availableWidth / worldWidth,
      availableHeight / worldHeight,
    );
    const targetScreenX =
      leftInset + (viewSize.width - rightInset - leftInset) / 2;
    const targetScreenY =
      topInset + (viewSize.height - bottomInset - topInset) / 2;
    const worldCenterX = (bounds.minX + bounds.maxXExclusive) / 2;
    const worldCenterZ = (bounds.minZ + bounds.maxZExclusive) / 2;
    setCamera({
      x:
        worldCenterX -
        (targetScreenX - viewSize.width / 2) / nextScale,
      z:
        worldCenterZ -
        (targetScreenY - viewSize.height / 2) / nextScale,
    });
    setScale(nextScale);
  }, [viewSize]);

  const viewFullCoverage = useCallback(() => {
    if (!atlasMode) {
      atlasReturnViewRef.current = { camera, scale };
    }
    setTopbarRevealed(false);
    setShowCoverageGrid(true);
    setMarkMode(null);
    setAtlasStatusFilter("all");
    setDrawer("atlas");
    fitAtlasView();
    window.requestAnimationFrame(() => canvasRef.current?.focus());
    notify("Atlas LOD 0 · selecciona una región para explorar");
  }, [atlasMode, camera, fitAtlasView, notify, scale]);

  const closeAtlas = useCallback(
    (nextDrawer: Drawer = null) => {
      const previous = atlasReturnViewRef.current;
      atlasReturnViewRef.current = null;
      setTopbarRevealed(false);
      setMarkMode(null);
      setCoveragePreview(null);
      setDrawer(nextDrawer);
      const restored = resolveAtlasExitView(
        previous,
        explorationState !== null,
        { camera: INITIAL_CAMERA, scale: INITIAL_SCALE },
      );
      if (restored) {
        setCamera(restored.camera);
        setScale(restored.scale);
      } else if (explorationState) {
        focusExploration(explorationState, { mode: "fit" });
      }
    },
    [explorationState, focusExploration],
  );

  useEffect(() => {
    if (!atlasMode) return;
    const frame = window.requestAnimationFrame(fitAtlasView);
    return () => window.cancelAnimationFrame(frame);
  }, [atlasMode, fitAtlasView]);

  const startMaxDetailExploration = useCallback(
    (bounds: WorldBounds, name: string): ExplorationPlan | null => {
      try {
        const selection = resolveExplorationSelection(
          savedExplorations,
          {
            dimension: "overworld",
            lod: MAX_DETAIL_EXPLORATION_LOD,
            bounds,
          },
          () =>
            createMaxDetailExplorationState({
              id: `region-${Date.now().toString(36)}`,
              name: name.trim() || "Región de análisis",
              bounds,
            }),
        );
        const plan: ExplorationPlan = {
          state: selection.state,
          source: selection.resumed ? "restored" : "new",
          reveal: true,
        };
        stageExplorationPlan(plan.state, plan.source);
        atlasReturnViewRef.current = null;
        notify(
          selection.resumed
            ? `${plan.state.reviewedCount.toLocaleString("es-GT")} celdas conservadas · reanudando ${plan.state.region.name}`
            : `${plan.state.region.cellCount.toLocaleString("es-GT")} celdas · calculando presupuesto regional`,
        );
        return plan;
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "La región no es válida",
        );
        return null;
      }
    },
    [notify, savedExplorations, stageExplorationPlan],
  );

  const createMaxDetailVersionOfLegacy = useCallback(() => {
    if (!explorationState || activeExplorationIsMaxDetail) return;
    try {
      const next = createMaxDetailExplorationState({
        id: `region-${Date.now().toString(36)}`,
        name: `${explorationState.region.name} · LOD 0`,
        bounds: explorationState.region.bounds,
      });
      archiveExploration(explorationState);
      stageExplorationPlan(next, "legacy");
      notify(
        `Versión LOD 0 preparada · completa la descarga regional para abrirla`,
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "No se pudo crear la versión LOD 0",
      );
    }
  }, [
    activeExplorationIsMaxDetail,
    archiveExploration,
    explorationState,
    notify,
    stageExplorationPlan,
  ]);

  const startCoverageSelection = useCallback(() => {
    if (!coverageSelection) return;
    if (coverageSelectionTooLarge) {
      notify(
        `La selección contiene ${selectedLod0CellCount.toLocaleString("es-GT")} celdas LOD 0; reduce la región`,
      );
      return;
    }
    if (!coverageRegionStatus || regionStatusLoading) {
      notify("Espera a que termine la comprobación local de la región");
      return;
    }
    const name =
      coverageSelection.cellCount === 1
        ? `Sector F${coverageSelection.minRow + 1} · C${coverageSelection.minColumn + 1}`
        : `Región ${coverageSelection.rows}×${coverageSelection.columns}`;
    const plan = startMaxDetailExploration(coverageSelection.bounds, name);
    if (!plan) return;
    if (coverageRegionStatus.ready) {
      activateDownloadedExploration(plan, coverageRegionStatus);
    } else {
      void startRegionDownload(plan);
    }
  }, [
    activateDownloadedExploration,
    coverageSelection,
    coverageSelectionTooLarge,
    coverageRegionStatus,
    notify,
    regionStatusLoading,
    selectedLod0CellCount,
    startRegionDownload,
    startMaxDetailExploration,
  ]);

  const beginMarkMode = useCallback(
    (mode: Exclude<MarkMode, null>) => {
      if (atlasMode && mode !== "coverage") closeAtlas();
      setQuickHighlightMenu(null);
      setMarkMode(mode);
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      areaStartRef.current = null;
      coverageStartRef.current = null;
      setCoveragePreview(null);
      pinStartRef.current = null;
    },
    [atlasMode, closeAtlas],
  );

  const handleContextMenu = (
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    if (!isExploring || workspaceMutationsBlocked) return;
    event.preventDefault();
    event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    const point = worldAtScreen(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    const menuWidth = 272;
    const menuHeight = 244;
    setMarkMode(null);
    pinStartRef.current = null;
    areaStartRef.current = null;
    areaPreviewRef.current = undefined;
    setAreaPreview(undefined);
    setQuickHighlightMenu({
      left: clamp(event.clientX, 12, window.innerWidth - menuWidth - 12),
      top: clamp(event.clientY, 12, window.innerHeight - menuHeight - 12),
      point,
      custom: false,
      customName: "",
    });
  };

  const saveQuickHighlight = (name: string) => {
    if (!quickHighlightMenu) return;
    const title = normalizeHighlightName(name);
    if (!title) {
      notify("Escribe un nombre de 1 a 200 caracteres");
      return;
    }
    addPin(quickHighlightMenu.point, {
      title,
      openEditor: false,
    });
    setQuickHighlightMenu(null);
  };

  const handleShellPointerMove = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (!isExploring || event.pointerType === "touch") return;
    setTopbarRevealed((current) => {
      const next = event.clientY <= (current ? 112 : 92);
      return next === current ? current : next;
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    setQuickHighlightMenu(null);
    event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const world = worldAtScreen(screenX, screenY);

    if (markMode === "pin") {
      pinStartRef.current = {
        id: event.pointerId,
        point: world,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (markMode === "coverage") {
      const cell = overviewCellAtWorld(world.x, world.z);
      if (!cell) {
        notify("Elige un sector dentro de la huella observada del Overworld");
        return;
      }
      coverageStartRef.current = cell;
      try {
        setCoveragePreview(coverageSelectionBetweenCells(cell, cell));
      } catch {
        setCoveragePreview(null);
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (markMode === "area" || markMode === "region") {
      areaStartRef.current = world;
      const preview = {
        x1: world.x,
        z1: world.z,
        x2: world.x,
        z2: world.z,
      };
      areaPreviewRef.current = preview;
      setAreaPreview(preview);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    activePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
      screenX,
      screenY,
    });
    event.currentTarget.setPointerCapture(event.pointerId);

    if (activePointersRef.current.size >= 2) {
      const [first, second] = [...activePointersRef.current.values()];
      const centerX = (first.screenX + second.screenX) / 2;
      const centerY = (first.screenY + second.screenY) / 2;
      pinchRef.current = {
        anchor: worldAtScreen(centerX, centerY),
        startDistance: Math.max(
          1,
          Math.hypot(
            second.screenX - first.screenX,
            second.screenY - first.screenY,
          ),
        ),
        startScale: scale,
      };
      pointerRef.current = null;
      return;
    }

    const hit = hitHighlight(screenX, screenY);
    const atlasCellAtPointerDown = atlasMode
      ? overviewCellAtWorld(world.x, world.z)
      : null;
    pointerRef.current = {
      id: event.pointerId,
      pointerType: event.pointerType,
      atlasCellWasFocused:
        atlasCellAtPointerDown?.index === atlasFocusedCellIndex,
      startX: event.clientX,
      startY: event.clientY,
      camera,
      moved: false,
      hitId: hit?.id ?? null,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const halfLens = MAGNIFIER_SIZE / 2;
    const visible =
      event.pointerType !== "touch" &&
      screenX >= 0 &&
      screenY >= 0 &&
      screenX <= rect.width &&
      screenY <= rect.height;
    const nextMagnifierPosition: MagnifierPosition = {
      x: screenX,
      y: screenY,
      lensX: clamp(
        screenX,
        halfLens + MAGNIFIER_EDGE_GAP,
        rect.width - halfLens - MAGNIFIER_EDGE_GAP,
      ),
      lensY: clamp(
        screenY,
        halfLens + MAGNIFIER_EDGE_GAP,
        rect.height - halfLens - MAGNIFIER_EDGE_GAP,
      ),
      visible,
    };
    lastMagnifierPositionRef.current =
      visible && isExploring ? nextMagnifierPosition : null;
    if (magnifierEnabled && isExploring) {
      scheduleMagnifierPosition(nextMagnifierPosition);
    } else if (magnifierPosition.visible) {
      hideMagnifier();
    }
    const world = worldAtScreen(screenX, screenY);
    setCursor(world);
    if (atlasMode) {
      const overviewCell = overviewCellAtWorld(world.x, world.z);
      if (
        overviewCell &&
        overviewCell.index !== atlasFocusedCellIndex
      ) {
        setAtlasFocusedCellIndex(overviewCell.index);
      }
    }

    const pinStart = pinStartRef.current;
    if (pinStart?.id === event.pointerId) {
      if (
        Math.hypot(
          event.clientX - pinStart.startX,
          event.clientY - pinStart.startY,
        ) > 6
      ) {
        pinStart.moved = true;
      }
      return;
    }

    if (
      (markMode === "area" || markMode === "region") &&
      areaStartRef.current
    ) {
      const preview = {
        x1: areaStartRef.current.x,
        z1: areaStartRef.current.z,
        x2: world.x,
        z2: world.z,
      };
      areaPreviewRef.current = preview;
      setAreaPreview(preview);
      return;
    }

    if (markMode === "coverage" && coverageStartRef.current) {
      const cell = overviewCellAtWorld(world.x, world.z);
      if (!cell) return;
      try {
        setCoveragePreview(
          coverageSelectionBetweenCells(coverageStartRef.current, cell),
        );
      } catch {
        setCoveragePreview(null);
      }
      return;
    }

    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX,
        screenY,
      });
    }

    if (pinchRef.current && activePointersRef.current.size >= 2) {
      const [first, second] = [...activePointersRef.current.values()];
      const centerX = (first.screenX + second.screenX) / 2;
      const centerY = (first.screenY + second.screenY) / 2;
      const distance = Math.max(
        1,
        Math.hypot(
          second.screenX - first.screenX,
          second.screenY - first.screenY,
        ),
      );
      const nextScale = clamp(
        pinchRef.current.startScale *
          (distance / pinchRef.current.startDistance),
        atlasMode
          ? ATLAS_MIN_SCALE
          : explorationState
            ? explorationMinimumScale
            : MIN_SCALE,
        MAX_SCALE,
      );
      setCamera(
        constrainActiveExplorationCamera(
          {
            x:
              pinchRef.current.anchor.x -
              (centerX - viewSize.width / 2) / nextScale,
            z:
              pinchRef.current.anchor.z -
              (centerY - viewSize.height / 2) / nextScale,
          },
          nextScale,
        ),
      );
      setScale(nextScale);
      return;
    }

    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    const movementThreshold = pointer.pointerType === "touch" ? 8 : 3;
    if (Math.hypot(dx, dy) > movementThreshold) pointer.moved = true;
    setCamera(
      constrainActiveExplorationCamera(
        {
          x: pointer.camera.x - dx / scale,
          z: pointer.camera.z - dy / scale,
        },
        scale,
      ),
    );
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pinStart = pinStartRef.current;
    if (pinStart?.id === event.pointerId) {
      pinStartRef.current = null;
      if (!pinStart.moved) addPin(pinStart.point);
    } else if (markMode === "coverage" && coverageStartRef.current) {
      const selection = coveragePreview;
      coverageStartRef.current = null;
      setCoveragePreview(null);
      setMarkMode(null);
      if (selection) {
        commitCoverageSelection(selection);
      } else {
        notify("La selección no contiene sectores con datos");
      }
    } else if (
      (markMode === "area" || markMode === "region") &&
      areaPreviewRef.current
    ) {
      const preview = areaPreviewRef.current;
      const completedMode = markMode;
      areaStartRef.current = null;
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      if (completedMode === "region") {
        captureRegionBounds(preview);
      } else {
        addArea(preview);
      }
    } else {
      const pointer = pointerRef.current;
      const wasPinching = pinchRef.current !== null;
      activePointersRef.current.delete(event.pointerId);
      if (activePointersRef.current.size < 2) {
        pinchRef.current = null;
      }

      if (
        !wasPinching &&
        pointer?.id === event.pointerId &&
        !pointer.moved
      ) {
        if (pointer.hitId) {
          setSelectedHighlightId(pointer.hitId);
          if (atlasMode) closeAtlas("highlights");
          else setDrawer("highlights");
        } else if (atlasMode) {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = worldAtScreen(
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
          const cell = overviewCellAtWorld(point.x, point.z);
          if (cell) {
            selectAtlasCell(cell.index);
          }
        } else if (explorationState) {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = worldAtScreen(
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
          const index = cellIndexAtWorld(
            explorationState.region,
            point.x,
            point.z,
          );
          if (index !== null) {
            const next = withVisitedIndex(explorationState, index);
            commitExplorationProgress(next);
            focusExploration(next, { mode: "preserve", scale });
          }
        } else {
          setSelectedHighlightId(null);
        }
      }
      if (pointer?.id === event.pointerId) pointerRef.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerCancel = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) pinchRef.current = null;
    if (pointerRef.current?.id === event.pointerId) pointerRef.current = null;
    if (pinStartRef.current?.id === event.pointerId) pinStartRef.current = null;
    areaStartRef.current = null;
    coverageStartRef.current = null;
    areaPreviewRef.current = undefined;
    setAreaPreview(undefined);
    setCoveragePreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setQuickHighlightMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(
      Math.exp(-event.deltaY * 0.0014),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const goToSearch = (event: FormEvent) => {
    event.preventDefault();
    const result = parseLocation(search, scopedHighlights);
    if (!result) {
      setSearchError(true);
      notify("Usa coordenadas X, Z o el nombre de un highlight");
      return;
    }
    setSearchError(false);
    if (atlasMode) {
      const cell = overviewCellAtWorld(result.x, result.z);
      if (!cell) {
        notify("La ubicación queda fuera de la huella publicada");
        return;
      }
      if (selectAtlasCell(cell.index)) {
        notify(`${cell.id} seleccionado en el mapa general`);
      }
      return;
    }
    if (explorationState) {
      const index = cellIndexAtWorld(
        explorationState.region,
        result.x,
        result.z,
      );
      if (index === null) {
        notify("Esa ubicación queda fuera de la sesión activa");
        return;
      }
      const next = withVisitedIndex(explorationState, index);
      commitExplorationProgress(next);
      focusExploration(next, {
        mode: "preserve",
        scale: result.scale ?? scale,
      });
      notify(`Celda centrada en ${Math.round(result.x)}, ${Math.round(result.z)}`);
      return;
    }
    setCamera({ x: result.x, z: result.z });
    if (result.scale) setScale(result.scale);
    notify(`Centrado en ${Math.round(result.x)}, ${Math.round(result.z)}`);
  };

  const moveExplorationCardinal = useCallback(
    (direction: CardinalDirection) => {
      if (!explorationState) return;
      const next = moveCurrentCardinal(explorationState, direction);
      if (next !== explorationState) {
        commitExplorationProgress(next);
        focusExploration(next, { mode: "preserve", scale });
      }
    },
    [commitExplorationProgress, explorationState, focusExploration, scale],
  );

  const moveAtlasFocusCardinal = useCallback(
    (direction: CardinalDirection) => {
      const current = overviewCellForIndex(atlasFocusedCellIndex);
      const nextRow = clamp(
        current.row +
          (direction === "south" ? 1 : direction === "north" ? -1 : 0),
        0,
        OVERWORLD_OVERVIEW_ROWS - 1,
      );
      const nextColumn = clamp(
        current.column +
          (direction === "east" ? 1 : direction === "west" ? -1 : 0),
        0,
        OVERWORLD_OVERVIEW_COLUMNS - 1,
      );
      selectAtlasCell(
        nextRow * OVERWORLD_OVERVIEW_COLUMNS + nextColumn,
      );
    },
    [atlasFocusedCellIndex, selectAtlasCell],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && quickHighlightMenu) {
        event.preventDefault();
        setQuickHighlightMenu(null);
        return;
      }
      const target =
        event.target instanceof HTMLElement ? event.target : null;
      const interactiveTarget = target?.closest(
        "input, textarea, select, button, a, summary, [contenteditable='true'], [role='tab']",
      );
      if (interactiveTarget) {
        if (event.key === "Escape") target?.blur();
        return;
      }
      if (
        (event.key === "l" || event.key === "L") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        isExploring
      ) {
        event.preventDefault();
        if (!event.repeat) {
          toggleMagnifier();
        }
        return;
      }
      if (workspaceMutationsBlocked) return;
      if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "0" || event.key === "Home") {
        event.preventDefault();
        viewFullCoverage();
      } else if (event.key === "h" || event.key === "H") {
        if (atlasMode) closeAtlas("highlights");
        else setDrawer("highlights");
      } else if (event.key === "e" || event.key === "E") {
        if (atlasMode) closeAtlas("exploration");
        else setDrawer("exploration");
      } else if (event.key === "m" || event.key === "M") {
        beginMarkMode("pin");
      } else if (event.key === "r" || event.key === "R") {
        beginMarkMode("area");
      } else if (event.key === "+" || event.key === "=") {
        zoomAt(1.5);
      } else if (event.key === "-") {
        zoomAt(1 / 1.5);
      } else if (event.key === "Escape") {
        setTopbarRevealed(false);
        pinStartRef.current = null;
        areaStartRef.current = null;
        coverageStartRef.current = null;
        areaPreviewRef.current = undefined;
        setMarkMode(null);
        setAreaPreview(undefined);
        setCoveragePreview(null);
        if (atlasMode) closeAtlas();
        else setDrawer(null);
      } else if (atlasMode && event.key === "Enter") {
        event.preventDefault();
        selectAtlasCell(atlasFocusedCellIndex);
      } else if (event.key.startsWith("Arrow")) {
        if (atlasMode) {
          event.preventDefault();
          const current = overviewCellForIndex(atlasFocusedCellIndex);
          const nextRow = clamp(
            current.row +
              (event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowUp"
                  ? -1
                  : 0),
            0,
            OVERWORLD_OVERVIEW_ROWS - 1,
          );
          const nextColumn = clamp(
            current.column +
              (event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0),
            0,
            OVERWORLD_OVERVIEW_COLUMNS - 1,
          );
          const nextIndex =
            nextRow * OVERWORLD_OVERVIEW_COLUMNS + nextColumn;
          if (event.shiftKey) {
            const anchor = coverageSelection
              ? overviewCellForIndex(
                  coverageSelection.minRow * OVERWORLD_OVERVIEW_COLUMNS +
                    coverageSelection.minColumn,
                )
              : current;
            const selection = coverageSelectionBetweenCells(
              anchor,
              overviewCellForIndex(nextIndex),
            );
            commitCoverageSelection(selection, nextIndex);
          } else {
            selectAtlasCell(nextIndex);
          }
          return;
        }
        if (explorationState) {
          event.preventDefault();
          moveExplorationCardinal(
            event.key === "ArrowRight"
              ? "east"
              : event.key === "ArrowLeft"
                ? "west"
                : event.key === "ArrowDown"
                  ? "south"
                  : "north",
          );
          return;
        }
        const amount = 120 / scale;
        setCamera((current) => ({
          x:
            current.x +
            (event.key === "ArrowRight"
              ? amount
              : event.key === "ArrowLeft"
                ? -amount
                : 0),
          z:
            current.z +
            (event.key === "ArrowDown"
              ? amount
              : event.key === "ArrowUp"
                ? -amount
                : 0),
        }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    atlasFocusedCellIndex,
    atlasMode,
    beginMarkMode,
    closeAtlas,
    commitCoverageSelection,
    coverageSelection,
    explorationState,
    isExploring,
    moveExplorationCardinal,
    quickHighlightMenu,
    scale,
    selectAtlasCell,
    toggleMagnifier,
    viewFullCoverage,
    workspaceMutationsBlocked,
    zoomAt,
  ]);

  const updateLayer = (
    id: TileLayer,
    patch: Partial<Pick<LayerState, "visible" | "opacity">>,
  ) => {
    setLayers((items) =>
      items.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
    );
  };

  const updateSelectedHighlight = (patch: Partial<Highlight>) => {
    if (!selectedHighlightId) return;
    invalidateXaeroPreview();
    setHighlights((items) =>
      items.map((highlight) =>
        highlight.id === selectedHighlightId
          ? { ...highlight, ...patch }
          : highlight,
      ),
    );
  };

  const deleteSelectedHighlight = () => {
    if (!selectedHighlightId) return;
    invalidateXaeroPreview();
    setHighlights((items) =>
      items.filter((highlight) => highlight.id !== selectedHighlightId),
    );
    setSelectedHighlightId(null);
    notify("Highlight eliminado");
  };

  const openArchive = async () => {
    try {
      const handle = await pickTileArchiveDirectory();
      localSourceRef.current?.dispose();
      const source = createLocalTileSource(handle);
      localSourceRef.current = source;
      setLocalSource(source);
      setArchiveName(handle.name);
      clearTileCache();
      setDrawer("exploration");
      notify("Archivo local conectado");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? error.message : "No se pudo abrir");
    }
  };

  const disconnectArchive = () => {
    localSourceRef.current?.dispose();
    localSourceRef.current = null;
    setLocalSource(null);
    setArchiveName(null);
    clearTileCache();
    notify("Archivo local desconectado");
  };

  const useCurrentViewForRegion = () => {
    const halfWidth = viewSize.width / (2 * scale);
    const halfHeight = viewSize.height / (2 * scale);
    setRegionForm((current) => ({
      ...current,
      minX: String(Math.floor(camera.x - halfWidth)),
      minZ: String(Math.floor(camera.z - halfHeight)),
      maxXExclusive: String(Math.ceil(camera.x + halfWidth)),
      maxZExclusive: String(Math.ceil(camera.z + halfHeight)),
    }));
    notify("Límites tomados de la vista actual");
  };

  const startExploration = () => {
    try {
      const bounds: WorldBounds = {
        minX: Number(regionForm.minX),
        minZ: Number(regionForm.minZ),
        maxXExclusive: Number(regionForm.maxXExclusive),
        maxZExclusive: Number(regionForm.maxZExclusive),
      };
      if (
        !Object.values(bounds).every((value) => Number.isSafeInteger(value))
      ) {
        throw new Error("Las cuatro coordenadas deben ser enteros");
      }
      startMaxDetailExploration(bounds, regionForm.name);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "La región no es válida",
      );
    }
  };

  const finishExploration = () => {
    if (!explorationState) return;
    setConfirmCloseExploration(true);
  };

  const confirmFinishExploration = async () => {
    if (!explorationState || pauseBusy) return;
    setPauseBusy(true);
    try {
      const nextExplorations = upsertWorkspaceExploration(
        [...savedExplorations],
        explorationState,
      );
      const nextContent: LocalAtlasWorkspaceContent = {
        ...workspaceContent,
        activeExplorationId: null,
        explorations: nextExplorations,
      };
      const previousContent = workspaceContentRef.current;
      const browserRecoverySaved = writeBrowserWorkspaceRecovery(
        nextContent,
        workspacePreconditionRef.current ??
          readBrowserWorkspaceRecovery()?.base ??
          null,
      );
      let savedToDisk = false;
      if (!browserRecoverySaved) {
        workspaceContentRef.current = nextContent;
        savedToDisk = await flushWorkspace();
        if (!savedToDisk) {
          workspaceContentRef.current = previousContent;
          notify(
            "No se pudo asegurar una copia; la sesión sigue activa para que puedas exportarla",
          );
          return;
        }
      }
      setSavedExplorations(nextExplorations);
      workspaceContentRef.current = nextContent;
      explorationStateRef.current = null;
      setConfirmCloseExploration(false);
      setExplorationState(null);
      if (!savedToDisk) savedToDisk = await flushWorkspace();
      notify(
        savedToDisk
          ? "Sesión pausada y guardada en LuisA"
          : "No se pudo confirmar el guardado en LuisA",
      );
    } finally {
      setPauseBusy(false);
    }
  };

  const exportExploration = () => {
    if (!explorationState) return;
    const blob = new Blob(
      [JSON.stringify(JSON.parse(serializeExplorationState(explorationState)), null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "obsidian-atlas-exploracion.json";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Sesión exportada");
  };

  const importExploration = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const next = deserializeExplorationState(await file.text());
      stageExplorationPlan(next, "imported");
      notify(
        `${next.reviewedCount.toLocaleString("es-GT")} celdas restauradas · verificando descarga regional`,
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Sesión de exploración inválida",
      );
    }
  };

  const resumeSavedExploration = (
    exploration: LocalAtlasWorkspaceExploration,
  ) => {
    try {
      const next = explorationStateFromWorkspace(exploration);
      stageExplorationPlan(next, "restored");
      notify(`Verificando los archivos locales de “${next.region.name}”`);
    } catch {
      notify("La sesión guardada ya no es compatible");
    }
  };

  const continueExplorationPlan = () => {
    if (!explorationPlan || !regionStatus || regionStatusLoading) return;
    if (regionStatus.ready) {
      activateDownloadedExploration(explorationPlan, regionStatus);
      return;
    }
    void startRegionDownload(explorationPlan);
  };

  const stopCurrentJob = async () => {
    if (!localRuntime?.job) return;
    setRuntimeBusy(true);
    try {
      await stopLocalRegionJob(localRuntime);
      setLocalRuntime(await readLocalAtlasRuntime());
      notify("Detención solicitada");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "No se pudo detener",
      );
    } finally {
      setRuntimeBusy(false);
    }
  };

  const copyCoordinates = async () => {
    try {
      await copyText(
        `${Math.round(displayedCoordinate.x)}, ${Math.round(displayedCoordinate.z)}`,
      );
      notify("Coordenadas copiadas");
    } catch {
      notify("Chrome no permitió copiar las coordenadas");
    }
  };

  const copyLink = async () => {
    const hash = locationHash(
      displayedCoordinate,
      atlasMode ? MIN_SCALE : scale,
    );
    const url = new URL(window.location.href);
    url.hash = hash;
    window.history.replaceState(null, "", hash);
    try {
      await copyText(url.toString());
      notify("Enlace copiado");
    } catch {
      notify("Chrome no permitió copiar el enlace");
    }
  };

  const exportHighlights = () => {
    const blob = new Blob([JSON.stringify(highlights, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "obsidian-atlas-highlights.json";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Copia JSON de highlights descargada");
  };

  const exportHighlightRoute = () => {
    if (!highlightRoute || !activeExplorationRegion) return;
    const payload = {
      ...createHighlightRouteExport(highlightRoute),
      exportedAt: new Date().toISOString(),
      region: {
        id: activeExplorationRegion.id,
        name: activeExplorationRegion.name,
        lod: activeExplorationRegion.lod,
        bounds: activeExplorationRegion.bounds,
      },
      segments: highlightRoute.overlay.segments,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "obsidian-atlas-ruta-highlights.json";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Ruta etiquetada descargada en JSON");
  };

  const exportHighlightRouteImage = () => {
    if (!highlightRoute || !canvasRef.current) return;
    try {
      canvasRef.current.toBlob((blob) => {
        if (!blob) {
          notify("No se pudo generar la imagen de la ruta");
          return;
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "obsidian-atlas-ruta-vista.png";
        anchor.click();
        URL.revokeObjectURL(url);
        notify("Vista actual de la ruta descargada en PNG");
      }, "image/png");
    } catch {
      notify("No se pudo exportar la vista actual de la ruta");
    }
  };

  const prepareXaeroOperation = async () => {
    if (!localRuntime) {
      setXaeroError("El runtime local todavía no está disponible");
      return;
    }
    if (xaeroScope.kind === "exploration" && !selectedXaeroRegion) {
      setXaeroError(
        "La región elegida ya no está disponible; selecciona otro alcance",
      );
      return;
    }
    const request: LocalAtlasXaeroRequest = {
      operation: xaeroOperation,
      scope: xaeroScope,
    };
    setXaeroBusy("preview");
    setXaeroError(null);
    setXaeroResult(null);
    setXaeroRemoveConfirmed(false);
    setXaeroExpanded(true);
    try {
      if (!(await flushWorkspace())) {
        throw new Error(
          "No se pudo asegurar la versión más reciente en LuisA",
        );
      }
      const preview = await readLocalAtlasXaeroPreview(request);
      setXaeroPreview(preview);
      if (preview.minecraftOpen) {
        notify(
          `Cierra Minecraft para ${
            preview.operation === "remove" ? "retirar" : "exportar"
          } los highlights`,
        );
      } else if (!preview.hasChanges) {
        notify(
          preview.operation === "remove"
            ? "No hay marcadores Atlas que retirar en este alcance"
            : "Xaero ya está sincronizado con este alcance",
        );
      } else {
        notify(
          preview.operation === "remove"
            ? "Vista previa de retirada lista"
            : "Vista previa de exportación lista",
        );
      }
    } catch (error) {
      setXaeroPreview(null);
      setXaeroError(
        error instanceof Error
          ? error.message
          : "No se pudo comprobar Xaero",
      );
    } finally {
      setXaeroBusy(null);
    }
  };

  const commitXaeroOperation = async () => {
    if (!localRuntime || !xaeroPreview) return;
    if (xaeroPreview.operation === "remove" && !xaeroRemoveConfirmed) {
      setXaeroError(
        "Confirma que deseas retirar los marcadores administrados por Atlas",
      );
      return;
    }
    const operation = xaeroPreview.operation;
    setXaeroBusy(operation);
    setXaeroError(null);
    try {
      if (!(await flushWorkspace())) {
        throw new Error(
          "No se pudo asegurar la versión más reciente en LuisA",
        );
      }
      const result = await applyLocalAtlasXaeroPreview(
        localRuntime,
        xaeroPreview,
      );
      setXaeroResult(result);
      setXaeroPreview(result);
      setXaeroRemoveConfirmed(false);
      notify(
        operation === "remove"
          ? "Marcadores Atlas retirados de Overworld y Nether"
          : "Highlights exportados a Overworld y Nether",
      );
    } catch (error) {
      setXaeroError(
        error instanceof Error
          ? error.message
          : operation === "remove"
            ? "No se pudieron retirar los marcadores Atlas"
            : "No se pudo exportar a Xaero",
      );
    } finally {
      setXaeroBusy(null);
    }
  };

  const importHighlights = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > MAX_WORKSPACE_HIGHLIGHTS
      ) {
        throw new Error("El archivo supera el límite de 10,000 highlights");
      }
      const valid = readHighlightList(parsed, { discardInvalid: false });
      if (!valid) {
        throw new Error(
          "JSON inválido: revisa áreas, coordenadas e identificadores duplicados",
        );
      }
      const importRegionBounds =
        explorationState?.region.bounds ??
        orderedSavedExplorations[0]?.state.region.bounds ??
        null;
      const scopedImport = valid.map((highlight) =>
        highlight.regionKey === undefined
          ? highlightWithRegionKey(
              highlight,
              inferLegacyHighlightRegionKey(
                highlight,
                importRegionBounds ? [importRegionBounds] : [],
              ),
            )
          : highlight,
      );
      if (
        highlights.length > 0 &&
        !window.confirm(
          `Esto reemplazará ${highlights.length} highlights locales. ¿Continuar?`,
        )
      ) {
        return;
      }
      invalidateXaeroPreview();
      setHighlights(scopedImport);
      setSelectedHighlightId(null);
      notify(`${scopedImport.length} highlights importados`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "JSON inválido");
    }
  };

  const toggleDrawer = (next: Exclude<Drawer, null>) => {
    if (next === "atlas") {
      if (atlasMode) closeAtlas();
      else viewFullCoverage();
      return;
    }
    if (atlasMode) {
      closeAtlas(next);
      return;
    }
    setDrawer((current) => (current === next ? null : next));
  };

  const drawerTitle = useMemo(
    () =>
      ({
        atlas: "Mapa general",
        layers: "Capas del mapa",
        exploration: "Exploración regional",
        highlights: "Highlights",
        help: "Guía rápida",
      })[drawer ?? "layers"],
    [drawer],
  );

  return (
    <main
      className={`atlas-shell ${drawer ? "has-drawer" : ""} ${atlasMode ? "is-atlas-mode" : ""} ${isExploring ? "is-exploring" : ""} ${topbarRevealed ? "is-topbar-revealed" : ""} ${markMode ? "is-marking" : ""} ${magnifierEnabled && isExploring ? "is-magnifier-active" : ""}`}
      aria-busy={workspaceMutationsBlocked}
      onPointerMoveCapture={handleShellPointerMove}
      onPointerLeave={() => setTopbarRevealed(false)}
    >
      <section
        className="desktop-viewport-gate"
        role="alert"
        aria-label="Atlas requiere una ventana de escritorio"
      >
        <div>
          <span className="desktop-viewport-gate-icon">
            <Maximize2 size={24} />
          </span>
          <span>
            <strong>Atlas requiere una ventana de escritorio</strong>
            <small>
              Amplía la ventana a 1024 × 640 px o más. La interfaz móvil está
              deshabilitada para mantener legibles el mapa y sus controles.
            </small>
          </span>
          <code>1024 × 640</code>
        </div>
      </section>

      {workspaceMutationsBlocked ? (
        <div
          className="workspace-hydration-shield"
          role={workspaceShieldNeedsAction ? "alert" : "status"}
        >
          <HardDrive size={19} />
          <div>
            <strong>{workspaceShieldTitle}</strong>
            <span>{workspaceShieldMessage}</span>
          </div>
        </div>
      ) : null}
      <div ref={mapRef} className="map-stage">
        <canvas
          ref={canvasRef}
          className="map-canvas"
          aria-label="Mapa interactivo del Overworld de 2b2t"
          aria-describedby={
            atlasMode
              ? "atlas-sector-announcement"
              : isExploring
                ? "map-magnifier-help"
                : undefined
          }
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={leaveMagnifier}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
          onDoubleClick={(event) => {
            setQuickHighlightMenu(null);
            const rect = event.currentTarget.getBoundingClientRect();
            zoomAt(
              1.8,
              event.clientX - rect.left,
              event.clientY - rect.top,
            );
          }}
        />
        {isExploring &&
        magnifierEnabled &&
        magnifierPosition.visible ? (
          <div
            className="map-magnifier"
            style={{
              left: magnifierPosition.lensX,
              top: magnifierPosition.lensY,
            }}
            aria-hidden="true"
          >
            <canvas
              ref={magnifierCanvasRef}
              width={MAGNIFIER_SIZE}
              height={MAGNIFIER_SIZE}
            />
            <span className="map-magnifier-scale">
              LUPA · {formatMapZoom(magnifierZoomFactor)}×
            </span>
          </div>
        ) : null}
        <div className="map-vignette" />
        <div className="center-reticle" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>

      <button
        type="button"
        className="topbar-touch-toggle glass-card"
        aria-label={
          topbarRevealed
            ? "Ocultar cabecera de exploración"
            : "Mostrar cabecera de exploración"
        }
        aria-controls="atlas-topbar"
        aria-expanded={topbarRevealed}
        onClick={() => setTopbarRevealed((visible) => !visible)}
      >
        {topbarRevealed ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>

      <header className="topbar" id="atlas-topbar">
        <div className="brand-card glass-card">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={17} />
          </div>
          <div>
            <strong>OBSIDIAN ATLAS</strong>
            <span>2b2t · exploración local</span>
          </div>
        </div>

        <form
          className={`search-card glass-card ${searchError ? "has-error" : ""}`}
          onSubmit={goToSearch}
        >
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="Ir a coordenadas o highlight"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Ir a X, Z o highlight…"
          />
          <kbd>G</kbd>
          <button type="submit" aria-label="Ir a la ubicación">
            <LocateFixed size={17} />
          </button>
        </form>

        <section className="coordinate-card glass-card">
          <div className="coordinate-main">
            <span>
              X <strong>{formatCoordinate(displayedCoordinate.x)}</strong>
            </span>
            <span>
              Z <strong>{formatCoordinate(displayedCoordinate.z)}</strong>
            </span>
          </div>
          <div className="coordinate-meta">
            <span>
              {atlasMode ? "Vista general" : `Zoom ${formatMapZoom(scale)}×`}
            </span>
            <i />
            <span>{atlasMode ? atlasFocusedCell.id : `LOD ${lod}`}</span>
            <i />
            <span>
              {atlasMode
                ? "sector 32,768 × 32,768"
                : `${explorationState ? "fuente " : ""}${blocksPerPixel} bloque${blocksPerPixel === 1 ? "" : "s"}/px`}
            </span>
          </div>
          <div className="coordinate-actions">
            <button
              type="button"
              title="Copiar coordenadas"
              aria-label="Copiar coordenadas"
              onClick={copyCoordinates}
            >
              <Copy size={15} />
            </button>
            <button
              type="button"
              title="Copiar enlace"
              aria-label="Copiar enlace"
              onClick={copyLink}
            >
              <Link2 size={15} />
            </button>
          </div>
        </section>
      </header>

      {quickHighlightMenu && isExploring && !workspaceMutationsBlocked ? (
        <div
          className="highlight-quick-menu glass-card"
          role="menu"
          aria-label="Agregar highlight rápido"
          style={{
            left: quickHighlightMenu.left,
            top: quickHighlightMenu.top,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="highlight-quick-heading">
            <span className="highlight-quick-icon">
              <MapPin size={17} />
            </span>
            <span>
              <strong>Agregar highlight</strong>
              <small>
                X {formatCoordinate(quickHighlightMenu.point.x)} · Z{" "}
                {formatCoordinate(quickHighlightMenu.point.z)}
              </small>
            </span>
            <button
              type="button"
              className="highlight-quick-close"
              aria-label="Cerrar menú rápido"
              onClick={() => setQuickHighlightMenu(null)}
            >
              <X size={15} />
            </button>
          </div>
          {quickHighlightMenu.custom ? (
            <form
              className="highlight-quick-custom"
              onSubmit={(event) => {
                event.preventDefault();
                saveQuickHighlight(quickHighlightMenu.customName);
              }}
            >
              <label htmlFor="quick-highlight-name">Nombre personalizado</label>
              <input
                id="quick-highlight-name"
                autoFocus
                maxLength={200}
                value={quickHighlightMenu.customName}
                placeholder="Escribe el nombre…"
                onChange={(event) =>
                  setQuickHighlightMenu((current) =>
                    current
                      ? { ...current, customName: event.target.value }
                      : current,
                  )
                }
              />
              <div>
                <button
                  type="button"
                  onClick={() =>
                    setQuickHighlightMenu((current) =>
                      current
                        ? { ...current, custom: false, customName: "" }
                        : current,
                    )
                  }
                >
                  Volver
                </button>
                <button
                  type="submit"
                  className="is-primary"
                  disabled={
                    normalizeHighlightName(quickHighlightMenu.customName) ===
                    null
                  }
                >
                  <Plus size={14} />
                  Guardar
                </button>
              </div>
            </form>
          ) : (
            <div className="highlight-quick-options">
              {quickHighlightPresetNames.map(({ preset, title }, index) => (
                <button
                  key={preset}
                  type="button"
                  role="menuitem"
                  autoFocus={index === 0}
                  onClick={() => saveQuickHighlight(title)}
                >
                  <MapPin size={15} />
                  {title}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className="is-custom"
                onClick={() =>
                  setQuickHighlightMenu((current) =>
                    current ? { ...current, custom: true } : current,
                  )
                }
              >
                <Plus size={15} />
                Otro nombre…
              </button>
            </div>
          )}
          <p>Solo se guardará en {explorationState?.region.name}.</p>
        </div>
      ) : null}

      <nav className="left-dock glass-card" aria-label="Herramientas del mapa">
        <DockButton
          active={atlasMode}
          label="Atlas"
          onClick={() => toggleDrawer("atlas")}
        >
          <MapIcon />
        </DockButton>
        <DockButton
          active={drawer === "layers"}
          label="Capas"
          onClick={() => toggleDrawer("layers")}
        >
          <Layers3 />
        </DockButton>
        <DockButton
          active={drawer === "exploration"}
          label="Explorar"
          badge={explorationState ? Math.round(explorationPercent) : undefined}
          onClick={() => toggleDrawer("exploration")}
        >
          <ScanSearch />
        </DockButton>
        <DockButton
          active={drawer === "highlights"}
          label="Highlights"
          badge={scopedHighlights.length || undefined}
          onClick={() => toggleDrawer("highlights")}
        >
          <MapPin />
        </DockButton>
        <DockButton
          active={drawer === "help"}
          label="Ayuda"
          onClick={() => toggleDrawer("help")}
        >
          <HelpCircle />
        </DockButton>
      </nav>

      {drawer && (
        <aside
          className={`side-drawer glass-card ${atlasMode ? "atlas-drawer" : ""}`}
          aria-label={drawerTitle}
        >
          <div className="drawer-heading">
            <div>
              <span className="eyebrow">OVERWORLD / {drawer.toUpperCase()}</span>
              <h2>{drawerTitle}</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Cerrar panel"
              onClick={() => {
                if (atlasMode) closeAtlas();
                else setDrawer(null);
              }}
            >
              <X size={18} />
            </button>
          </div>

          {(drawer === "atlas" || drawer === "exploration") && (
            <div className="atlas-flow" aria-label="Flujo de exploración">
              <span
                data-state={
                  atlasMode
                    ? "current"
                    : explorationPlan || explorationState
                      ? "complete"
                      : "current"
                }
              >
                <i>1</i>
                Seleccionar
              </span>
              <span
                data-state={
                  explorationPlan
                    ? "current"
                    : explorationState
                      ? "complete"
                      : "pending"
                }
              >
                <i>2</i>
                Predescargar
              </span>
              <span data-state={explorationState ? "current" : "pending"}>
                <i>3</i>
                Explorar
              </span>
            </div>
          )}

          {drawer === "atlas" && (
            <div className="drawer-content atlas-overview-panel">
              <section className="atlas-overview-hero">
                <div className="atlas-overview-hero-heading">
                  <span className="atlas-overview-icon">
                    <Maximize2 size={19} />
                  </span>
                  <div>
                    <span>VISTA COMPLETA · OVERWORLD</span>
                    <strong>1,089 sectores en una sola vista</strong>
                  </div>
                  <span className="coverage-overview-status">33 × 33</span>
                </div>
                <p>
                  Esta vista es solo para orientarte. Elige una región y sus
                  tres capas se guardarán en LuisA antes de explorarla.
                </p>
                {explorationState ? (
                  <button
                    type="button"
                    className="atlas-active-session"
                    onClick={() => closeAtlas()}
                  >
                    <span className="atlas-active-session-dot" />
                    <span>
                      <small>SESIÓN ACTIVA</small>
                      <strong>{explorationState.region.name}</strong>
                    </span>
                    <span>{formatProgressPercent(explorationPercent)}%</span>
                  </button>
                ) : null}
              </section>

              {coverageSelection && !explorationPlan ? (
                <section className="atlas-selection-summary">
                  <div>
                    <span>SELECCIÓN LISTA</span>
                    <strong>
                      {coverageSelection.rows} × {coverageSelection.columns} ·{" "}
                      {selectedRegionFileBudget.toLocaleString("es-GT")}{" "}
                      archivos
                    </strong>
                  </div>
                  <button
                    type="button"
                    disabled={
                      coverageSelectionTooLarge ||
                      regionStatusLoading ||
                      !coverageRegionStatus ||
                      coverageRegionBlockedByOther ||
                      coverageRegionDownloadRunning
                    }
                    title={
                      coverageSelectionTooLarge
                        ? "Reduce la región para mantener una descarga segura"
                        : coverageRegionStatus?.ready
                          ? "Abrir la región ya guardada"
                          : "Guardar esta región en LuisA"
                    }
                    onClick={startCoverageSelection}
                  >
                    {coverageRegionStatus?.ready ? (
                      <ScanSearch size={15} />
                    ) : (
                      <Download size={15} />
                    )}
                    {coverageRegionDownloadRunning
                      ? "Guardando región…"
                      : coverageRegionStatus?.ready
                        ? "Explorar región"
                        : (coverageRegionStatus?.resolvedCount ?? 0) > 0
                          ? "Reanudar guardado"
                          : "Guardar región"}
                  </button>
                  {coverageSelectionTooLarge ? (
                    <small className="atlas-selection-warning">
                      El máximo seguro es{" "}
                      {MAX_EXPLORATION_CELLS.toLocaleString("es-GT")} celdas.
                      Reduce la selección.
                    </small>
                  ) : explorationState ? (
                    <small>La sesión actual se guardará automáticamente.</small>
                  ) : regionStatusDisplayError ? (
                    <small className="atlas-selection-warning">
                      {regionStatusDisplayError}
                    </small>
                  ) : coverageRegionStatus ? (
                    <small>
                      {coverageRegionStatus.resolvedCount.toLocaleString(
                        "es-GT",
                      )}{" "}
                      /{" "}
                      {coverageRegionStatus.totalCount.toLocaleString("es-GT")}{" "}
                      archivos resueltos · 3 capas
                    </small>
                  ) : (
                    <small>Comprobando archivos locales…</small>
                  )}
                </section>
              ) : null}

              <section className="atlas-progress-card atlas-availability-card">
                <div className="atlas-progress-heading">
                  <div>
                    <span>DISPONIBILIDAD REGIONAL · LOD 0</span>
                    <strong>El mapa general no descarga archivos</strong>
                  </div>
                  <span className="atlas-navigation-badge">NAVEGACIÓN</span>
                </div>
                <p className="atlas-availability-copy">
                  Los colores indican qué sectores ya tienen datos locales.
                  Nada se descarga hasta que tú eliges una región.
                </p>
                {localCoverageState === "loading" ? (
                  <p className="atlas-progress-loading" role="status">
                    Leyendo la biblioteca local…
                  </p>
                ) : localCoverageState === "error" ? (
                  <p className="atlas-progress-error" role="alert">
                    La cobertura local no está disponible. Tus sesiones y
                    selecciones siguen intactas.
                  </p>
                ) : (
                  <div className="atlas-status-grid">
                    {(
                      [
                        [
                          "complete",
                          "En LuisA",
                          atlasProgress?.completeSectorCount ?? 0,
                        ],
                        [
                          "in-progress",
                          "Parciales",
                          atlasProgress?.inProgressSectorCount ?? 0,
                        ],
                        [
                          "pending",
                          "Sin descarga",
                          atlasProgress?.pendingSectorCount ?? 0,
                        ],
                      ] as const
                    ).map(([status, label, value]) => (
                      <button
                        type="button"
                        data-status={status}
                        aria-pressed={atlasStatusFilter === status}
                        className={
                          atlasStatusFilter === status ? "active" : ""
                        }
                        key={status}
                        onClick={() =>
                          setAtlasStatusFilter((current) =>
                            current === status ? "all" : status,
                          )
                        }
                      >
                        <span>{label}</span>
                        <strong>{value.toLocaleString("es-GT")}</strong>
                      </button>
                    ))}
                  </div>
                )}
                {localCoverageState === "stale" ? (
                  <p className="atlas-progress-stale" role="status">
                    Mostrando la última lectura válida; se reintentará
                    automáticamente.
                  </p>
                ) : null}
                {(atlasProgress?.failedCount ?? 0) > 0 ? (
                  <p className="atlas-sector-warning" role="alert">
                    <AlertTriangle size={14} />
                    {atlasProgress?.failedCount.toLocaleString("es-GT")} tiles
                    requieren atención
                  </p>
                ) : null}
                {(atlasProgress?.excludedCount ?? 0) > 0 ? (
                  <p className="atlas-sector-note">
                    {atlasProgress?.excludedCount.toLocaleString("es-GT")} tiles
                    sin imagen confirmada, excluidos del objetivo
                  </p>
                ) : null}
                {atlasStatusFilter !== "all" ? (
                  <button
                    type="button"
                    className="atlas-clear-filter"
                    onClick={() => setAtlasStatusFilter("all")}
                  >
                    <X size={13} />
                    Mostrar todos los sectores
                  </button>
                ) : null}
                {atlasNextPending ? (
                  <button
                    type="button"
                    className="atlas-next-pending"
                    onClick={() => {
                      setAtlasStatusFilter("all");
                      selectAtlasCell(atlasNextPending.index);
                    }}
                  >
                    <Navigation size={15} />
                    Elegir siguiente zona sin descarga
                  </button>
                ) : null}
              </section>

              <section
                className="atlas-sector-inspector"
                id="atlas-sector-announcement"
              >
                <div
                  className="atlas-sector-heading"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <Crosshair size={18} />
                  <div>
                    <span>SECTOR EN FOCO</span>
                    <strong>{atlasFocusedCell.id}</strong>
                  </div>
                  {atlasFocusedProgress ? (
                    <span
                      className="atlas-sector-state"
                      data-status={atlasFocusedProgress.status}
                    >
                      {atlasFocusedProgress.status === "complete"
                        ? "Completo"
                        : atlasFocusedProgress.status === "in-progress"
                          ? "Parcial"
                          : "Sin descarga"}
                    </span>
                  ) : (
                    <span
                      className="atlas-sector-state"
                      data-status="pending"
                    >
                      Midiendo
                    </span>
                  )}
                </div>
                <div className="atlas-sector-metrics">
                  <span>
                    Guardados
                    <strong>
                      {atlasFocusedProgress?.completeCount.toLocaleString(
                        "es-GT",
                      ) ?? "—"}
                    </strong>
                  </span>
                  <span>
                    Objetivo
                    <strong>
                      {atlasFocusedProgress?.expectedCount.toLocaleString(
                        "es-GT",
                      ) ?? "—"}
                    </strong>
                  </span>
                  <span>
                    Disponible
                    <strong>
                      {atlasFocusedProgress
                        ? `${formatProgressPercent(
                            atlasFocusedProgress.percent,
                          )}%`
                        : "—"}
                    </strong>
                  </span>
                </div>
                {(atlasFocusedProgress?.queuedCount ?? 0) > 0 ? (
                  <p className="atlas-sector-note">
                    {atlasFocusedProgress?.queuedCount.toLocaleString(
                      "es-GT",
                    )}{" "}
                    archivos parciales detectados en este sector
                  </p>
                ) : null}
                {(atlasFocusedLocalCell?.failedCount ?? 0) > 0 ? (
                  <p className="atlas-sector-warning">
                    <AlertTriangle size={14} />
                    {atlasFocusedLocalCell?.failedCount.toLocaleString("es-GT")}{" "}
                    tiles requieren atención
                  </p>
                ) : null}
                {(atlasFocusedProgress?.excludedCount ?? 0) > 0 ? (
                  <p className="atlas-sector-note">
                    {atlasFocusedProgress?.excludedCount.toLocaleString(
                      "es-GT",
                    )}{" "}
                    ausencias 404 excluidas del objetivo
                  </p>
                ) : null}
                <code>
                  X [{formatCoordinate(atlasFocusedCell.bounds.minX)},{" "}
                  {formatCoordinate(
                    atlasFocusedCell.bounds.maxXExclusive,
                  )}
                  )<br />
                  Z [{formatCoordinate(atlasFocusedCell.bounds.minZ)},{" "}
                  {formatCoordinate(
                    atlasFocusedCell.bounds.maxZExclusive,
                  )}
                  )
                </code>
                <div
                  className="direction-pad atlas-focus-pad"
                  aria-label="Ajustar sector en foco"
                >
                  <button
                    type="button"
                    className="north"
                    aria-label="Sector superior"
                    disabled={atlasFocusedCell.row === 0}
                    onClick={() => moveAtlasFocusCardinal("north")}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    type="button"
                    className="west"
                    aria-label="Sector izquierdo"
                    disabled={atlasFocusedCell.column === 0}
                    onClick={() => moveAtlasFocusCardinal("west")}
                  >
                    <ArrowLeft />
                  </button>
                  <span className="center-label" aria-hidden="true">
                    F{atlasFocusedCell.row + 1} C
                    {atlasFocusedCell.column + 1}
                  </span>
                  <button
                    type="button"
                    className="east"
                    aria-label="Sector derecho"
                    disabled={
                      atlasFocusedCell.column ===
                      OVERWORLD_OVERVIEW_COLUMNS - 1
                    }
                    onClick={() => moveAtlasFocusCardinal("east")}
                  >
                    <ArrowRight />
                  </button>
                  <button
                    type="button"
                    className="south"
                    aria-label="Sector inferior"
                    disabled={
                      atlasFocusedCell.row === OVERWORLD_OVERVIEW_ROWS - 1
                    }
                    onClick={() => moveAtlasFocusCardinal("south")}
                  >
                    <ArrowDown />
                  </button>
                </div>
                <div className="atlas-sector-actions">
                  <button
                    type="button"
                    onClick={() =>
                      selectAtlasCell(
                        (atlasFocusedCellIndex - 1 +
                          OVERWORLD_OVERVIEW_CELL_COUNT) %
                          OVERWORLD_OVERVIEW_CELL_COUNT,
                      )
                    }
                  >
                    <ChevronLeft size={15} />
                    Anterior
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      selectAtlasCell(
                        (atlasFocusedCellIndex + 1) %
                          OVERWORLD_OVERVIEW_CELL_COUNT,
                      )
                    }
                  >
                    Siguiente
                    <ArrowRight size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAtlasCell(atlasFocusedCellIndex)}
                  >
                    <SquareMousePointer size={15} />
                    Elegir sector
                  </button>
                  <button
                    type="button"
                    className={markMode === "coverage" ? "active" : ""}
                    aria-pressed={markMode === "coverage"}
                    onClick={() => {
                      if (markMode === "coverage") {
                        coverageStartRef.current = null;
                        setCoveragePreview(null);
                        setMarkMode(null);
                      } else {
                        beginMarkMode("coverage");
                      }
                    }}
                  >
                    <MousePointer2 size={15} />
                    {markMode === "coverage"
                      ? "Cancelar selección"
                      : "Seleccionar varios"}
                  </button>
                </div>
              </section>

              <div className="atlas-keyboard-hint">
                <kbd>←↑↓→</kbd>
                <span>Mover foco</span>
                <kbd>Enter</kbd>
                <span>Elegir</span>
                <kbd>0</kbd>
                <span>Atlas</span>
              </div>
            </div>
          )}

          {drawer === "layers" && (
            <div className="drawer-content">
              <div className="section-copy">
                <p>Combina las capas en tiempo real.</p>
                <span>Arriba se dibuja sobre las capas anteriores.</span>
              </div>
              <div className="layer-list">
                {layers.map((layer) => (
                  <article
                    className={`layer-row ${layer.visible ? "is-visible" : ""}`}
                    key={layer.id}
                  >
                    <button
                      type="button"
                      className="layer-toggle"
                      aria-pressed={layer.visible}
                      onClick={() =>
                        updateLayer(layer.id, { visible: !layer.visible })
                      }
                    >
                      <span
                        className="layer-swatch"
                        style={{ backgroundColor: layer.swatch }}
                      />
                      <span>
                        <strong>{layer.label}</strong>
                        <small>{layer.detail}</small>
                      </span>
                      {layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}
                    </button>
                    <label className="opacity-control">
                      <span>Opacidad</span>
                      <output>{Math.round(layer.opacity * 100)}%</output>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={layer.opacity}
                        onChange={(event) =>
                          updateLayer(layer.id, {
                            opacity: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>
              <button
                className="setting-row"
                type="button"
                aria-pressed={showGrid}
                onClick={() => setShowGrid((visible) => !visible)}
              >
                <Grid3X3 size={18} />
                <span>
                  <strong>Cuadrícula adaptativa</strong>
                  <small>Cada {gridStep.toLocaleString()} bloques</small>
                </span>
                <span className={`switch ${showGrid ? "on" : ""}`} />
              </button>
            </div>
          )}

          {drawer === "exploration" && (
            <div className="drawer-content exploration-panel">
              {!explorationPlan && !explorationState ? (
                <section className="atlas-launch-card">
                <div className="atlas-launch-heading">
                  <MapIcon size={19} />
                  <div>
                    <span>MAPA GENERAL · OVERWORLD</span>
                    <strong>Tú decides qué región guardar</strong>
                  </div>
                  <span className="coverage-overview-status">33 × 33</span>
                </div>
                <p>
                  Úsalo para navegar y elegir una zona. Solo esa región se
                  predescarga en LuisA y queda disponible en futuras
                  ejecuciones.
                </p>
                {localCoverageError ? (
                  <p className="atlas-launch-loading" role="alert">
                    No se pudo leer la disponibilidad local. Puedes seguir
                    navegando y se reintentará automáticamente.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="atlas-launch-button"
                  onClick={viewFullCoverage}
                >
                  <Maximize2 size={16} />
                  Abrir mapa completo
                </button>
                </section>
              ) : null}

              {!explorationPlan && !explorationState ? (
                <section
                  className={`coverage-selection-card ${
                    coverageSelection ? "" : "is-empty"
                  }`}
                  data-active={coverageSelection ? "true" : "false"}
                >
                <div className="coverage-selection-heading">
                  <SquareMousePointer size={18} />
                  <div>
                    <span>REGIÓN SELECCIONADA</span>
                    <strong>
                      {coverageSelection
                        ? `${coverageSelection.rows} ${
                            coverageSelection.rows === 1 ? "fila" : "filas"
                          } × ${coverageSelection.columns} ${
                            coverageSelection.columns === 1
                              ? "columna"
                              : "columnas"
                          }`
                        : "Todavía no has elegido una región"}
                    </strong>
                  </div>
                  {coverageSelection ? (
                    <span className="coverage-selection-status">
                      {selectedLod0CellCount.toLocaleString("es-GT")} celdas L0
                    </span>
                  ) : null}
                </div>
                {coverageSelection ? (
                  <>
                    <div className="coverage-selection-summary">
                      <span>
                        Celdas L0
                        <strong>
                          {selectedLod0CellCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                      <span>
                        Capas
                        <strong>{REGIONAL_DOWNLOAD_LAYERS.length}</strong>
                      </span>
                      <span>
                        Archivos
                        <strong>
                          {selectedRegionFileBudget.toLocaleString("es-GT")}
                        </strong>
                      </span>
                    </div>
                    <span className="coverage-selection-bounds">
                      X {formatCoordinate(coverageSelection.bounds.minX)} →{" "}
                      {formatCoordinate(
                        coverageSelection.bounds.maxXExclusive,
                      )}
                      <br />
                      Z {formatCoordinate(coverageSelection.bounds.minZ)} →{" "}
                      {formatCoordinate(
                        coverageSelection.bounds.maxZExclusive,
                      )}
                    </span>
                    <div className="coverage-full-map-actions">
                      <button
                        type="button"
                        data-primary="true"
                        disabled={
                          coverageSelectionTooLarge ||
                          regionStatusLoading ||
                          !coverageRegionStatus ||
                          coverageRegionBlockedByOther ||
                          coverageRegionDownloadRunning
                        }
                        title={
                          coverageSelectionTooLarge
                            ? "Reduce la selección para descargarla en LOD 0"
                            : coverageRegionStatus?.ready
                              ? "Abrir la región ya guardada"
                              : "Guardar esta región en LuisA"
                        }
                        onClick={startCoverageSelection}
                      >
                        {coverageRegionStatus?.ready ? (
                          <ScanSearch size={15} />
                        ) : (
                          <Download size={15} />
                        )}
                        {coverageRegionDownloadRunning
                          ? "Guardando región…"
                          : coverageRegionStatus?.ready
                            ? "Explorar región"
                            : (coverageRegionStatus?.resolvedCount ?? 0) > 0
                              ? "Reanudar guardado"
                              : "Guardar región en LuisA"}
                      </button>
                    </div>
                    {coverageSelectionTooLarge ? (
                      <p className="coverage-selection-warning" role="alert">
                        La región supera el máximo seguro de{" "}
                        {MAX_EXPLORATION_CELLS.toLocaleString("es-GT")} celdas.
                        Selecciona menos sectores.
                      </p>
                    ) : regionStatusLoading && !coverageRegionStatus ? (
                      <p className="coverage-selection-hint" role="status">
                        Comprobando los archivos locales de esta región…
                      </p>
                    ) : coverageRegionBlockedByOther ? (
                      <p className="coverage-selection-warning" role="status">
                        Hay otra región descargándose. Puedes volver cuando
                        termine o detenerla desde su gate.
                      </p>
                    ) : !localRuntime?.capacity.configured ? (
                      <p className="coverage-selection-warning" role="alert">
                        La biblioteca APFS de LuisA no está disponible.
                      </p>
                    ) : !coverageRegionStatus && regionStatusDisplayError ? (
                      <p className="coverage-selection-warning" role="alert">
                        {regionStatusDisplayError}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="coverage-selection-hint">
                      Elige un sector con un clic o arrastra varios sectores en
                      el Atlas.
                    </p>
                    <button
                      type="button"
                      className="coverage-empty-action"
                      onClick={viewFullCoverage}
                    >
                      <MapIcon size={16} />
                      Elegir región en el Atlas
                    </button>
                  </>
                )}
                </section>
              ) : null}

              {!explorationPlan && !explorationState ? (
                <details className="saved-session-picker">
                  <summary className="saved-session-picker-heading">
                    <HardDrive size={18} />
                    <div>
                      <span>SESIÓN ACTUAL · LUISA</span>
                      <strong>
                        {orderedSavedExplorations[0]?.state.region.name ??
                          "Sin sesión guardada"}
                      </strong>
                    </div>
                    <span
                      className="persistence-badge"
                      data-state={persistenceState}
                      title={persistenceMessage}
                    >
                      <strong>{persistenceLabel}</strong>
                    </span>
                  </summary>
                  <p className="saved-session-persistence-copy">
                    {persistenceMessage}
                    {" · "}
                    LuisA conserva esta única sesión entre ejecuciones.
                  </p>
                <div className="saved-session-actions">
                  <button
                    type="button"
                    className="compact-button is-primary"
                    disabled={
                      persistenceState === "saving" ||
                      !localRuntime?.persistence.configured ||
                      !localRuntime.persistence.writable
                    }
                    onClick={() => void flushWorkspace()}
                  >
                    <HardDrive size={14} />
                    Sincronizar ahora
                  </button>
                </div>
                {orderedSavedExplorations.length > 0 ? (
                  <div className="saved-session-list">
                    {orderedSavedExplorations.map((exploration) => {
                      const savedState =
                        explorationStateFromWorkspace(exploration);
                      const savedReviewableCount =
                        savedState.region.cellCount -
                        exploration.state.skippedCount;
                      const sessionPercent =
                        savedReviewableCount === 0
                          ? 100
                          : (exploration.state.reviewedCount /
                              savedReviewableCount) *
                            100;
                      return (
                        <article
                          className="saved-session-item"
                          key={exploration.id}
                        >
                          <div className="saved-session-item-main">
                            <strong>{exploration.state.region.name}</strong>
                            <small>
                              LOD {exploration.state.region.lod} ·{" "}
                              {exploration.state.reviewedCount.toLocaleString(
                                "es-GT",
                              )}{" / "}
                              {savedReviewableCount.toLocaleString(
                                "es-GT",
                              )}
                              {exploration.state.skippedCount > 0
                                ? ` · ${exploration.state.skippedCount.toLocaleString("es-GT")} sin datos`
                                : ""}
                            </small>
                            <span className="saved-session-mini-track">
                              <i style={{ width: `${sessionPercent}%` }} />
                            </span>
                          </div>
                          <span
                            className="saved-session-item-progress"
                            data-status={
                              sessionPercent >= 100
                                ? "complete"
                                : sessionPercent > 0
                                  ? "in-progress"
                                  : "pending"
                            }
                          >
                            {formatProgressPercent(sessionPercent)}%
                          </span>
                          <div className="saved-session-item-actions">
                            <button
                              type="button"
                              onClick={() =>
                                resumeSavedExploration(exploration)
                              }
                            >
                              Continuar
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="saved-session-empty">
                    La región que elijas se convertirá en tu sesión actual y
                    permanecerá en LuisA.
                  </p>
                )}
                </details>
              ) : null}

              {!explorationPlan && !explorationState ? (
                <details className="exploration-storage-details">
                  <summary>
                    <HardDrive size={17} />
                    <span>
                      <strong>Disco LuisA</strong>
                      <small>
                        {localRuntime?.capacity.configured
                          ? `${formatBytes(localRuntime.capacity.freeBytes)} libres · solo regiones elegidas`
                          : runtimeChecked
                            ? "Biblioteca local no disponible"
                            : "Comprobando almacenamiento…"}
                      </small>
                    </span>
                  </summary>
                  <section
                    className={`capacity-card ${
                      localRuntime?.capacity.configured ? "fits" : ""
                    }`}
                  >
                    <div className="capacity-heading">
                      <HardDrive size={20} />
                      <div>
                        <span>ALMACENAMIENTO REGIONAL · LUISA</span>
                        <strong>
                          {localRuntime?.capacity.configured
                            ? "Destino listo para las regiones que elijas"
                            : runtimeChecked
                              ? "LuisA no está disponible"
                              : "Comprobando disco…"}
                        </strong>
                      </div>
                      {localRuntime?.capacity.configured && <CheckCircle2 />}
                    </div>
                    {localRuntime ? (
                      <div className="capacity-metrics">
                        <span>
                          Libres en LuisA
                          <strong>
                            {formatBytes(localRuntime.capacity.freeBytes)}
                          </strong>
                        </span>
                        <span>
                          Regiones en disco
                          <strong>
                            {formatBytes(localRuntime.capacity.archiveBytes)}
                          </strong>
                        </span>
                      </div>
                    ) : null}
                    <p>
                      Cada selección verifica y guarda únicamente sus propios
                      archivos. La vista general se conserva como navegación.
                    </p>
                  </section>
                </details>
              ) : null}

              {!explorationState ? (
                <>
                  {explorationPlan ? (
                    <section
                      className="region-download-gate"
                      data-state={
                        regionStatus?.ready
                          ? "ready"
                          : matchingRegionDownloadRunning
                            ? "running"
                            : regionStatusDisplayError ||
                                matchingRegionDownloadError
                              ? "error"
                              : "pending"
                      }
                    >
                      <div className="region-download-gate-heading">
                        <span className="region-download-gate-icon">
                          {regionStatus?.ready ? (
                            <CheckCircle2 size={20} />
                          ) : (
                            <Download size={20} />
                          )}
                        </span>
                        <div>
                          <span>REGIÓN ELEGIDA · GUARDADO LOCAL</span>
                          <h3>{explorationPlan.state.region.name}</h3>
                        </div>
                        <strong>
                          {regionStatus || activeDownloadProgress
                            ? `${formatProgressPercent(displayedRegionPercent)}%`
                            : "—"}
                        </strong>
                      </div>
                      <p>
                        {regionStatusLoading && !regionStatus
                          ? "Comprobando cada archivo de la región…"
                          : regionStatusDisplayError
                            ? regionStatusDisplayError
                            : matchingRegionDownloadError
                              ? `${matchingRegionDownloadError}. Puedes reanudar sin perder lo ya guardado.`
                            : matchingRegionDownloadRunning
                              ? localRuntime?.job?.message ??
                                "Guardando esta región en LuisA…"
                              : regionStatus?.ready
                                ? "La región está completa en LuisA y ya puede explorarse."
                                : "Guarda las tres capas de esta zona para explorarla; el resultado persistirá entre ejecuciones."}
                      </p>
                      <div
                        className="region-download-progress"
                        role="progressbar"
                        aria-label="Progreso de la región elegida"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={displayedRegionPercent}
                      >
                        <span
                          style={{ width: `${displayedRegionPercent}%` }}
                        />
                      </div>
                      {matchingRegionDownloadRunning ? (
                        <div className="region-download-metrics">
                          <span>
                            En disco
                            <strong>
                              {displayedRegionResolved !== undefined &&
                              displayedRegionTotal !== undefined
                                ? `${displayedRegionResolved.toLocaleString(
                                    "es-GT",
                                  )}/${displayedRegionTotal.toLocaleString(
                                    "es-GT",
                                  )}`
                                : "—"}
                            </strong>
                          </span>
                          <span>
                            Velocidad
                            <strong>
                              {activeDownloadProgress?.networkTilesPerSecond ===
                              undefined
                                ? "—"
                                : `${activeDownloadProgress.networkTilesPerSecond.toFixed(2)} tiles/s`}
                            </strong>
                          </span>
                          <span>
                            Tiempo restante
                            <strong>
                              {formatEta(activeDownloadProgress?.etaSeconds)}
                            </strong>
                          </span>
                        </div>
                      ) : null}
                      {matchingRegionDownloadRunning ? (
                        <button
                          type="button"
                          className="stop-job-button region-download-primary-action"
                          disabled={runtimeBusy}
                          onClick={stopCurrentJob}
                        >
                          <X size={16} />
                          Detener descarga
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button region-download-primary region-download-primary-action"
                          disabled={
                            runtimeBusy ||
                            regionStatusLoading ||
                            !regionStatus ||
                            anotherRegionDownloadRunning ||
                            !localRuntime?.capacity.configured
                          }
                          onClick={continueExplorationPlan}
                        >
                          {regionStatus?.ready ? (
                            <Navigation size={17} />
                          ) : (
                            <Download size={17} />
                          )}
                          {anotherRegionDownloadRunning
                            ? "Otra región en descarga"
                            : regionStatus?.ready
                              ? "Explorar región"
                              : (regionStatus?.resolvedCount ?? 0) > 0
                                ? "Reanudar guardado"
                                : "Guardar región en LuisA"}
                        </button>
                      )}
                      {!regionStatus?.ready ? (
                        <div
                          className="region-download-rate-fixed"
                          aria-label="Velocidad objetivo: hasta 16 solicitudes por segundo, con ajuste adaptativo"
                        >
                          <Sparkles size={16} />
                          <span>
                            <small>VELOCIDAD OBJETIVO</small>
                            <strong>
                              Máximo · {REGIONAL_REQUESTS_PER_SECOND} req/s
                            </strong>
                          </span>
                          <span>ADAPTATIVA</span>
                        </div>
                      ) : null}
                      {downloadCooldownSeconds > 0 ? (
                        <p className="region-download-warning" role="status">
                          <AlertTriangle size={14} />
                          Pausa indicada por el servidor ·{" "}
                          {formatEta(downloadCooldownSeconds)}
                        </p>
                      ) : null}
                      {(regionStatus?.failedCount ?? 0) > 0 ? (
                        <p className="region-download-warning" role="alert">
                          <AlertTriangle size={14} />
                          {regionStatus?.failedCount.toLocaleString("es-GT")}{" "}
                          archivos fallaron; reanuda para volver a intentarlos.
                        </p>
                      ) : null}
                      <details className="region-download-details">
                        <summary>
                          <span>
                            <strong>Detalles de esta región</strong>
                            <small>
                              Presupuesto, persistencia y métricas de red
                            </small>
                          </span>
                        </summary>
                        <div className="region-download-details-content">
                          <div className="region-download-budget">
                            <span className="region-download-budget-title">
                              PRESUPUESTO DE ESTA REGIÓN
                            </span>
                            <div className="region-download-budget-grid">
                              <span>
                                Celdas L0
                                <strong>
                                  {explorationPlan.state.region.cellCount.toLocaleString(
                                    "es-GT",
                                  )}
                                </strong>
                              </span>
                              <span>
                                Capas
                                <strong>
                                  {REGIONAL_DOWNLOAD_LAYERS.length}
                                </strong>
                              </span>
                              <span>
                                Archivos
                                <strong>
                                  {plannedRegionFileBudget.toLocaleString(
                                    "es-GT",
                                  )}
                                </strong>
                              </span>
                              <span>
                                Pendientes
                                <strong>
                                  {plannedRegionPendingFiles.toLocaleString(
                                    "es-GT",
                                  )}
                                </strong>
                              </span>
                            </div>
                          </div>
                          <div className="region-persistence-note">
                            <HardDrive size={16} />
                            <span>
                              <strong>
                                {localRuntime?.capacity.configured
                                  ? "Región persistente en LuisA"
                                  : "LuisA no está disponible"}
                              </strong>
                              <small>
                                {localRuntime?.capacity.configured
                                  ? "Puedes cerrar el Atlas y continuar después sin repetir archivos válidos."
                                  : "Monta la biblioteca APFS antes de iniciar o reanudar la descarga."}
                              </small>
                            </span>
                            <span
                              className="persistence-badge"
                              data-state={
                                localRuntime?.capacity.configured
                                  ? "saved"
                                  : "offline"
                              }
                              title="Estado de la biblioteca regional"
                            >
                              <strong>
                                {localRuntime?.capacity.configured
                                  ? "En disco"
                                  : "Sin disco"}
                              </strong>
                            </span>
                          </div>
                          {activeDownloadProgress ? (
                            <div
                              className="region-download-metrics region-download-network-metrics"
                              aria-label="Métricas técnicas de descarga por red"
                            >
                              <span>
                                Velocidad de red
                                <strong>
                                  {activeDownloadProgress.networkTilesPerSecond ===
                                  undefined
                                    ? "—"
                                    : `${activeDownloadProgress.networkTilesPerSecond.toFixed(2)} tiles/s`}
                                </strong>
                              </span>
                              <span>
                                RPS logrado
                                <strong>
                                  {activeDownloadProgress.achievedRps ===
                                  undefined
                                    ? "—"
                                    : `${activeDownloadProgress.achievedRps.toFixed(2)} req/s`}
                                </strong>
                              </span>
                              <span>
                                Setpoint / objetivo
                                <strong>
                                  {activeDownloadProgress.effectiveRps ===
                                    undefined ||
                                  activeDownloadProgress.targetRps === undefined
                                    ? "—"
                                    : `${activeDownloadProgress.effectiveRps.toFixed(1)}/${activeDownloadProgress.targetRps.toFixed(0)} req/s`}
                                </strong>
                              </span>
                              <span>
                                Resolución total
                                <strong>
                                  {activeDownloadProgress.resolvedPerSecond ===
                                  undefined
                                    ? "—"
                                    : `${activeDownloadProgress.resolvedPerSecond.toFixed(2)} tiles/s`}
                                </strong>
                              </span>
                              <span>
                                Transferencia
                                <strong>
                                  {activeDownloadProgress.bytesPerSecond ===
                                  undefined
                                    ? "—"
                                    : `${formatBytes(activeDownloadProgress.bytesPerSecond)}/s`}
                                </strong>
                              </span>
                              <span>
                                ETA de red
                                <strong>
                                  {formatEta(activeDownloadProgress.etaSeconds)}
                                </strong>
                              </span>
                              <span>
                                Tiles de red
                                <strong>
                                  {activeDownloadProgress.networkProcessed ===
                                  undefined
                                    ? "—"
                                    : activeDownloadProgress.networkRequested ===
                                          undefined ||
                                        activeDownloadProgress.networkRequested ===
                                          null
                                      ? activeDownloadProgress.networkProcessed.toLocaleString(
                                          "es-GT",
                                        )
                                      : `${activeDownloadProgress.networkProcessed.toLocaleString("es-GT")}/${activeDownloadProgress.networkRequested.toLocaleString("es-GT")}`}
                                </strong>
                              </span>
                              <span>
                                Descargado
                                <strong>
                                  {formatBytes(
                                    activeDownloadProgress.downloadedBytes,
                                  )}
                                </strong>
                              </span>
                              <span>
                                Intentos HTTP
                                <strong>
                                  {activeDownloadProgress.requestAttempts ===
                                  undefined
                                    ? "—"
                                    : activeDownloadProgress.requestAttempts.toLocaleString(
                                        "es-GT",
                                      )}
                                </strong>
                              </span>
                              <span>
                                Faltantes
                                <strong>
                                  {regionStatus?.missingCount.toLocaleString(
                                    "es-GT",
                                  ) ?? "—"}
                                </strong>
                              </span>
                              <span>
                                Sin imagen
                                <strong>
                                  {regionStatus?.absentCount.toLocaleString(
                                    "es-GT",
                                  ) ?? "—"}
                                </strong>
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </details>
                      <button
                        type="button"
                        className="region-download-cancel"
                        disabled={matchingRegionDownloadRunning}
                        onClick={() => {
                          setExplorationPlan(null);
                          viewFullCoverage();
                        }}
                      >
                        Elegir otra región
                      </button>
                    </section>
                  ) : (
                    <details className="manual-region-details">
                      <summary>
                        <SquareDashedMousePointer size={17} />
                        <span>
                          <strong>Definir otra región</strong>
                          <small>
                            Dibujo, vista actual o coordenadas exactas
                          </small>
                        </span>
                      </summary>
                      <div className="manual-region-content">
                        <div className="region-actions">
                          <button
                            type="button"
                            onClick={() => beginMarkMode("region")}
                          >
                            <SquareMousePointer size={16} />
                            Dibujar región
                          </button>
                          <button type="button" onClick={useCurrentViewForRegion}>
                            <Crosshair size={16} />
                            Usar vista
                          </button>
                        </div>
                        <label className="region-name-field">
                          <span>Nombre</span>
                          <input
                            value={regionForm.name}
                            maxLength={200}
                            onChange={(event) =>
                              setRegionForm((current) => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <div className="region-coordinate-grid">
                          {(
                            [
                              ["minX", "X mínima"],
                              ["minZ", "Z mínima"],
                              ["maxXExclusive", "X máxima"],
                              ["maxZExclusive", "Z máxima"],
                            ] as const
                          ).map(([field, label]) => (
                            <label key={field}>
                              <span>{label}</span>
                              <input
                                inputMode="numeric"
                                value={regionForm[field]}
                                onChange={(event) =>
                                  setRegionForm((current) => ({
                                    ...current,
                                    [field]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <div className="fixed-zoom-card">
                          <LockKeyhole size={17} />
                          <span>
                            <strong>Detalle original garantizado</strong>
                            <small>LOD 0 · 512 bloques por celda</small>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={startExploration}
                        >
                          <Download size={17} />
                          Preparar descarga regional
                        </button>
                      </div>
                    </details>
                  )}
                  {!explorationPlan ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => explorationImportRef.current?.click()}
                    >
                      <Upload size={16} />
                      Importar sesión anterior
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <section className="exploration-progress-card">
                    <div className="exploration-progress-heading">
                      <div>
                        <span>SESIÓN ACTIVA</span>
                        <h3>{explorationState.region.name}</h3>
                      </div>
                      <strong>{formatProgressPercent(explorationPercent)}%</strong>
                    </div>
                    <div
                      className="exploration-progress-track"
                      role="progressbar"
                      aria-label="Progreso de exploración regional"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={explorationPercent}
                    >
                      <span style={{ width: `${explorationPercent}%` }} />
                    </div>
                    <div className="exploration-summary-grid">
                      <span>
                        Exploradas
                        <strong>
                          {explorationState.reviewedCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                      <span>
                        Total
                        <strong>
                          {reviewableCellCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                      <span>
                        Sin datos
                        <strong>
                          {explorationState.skippedCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                    </div>
                  </section>

                  {currentExplorationCell && (
                    <section className="current-cell-card">
                      <div className="current-cell-heading">
                        <div>
                          <span>CELDA ACTUAL</span>
                          <strong>
                            Fila {currentExplorationCell.row + 1} /{" "}
                            {explorationState.region.rows} · Columna{" "}
                            {currentExplorationCell.column + 1} /{" "}
                            {explorationState.region.columns}
                          </strong>
                        </div>
                        <span className="cell-lod">
                          L{explorationState.region.lod}
                        </span>
                      </div>
                      <code>
                        X [{currentExplorationCell.bounds.minX},{" "}
                        {currentExplorationCell.bounds.maxXExclusive}) · Z [
                        {currentExplorationCell.bounds.minZ},{" "}
                        {currentExplorationCell.bounds.maxZExclusive})
                      </code>
                      <div
                        className="current-detail-status"
                        data-state={
                          !activeExplorationIsMaxDetail
                            ? "legacy"
                            : currentCellSkipped
                              ? "absent"
                            : currentDetailReady
                              ? "ready"
                              : "loading"
                        }
                      >
                        {activeExplorationIsMaxDetail ? (
                          currentCellSkipped ? (
                            <>
                              <CheckCircle2 size={15} />
                              Sin imagen confirmada (404) · excluida del recorrido
                            </>
                          ) : currentDetailReady ? (
                            <>
                              <CheckCircle2 size={15} />
                              Celda explorada automáticamente · LOD 0 local
                            </>
                          ) : (
                            <>
                              <RotateCcw size={15} />
                              Cargando desde la región ya descargada…
                            </>
                          )
                        ) : (
                          <>
                            <AlertTriangle size={15} />
                            Sesión heredada en LOD{" "}
                            {explorationState.region.lod} · solo lectura
                          </>
                        )}
                      </div>
                      {!activeExplorationIsMaxDetail ? (
                        <button
                          type="button"
                          className="primary-button legacy-upgrade-button"
                          onClick={createMaxDetailVersionOfLegacy}
                        >
                          <Sparkles size={16} />
                          Crear versión en LOD 0
                        </button>
                      ) : null}
                    </section>
                  )}

                  <div className="exploration-transfer">
                    <button type="button" onClick={exportExploration}>
                      <Download size={15} />
                      Exportar
                    </button>
                    <button
                      type="button"
                      onClick={() => explorationImportRef.current?.click()}
                    >
                      <Upload size={15} />
                      Importar
                    </button>
                    <button
                      type="button"
                      className="danger"
                      aria-expanded={confirmCloseExploration}
                      onClick={finishExploration}
                    >
                      <Trash2 size={15} />
                      Pausar sesión
                    </button>
                  </div>
                  {confirmCloseExploration ? (
                    <section
                      className="exploration-close-confirm"
                      aria-label="Confirmar cierre de sesión"
                    >
                      <div>
                        <strong>¿Pausar esta sesión?</strong>
                        <small>
                          El progreso seguirá en el workspace y podrás abrirlo
                          otra vez.
                        </small>
                      </div>
                      <div>
                        <button
                          type="button"
                          onClick={() => setConfirmCloseExploration(false)}
                        >
                          Conservar
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={persistenceState === "saving"}
                          onClick={confirmFinishExploration}
                        >
                          {persistenceState === "saving"
                            ? "Guardando…"
                            : "Pausar y guardar"}
                        </button>
                      </div>
                    </section>
                  ) : null}
                </>
              )}

              <input
                ref={explorationImportRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={importExploration}
              />

              <details className="local-data-details">
                <summary>Biblioteca local</summary>
                <div className={`archive-hero ${localSource ? "connected" : ""}`}>
                  <div className="archive-icon">
                    {localSource ? <Check /> : <FolderOpen />}
                  </div>
                  <div>
                    <span>
                      {localSource ? "CARPETA CONECTADA" : "BIBLIOTECA LOCAL"}
                    </span>
                    <h3>
                      {archiveName ??
                        (localRuntime?.capacity.configured
                          ? "LuisA conectada"
                          : "Elegir 2b2t_tiles")}
                    </h3>
                    <p>El visor solo abre tiles que ya están guardados.</p>
                  </div>
                </div>
                {localSupported && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={localSource ? disconnectArchive : openArchive}
                  >
                    {localSource ? <X size={17} /> : <FolderOpen size={17} />}
                    {localSource ? "Desconectar carpeta" : "Elegir carpeta"}
                  </button>
                )}
                <div className="stats-grid">
                  <Metric label="Local" value={tileStats.local} tone="mint" />
                  <Metric
                    label="Ausentes"
                    value={tileStats.missing}
                    tone="amber"
                  />
                </div>
              </details>
            </div>
          )}

          {drawer === "highlights" && (
            <div className="drawer-content highlight-panel">
              <section
                className={`xaero-export-card ${xaeroExpanded ? "expanded" : ""}`}
                aria-busy={xaeroBusy !== null}
              >
                <button
                  type="button"
                  className="xaero-export-launch"
                  aria-expanded={xaeroExpanded}
                  aria-controls="xaero-export-preview"
                  onClick={() => {
                    if (xaeroExpanded) {
                      setXaeroExpanded(false);
                    } else if (xaeroPreview) {
                      setXaeroExpanded(true);
                    } else {
                      void prepareXaeroOperation();
                    }
                  }}
                  disabled={xaeroBusy !== null || workspaceMutationsBlocked}
                >
                  <Navigation size={18} />
                  <span>
                    <strong>Sincronizar con Xaero 2b2t</strong>
                    <small>
                      Exportar o retirar por región · Overworld + Nether
                    </small>
                  </span>
                  {xaeroBusy === "preview" ? (
                    <RotateCcw className="spin" size={16} />
                  ) : xaeroResult ? (
                    <CheckCircle2 size={16} />
                  ) : (
                    <ChevronLeft className="xaero-chevron" size={16} />
                  )}
                </button>

                {xaeroExpanded && (
                  <div
                    className="xaero-export-preview"
                    id="xaero-export-preview"
                  >
                    <fieldset
                      className="xaero-operation-picker"
                      disabled={xaeroBusy !== null}
                    >
                      <legend>ACCIÓN</legend>
                      <button
                        type="button"
                        aria-pressed={xaeroOperation === "export"}
                        className={
                          xaeroOperation === "export" ? "active" : ""
                        }
                        onClick={() => {
                          if (xaeroOperation === "export") return;
                          setXaeroOperation("export");
                          invalidateXaeroPreview();
                        }}
                      >
                        <Download size={14} />
                        Exportar
                      </button>
                      <button
                        type="button"
                        aria-pressed={xaeroOperation === "remove"}
                        className={
                          xaeroOperation === "remove" ? "active danger" : ""
                        }
                        onClick={() => {
                          if (xaeroOperation === "remove") return;
                          setXaeroOperation("remove");
                          invalidateXaeroPreview();
                        }}
                      >
                        <Trash2 size={14} />
                        Retirar
                      </button>
                    </fieldset>

                    <label
                      className="xaero-scope-picker"
                      htmlFor="xaero-scope"
                    >
                      <span>ALCANCE</span>
                      <select
                        id="xaero-scope"
                        value={
                          xaeroScope.kind === "all"
                            ? "__all__"
                            : xaeroScope.explorationId
                        }
                        disabled={xaeroBusy !== null}
                        aria-describedby="xaero-scope-help"
                        onChange={(event) => {
                          const value = event.target.value;
                          xaeroDefaultScopeAppliedRef.current = true;
                          chooseXaeroScope(
                            value === "__all__"
                              ? { kind: "all" }
                              : {
                                  kind: "exploration",
                                  explorationId: value,
                                },
                          );
                          invalidateXaeroPreview();
                        }}
                      >
                        <option value="__all__">
                          Todo el Atlas ·{" "}
                          {
                            highlights.filter(
                              (highlight) => highlight.type === "pin",
                            ).length
                          }{" "}
                          puntos
                        </option>
                        {xaeroRegionOptions.map((region) => (
                          <option key={region.id} value={region.id}>
                            {region.name} · {region.pinCount}{" "}
                            {region.pinCount === 1 ? "punto" : "puntos"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p id="xaero-scope-help" className="xaero-scope-help">
                      {xaeroScope.kind === "all"
                        ? xaeroOperation === "remove"
                          ? "Incluye todos los marcadores que Atlas administra, incluso si el highlight original cambió."
                          : "Incluye todos los puntos guardados en el workspace."
                        : xaeroOperation === "remove"
                          ? "Usa la posición Overworld registrada al exportar; también encuentra highlights movidos o eliminados."
                          : "Incluye puntos cuya coordenada actual está dentro de los límites guardados de la región."}
                    </p>
                    <div className="xaero-scope-summary" aria-live="polite">
                      <MapPin size={13} />
                      <span>{xaeroSelectionLabel}</span>
                    </div>

                    {xaeroBusy === "preview" && !xaeroPreview ? (
                      <p className="xaero-checking">
                        Preparando vista previa en ambos mapas…
                      </p>
                    ) : null}

                    {xaeroError ? (
                      <div className="xaero-message error" role="alert">
                        <AlertTriangle size={16} />
                        <span>{xaeroError}</span>
                      </div>
                    ) : null}

                    {!xaeroPreview && xaeroBusy !== "preview" ? (
                      <button
                        type="button"
                        className="secondary-button xaero-preview-button"
                        onClick={() => void prepareXaeroOperation()}
                        disabled={
                          xaeroBusy !== null || workspaceMutationsBlocked
                        }
                      >
                        <Eye size={15} />
                        {xaeroOperation === "remove"
                          ? "Previsualizar retirada"
                          : "Previsualizar exportación"}
                      </button>
                    ) : null}

                    {xaeroPreview ? (
                      <>
                        <div className="xaero-preview-heading">
                          <span>
                            {xaeroPreview.scope === "exploration"
                              ? xaeroPreview.regionName
                              : "Todo el Atlas"}
                          </span>
                          <strong>
                            {xaeroPreview.operation === "remove"
                              ? xaeroPreview.managedHighlights.toLocaleString(
                                  "es-GT",
                                )
                              : xaeroPreview.selectedHighlights.toLocaleString(
                                  "es-GT",
                                )}{" "}
                            {xaeroPreview.operation === "remove"
                              ? xaeroPreview.managedHighlights === 1
                                ? "marcador exportado administrado"
                                : "marcadores exportados administrados"
                              : xaeroPreview.selectedHighlights === 1
                                ? "highlight seleccionado"
                                : "highlights seleccionados"}
                          </strong>
                          {xaeroPreview.operation === "remove" ? (
                            <small>
                              {xaeroPreview.selectedHighlights.toLocaleString(
                                "es-GT",
                              )}{" "}
                              highlights actuales en el alcance ·{" "}
                              {xaeroPreview.removableHighlights.toLocaleString(
                                "es-GT",
                              )}{" "}
                              con filas retirables
                            </small>
                          ) : null}
                        </div>
                        <div className="xaero-dimension-grid">
                          <div>
                            <span>OVERWORLD</span>
                            {xaeroPreview.operation === "remove" ? (
                              <>
                                <strong>
                                  −{xaeroPreview.overworld.removed}{" "}
                                  {xaeroPreview.overworld.removed === 1
                                    ? "retirada"
                                    : "retiradas"}
                                </strong>
                                <small>
                                  {xaeroPreview.overworld.alreadyAbsent} ya{" "}
                                  {xaeroPreview.overworld.alreadyAbsent === 1
                                    ? "ausente"
                                    : "ausentes"}{" "}
                                  · {xaeroPreview.overworld.conflicts} en
                                  conflicto
                                </small>
                              </>
                            ) : (
                              <>
                                <strong>
                                  +{xaeroPreview.overworld.added}{" "}
                                  {xaeroPreview.overworld.added === 1
                                    ? "nueva"
                                    : "nuevas"}
                                </strong>
                                <small>
                                  {xaeroPreview.overworld.existing}{" "}
                                  {xaeroPreview.overworld.existing === 1
                                    ? "existente"
                                    : "existentes"}{" "}
                                  · {xaeroPreview.overworld.updated}{" "}
                                  {xaeroPreview.overworld.updated === 1
                                    ? "actualizada"
                                    : "actualizadas"}
                                </small>
                              </>
                            )}
                          </div>
                          <div>
                            <span>NETHER · 1:8</span>
                            {xaeroPreview.operation === "remove" ? (
                              <>
                                <strong>
                                  −{xaeroPreview.nether.removed}{" "}
                                  {xaeroPreview.nether.removed === 1
                                    ? "retirada"
                                    : "retiradas"}
                                </strong>
                                <small>
                                  {xaeroPreview.nether.alreadyAbsent} ya{" "}
                                  {xaeroPreview.nether.alreadyAbsent === 1
                                    ? "ausente"
                                    : "ausentes"}{" "}
                                  · {xaeroPreview.nether.conflicts} en conflicto
                                </small>
                              </>
                            ) : (
                              <>
                                <strong>
                                  +{xaeroPreview.nether.added}{" "}
                                  {xaeroPreview.nether.added === 1
                                    ? "nueva"
                                    : "nuevas"}
                                </strong>
                                <small>
                                  {xaeroPreview.nether.existing}{" "}
                                  {xaeroPreview.nether.existing === 1
                                    ? "existente"
                                    : "existentes"}{" "}
                                  · {xaeroPreview.nether.updated}{" "}
                                  {xaeroPreview.nether.updated === 1
                                    ? "actualizada"
                                    : "actualizadas"}
                                </small>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="xaero-preservation-note">
                          <HardDrive size={15} />
                          {xaeroPreview.operation === "remove" ? (
                            <span>
                              Solo se retiran filas intactas administradas por
                              Atlas en este alcance. No se borran highlights de
                              Atlas ni marcadores ajenos; los cambios manuales
                              se preservan. Se crea un respaldo en LuisA.
                            </span>
                          ) : (
                            <span>
                              Los marcadores existentes se preservan. Cada
                              nombre termina en <strong> - Atlas</strong> y se
                              crea un respaldo en LuisA.
                            </span>
                          )}
                        </div>

                        {xaeroPreview.minecraftOpen ? (
                          <div className="xaero-message warning" role="status">
                            <LockKeyhole size={16} />
                            <span>
                              Minecraft está abierto. La previsualización es
                              segura, pero debes cerrarlo antes de escribir.
                            </span>
                          </div>
                        ) : null}

                        {xaeroPreview.conflicts > 0 ? (
                          <div className="xaero-message warning">
                            <AlertTriangle size={16} />
                            <span>
                              {xaeroPreview.conflicts}{" "}
                              {xaeroPreview.conflicts === 1
                                ? "highlight tiene"
                                : "highlights tienen"}{" "}
                              {xaeroPreview.operation === "remove"
                                ? "filas modificadas o duplicadas; "
                                : "cambios manuales o duplicados; "}
                              {xaeroPreview.conflicts === 1
                                ? "se preservará."
                                : "se preservarán."}
                            </span>
                          </div>
                        ) : null}

                        {xaeroPreview.skippedAreas > 0 ||
                        xaeroPreview.notesNotExported > 0 ? (
                          <p className="xaero-caveat">
                            {xaeroPreview.skippedAreas > 0
                              ? xaeroPreview.skippedAreas === 1
                                ? "1 área omitida; Xaero solo admite puntos. "
                                : `${xaeroPreview.skippedAreas} áreas omitidas; Xaero solo admite puntos. `
                              : ""}
                            {xaeroPreview.notesNotExported > 0
                              ? xaeroPreview.notesNotExported === 1
                                ? "1 nota permanece únicamente en Atlas."
                                : `${xaeroPreview.notesNotExported} notas permanecen únicamente en Atlas.`
                              : ""}
                          </p>
                        ) : null}

                        {xaeroResult ? (
                          <div className="xaero-message success" role="status">
                            <CheckCircle2 size={16} />
                            <span>
                              {xaeroResult.operation === "remove"
                                ? "Retirada terminada y verificada en ambas dimensiones."
                                : "Exportación terminada y verificada en ambas dimensiones."}{" "}
                              Respaldo guardado en LuisA.
                            </span>
                          </div>
                        ) : null}

                        {xaeroPreview.operation === "remove" &&
                        xaeroPreview.hasChanges &&
                        !xaeroResult ? (
                          <div
                            className="xaero-remove-confirmation"
                            role="group"
                            aria-labelledby="xaero-remove-confirmation-title"
                          >
                            <div>
                              <Trash2 size={16} />
                              <span>
                                <strong id="xaero-remove-confirmation-title">
                                  Confirmación necesaria
                                </strong>
                                Se procesarán{" "}
                                {xaeroPreview.managedHighlights.toLocaleString(
                                  "es-GT",
                                )}{" "}
                                marcadores administrados y se retirarán hasta{" "}
                                {(
                                  xaeroPreview.overworld.removed +
                                  xaeroPreview.nether.removed
                                ).toLocaleString("es-GT")}{" "}
                                filas Atlas de Overworld y Nether. Las
                                referencias de filas ya ausentes se limpiarán.
                                {" "}
                                Los highlights seguirán guardados en Atlas.
                              </span>
                            </div>
                            <label>
                              <input
                                type="checkbox"
                                checked={xaeroRemoveConfirmed}
                                onChange={(event) =>
                                  setXaeroRemoveConfirmed(event.target.checked)
                                }
                              />
                              <span>
                                Confirmo que quiero aplicar esta retirada en
                                Xaero
                              </span>
                            </label>
                          </div>
                        ) : null}

                        <div className="xaero-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void prepareXaeroOperation()}
                            disabled={xaeroBusy !== null}
                          >
                            <RotateCcw size={15} />
                            Actualizar vista
                          </button>
                          <button
                            type="button"
                            className={
                              xaeroPreview.operation === "remove"
                                ? "danger-button"
                                : "primary-button"
                            }
                            onClick={() => void commitXaeroOperation()}
                            disabled={
                              xaeroBusy !== null ||
                              !xaeroPreview.canExport ||
                              (xaeroPreview.operation === "remove" &&
                                !xaeroRemoveConfirmed)
                            }
                          >
                            {xaeroPreview.operation === "remove" ? (
                              <Trash2 size={16} />
                            ) : (
                              <Download size={16} />
                            )}
                            {xaeroBusy === "export"
                              ? "Exportando…"
                              : xaeroBusy === "remove"
                                ? "Retirando…"
                                : xaeroPreview.minecraftOpen
                                  ? "Minecraft abierto"
                                  : xaeroPreview.operation === "remove"
                                    ? xaeroPreview.hasChanges
                                      ? "Retirar de ambas"
                                      : "Nada que retirar"
                                    : xaeroPreview.hasChanges
                                      ? "Exportar ambas"
                                      : "Xaero está al día"}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </section>

              <section className="highlight-scope-card" aria-live="polite">
                <span className="highlight-scope-icon">
                  <Grid3X3 size={16} />
                </span>
                <span>
                  <small>
                    {explorationState ? "REGIÓN ACTIVA" : "SIN REGIÓN ACTIVA"}
                  </small>
                  <strong>
                    {explorationState?.region.name ?? "Highlights generales"}
                  </strong>
                  <em>
                    {scopedHighlights.length.toLocaleString("es-GT")}{" "}
                    {scopedHighlights.length === 1
                      ? "highlight guardado"
                      : "highlights guardados"}{" "}
                    en esta región
                    {highlights.length > scopedHighlights.length
                      ? ` · ${(highlights.length - scopedHighlights.length).toLocaleString("es-GT")} de otras regiones ocultos`
                      : ""}
                  </em>
                </span>
              </section>

              <section
                className={`highlight-route-card ${highlightRouteEnabled ? "active" : ""}`}
                aria-labelledby="highlight-route-title"
                aria-busy={highlightRouteIsCalculating}
              >
                <div className="highlight-route-heading">
                  <span className="highlight-route-icon">
                    <Route size={18} />
                  </span>
                  <span>
                    <small>ANÁLISIS DE RECORRIDO</small>
                    <strong id="highlight-route-title">Ruta inteligente</strong>
                    <em>
                      Conecta todos los highlights en línea recta, sin regresar
                      al inicio.
                    </em>
                  </span>
                </div>

                {!activeExplorationRegion ? (
                  <p className="highlight-route-empty">
                    Abre una región explorada para calcular su recorrido.
                  </p>
                ) : scopedHighlights.length === 0 ? (
                  <p className="highlight-route-empty">
                    Crea al menos un highlight en esta región para iniciar el
                    análisis.
                  </p>
                ) : (
                  <>
                    <label
                      className="highlight-route-start"
                      htmlFor="highlight-route-start"
                    >
                      <span>PUNTO INICIAL</span>
                      <input
                        type="search"
                        value={highlightRouteStartSearch}
                        onChange={(event) =>
                          setHighlightRouteStartSearch(event.target.value)
                        }
                        placeholder="Filtrar por nombre, ID o coordenadas"
                        aria-label="Filtrar puntos iniciales"
                      />
                      <select
                        id="highlight-route-start"
                        value={validHighlightRouteStartId ?? ""}
                        onChange={(event) =>
                          setHighlightRouteStartId(
                            event.target.value === ""
                              ? null
                              : event.target.value,
                          )
                        }
                      >
                        <option value="">
                          Automático · esquina superior izquierda
                        </option>
                        {highlightRouteStartOptions.map((highlight) => (
                          <option key={highlight.id} value={highlight.id}>
                            {highlight.title} · X {Math.round(highlight.x)}, Z{" "}
                            {Math.round(highlight.z)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="highlight-route-start-help">
                      El automático elige el punto más cercano a minX/minZ.
                      También puedes fijar manualmente la primera parada.
                      {scopedHighlights.length >
                      highlightRouteStartOptions.length
                        ? ` Se muestran hasta ${MAX_HIGHLIGHT_ROUTE_START_OPTIONS}; usa el filtro para encontrar cualquier otro.`
                        : ""}
                    </p>

                    {highlightRouteIsCalculating ? (
                      <div
                        className="highlight-route-calculation"
                        role="status"
                      >
                        <RotateCcw
                          className="highlight-route-spinner"
                          size={16}
                        />
                        <span>
                          <strong>Calculando en segundo plano…</strong>
                          <small>
                            Puedes seguir usando el mapa mientras termina.
                          </small>
                        </span>
                        <button
                          type="button"
                          onClick={() => setHighlightRouteEnabled(false)}
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : highlightRouteError ? (
                      <div className="highlight-route-error" role="alert">
                        <p>{highlightRouteError}</p>
                        <button
                          type="button"
                          className="highlight-route-primary"
                          onClick={() =>
                            setHighlightRouteRetry(
                              (current) => current + 1,
                            )
                          }
                        >
                          <RotateCcw size={16} />
                          Reintentar cálculo
                        </button>
                      </div>
                    ) : !highlightRoute ? (
                      <button
                        type="button"
                        className="highlight-route-primary"
                        onClick={() => setHighlightRouteEnabled(true)}
                      >
                        <Route size={16} />
                        Calcular y superponer ruta
                      </button>
                    ) : (
                      <>
                        <div
                          className="highlight-route-metrics"
                          aria-live="polite"
                        >
                          <span>
                            <small>PARADAS</small>
                            <strong>
                              {highlightRoute.stops.length.toLocaleString(
                                "es-GT",
                              )}
                            </strong>
                          </span>
                          <span>
                            <small>DISTANCIA</small>
                            <strong>
                              {Math.round(
                                highlightRoute.totalDistance,
                              ).toLocaleString("es-GT")}{" "}
                              bl.
                            </strong>
                          </span>
                        </div>
                        <p className="highlight-route-method">
                          {highlightRoute.optimal
                            ? "Ruta óptima exacta · Held–Karp"
                            : "Ruta heurística escalable · vecino más cercano + 2-opt"}
                        </p>
                        <div className="highlight-route-actions">
                          <button
                            type="button"
                            onClick={() => setHighlightRouteEnabled(false)}
                          >
                            <EyeOff size={14} />
                            Ocultar
                          </button>
                          <button type="button" onClick={exportHighlightRoute}>
                            <Download size={14} />
                            JSON
                          </button>
                          <button
                            type="button"
                            onClick={exportHighlightRouteImage}
                          >
                            <Download size={14} />
                            PNG vista
                          </button>
                        </div>
                        <div className="highlight-route-list-heading">
                          <span>ORDEN DE VISITA</span>
                          <small>
                            {highlightRoute.startMode === "selected"
                              ? "Inicio elegido"
                              : "Inicio automático"}
                          </small>
                        </div>
                        <ol className="highlight-route-list">
                          {highlightRoute.stops
                            .slice(0, MAX_VISIBLE_ROUTE_STOPS)
                            .map((stop) => (
                              <li key={stop.highlight.id}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedHighlightId(stop.highlight.id);
                                    focusMapPoint(
                                      stop.highlight.x,
                                      stop.highlight.z,
                                    );
                                  }}
                                >
                                  <span
                                    className={
                                      stop.order === 1
                                        ? "route-order start"
                                        : "route-order"
                                    }
                                  >
                                    {stop.label}
                                  </span>
                                  <span>
                                    <strong>{stop.highlight.title}</strong>
                                    <small>
                                      X {formatCoordinate(stop.highlight.x)} · Z{" "}
                                      {formatCoordinate(stop.highlight.z)}
                                      {stop.order > 1
                                        ? ` · +${Math.round(stop.distanceFromPrevious).toLocaleString("es-GT")} bl.`
                                        : " · inicio"}
                                    </small>
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ol>
                        {highlightRoute.stops.length >
                        MAX_VISIBLE_ROUTE_STOPS ? (
                          <p className="highlight-route-overflow">
                            Se muestran las primeras{" "}
                            {MAX_VISIBLE_ROUTE_STOPS.toLocaleString("es-GT")}{" "}
                            paradas; el overlay y el JSON conservan las{" "}
                            {highlightRoute.stops.length.toLocaleString(
                              "es-GT",
                            )}{" "}
                            completas.
                          </p>
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </section>

              <div className="highlight-tools">
                <button
                  type="button"
                  className={markMode === "pin" ? "active" : ""}
                  aria-pressed={markMode === "pin"}
                  onClick={() => {
                    if (markMode === "pin") {
                      pinStartRef.current = null;
                      setMarkMode(null);
                    } else {
                      beginMarkMode("pin");
                    }
                  }}
                >
                  <MapPin size={17} />
                  Punto
                  <kbd>M</kbd>
                </button>
                <button
                  type="button"
                  className={markMode === "area" ? "active" : ""}
                  aria-pressed={markMode === "area"}
                  onClick={() => {
                    if (markMode === "area") {
                      areaStartRef.current = null;
                      areaPreviewRef.current = undefined;
                      setAreaPreview(undefined);
                      setMarkMode(null);
                    } else {
                      beginMarkMode("area");
                    }
                  }}
                >
                  <SquareDashedMousePointer size={17} />
                  Área
                  <kbd>R</kbd>
                </button>
              </div>
              <div className="highlight-transfer-label">
                Copia y recuperación
              </div>
              <div className="highlight-transfer">
                <button type="button" onClick={exportHighlights}>
                  <Download size={15} />
                  Descargar JSON
                </button>
                <button type="button" onClick={() => importRef.current?.click()}>
                  <Upload size={15} />
                  Importar JSON
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={importHighlights}
                />
              </div>

              {selectedHighlight ? (
                <div className="highlight-editor">
                  <button
                    type="button"
                    className="back-button"
                    onClick={() => setSelectedHighlightId(null)}
                  >
                    <ChevronLeft size={16} />
                    Todos los highlights
                  </button>
                  <div className="editor-type">
                    {selectedHighlight.type === "pin" ? (
                      <MapPin size={18} />
                    ) : (
                      <AreaChart size={18} />
                    )}
                    <span>
                      {selectedHighlight.type === "pin"
                        ? "PUNTO MARCADO"
                        : "ÁREA MARCADA"}
                    </span>
                  </div>
                  <label>
                    <span>Nombre</span>
                    <input
                      value={selectedHighlight.title}
                      maxLength={200}
                      onChange={(event) =>
                        updateSelectedHighlight({ title: event.target.value })
                      }
                    />
                  </label>
                  <fieldset className="highlight-name-presets">
                    <legend>Nombre rápido</legend>
                    {selectedHighlightPresetNames.map(
                      ({ preset, title }) => (
                        <button
                          key={preset}
                          type="button"
                          className={
                            selectedHighlight.title === title
                              ? "selected"
                              : ""
                          }
                          onClick={() =>
                            updateSelectedHighlight({ title })
                          }
                        >
                          {title}
                        </button>
                      ),
                    )}
                    <span>o escribe el nombre que desees arriba</span>
                  </fieldset>
                  <label>
                    <span>Notas</span>
                    <textarea
                      rows={4}
                      value={selectedHighlight.note}
                      maxLength={20_000}
                      placeholder="Qué hay aquí, cuándo se revisó…"
                      onChange={(event) =>
                        updateSelectedHighlight({ note: event.target.value })
                      }
                    />
                  </label>
                  <div className="coordinate-readout">
                    <span>X {formatCoordinate(selectedHighlight.x)}</span>
                    <span>Z {formatCoordinate(selectedHighlight.z)}</span>
                    <button
                      type="button"
                      aria-label="Centrar highlight"
                      onClick={() =>
                        focusMapPoint(selectedHighlight.x, selectedHighlight.z)
                      }
                    >
                      <Crosshair size={16} />
                    </button>
                  </div>
                  {activeExplorationRegion ? (
                    <button
                      type="button"
                      className={`highlight-route-select-start ${
                        validHighlightRouteStartId === selectedHighlight.id
                          ? "active"
                          : ""
                      }`}
                      aria-pressed={
                        validHighlightRouteStartId === selectedHighlight.id
                      }
                      onClick={() => {
                        setHighlightRouteStartId(selectedHighlight.id);
                        setHighlightRouteEnabled(true);
                        notify(
                          `“${selectedHighlight.title}” será el inicio de la ruta`,
                        );
                      }}
                    >
                      <Route size={15} />
                      {validHighlightRouteStartId === selectedHighlight.id
                        ? "Punto inicial de la ruta"
                        : "Usar como punto inicial"}
                    </button>
                  ) : null}
                  {selectedHighlight.bounds && (
                    <p className="bounds-readout">
                      X {formatCoordinate(selectedHighlight.bounds.x1)} →{" "}
                      {formatCoordinate(selectedHighlight.bounds.x2)}
                      <br />
                      Z {formatCoordinate(selectedHighlight.bounds.z1)} →{" "}
                      {formatCoordinate(selectedHighlight.bounds.z2)}
                    </p>
                  )}
                  <fieldset className="color-picker">
                    <legend>Color</legend>
                    {COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Usar color ${color}`}
                        className={
                          selectedHighlight.color === color ? "selected" : ""
                        }
                        style={{ backgroundColor: color }}
                        onClick={() => updateSelectedHighlight({ color })}
                      />
                    ))}
                  </fieldset>
                  <button
                    className="setting-row compact"
                    type="button"
                    aria-pressed={selectedHighlight.visible}
                    onClick={() =>
                      updateSelectedHighlight({
                        visible: !selectedHighlight.visible,
                      })
                    }
                  >
                    {selectedHighlight.visible ? (
                      <Eye size={17} />
                    ) : (
                      <EyeOff size={17} />
                    )}
                    <span>
                      <strong>Visible en el mapa</strong>
                    </span>
                    <span
                      className={`switch ${selectedHighlight.visible ? "on" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={deleteSelectedHighlight}
                  >
                    <Trash2 size={16} />
                    Eliminar highlight
                  </button>
                </div>
              ) : scopedHighlights.length ? (
                <div className="highlight-list">
                  <div className="list-heading">
                    <span>
                      {scopedHighlights.length} guardados en esta región
                    </span>
                    <ListFilter size={15} />
                  </div>
                  {scopedHighlights.map((highlight) => (
                    <button
                      type="button"
                      className="highlight-list-item"
                      key={highlight.id}
                      onClick={() => {
                        setSelectedHighlightId(highlight.id);
                        focusMapPoint(highlight.x, highlight.z);
                      }}
                    >
                      <span
                        className="highlight-list-icon"
                        style={{ color: highlight.color }}
                      >
                        {highlight.type === "pin" ? (
                          <MapPin size={17} />
                        ) : (
                          <AreaChart size={17} />
                        )}
                      </span>
                      <span>
                        <strong>{highlight.title}</strong>
                        <small>
                          X {formatCoordinate(highlight.x)} · Z{" "}
                          {formatCoordinate(highlight.z)}
                        </small>
                      </span>
                      {highlight.visible ? (
                        <Eye size={15} />
                      ) : (
                        <EyeOff size={15} />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div>
                    <MapPin />
                  </div>
                  <h3>Tu mapa, tus referencias</h3>
                  <p>
                    Haz clic derecho para guardar Base, Base D o Mapa al
                    instante. También puedes marcar un punto, un área o usar
                    el nombre que desees.
                  </p>
                  <button type="button" onClick={() => beginMarkMode("pin")}>
                    <Plus size={16} />
                    Crear primer punto
                  </button>
                </div>
              )}
            </div>
          )}

          {drawer === "help" && (
            <div className="drawer-content">
              <div className="help-intro">
                <MousePointer2 size={22} />
                <h3>Explora sin perderte</h3>
                <p>
                  El cursor muestra coordenadas precisas y el centro siempre
                  queda marcado por la retícula.
                </p>
              </div>
              <div className="shortcut-list">
                <Shortcut keys="Arrastrar" label="Mover el mapa" />
                <Shortcut keys="Rueda / ±" label="Cambiar zoom" />
                <Shortcut keys="0 / Home" label="Abrir mapa general" />
                <Shortcut keys="Flechas" label="Saltar entre celdas" />
                <Shortcut keys="G" label="Ir a coordenadas" />
                <Shortcut keys="E" label="Abrir exploración" />
                <Shortcut keys="M" label="Marcar punto" />
                <Shortcut keys="L" label="Activar o desactivar lupa" />
                <Shortcut keys="R" label="Dibujar área" />
                <Shortcut keys="Esc" label="Cancelar o cerrar" />
              </div>
              <div className="archive-note">
                <HelpCircle size={17} />
                <p>
                  Toda región nueva usa LOD 0. Puedes acercar y mover el mapa
                  sin perder el detalle original de 512 × 512 bloques.
                </p>
              </div>
              <a
                className="source-attribution"
                href="https://2b2t.place"
                target="_blank"
                rel="noreferrer"
              >
                <Link2 size={16} />
                <span>
                  Tiles cartográficos de <strong>2b2t.place</strong>
                </span>
              </a>
            </div>
          )}
        </aside>
      )}

      <div className="bottom-left-status">
        <span
          className={`source-dot ${
            localSource || localRuntime?.capacity.configured
              ? "is-local"
              : "is-online"
          }`}
        />
        <strong>
          {localSource
            ? "Carpeta local"
            : localRuntime?.capacity.configured
              ? "Biblioteca LuisA"
              : "Solo local"}
        </strong>
        <span>
          Cursor X {formatCoordinate(cursor.x)} · Z {formatCoordinate(cursor.z)}
        </span>
      </div>

      {isExploring ? (
        <>
          <button
            type="button"
            className={`magnifier-toggle glass-card ${magnifierEnabled ? "active" : ""}`}
            aria-label={
              magnifierEnabled
                ? "Desactivar lupa del mapa"
                : "Activar lupa del mapa"
            }
            aria-keyshortcuts="L"
            aria-pressed={magnifierEnabled}
            onClick={toggleMagnifier}
          >
            <ScanSearch size={15} aria-hidden="true" />
            <span>{magnifierEnabled ? "Lupa activa" : "Lupa"}</span>
            <kbd>L</kbd>
          </button>
          <span id="map-magnifier-help" className="sr-only">
            Presiona L para activar o desactivar una lupa de detalle que sigue
            el puntero.
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            {magnifierEnabled ? "Lupa activada" : "Lupa desactivada"}
          </span>
        </>
      ) : null}

      <div
        ref={fallbackBadgeRef}
        className="fallback-badge glass-card"
        data-active="false"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <RotateCcw size={14} aria-hidden="true" />
        <span ref={fallbackTextRef} />
      </div>

      {explorationState && currentExplorationCell && !atlasMode && (
        <section
          className="exploration-navigation glass-card"
          aria-label="Navegación por celdas"
        >
          <div className="navigation-progress">
            <span>
              CELDA{" "}
              {explorationState.currentIndex + 1}{" "}
              / {explorationState.region.cellCount.toLocaleString("es-GT")}
            </span>
            <strong>{formatProgressPercent(explorationPercent)}%</strong>
          </div>
          <span className="navigation-auto-state">
            <CheckCircle2 />
            {currentCellSkipped ? "Sin imagen" : "Auto"}
          </span>
          <div className="direction-pad">
            <button
              type="button"
              className="north"
              aria-label="Celda superior"
              disabled={
                cardinalNeighbor(
                  explorationState.region,
                  explorationState.currentIndex,
                  "north",
                ) === null
              }
              onClick={() => moveExplorationCardinal("north")}
            >
              <ArrowUp />
            </button>
            <button
              type="button"
              className="west"
              aria-label="Celda izquierda"
              disabled={
                cardinalNeighbor(
                  explorationState.region,
                  explorationState.currentIndex,
                  "west",
                ) === null
              }
              onClick={() => moveExplorationCardinal("west")}
            >
              <ArrowLeft />
            </button>
            <span className="center-label" aria-hidden="true">
              <Navigation />
            </span>
            <button
              type="button"
              className="east"
              aria-label="Celda derecha"
              disabled={
                cardinalNeighbor(
                  explorationState.region,
                  explorationState.currentIndex,
                  "east",
                ) === null
              }
              onClick={() => moveExplorationCardinal("east")}
            >
              <ArrowRight />
            </button>
            <button
              type="button"
              className="south"
              aria-label="Celda inferior"
              disabled={
                cardinalNeighbor(
                  explorationState.region,
                  explorationState.currentIndex,
                  "south",
                ) === null
              }
              onClick={() => moveExplorationCardinal("south")}
            >
              <ArrowDown />
            </button>
          </div>
        </section>
      )}

      <div className="zoom-stack glass-card">
        <button
          type="button"
          aria-label="Acercar"
          title="Acercar"
          onClick={() => zoomAt(1.5)}
        >
          <Plus />
        </button>
        <span className="zoom-lod">
          {explorationState && !atlasMode ? <LockKeyhole size={12} /> : null} L
          {lod}
        </span>
        <button
          type="button"
          aria-label="Alejar"
          title="Alejar"
          onClick={() => zoomAt(1 / 1.5)}
        >
          <Minus />
        </button>
        <button
          type="button"
          aria-label={
            atlasMode
              ? explorationState
                ? "Volver a la sesión activa"
                : "Volver al detalle anterior"
              : explorationState
                ? "Volver a la celda activa"
                : "Volver al área inicial"
          }
          title={
            atlasMode
              ? explorationState
                ? "Volver a la sesión activa"
                : "Volver al detalle anterior"
              : explorationState
                ? "Volver a la celda activa"
                : "Volver al área inicial"
          }
          onClick={() => {
            if (atlasMode) {
              closeAtlas();
              return;
            }
            if (currentExplorationCell && explorationState) {
              focusExploration(explorationState, {
                mode: "preserve",
                scale,
              });
            } else {
              setCamera(INITIAL_CAMERA);
              setScale(INITIAL_SCALE);
            }
          }}
        >
          <LocateFixed />
        </button>
        <button
          type="button"
          className={atlasMode ? "active" : ""}
          aria-label={
            atlasMode ? "Salir del mapa completo" : "Ver mapa completo"
          }
          title={atlasMode ? "Volver al detalle" : "Mapa completo · tecla 0"}
          onClick={() => toggleDrawer("atlas")}
        >
          <MapIcon />
        </button>
      </div>

      {markMode && (
        <div className="marking-banner glass-card">
          {markMode === "pin" ? (
            <MapPin />
          ) : markMode === "coverage" ? (
            <Grid3X3 />
          ) : markMode === "region" ? (
            <SquareMousePointer />
          ) : (
            <SquareDashedMousePointer />
          )}
          <div>
            <strong>
              {markMode === "pin"
                ? "Haz clic para marcar"
                : markMode === "coverage"
                  ? "Arrastra para seleccionar sectores del Overworld"
                : markMode === "region"
                  ? "Arrastra para delimitar la región"
                  : "Arrastra para delimitar un área"}
            </strong>
            <span>Esc para cancelar</span>
          </div>
          <button
            type="button"
            aria-label="Cancelar marcado"
            onClick={() => {
              pinStartRef.current = null;
              areaStartRef.current = null;
              coverageStartRef.current = null;
              areaPreviewRef.current = undefined;
              setMarkMode(null);
              setAreaPreview(undefined);
              setCoveragePreview(null);
            }}
          >
            <X />
          </button>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </main>
  );
}

function DockButton({
  active,
  badge,
  children,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
      {badge ? <i>{badge}</i> : null}
    </button>
  );
}

function formatProgressPercent(value: number) {
  if (value > 0 && value < 0.1) return "<0.1";
  return new Intl.NumberFormat("es-GT", {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function formatBytes(value: number | null) {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unitIndex = 0;
  let normalized = value;
  while (normalized >= 1024 && unitIndex < units.length - 1) {
    normalized /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat("es-GT", {
    maximumFractionDigits: normalized < 10 && unitIndex > 0 ? 2 : 1,
  }).format(normalized)} ${units[unitIndex]}`;
}

function formatEta(value: number | null | undefined) {
  if (value === undefined) return "—";
  if (value === null) return "Calculando…";
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function Metric({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "mint" | "blue" | "amber";
  value: number;
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>tiles</small>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div>
      <kbd>{keys}</kbd>
      <span>{label}</span>
    </div>
  );
}
