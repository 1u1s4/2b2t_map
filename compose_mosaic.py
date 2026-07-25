#!/usr/bin/env python3
"""Compose already-downloaded 2b2t.place tiles into an offline mosaic.

Coordinates are integer Minecraft block coordinates. Explicit ranges are
half-open: ``[x_min, x_max) × [z_min, z_max)``. X increases to the right and Z
increases downward in the resulting image.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageDraw, ImageFont

from tile_core import (
    DIMENSIONS,
    LAYERS,
    LODS,
    TILE_PIXELS,
    TileSpec,
    WebPValidationError,
    tile_output_path,
    validate_webp_file,
)


DEFAULT_AREA = 16_384
DEFAULT_MAX_PIXELS = 100_000_000
MISSING_EXIT_CODE = 3
CORRUPT_EXIT_CODE = 4


class MosaicError(RuntimeError):
    """Base class for composition failures with actionable user messages."""


class PixelLimitError(MosaicError):
    """Raised before allocation when the requested image is too large."""


class MissingTilesError(MosaicError):
    """Raised when required local tile files are absent."""

    def __init__(self, paths: Iterable[Path]) -> None:
        self.paths = tuple(paths)
        super().__init__(f"{len(self.paths)} required tile(s) are missing")


class CorruptTilesError(MosaicError):
    """Raised when required local tile files fail strict WebP validation."""

    def __init__(self, failures: Iterable[tuple[Path, str]]) -> None:
        self.failures = tuple(failures)
        super().__init__(f"{len(self.failures)} tile(s) are corrupt or invalid")


@dataclass(frozen=True, slots=True)
class BlockRange:
    """A half-open X/Z range in integer block coordinates."""

    x_min: int
    z_min: int
    x_max: int
    z_max: int

    def __post_init__(self) -> None:
        values = (self.x_min, self.z_min, self.x_max, self.z_max)
        if any(not isinstance(value, int) or isinstance(value, bool) for value in values):
            raise TypeError("block coordinates must be integers")
        if self.x_max <= self.x_min:
            raise ValueError("x_max must be greater than x_min")
        if self.z_max <= self.z_min:
            raise ValueError("z_max must be greater than z_min")

    @classmethod
    def from_center(
        cls,
        center_x: int,
        center_z: int,
        area: int = DEFAULT_AREA,
    ) -> BlockRange:
        if not isinstance(area, int) or isinstance(area, bool) or area <= 0:
            raise ValueError("area must be a positive integer")
        x_min = center_x - area // 2
        z_min = center_z - area // 2
        return cls(x_min, z_min, x_min + area, z_min + area)


@dataclass(frozen=True, slots=True)
class PixelWindow:
    """World-aligned pixel bounds covering a requested block range."""

    x_min: int
    z_min: int
    x_max: int
    z_max: int

    @property
    def width(self) -> int:
        return self.x_max - self.x_min

    @property
    def height(self) -> int:
        return self.z_max - self.z_min

    @property
    def total_pixels(self) -> int:
        return self.width * self.height


@dataclass(frozen=True, slots=True)
class CompositionResult:
    """Summary returned after a mosaic has been written."""

    output_path: Path
    width: int
    height: int
    tiles_used: int
    missing_paths: tuple[Path, ...]
    pixel_x_min: int
    pixel_z_min: int


def _ceil_div(value: int, divisor: int) -> int:
    return -((-value) // divisor)


def pixel_window(block_range: BlockRange, lod: int) -> PixelWindow:
    """Return map-pixel bounds intersecting the half-open block range."""

    if not isinstance(lod, int) or isinstance(lod, bool) or lod not in LODS:
        raise ValueError(f"lod must be an integer from {LODS[0]} to {LODS[-1]}")
    blocks_per_pixel = 1 << lod
    return PixelWindow(
        x_min=block_range.x_min // blocks_per_pixel,
        z_min=block_range.z_min // blocks_per_pixel,
        x_max=_ceil_div(block_range.x_max, blocks_per_pixel),
        z_max=_ceil_div(block_range.z_max, blocks_per_pixel),
    )


def required_tile_specs(
    block_range: BlockRange,
    *,
    lod: int,
    dimension: str,
    layer: str,
) -> tuple[TileSpec, ...]:
    """List required tiles in top-to-bottom, left-to-right order."""

    window = pixel_window(block_range, lod)
    tile_x_min = window.x_min // TILE_PIXELS
    tile_z_min = window.z_min // TILE_PIXELS
    tile_x_max = (window.x_max - 1) // TILE_PIXELS
    tile_z_max = (window.z_max - 1) // TILE_PIXELS
    return tuple(
        TileSpec(layer, lod, dimension, tile_x, tile_z)
        for tile_z in range(tile_z_min, tile_z_max + 1)
        for tile_x in range(tile_x_min, tile_x_max + 1)
    )


def _inspect_tiles(
    specs: Iterable[TileSpec],
    tiles_root: Path,
) -> tuple[dict[TileSpec, Path], tuple[Path, ...], tuple[tuple[Path, str], ...]]:
    available: dict[TileSpec, Path] = {}
    missing: list[Path] = []
    corrupt: list[tuple[Path, str]] = []

    for spec in specs:
        path = tile_output_path(tiles_root, spec)
        if not path.is_file():
            missing.append(path)
            continue
        try:
            validate_webp_file(path)
        except WebPValidationError as exc:
            corrupt.append((path, str(exc)))
            continue
        available[spec] = path

    return available, tuple(missing), tuple(corrupt)


def _output_format(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".png":
        return "PNG"
    if suffix == ".webp":
        return "WEBP"
    raise ValueError("output filename must end in .png or .webp")


def _atomic_save(image: Image.Image, output_path: Path, output_format: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        suffix=output_path.suffix,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)

    try:
        if output_format == "WEBP":
            image.save(
                temporary_path,
                format="WEBP",
                lossless=True,
                method=6,
                exact=True,
            )
        else:
            image.save(temporary_path, format="PNG", optimize=True)

        with temporary_path.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary_path, output_path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _annotation_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except OSError:
        return ImageFont.load_default()


def _draw_coordinate_overlay(
    image: Image.Image,
    *,
    block_range: BlockRange,
    window: PixelWindow,
    lod: int,
    scale: int,
    grid_step: int,
    layers: Sequence[str],
) -> None:
    """Draw a labeled X/Z grid and exact range metadata on the image."""

    blocks_per_pixel = 1 << lod
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    line_color = (255, 255, 255, 95)
    label_fill = (255, 255, 255, 235)
    label_background = (0, 0, 0, 185)
    font = _annotation_font(max(12, 13 * scale // 2))
    info_font = _annotation_font(max(13, 15 * scale // 2))

    def x_position(block_x: int) -> int:
        return round(
            ((block_x / blocks_per_pixel) - window.x_min) * scale
        )

    def z_position(block_z: int) -> int:
        return round(
            ((block_z / blocks_per_pixel) - window.z_min) * scale
        )

    first_x = -((-block_range.x_min) // grid_step) * grid_step
    first_z = -((-block_range.z_min) // grid_step) * grid_step
    last_label_x = -10_000
    for block_x in range(first_x, block_range.x_max, grid_step):
        px = x_position(block_x)
        draw.line((px, 0, px, image.height), fill=line_color, width=max(1, scale))
        label = f"X {block_x}"
        box = draw.textbbox((0, 0), label, font=font)
        label_width = box[2] - box[0]
        if px - last_label_x >= label_width + 12:
            draw.rectangle(
                (px + 3, 3, px + label_width + 9, box[3] - box[1] + 9),
                fill=label_background,
            )
            draw.text((px + 6, 6), label, font=font, fill=label_fill)
            last_label_x = px

    last_label_z = -10_000
    for block_z in range(first_z, block_range.z_max, grid_step):
        py = z_position(block_z)
        draw.line((0, py, image.width, py), fill=line_color, width=max(1, scale))
        label = f"Z {block_z}"
        box = draw.textbbox((0, 0), label, font=font)
        label_height = box[3] - box[1]
        label_width = box[2] - box[0]
        if py - last_label_z >= label_height + 10:
            draw.rectangle(
                (3, py + 3, label_width + 9, py + label_height + 9),
                fill=label_background,
            )
            draw.text((6, py + 6), label, font=font, fill=label_fill)
            last_label_z = py

    info = (
        f"X [{block_range.x_min}, {block_range.x_max})  "
        f"Z [{block_range.z_min}, {block_range.z_max})\n"
        f"LOD {lod} · {blocks_per_pixel} bloque(s)/px · "
        f"capas: {','.join(layers)}"
    )
    info_box = draw.multiline_textbbox(
        (0, 0), info, font=info_font, spacing=4
    )
    info_width = info_box[2] - info_box[0]
    info_height = info_box[3] - info_box[1]
    margin = 8
    x0 = max(4, image.width - info_width - margin * 2 - 4)
    y0 = max(4, image.height - info_height - margin * 2 - 4)
    draw.rounded_rectangle(
        (x0, y0, x0 + info_width + margin * 2, y0 + info_height + margin * 2),
        radius=6,
        fill=(0, 0, 0, 205),
        outline=(255, 255, 255, 160),
        width=max(1, scale),
    )
    draw.multiline_text(
        (x0 + margin, y0 + margin),
        info,
        font=info_font,
        fill=(255, 255, 255, 255),
        spacing=4,
    )
    image.alpha_composite(overlay)
    overlay.close()


def compose_mosaic(
    block_range: BlockRange,
    *,
    lod: int,
    dimension: str,
    layer: str,
    layers: Sequence[str] | None = None,
    tiles_root: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    max_pixels: int = DEFAULT_MAX_PIXELS,
    allow_missing: bool = False,
    scale: int = 1,
    show_coordinates: bool = False,
    grid_step: int = 64,
) -> CompositionResult:
    """Validate local tiles and atomically write a cropped PNG or WebP mosaic."""

    if (
        not isinstance(max_pixels, int)
        or isinstance(max_pixels, bool)
        or max_pixels <= 0
    ):
        raise ValueError("max_pixels must be a positive integer")
    if not isinstance(scale, int) or isinstance(scale, bool) or scale <= 0:
        raise ValueError("scale must be a positive integer")
    if (
        not isinstance(grid_step, int)
        or isinstance(grid_step, bool)
        or grid_step <= 0
    ):
        raise ValueError("grid_step must be a positive integer")
    selected_layers = tuple(dict.fromkeys(layers or (layer,)))
    invalid_layers = [item for item in selected_layers if item not in LAYERS]
    if invalid_layers:
        raise ValueError(f"unknown layer(s): {', '.join(invalid_layers)}")

    window = pixel_window(block_range, lod)
    scaled_pixels = window.total_pixels * scale * scale
    if scaled_pixels > max_pixels:
        raise PixelLimitError(
            f"requested mosaic is {window.width * scale}x"
            f"{window.height * scale} ({scaled_pixels:,} pixels), above the "
            f"{max_pixels:,}-pixel safety limit"
        )

    destination = Path(output_path)
    output_format = _output_format(destination)
    root = Path(tiles_root)
    specs = tuple(
        spec
        for selected_layer in selected_layers
        for spec in required_tile_specs(
            block_range,
            lod=lod,
            dimension=dimension,
            layer=selected_layer,
        )
    )
    available, missing, corrupt = _inspect_tiles(specs, root)

    if corrupt:
        raise CorruptTilesError(corrupt)
    if missing and not allow_missing:
        raise MissingTilesError(missing)

    destination_resolved = destination.resolve(strict=False)
    if any(path.resolve(strict=False) == destination_resolved for path in available.values()):
        raise ValueError("output path must not overwrite a source tile")

    canvas = Image.new(
        "RGBA",
        (window.width, window.height),
        (0, 0, 0, 0),
    )
    try:
        for spec in specs:
            path = available.get(spec)
            if path is None:
                continue

            tile_pixel_x = spec.tile_x * TILE_PIXELS
            tile_pixel_z = spec.tile_z * TILE_PIXELS
            intersect_x_min = max(window.x_min, tile_pixel_x)
            intersect_z_min = max(window.z_min, tile_pixel_z)
            intersect_x_max = min(window.x_max, tile_pixel_x + TILE_PIXELS)
            intersect_z_max = min(window.z_max, tile_pixel_z + TILE_PIXELS)

            source_box = (
                intersect_x_min - tile_pixel_x,
                intersect_z_min - tile_pixel_z,
                intersect_x_max - tile_pixel_x,
                intersect_z_max - tile_pixel_z,
            )
            destination_xy = (
                intersect_x_min - window.x_min,
                intersect_z_min - window.z_min,
            )

            with Image.open(path) as source:
                tile = source.convert("RGBA")
            try:
                region = tile.crop(source_box)
                try:
                    canvas.alpha_composite(region, dest=destination_xy)
                finally:
                    region.close()
            finally:
                tile.close()

        output_image = canvas
        scaled_image: Image.Image | None = None
        if scale != 1:
            scaled_image = canvas.resize(
                (canvas.width * scale, canvas.height * scale),
                resample=Image.Resampling.NEAREST,
            )
            output_image = scaled_image
        try:
            if show_coordinates:
                _draw_coordinate_overlay(
                    output_image,
                    block_range=block_range,
                    window=window,
                    lod=lod,
                    scale=scale,
                    grid_step=grid_step,
                    layers=selected_layers,
                )
            _atomic_save(output_image, destination, output_format)
        finally:
            if scaled_image is not None:
                scaled_image.close()
    finally:
        canvas.close()

    return CompositionResult(
        output_path=destination,
        width=window.width * scale,
        height=window.height * scale,
        tiles_used=len(available),
        missing_paths=missing,
        pixel_x_min=window.x_min,
        pixel_z_min=window.z_min,
    )


def resolve_block_range(args: argparse.Namespace) -> BlockRange:
    """Resolve either explicit half-open bounds or legacy center/area options."""

    explicit_values = (args.x_min, args.z_min, args.x_max, args.z_max)
    center_values = (args.center_x, args.center_z)
    has_explicit = any(value is not None for value in explicit_values)
    has_center = any(value is not None for value in center_values)
    has_area = args.area is not None

    if has_explicit and (has_center or has_area):
        raise ValueError(
            "use either explicit --x-min/--z-min/--x-max/--z-max bounds "
            "or --center-x/--center-z/--area"
        )
    if has_explicit:
        if any(value is None for value in explicit_values):
            raise ValueError(
                "explicit mode requires --x-min, --z-min, --x-max, and --z-max"
            )
        return BlockRange(*explicit_values)

    if not has_center:
        if has_area:
            raise ValueError("--area requires --center-x and --center-z")
        raise ValueError(
            "provide explicit bounds or --center-x and --center-z"
        )
    if any(value is None for value in center_values):
        raise ValueError("center mode requires both --center-x and --center-z")
    return BlockRange.from_center(
        args.center_x,
        args.center_z,
        DEFAULT_AREA if args.area is None else args.area,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compose downloaded 2b2t.place tiles for a half-open X/Z block range."
        )
    )
    parser.add_argument("--x-min", type=int)
    parser.add_argument("--z-min", type=int)
    parser.add_argument("--x-max", type=int)
    parser.add_argument("--z-max", type=int)
    parser.add_argument("--center-x", type=int)
    parser.add_argument("--center-z", type=int)
    parser.add_argument(
        "--area",
        type=int,
        help=f"Legacy square side length in blocks (default: {DEFAULT_AREA}).",
    )
    parser.add_argument("--lod", type=int, choices=LODS, default=3)
    parser.add_argument(
        "--dimension",
        choices=tuple(DIMENSIONS),
        default="overworld",
    )
    layer_group = parser.add_mutually_exclusive_group()
    layer_group.add_argument(
        "--layer",
        choices=LAYERS,
        default="base",
        help="Single layer to compose (default: base).",
    )
    layer_group.add_argument(
        "--layers",
        help=(
            "Comma-separated layers in bottom-to-top order, for example "
            "base,overlay."
        ),
    )
    parser.add_argument(
        "--tiles-root",
        type=Path,
        default=Path("2b2t_tiles"),
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--max-pixels",
        type=int,
        default=DEFAULT_MAX_PIXELS,
        help=f"Refuse larger mosaics (default: {DEFAULT_MAX_PIXELS:,}).",
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="Write transparent pixels where local tile files are missing.",
    )
    parser.add_argument(
        "--scale",
        type=int,
        default=1,
        help="Nearest-neighbour display enlargement (default: 1).",
    )
    parser.add_argument(
        "--show-coordinates",
        action="store_true",
        help="Draw an X/Z coordinate grid and range information on the image.",
    )
    parser.add_argument(
        "--grid-step",
        type=int,
        default=64,
        help="Coordinate-grid spacing in Minecraft blocks (default: 64).",
    )
    return parser


def _report_paths(
    heading: str,
    rows: Iterable[tuple[Path, str | None]],
    *,
    limit: int = 50,
) -> None:
    values = tuple(rows)
    print(f"{heading}: {len(values)}", file=sys.stderr)
    for path, detail in values[:limit]:
        suffix = f": {detail}" if detail else ""
        print(f"  {path}{suffix}", file=sys.stderr)
    if len(values) > limit:
        print(f"  ... and {len(values) - limit} more", file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        block_range = resolve_block_range(args)
    except (TypeError, ValueError) as exc:
        parser.error(str(exc))

    selected_layers: tuple[str, ...] | None = None
    if args.layers:
        selected_layers = tuple(
            value.strip() for value in args.layers.split(",") if value.strip()
        )
        if not selected_layers:
            parser.error("--layers must contain at least one layer")
        unknown_layers = [
            value for value in selected_layers if value not in LAYERS
        ]
        if unknown_layers:
            parser.error(
                "--layers contains unknown value(s): "
                + ", ".join(unknown_layers)
            )

    try:
        result = compose_mosaic(
            block_range,
            lod=args.lod,
            dimension=args.dimension,
            layer=args.layer,
            layers=selected_layers,
            tiles_root=args.tiles_root,
            output_path=args.out,
            max_pixels=args.max_pixels,
            allow_missing=args.allow_missing,
            scale=args.scale,
            show_coordinates=args.show_coordinates,
            grid_step=args.grid_step,
        )
    except MissingTilesError as exc:
        _report_paths(
            "Missing tiles",
            ((path, None) for path in exc.paths),
        )
        print("Use --allow-missing to render transparent gaps.", file=sys.stderr)
        return MISSING_EXIT_CODE
    except CorruptTilesError as exc:
        _report_paths("Corrupt tiles", exc.failures)
        return CORRUPT_EXIT_CODE
    except (MosaicError, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if result.missing_paths:
        _report_paths(
            "Missing tiles rendered as transparent",
            ((path, None) for path in result.missing_paths),
        )
    print(
        f"Wrote {result.output_path.resolve()} "
        f"({result.width}x{result.height} px, "
        f"{result.tiles_used} tile(s) used, "
        f"{len(result.missing_paths)} missing)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
