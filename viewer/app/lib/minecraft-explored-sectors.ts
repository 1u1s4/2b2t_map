import {
  OVERWORLD_OVERVIEW_CELL_COUNT,
  overviewCellForIndex,
} from "./overworld-coverage.ts";

const SECTOR_IDS = Object.freeze(
  Array.from(
    { length: OVERWORLD_OVERVIEW_CELL_COUNT },
    (_, index) => overviewCellForIndex(index).id,
  ),
);
const SECTOR_INDEX_BY_ID = new Map(
  SECTOR_IDS.map((id, index) => [id, index] as const),
);

/**
 * Validate and canonicalize the global sectors completed in real Minecraft.
 * IDs are stored in Atlas row-major order so workspace comparisons stay stable.
 */
export function parseMinecraftExploredSectorIds(
  value: unknown,
): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > OVERWORLD_OVERVIEW_CELL_COUNT
  ) {
    return null;
  }

  const seen = new Set<string>();
  const indexed: Array<{ readonly id: string; readonly index: number }> = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const index = SECTOR_INDEX_BY_ID.get(candidate);
    if (index === undefined || seen.has(candidate)) return null;
    seen.add(candidate);
    indexed.push({ id: candidate, index });
  }
  indexed.sort((left, right) => left.index - right.index);
  return Object.freeze(indexed.map(({ id }) => id));
}

export function withMinecraftExploredSector(
  sectorIds: readonly string[],
  sectorId: string,
  explored: boolean,
): readonly string[] {
  const canonical = parseMinecraftExploredSectorIds(sectorIds);
  if (!canonical) {
    throw new TypeError("La lista de sectores explorados no es válida");
  }
  if (!SECTOR_INDEX_BY_ID.has(sectorId)) {
    throw new RangeError("El sector explorado no existe en el Atlas");
  }
  const currentlyExplored = canonical.includes(sectorId);
  if (currentlyExplored === explored) return canonical;
  return parseMinecraftExploredSectorIds(
    explored
      ? [...canonical, sectorId]
      : canonical.filter((candidate) => candidate !== sectorId),
  )!;
}
