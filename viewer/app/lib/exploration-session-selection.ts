import {
  EXPLORATION_DIMENSION,
  deserializeExplorationState,
  type ExplorationState,
  type WorldBounds,
} from "./exploration-grid.ts";

/**
 * Minimal persisted-session shape needed to resume an exploration. Keeping
 * this structural avoids coupling selection logic to a particular workspace
 * transport or store implementation.
 */
export interface PersistedExplorationSession {
  readonly id: string;
  readonly state: unknown;
}

export interface ExplorationSelectionTarget {
  readonly dimension: typeof EXPLORATION_DIMENSION;
  readonly lod: number;
  readonly bounds: WorldBounds;
}

export interface ExplorationSelectionResolution {
  readonly state: ExplorationState;
  readonly resumed: boolean;
}

type PersistedExplorationSignature = {
  readonly dimension?: unknown;
  readonly region?: {
    readonly lod?: unknown;
    readonly bounds?: {
      readonly minX?: unknown;
      readonly minZ?: unknown;
      readonly maxXExclusive?: unknown;
      readonly maxZExclusive?: unknown;
    };
  };
};

function hasExactSelectionSignature(
  session: PersistedExplorationSession,
  target: ExplorationSelectionTarget,
): boolean {
  if (typeof session.state !== "object" || session.state === null) {
    return false;
  }
  const persisted = session.state as PersistedExplorationSignature;
  const bounds = persisted.region?.bounds;
  return (
    persisted.dimension === EXPLORATION_DIMENSION &&
    persisted.dimension === target.dimension &&
    persisted.region?.lod === target.lod &&
    bounds?.minX === target.bounds.minX &&
    bounds.minZ === target.bounds.minZ &&
    bounds.maxXExclusive === target.bounds.maxXExclusive &&
    bounds.maxZExclusive === target.bounds.maxZExclusive
  );
}

/**
 * Resume the persisted session for an exact Atlas selection, or create one
 * when that region has never been explored. Bounds are half-open, so all four
 * endpoints must match; overlap or adjacency is never enough.
 */
export function resolveExplorationSelection(
  sessions: readonly PersistedExplorationSession[],
  target: ExplorationSelectionTarget,
  create: (target: ExplorationSelectionTarget) => ExplorationState,
): ExplorationSelectionResolution {
  const persisted = sessions.find((session) =>
    hasExactSelectionSignature(session, target),
  );
  if (persisted) {
    const state = deserializeExplorationState(
      JSON.stringify(persisted.state),
    );
    if (persisted.id !== state.region.id) {
      throw new Error(
        "El identificador de la sesión persistida no coincide con su estado",
      );
    }
    return { state, resumed: true };
  }
  return { state: create(target), resumed: false };
}
