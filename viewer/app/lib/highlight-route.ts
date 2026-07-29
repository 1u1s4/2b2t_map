import type { WorldBounds } from "./exploration-grid.ts";

export const DEFAULT_EXACT_HIGHLIGHT_ROUTE_LIMIT = 14;
export const MAX_EXACT_HIGHLIGHT_ROUTE_LIMIT = 18;
export const DEFAULT_HIGHLIGHT_ROUTE_TWO_OPT_PASSES = 32;
export const MAX_HIGHLIGHT_ROUTE_TWO_OPT_PASSES = 256;
/** Full O(N²) 2-opt scans are reserved for routes at or below this size. */
export const FULL_SCAN_HIGHLIGHT_ROUTE_TWO_OPT_LIMIT = 512;
/** Large routes compare each stop with this many later route positions. */
export const LARGE_HIGHLIGHT_ROUTE_TWO_OPT_WINDOW = 64;
/** Bounds synchronous work when routing the workspace maximum of 10,000. */
export const LARGE_HIGHLIGHT_ROUTE_TWO_OPT_PASSES = 8;
export const HIGHLIGHT_ROUTE_EXPORT_VERSION = 1 as const;

const MAX_ABSOLUTE_WORLD_COORDINATE = 30_000_000;
const TWO_OPT_EPSILON = 1e-9;
const HIGHLIGHT_ROUTE_LABEL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface HighlightRoutePoint {
  readonly id: string;
  readonly title?: string;
  readonly x: number;
  readonly z: number;
}

export interface HighlightRouteOptions {
  /**
   * Held–Karp is exponential, so exact routing is deliberately bounded.
   * Set this to zero to force the heuristic for non-trivial routes.
   */
  readonly exactPointLimit?: number;
  /** Maximum number of best-improvement 2-opt reversals. */
  readonly twoOptMaxPasses?: number;
  /**
   * Fixes the route start to one highlight. Null or undefined preserves the
   * automatic choice nearest the region's upper-left corner.
   */
  readonly startHighlightId?: string | null;
}

export type HighlightRouteAlgorithm =
  | "exact-held-karp"
  | "nearest-neighbor-2-opt";
export type HighlightRouteStartMode = "top-left" | "selected";

export interface HighlightRouteStop<T extends HighlightRoutePoint> {
  /** One-based visit order, ready to render as a numbered marker. */
  readonly order: number;
  readonly label: string;
  readonly highlight: T;
  readonly distanceFromPrevious: number;
  readonly cumulativeDistance: number;
}

export interface HighlightRouteOverlayMarker {
  readonly highlightId: string;
  readonly order: number;
  readonly label: string;
  readonly x: number;
  readonly z: number;
}

export interface HighlightRouteOverlaySegment {
  readonly fromHighlightId: string;
  readonly toHighlightId: string;
  readonly fromOrder: number;
  readonly toOrder: number;
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
  readonly distance: number;
}

export interface HighlightRouteOverlay {
  readonly markers: readonly HighlightRouteOverlayMarker[];
  readonly segments: readonly HighlightRouteOverlaySegment[];
}

export interface HighlightRoutePlan<T extends HighlightRoutePoint> {
  readonly algorithm: HighlightRouteAlgorithm;
  /** True only when the global optimum is known, including trivial routes. */
  readonly optimal: boolean;
  readonly bounds: WorldBounds;
  /**
   * The canvas maps increasing Z downwards, so minX/minZ is the visual
   * upper-left corner used to select the fixed starting highlight.
   */
  readonly startCorner: Readonly<{ x: number; z: number }>;
  readonly startHighlightId: string | null;
  readonly startMode: HighlightRouteStartMode;
  readonly stops: readonly HighlightRouteStop<T>[];
  readonly totalDistance: number;
  readonly twoOptPasses: number;
  readonly overlay: HighlightRouteOverlay;
}

export interface HighlightRouteExportPoint {
  readonly highlightId: string;
  readonly title?: string;
  readonly order: number;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly distanceFromPrevious: number;
  readonly cumulativeDistance: number;
}

export interface HighlightRouteExport {
  readonly version: typeof HIGHLIGHT_ROUTE_EXPORT_VERSION;
  readonly kind: "obsidian-atlas-highlight-route";
  readonly algorithm: HighlightRouteAlgorithm;
  readonly optimal: boolean;
  readonly bounds: WorldBounds;
  readonly startCorner: Readonly<{ x: number; z: number }>;
  readonly startHighlightId: string | null;
  readonly startMode: HighlightRouteStartMode;
  readonly totalDistance: number;
  readonly points: readonly HighlightRouteExportPoint[];
}

interface KdNode {
  pointIndex: number;
  parent: KdNode | null;
  left: KdNode | null;
  right: KdNode | null;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  active: boolean;
  activeCount: number;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Provides a canonical order for every distance tie. Coordinates come before
 * id so equal geometric choices remain stable across input permutations.
 */
function comparePoints(
  left: HighlightRoutePoint,
  right: HighlightRoutePoint,
): number {
  if (left.x !== right.x) return left.x - right.x;
  if (left.z !== right.z) return left.z - right.z;
  return compareStrings(left.id, right.id);
}

function routeDistance(
  left: HighlightRoutePoint,
  right: HighlightRoutePoint,
): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

/**
 * Human-facing route labels use A–Z, then a–z. Once both alphabets are
 * exhausted, the sequence repeats with a numeric suffix: A1…z1, A2…z2, etc.
 */
export function highlightRouteLabel(order: number): string {
  if (!Number.isSafeInteger(order) || order < 1) {
    throw new RangeError("Highlight route order must be a positive integer");
  }
  const zeroBased = order - 1;
  const letter =
    HIGHLIGHT_ROUTE_LABEL_ALPHABET[
      zeroBased % HIGHLIGHT_ROUTE_LABEL_ALPHABET.length
    ];
  const cycle = Math.floor(
    zeroBased / HIGHLIGHT_ROUTE_LABEL_ALPHABET.length,
  );
  return cycle === 0 ? letter : `${letter}${cycle}`;
}

function squaredRouteDistance(
  left: HighlightRoutePoint,
  right: HighlightRoutePoint,
): number {
  const deltaX = right.x - left.x;
  const deltaZ = right.z - left.z;
  return deltaX * deltaX + deltaZ * deltaZ;
}

function assertBounds(bounds: WorldBounds): void {
  const coordinates = [
    bounds.minX,
    bounds.minZ,
    bounds.maxXExclusive,
    bounds.maxZExclusive,
  ];
  if (
    !coordinates.every(
      (coordinate) =>
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= MAX_ABSOLUTE_WORLD_COORDINATE,
    ) ||
    bounds.maxXExclusive <= bounds.minX ||
    bounds.maxZExclusive <= bounds.minZ
  ) {
    throw new RangeError("Highlight route bounds are invalid");
  }
}

function assertOptions(options: HighlightRouteOptions): {
  exactPointLimit: number;
  twoOptMaxPasses: number;
  startHighlightId: string | null;
} {
  const exactPointLimit =
    options.exactPointLimit ?? DEFAULT_EXACT_HIGHLIGHT_ROUTE_LIMIT;
  const twoOptMaxPasses =
    options.twoOptMaxPasses ?? DEFAULT_HIGHLIGHT_ROUTE_TWO_OPT_PASSES;
  const startHighlightId = options.startHighlightId ?? null;

  if (
    !Number.isInteger(exactPointLimit) ||
    exactPointLimit < 0 ||
    exactPointLimit > MAX_EXACT_HIGHLIGHT_ROUTE_LIMIT
  ) {
    throw new RangeError(
      `exactPointLimit must be an integer from 0 to ${MAX_EXACT_HIGHLIGHT_ROUTE_LIMIT}`,
    );
  }
  if (
    !Number.isInteger(twoOptMaxPasses) ||
    twoOptMaxPasses < 0 ||
    twoOptMaxPasses > MAX_HIGHLIGHT_ROUTE_TWO_OPT_PASSES
  ) {
    throw new RangeError(
      `twoOptMaxPasses must be an integer from 0 to ${MAX_HIGHLIGHT_ROUTE_TWO_OPT_PASSES}`,
    );
  }
  if (
    startHighlightId !== null &&
    typeof startHighlightId !== "string"
  ) {
    throw new TypeError("startHighlightId must be a string or null");
  }
  return { exactPointLimit, twoOptMaxPasses, startHighlightId };
}

function canonicalPoints<T extends HighlightRoutePoint>(
  points: readonly T[],
): T[] {
  const seenIds = new Set<string>();
  for (const point of points) {
    if (
      typeof point.id !== "string" ||
      point.id.length === 0 ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.z) ||
      Math.abs(point.x) > MAX_ABSOLUTE_WORLD_COORDINATE ||
      Math.abs(point.z) > MAX_ABSOLUTE_WORLD_COORDINATE
    ) {
      throw new TypeError("Highlight route points are invalid");
    }
    if (seenIds.has(point.id)) {
      throw new TypeError(`Duplicate highlight route id: ${point.id}`);
    }
    seenIds.add(point.id);
  }
  return [...points].sort(comparePoints);
}

function startFirst<T extends HighlightRoutePoint>(
  canonical: readonly T[],
  corner: Readonly<{ x: number; z: number }>,
  selectedHighlightId: string | null,
): { points: T[]; mode: HighlightRouteStartMode } {
  if (selectedHighlightId !== null) {
    const selectedIndex = canonical.findIndex(
      (point) => point.id === selectedHighlightId,
    );
    if (selectedIndex < 0) {
      throw new RangeError(
        `Selected start highlight does not exist: ${selectedHighlightId}`,
      );
    }
    return {
      points: [
        canonical[selectedIndex],
        ...canonical.slice(0, selectedIndex),
        ...canonical.slice(selectedIndex + 1),
      ],
      mode: "selected",
    };
  }
  if (canonical.length <= 1) {
    return { points: [...canonical], mode: "top-left" };
  }
  let startIndex = 0;
  let shortestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < canonical.length; index += 1) {
    const point = canonical[index];
    const distance = Math.hypot(
      point.x - corner.x,
      point.z - corner.z,
    );
    // Canonical order wins exact ties because equal values are not replaced.
    if (distance < shortestDistance) {
      startIndex = index;
      shortestDistance = distance;
    }
  }
  return {
    points: [
      canonical[startIndex],
      ...canonical.slice(0, startIndex),
      ...canonical.slice(startIndex + 1),
    ],
    mode: "top-left",
  };
}

function exactOpenRoute<T extends HighlightRoutePoint>(
  points: readonly T[],
): T[] {
  if (points.length <= 1) return [...points];

  // Point zero is the fixed start; masks only represent the remaining points.
  const remainingCount = points.length - 1;
  const stateCount = 1 << remainingCount;
  const costs = new Float64Array(stateCount * remainingCount);
  const parents = new Int8Array(stateCount * remainingCount);
  costs.fill(Number.POSITIVE_INFINITY);
  parents.fill(-1);

  for (let end = 0; end < remainingCount; end += 1) {
    const mask = 1 << end;
    costs[mask * remainingCount + end] = routeDistance(
      points[0],
      points[end + 1],
    );
  }

  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let end = 0; end < remainingCount; end += 1) {
      const endBit = 1 << end;
      if ((mask & endBit) === 0) continue;
      const previousMask = mask ^ endBit;
      if (previousMask === 0) continue;

      const stateIndex = mask * remainingCount + end;
      let bestCost = Number.POSITIVE_INFINITY;
      let bestPrevious = -1;
      for (
        let previous = 0;
        previous < remainingCount;
        previous += 1
      ) {
        if ((previousMask & (1 << previous)) === 0) continue;
        const candidateCost =
          costs[previousMask * remainingCount + previous] +
          routeDistance(points[previous + 1], points[end + 1]);
        if (
          candidateCost < bestCost ||
          (candidateCost === bestCost && previous < bestPrevious)
        ) {
          bestCost = candidateCost;
          bestPrevious = previous;
        }
      }
      costs[stateIndex] = bestCost;
      parents[stateIndex] = bestPrevious;
    }
  }

  const fullMask = stateCount - 1;
  let bestEnd = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let end = 0; end < remainingCount; end += 1) {
    const candidateCost = costs[fullMask * remainingCount + end];
    if (
      candidateCost < bestCost ||
      (candidateCost === bestCost && end < bestEnd)
    ) {
      bestCost = candidateCost;
      bestEnd = end;
    }
  }

  const reversed: T[] = [];
  let mask = fullMask;
  let end = bestEnd;
  while (end >= 0) {
    reversed.push(points[end + 1]);
    const previous = parents[mask * remainingCount + end];
    mask ^= 1 << end;
    end = previous;
  }
  reversed.reverse();
  return [points[0], ...reversed];
}

function nearestNeighborRoute<T extends HighlightRoutePoint>(
  points: readonly T[],
): T[] {
  if (points.length <= 1) return [...points];
  const nodesByPointIndex: Array<KdNode | undefined> = new Array(
    points.length,
  );
  const root = buildKdTree(
    points,
    Array.from({ length: points.length - 1 }, (_, index) => index + 1),
    0,
    null,
    nodesByPointIndex,
  );
  const route: T[] = [points[0]];
  let currentIndex = 0;

  while (route.length < points.length) {
    const nearestIndex = nearestActiveKdPoint(
      root,
      points,
      points[currentIndex],
    );
    deactivateKdNode(nodesByPointIndex[nearestIndex]);
    route.push(points[nearestIndex]);
    currentIndex = nearestIndex;
  }
  return route;
}

function comparePointIndicesOnAxis<T extends HighlightRoutePoint>(
  points: readonly T[],
  leftIndex: number,
  rightIndex: number,
  axis: 0 | 1,
): number {
  const left = points[leftIndex];
  const right = points[rightIndex];
  const primary =
    axis === 0 ? left.x - right.x : left.z - right.z;
  if (primary !== 0) return primary;
  const secondary =
    axis === 0 ? left.z - right.z : left.x - right.x;
  if (secondary !== 0) return secondary;
  return compareStrings(left.id, right.id);
}

function buildKdTree<T extends HighlightRoutePoint>(
  points: readonly T[],
  pointIndices: number[],
  depth: number,
  parent: KdNode | null,
  nodesByPointIndex: Array<KdNode | undefined>,
): KdNode | null {
  if (pointIndices.length === 0) return null;
  const axis = (depth % 2) as 0 | 1;
  pointIndices.sort((left, right) =>
    comparePointIndicesOnAxis(points, left, right, axis),
  );
  const middle = Math.floor(pointIndices.length / 2);
  const pointIndex = pointIndices[middle];
  const point = points[pointIndex];

  // Bounds and active counts are filled after the two child nodes exist.
  const node: KdNode = {
    pointIndex,
    parent,
    left: null,
    right: null,
    minX: point.x,
    minZ: point.z,
    maxX: point.x,
    maxZ: point.z,
    active: true,
    activeCount: 1,
  };
  node.left = buildKdTree(
    points,
    pointIndices.slice(0, middle),
    depth + 1,
    node,
    nodesByPointIndex,
  );
  node.right = buildKdTree(
    points,
    pointIndices.slice(middle + 1),
    depth + 1,
    node,
    nodesByPointIndex,
  );

  for (const child of [node.left, node.right]) {
    if (child === null) continue;
    node.minX = Math.min(node.minX, child.minX);
    node.minZ = Math.min(node.minZ, child.minZ);
    node.maxX = Math.max(node.maxX, child.maxX);
    node.maxZ = Math.max(node.maxZ, child.maxZ);
    node.activeCount += child.activeCount;
  }
  nodesByPointIndex[pointIndex] = node;
  return node;
}

function squaredDistanceToKdBounds(
  point: HighlightRoutePoint,
  node: KdNode,
): number {
  const deltaX =
    point.x < node.minX
      ? node.minX - point.x
      : point.x > node.maxX
        ? point.x - node.maxX
        : 0;
  const deltaZ =
    point.z < node.minZ
      ? node.minZ - point.z
      : point.z > node.maxZ
        ? point.z - node.maxZ
        : 0;
  return deltaX * deltaX + deltaZ * deltaZ;
}

function nearestActiveKdPoint<T extends HighlightRoutePoint>(
  root: KdNode | null,
  points: readonly T[],
  origin: T,
): number {
  let bestPointIndex = -1;
  let bestSquaredDistance = Number.POSITIVE_INFINITY;

  const visit = (node: KdNode | null): void => {
    if (
      node === null ||
      node.activeCount === 0 ||
      squaredDistanceToKdBounds(origin, node) > bestSquaredDistance
    ) {
      return;
    }

    if (node.active) {
      const candidateDistance = squaredRouteDistance(
        origin,
        points[node.pointIndex],
      );
      if (
        candidateDistance < bestSquaredDistance ||
        (candidateDistance === bestSquaredDistance &&
          (bestPointIndex < 0 || node.pointIndex < bestPointIndex))
      ) {
        bestPointIndex = node.pointIndex;
        bestSquaredDistance = candidateDistance;
      }
    }

    const leftDistance =
      node.left?.activeCount
        ? squaredDistanceToKdBounds(origin, node.left)
        : Number.POSITIVE_INFINITY;
    const rightDistance =
      node.right?.activeCount
        ? squaredDistanceToKdBounds(origin, node.right)
        : Number.POSITIVE_INFINITY;
    if (leftDistance <= rightDistance) {
      visit(node.left);
      visit(node.right);
    } else {
      visit(node.right);
      visit(node.left);
    }
  };

  visit(root);
  if (bestPointIndex < 0) {
    throw new Error("Highlight route spatial index is inconsistent");
  }
  return bestPointIndex;
}

function deactivateKdNode(node: KdNode | undefined): void {
  if (!node?.active) {
    throw new Error("Highlight route spatial index is inconsistent");
  }
  node.active = false;
  let ancestor: KdNode | null = node;
  while (ancestor !== null) {
    ancestor.activeCount -= 1;
    ancestor = ancestor.parent;
  }
}

function improveWithTwoOpt<T extends HighlightRoutePoint>(
  initialRoute: readonly T[],
  maxPasses: number,
): { route: T[]; passes: number } {
  const route = [...initialRoute];
  let passes = 0;
  const windowed =
    route.length > FULL_SCAN_HIGHLIGHT_ROUTE_TWO_OPT_LIMIT;
  const passLimit = windowed
    ? Math.min(maxPasses, LARGE_HIGHLIGHT_ROUTE_TWO_OPT_PASSES)
    : maxPasses;
  const endWindow = windowed
    ? LARGE_HIGHLIGHT_ROUTE_TWO_OPT_WINDOW
    : route.length;

  while (passes < passLimit) {
    let bestStart = -1;
    let bestEnd = -1;
    let bestDelta = -TWO_OPT_EPSILON;

    // Index zero never moves: it is the highlight nearest the start corner.
    for (let start = 1; start < route.length - 1; start += 1) {
      const maximumEnd = Math.min(
        route.length - 1,
        start + endWindow,
      );
      for (let end = start + 1; end <= maximumEnd; end += 1) {
        const beforeStart = route[start - 1];
        const first = route[start];
        const last = route[end];
        const afterEnd =
          end + 1 < route.length ? route[end + 1] : null;
        const oldDistance =
          routeDistance(beforeStart, first) +
          (afterEnd === null ? 0 : routeDistance(last, afterEnd));
        const newDistance =
          routeDistance(beforeStart, last) +
          (afterEnd === null ? 0 : routeDistance(first, afterEnd));
        const delta = newDistance - oldDistance;

        // Loop order (start, then end) is the deterministic tie-break.
        if (delta < bestDelta) {
          bestDelta = delta;
          bestStart = start;
          bestEnd = end;
        }
      }
    }

    if (bestStart < 0) break;
    for (
      let left = bestStart, right = bestEnd;
      left < right;
      left += 1, right -= 1
    ) {
      [route[left], route[right]] = [route[right], route[left]];
    }
    passes += 1;
  }

  return { route, passes };
}

function buildStops<T extends HighlightRoutePoint>(
  route: readonly T[],
): {
  stops: readonly HighlightRouteStop<T>[];
  totalDistance: number;
} {
  let cumulativeDistance = 0;
  const stops = route.map((highlight, index) => {
    const distanceFromPrevious =
      index === 0 ? 0 : routeDistance(route[index - 1], highlight);
    cumulativeDistance += distanceFromPrevious;
    return Object.freeze({
      order: index + 1,
      label: highlightRouteLabel(index + 1),
      highlight,
      distanceFromPrevious,
      cumulativeDistance,
    });
  });
  return {
    stops: Object.freeze(stops),
    totalDistance: cumulativeDistance,
  };
}

function buildOverlay<T extends HighlightRoutePoint>(
  stops: readonly HighlightRouteStop<T>[],
): HighlightRouteOverlay {
  const markers = stops.map((stop) =>
    Object.freeze({
      highlightId: stop.highlight.id,
      order: stop.order,
      label: stop.label,
      x: stop.highlight.x,
      z: stop.highlight.z,
    }),
  );
  const segments = stops.slice(1).map((stop, index) => {
    const previous = stops[index];
    return Object.freeze({
      fromHighlightId: previous.highlight.id,
      toHighlightId: stop.highlight.id,
      fromOrder: previous.order,
      toOrder: stop.order,
      fromX: previous.highlight.x,
      fromZ: previous.highlight.z,
      toX: stop.highlight.x,
      toZ: stop.highlight.z,
      distance: stop.distanceFromPrevious,
    });
  });
  return Object.freeze({
    markers: Object.freeze(markers),
    segments: Object.freeze(segments),
  });
}

/**
 * Plans an open Euclidean TSP route through all supplied point highlights.
 *
 * The first highlight is fixed to the one closest to (minX, minZ). Small
 * inputs use exact Held–Karp dynamic programming; larger inputs use a
 * deterministic, exact nearest-neighbor seed backed by a dynamic k-d tree.
 * Best-improvement 2-opt is exhaustive through 512 points and uses a bounded
 * 64-position window above that threshold, retaining every input point while
 * avoiding an O(N²) scan per pass at the workspace limit of 10,000. The path
 * intentionally does not return to its starting point.
 */
export function planHighlightRoute<T extends HighlightRoutePoint>(
  points: readonly T[],
  bounds: WorldBounds,
  options: HighlightRouteOptions = {},
): HighlightRoutePlan<T> {
  assertBounds(bounds);
  const {
    exactPointLimit,
    twoOptMaxPasses,
    startHighlightId,
  } = assertOptions(options);
  const canonical = canonicalPoints(points);
  const frozenBounds = Object.freeze({ ...bounds });
  const startCorner = Object.freeze({
    x: bounds.minX,
    z: bounds.minZ,
  });
  const start = startFirst(canonical, startCorner, startHighlightId);
  const orderedCandidates = start.points;
  const exact =
    orderedCandidates.length <= 1 ||
    orderedCandidates.length <= exactPointLimit;

  let route: T[];
  let twoOptPasses = 0;
  if (exact) {
    route = exactOpenRoute(orderedCandidates);
  } else {
    const nearest = nearestNeighborRoute(orderedCandidates);
    const improved = improveWithTwoOpt(nearest, twoOptMaxPasses);
    route = improved.route;
    twoOptPasses = improved.passes;
  }

  const { stops, totalDistance } = buildStops(route);
  return Object.freeze({
    algorithm: exact
      ? "exact-held-karp"
      : "nearest-neighbor-2-opt",
    optimal: exact,
    bounds: frozenBounds,
    startCorner,
    startHighlightId: stops[0]?.highlight.id ?? null,
    startMode: start.mode,
    stops,
    totalDistance,
    twoOptPasses,
    overlay: buildOverlay(stops),
  });
}

/**
 * Produces a JSON-safe, numbered export without retaining references to the
 * workspace highlight objects.
 */
export function createHighlightRouteExport<T extends HighlightRoutePoint>(
  plan: HighlightRoutePlan<T>,
): HighlightRouteExport {
  const points = plan.stops.map((stop) => {
    const title = stop.highlight.title;
    return Object.freeze({
      highlightId: stop.highlight.id,
      ...(typeof title === "string" ? { title } : {}),
      order: stop.order,
      label: stop.label,
      x: stop.highlight.x,
      z: stop.highlight.z,
      distanceFromPrevious: stop.distanceFromPrevious,
      cumulativeDistance: stop.cumulativeDistance,
    });
  });
  return Object.freeze({
    version: HIGHLIGHT_ROUTE_EXPORT_VERSION,
    kind: "obsidian-atlas-highlight-route",
    algorithm: plan.algorithm,
    optimal: plan.optimal,
    bounds: Object.freeze({ ...plan.bounds }),
    startCorner: Object.freeze({ ...plan.startCorner }),
    startHighlightId: plan.startHighlightId,
    startMode: plan.startMode,
    totalDistance: plan.totalDistance,
    points: Object.freeze(points),
  });
}
