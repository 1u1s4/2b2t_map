"use client";

import {
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
  Gauge,
  Grid3X3,
  HardDrive,
  HelpCircle,
  Layers3,
  Link2,
  ListFilter,
  LockKeyhole,
  LocateFixed,
  MapPin,
  Minus,
  MousePointer2,
  Navigation,
  Plus,
  RotateCcw,
  Search,
  ScanSearch,
  Sparkles,
  SquareDashedMousePointer,
  SquareMousePointer,
  StepBack,
  StepForward,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  blocksPerPixelAtLod,
  blocksPerTileAtLod,
  createLocalTileSource,
  getFileSystemAccessSupport,
  LocalTileSource,
  pickTileArchiveDirectory,
  type TileKey,
  type TileLayer,
} from "./lib/local-tile-source";
import {
  cardinalNeighbor,
  cellForIndex,
  cellIndexAtTile,
  cellIndexAtWorld,
  createExplorationState,
  deserializeExplorationState,
  isCellReviewed,
  moveCurrentCardinal,
  moveCurrentSerpentine,
  serializeExplorationState,
  serpentinePositionForCellIndex,
  withCurrentCellReviewed,
  withCurrentIndex,
  type CardinalDirection,
  type ExplorationState,
  type WorldBounds,
} from "./lib/exploration-grid";
import {
  OVERWORLD_OBSERVED_DATA_BOUNDS,
  OVERWORLD_OVERVIEW_CELL_BLOCKS,
  OVERWORLD_OVERVIEW_CELL_COUNT,
  OVERWORLD_OVERVIEW_GRID_BOUNDS,
  coverageSelectionBetweenCells,
  fitCoverageScale,
  overviewCellAtWorld,
  overviewCellForIndex,
  parseCoverageSelection,
  type OverworldCoverageSelection,
  type OverworldOverviewCell,
} from "./lib/overworld-coverage";
import {
  downloadExplorationCell,
  LocalAtlasWorkspaceConflictError,
  localAtlasWorkspaceContent,
  parseLocalAtlasWorkspaceContent,
  parseLocalAtlasWorkspaceExplorations,
  readLocalAtlasRuntime,
  readLocalAtlasWorkspace,
  stopLocalRegionJob,
  writeLocalAtlasWorkspace,
  type LocalAtlasRuntime,
  type LocalAtlasWorkspaceContent,
  type LocalAtlasWorkspaceExploration,
  type LocalAtlasWorkspacePrecondition,
} from "./lib/local-atlas-runtime";
import {
  type ChangeEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const INITIAL_CAMERA = { x: -85_181, z: 168_232 };
const INITIAL_SCALE = 2.9423;
const MIN_SCALE = 1 / 1_500;
const MAX_SCALE = 8;
const MAX_WORKSPACE_EXPLORATIONS = 128;
const MAX_WORKSPACE_HIGHLIGHTS = 10_000;
const HIGHLIGHT_STORAGE_KEY = "obsidian-atlas-highlights-v1";
const EXPLORATION_STORAGE_KEY = "obsidian-atlas-exploration-v1";
const SAVED_EXPLORATIONS_STORAGE_KEY =
  "obsidian-atlas-saved-explorations-v1";
const LEGACY_WORKSPACE_RECOVERY_STORAGE_KEY =
  "obsidian-atlas-workspace-recovery-v1";
const WORKSPACE_RECOVERY_STORAGE_PREFIX =
  "obsidian-atlas-workspace-recovery-v1:";
const WORKSPACE_TAB_ID_SESSION_KEY = "obsidian-atlas-workspace-tab-id-v1";
const COVERAGE_SELECTION_STORAGE_KEY =
  "obsidian-atlas-overworld-selection-v1";
const COLORS = ["#ff5f57", "#ffbd4a", "#26d9c7", "#62a8ff", "#c58cff"];

type Drawer = "layers" | "exploration" | "highlights" | "help" | null;
type MarkMode = "pin" | "area" | "region" | "coverage" | null;

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

type TileRecord = {
  status: "loading" | "loaded" | "missing" | "error";
  bitmap?: ImageBitmap;
  source?: "local" | "remote";
};

type TileStats = {
  local: number;
  remote: number;
  missing: number;
};

type PersistenceState =
  | "checking"
  | "saving"
  | "saved"
  | "readonly"
  | "offline"
  | "conflict"
  | "error";

type ActivePointer = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

type BrowserWorkspaceRecovery = {
  readonly version: 1;
  readonly dirty: true;
  readonly updatedAt: string;
  readonly base: LocalAtlasWorkspacePrecondition | null;
  readonly content: LocalAtlasWorkspaceContent;
  readonly storageKey: string;
};

let browserWorkspaceTabId: string | null = null;
const activeBrowserWorkspaceBranches = new Set<string>();

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
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

function currentBrowserWorkspaceTabIdentifier() {
  if (!browserWorkspaceTabId) {
    try {
      browserWorkspaceTabId =
        window.sessionStorage.getItem(WORKSPACE_TAB_ID_SESSION_KEY);
      if (!browserWorkspaceTabId) {
        browserWorkspaceTabId = crypto.randomUUID();
        window.sessionStorage.setItem(
          WORKSPACE_TAB_ID_SESSION_KEY,
          browserWorkspaceTabId,
        );
      }
    } catch {
      browserWorkspaceTabId = crypto.randomUUID();
    }
  }
  return browserWorkspaceTabId;
}

function currentBrowserWorkspaceRecoveryKey() {
  return `${WORKSPACE_RECOVERY_STORAGE_PREFIX}${currentBrowserWorkspaceTabIdentifier()}`;
}

function rotateBrowserWorkspaceRecoveryBranch() {
  const previous = readRecoveryAtKey(currentBrowserWorkspaceRecoveryKey());
  browserWorkspaceTabId = crypto.randomUUID();
  try {
    window.sessionStorage.setItem(
      WORKSPACE_TAB_ID_SESSION_KEY,
      browserWorkspaceTabId,
    );
  } catch {
    // The in-memory branch id still separates this page instance.
  }
  if (previous) {
    writeBrowserWorkspaceRecovery(previous.content, previous.base);
  }
  return browserWorkspaceTabId;
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

function readBrowserWorkspaceRecovery(options?: {
  includeOtherBranches?: boolean;
}): BrowserWorkspaceRecovery | null {
  const own = readRecoveryAtKey(currentBrowserWorkspaceRecoveryKey());
  if (own || !options?.includeOtherBranches) return own;
  const candidates: BrowserWorkspaceRecovery[] = [];
  const legacy = readRecoveryAtKey(LEGACY_WORKSPACE_RECOVERY_STORAGE_KEY);
  if (legacy) candidates.push(legacy);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (
        !storageKey ||
        !storageKey.startsWith(WORKSPACE_RECOVERY_STORAGE_PREFIX)
      ) {
        continue;
      }
      const branchId = storageKey.slice(
        WORKSPACE_RECOVERY_STORAGE_PREFIX.length,
      );
      if (
        branchId !== currentBrowserWorkspaceTabIdentifier() &&
        activeBrowserWorkspaceBranches.has(branchId)
      ) {
        continue;
      }
      const recovery = readRecoveryAtKey(storageKey);
      if (recovery) candidates.push(recovery);
    }
  } catch {
    // A current-tab branch is still sufficient when storage enumeration fails.
  }
  return (
    candidates.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ?? null
  );
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
      currentBrowserWorkspaceRecoveryKey(),
      JSON.stringify(recovery),
    );
    return true;
  } catch {
    return false;
  }
}

function clearBrowserWorkspaceRecovery(
  expectedContent?: LocalAtlasWorkspaceContent,
) {
  try {
    const ownKey = currentBrowserWorkspaceRecoveryKey();
    if (!expectedContent) {
      window.localStorage.removeItem(ownKey);
      return;
    }
    const expectedSignature = JSON.stringify(expectedContent);
    const candidateKeys = new Set<string>([
      ownKey,
      LEGACY_WORKSPACE_RECOVERY_STORAGE_KEY,
    ]);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (storageKey?.startsWith(WORKSPACE_RECOVERY_STORAGE_PREFIX)) {
        candidateKeys.add(storageKey);
      }
    }
    for (const storageKey of candidateKeys) {
      const branchId = storageKey.startsWith(
        WORKSPACE_RECOVERY_STORAGE_PREFIX,
      )
        ? storageKey.slice(WORKSPACE_RECOVERY_STORAGE_PREFIX.length)
        : null;
      if (
        storageKey !== ownKey &&
        branchId &&
        activeBrowserWorkspaceBranches.has(branchId)
      ) {
        continue;
      }
      const recovery = readRecoveryAtKey(storageKey);
      if (
        recovery &&
        JSON.stringify(recovery.content) === expectedSignature
      ) {
        window.localStorage.removeItem(storageKey);
      }
    }
  } catch {
    // The canonical disk workspace remains safe if browser cleanup is blocked.
  }
}

function formatCoordinate(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function lodForScale(scale: number) {
  return clamp(Math.floor(Math.log2(1 / scale)), 0, 10);
}

function adaptiveGridStep(scale: number) {
  const targetBlocks = 150 / scale;
  return 2 ** clamp(Math.round(Math.log2(targetBlocks)), 4, 20);
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

function remoteTileUrl(key: TileKey, online: boolean) {
  const params = new URLSearchParams({
    layer: key.layer,
    lod: String(key.lod),
    dimension: "0",
    tileX: String(key.tileX),
    tileZ: String(key.tileZ),
    online: online ? "1" : "0",
  });
  return `/api/tile?${params.toString()}`;
}

function highlightLabel(index: number, type: Highlight["type"]) {
  return `${type === "pin" ? "Punto" : "Área"} ${String(index + 1).padStart(2, "0")}`;
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
  const existingIndex = items.findIndex(
    (item) => item.id === state.region.id,
  );
  const existing = existingIndex === -1 ? undefined : items[existingIndex];
  const next = workspaceExplorationFromState(state, existing);
  if (next === existing) return items;
  if (existingIndex === -1) return [...items, next];
  return items.map((item, index) =>
    index === existingIndex ? next : item,
  );
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
  const mapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const explorationImportRef = useRef<HTMLInputElement>(null);
  const fallbackBadgeRef = useRef<HTMLDivElement>(null);
  const fallbackTextRef = useRef<HTMLSpanElement>(null);
  const tileCacheRef = useRef<Map<string, TileRecord>>(new Map());
  const tileGenerationRef = useRef(0);
  const onlineFallbackRef = useRef(false);
  const lastCompletedJobRef = useRef<string | null>(null);
  const pointerRef = useRef<{
    id: number;
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
  const localSourceRef = useRef<LocalTileSource | null>(null);
  const workspaceHydrationTokenRef = useRef<string | null>(null);
  const workspacePreconditionRef =
    useRef<LocalAtlasWorkspacePrecondition | null>(null);
  const workspaceContentRef = useRef<LocalAtlasWorkspaceContent | null>(null);
  const workspaceRuntimeRef = useRef<LocalAtlasRuntime | null>(null);
  const explorationStateRef = useRef<ExplorationState | null>(null);
  const workspaceSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const workspaceConflictRef = useRef(false);
  const workspaceSaveTimerRef = useRef<number | null>(null);
  const lastSavedWorkspaceRef = useRef<string | null>(null);
  const pendingWorkspaceWriteRef = useRef<{
    readonly content: LocalAtlasWorkspaceContent;
    readonly expected: LocalAtlasWorkspacePrecondition;
    readonly signature: string;
    readonly writeId: string;
  } | null>(null);

  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [viewSize, setViewSize] = useState({ width: 1280, height: 760 });
  const [cursor, setCursor] = useState<Camera>(INITIAL_CAMERA);
  const [drawer, setDrawer] = useState<Drawer>(null);
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
  const [onlineFallback, setOnlineFallback] = useState(false);
  const [localSource, setLocalSource] = useState<LocalTileSource | null>(null);
  const [archiveName, setArchiveName] = useState<string | null>(null);
  const [localSupported, setLocalSupported] = useState(false);
  const [tileStats, setTileStats] = useState<TileStats>({
    local: 0,
    remote: 0,
    missing: 0,
  });
  const [renderVersion, setRenderVersion] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(
    null,
  );
  const [highlightsReady, setHighlightsReady] = useState(false);
  const [explorationState, setExplorationState] =
    useState<ExplorationState | null>(null);
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
  const [requestsPerSecond, setRequestsPerSecond] = useState(1);
  const [localRuntime, setLocalRuntime] =
    useState<LocalAtlasRuntime | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [workspaceBranchReady, setWorkspaceBranchReady] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [persistenceState, setPersistenceState] =
    useState<PersistenceState>("checking");
  const [persistenceMessage, setPersistenceMessage] = useState(
    "Comprobando LuisA…",
  );
  const [toast, setToast] = useState<string | null>(null);

  const lod = lodForScale(scale);
  const blocksPerPixel = blocksPerPixelAtLod(lod);
  const gridStep = adaptiveGridStep(scale);
  const selectedHighlight = highlights.find(
    (highlight) => highlight.id === selectedHighlightId,
  );
  const currentExplorationCell = explorationState
    ? cellForIndex(
        explorationState.region,
        explorationState.currentIndex,
      )
    : null;
  const explorationPercent = explorationState
    ? (explorationState.reviewedCount / explorationState.region.cellCount) * 100
    : 0;
  const visibleCoverageSelection = coveragePreview ?? coverageSelection;
  const coverageSummary = useMemo(() => {
    let full = 0;
    let partial = 0;
    let availableTiles = 0;
    for (let index = 0; index < OVERWORLD_OVERVIEW_CELL_COUNT; index += 1) {
      const cell = overviewCellForIndex(index);
      availableTiles += cell.availableTileCount;
      if (cell.coverageStatus === "full") full += 1;
      if (cell.coverageStatus === "partial") partial += 1;
    }
    return {
      full,
      partial,
      available: full + partial,
      empty: OVERWORLD_OVERVIEW_CELL_COUNT - full - partial,
      availableTiles,
    };
  }, []);
  const workspaceContent = useMemo<LocalAtlasWorkspaceContent>(
    () => ({
      schemaVersion: 1,
      activeExplorationId: explorationState?.region.id ?? null,
      explorations: savedExplorations,
      highlights,
      coverageSelection,
    }),
    [
      coverageSelection,
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
  const runtimeMutationToken = localRuntime?.mutationToken ?? null;
  const runtimePersistenceConfigured =
    localRuntime?.persistence.configured ?? false;
  const runtimePersistenceWritable =
    localRuntime?.persistence.writable ?? false;
  const workspaceMutationsBlocked =
    !runtimeChecked ||
    !workspaceBranchReady ||
    pauseBusy ||
    (runtimePersistenceConfigured && !workspaceReady);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1_700);
  }, []);

  useEffect(() => {
    const pageInstanceId = crypto.randomUUID();
    let branchId = currentBrowserWorkspaceTabIdentifier();
    let channel: BroadcastChannel | null = null;
    const readyTimer = window.setTimeout(
      () => setWorkspaceBranchReady(true),
      150,
    );
    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel("obsidian-atlas-workspace-branches-v1");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (
          typeof event.data !== "object" ||
          event.data === null ||
          Array.isArray(event.data)
        ) {
          return;
        }
        const message = event.data as Record<string, unknown>;
        if (
          typeof message.pageInstanceId !== "string" ||
          message.pageInstanceId === pageInstanceId
        ) {
          return;
        }
        if (message.type === "branch-query") {
          channel?.postMessage({
            type: "branch-presence",
            branchId,
            pageInstanceId,
          });
          return;
        }
        if (typeof message.branchId !== "string") return;
        if (message.type === "branch-release") {
          activeBrowserWorkspaceBranches.delete(message.branchId);
          return;
        }
        if (message.type === "branch-presence") {
          activeBrowserWorkspaceBranches.add(message.branchId);
          return;
        }
        if (message.type !== "branch-claim") return;
        activeBrowserWorkspaceBranches.add(message.branchId);
        if (message.branchId !== branchId) return;
        if (pageInstanceId > message.pageInstanceId) {
          branchId = rotateBrowserWorkspaceRecoveryBranch();
          channel?.postMessage({
            type: "branch-claim",
            branchId,
            pageInstanceId,
          });
        } else {
          channel?.postMessage({
            type: "branch-claim",
            branchId,
            pageInstanceId,
          });
        }
      };
      channel.postMessage({
        type: "branch-claim",
        branchId,
        pageInstanceId,
      });
      channel.postMessage({
        type: "branch-query",
        pageInstanceId,
      });
    }
    return () => {
      window.clearTimeout(readyTimer);
      channel?.postMessage({
        type: "branch-release",
        branchId,
        pageInstanceId,
      });
      channel?.close();
    };
  }, []);

  const clearTileCache = useCallback(() => {
    tileGenerationRef.current += 1;
    for (const record of tileCacheRef.current.values()) {
      record.bitmap?.close();
    }
    tileCacheRef.current.clear();
    setTileStats({ local: 0, remote: 0, missing: 0 });
    setRenderVersion((version) => version + 1);
  }, []);

  const focusExploration = useCallback((state: ExplorationState) => {
    const cell = cellForIndex(state.region, state.currentIndex);
    setCamera({
      x: (cell.bounds.minX + cell.bounds.maxXExclusive) / 2,
      z: (cell.bounds.minZ + cell.bounds.maxZExclusive) / 2,
    });
    setScale(state.region.scale);
  }, []);

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
      const next = withCurrentIndex(explorationState, index);
      setExplorationState(next);
      focusExploration(next);
      return true;
    },
    [explorationState, focusExploration, notify],
  );

  const archiveExploration = useCallback((state: ExplorationState) => {
    setSavedExplorations((items) =>
      upsertWorkspaceExploration(items, state),
    );
  }, []);

  useEffect(() => {
    workspaceContentRef.current = workspaceContent;
  }, [workspaceContent]);

  useEffect(() => {
    workspaceRuntimeRef.current = localRuntime;
  }, [localRuntime]);

  useEffect(() => {
    explorationStateRef.current = explorationState;
  }, [explorationState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setLocalSupported(getFileSystemAccessSupport().supported);
      try {
        const stored = window.localStorage.getItem(HIGHLIGHT_STORAGE_KEY);
        if (stored) {
          const parsed = readHighlightList(JSON.parse(stored), {
            discardInvalid: true,
          });
          if (parsed) {
            setHighlights(parsed);
          }
        }
      } catch {
        // A malformed local preference should never block the map.
      }
      setHighlightsReady(true);

      try {
        const stored = window.localStorage.getItem(
          COVERAGE_SELECTION_STORAGE_KEY,
        );
        if (stored) {
          const parsed = parseCoverageSelection(JSON.parse(stored) as unknown);
          if (parsed) setCoverageSelection(parsed);
        }
      } catch {
        // The disk-backed workspace can repair a malformed browser cache.
      }
      setCoverageSelectionReady(true);

      try {
        const stored = window.localStorage.getItem(
          SAVED_EXPLORATIONS_STORAGE_KEY,
        );
        if (stored) {
          const parsed = parseLocalAtlasWorkspaceExplorations(
            JSON.parse(stored) as unknown,
          );
          if (parsed) setSavedExplorations(parsed);
        }
      } catch {
        // A malformed recovery cache must never block disk hydration.
      }

      let restoredExploration: ExplorationState | null = null;
      try {
        const stored = window.localStorage.getItem(EXPLORATION_STORAGE_KEY);
        if (stored) {
          restoredExploration = deserializeExplorationState(stored);
          setExplorationState(restoredExploration);
        }
      } catch {
        // Invalid or obsolete sessions are ignored instead of blocking the map.
      }
      setExplorationReady(true);

      if (restoredExploration) {
        const cell = cellForIndex(
          restoredExploration.region,
          restoredExploration.currentIndex,
        );
        setCamera({
          x: (cell.bounds.minX + cell.bounds.maxXExclusive) / 2,
          z: (cell.bounds.minZ + cell.bounds.maxZExclusive) / 2,
        });
        setScale(restoredExploration.region.scale);
      } else {
        const location = parseLocation(window.location.hash, []);
        if (location) {
          setCamera({ x: location.x, z: location.z });
          if (location.scale) setScale(location.scale);
        }
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!highlightsReady) return;
    try {
      window.localStorage.setItem(
        HIGHLIGHT_STORAGE_KEY,
        JSON.stringify(highlights),
      );
    } catch {
      const timeout = window.setTimeout(
        () => notify("No se pudieron guardar los highlights en este navegador"),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [highlights, highlightsReady, notify]);

  useEffect(() => {
    if (!explorationReady) return;
    try {
      if (explorationState) {
        window.localStorage.setItem(
          EXPLORATION_STORAGE_KEY,
          serializeExplorationState(explorationState),
        );
      } else {
        window.localStorage.removeItem(EXPLORATION_STORAGE_KEY);
      }
    } catch {
      const timeout = window.setTimeout(
        () => notify("No se pudo guardar la sesión de exploración"),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [explorationReady, explorationState, notify]);

  useEffect(() => {
    if (!explorationReady) return;
    try {
      window.localStorage.setItem(
        SAVED_EXPLORATIONS_STORAGE_KEY,
        JSON.stringify(savedExplorations),
      );
    } catch {
      const timeout = window.setTimeout(
        () =>
          notify(
            "No se pudo guardar la lista de sesiones en este navegador",
          ),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [explorationReady, notify, savedExplorations]);

  useEffect(() => {
    if (!explorationReady || !explorationState) return;
    const frame = window.requestAnimationFrame(() => {
      setSavedExplorations((items) =>
        upsertWorkspaceExploration(items, explorationState),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [explorationReady, explorationState]);

  useEffect(() => {
    if (!coverageSelectionReady) return;
    try {
      if (coverageSelection) {
        window.localStorage.setItem(
          COVERAGE_SELECTION_STORAGE_KEY,
          JSON.stringify(coverageSelection),
        );
      } else {
        window.localStorage.removeItem(COVERAGE_SELECTION_STORAGE_KEY);
      }
    } catch {
      const timeout = window.setTimeout(
        () => notify("No se pudo guardar la selección global en el navegador"),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [coverageSelection, coverageSelectionReady, notify]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.history.replaceState(null, "", locationHash(camera, scale));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [camera, scale]);

  useEffect(() => {
    const onHashChange = () => {
      const location = parseLocation(window.location.hash, []);
      if (!location) return;
      if (explorationState) {
        const index = cellIndexAtWorld(
          explorationState.region,
          location.x,
          location.z,
        );
        if (index === null) return;
        const next = withCurrentIndex(explorationState, index);
        setExplorationState(next);
        focusExploration(next);
        return;
      }
      setCamera({ x: location.x, z: location.z });
      if (location.scale) setScale(location.scale);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [explorationState, focusExploration]);

  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewSize({
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
        if (
          runtime?.job?.status === "complete" &&
          lastCompletedJobRef.current !== runtime.job.id
        ) {
          lastCompletedJobRef.current = runtime.job.id;
          clearTileCache();
          notify("La celda ya está disponible localmente");
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

  const flushWorkspace = useCallback(async (): Promise<boolean> => {
    const inFlight = workspaceSavePromiseRef.current;
    if (inFlight) return inFlight;

    const task = (async (): Promise<boolean> => {
      while (true) {
        const runtime = workspaceRuntimeRef.current;
        const latestContent = workspaceContentRef.current;
        if (!runtime?.persistence.configured || !latestContent) {
          setPersistenceState("offline");
          setPersistenceMessage("Sin guardar en LuisA · copia local activa");
          return false;
        }
        if (!runtime.persistence.writable) {
          setPersistenceState("readonly");
          setPersistenceMessage("LuisA está en solo lectura · copia local activa");
          return false;
        }
        if (workspaceConflictRef.current) {
          setPersistenceState("conflict");
          setPersistenceMessage(
            "Conflicto pendiente · recarga LuisA antes de volver a guardar",
          );
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
            clearBrowserWorkspaceRecovery(
              localAtlasWorkspaceContent(saved),
            );
          }
          workspaceConflictRef.current = false;
          setPersistenceState("saved");
          setPersistenceMessage(
            `Guardado en LuisA · ${new Date(saved.updatedAt ?? Date.now()).toLocaleTimeString("es-GT", {
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          );
        } catch (error) {
          if (error instanceof LocalAtlasWorkspaceConflictError) {
            writeBrowserWorkspaceRecovery(
              workspaceContentRef.current ?? pending.content,
              pending.expected,
            );
            pendingWorkspaceWriteRef.current = null;
            workspacePreconditionRef.current = null;
            lastSavedWorkspaceRef.current = null;
            workspaceConflictRef.current = true;
            setPersistenceState("conflict");
            setPersistenceMessage(
              "Conflicto con otra pestaña · no se sobrescribió ningún dato",
            );
          } else {
            setPersistenceState("error");
            setPersistenceMessage(
              error instanceof Error
                ? error.message
                : "No se pudo guardar en LuisA",
            );
          }
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
  }, []);

  useEffect(() => {
    if (
      !highlightsReady ||
      !explorationReady ||
      !coverageSelectionReady ||
      !workspaceBranchReady
    ) {
      return;
    }
    if (!runtimePersistenceConfigured || !runtimeMutationToken) {
      if (
        runtimeChecked &&
        lastSavedWorkspaceRef.current === null &&
        workspaceContentRef.current
      ) {
        lastSavedWorkspaceRef.current = JSON.stringify(
          workspaceContentRef.current,
        );
      }
      const timeout = window.setTimeout(() => {
        setPersistenceState("offline");
        setPersistenceMessage("Sin LuisA · guardando copia en el navegador");
        if (runtimeChecked) setWorkspaceReady(true);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    if (
      workspaceHydrationTokenRef.current === runtimeMutationToken
    ) {
      const timeout = window.setTimeout(() => {
        if (!runtimePersistenceWritable) {
          setPersistenceState("readonly");
          setPersistenceMessage(
            "LuisA está en solo lectura · copia local activa",
          );
        } else if (workspaceConflictRef.current) {
          setPersistenceState("conflict");
          setPersistenceMessage(
            "Conflicto pendiente · recarga LuisA antes de volver a guardar",
          );
        } else {
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
      const hydrationStartSignature = JSON.stringify(
        workspaceContentRef.current,
      );
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
        workspaceConflictRef.current = false;

        const contentAfterRead = workspaceContentRef.current;
        if (
          contentAfterRead &&
          JSON.stringify(contentAfterRead) !== hydrationStartSignature
        ) {
          writeBrowserWorkspaceRecovery(contentAfterRead, null);
        }
        let browserRecovery = readBrowserWorkspaceRecovery({
          includeOtherBranches: true,
        });
        if (
          browserRecovery &&
          browserRecovery.storageKey !== currentBrowserWorkspaceRecoveryKey() &&
          writeBrowserWorkspaceRecovery(
            browserRecovery.content,
            browserRecovery.base,
          )
        ) {
          browserRecovery =
            readBrowserWorkspaceRecovery() ?? browserRecovery;
        }
        if (browserRecovery) {
          const diskContent = localAtlasWorkspaceContent(diskWorkspace);
          const recoveryMatchesDisk =
            JSON.stringify(browserRecovery.content) ===
            JSON.stringify(diskContent);
          const baseMatchesDisk =
            browserRecovery.base?.workspaceId === diskWorkspace.workspaceId &&
            browserRecovery.base.revision === diskWorkspace.revision;
          const diskIsEmpty =
            diskWorkspace.revision === 0 &&
            diskWorkspace.explorations.length === 0 &&
            diskWorkspace.highlights.length === 0 &&
            diskWorkspace.coverageSelection === null;

          if (recoveryMatchesDisk) {
            clearBrowserWorkspaceRecovery(browserRecovery.content);
          } else if (
            runtime.persistence.writable &&
            (baseMatchesDisk || diskIsEmpty)
          ) {
            diskWorkspace = await writeLocalAtlasWorkspace(
              runtime,
              browserRecovery.content,
              {
                workspaceId: diskWorkspace.workspaceId,
                revision: diskWorkspace.revision,
              },
            );
            clearBrowserWorkspaceRecovery(browserRecovery.content);
          } else {
            const recoveredHighlights = readHighlightList(
              browserRecovery.content.highlights,
              { discardInvalid: false },
            );
            if (!recoveredHighlights) {
              throw new Error("La copia de recuperación no es válida");
            }
            const recoveredActive = browserRecovery.content.activeExplorationId
              ? browserRecovery.content.explorations.find(
                  (item) =>
                    item.id ===
                    browserRecovery.content.activeExplorationId,
                )
              : undefined;
            const recoveredExploration = recoveredActive
              ? explorationStateFromWorkspace(recoveredActive)
              : null;
            workspacePreconditionRef.current = baseMatchesDisk
              ? {
                  workspaceId: diskWorkspace.workspaceId,
                  revision: diskWorkspace.revision,
                }
              : null;
            lastSavedWorkspaceRef.current = JSON.stringify(diskContent);
            workspaceContentRef.current = browserRecovery.content;
            setSavedExplorations([
              ...browserRecovery.content.explorations,
            ]);
            setHighlights(recoveredHighlights);
            setCoverageSelection(browserRecovery.content.coverageSelection);
            setExplorationState(recoveredExploration);
            if (recoveredExploration) focusExploration(recoveredExploration);
            setWorkspaceReady(true);
            if (!runtime.persistence.writable && baseMatchesDisk) {
              setPersistenceState("readonly");
              setPersistenceMessage(
                "Cambios locales conservados · LuisA está en solo lectura",
              );
            } else {
              workspaceConflictRef.current = true;
              setPersistenceState("conflict");
              setPersistenceMessage(
                "Cambios locales en conflicto · elige qué versión conservar",
              );
            }
            hydrationCompleted = true;
            return;
          }
        }

        if (
          diskWorkspace.revision === 0 &&
          diskWorkspace.explorations.length === 0 &&
          diskWorkspace.highlights.length === 0 &&
          diskWorkspace.coverageSelection === null
        ) {
          const cached = workspaceContentRef.current;
          if (!cached) {
            throw new Error("El workspace local todavía no está listo");
          }
          const explorations = [...cached.explorations];
          const cachedExploration = explorationStateRef.current;
          if (
            cachedExploration &&
            !explorations.some(
              (item) => item.id === cachedExploration.region.id,
            )
          ) {
            explorations.push(
              workspaceExplorationFromState(cachedExploration),
            );
          }
          const legacyContent: LocalAtlasWorkspaceContent = {
            ...cached,
            activeExplorationId: cachedExploration?.region.id ?? null,
            explorations,
          };
          const hasLegacyData =
            legacyContent.explorations.length > 0 ||
            legacyContent.highlights.length > 0 ||
            legacyContent.coverageSelection !== null;
          const migrated = hasLegacyData && runtime.persistence.writable
            ? await writeLocalAtlasWorkspace(
                runtime,
                legacyContent,
                {
                  workspaceId: diskWorkspace.workspaceId,
                  revision: diskWorkspace.revision,
                },
              )
            : diskWorkspace;
          if (cancelled) return;
          workspacePreconditionRef.current = {
            workspaceId: migrated.workspaceId,
            revision: migrated.revision,
          };
          lastSavedWorkspaceRef.current = JSON.stringify(
            localAtlasWorkspaceContent(migrated),
          );
          if (hasLegacyData && runtime.persistence.writable) {
            clearBrowserWorkspaceRecovery(legacyContent);
          }
          setSavedExplorations([...legacyContent.explorations]);
          setWorkspaceReady(true);
          if (runtime.persistence.writable) {
            setPersistenceState("saved");
            setPersistenceMessage(
              hasLegacyData
                ? "Datos del navegador migrados a LuisA"
                : "Workspace de LuisA listo",
            );
          } else {
            setPersistenceState("readonly");
            setPersistenceMessage(
              hasLegacyData
                ? "LuisA en solo lectura · copia local conservada"
                : "LuisA está en solo lectura",
            );
          }
          hydrationCompleted = true;
          return;
        }

        const restoredHighlights = readHighlightList(
          diskWorkspace.highlights,
          { discardInvalid: false },
        );
        if (!restoredHighlights) {
          throw new Error("Los highlights de LuisA no son válidos");
        }
        const activeExploration = diskWorkspace.activeExplorationId
          ? diskWorkspace.explorations.find(
              (item) => item.id === diskWorkspace.activeExplorationId,
            )
          : undefined;
        const restoredExploration = activeExploration
          ? explorationStateFromWorkspace(activeExploration)
          : null;

        workspacePreconditionRef.current = {
          workspaceId: diskWorkspace.workspaceId,
          revision: diskWorkspace.revision,
        };
        lastSavedWorkspaceRef.current = JSON.stringify(
          localAtlasWorkspaceContent(diskWorkspace),
        );
        setSavedExplorations([...diskWorkspace.explorations]);
        setHighlights(restoredHighlights);
        setCoverageSelection(diskWorkspace.coverageSelection);
        setExplorationState(restoredExploration);
        if (restoredExploration) focusExploration(restoredExploration);
        setWorkspaceReady(true);
        if (runtime.persistence.writable) {
          setPersistenceState("saved");
          setPersistenceMessage(
            diskWorkspace.updatedAt
              ? `Restaurado desde LuisA · rev. ${diskWorkspace.revision}`
              : "Workspace de LuisA listo",
          );
        } else {
          setPersistenceState("readonly");
          setPersistenceMessage("Restaurado desde LuisA · solo lectura");
        }
        hydrationCompleted = true;
      } catch (error) {
        if (cancelled) return;
        if (error instanceof LocalAtlasWorkspaceConflictError) {
          const recovery = readBrowserWorkspaceRecovery({
            includeOtherBranches: true,
          });
          if (recovery) {
            const recoveredHighlights = readHighlightList(
              recovery.content.highlights,
              { discardInvalid: false },
            );
            if (recoveredHighlights) {
              const recoveredActive = recovery.content.activeExplorationId
                ? recovery.content.explorations.find(
                    (item) =>
                      item.id === recovery.content.activeExplorationId,
                  )
                : undefined;
              const recoveredExploration = recoveredActive
                ? explorationStateFromWorkspace(recoveredActive)
                : null;
              pendingWorkspaceWriteRef.current = null;
              workspacePreconditionRef.current = null;
              lastSavedWorkspaceRef.current = error.current
                ? JSON.stringify(localAtlasWorkspaceContent(error.current))
                : null;
              workspaceContentRef.current = recovery.content;
              workspaceConflictRef.current = true;
              setSavedExplorations([...recovery.content.explorations]);
              setHighlights(recoveredHighlights);
              setCoverageSelection(recovery.content.coverageSelection);
              setExplorationState(recoveredExploration);
              if (recoveredExploration) {
                focusExploration(recoveredExploration);
              }
              setWorkspaceReady(true);
              setPersistenceState("conflict");
              setPersistenceMessage(
                "LuisA cambió durante la recuperación · tu copia local sigue intacta",
              );
              hydrationCompleted = true;
              return;
            }
          }
        }
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
    focusExploration,
    flushWorkspace,
    highlightsReady,
    runtimeMutationToken,
    runtimePersistenceConfigured,
    runtimePersistenceWritable,
    runtimeChecked,
    workspaceBranchReady,
  ]);

  useEffect(() => {
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
      workspaceConflictRef.current ||
      JSON.stringify(workspaceContent) === lastSavedWorkspaceRef.current
    ) {
      return;
    }
    if (workspaceSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveTimerRef.current);
    }
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      workspaceSaveTimerRef.current = null;
      void flushWorkspace();
    }, 650);
    return () => {
      if (workspaceSaveTimerRef.current !== null) {
        window.clearTimeout(workspaceSaveTimerRef.current);
        workspaceSaveTimerRef.current = null;
      }
    };
  }, [
    flushWorkspace,
    runtimePersistenceConfigured,
    runtimePersistenceWritable,
    workspaceContent,
    workspaceReady,
  ]);

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
          setTileStats((stats) => ({
            ...stats,
            [record.source!]: stats[record.source!] + 1,
          }));
        } else if (record.status === "missing") {
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

          if (!source || onlineFallbackRef.current) {
            const response = await fetch(
              remoteTileUrl(key, onlineFallbackRef.current),
            );
            if (response.ok) {
              const bitmap = await createImageBitmap(await response.blob());
              finish({
                status: "loaded",
                bitmap,
                source:
                  response.headers.get("X-Atlas-Tile-Source") === "local"
                    ? "local"
                    : "remote",
              });
              return;
            }
            if (response.status === 404) {
              finish({ status: "missing" });
              return;
            }
          }
          finish({ status: "missing" });
        } catch {
          finish({ status: "error" });
        }
      })();
    },
    [],
  );

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
          ensureTile(key);
          const record = tileCacheRef.current.get(tileCacheKey(key));
          const worldOriginX = tileX * tileSpan;
          const worldOriginZ = tileZ * tileSpan;
          const destination = screenAtWorld(worldOriginX, worldOriginZ);
          const destinationSize = tileSpan * scale;

          if (record?.status === "loaded" && record.bitmap) {
            try {
              context.drawImage(
                record.bitmap,
                destination.x,
                destination.y,
                destinationSize + 0.5,
                destinationSize + 0.5,
              );
              continue;
            } catch {
              record.bitmap.close();
              tileCacheRef.current.delete(tileCacheKey(key));
              ensureTile(key);
            }
          }

          let mayRequestAncestor =
            record?.status === "missing" || record?.status === "error";
          let requestedAncestor = false;
          for (let fallbackLod = lod + 1; fallbackLod <= 10; fallbackLod += 1) {
            const lodDelta = fallbackLod - lod;
            const subdivision = 2 ** lodDelta;
            const parentTileX = Math.floor(tileX / subdivision);
            const parentTileZ = Math.floor(tileZ / subdivision);
            const parentKey: TileKey = {
              ...key,
              lod: fallbackLod,
              tileX: parentTileX,
              tileZ: parentTileZ,
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

            const childX = tileX - parentTileX * subdivision;
            const childZ = tileZ - parentTileZ * subdivision;
            const sourceSize = 512 / subdivision;
            try {
              context.drawImage(
                parent.bitmap,
                childX * sourceSize,
                childZ * sourceSize,
                sourceSize,
                sourceSize,
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
            deepestFallbackLod =
              deepestFallbackLod === null
                ? fallbackLod
                : Math.max(deepestFallbackLod, fallbackLod);
            break;
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

    if (showCoverageGrid && !explorationState) {
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

        context.globalAlpha = 1;
        context.fillStyle = selected
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
        context.lineWidth = selected ? 2.5 : 1;
        context.strokeStyle = selected
          ? "rgba(133, 196, 255, 0.98)"
          : cell.coverageStatus === "full"
            ? "rgba(94, 242, 219, 0.36)"
            : cell.coverageStatus === "partial"
              ? "rgba(255, 196, 87, 0.58)"
              : "rgba(164, 178, 195, 0.16)";
        context.setLineDash(
          selected || cell.coverageStatus === "full" ? [] : [4, 4],
        );
        context.strokeRect(
          point.x + 0.5,
          point.y + 0.5,
          overviewCellSize - 1,
          overviewCellSize - 1,
        );
        context.setLineDash([]);

        if (overviewCellSize >= 72 && cell.coverageStatus !== "empty") {
          context.font = "600 10px var(--font-geist-mono), monospace";
          context.fillStyle = selected
            ? "rgba(225, 242, 255, 0.98)"
            : "rgba(225, 236, 246, 0.78)";
          context.fillText(
            `${cell.id} · ${cell.availableTileCount}/64`,
            point.x + 8,
            point.y + 17,
          );
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

    if (explorationState) {
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
          context.globalAlpha = 1;
          context.fillStyle = current
            ? "rgba(98, 168, 255, 0.20)"
            : reviewed
              ? "rgba(38, 217, 199, 0.12)"
              : "rgba(4, 11, 20, 0.05)";
          context.fillRect(point.x, point.y, cellSize, cellSize);
          context.lineWidth = current ? 3 : reviewed ? 1.5 : 1;
          context.strokeStyle = current
            ? "rgba(133, 196, 255, 0.95)"
            : reviewed
              ? "rgba(38, 217, 199, 0.68)"
              : "rgba(255, 255, 255, 0.24)";
          context.setLineDash(current ? [] : reviewed ? [] : [7, 6]);
          context.strokeRect(
            point.x + 0.5,
            point.y + 0.5,
            cellSize - 1,
            cellSize - 1,
          );
          context.setLineDash([]);
          if (cellSize >= 94) {
            const cell = cellForIndex(region, index);
            context.fillStyle = current
              ? "rgba(224, 242, 255, 0.98)"
              : reviewed
                ? "rgba(180, 255, 245, 0.88)"
                : "rgba(232, 240, 248, 0.72)";
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

    for (const highlight of highlights) {
      if (!highlight.visible) continue;
      const selected = highlight.id === selectedHighlightId;
      context.strokeStyle = highlight.color;
      context.fillStyle = highlight.color;
      context.lineWidth = selected ? 3 : 2;
      context.shadowColor = "rgba(0,0,0,.5)";
      context.shadowBlur = 10;

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
    camera,
    ensureTile,
    explorationState,
    gridStep,
    highlights,
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

  const zoomAt = useCallback(
    (factor: number, screenX = viewSize.width / 2, screenY = viewSize.height / 2) => {
      if (explorationState) return;
      const anchor = worldAtScreen(screenX, screenY);
      const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
      setCamera({
        x: anchor.x - (screenX - viewSize.width / 2) / nextScale,
        z: anchor.z - (screenY - viewSize.height / 2) / nextScale,
      });
      setScale(nextScale);
    },
    [explorationState, scale, viewSize, worldAtScreen],
  );

  const hitHighlight = useCallback(
    (screenX: number, screenY: number) => {
      return [...highlights]
        .reverse()
        .find((highlight) => {
          if (!highlight.visible) return false;
          if (highlight.type === "area" && highlight.bounds) {
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
          return Math.hypot(point.x - screenX, point.y - screenY) <= 18;
        });
    },
    [highlights, screenAtWorld],
  );

  const addPin = useCallback(
    (point: Camera) => {
      if (highlights.length >= MAX_WORKSPACE_HIGHLIGHTS) {
        setMarkMode(null);
        notify("El workspace alcanzó el límite de 10,000 highlights");
        return;
      }
      const id = crypto.randomUUID();
      const highlight: Highlight = {
        id,
        type: "pin",
        title: highlightLabel(highlights.length, "pin"),
        note: "",
        color: COLORS[highlights.length % COLORS.length],
        x: Math.round(point.x),
        z: Math.round(point.z),
        visible: true,
        createdAt: new Date().toISOString(),
      };
      setHighlights((items) => [...items, highlight]);
      setSelectedHighlightId(id);
      setDrawer("highlights");
      setMarkMode(null);
      notify("Punto guardado");
    },
    [highlights.length, notify],
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
        x: Math.round((x1 + x2) / 2),
        z: Math.round((z1 + z2) / 2),
        bounds: { x1, z1, x2, z2 },
        visible: true,
        createdAt: new Date().toISOString(),
      };
      setHighlights((items) => [...items, highlight]);
      setSelectedHighlightId(id);
      setDrawer("highlights");
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      setMarkMode(null);
      notify("Área guardada");
    },
    [highlights.length, notify],
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
            ? `Sector global F${selection.minRow + 1} · C${selection.minColumn + 1}`
            : `Selección global ${selection.rows}×${selection.columns}`,
        minX: String(selection.bounds.minX),
        minZ: String(selection.bounds.minZ),
        maxXExclusive: String(selection.bounds.maxXExclusive),
        maxZExclusive: String(selection.bounds.maxZExclusive),
      }));
    },
    [],
  );

  const commitCoverageSelection = useCallback(
    (selection: OverworldCoverageSelection) => {
      setCoverageSelection(selection);
      setCoveragePreview(null);
      applyCoverageSelectionToRegion(selection);
      setDrawer("exploration");
      notify(
        `${selection.availableCellCount.toLocaleString("es-GT")} sectores con datos seleccionados`,
      );
    },
    [applyCoverageSelectionToRegion, notify],
  );

  const viewFullCoverage = useCallback(() => {
    const bounds = OVERWORLD_OVERVIEW_GRID_BOUNDS;
    setCamera({
      x: (bounds.minX + bounds.maxXExclusive) / 2,
      z: (bounds.minZ + bounds.maxZExclusive) / 2,
    });
    setScale(fitCoverageScale(viewSize.width, viewSize.height, 68));
    setShowCoverageGrid(true);
    setDrawer("exploration");
    setMarkMode("coverage");
    notify("Arrastra sobre la rejilla para elegir una región");
  }, [notify, viewSize]);

  const openCoverageSelection = useCallback(
    (maximumDetail = false) => {
      if (!coverageSelection) return;
      const bounds = coverageSelection.bounds;
      const nextScale = maximumDetail
        ? INITIAL_SCALE
        : clamp(
            Math.min(
              (viewSize.width - 144) /
                (bounds.maxXExclusive - bounds.minX),
              (viewSize.height - 144) /
                (bounds.maxZExclusive - bounds.minZ),
            ),
            MIN_SCALE,
            MAX_SCALE,
          );
      setCamera({
        x: (bounds.minX + bounds.maxXExclusive) / 2,
        z: (bounds.minZ + bounds.maxZExclusive) / 2,
      });
      setScale(nextScale);
      setMarkMode(null);
      applyCoverageSelectionToRegion(coverageSelection);
      notify(
        maximumDetail
          ? "Detalle máximo listo · LOD 0"
          : "Región abierta; ajusta el zoom o inicia la exploración",
      );
    },
    [applyCoverageSelectionToRegion, coverageSelection, notify, viewSize],
  );

  const beginMarkMode = useCallback((mode: Exclude<MarkMode, null>) => {
    setMarkMode(mode);
    areaPreviewRef.current = undefined;
    setAreaPreview(undefined);
    areaStartRef.current = null;
    coverageStartRef.current = null;
    setCoveragePreview(null);
    pinStartRef.current = null;
    if (window.matchMedia("(max-width: 720px)").matches) {
      setDrawer(null);
    }
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
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

    if (explorationState) {
      const hit = hitHighlight(screenX, screenY);
      pointerRef.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        camera,
        moved: false,
        hitId: hit?.id ?? null,
      };
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
    pointerRef.current = {
      id: event.pointerId,
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
    const world = worldAtScreen(screenX, screenY);
    setCursor(world);

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
      if (explorationState) return;
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
        MIN_SCALE,
        MAX_SCALE,
      );
      setCamera({
        x:
          pinchRef.current.anchor.x -
          (centerX - viewSize.width / 2) / nextScale,
        z:
          pinchRef.current.anchor.z -
          (centerY - viewSize.height / 2) / nextScale,
      });
      setScale(nextScale);
      return;
    }

    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
    if (explorationState) return;
    setCamera({
      x: pointer.camera.x - dx / scale,
      z: pointer.camera.z - dy / scale,
    });
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
          setDrawer("highlights");
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
            const next = withCurrentIndex(explorationState, index);
            setExplorationState(next);
            focusExploration(next);
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
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(
      Math.exp(-event.deltaY * 0.0014),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const goToSearch = (event: FormEvent) => {
    event.preventDefault();
    const result = parseLocation(search, highlights);
    if (!result) {
      setSearchError(true);
      notify("Usa coordenadas X, Z o el nombre de un highlight");
      return;
    }
    setSearchError(false);
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
      const next = withCurrentIndex(explorationState, index);
      setExplorationState(next);
      focusExploration(next);
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
      setExplorationState(next);
      if (next !== explorationState) focusExploration(next);
    },
    [explorationState, focusExploration],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (workspaceMutationsBlocked) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        if (event.key === "Escape") (event.target as HTMLElement).blur();
        return;
      }
      if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "h" || event.key === "H") {
        setDrawer("highlights");
      } else if (event.key === "e" || event.key === "E") {
        setDrawer("exploration");
      } else if (event.key === "m" || event.key === "M") {
        beginMarkMode("pin");
      } else if (event.key === "r" || event.key === "R") {
        beginMarkMode("area");
      } else if (event.key === "+" || event.key === "=") {
        zoomAt(1.5);
      } else if (event.key === "-") {
        zoomAt(1 / 1.5);
      } else if (event.key === "Escape") {
        pinStartRef.current = null;
        areaStartRef.current = null;
        coverageStartRef.current = null;
        areaPreviewRef.current = undefined;
        setMarkMode(null);
        setAreaPreview(undefined);
        setCoveragePreview(null);
        setDrawer(null);
      } else if (event.key.startsWith("Arrow")) {
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
    beginMarkMode,
    explorationState,
    moveExplorationCardinal,
    scale,
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

  const toggleOnlineFallback = () => {
    const next = !onlineFallbackRef.current;
    onlineFallbackRef.current = next;
    setOnlineFallback(next);
    clearTileCache();
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
      const knownExplorationIds = new Set(
        savedExplorations.map((exploration) => exploration.id),
      );
      if (explorationState) {
        knownExplorationIds.add(explorationState.region.id);
      }
      if (knownExplorationIds.size >= MAX_WORKSPACE_EXPLORATIONS) {
        throw new Error(
          "El workspace alcanzó el límite de 128 sesiones; exporta una antes de crear otra",
        );
      }
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
      if (explorationState) archiveExploration(explorationState);
      let next = createExplorationState({
        id: `region-${Date.now().toString(36)}`,
        name: regionForm.name.trim() || "Región de análisis",
        bounds,
        lod,
        scale,
      });
      const initialIndex = cellIndexAtWorld(
        next.region,
        camera.x,
        camera.z,
      );
      if (initialIndex !== null) next = withCurrentIndex(next, initialIndex);
      setExplorationState(next);
      focusExploration(next);
      onlineFallbackRef.current = false;
      setOnlineFallback(false);
      clearTileCache();
      setDrawer("exploration");
      notify(
        `${next.region.cellCount.toLocaleString("es-GT")} celdas · zoom fijado`,
      );
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
      if (nextExplorations.length > MAX_WORKSPACE_EXPLORATIONS) {
        notify(
          "No se puede pausar: el workspace alcanzó el límite de 128 sesiones",
        );
        return;
      }
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
      try {
        window.localStorage.setItem(
          SAVED_EXPLORATIONS_STORAGE_KEY,
          JSON.stringify(nextExplorations),
        );
        window.localStorage.removeItem(EXPLORATION_STORAGE_KEY);
      } catch {
        // The full recovery record or the completed disk write is already safe.
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
          : "Sesión pausada · copia de recuperación conservada",
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
      const knownExplorationIds = new Set(
        savedExplorations.map((exploration) => exploration.id),
      );
      if (explorationState) {
        knownExplorationIds.add(explorationState.region.id);
      }
      if (
        !knownExplorationIds.has(next.region.id) &&
        knownExplorationIds.size >= MAX_WORKSPACE_EXPLORATIONS
      ) {
        throw new Error(
          "El workspace alcanzó el límite de 128 sesiones; exporta una antes de importar otra",
        );
      }
      if (explorationState) archiveExploration(explorationState);
      setExplorationState(next);
      focusExploration(next);
      onlineFallbackRef.current = false;
      setOnlineFallback(false);
      clearTileCache();
      setDrawer("exploration");
      notify(`${next.reviewedCount.toLocaleString("es-GT")} celdas restauradas`);
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
      if (explorationState) archiveExploration(explorationState);
      const next = explorationStateFromWorkspace(exploration);
      setExplorationState(next);
      focusExploration(next);
      onlineFallbackRef.current = false;
      setOnlineFallback(false);
      clearTileCache();
      setDrawer("exploration");
      notify(`Sesión “${next.region.name}” restaurada`);
    } catch {
      notify("La sesión guardada ya no es compatible");
    }
  };

  const deleteSavedExploration = (
    exploration: LocalAtlasWorkspaceExploration,
  ) => {
    if (explorationState?.region.id === exploration.id) return;
    if (
      !window.confirm(
        `¿Eliminar “${exploration.state.region.name}” del workspace? Exporta la sesión primero si quieres conservar otra copia.`,
      )
    ) {
      return;
    }
    setSavedExplorations((items) =>
      items.filter((item) => item.id !== exploration.id),
    );
    notify(`Sesión “${exploration.state.region.name}” eliminada`);
  };

  const reviewCurrentAndMove = (step: -1 | 1) => {
    if (!explorationState) return;
    const reviewed = withCurrentCellReviewed(explorationState);
    const next = moveCurrentSerpentine(reviewed, step);
    setExplorationState(next);
    if (next.currentIndex !== explorationState.currentIndex) {
      focusExploration(next);
    }
  };

  const moveExplorationSerpentine = (step: -1 | 1) => {
    if (!explorationState) return;
    const next = moveCurrentSerpentine(explorationState, step);
    setExplorationState(next);
    if (next !== explorationState) focusExploration(next);
  };

  const toggleCurrentReviewed = () => {
    setExplorationState((current) =>
      current
        ? withCurrentCellReviewed(
            current,
            !isCellReviewed(current, current.currentIndex),
          )
        : current,
    );
  };

  const downloadCurrentCell = async () => {
    if (!localRuntime?.capacity.configured || !currentExplorationCell) {
      notify("Inicia el visor con la biblioteca local de LuisA");
      return;
    }
    const selectedLayers = layers
      .filter((layer) => layer.visible)
      .map((layer) => layer.id);
    setRuntimeBusy(true);
    try {
      await downloadExplorationCell(
        localRuntime,
        currentExplorationCell.bounds,
        explorationState!.region.lod,
        selectedLayers.length > 0 ? selectedLayers : ["base"],
        requestsPerSecond,
      );
      setLocalRuntime(await readLocalAtlasRuntime());
      notify("Descarga regional iniciada");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "No se pudo iniciar la celda",
      );
    } finally {
      setRuntimeBusy(false);
    }
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
      await copyText(`${Math.round(camera.x)}, ${Math.round(camera.z)}`);
      notify("Coordenadas copiadas");
    } catch {
      notify("Chrome no permitió copiar las coordenadas");
    }
  };

  const copyLink = async () => {
    const hash = locationHash(camera, scale);
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
    notify("Highlights exportados");
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
      if (
        highlights.length > 0 &&
        !window.confirm(
          `Esto reemplazará ${highlights.length} highlights locales. ¿Continuar?`,
        )
      ) {
        return;
      }
      setHighlights(valid);
      setSelectedHighlightId(null);
      notify(`${valid.length} highlights importados`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "JSON inválido");
    }
  };

  const toggleDrawer = (next: Exclude<Drawer, null>) => {
    setDrawer((current) => (current === next ? null : next));
  };

  const drawerTitle = useMemo(
    () =>
      ({
        layers: "Capas del mapa",
        exploration: "Exploración regional",
        highlights: "Highlights",
        help: "Guía rápida",
      })[drawer ?? "layers"],
    [drawer],
  );

  return (
    <main
      className={`atlas-shell ${drawer ? "has-drawer" : ""} ${markMode ? "is-marking" : ""}`}
      aria-busy={workspaceMutationsBlocked}
    >
      {workspaceMutationsBlocked ? (
        <div className="workspace-hydration-shield" role="status">
          <HardDrive size={19} />
          <div>
            <strong>
              {pauseBusy ? "Guardando sesión" : "Sincronizando workspace"}
            </strong>
            <span>
              {pauseBusy
                ? "Asegurando una copia antes de pausar…"
                : "Protegiendo el progreso antes de habilitar cambios…"}
            </span>
          </div>
        </div>
      ) : null}
      <div ref={mapRef} className="map-stage">
        <canvas
          ref={canvasRef}
          className="map-canvas"
          aria-label="Mapa interactivo del Overworld de 2b2t"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onDoubleClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            zoomAt(
              1.8,
              event.clientX - rect.left,
              event.clientY - rect.top,
            );
          }}
        />
        <div className="map-vignette" />
        <div className="center-reticle" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>

      <header className="topbar">
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
              X <strong>{formatCoordinate(camera.x)}</strong>
            </span>
            <span>
              Z <strong>{formatCoordinate(camera.z)}</strong>
            </span>
          </div>
          <div className="coordinate-meta">
            <span>Zoom {scale.toFixed(2)}×</span>
            <i />
            <span>LOD {lod}</span>
            <i />
            <span>{blocksPerPixel} bloque{blocksPerPixel === 1 ? "" : "s"}/px</span>
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

      <nav className="left-dock glass-card" aria-label="Herramientas del mapa">
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
          badge={highlights.length || undefined}
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
        <aside className="side-drawer glass-card" aria-label={drawerTitle}>
          <div className="drawer-heading">
            <div>
              <span className="eyebrow">OVERWORLD / {drawer.toUpperCase()}</span>
              <h2>{drawerTitle}</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Cerrar panel"
              onClick={() => setDrawer(null)}
            >
              <X size={18} />
            </button>
          </div>

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
              <section className="coverage-overview-card">
                <div className="coverage-overview-heading">
                  <Grid3X3 size={19} />
                  <div>
                    <span>REJILLA MAESTRA · OVERWORLD</span>
                    <strong>Huella real publicada, sector por sector</strong>
                  </div>
                  <span className="coverage-overview-status">33 × 33</span>
                </div>
                <p className="coverage-overview-copy">
                  Cada sector representa{" "}
                  {OVERWORLD_OVERVIEW_CELL_BLOCKS.toLocaleString("es-GT")} ×{" "}
                  {OVERWORLD_OVERVIEW_CELL_BLOCKS.toLocaleString("es-GT")}{" "}
                  bloques. La máscara distingue tiles existentes de huecos.
                </p>
                <div className="coverage-overview-metrics">
                  <span>
                    Con datos
                    <strong>
                      {coverageSummary.available.toLocaleString("es-GT")} sectores
                    </strong>
                  </span>
                  <span>
                    Tiles verificados
                    <strong>
                      {coverageSummary.availableTiles.toLocaleString("es-GT")}
                    </strong>
                  </span>
                  <span>
                    Paso
                    <strong>32,768 bloques</strong>
                  </span>
                </div>
                <span className="coverage-bounds">
                  X {formatCoordinate(OVERWORLD_OBSERVED_DATA_BOUNDS.minX)} →{" "}
                  {formatCoordinate(
                    OVERWORLD_OBSERVED_DATA_BOUNDS.maxXExclusive,
                  )}
                  <br />
                  Z {formatCoordinate(OVERWORLD_OBSERVED_DATA_BOUNDS.minZ)} →{" "}
                  {formatCoordinate(
                    OVERWORLD_OBSERVED_DATA_BOUNDS.maxZExclusive,
                  )}
                </span>
                <div className="coverage-overview-actions">
                  <button
                    type="button"
                    data-primary="true"
                    disabled={Boolean(explorationState)}
                    onClick={viewFullCoverage}
                  >
                    <ScanSearch size={15} />
                    Ver mapa completo y seleccionar
                  </button>
                  <button
                    type="button"
                    aria-pressed={showCoverageGrid}
                    disabled={Boolean(explorationState)}
                    onClick={() => setShowCoverageGrid((visible) => !visible)}
                  >
                    {showCoverageGrid ? <Eye size={15} /> : <EyeOff size={15} />}
                    {showCoverageGrid ? "Ocultar rejilla" : "Mostrar rejilla"}
                  </button>
                </div>
                <div className="coverage-legend" aria-label="Leyenda de cobertura">
                  <span
                    className="coverage-legend-item"
                    data-coverage="full"
                  >
                    <i className="coverage-legend-dot" />
                    Completo
                  </span>
                  <span
                    className="coverage-legend-item"
                    data-coverage="partial"
                  >
                    <i className="coverage-legend-dot" />
                    Parcial
                  </span>
                  <span
                    className="coverage-legend-item"
                    data-coverage="empty"
                  >
                    <i className="coverage-legend-dot" />
                    Sin tile
                  </span>
                </div>
              </section>

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
                        ? `${coverageSelection.rows} filas × ${coverageSelection.columns} columnas`
                        : "Todavía no has elegido una región"}
                    </strong>
                  </div>
                  {coverageSelection ? (
                    <span className="coverage-selection-status">
                      {coverageSelection.availableCellCount} con datos
                    </span>
                  ) : null}
                </div>
                {coverageSelection ? (
                  <>
                    <div className="coverage-selection-summary">
                      <span>
                        Sectores
                        <strong>{coverageSelection.cellCount}</strong>
                      </span>
                      <span>
                        Completos
                        <strong>{coverageSelection.fullCellCount}</strong>
                      </span>
                      <span>
                        Parciales
                        <strong>{coverageSelection.partialCellCount}</strong>
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
                        onClick={() => openCoverageSelection(false)}
                      >
                        <Crosshair size={15} />
                        Encajar región
                      </button>
                      <button
                        type="button"
                        data-primary="true"
                        onClick={() => openCoverageSelection(true)}
                      >
                        <ScanSearch size={15} />
                        Preparar LOD 0
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="coverage-selection-hint">
                    Pulsa “Ver mapa completo” y arrastra desde el primer sector
                    hasta el último. También puedes seguir escribiendo
                    coordenadas exactas.
                  </p>
                )}
              </section>

              <section className="saved-session-picker">
                <div className="saved-session-picker-heading">
                  <HardDrive size={18} />
                  <div>
                    <span>WORKSPACE DURABLE</span>
                    <strong>Progreso, regiones y highlights</strong>
                  </div>
                  <span
                    className="persistence-badge"
                    data-state={persistenceState}
                    title={persistenceMessage}
                  >
                    <strong>{persistenceMessage}</strong>
                  </span>
                </div>
                <div className="saved-session-actions">
                  <button
                    type="button"
                    className="compact-button is-primary"
                    disabled={
                      persistenceState === "saving" ||
                      persistenceState === "conflict" ||
                      !localRuntime?.persistence.configured ||
                      !localRuntime.persistence.writable
                    }
                    onClick={() => void flushWorkspace()}
                  >
                    <HardDrive size={14} />
                    Guardar ahora
                  </button>
                  {persistenceState === "conflict" ? (
                    <button
                      type="button"
                      className="compact-button"
                      onClick={() => {
                        if (
                          !window.confirm(
                            "Esto descartará la copia local en conflicto y cargará la versión guardada en LuisA. ¿Continuar?",
                          )
                        ) {
                          return;
                        }
                        clearBrowserWorkspaceRecovery(
                          workspaceContentRef.current ?? workspaceContent,
                        );
                        window.location.reload();
                      }}
                    >
                      <RotateCcw size={14} />
                      Usar versión de LuisA
                    </button>
                  ) : null}
                </div>
                {orderedSavedExplorations.length > 0 ? (
                  <div className="saved-session-list">
                    {orderedSavedExplorations.map((exploration) => {
                      const active =
                        explorationState?.region.id === exploration.id;
                      return (
                        <article
                          className={`saved-session-item ${
                            active ? "is-active" : ""
                          }`}
                          key={exploration.id}
                        >
                          <div>
                            <strong>{exploration.state.region.name}</strong>
                            <span>
                              LOD {exploration.state.region.lod} ·{" "}
                              {exploration.state.reviewedCount.toLocaleString(
                                "es-GT",
                              )}{" "}
                              revisadas
                            </span>
                          </div>
                          <div className="saved-session-item-actions">
                            <button
                              type="button"
                              disabled={active}
                              onClick={() =>
                                resumeSavedExploration(exploration)
                              }
                            >
                              {active ? "Activa" : "Abrir"}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={active}
                              aria-label={`Eliminar ${exploration.state.region.name}`}
                              title={
                                active
                                  ? "Pausa la sesión antes de eliminarla"
                                  : "Eliminar del workspace"
                              }
                              onClick={() =>
                                deleteSavedExploration(exploration)
                              }
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="saved-session-empty">
                    Las regiones que inicies aparecerán aquí y permanecerán en
                    LuisA aunque cierres el navegador.
                  </p>
                )}
              </section>

              <section
                className={`capacity-card ${
                  localRuntime?.capacity.fits === true
                    ? "fits"
                    : localRuntime?.capacity.fits === false
                      ? "tight"
                      : ""
                }`}
              >
                <div className="capacity-heading">
                  <HardDrive size={20} />
                  <div>
                    <span>CAPACIDAD LOCAL · LUISA</span>
                    <strong>
                      {localRuntime?.capacity.fits === true
                        ? "Overworld completo: capacidad verificada"
                        : localRuntime?.capacity.fits === false
                          ? "Margen insuficiente para la referencia completa"
                          : runtimeChecked
                            ? "Runtime local no configurado"
                            : "Comprobando discos…"}
                    </strong>
                  </div>
                  {localRuntime?.capacity.fits === true && <CheckCircle2 />}
                </div>
                {localRuntime && (
                  <div className="capacity-metrics">
                    <span>
                      Libre
                      <strong>
                        {formatBytes(localRuntime.capacity.freeBytes)}
                      </strong>
                    </span>
                    <span>
                      Referencia + reserva
                      <strong>
                        {formatBytes(
                          localRuntime.capacity.overworldRequirementBytes,
                        )}
                      </strong>
                    </span>
                    <span>
                      Margen
                      <strong>
                        {formatSignedBytes(localRuntime.capacity.marginBytes)}
                      </strong>
                    </span>
                  </div>
                )}
                <p>
                  Comprobación conservadora del APFS de tiles y del espacio
                  disponible en LuisA. No inicia una descarga total.
                </p>
              </section>

              {!explorationState ? (
                <>
                  <div className="section-copy">
                    <p>Divide una región en celdas del LOD actual.</p>
                    <span>
                      Cada celda es un tile; el zoom queda fijado durante la
                      revisión.
                    </span>
                  </div>
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
                      <strong>Zoom a fijar: {scale.toFixed(3)}×</strong>
                      <small>
                        LOD {lod} · {blocksPerTileAtLod(lod).toLocaleString("es-GT")}{" "}
                        bloques por celda
                      </small>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={startExploration}
                  >
                    <Navigation size={17} />
                    Crear sesión de exploración
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => explorationImportRef.current?.click()}
                  >
                    <Upload size={16} />
                    Importar sesión anterior
                  </button>
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
                        Revisadas
                        <strong>
                          {explorationState.reviewedCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                      <span>
                        Total
                        <strong>
                          {explorationState.region.cellCount.toLocaleString("es-GT")}
                        </strong>
                      </span>
                      <span>
                        Posición
                        <strong>
                          {serpentinePositionForCellIndex(
                            explorationState.region,
                            explorationState.currentIndex,
                          ) + 1}
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
                      <button
                        type="button"
                        className={`review-toggle ${
                          isCellReviewed(
                            explorationState,
                            explorationState.currentIndex,
                          )
                            ? "reviewed"
                            : ""
                        }`}
                        onClick={toggleCurrentReviewed}
                      >
                        <CheckCircle2 size={17} />
                        {isCellReviewed(
                          explorationState,
                          explorationState.currentIndex,
                        )
                          ? "Celda revisada"
                          : "Marcar como revisada"}
                      </button>
                      <div className="sequence-actions">
                        <button
                          type="button"
                          disabled={
                            serpentinePositionForCellIndex(
                              explorationState.region,
                              explorationState.currentIndex,
                            ) === 0
                          }
                          onClick={() => moveExplorationSerpentine(-1)}
                        >
                          <StepBack size={16} />
                          Anterior
                        </button>
                        <button
                          type="button"
                          className="next-review"
                          onClick={() => reviewCurrentAndMove(1)}
                        >
                          Revisada y siguiente
                          <StepForward size={16} />
                        </button>
                      </div>
                    </section>
                  )}

                  <section className="regional-download-card">
                    <div className="regional-download-heading">
                      <Gauge size={18} />
                      <div>
                        <span>DATOS BAJO DEMANDA</span>
                        <strong>
                          {localRuntime?.job?.status === "running" ||
                          localRuntime?.job?.status === "stopping"
                            ? localRuntime.job.message
                            : "Guardar únicamente esta celda"}
                        </strong>
                      </div>
                    </div>
                    <label>
                      <span>Ritmo seguro</span>
                      <select
                        value={requestsPerSecond}
                        disabled={
                          localRuntime?.job?.status === "running" ||
                          localRuntime?.job?.status === "stopping"
                        }
                        onChange={(event) =>
                          setRequestsPerSecond(Number(event.target.value))
                        }
                      >
                        <option value="0.25">0.25 req/s</option>
                        <option value="0.5">0.5 req/s</option>
                        <option value="1">1 req/s</option>
                        <option value="2">2 req/s</option>
                      </select>
                    </label>
                    {localRuntime?.job?.status === "running" ||
                    localRuntime?.job?.status === "stopping" ? (
                      <button
                        type="button"
                        className="stop-job-button"
                        disabled={runtimeBusy}
                        onClick={stopCurrentJob}
                      >
                        <X size={16} />
                        Detener celda
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          runtimeBusy ||
                          !localRuntime?.capacity.configured
                        }
                        onClick={downloadCurrentCell}
                      >
                        <Download size={16} />
                        Descargar celda actual
                      </button>
                    )}
                    <small>
                      El límite de 2 req/s se comparte dentro del trabajo
                      regional. La navegación no descarga en segundo plano.
                    </small>
                  </section>

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
                <summary>Fuentes de datos locales</summary>
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
                    <p>Los tiles locales siempre tienen prioridad.</p>
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
                <button
                  className="setting-row"
                  type="button"
                  aria-pressed={onlineFallback}
                  onClick={toggleOnlineFallback}
                >
                  <RotateCcw size={18} />
                  <span>
                    <strong>Vista rápida online</strong>
                    <small>
                      Opcional; no guarda tiles ni respeta el ritmo regional
                    </small>
                  </span>
                  <span className={`switch ${onlineFallback ? "on" : ""}`} />
                </button>
                <div className="stats-grid">
                  <Metric label="Local" value={tileStats.local} tone="mint" />
                  <Metric label="Online" value={tileStats.remote} tone="blue" />
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
              <div className="highlight-transfer">
                <button type="button" onClick={exportHighlights}>
                  <Download size={15} />
                  Exportar
                </button>
                <button type="button" onClick={() => importRef.current?.click()}>
                  <Upload size={15} />
                  Importar
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
              ) : highlights.length ? (
                <div className="highlight-list">
                  <div className="list-heading">
                    <span>{highlights.length} guardados</span>
                    <ListFilter size={15} />
                  </div>
                  {highlights.map((highlight) => (
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
                    Marca un punto o arrastra un área. Se guardan
                    automáticamente en LuisA y mantienen una copia local.
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
                <Shortcut keys="Flechas" label="Saltar entre celdas" />
                <Shortcut keys="G" label="Ir a coordenadas" />
                <Shortcut keys="E" label="Abrir exploración" />
                <Shortcut keys="M" label="Marcar punto" />
                <Shortcut keys="R" label="Dibujar área" />
                <Shortcut keys="Esc" label="Cancelar o cerrar" />
              </div>
              <div className="archive-note">
                <HelpCircle size={17} />
                <p>
                  Antes de iniciar, el LOD sigue al zoom. Una sesión fija ambos
                  valores y convierte cada tile en una celda revisable.
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
              : onlineFallback
                ? "Vista online"
                : "Solo local"}
        </strong>
        <span>
          Cursor X {formatCoordinate(cursor.x)} · Z {formatCoordinate(cursor.z)}
        </span>
      </div>

      <div
        ref={fallbackBadgeRef}
        className="fallback-badge glass-card"
        data-active="false"
      >
        <RotateCcw size={14} aria-hidden="true" />
        <span ref={fallbackTextRef} />
      </div>

      {explorationState && currentExplorationCell && (
        <section
          className="exploration-navigation glass-card"
          aria-label="Navegación por celdas"
        >
          <div className="navigation-progress">
            <span>
              CELDA{" "}
              {serpentinePositionForCellIndex(
                explorationState.region,
                explorationState.currentIndex,
              ) + 1}{" "}
              / {explorationState.region.cellCount.toLocaleString("es-GT")}
            </span>
            <strong>{formatProgressPercent(explorationPercent)}%</strong>
          </div>
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
            <button
              type="button"
              className="review"
              aria-label="Marcar revisada y avanzar"
              onClick={() => reviewCurrentAndMove(1)}
            >
              <Check />
            </button>
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

      <div className="dimension-pill glass-card">
        <button type="button" className="active" aria-pressed="true">
          <span className="dimension-orb" />
          Overworld
        </button>
        <span className="coming-soon">Nether y End próximamente</span>
      </div>

      <div className="zoom-stack glass-card">
        <button
          type="button"
          aria-label="Acercar"
          title="Acercar"
          disabled={Boolean(explorationState)}
          onClick={() => zoomAt(1.5)}
        >
          <Plus />
        </button>
        <span className="zoom-lod">
          {explorationState ? <LockKeyhole size={12} /> : null} L{lod}
        </span>
        <button
          type="button"
          aria-label="Alejar"
          title="Alejar"
          disabled={Boolean(explorationState)}
          onClick={() => zoomAt(1 / 1.5)}
        >
          <Minus />
        </button>
        <button
          type="button"
          aria-label="Volver al área inicial"
          title="Volver al área inicial"
          onClick={() => {
            if (currentExplorationCell && explorationState) {
              setCamera({
                x:
                  (currentExplorationCell.bounds.minX +
                    currentExplorationCell.bounds.maxXExclusive) /
                  2,
                z:
                  (currentExplorationCell.bounds.minZ +
                    currentExplorationCell.bounds.maxZExclusive) /
                  2,
              });
              setScale(explorationState.region.scale);
            } else {
              setCamera(INITIAL_CAMERA);
              setScale(INITIAL_SCALE);
            }
          }}
        >
          <LocateFixed />
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

function formatSignedBytes(value: number | null) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
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
