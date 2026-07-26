import {
  cellForIndex,
  cellIndexAtWorld,
  deserializeExplorationState,
  serializeExplorationState,
  withCellsReviewed,
  type ExplorationState,
} from "./exploration-grid.ts";

export interface WorkspaceExplorationRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: unknown;
}

export interface WorkspaceContentRecord<
  Exploration extends WorkspaceExplorationRecord = WorkspaceExplorationRecord,
  Highlight = unknown,
  CoverageSelection = unknown,
> {
  readonly schemaVersion: 1;
  readonly activeExplorationId: string | null;
  readonly explorations: readonly Exploration[];
  readonly highlights: readonly Highlight[];
  readonly coverageSelection: CoverageSelection | null;
}

function stateFor(
  exploration: WorkspaceExplorationRecord,
): ExplorationState {
  return deserializeExplorationState(JSON.stringify(exploration.state));
}

function isReviewed(bits: Uint8Array, index: number): boolean {
  return (bits[index >>> 3] & (1 << (index & 7))) !== 0;
}

function compareCandidates(
  left: WorkspaceExplorationRecord,
  right: WorkspaceExplorationRecord,
  activeExplorationId: string | null,
  leftReviewedCount: number,
  rightReviewedCount: number,
): number {
  const reviewedDelta = rightReviewedCount - leftReviewedCount;
  if (reviewedDelta !== 0) return reviewedDelta;
  const leftActive = left.id === activeExplorationId ? 1 : 0;
  const rightActive = right.id === activeExplorationId ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;
  const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;
  const createdDelta = right.createdAt.localeCompare(left.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

function reviewedIndexesMappedTo(
  source: ExplorationState,
  target: ExplorationState,
): number[] {
  if (
    source.region.dimension !== target.region.dimension ||
    source.region.lod !== target.region.lod
  ) {
    return [];
  }
  const mapped = new Set<number>();
  for (let index = 0; index < source.region.cellCount; index += 1) {
    if (!isReviewed(source.reviewed, index)) continue;
    const cell = cellForIndex(source.region, index);
    const targetIndex = cellIndexAtWorld(
      target.region,
      cell.bounds.minX,
      cell.bounds.minZ,
    );
    if (targetIndex !== null) mapped.add(targetIndex);
  }
  return [...mapped];
}

/**
 * Reduce a legacy list to one useful session. Human review progress is the
 * primary signal, then the active session and recency. Reviewed cells from
 * overlapping LOD peers are unioned by world coordinate. Skipped/404 cells
 * are intentionally not imported from discarded sessions because they must
 * remain tied to the catalog that originally verified them.
 */
export function consolidateWorkspaceExplorations<
  Exploration extends WorkspaceExplorationRecord,
>(
  explorations: readonly Exploration[],
  activeExplorationId: string | null,
): Exploration | null {
  if (explorations.length === 0) return null;
  const ordered = explorations
    .map((exploration) => ({
      exploration,
      state: stateFor(exploration),
    }))
    .sort((left, right) =>
      compareCandidates(
        left.exploration,
        right.exploration,
        activeExplorationId,
        left.state.reviewedCount,
        right.state.reviewedCount,
      ),
    );
  const selected = ordered[0];
  let mergedState = selected.state;
  let mergedUpdatedAt = selected.exploration.updatedAt;

  for (const source of ordered) {
    const mapped = reviewedIndexesMappedTo(source.state, mergedState);
    if (mapped.length === 0) continue;
    const before = mergedState.reviewedCount;
    mergedState = withCellsReviewed(mergedState, mapped);
    if (
      mergedState.reviewedCount > before &&
      source.exploration.updatedAt > mergedUpdatedAt
    ) {
      mergedUpdatedAt = source.exploration.updatedAt;
    }
  }

  const serialized = JSON.parse(
    serializeExplorationState(mergedState),
  ) as Exploration["state"];
  return {
    ...selected.exploration,
    id: mergedState.region.id,
    updatedAt: mergedUpdatedAt,
    state: serialized,
  } as Exploration;
}

export function consolidateSingleWorkspaceContent<
  Exploration extends WorkspaceExplorationRecord,
  Highlight,
  CoverageSelection,
>(
  content: WorkspaceContentRecord<
    Exploration,
    Highlight,
    CoverageSelection
  >,
): WorkspaceContentRecord<Exploration, Highlight, CoverageSelection> {
  const exploration = consolidateWorkspaceExplorations(
    content.explorations,
    content.activeExplorationId,
  );
  const keepActive =
    content.activeExplorationId !== null ||
    content.explorations.length > 1;
  return {
    ...content,
    activeExplorationId:
      exploration && keepActive ? exploration.id : null,
    explorations: exploration ? [exploration] : [],
  };
}

function richerDuplicate<
  Exploration extends WorkspaceExplorationRecord,
>(
  left: Exploration,
  right: Exploration,
  activeExplorationId: string | null,
): Exploration {
  const leftState = stateFor(left);
  const rightState = stateFor(right);
  return compareCandidates(
    left,
    right,
    activeExplorationId,
    leftState.reviewedCount,
    rightState.reviewedCount,
  ) <= 0
    ? left
    : right;
}

/**
 * Combine independently valid legacy snapshots before the server performs the
 * one-session migration. The first snapshot has preference for metadata that
 * has no update timestamp (highlights and coverage selection).
 */
export function mergeWorkspaceContentCandidates<
  Exploration extends WorkspaceExplorationRecord,
  Highlight extends { readonly id: string },
  CoverageSelection,
>(
  candidates: readonly WorkspaceContentRecord<
    Exploration,
    Highlight,
    CoverageSelection
  >[],
): WorkspaceContentRecord<Exploration, Highlight, CoverageSelection> {
  const first = candidates[0];
  if (!first) {
    return {
      schemaVersion: 1,
      activeExplorationId: null,
      explorations: [],
      highlights: [],
      coverageSelection: null,
    };
  }
  const activeExplorationId =
    candidates.find((candidate) => candidate.activeExplorationId !== null)
      ?.activeExplorationId ?? null;
  const explorationsById = new Map<string, Exploration>();
  for (const candidate of candidates) {
    for (const exploration of candidate.explorations) {
      const existing = explorationsById.get(exploration.id);
      explorationsById.set(
        exploration.id,
        existing
          ? richerDuplicate(existing, exploration, activeExplorationId)
          : exploration,
      );
    }
  }
  const highlightsById = new Map<string, Highlight>();
  for (const candidate of candidates) {
    for (const highlight of candidate.highlights) {
      if (!highlightsById.has(highlight.id)) {
        highlightsById.set(highlight.id, highlight);
      }
    }
  }
  return {
    schemaVersion: 1,
    activeExplorationId:
      activeExplorationId &&
      explorationsById.has(activeExplorationId)
        ? activeExplorationId
        : null,
    explorations: [...explorationsById.values()],
    highlights: [...highlightsById.values()],
    coverageSelection:
      candidates.find((candidate) => candidate.coverageSelection !== null)
        ?.coverageSelection ?? null,
  };
}
