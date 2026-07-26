/**
 * Pure model for reviewing a bounded Overworld region one source tile at a
 * time. World bounds are half-open and are expanded to full 512px source tiles
 * at the selected LOD.
 */

export const EXPLORATION_GRID_VERSION = 1 as const;
export const EXPLORATION_DIMENSION = "overworld" as const;
export const MIN_EXPLORATION_LOD = 0;
export const MAX_EXPLORATION_LOD = 10;
export const TILE_SIZE_PIXELS = 512;
/** Canonical source resolution for every newly-created exploration. */
export const MAX_DETAIL_EXPLORATION_LOD = 0 as const;
/** One world block per rendered pixel while inspecting an LOD-0 tile. */
export const MAX_DETAIL_EXPLORATION_SCALE = 1 as const;
/** Rendering budget while an exact-detail session is active. */
export const MAX_VISIBLE_EXPLORATION_COLUMNS = 8;
export const MAX_VISIBLE_EXPLORATION_ROWS = 6;
export const WORLD_MIN_BLOCK = -30_000_000;
export const WORLD_MAX_BLOCK_EXCLUSIVE = 30_000_000;
export const MIN_EXPLORATION_SCALE = 1 / 1_500;
export const MAX_EXPLORATION_SCALE = 8;

/**
 * 1,048,576 cells use a 128 KB bitset (about 171 KB when exported as
 * base64url). This matches the bounded regional downloader while keeping a
 * complete session comfortably below browser storage and JSON parsing limits.
 */
export const MAX_EXPLORATION_CELLS = 1_048_576;
export const MAX_SERIALIZED_EXPLORATION_CHARS = 2_000_000;

const MAX_REGION_ID_LENGTH = 100;
const MAX_REGION_NAME_LENGTH = 200;
const REGION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type CardinalDirection = "north" | "east" | "south" | "west";

export interface WorldBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxXExclusive: number;
  readonly maxZExclusive: number;
}

export interface ExplorationViewport {
  readonly width: number;
  readonly height: number;
}

export interface ExplorationCamera {
  readonly x: number;
  readonly z: number;
}

/**
 * Keeps the exact LOD tile loop bounded even when the user zooms out. The
 * renderer adds a one-tile margin around this viewport, so 8×6 also remains
 * below the in-memory tile-cache budget with all three layers visible.
 */
export function minimumSafeExplorationScale(
  tileSpan: number,
  viewport: ExplorationViewport,
): number {
  if (
    !Number.isFinite(tileSpan) ||
    tileSpan <= 0 ||
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new RangeError("Tile span and viewport must be positive");
  }
  return Math.max(
    MIN_EXPLORATION_SCALE,
    viewport.width / (tileSpan * MAX_VISIBLE_EXPLORATION_COLUMNS),
    viewport.height / (tileSpan * MAX_VISIBLE_EXPLORATION_ROWS),
  );
}

/**
 * Keeps the visible viewport within the selected region plus one neighboring
 * cell of context. If the viewport is larger than an axis, that axis is
 * centered instead of producing an invalid clamp interval.
 */
export function clampCameraToExploration(
  camera: ExplorationCamera,
  bounds: WorldBounds,
  tileSpan: number,
  scale: number,
  viewport: ExplorationViewport,
): ExplorationCamera {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Scale must be positive");
  }
  const halfWidth = viewport.width / (2 * scale);
  const halfHeight = viewport.height / (2 * scale);
  const outerMinX = bounds.minX - tileSpan;
  const outerMaxX = bounds.maxXExclusive + tileSpan;
  const outerMinZ = bounds.minZ - tileSpan;
  const outerMaxZ = bounds.maxZExclusive + tileSpan;

  const clampAxis = (
    value: number,
    outerMinimum: number,
    outerMaximum: number,
    halfExtent: number,
  ) => {
    const minimum = outerMinimum + halfExtent;
    const maximum = outerMaximum - halfExtent;
    if (minimum > maximum) return (outerMinimum + outerMaximum) / 2;
    return Math.min(maximum, Math.max(minimum, value));
  };

  return {
    x: clampAxis(camera.x, outerMinX, outerMaxX, halfWidth),
    z: clampAxis(camera.z, outerMinZ, outerMaxZ, halfHeight),
  };
}

export interface ExplorationRegionInput {
  readonly id: string;
  readonly name: string;
  /**
   * Requested half-open bounds. They are expanded outwards to tile boundaries.
   */
  readonly bounds: WorldBounds;
  readonly lod: number;
  /** Exact map scale to restore and hold while this region is active. */
  readonly scale: number;
}

export type MaxDetailExplorationInput = Pick<
  ExplorationRegionInput,
  "id" | "name" | "bounds"
>;

export interface ExplorationRegion {
  readonly version: typeof EXPLORATION_GRID_VERSION;
  readonly dimension: typeof EXPLORATION_DIMENSION;
  readonly id: string;
  readonly name: string;
  readonly bounds: WorldBounds;
  readonly lod: number;
  readonly scale: number;
  readonly tileSpan: number;
  readonly minTileX: number;
  readonly minTileZ: number;
  readonly maxTileXExclusive: number;
  readonly maxTileZExclusive: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellCount: number;
}

export interface ExplorationCell {
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly bounds: WorldBounds;
}

export interface ExplorationState {
  readonly region: ExplorationRegion;
  /** Row-major cell index. */
  readonly currentIndex: number;
  /**
   * Whether the current cell had already been reviewed before it became the
   * current selection. A first visit can therefore count toward progress
   * without obscuring the map; returning to that cell restores its reviewed
   * fill.
   */
  readonly currentCellPreviouslyReviewed: boolean;
  /**
   * Bit N represents row-major cell N. Callers must treat this byte array as
   * immutable; state-changing helpers return a defensive copy.
   */
  readonly reviewed: Uint8Array;
  readonly reviewedCount: number;
  /** Confirmed source absences, kept separate from human review progress. */
  readonly skipped: Uint8Array;
  readonly skippedCount: number;
}

type SerializedExplorationState = {
  readonly version: typeof EXPLORATION_GRID_VERSION;
  readonly dimension: typeof EXPLORATION_DIMENSION;
  readonly region: {
    readonly id: string;
    readonly name: string;
    readonly bounds: WorldBounds;
    readonly lod: number;
    readonly scale: number;
  };
  readonly currentIndex: number;
  /** Optional so earlier version-1 exports remain readable. */
  readonly currentCellPreviouslyReviewed?: boolean;
  readonly reviewedCount: number;
  readonly reviewedBits: string;
  /** Optional only so version-1 exports from earlier builds remain readable. */
  readonly skippedCount?: number;
  readonly skippedBits?: string;
};

export class ExplorationGridError extends Error {
  readonly code:
    | "INVALID_REGION"
    | "TOO_MANY_CELLS"
    | "INVALID_CELL"
    | "INVALID_STATE"
    | "INVALID_SERIALIZATION";

  constructor(
    message: string,
    code:
      | "INVALID_REGION"
      | "TOO_MANY_CELLS"
      | "INVALID_CELL"
      | "INVALID_STATE"
      | "INVALID_SERIALIZATION",
  ) {
    super(message);
    this.name = "ExplorationGridError";
    this.code = code;
  }
}

function fail(
  message: string,
  code: ExplorationGridError["code"] = "INVALID_REGION",
): never {
  throw new ExplorationGridError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${label} debe ser un entero seguro`);
  }
}

function assertCellIndex(region: ExplorationRegion, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= region.cellCount) {
    fail(
      `Índice de celda fuera de rango: ${String(index)}`,
      "INVALID_CELL",
    );
  }
}

function assertWorldBounds(bounds: unknown): asserts bounds is WorldBounds {
  if (!isRecord(bounds)) {
    fail("Los límites de la región deben ser un objeto");
  }

  assertSafeInteger(bounds.minX, "minX");
  assertSafeInteger(bounds.minZ, "minZ");
  assertSafeInteger(bounds.maxXExclusive, "maxXExclusive");
  assertSafeInteger(bounds.maxZExclusive, "maxZExclusive");

  if (
    bounds.minX < WORLD_MIN_BLOCK ||
    bounds.minZ < WORLD_MIN_BLOCK ||
    bounds.maxXExclusive > WORLD_MAX_BLOCK_EXCLUSIVE ||
    bounds.maxZExclusive > WORLD_MAX_BLOCK_EXCLUSIVE
  ) {
    fail(
      `La región debe estar dentro de [${WORLD_MIN_BLOCK}, ${WORLD_MAX_BLOCK_EXCLUSIVE})`,
    );
  }
  if (
    bounds.minX >= bounds.maxXExclusive ||
    bounds.minZ >= bounds.maxZExclusive
  ) {
    fail("Los límites half-open deben tener ancho y alto positivos");
  }
}

function assertRegionIdentity(id: unknown, name: unknown): {
  id: string;
  name: string;
} {
  if (
    typeof id !== "string" ||
    id.length > MAX_REGION_ID_LENGTH ||
    !REGION_ID_PATTERN.test(id)
  ) {
    fail(
      "El id de región debe usar únicamente letras, números, punto, guion, guion bajo o dos puntos",
    );
  }
  if (
    typeof name !== "string" ||
    name.trim() !== name ||
    name.length === 0 ||
    name.length > MAX_REGION_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    fail("El nombre de región no es válido");
  }
  return { id, name };
}

export function blocksPerExplorationTile(lod: number): number {
  if (
    !Number.isSafeInteger(lod) ||
    lod < MIN_EXPLORATION_LOD ||
    lod > MAX_EXPLORATION_LOD
  ) {
    fail(
      `LOD debe estar entre ${MIN_EXPLORATION_LOD} y ${MAX_EXPLORATION_LOD}`,
    );
  }
  return TILE_SIZE_PIXELS * 2 ** lod;
}

export function explorationLodForScale(scale: number): number {
  if (
    !Number.isFinite(scale) ||
    scale < MIN_EXPLORATION_SCALE ||
    scale > MAX_EXPLORATION_SCALE
  ) {
    fail(
      `La escala debe estar entre ${MIN_EXPLORATION_SCALE} y ${MAX_EXPLORATION_SCALE}`,
    );
  }
  return Math.min(
    MAX_EXPLORATION_LOD,
    Math.max(MIN_EXPLORATION_LOD, Math.floor(Math.log2(1 / scale))),
  );
}

/**
 * Convert a world block coordinate to its source tile. Math.floor is
 * intentional: tile -1 owns [-span, 0), including negative coordinates close
 * to zero.
 */
export function worldBlockToExplorationTile(
  coordinate: number,
  lod: number,
): number {
  if (!Number.isFinite(coordinate)) {
    fail("La coordenada debe ser finita");
  }
  return Math.floor(coordinate / blocksPerExplorationTile(lod));
}

export function createExplorationRegion(
  input: ExplorationRegionInput,
): ExplorationRegion {
  if (!isRecord(input)) {
    fail("La región debe ser un objeto");
  }
  const identity = assertRegionIdentity(input.id, input.name);
  assertWorldBounds(input.bounds);
  const tileSpan = blocksPerExplorationTile(input.lod);

  if (
    !Number.isFinite(input.scale) ||
    input.scale < MIN_EXPLORATION_SCALE ||
    input.scale > MAX_EXPLORATION_SCALE
  ) {
    fail(
      `La escala debe estar entre ${MIN_EXPLORATION_SCALE} y ${MAX_EXPLORATION_SCALE}`,
    );
  }
  if (explorationLodForScale(input.scale) !== input.lod) {
    fail(
      `La escala ${input.scale} corresponde a LOD ${explorationLodForScale(input.scale)}, no a LOD ${input.lod}`,
    );
  }

  const minTileX = Math.floor(input.bounds.minX / tileSpan);
  const minTileZ = Math.floor(input.bounds.minZ / tileSpan);
  // Subtracting one preserves the half-open maximum when it lies exactly on a
  // tile boundary, including for negative coordinates.
  const maxTileXExclusive =
    Math.floor((input.bounds.maxXExclusive - 1) / tileSpan) + 1;
  const maxTileZExclusive =
    Math.floor((input.bounds.maxZExclusive - 1) / tileSpan) + 1;
  const columns = maxTileXExclusive - minTileX;
  const rows = maxTileZExclusive - minTileZ;

  if (
    columns <= 0 ||
    rows <= 0 ||
    columns > Number.MAX_SAFE_INTEGER / rows
  ) {
    fail("La cantidad de celdas no es un entero seguro", "TOO_MANY_CELLS");
  }
  const cellCount = columns * rows;
  if (cellCount > MAX_EXPLORATION_CELLS) {
    fail(
      `La región contiene ${cellCount.toLocaleString("en-US")} celdas; el máximo seguro es ${MAX_EXPLORATION_CELLS.toLocaleString("en-US")}. Divide la región en selecciones más pequeñas.`,
      "TOO_MANY_CELLS",
    );
  }

  const bounds = Object.freeze({
    minX: minTileX * tileSpan,
    minZ: minTileZ * tileSpan,
    maxXExclusive: maxTileXExclusive * tileSpan,
    maxZExclusive: maxTileZExclusive * tileSpan,
  });

  return Object.freeze({
    version: EXPLORATION_GRID_VERSION,
    dimension: EXPLORATION_DIMENSION,
    ...identity,
    bounds,
    lod: input.lod,
    scale: input.scale,
    tileSpan,
    minTileX,
    minTileZ,
    maxTileXExclusive,
    maxTileZExclusive,
    columns,
    rows,
    cellCount,
  });
}

export function cellForIndex(
  region: ExplorationRegion,
  index: number,
): ExplorationCell {
  assertCellIndex(region, index);
  const row = Math.floor(index / region.columns);
  const column = index % region.columns;
  const tileX = region.minTileX + column;
  const tileZ = region.minTileZ + row;
  const minX = tileX * region.tileSpan;
  const minZ = tileZ * region.tileSpan;

  return Object.freeze({
    index,
    row,
    column,
    tileX,
    tileZ,
    bounds: Object.freeze({
      minX,
      minZ,
      maxXExclusive: minX + region.tileSpan,
      maxZExclusive: minZ + region.tileSpan,
    }),
  });
}

export function cellIndexAtTile(
  region: ExplorationRegion,
  tileX: number,
  tileZ: number,
): number | null {
  if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileZ)) return null;
  const column = tileX - region.minTileX;
  const row = tileZ - region.minTileZ;
  if (
    column < 0 ||
    column >= region.columns ||
    row < 0 ||
    row >= region.rows
  ) {
    return null;
  }
  return row * region.columns + column;
}

export function cellIndexAtWorld(
  region: ExplorationRegion,
  x: number,
  z: number,
): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return cellIndexAtTile(
    region,
    Math.floor(x / region.tileSpan),
    Math.floor(z / region.tileSpan),
  );
}

export function cardinalNeighbor(
  region: ExplorationRegion,
  index: number,
  direction: CardinalDirection,
): number | null {
  const cell = cellForIndex(region, index);
  const delta =
    direction === "north"
      ? { column: 0, row: -1 }
      : direction === "east"
        ? { column: 1, row: 0 }
        : direction === "south"
          ? { column: 0, row: 1 }
          : direction === "west"
            ? { column: -1, row: 0 }
            : null;
  if (delta === null) {
    fail(`Dirección cardinal desconocida: ${String(direction)}`, "INVALID_CELL");
  }
  return cellIndexAtTile(
    region,
    cell.tileX + delta.column,
    cell.tileZ + delta.row,
  );
}

export function cellIndexAtSerpentinePosition(
  region: ExplorationRegion,
  position: number,
): number {
  assertCellIndex(region, position);
  const row = Math.floor(position / region.columns);
  const offset = position % region.columns;
  const column = row % 2 === 0 ? offset : region.columns - 1 - offset;
  return row * region.columns + column;
}

export function serpentinePositionForCellIndex(
  region: ExplorationRegion,
  index: number,
): number {
  const cell = cellForIndex(region, index);
  const offset =
    cell.row % 2 === 0
      ? cell.column
      : region.columns - 1 - cell.column;
  return cell.row * region.columns + offset;
}

export function serpentineNeighbor(
  region: ExplorationRegion,
  index: number,
  step: -1 | 1,
): number | null {
  if (step !== -1 && step !== 1) {
    fail("El paso serpentina debe ser -1 o 1", "INVALID_CELL");
  }
  const nextPosition = serpentinePositionForCellIndex(region, index) + step;
  if (nextPosition < 0 || nextPosition >= region.cellCount) return null;
  return cellIndexAtSerpentinePosition(region, nextPosition);
}

function cellBitsetByteLength(cellCount: number): number {
  return Math.ceil(cellCount / 8);
}

function bitLocation(index: number): { byte: number; mask: number } {
  return {
    byte: Math.floor(index / 8),
    mask: 1 << (index % 8),
  };
}

function popcountByte(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function countCellBits(bits: Uint8Array): number {
  let count = 0;
  for (const value of bits) count += popcountByte(value);
  return count;
}

function assertCanonicalCellBits(
  region: ExplorationRegion,
  bits: Uint8Array,
  label: string,
): void {
  const expectedBytes = cellBitsetByteLength(region.cellCount);
  if (!(bits instanceof Uint8Array) || bits.byteLength !== expectedBytes) {
    fail(`El bitset ${label} tiene un tamaño incompatible`, "INVALID_STATE");
  }
  const remainder = region.cellCount % 8;
  if (remainder !== 0 && bits.byteLength > 0) {
    const allowedMask = (1 << remainder) - 1;
    if ((bits[bits.byteLength - 1] & ~allowedMask) !== 0) {
      fail(
        `El bitset ${label} contiene bits fuera de la región`,
        "INVALID_STATE",
      );
    }
  }
}

export function createExplorationState(
  input: ExplorationRegionInput | ExplorationRegion,
): ExplorationState {
  const region =
    "cellCount" in input ? validateCanonicalRegion(input) : createExplorationRegion(input);
  return Object.freeze({
    region,
    currentIndex: 0,
    currentCellPreviouslyReviewed: false,
    reviewed: new Uint8Array(cellBitsetByteLength(region.cellCount)),
    reviewedCount: 0,
    skipped: new Uint8Array(cellBitsetByteLength(region.cellCount)),
    skippedCount: 0,
  });
}

/**
 * Create a new exploration at the only resolution used by the current
 * source-to-local workflow. The generic constructors and deserializer remain
 * intentionally LOD-aware so existing workspaces from older versions can
 * still be restored without changing their meaning.
 */
export function createMaxDetailExplorationState(
  input: MaxDetailExplorationInput,
): ExplorationState {
  return createExplorationState({
    id: input.id,
    name: input.name,
    bounds: input.bounds,
    lod: MAX_DETAIL_EXPLORATION_LOD,
    scale: MAX_DETAIL_EXPLORATION_SCALE,
  });
}

export function isCellReviewed(
  state: ExplorationState,
  index: number,
): boolean {
  assertCellIndex(state.region, index);
  assertCanonicalCellBits(state.region, state.reviewed, "revisado");
  const location = bitLocation(index);
  return (state.reviewed[location.byte] & location.mask) !== 0;
}

export function isCellSkipped(
  state: ExplorationState,
  index: number,
): boolean {
  assertCellIndex(state.region, index);
  assertCanonicalCellBits(state.region, state.skipped, "sin datos");
  const location = bitLocation(index);
  return (state.skipped[location.byte] & location.mask) !== 0;
}

export type ExplorationCellAppearance =
  | "current-new"
  | "current-reviewed"
  | "reviewed"
  | "pending";

export function explorationCellAppearance(
  state: ExplorationState,
  index: number,
): ExplorationCellAppearance {
  assertExplorationState(state);
  assertCellIndex(state.region, index);
  const reviewed = isCellReviewed(state, index);
  if (index === state.currentIndex) {
    return reviewed && state.currentCellPreviouslyReviewed
      ? "current-reviewed"
      : "current-new";
  }
  return reviewed ? "reviewed" : "pending";
}

export function withCellReviewed(
  state: ExplorationState,
  index: number,
  reviewed = true,
): ExplorationState {
  assertExplorationState(state);
  assertCellIndex(state.region, index);
  const location = bitLocation(index);
  const currentlyReviewed =
    (state.reviewed[location.byte] & location.mask) !== 0;
  if (currentlyReviewed === reviewed) return state;

  const nextBits = state.reviewed.slice();
  const nextSkipped = state.skipped.slice();
  const currentlySkipped =
    (state.skipped[location.byte] & location.mask) !== 0;
  if (reviewed) {
    nextBits[location.byte] |= location.mask;
    if (currentlySkipped) nextSkipped[location.byte] &= ~location.mask;
  } else {
    nextBits[location.byte] &= ~location.mask;
  }
  return Object.freeze({
    ...state,
    currentCellPreviouslyReviewed:
      !reviewed && index === state.currentIndex
        ? false
        : state.currentCellPreviouslyReviewed,
    reviewed: nextBits,
    reviewedCount: state.reviewedCount + (reviewed ? 1 : -1),
    skipped: nextSkipped,
    skippedCount:
      state.skippedCount - (reviewed && currentlySkipped ? 1 : 0),
  });
}

export function withCurrentCellReviewed(
  state: ExplorationState,
  reviewed = true,
): ExplorationState {
  return withCellReviewed(state, state.currentIndex, reviewed);
}

export function withCellSkipped(
  state: ExplorationState,
  index: number,
  skipped = true,
): ExplorationState {
  assertExplorationState(state);
  assertCellIndex(state.region, index);
  const location = bitLocation(index);
  const currentlySkipped =
    (state.skipped[location.byte] & location.mask) !== 0;
  if (currentlySkipped === skipped) return state;

  const nextSkipped = state.skipped.slice();
  const nextReviewed = state.reviewed.slice();
  const currentlyReviewed =
    (state.reviewed[location.byte] & location.mask) !== 0;
  if (skipped) {
    nextSkipped[location.byte] |= location.mask;
    if (currentlyReviewed) nextReviewed[location.byte] &= ~location.mask;
  } else {
    nextSkipped[location.byte] &= ~location.mask;
  }
  return Object.freeze({
    ...state,
    currentCellPreviouslyReviewed:
      skipped && index === state.currentIndex
        ? false
        : state.currentCellPreviouslyReviewed,
    reviewed: nextReviewed,
    reviewedCount:
      state.reviewedCount - (skipped && currentlyReviewed ? 1 : 0),
    skipped: nextSkipped,
    skippedCount: state.skippedCount + (skipped ? 1 : -1),
  });
}

export function withCurrentCellSkipped(
  state: ExplorationState,
  skipped = true,
): ExplorationState {
  return withCellSkipped(state, state.currentIndex, skipped);
}

/**
 * Apply a known-absent inventory in one immutable update. This is used when a
 * complete regional download has already resolved every 404 before exploration
 * begins, so no per-cell confirmation is necessary.
 */
export function withCellsSkipped(
  state: ExplorationState,
  indexes: Iterable<number>,
): ExplorationState {
  assertExplorationState(state);
  const nextSkipped = state.skipped.slice();
  const nextReviewed = state.reviewed.slice();
  let skippedCount = state.skippedCount;
  let reviewedCount = state.reviewedCount;
  let currentCellPreviouslyReviewed =
    state.currentCellPreviouslyReviewed;
  let changed = false;

  for (const index of indexes) {
    assertCellIndex(state.region, index);
    const location = bitLocation(index);
    if ((nextSkipped[location.byte] & location.mask) !== 0) continue;
    nextSkipped[location.byte] |= location.mask;
    skippedCount += 1;
    changed = true;
    if ((nextReviewed[location.byte] & location.mask) !== 0) {
      nextReviewed[location.byte] &= ~location.mask;
      reviewedCount -= 1;
    }
    if (index === state.currentIndex) {
      currentCellPreviouslyReviewed = false;
    }
  }

  return changed
    ? Object.freeze({
        ...state,
        currentCellPreviouslyReviewed,
        reviewed: nextReviewed,
        reviewedCount,
        skipped: nextSkipped,
        skippedCount,
      })
    : state;
}

export function withCurrentIndex(
  state: ExplorationState,
  index: number,
): ExplorationState {
  assertExplorationState(state);
  assertCellIndex(state.region, index);
  if (index === state.currentIndex) return state;
  return Object.freeze({
    ...state,
    currentIndex: index,
    currentCellPreviouslyReviewed: isCellReviewed(state, index),
  });
}

/**
 * Select a cell and count that visit exactly once. Known-absent cells remain
 * skipped and are never converted into reviewed cells.
 */
export function withVisitedIndex(
  state: ExplorationState,
  index: number,
): ExplorationState {
  const selected = withCurrentIndex(state, index);
  return isCellSkipped(selected, index)
    ? selected
    : withCellReviewed(selected, index);
}

export function withCurrentCellVisited(
  state: ExplorationState,
): ExplorationState {
  return withVisitedIndex(state, state.currentIndex);
}

export function moveCurrentCardinal(
  state: ExplorationState,
  direction: CardinalDirection,
): ExplorationState {
  const neighbor = cardinalNeighbor(
    state.region,
    state.currentIndex,
    direction,
  );
  return neighbor === null ? state : withVisitedIndex(state, neighbor);
}

export function moveCurrentSerpentine(
  state: ExplorationState,
  step: -1 | 1,
): ExplorationState {
  const neighbor = serpentineNeighbor(
    state.region,
    state.currentIndex,
    step,
  );
  return neighbor === null ? state : withCurrentIndex(state, neighbor);
}

function validateCanonicalRegion(region: ExplorationRegion): ExplorationRegion {
  if (!isRecord(region)) {
    fail("La región persistida no es válida", "INVALID_STATE");
  }
  const canonical = createExplorationRegion({
    id: region.id,
    name: region.name,
    bounds: region.bounds,
    lod: region.lod,
    scale: region.scale,
  });
  const numericFields: Array<keyof ExplorationRegion> = [
    "tileSpan",
    "minTileX",
    "minTileZ",
    "maxTileXExclusive",
    "maxTileZExclusive",
    "columns",
    "rows",
    "cellCount",
  ];
  if (
    region.version !== EXPLORATION_GRID_VERSION ||
    region.dimension !== EXPLORATION_DIMENSION ||
    numericFields.some((field) => region[field] !== canonical[field]) ||
    region.bounds.minX !== canonical.bounds.minX ||
    region.bounds.minZ !== canonical.bounds.minZ ||
    region.bounds.maxXExclusive !== canonical.bounds.maxXExclusive ||
    region.bounds.maxZExclusive !== canonical.bounds.maxZExclusive
  ) {
    fail("La región no está en forma canónica", "INVALID_STATE");
  }
  return canonical;
}

function assertExplorationState(state: ExplorationState): void {
  if (!isRecord(state)) {
    fail("El estado de exploración no es válido", "INVALID_STATE");
  }
  const region = validateCanonicalRegion(state.region);
  assertCellIndex(region, state.currentIndex);
  assertCanonicalCellBits(region, state.reviewed, "revisado");
  assertCanonicalCellBits(region, state.skipped, "sin datos");
  if (typeof state.currentCellPreviouslyReviewed !== "boolean") {
    fail(
      "El historial visual de la celda actual no es válido",
      "INVALID_STATE",
    );
  }
  const currentLocation = bitLocation(state.currentIndex);
  const currentReviewed =
    (state.reviewed[currentLocation.byte] & currentLocation.mask) !== 0;
  if (
    state.currentCellPreviouslyReviewed &&
    !currentReviewed
  ) {
    fail(
      "La celda actual no puede ser previa si todavía no está revisada",
      "INVALID_STATE",
    );
  }
  if (
    !Number.isSafeInteger(state.reviewedCount) ||
    state.reviewedCount < 0 ||
    state.reviewedCount > region.cellCount ||
    countCellBits(state.reviewed) !== state.reviewedCount
  ) {
    fail("El contador de celdas revisadas no coincide", "INVALID_STATE");
  }
  if (
    !Number.isSafeInteger(state.skippedCount) ||
    state.skippedCount < 0 ||
    state.skippedCount > region.cellCount ||
    countCellBits(state.skipped) !== state.skippedCount
  ) {
    fail("El contador de celdas sin datos no coincide", "INVALID_STATE");
  }
  for (let index = 0; index < state.reviewed.length; index += 1) {
    if ((state.reviewed[index] & state.skipped[index]) !== 0) {
      fail(
        "Una celda no puede estar revisada y sin datos a la vez",
        "INVALID_STATE",
      );
    }
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    result += BASE64URL_ALPHABET[(combined >>> 18) & 63];
    result += BASE64URL_ALPHABET[(combined >>> 12) & 63];
    if (index + 1 < bytes.length) {
      result += BASE64URL_ALPHABET[(combined >>> 6) & 63];
    }
    if (index + 2 < bytes.length) {
      result += BASE64URL_ALPHABET[combined & 63];
    }
  }
  return result;
}

function decodeBase64Url(value: string, expectedBytes: number): Uint8Array {
  const expectedCharacters =
    Math.floor(expectedBytes / 3) * 4 +
    (expectedBytes % 3 === 0 ? 0 : expectedBytes % 3 + 1);
  if (
    value.length !== expectedCharacters ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  ) {
    fail("El bitset exportado no usa base64url canónico", "INVALID_SERIALIZATION");
  }

  const result = new Uint8Array(expectedBytes);
  let buffer = 0;
  let bufferedBits = 0;
  let outputIndex = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) {
      fail("El bitset exportado contiene caracteres inválidos", "INVALID_SERIALIZATION");
    }
    buffer = (buffer << 6) | digit;
    bufferedBits += 6;
    while (bufferedBits >= 8) {
      bufferedBits -= 8;
      if (outputIndex >= result.length) {
        fail("El bitset exportado contiene datos adicionales", "INVALID_SERIALIZATION");
      }
      result[outputIndex] = (buffer >>> bufferedBits) & 0xff;
      outputIndex += 1;
      buffer &= (1 << bufferedBits) - 1;
    }
  }
  if (outputIndex !== result.length || buffer !== 0) {
    fail("El bitset exportado está truncado o no es canónico", "INVALID_SERIALIZATION");
  }
  return result;
}

export function serializeExplorationState(state: ExplorationState): string {
  assertExplorationState(state);
  const payload: SerializedExplorationState = {
    version: EXPLORATION_GRID_VERSION,
    dimension: EXPLORATION_DIMENSION,
    region: {
      id: state.region.id,
      name: state.region.name,
      bounds: state.region.bounds,
      lod: state.region.lod,
      scale: state.region.scale,
    },
    currentIndex: state.currentIndex,
    currentCellPreviouslyReviewed:
      state.currentCellPreviouslyReviewed,
    reviewedCount: state.reviewedCount,
    reviewedBits: encodeBase64Url(state.reviewed),
    skippedCount: state.skippedCount,
    skippedBits: encodeBase64Url(state.skipped),
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_SERIALIZED_EXPLORATION_CHARS) {
    fail("La exportación supera el tamaño seguro", "INVALID_SERIALIZATION");
  }
  return serialized;
}

export function deserializeExplorationState(
  serialized: string,
): ExplorationState {
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    serialized.length > MAX_SERIALIZED_EXPLORATION_CHARS
  ) {
    fail("La exportación tiene un tamaño inválido", "INVALID_SERIALIZATION");
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    fail("La exportación no contiene JSON válido", "INVALID_SERIALIZATION");
  }
  if (!isRecord(value) || !isRecord(value.region)) {
    fail("La exportación no contiene una región", "INVALID_SERIALIZATION");
  }
  if (
    value.version !== EXPLORATION_GRID_VERSION ||
    value.dimension !== EXPLORATION_DIMENSION
  ) {
    fail("Versión o dimensión de exploración incompatible", "INVALID_SERIALIZATION");
  }

  let region: ExplorationRegion;
  try {
    region = createExplorationRegion({
      id: value.region.id as string,
      name: value.region.name as string,
      bounds: value.region.bounds as WorldBounds,
      lod: value.region.lod as number,
      scale: value.region.scale as number,
    });
  } catch (error) {
    if (error instanceof ExplorationGridError) {
      throw new ExplorationGridError(error.message, "INVALID_SERIALIZATION");
    }
    throw error;
  }

  const serializedBounds = value.region.bounds;
  if (
    !isRecord(serializedBounds) ||
    serializedBounds.minX !== region.bounds.minX ||
    serializedBounds.minZ !== region.bounds.minZ ||
    serializedBounds.maxXExclusive !== region.bounds.maxXExclusive ||
    serializedBounds.maxZExclusive !== region.bounds.maxZExclusive
  ) {
    fail("Los límites exportados no están alineados a tiles", "INVALID_SERIALIZATION");
  }
  const currentIndex = value.currentIndex;
  const serializedCurrentCellPreviouslyReviewed =
    value.currentCellPreviouslyReviewed;
  const serializedReviewedCount = value.reviewedCount;
  const hasSkippedState =
    value.skippedCount !== undefined || value.skippedBits !== undefined;
  const serializedSkippedCount = hasSkippedState ? value.skippedCount : 0;
  if (
    typeof currentIndex !== "number" ||
    !Number.isSafeInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= region.cellCount ||
    (serializedCurrentCellPreviouslyReviewed !== undefined &&
      typeof serializedCurrentCellPreviouslyReviewed !== "boolean") ||
    typeof serializedReviewedCount !== "number" ||
    !Number.isSafeInteger(serializedReviewedCount) ||
    serializedReviewedCount < 0 ||
    serializedReviewedCount > region.cellCount ||
    typeof value.reviewedBits !== "string" ||
    typeof serializedSkippedCount !== "number" ||
    !Number.isSafeInteger(serializedSkippedCount) ||
    serializedSkippedCount < 0 ||
    serializedSkippedCount > region.cellCount ||
    (hasSkippedState && typeof value.skippedBits !== "string")
  ) {
    fail("Índice o contador exportado fuera de rango", "INVALID_SERIALIZATION");
  }

  const reviewed = decodeBase64Url(
    value.reviewedBits,
    cellBitsetByteLength(region.cellCount),
  );
  const skipped = hasSkippedState
    ? decodeBase64Url(
        value.skippedBits as string,
        cellBitsetByteLength(region.cellCount),
      )
    : new Uint8Array(cellBitsetByteLength(region.cellCount));
  try {
    assertCanonicalCellBits(region, reviewed, "revisado");
    assertCanonicalCellBits(region, skipped, "sin datos");
  } catch (error) {
    if (error instanceof ExplorationGridError) {
      throw new ExplorationGridError(error.message, "INVALID_SERIALIZATION");
    }
    throw error;
  }
  const reviewedCount = countCellBits(reviewed);
  if (reviewedCount !== serializedReviewedCount) {
    fail("El contador exportado no coincide con el bitset", "INVALID_SERIALIZATION");
  }
  const skippedCount = countCellBits(skipped);
  if (skippedCount !== serializedSkippedCount) {
    fail(
      "El contador sin datos exportado no coincide con el bitset",
      "INVALID_SERIALIZATION",
    );
  }
  for (let index = 0; index < reviewed.length; index += 1) {
    if ((reviewed[index] & skipped[index]) !== 0) {
      fail(
        "Una celda exportada no puede estar revisada y sin datos",
        "INVALID_SERIALIZATION",
      );
    }
  }
  const currentLocation = bitLocation(currentIndex);
  const currentReviewed =
    (reviewed[currentLocation.byte] & currentLocation.mask) !== 0;
  const currentCellPreviouslyReviewed =
    serializedCurrentCellPreviouslyReviewed ?? currentReviewed;
  if (currentCellPreviouslyReviewed && !currentReviewed) {
    fail(
      "El historial visual actual no coincide con el bitset",
      "INVALID_SERIALIZATION",
    );
  }

  return Object.freeze({
    region,
    currentIndex,
    currentCellPreviouslyReviewed,
    reviewed,
    reviewedCount,
    skipped,
    skippedCount,
  });
}
