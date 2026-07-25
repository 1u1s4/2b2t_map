"use client";

import {
  Activity,
  AlertTriangle,
  Archive,
  AreaChart,
  Check,
  ChevronLeft,
  Copy,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Grid3X3,
  HelpCircle,
  Layers3,
  Link2,
  ListFilter,
  LocateFixed,
  MapPin,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  SquareDashedMousePointer,
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
  isDownloadProgressStale,
  readDownloadProgress,
  readServedDownloadProgress,
  type DownloadProgressReadResult,
  type DownloadProgressSnapshot,
} from "./lib/download-progress";
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
const HIGHLIGHT_STORAGE_KEY = "obsidian-atlas-highlights-v1";
const COLORS = ["#ff5f57", "#ffbd4a", "#26d9c7", "#62a8ff", "#c58cff"];

type Drawer = "layers" | "archive" | "highlights" | "help" | null;
type MarkMode = "pin" | "area" | null;

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

type DownloadProgressState = {
  source: LocalTileSource | "server";
  result: DownloadProgressReadResult;
  checkedAt: number;
};

type ActivePointer = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
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

function remoteTileUrl(key: TileKey) {
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

function isSafeMapCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 60_000_000
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
  const seen = new Set<string>();
  const result: Highlight[] = [];
  for (const item of value) {
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
  const fallbackBadgeRef = useRef<HTMLDivElement>(null);
  const fallbackTextRef = useRef<HTMLSpanElement>(null);
  const tileCacheRef = useRef<Map<string, TileRecord>>(new Map());
  const tileGenerationRef = useRef(0);
  const onlineFallbackRef = useRef(true);
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
  const localSourceRef = useRef<LocalTileSource | null>(null);

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
  const [onlineFallback, setOnlineFallback] = useState(true);
  const [localSource, setLocalSource] = useState<LocalTileSource | null>(null);
  const [archiveName, setArchiveName] = useState<string | null>(null);
  const [localSupported, setLocalSupported] = useState(false);
  const [tileStats, setTileStats] = useState<TileStats>({
    local: 0,
    remote: 0,
    missing: 0,
  });
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(
    null,
  );
  const [highlightsReady, setHighlightsReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const lod = lodForScale(scale);
  const blocksPerPixel = blocksPerPixelAtLod(lod);
  const gridStep = adaptiveGridStep(scale);
  const selectedHighlight = highlights.find(
    (highlight) => highlight.id === selectedHighlightId,
  );
  const progressMatchesCurrentSource =
    (localSource !== null && downloadProgress?.source === localSource) ||
    (localSource === null && downloadProgress?.source === "server");
  const showDownloadProgress =
    localSource !== null || downloadProgress?.source === "server";

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1_700);
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

      const location = parseLocation(window.location.hash, []);
      if (location) {
        setCamera({ x: location.x, z: location.z });
        if (location.scale) setScale(location.scale);
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
    const timeout = window.setTimeout(() => {
      window.history.replaceState(null, "", locationHash(camera, scale));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [camera, scale]);

  useEffect(() => {
    const onHashChange = () => {
      const location = parseLocation(window.location.hash, []);
      if (!location) return;
      setCamera({ x: location.x, z: location.z });
      if (location.scale) setScale(location.scale);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
    };
  }, []);

  useEffect(() => {
    if (!localSource) return;

    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await readDownloadProgress(localSource.directory);
        if (!cancelled) {
          setDownloadProgress({
            source: localSource,
            result,
            checkedAt: Date.now(),
          });
        }
      } finally {
        reading = false;
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [localSource]);

  useEffect(() => {
    if (localSource) return;

    let cancelled = false;
    let reading = false;
    let interval: number | null = null;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      const controller = new AbortController();
      activeController = controller;
      const abortTimeout = window.setTimeout(() => controller.abort(), 10_000);
      let keepPolling = true;
      try {
        const result = await readServedDownloadProgress(
          fetch,
          controller.signal,
        );
        if (cancelled) return;
        if (result === null) {
          keepPolling = false;
          setDownloadProgress((current) =>
            current?.source === "server" ? null : current,
          );
          return;
        }
        setDownloadProgress({
          source: "server",
          result,
          checkedAt: Date.now(),
        });
      } finally {
        window.clearTimeout(abortTimeout);
        if (activeController === controller) activeController = null;
        reading = false;
        if (!cancelled && keepPolling) {
          interval = window.setTimeout(() => {
            void refresh();
          }, 5_000);
        }
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      activeController?.abort();
      if (interval !== null) window.clearTimeout(interval);
    };
  }, [localSource]);

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
            const response = await fetch(remoteTileUrl(key));
            if (response.ok) {
              const bitmap = await createImageBitmap(await response.blob());
              finish({ status: "loaded", bitmap, source: "remote" });
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
            context.drawImage(
              record.bitmap,
              destination.x,
              destination.y,
              destinationSize + 0.5,
              destinationSize + 0.5,
            );
            continue;
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
    gridStep,
    highlights,
    layers,
    lod,
    renderVersion,
    scale,
    screenAtWorld,
    selectedHighlightId,
    showGrid,
    viewSize,
  ]);

  const zoomAt = useCallback(
    (factor: number, screenX = viewSize.width / 2, screenY = viewSize.height / 2) => {
      const anchor = worldAtScreen(screenX, screenY);
      const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
      setCamera({
        x: anchor.x - (screenX - viewSize.width / 2) / nextScale,
        z: anchor.z - (screenY - viewSize.height / 2) / nextScale,
      });
      setScale(nextScale);
    },
    [scale, viewSize, worldAtScreen],
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

  const beginMarkMode = useCallback((mode: Exclude<MarkMode, null>) => {
    setMarkMode(mode);
    areaPreviewRef.current = undefined;
    setAreaPreview(undefined);
    areaStartRef.current = null;
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
    if (markMode === "area") {
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

    if (markMode === "area" && areaStartRef.current) {
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
    } else if (markMode === "area" && areaPreviewRef.current) {
      const preview = areaPreviewRef.current;
      areaStartRef.current = null;
      areaPreviewRef.current = undefined;
      setAreaPreview(undefined);
      addArea(preview);
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
        setSelectedHighlightId(pointer.hitId);
        if (pointer.hitId) setDrawer("highlights");
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
    areaPreviewRef.current = undefined;
    setAreaPreview(undefined);
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
    setCamera({ x: result.x, z: result.z });
    if (result.scale) setScale(result.scale);
    notify(`Centrado en ${Math.round(result.x)}, ${Math.round(result.z)}`);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        areaPreviewRef.current = undefined;
        setMarkMode(null);
        setAreaPreview(undefined);
        setDrawer(null);
      } else if (event.key.startsWith("Arrow")) {
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
  }, [beginMarkMode, scale, zoomAt]);

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
      setDrawer("archive");
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
        archive: "Archivo de tiles",
        highlights: "Highlights",
        help: "Guía rápida",
      })[drawer ?? "layers"],
    [drawer],
  );

  return (
    <main
      className={`atlas-shell ${drawer ? "has-drawer" : ""} ${markMode ? "is-marking" : ""}`}
    >
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
            <span>2b2t · Overworld archive</span>
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
          active={drawer === "archive"}
          label="Archivo"
          onClick={() => toggleDrawer("archive")}
        >
          <Archive />
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

          {drawer === "archive" && (
            <div className="drawer-content">
              <div className={`archive-hero ${localSource ? "connected" : ""}`}>
                <div className="archive-icon">
                  {localSource ? <Check /> : <FolderOpen />}
                </div>
                <div>
                  <span>{localSource ? "ARCHIVO CONECTADO" : "FUENTE DE TILES"}</span>
                  <h3>{archiveName ?? "Abrir 2b2t_tiles"}</h3>
                  <p>
                    {localSource
                      ? "Los tiles locales tienen prioridad."
                      : downloadProgress?.source === "server"
                        ? "El progreso local se actualiza automáticamente."
                      : "Chrome puede leer tu archivo sin subirlo."}
                  </p>
                </div>
              </div>
              {localSupported ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={localSource ? disconnectArchive : openArchive}
                >
                  {localSource ? <X size={17} /> : <FolderOpen size={17} />}
                  {localSource ? "Desconectar archivo" : "Elegir carpeta local"}
                </button>
              ) : (
                <p className="warning-note">
                  La apertura directa requiere Chrome y una conexión segura.
                </p>
              )}
              <button
                className="setting-row"
                type="button"
                aria-pressed={onlineFallback}
                onClick={toggleOnlineFallback}
              >
                <RotateCcw size={18} />
                <span>
                  <strong>Respaldo online</strong>
                  <small>Completa tiles ausentes desde 2b2t.place</small>
                </span>
                <span className={`switch ${onlineFallback ? "on" : ""}`} />
              </button>
              {showDownloadProgress && (
                <DownloadProgressCard
                  result={
                    progressMatchesCurrentSource
                      ? (downloadProgress?.result ?? null)
                      : null
                  }
                  checkedAt={
                    progressMatchesCurrentSource
                      ? (downloadProgress?.checkedAt ?? null)
                      : null
                  }
                />
              )}
              <p className="metric-caption">
                Tiles consultados por el mapa en esta sesión
              </p>
              <div className="stats-grid">
                <Metric label="Local" value={tileStats.local} tone="mint" />
                <Metric label="Online" value={tileStats.remote} tone="blue" />
                <Metric label="Ausentes" value={tileStats.missing} tone="amber" />
              </div>
              <div className="archive-note">
                <Archive size={17} />
                <p>
                  Selecciona la carpeta <strong>2b2t_tiles</strong>. El
                  navegador recibe acceso de solo lectura; nada se sube.
                </p>
              </div>
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
                        setCamera({
                          x: selectedHighlight.x,
                          z: selectedHighlight.z,
                        })
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
                        setCamera({ x: highlight.x, z: highlight.z });
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
                    Marca un punto o arrastra un área. Se guardan únicamente en
                    este navegador.
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
                <Shortcut keys="G" label="Ir a coordenadas" />
                <Shortcut keys="M" label="Marcar punto" />
                <Shortcut keys="R" label="Dibujar área" />
                <Shortcut keys="Esc" label="Cancelar o cerrar" />
              </div>
              <div className="archive-note">
                <HelpCircle size={17} />
                <p>
                  El LOD cambia automáticamente según el zoom. LOD 0 conserva
                  la resolución máxima de 1 bloque por píxel.
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
          className={`source-dot ${localSource ? "is-local" : "is-online"}`}
        />
        <strong>{localSource ? "Archivo local" : "Tiles online"}</strong>
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
          onClick={() => zoomAt(1.5)}
        >
          <Plus />
        </button>
        <span className="zoom-lod">L{lod}</span>
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
          aria-label="Volver al área inicial"
          title="Volver al área inicial"
          onClick={() => {
            setCamera(INITIAL_CAMERA);
            setScale(INITIAL_SCALE);
          }}
        >
          <LocateFixed />
        </button>
      </div>

      {markMode && (
        <div className="marking-banner glass-card">
          {markMode === "pin" ? <MapPin /> : <SquareDashedMousePointer />}
          <div>
            <strong>
              {markMode === "pin"
                ? "Haz clic para marcar"
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
              areaPreviewRef.current = undefined;
              setMarkMode(null);
              setAreaPreview(undefined);
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

const DOWNLOAD_STATUS_META: Record<
  string,
  { readonly label: string; readonly tone: string }
> = {
  discovering: { label: "Analizando", tone: "running" },
  running: { label: "Descargando", tone: "running" },
  complete: { label: "Completa", tone: "complete" },
  fallback_complete: { label: "Prioridad completa", tone: "warning" },
  incomplete: { label: "Incompleta", tone: "warning" },
  stopped: { label: "Pausada", tone: "warning" },
  preflight_blocked: { label: "Falta espacio", tone: "error" },
  error: { label: "Con errores", tone: "error" },
  smoke_test_complete: { label: "Prueba completa", tone: "complete" },
  unknown: { label: "Estado desconocido", tone: "neutral" },
};

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

function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) {
    return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} d ${remainingHours} h` : `${days} d`;
}

function formatUpdatedAt(progress: DownloadProgressSnapshot) {
  if (progress.updatedAtTimestamp === null) return "Sin fecha válida";
  return new Intl.DateTimeFormat("es-GT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(progress.updatedAtTimestamp);
}

function DownloadProgressCard({
  checkedAt,
  result,
}: {
  checkedAt: number | null;
  result: DownloadProgressReadResult | null;
}) {
  if (result === null) {
    return (
      <section
        className="download-progress-card is-loading"
        aria-label="Progreso de la descarga"
        aria-busy="true"
      >
        <div className="download-progress-heading">
          <Activity size={18} aria-hidden="true" />
          <div>
            <span>DESCARGA COMPLETA</span>
            <strong>Leyendo progress.json…</strong>
          </div>
        </div>
        <div className="download-progress-track is-indeterminate" aria-hidden="true">
          <span />
        </div>
      </section>
    );
  }

  if (result.kind !== "ready") {
    return (
      <section
        className={`download-progress-card has-message ${result.kind === "missing" ? "" : "has-error"}`}
        aria-label="Progreso de la descarga"
        role="status"
      >
        <div className="download-progress-heading">
          {result.kind === "missing" ? (
            <Activity size={18} aria-hidden="true" />
          ) : (
            <AlertTriangle size={18} aria-hidden="true" />
          )}
          <div>
            <span>DESCARGA COMPLETA</span>
            <strong>
              {result.kind === "missing"
                ? "Esperando al descargador"
                : "Progreso no disponible"}
            </strong>
          </div>
        </div>
        <p>{result.message}</p>
      </section>
    );
  }

  const progress = result.progress;
  const statusMeta =
    DOWNLOAD_STATUS_META[progress.status] ?? DOWNLOAD_STATUS_META.unknown;
  const percent = progress.progressPercent;
  const isIndeterminate = percent === null;
  const percentText =
    percent === null ? "Calculando…" : `${formatProgressPercent(percent)} %`;
  const estimateLabel =
    progress.progressKind === "dynamic"
      ? "dinámico"
      : progress.progressKind === "estimated" ||
          progress.progressPercentSource === "derived"
        ? "estimado"
        : null;
  const isStale = isDownloadProgressStale(progress, checkedAt);
  const httpErrors = progress.httpErrors.filter(
    (item) => item.count > 0 && item.code !== "404",
  );
  const hasProblems =
    Boolean(progress.reason) ||
    progress.tilesCorrupt > 0 ||
    progress.tilesFailed > 0 ||
    httpErrors.length > 0;
  const processedText =
    progress.plannedRequests === null
      ? `${progress.processedRequests.toLocaleString("es-GT")} solicitudes resueltas`
      : `${progress.processedRequests.toLocaleString("es-GT")} de ${progress.plannedRequests.toLocaleString("es-GT")} solicitudes`;
  const speedParts: string[] = [];
  if (progress.tilesPerSecond !== null) {
    speedParts.push(
      `${progress.tilesPerSecond.toLocaleString("es-GT", {
        maximumFractionDigits: 2,
      })} tiles/s`,
    );
  } else if (progress.effectiveRequestsPerSecond !== null) {
    speedParts.push(
      `${progress.effectiveRequestsPerSecond.toLocaleString("es-GT", {
        maximumFractionDigits: 2,
      })} req/s`,
    );
  }
  if (progress.megabytesPerSecond !== null) {
    speedParts.push(
      `${progress.megabytesPerSecond.toLocaleString("es-GT", {
        maximumFractionDigits: 2,
      })} MB/s`,
    );
  }
  const speed = speedParts.join(" · ") || "—";

  return (
    <section
      className="download-progress-card"
      aria-labelledby="download-progress-title"
    >
      <div className="download-progress-heading">
        <Activity size={18} aria-hidden="true" />
        <div>
          <span>DESCARGA COMPLETA</span>
          <strong id="download-progress-title">Progreso del archivo</strong>
        </div>
        <span
          className={`download-status ${statusMeta.tone}`}
          role="status"
          aria-live="polite"
        >
          {statusMeta.label}
        </span>
      </div>

      <div className="download-progress-summary">
        <strong>{percentText}</strong>
        <span>
          {processedText}
          {estimateLabel ? ` · ${estimateLabel}` : ""}
        </span>
      </div>
      <div
        className={`download-progress-track ${isIndeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-label="Avance de la descarga completa"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percentText}
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>

      <div className="download-progress-metrics">
        <ProgressMetric
          label="Completos"
          value={progress.tilesCompleted.toLocaleString("es-GT")}
        />
        <ProgressMetric
          label={progress.status === "discovering" ? "Grupos restantes" : "Restantes"}
          value={progress.remainingRequests.toLocaleString("es-GT")}
        />
        <ProgressMetric label="Velocidad" value={speed} />
        <ProgressMetric
          label="Datos"
          value={formatBytes(progress.downloadedBytes)}
        />
        <ProgressMetric label="ETA" value={formatDuration(progress.etaSeconds)} />
        <ProgressMetric
          label="Ausentes"
          value={progress.tilesAbsent.toLocaleString("es-GT")}
        />
      </div>

      <div className={`download-progress-updated ${isStale ? "is-stale" : ""}`}>
        <span className="source-dot" />
        <span>{isStale ? "Actualización atrasada" : "Actualizado"}</span>
        <time dateTime={progress.updatedAt ?? undefined}>
          {formatUpdatedAt(progress)}
        </time>
        <small>Se revisa cada 5 s</small>
      </div>

      {hasProblems && (
        <div
          className="download-progress-errors"
          aria-label="Errores reportados"
          role="status"
        >
          <AlertTriangle size={15} aria-hidden="true" />
          <div>
            {progress.reason && <p>{progress.reason}</p>}
            {(progress.tilesCorrupt > 0 || progress.tilesFailed > 0) && (
              <p>
                Corruptos: {progress.tilesCorrupt.toLocaleString("es-GT")} ·
                Fallidos: {progress.tilesFailed.toLocaleString("es-GT")}
              </p>
            )}
            {httpErrors.length > 0 && (
              <p>
                HTTP{" "}
                {httpErrors
                  .map(
                    ({ code, count }) =>
                      `${code} × ${count.toLocaleString("es-GT")}`,
                  )
                  .join(" · ")}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ProgressMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
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
