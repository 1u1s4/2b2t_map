import type { WorldBounds } from "./exploration-grid.ts";
import { overviewCellAtWorld } from "./overworld-coverage.ts";

export const HIGHLIGHT_NAME_PRESETS = ["Base", "Base D", "Mapa"] as const;
export const MAX_HIGHLIGHT_NAME_LENGTH = 200;
export type HighlightNamePreset = (typeof HIGHLIGHT_NAME_PRESETS)[number];
const HIGHLIGHT_REGION_SCOPE_PREFIX = "highlight-region:";

export interface RegionScopedHighlight {
  readonly regionKey?: string | null;
  readonly x: number;
  readonly z: number;
}

export interface NamedHighlightInScope {
  readonly regionKey?: string | null;
  readonly title: string;
}

function sameHighlightScope(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

/**
 * Returns the next numbered instance of a predefined name within one region.
 * Exact unnumbered legacy names occupy slot 1, while existing numeric suffixes
 * advance the sequence by their highest value.
 */
export function nextHighlightPresetName(
  preset: HighlightNamePreset,
  highlights: readonly NamedHighlightInScope[],
  regionKey: string | null | undefined,
): string {
  const escapedPreset = preset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numberedPreset = new RegExp(
    `^${escapedPreset}(?:\\s+(\\d+))?$`,
    "i",
  );
  let highestSequence = 0n;

  for (const highlight of highlights) {
    if (!sameHighlightScope(highlight.regionKey, regionKey)) continue;
    const match = highlight.title.trim().match(numberedPreset);
    if (!match) continue;
    const sequence = match[1] === undefined ? 1n : BigInt(match[1]);
    if (sequence > highestSequence) highestSequence = sequence;
  }

  return `${preset} ${highestSequence + 1n}`;
}

export function highlightRegionKey(bounds: WorldBounds): string {
  return [
    bounds.minX,
    bounds.minZ,
    bounds.maxXExclusive,
    bounds.maxZExclusive,
  ].join(":");
}

export function highlightRegionBounds(value: unknown): WorldBounds | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    return null;
  }
  const coordinates = value.split(":");
  if (coordinates.length !== 4) return null;
  const [minX, minZ, maxXExclusive, maxZExclusive] = coordinates.map(Number);
  if (
    coordinates.every((coordinate) => /^-?\d+$/.test(coordinate)) &&
    [minX, minZ, maxXExclusive, maxZExclusive].every(
      (coordinate) =>
        Number.isSafeInteger(coordinate) &&
        Math.abs(coordinate) <= 30_000_000,
    ) &&
    maxXExclusive > minX &&
    maxZExclusive > minZ
  ) {
    return { minX, minZ, maxXExclusive, maxZExclusive };
  }
  return null;
}

export function isHighlightRegionKey(value: unknown): value is string {
  return highlightRegionBounds(value) !== null;
}

export function highlightRegionDisplayName(regionKey: string): string {
  const bounds = highlightRegionBounds(regionKey);
  if (!bounds) throw new TypeError("La región del highlight no es válida");
  const cell = overviewCellAtWorld(bounds.minX, bounds.minZ);
  if (
    cell &&
    highlightRegionKey(cell.bounds) === regionKey
  ) {
    return `Sector F${cell.row + 1} · C${cell.column + 1}`;
  }
  return `Región X ${bounds.minX}…${bounds.maxXExclusive} · Z ${bounds.minZ}…${bounds.maxZExclusive}`;
}

export function highlightRegionScopeId(regionKey: string): string {
  if (!isHighlightRegionKey(regionKey)) {
    throw new TypeError("La región del highlight no es válida");
  }
  return `${HIGHLIGHT_REGION_SCOPE_PREFIX}${regionKey}`;
}

export function highlightRegionKeyFromScopeId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith(HIGHLIGHT_REGION_SCOPE_PREFIX)
  ) {
    return null;
  }
  const regionKey = value.slice(HIGHLIGHT_REGION_SCOPE_PREFIX.length);
  return isHighlightRegionKey(regionKey) ? regionKey : null;
}

/**
 * Regional Xaero scopes survive after their exploration session is archived.
 * Explicit scopes win; legacy/global points fall back to their overview sector.
 */
export function highlightRegionKeyForScope(
  highlight: RegionScopedHighlight,
): string | null {
  if (typeof highlight.regionKey === "string") return highlight.regionKey;
  const cell = overviewCellAtWorld(highlight.x, highlight.z);
  return cell ? highlightRegionKey(cell.bounds) : null;
}

export function highlightIsInsideRegionScope(
  highlight: RegionScopedHighlight,
  regionKey: string,
): boolean {
  const bounds = highlightRegionBounds(regionKey);
  if (!bounds) return false;
  return typeof highlight.regionKey === "string"
    ? highlight.regionKey === regionKey
    : pointIsInsideBounds(highlight, bounds);
}

export function pointIsInsideBounds(
  point: Pick<RegionScopedHighlight, "x" | "z">,
  bounds: WorldBounds,
): boolean {
  return (
    point.x >= bounds.minX &&
    point.x < bounds.maxXExclusive &&
    point.z >= bounds.minZ &&
    point.z < bounds.maxZExclusive
  );
}

export function highlightsForRegion<T extends RegionScopedHighlight>(
  highlights: readonly T[],
  bounds: WorldBounds | null,
): T[] {
  if (bounds === null) {
    return highlights.filter(
      (highlight) =>
        highlight.regionKey === null || highlight.regionKey === undefined,
    );
  }
  const regionKey = highlightRegionKey(bounds);
  return highlights.filter((highlight) =>
    highlight.regionKey === undefined
      ? pointIsInsideBounds(highlight, bounds)
      : highlight.regionKey === regionKey,
  );
}

export function inferLegacyHighlightRegionKey(
  highlight: RegionScopedHighlight,
  regions: readonly WorldBounds[],
): string | null {
  if (highlight.regionKey !== undefined) return highlight.regionKey;
  const matchingRegion = regions.find((bounds) =>
    pointIsInsideBounds(highlight, bounds),
  );
  return matchingRegion ? highlightRegionKey(matchingRegion) : null;
}

export function normalizeHighlightName(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= MAX_HIGHLIGHT_NAME_LENGTH
    ? normalized
    : null;
}
