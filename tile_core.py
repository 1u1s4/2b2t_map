"""Shared primitives for downloading and validating 2b2t.place map tiles.

The public tile schema uses numeric dimension identifiers in URLs and canonical
dimension names on disk:

    {layer}/{lod}/{dimension}/{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp

Shard coordinates intentionally use JavaScript-style truncation toward zero,
not Python's floor division for negative values.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, BinaryIO, Callable

from PIL import Image


BASE_URL = "https://2b2t.place"
DIMENSIONS = {
    "overworld": 0,
    "nether": 1,
    "end": 2,
}
DIMENSION_NAMES = {identifier: name for name, identifier in DIMENSIONS.items()}
LAYERS = ("base", "overlay", "newchunks")
LODS = tuple(range(0, 11))
TILE_PIXELS = 512
SHARD_TILES = 32


class WebPValidationError(ValueError):
    """Raised when a payload is not a complete, valid 512×512 WebP tile."""


def _is_int(value: object) -> bool:
    """Return true for integers while rejecting booleans."""

    return isinstance(value, int) and not isinstance(value, bool)


def trunc_div(value: int, divisor: int) -> int:
    """Divide integers with truncation toward zero, without using floats."""

    if not _is_int(value) or not _is_int(divisor):
        raise TypeError("value and divisor must be integers")
    if divisor == 0:
        raise ZeroDivisionError("integer division or modulo by zero")

    quotient = abs(value) // abs(divisor)
    return -quotient if (value < 0) != (divisor < 0) else quotient


def tile_shard(tile_coordinate: int) -> int:
    """Return the shard used by ``(tile_coordinate / 32) >> 0``."""

    return trunc_div(tile_coordinate, SHARD_TILES)


def dimension_id(dimension: str | int) -> int:
    """Resolve a canonical dimension name or verified numeric identifier."""

    if isinstance(dimension, str):
        try:
            return DIMENSIONS[dimension]
        except KeyError as exc:
            choices = ", ".join(DIMENSIONS)
            raise ValueError(
                f"unknown dimension {dimension!r}; expected one of: {choices}"
            ) from exc
    if _is_int(dimension) and dimension in DIMENSION_NAMES:
        return dimension
    raise ValueError(f"unknown dimension identifier: {dimension!r}")


def dimension_name(dimension: str | int) -> str:
    """Return the canonical filesystem name for a dimension."""

    return DIMENSION_NAMES[dimension_id(dimension)]


@dataclass(frozen=True, slots=True)
class TileSpec:
    """The complete identity of one map tile."""

    layer: str
    lod: int
    dimension: str
    tile_x: int
    tile_z: int

    def __post_init__(self) -> None:
        if self.layer not in LAYERS:
            choices = ", ".join(LAYERS)
            raise ValueError(
                f"unknown layer {self.layer!r}; expected one of: {choices}"
            )
        if not _is_int(self.lod) or self.lod not in LODS:
            raise ValueError(f"lod must be an integer from {LODS[0]} to {LODS[-1]}")
        if not _is_int(self.tile_x) or not _is_int(self.tile_z):
            raise TypeError("tile_x and tile_z must be integers")

        # Accept a verified numeric identifier at construction for convenience,
        # while keeping one canonical representation inside the frozen object.
        object.__setattr__(self, "dimension", dimension_name(self.dimension))

    @property
    def dimension_id(self) -> int:
        return DIMENSIONS[self.dimension]

    @property
    def shard_x(self) -> int:
        return tile_shard(self.tile_x)

    @property
    def shard_z(self) -> int:
        return tile_shard(self.tile_z)

    @property
    def blocks_per_pixel(self) -> int:
        return 1 << self.lod

    @property
    def tile_blocks(self) -> int:
        return TILE_PIXELS * self.blocks_per_pixel

    @property
    def filename(self) -> str:
        return f"t.{self.tile_x}.{self.tile_z}.webp"

    @property
    def relative_path(self) -> Path:
        return tile_relative_path(self)

    def output_path(self, root: str | os.PathLike[str]) -> Path:
        return tile_output_path(root, self)

    def url(self, base_url: str = BASE_URL) -> str:
        return tile_url(self, base_url=base_url)


def tile_url(spec: TileSpec, *, base_url: str = BASE_URL) -> str:
    """Build the direct URL for a tile."""

    normalized_base = base_url.rstrip("/")
    if not normalized_base:
        raise ValueError("base_url must not be empty")
    return (
        f"{normalized_base}/tiles/{spec.layer}/{spec.lod}/{spec.dimension_id}/"
        f"{spec.shard_x}/{spec.shard_z}/{spec.filename}"
    )


def tile_relative_path(spec: TileSpec) -> Path:
    """Build the required canonical relative output path for a tile."""

    return (
        Path(spec.layer)
        / str(spec.lod)
        / spec.dimension
        / str(spec.shard_x)
        / str(spec.shard_z)
        / spec.filename
    )


def tile_output_path(
    root: str | os.PathLike[str],
    spec: TileSpec,
) -> Path:
    """Build a tile path below an output root."""

    return Path(root) / tile_relative_path(spec)


def _validate_riff_webp_header(header: bytes, total_size: int) -> None:
    if total_size < 12 or len(header) < 12:
        raise WebPValidationError("payload is too short to be a RIFF/WebP file")
    if header[:4] != b"RIFF" or header[8:12] != b"WEBP":
        raise WebPValidationError("payload does not have a RIFF/WebP header")

    declared_size = int.from_bytes(header[4:8], byteorder="little") + 8
    if declared_size != total_size:
        raise WebPValidationError(
            f"RIFF size mismatch: header declares {declared_size} bytes, "
            f"file contains {total_size} bytes"
        )


def _pillow_validate_webp(
    source_factory: Callable[[], BinaryIO],
) -> tuple[int, int]:
    try:
        with source_factory() as source:
            with Image.open(source) as image:
                if image.format != "WEBP":
                    raise WebPValidationError(
                        f"decoded format is {image.format!r}, not 'WEBP'"
                    )
                if image.size != (TILE_PIXELS, TILE_PIXELS):
                    raise WebPValidationError(
                        f"tile dimensions are {image.size[0]}x{image.size[1]}, "
                        f"expected {TILE_PIXELS}x{TILE_PIXELS}"
                    )
                image.verify()

        # Pillow's verify() checks container integrity but does not decode pixel
        # data. Reopen and load every pixel to catch truncated/corrupt payloads.
        with source_factory() as source:
            with Image.open(source) as image:
                if image.format != "WEBP":
                    raise WebPValidationError(
                        f"decoded format is {image.format!r}, not 'WEBP'"
                    )
                if image.size != (TILE_PIXELS, TILE_PIXELS):
                    raise WebPValidationError(
                        f"tile dimensions are {image.size[0]}x{image.size[1]}, "
                        f"expected {TILE_PIXELS}x{TILE_PIXELS}"
                    )
                image.load()
                return image.size
    except WebPValidationError:
        raise
    except Exception as exc:
        raise WebPValidationError(f"Pillow could not fully decode WebP: {exc}") from exc


def validate_webp_bytes(
    payload: bytes | bytearray | memoryview,
) -> tuple[int, int]:
    """Validate an in-memory tile and return its pixel dimensions."""

    data = bytes(payload)
    _validate_riff_webp_header(data[:12], len(data))
    return _pillow_validate_webp(lambda: io.BytesIO(data))


def validate_webp_file(
    path: str | os.PathLike[str],
) -> tuple[int, int]:
    """Validate a tile file and return its pixel dimensions."""

    tile_path = Path(path)
    try:
        with tile_path.open("rb") as handle:
            header = handle.read(12)
            handle.seek(0, os.SEEK_END)
            total_size = handle.tell()
    except OSError as exc:
        raise WebPValidationError(f"cannot read tile {tile_path}: {exc}") from exc

    _validate_riff_webp_header(header, total_size)
    return _pillow_validate_webp(lambda: tile_path.open("rb"))


def sha256_file(
    path: str | os.PathLike[str],
    *,
    chunk_size: int = 1024 * 1024,
) -> str:
    """Return the lowercase SHA-256 hex digest of a file."""

    if not _is_int(chunk_size) or chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer")

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_retry_after(
    value: str | None,
    *,
    now: datetime | None = None,
) -> float | None:
    """Parse an HTTP Retry-After value into nonnegative delay seconds."""

    if value is None:
        return None
    value = value.strip()
    if not value:
        return None

    if value.isascii() and value.isdecimal():
        try:
            delay = float(int(value, 10))
        except (OverflowError, ValueError):
            return None
        return delay if math.isfinite(delay) else None

    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at is None:
        return None

    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)

    current = now if now is not None else datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    return max(0.0, (retry_at - current).total_seconds())


def _fsync_directory(directory: Path) -> None:
    """Best-effort directory sync after an atomic replacement."""

    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_write_json(
    path: str | os.PathLike[str],
    value: Any,
    *,
    indent: int | None = 2,
) -> None:
    """Serialize JSON durably and atomically beside the destination file."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(
                value,
                handle,
                ensure_ascii=False,
                indent=indent,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())

        os.replace(temporary_path, destination)
        temporary_path = None
        _fsync_directory(destination.parent)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def human_bytes(value: int | float | None) -> str:
    """Format a byte count using IEC binary units."""

    if value is None:
        return "unknown"
    numeric = float(value)
    if math.isnan(numeric):
        return "unknown"
    if math.isinf(numeric):
        return "-∞" if numeric < 0 else "∞"

    sign = "-" if numeric < 0 else ""
    amount = abs(numeric)
    units = ("B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB")
    unit = units[0]
    for candidate in units:
        unit = candidate
        if amount < 1024.0 or candidate == units[-1]:
            break
        amount /= 1024.0

    if unit == "B":
        return f"{sign}{amount:.0f} {unit}"
    return f"{sign}{amount:.2f} {unit}"


def human_duration(seconds: int | float | None) -> str:
    """Format an elapsed time or ETA in compact day/hour/minute form."""

    if seconds is None:
        return "unknown"
    numeric = float(seconds)
    if math.isnan(numeric):
        return "unknown"
    if math.isinf(numeric):
        return "-∞" if numeric < 0 else "∞"

    total_seconds = max(0, int(round(numeric)))
    days, remainder = divmod(total_seconds, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes, secs = divmod(remainder, 60)

    if days:
        return f"{days}d {hours}h {minutes}m {secs}s"
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"
