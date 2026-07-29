/**
 * Browser-only access to a downloaded 2b2t tile archive.
 *
 * The selected directory is expected to be `2b2t_tiles` itself, with files at:
 *
 *   layer/lod/dimension/shardX/shardZ/t.tileX.tileZ.webp
 *
 * File System Access handles can be kept by the caller (for example in
 * IndexedDB), but object URLs must not be persisted. `LocalTileSource` owns all
 * object URLs it creates and revokes them when `dispose()` is called.
 */

export const TILE_ARCHIVE_DIRECTORY_NAME = "2b2t_tiles";
export const TILE_SIZE_PIXELS = 512;
export const TILES_PER_SHARD = 32;
export const MIN_TILE_LOD = 0;
export const MAX_TILE_LOD = 10;

export const TILE_LAYERS = ["base", "overlay", "newchunks"] as const;

export type TileLayer = (typeof TILE_LAYERS)[number];
export type TileDimension = "overworld";

export interface TileKey {
  readonly layer: TileLayer;
  readonly lod: number;
  readonly dimension: TileDimension;
  readonly tileX: number;
  readonly tileZ: number;
}

export interface TileBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxXExclusive: number;
  readonly maxZExclusive: number;
}

export interface WorldTilePosition {
  readonly tileX: number;
  readonly tileZ: number;
  /** Pixel coordinate inside the native 512 × 512 tile. */
  readonly pixelX: number;
  /** Pixel coordinate inside the native 512 × 512 tile. */
  readonly pixelZ: number;
}

export interface AncestorTileCrop {
  readonly lod: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly sourceX: number;
  readonly sourceZ: number;
  readonly sourceSize: number;
}

export type TilePathSegments = readonly [
  layer: TileLayer,
  lod: string,
  dimension: TileDimension,
  shardX: string,
  shardZ: string,
  filename: string,
];

export interface LocalTileObjectUrl {
  readonly key: Readonly<TileKey>;
  readonly relativePath: string;
  readonly file: File;
  readonly url: string;
  /** Reflects whether this individual URL has already been revoked. */
  readonly revoked: boolean;
  /** Idempotent. Safe to call even after the source has been disposed. */
  readonly revoke: () => void;
}

export type FileSystemAccessUnsupportedReason =
  | "server-rendering"
  | "insecure-context"
  | "directory-picker-unavailable"
  | "object-url-unavailable";

export type FileSystemAccessSupport =
  | { readonly supported: true; readonly reason: null }
  | {
      readonly supported: false;
      readonly reason: FileSystemAccessUnsupportedReason;
    };

type WellKnownDirectory =
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos";

type DirectoryPickerStartIn = WellKnownDirectory | FileSystemHandle;

interface ShowDirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: "read" | "readwrite";
  readonly startIn?: DirectoryPickerStartIn;
}

type ShowDirectoryPicker = (
  options?: ShowDirectoryPickerOptions,
) => Promise<FileSystemDirectoryHandle>;

export interface PickTileDirectoryOptions {
  /**
   * Stable picker id lets Chromium remember the last location for this use.
   * Defaults to a viewer-specific id.
   */
  readonly id?: string;
  readonly startIn?: DirectoryPickerStartIn;
  /**
   * Reject a directory whose basename is not `2b2t_tiles`.
   * Enabled by default to catch accidentally selecting its parent.
   */
  readonly requireCanonicalName?: boolean;
}

export class LocalTileSourceError extends Error {
  public readonly code:
    | "UNSUPPORTED"
    | "WRONG_DIRECTORY"
    | "DISPOSED"
    | "INVALID_TILE_KEY";

  constructor(
    message: string,
    code:
      | "UNSUPPORTED"
      | "WRONG_DIRECTORY"
      | "DISPOSED"
      | "INVALID_TILE_KEY",
  ) {
    super(message);
    this.name = "LocalTileSourceError";
    this.code = code;
  }
}

function getDirectoryPicker(): ShowDirectoryPicker | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (
    window as Window & { showDirectoryPicker?: ShowDirectoryPicker }
  ).showDirectoryPicker;

  return typeof candidate === "function" ? candidate.bind(window) : null;
}

/**
 * Gives the UI a useful reason instead of a generic failure. The directory
 * picker requires a Chromium-compatible browser and a secure context
 * (`https://` or localhost).
 */
export function getFileSystemAccessSupport(): FileSystemAccessSupport {
  if (typeof window === "undefined") {
    return { supported: false, reason: "server-rendering" };
  }

  if (!window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }

  if (getDirectoryPicker() === null) {
    return { supported: false, reason: "directory-picker-unavailable" };
  }

  if (
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return { supported: false, reason: "object-url-unavailable" };
  }

  return { supported: true, reason: null };
}

export function supportsFileSystemAccess(): boolean {
  return getFileSystemAccessSupport().supported;
}

export function isTileArchiveDirectory(
  directory: FileSystemDirectoryHandle,
): boolean {
  return (
    directory.kind === "directory" &&
    directory.name === TILE_ARCHIVE_DIRECTORY_NAME
  );
}

/**
 * Opens Chromium's directory chooser in read-only mode.
 *
 * User cancellation is deliberately not swallowed: browsers report it as an
 * `AbortError`, allowing the UI to distinguish Cancel from an actual failure.
 */
export async function pickTileArchiveDirectory(
  options: PickTileDirectoryOptions = {},
): Promise<FileSystemDirectoryHandle> {
  const support = getFileSystemAccessSupport();
  if (!support.supported) {
    throw new LocalTileSourceError(
      `Local directory access is unavailable (${support.reason}).`,
      "UNSUPPORTED",
    );
  }

  const picker = getDirectoryPicker();
  // The support check above makes this unreachable, but preserves type safety.
  if (picker === null) {
    throw new LocalTileSourceError(
      "This browser does not expose showDirectoryPicker().",
      "UNSUPPORTED",
    );
  }

  const directory = await picker({
    id: options.id ?? "2b2t-map-tile-archive",
    mode: "read",
    startIn: options.startIn,
  });

  if (
    options.requireCanonicalName !== false &&
    !isTileArchiveDirectory(directory)
  ) {
    throw new LocalTileSourceError(
      `Choose the "${TILE_ARCHIVE_DIRECTORY_NAME}" directory itself, not "${directory.name}".`,
      "WRONG_DIRECTORY",
    );
  }

  return directory;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new LocalTileSourceError(
      `${label} must be a safe integer; received ${String(value)}.`,
      "INVALID_TILE_KEY",
    );
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new LocalTileSourceError(
      `${label} must be finite; received ${String(value)}.`,
      "INVALID_TILE_KEY",
    );
  }
}

function assertLod(lod: number): void {
  assertSafeInteger(lod, "lod");
  if (lod < MIN_TILE_LOD || lod > MAX_TILE_LOD) {
    throw new LocalTileSourceError(
      `lod must be between ${MIN_TILE_LOD} and ${MAX_TILE_LOD}; received ${lod}.`,
      "INVALID_TILE_KEY",
    );
  }
}

export function isTileLayer(value: string): value is TileLayer {
  return (TILE_LAYERS as readonly string[]).includes(value);
}

/**
 * Only terrain is spatially continuous across LODs. Sparse semantic layers
 * use a missing tile to mean "nothing to draw"; enlarging an aggregated
 * ancestor pixel would invent overlay coverage and can obscure the base map.
 */
export function allowsAncestorTileFallback(layer: TileLayer): boolean {
  return layer === "base";
}

/**
 * Resolves the native-pixel crop that represents one detailed child tile
 * inside a coarser ancestor. Math.floor is intentional for negative tiles.
 */
export function resolveAncestorTileCrop(
  key: Readonly<TileKey>,
  ancestorLod: number,
): AncestorTileCrop {
  if (
    !Number.isInteger(ancestorLod) ||
    ancestorLod <= key.lod ||
    ancestorLod > MAX_TILE_LOD
  ) {
    throw new RangeError(
      `ancestorLod must be greater than ${key.lod} and at most ${MAX_TILE_LOD}`,
    );
  }
  const subdivision = 2 ** (ancestorLod - key.lod);
  const tileX = Math.floor(key.tileX / subdivision);
  const tileZ = Math.floor(key.tileZ / subdivision);
  const childX = key.tileX - tileX * subdivision;
  const childZ = key.tileZ - tileZ * subdivision;
  const sourceSize = TILE_SIZE_PIXELS / subdivision;
  return Object.freeze({
    lod: ancestorLod,
    tileX,
    tileZ,
    sourceX: childX * sourceSize,
    sourceZ: childZ * sourceSize,
    sourceSize,
  });
}

/**
 * Runtime validation is important because every field becomes part of a local
 * path. Returning a fresh frozen object also prevents a key from changing
 * during asynchronous directory traversal.
 */
export function normalizeTileKey(key: TileKey): Readonly<TileKey> {
  if (!isTileLayer(key.layer)) {
    throw new LocalTileSourceError(
      `Unknown tile layer "${String(key.layer)}".`,
      "INVALID_TILE_KEY",
    );
  }
  if (key.dimension !== "overworld") {
    throw new LocalTileSourceError(
      `Only the overworld archive is supported; received "${String(key.dimension)}".`,
      "INVALID_TILE_KEY",
    );
  }

  assertLod(key.lod);
  assertSafeInteger(key.tileX, "tileX");
  assertSafeInteger(key.tileZ, "tileZ");

  return Object.freeze({
    layer: key.layer,
    lod: key.lod,
    dimension: "overworld",
    tileX: key.tileX,
    tileZ: key.tileZ,
  });
}

/**
 * The live 2b2t.place client groups 32 tiles per shard with JavaScript integer
 * truncation. This differs from Math.floor for tile coordinates -1 through
 * -31, which all belong to shard 0.
 */
export function tileCoordinateToShard(tileCoordinate: number): number {
  assertSafeInteger(tileCoordinate, "tile coordinate");
  const shard = Math.trunc(tileCoordinate / TILES_PER_SHARD);
  // Avoid exposing negative zero in serialized labels or debug output.
  return Object.is(shard, -0) ? 0 : shard;
}

export function tileFilename(tileX: number, tileZ: number): string {
  assertSafeInteger(tileX, "tileX");
  assertSafeInteger(tileZ, "tileZ");
  return `t.${tileX}.${tileZ}.webp`;
}

export function tilePathSegments(key: TileKey): TilePathSegments {
  const normalized = normalizeTileKey(key);
  return [
    normalized.layer,
    String(normalized.lod),
    normalized.dimension,
    String(tileCoordinateToShard(normalized.tileX)),
    String(tileCoordinateToShard(normalized.tileZ)),
    tileFilename(normalized.tileX, normalized.tileZ),
  ];
}

export function tileRelativePath(key: TileKey): string {
  return tilePathSegments(key).join("/");
}

export function tileKeyId(key: TileKey): string {
  const normalized = normalizeTileKey(key);
  return [
    normalized.layer,
    normalized.lod,
    normalized.dimension,
    normalized.tileX,
    normalized.tileZ,
  ].join(":");
}

export function blocksPerPixelAtLod(lod: number): number {
  assertLod(lod);
  return 2 ** lod;
}

export function blocksPerTileAtLod(lod: number): number {
  return TILE_SIZE_PIXELS * blocksPerPixelAtLod(lod);
}

export function worldBlockToTileCoordinate(
  blockCoordinate: number,
  lod: number,
): number {
  assertFiniteNumber(blockCoordinate, "block coordinate");
  return Math.floor(blockCoordinate / blocksPerTileAtLod(lod));
}

export function tileCoordinateToWorldOrigin(
  tileCoordinate: number,
  lod: number,
): number {
  assertSafeInteger(tileCoordinate, "tile coordinate");
  return tileCoordinate * blocksPerTileAtLod(lod);
}

export function tileBoundsInWorld(
  tileX: number,
  tileZ: number,
  lod: number,
): TileBounds {
  const minX = tileCoordinateToWorldOrigin(tileX, lod);
  const minZ = tileCoordinateToWorldOrigin(tileZ, lod);
  const tileSpan = blocksPerTileAtLod(lod);

  return {
    minX,
    minZ,
    maxXExclusive: minX + tileSpan,
    maxZExclusive: minZ + tileSpan,
  };
}

/**
 * Converts world coordinates into the tile and continuous native pixel
 * coordinates needed by a canvas renderer. Fractional world coordinates are
 * preserved, which keeps panning smooth.
 */
export function worldToTilePosition(
  blockX: number,
  blockZ: number,
  lod: number,
): WorldTilePosition {
  assertFiniteNumber(blockX, "blockX");
  assertFiniteNumber(blockZ, "blockZ");

  const tileX = worldBlockToTileCoordinate(blockX, lod);
  const tileZ = worldBlockToTileCoordinate(blockZ, lod);
  const originX = tileCoordinateToWorldOrigin(tileX, lod);
  const originZ = tileCoordinateToWorldOrigin(tileZ, lod);
  const blocksPerPixel = blocksPerPixelAtLod(lod);

  return {
    tileX,
    tileZ,
    pixelX: (blockX - originX) / blocksPerPixel,
    pixelZ: (blockZ - originZ) / blocksPerPixel,
  };
}

export function tilePixelToWorld(
  tileX: number,
  tileZ: number,
  pixelX: number,
  pixelZ: number,
  lod: number,
): { readonly blockX: number; readonly blockZ: number } {
  assertFiniteNumber(pixelX, "pixelX");
  assertFiniteNumber(pixelZ, "pixelZ");
  const blocksPerPixel = blocksPerPixelAtLod(lod);

  return {
    blockX:
      tileCoordinateToWorldOrigin(tileX, lod) + pixelX * blocksPerPixel,
    blockZ:
      tileCoordinateToWorldOrigin(tileZ, lod) + pixelZ * blocksPerPixel,
  };
}

export function tileKeyAtWorldPosition(
  layer: TileLayer,
  lod: number,
  blockX: number,
  blockZ: number,
): Readonly<TileKey> {
  return normalizeTileKey({
    layer,
    lod,
    dimension: "overworld",
    tileX: worldBlockToTileCoordinate(blockX, lod),
    tileZ: worldBlockToTileCoordinate(blockZ, lod),
  });
}

function isMissingFileSystemEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "NotFoundError"
  );
}

/**
 * Reads a tile as a File without allocating an object URL. Missing directory
 * segments and missing files both resolve to null.
 */
export async function readTileFile(
  directory: FileSystemDirectoryHandle,
  key: TileKey,
): Promise<File | null> {
  const segments = tilePathSegments(key);

  try {
    let current = directory;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment, { create: false });
    }

    const fileHandle = await current.getFileHandle(segments.at(-1)!, {
      create: false,
    });
    return await fileHandle.getFile();
  } catch (error) {
    if (isMissingFileSystemEntry(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Owns the short-lived object URLs used by image/canvas consumers.
 *
 * Call `asset.revoke()` as soon as an individual image has been decoded, and
 * call `source.dispose()` whenever the archive changes or the viewer unmounts.
 */
export class LocalTileSource {
  readonly #revokeByUrl = new Map<string, () => void>();
  #disposed = false;
  readonly directory: FileSystemDirectoryHandle;

  constructor(directory: FileSystemDirectoryHandle) {
    this.directory = directory;
  }

  get activeObjectUrlCount(): number {
    return this.#revokeByUrl.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async readTile(key: TileKey): Promise<LocalTileObjectUrl | null> {
    if (this.#disposed) {
      throw new LocalTileSourceError(
        "This local tile source has already been disposed.",
        "DISPOSED",
      );
    }

    if (
      typeof window === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      throw new LocalTileSourceError(
        "Tile object URLs are only available in a browser.",
        "UNSUPPORTED",
      );
    }

    const normalizedKey = normalizeTileKey(key);
    const file = await readTileFile(this.directory, normalizedKey);
    if (file === null) {
      return null;
    }

    // The source may have been disposed while the asynchronous file read ran.
    if (this.#disposed) {
      throw new LocalTileSourceError(
        "This local tile source was disposed while reading a tile.",
        "DISPOSED",
      );
    }

    const url = URL.createObjectURL(file);
    let revoked = false;

    const revoke = (): void => {
      if (revoked) {
        return;
      }
      revoked = true;
      URL.revokeObjectURL(url);
      this.#revokeByUrl.delete(url);
    };
    this.#revokeByUrl.set(url, revoke);

    const result = {
      key: normalizedKey,
      relativePath: tileRelativePath(normalizedKey),
      file,
      url,
      get revoked(): boolean {
        return revoked;
      },
      revoke,
    } satisfies LocalTileObjectUrl;

    return Object.freeze(result);
  }

  /**
   * Convenience wrapper for one-shot work such as `createImageBitmap`.
   * The object URL is revoked even if the callback throws.
   */
  async withTile<T>(
    key: TileKey,
    consume: (tile: LocalTileObjectUrl) => T | Promise<T>,
  ): Promise<T | null> {
    const tile = await this.readTile(key);
    if (tile === null) {
      return null;
    }

    try {
      return await consume(tile);
    } finally {
      tile.revoke();
    }
  }

  revokeAll(): void {
    // Snapshot because each callback removes itself from the map.
    for (const revoke of [...this.#revokeByUrl.values()]) {
      revoke();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.revokeAll();
  }
}

export function createLocalTileSource(
  directory: FileSystemDirectoryHandle,
): LocalTileSource {
  return new LocalTileSource(directory);
}
