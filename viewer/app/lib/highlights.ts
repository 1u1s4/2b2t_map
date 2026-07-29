import type { WorldBounds } from "./exploration-grid.ts";

export const HIGHLIGHT_NAME_PRESETS = ["Base", "Base D", "Mapa"] as const;
export const MAX_HIGHLIGHT_NAME_LENGTH = 200;
export type HighlightNamePreset = (typeof HIGHLIGHT_NAME_PRESETS)[number];

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

export function isHighlightRegionKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    return false;
  }
  const coordinates = value.split(":");
  if (coordinates.length !== 4) return false;
  const [minX, minZ, maxXExclusive, maxZExclusive] = coordinates.map(Number);
  return (
    coordinates.every((coordinate) => /^-?\d+$/.test(coordinate)) &&
    [minX, minZ, maxXExclusive, maxZExclusive].every(
      (coordinate) =>
        Number.isSafeInteger(coordinate) &&
        Math.abs(coordinate) <= 30_000_000,
    ) &&
    maxXExclusive > minX &&
    maxZExclusive > minZ
  );
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
