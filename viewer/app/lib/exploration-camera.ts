import {
  MAX_DETAIL_EXPLORATION_SCALE,
  MAX_EXPLORATION_SCALE,
  cellForIndex,
  clampCameraToExploration,
  minimumSafeExplorationScale,
  type ExplorationCamera,
  type ExplorationState,
  type ExplorationViewport,
} from "./exploration-grid.ts";

export type ExplorationFocusRequest =
  | { readonly mode: "fit" }
  | { readonly mode: "preserve"; readonly scale: number };

export interface ExplorationFocusView {
  readonly camera: ExplorationCamera;
  readonly scale: number;
}

export function resolveAtlasExitView(
  previous: ExplorationFocusView | null,
  hasActiveExploration: boolean,
  fallback: ExplorationFocusView,
): ExplorationFocusView | null {
  if (previous) return previous;
  return hasActiveExploration ? null : fallback;
}

export function formatMapZoom(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "—";
  if (scale >= 0.01) return scale.toFixed(2);
  if (scale >= 0.001) return scale.toFixed(3);
  return scale.toFixed(4);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Centers the current exploration cell while keeping the two camera intents
 * distinct: initial activation fits a full source tile, while navigation
 * preserves the user's zoom.
 */
export function resolveExplorationFocusView(
  state: ExplorationState,
  viewport: ExplorationViewport,
  request: ExplorationFocusRequest,
): ExplorationFocusView {
  const cell = cellForIndex(state.region, state.currentIndex);
  const minimumScale = minimumSafeExplorationScale(
    state.region.tileSpan,
    viewport,
  );
  let scale: number;

  if (request.mode === "preserve") {
    if (!Number.isFinite(request.scale) || request.scale <= 0) {
      throw new RangeError("Preserved exploration scale must be positive");
    }
    scale = clamp(
      request.scale,
      minimumScale,
      MAX_EXPLORATION_SCALE,
    );
  } else {
    const mobile = viewport.width <= 720;
    const horizontalInset = mobile ? 96 : 500;
    const verticalInset = mobile ? 220 : 160;
    const availableWidth = Math.max(
      220,
      viewport.width - horizontalInset,
    );
    const availableHeight = Math.max(
      220,
      viewport.height - verticalInset,
    );
    const fitScale = Math.min(
      availableWidth / state.region.tileSpan,
      availableHeight / state.region.tileSpan,
    );
    scale = clamp(
      Math.min(state.region.scale, fitScale),
      minimumScale,
      MAX_DETAIL_EXPLORATION_SCALE,
    );
  }

  const camera = clampCameraToExploration(
    {
      x: (cell.bounds.minX + cell.bounds.maxXExclusive) / 2,
      z: (cell.bounds.minZ + cell.bounds.maxZExclusive) / 2,
    },
    state.region.bounds,
    state.region.tileSpan,
    scale,
    viewport,
  );
  return Object.freeze({
    camera: Object.freeze(camera),
    scale,
  });
}
