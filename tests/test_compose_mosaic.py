from __future__ import annotations

import argparse
import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image, features

from compose_mosaic import (
    CORRUPT_EXIT_CODE,
    DEFAULT_AREA,
    MISSING_EXIT_CODE,
    BlockRange,
    CorruptTilesError,
    MissingTilesError,
    PixelLimitError,
    build_parser,
    compose_mosaic,
    main,
    pixel_window,
    required_tile_specs,
    resolve_block_range,
)
from tile_core import TileSpec, tile_output_path


@unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
class ComposeMosaicTests(unittest.TestCase):
    @staticmethod
    def write_tile(
        root: Path,
        spec: TileSpec,
        color: tuple[int, int, int, int],
    ) -> Path:
        path = tile_output_path(root, spec)
        path.parent.mkdir(parents=True, exist_ok=True)
        with Image.new("RGBA", (512, 512), color) as image:
            image.save(path, "WEBP", lossless=True, exact=True)
        return path

    def test_negative_coordinates_and_x_right_z_down_orientation(self) -> None:
        colors = {
            (-1, -1): (255, 0, 0, 255),
            (0, -1): (0, 255, 0, 255),
            (-1, 0): (0, 0, 255, 255),
            (0, 0): (255, 255, 0, 255),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            for (tile_x, tile_z), color in colors.items():
                self.write_tile(
                    root,
                    TileSpec("base", 0, "overworld", tile_x, tile_z),
                    color,
                )

            output = Path(directory) / "mosaic.png"
            result = compose_mosaic(
                BlockRange(-2, -2, 2, 2),
                lod=0,
                dimension="overworld",
                layer="base",
                tiles_root=root,
                output_path=output,
                max_pixels=16,
            )

            self.assertEqual((result.width, result.height), (4, 4))
            self.assertEqual(result.tiles_used, 4)
            self.assertEqual(result.missing_paths, ())
            with Image.open(output) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.getpixel((0, 0)), colors[(-1, -1)])
                self.assertEqual(image.getpixel((3, 0)), colors[(0, -1)])
                self.assertEqual(image.getpixel((0, 3)), colors[(-1, 0)])
                self.assertEqual(image.getpixel((3, 3)), colors[(0, 0)])

    def test_half_open_unaligned_range_at_lod(self) -> None:
        block_range = BlockRange(1, 1, 9, 9)
        window = pixel_window(block_range, lod=3)
        self.assertEqual(
            (window.x_min, window.z_min, window.x_max, window.z_max),
            (0, 0, 2, 2),
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            self.write_tile(
                root,
                TileSpec("base", 3, "overworld", 0, 0),
                (10, 20, 30, 255),
            )
            output = Path(directory) / "lod.png"
            result = compose_mosaic(
                block_range,
                lod=3,
                dimension="overworld",
                layer="base",
                tiles_root=root,
                output_path=output,
                max_pixels=4,
            )
            self.assertEqual((result.width, result.height), (2, 2))

    def test_missing_tiles_fail_without_writing_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "missing.png"
            with self.assertRaises(MissingTilesError) as raised:
                compose_mosaic(
                    BlockRange(0, 0, 1, 1),
                    lod=0,
                    dimension="overworld",
                    layer="base",
                    tiles_root=Path(directory) / "tiles",
                    output_path=output,
                )
            self.assertEqual(len(raised.exception.paths), 1)
            self.assertFalse(output.exists())

    def test_allow_missing_writes_transparent_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "missing.png"
            result = compose_mosaic(
                BlockRange(0, 0, 2, 2),
                lod=0,
                dimension="overworld",
                layer="base",
                tiles_root=Path(directory) / "tiles",
                output_path=output,
                allow_missing=True,
            )
            self.assertEqual(len(result.missing_paths), 1)
            with Image.open(output) as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))

    def test_corrupt_tile_fails_even_when_missing_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            spec = TileSpec("base", 0, "overworld", 0, 0)
            path = tile_output_path(root, spec)
            path.parent.mkdir(parents=True)
            path.write_bytes(b"not a WebP")

            with self.assertRaises(CorruptTilesError) as raised:
                compose_mosaic(
                    BlockRange(0, 0, 1, 1),
                    lod=0,
                    dimension="overworld",
                    layer="base",
                    tiles_root=root,
                    output_path=Path(directory) / "corrupt.png",
                    allow_missing=True,
                )
            self.assertEqual(raised.exception.failures[0][0], path)

    def test_max_pixels_checked_before_tile_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(PixelLimitError):
                compose_mosaic(
                    BlockRange(0, 0, 11, 10),
                    lod=0,
                    dimension="overworld",
                    layer="base",
                    tiles_root=Path(directory) / "tiles",
                    output_path=Path(directory) / "too-large.png",
                    max_pixels=100,
                )

    def test_lossless_webp_output(self) -> None:
        color = (12, 34, 56, 255)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            self.write_tile(
                root,
                TileSpec("base", 0, "overworld", 0, 0),
                color,
            )
            output = Path(directory) / "mosaic.webp"
            compose_mosaic(
                BlockRange(0, 0, 2, 2),
                lod=0,
                dimension="overworld",
                layer="base",
                tiles_root=root,
                output_path=output,
                max_pixels=4,
            )
            with Image.open(output) as image:
                image.load()
                self.assertEqual(image.format, "WEBP")
                self.assertEqual(image.convert("RGBA").getpixel((1, 1)), color)

    def test_multilayer_composition_and_nearest_neighbour_scale(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            self.write_tile(
                root,
                TileSpec("base", 0, "overworld", 0, 0),
                (255, 0, 0, 255),
            )
            self.write_tile(
                root,
                TileSpec("overlay", 0, "overworld", 0, 0),
                (0, 0, 255, 128),
            )
            output = Path(directory) / "layers.png"
            result = compose_mosaic(
                BlockRange(0, 0, 4, 4),
                lod=0,
                dimension="overworld",
                layer="base",
                layers=("base", "overlay"),
                tiles_root=root,
                output_path=output,
                max_pixels=144,
                scale=3,
            )
            self.assertEqual((result.width, result.height), (12, 12))
            self.assertEqual(result.tiles_used, 2)
            with Image.open(output) as image:
                self.assertEqual(image.size, (12, 12))
                pixel = image.convert("RGBA").getpixel((6, 6))
                self.assertGreater(pixel[2], 100)
                self.assertGreater(pixel[0], 100)
                self.assertEqual(pixel[3], 255)

    def test_coordinate_overlay_changes_grid_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            base_color = (20, 40, 60, 255)
            self.write_tile(
                root,
                TileSpec("base", 0, "overworld", 0, 0),
                base_color,
            )
            output = Path(directory) / "coordinates.png"
            result = compose_mosaic(
                BlockRange(0, 0, 128, 128),
                lod=0,
                dimension="overworld",
                layer="base",
                tiles_root=root,
                output_path=output,
                max_pixels=65_536,
                scale=2,
                show_coordinates=True,
                grid_step=64,
            )
            self.assertEqual((result.width, result.height), (256, 256))
            with Image.open(output) as image:
                image = image.convert("RGBA")
                self.assertNotEqual(image.getpixel((128, 100)), base_color)

    def test_required_tiles_follow_z_then_x_order(self) -> None:
        specs = required_tile_specs(
            BlockRange(-1, -1, 1, 1),
            lod=0,
            dimension="nether",
            layer="overlay",
        )
        self.assertEqual(
            [(spec.tile_x, spec.tile_z) for spec in specs],
            [(-1, -1), (0, -1), (-1, 0), (0, 0)],
        )

    def test_main_returns_nonzero_for_missing_unless_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            common = [
                "--x-min",
                "0",
                "--z-min",
                "0",
                "--x-max",
                "1",
                "--z-max",
                "1",
                "--lod",
                "0",
                "--tiles-root",
                str(Path(directory) / "tiles"),
                "--out",
                str(Path(directory) / "out.png"),
            ]
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(main(common), MISSING_EXIT_CODE)
            self.assertIn("Missing tiles: 1", stderr.getvalue())

            stderr = io.StringIO()
            stdout = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
                self.assertEqual(main([*common, "--allow-missing"]), 0)
            self.assertIn("rendered as transparent", stderr.getvalue())

    def test_main_returns_corrupt_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "tiles"
            spec = TileSpec("base", 0, "overworld", 0, 0)
            path = tile_output_path(root, spec)
            path.parent.mkdir(parents=True)
            path.write_bytes(b"bad")
            args = [
                "--x-min",
                "0",
                "--z-min",
                "0",
                "--x-max",
                "1",
                "--z-max",
                "1",
                "--lod",
                "0",
                "--tiles-root",
                str(root),
                "--out",
                str(Path(directory) / "out.png"),
            ]
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(args), CORRUPT_EXIT_CODE)


class CoordinateArgumentTests(unittest.TestCase):
    def test_explicit_half_open_bounds(self) -> None:
        args = argparse.Namespace(
            x_min=-10,
            z_min=-20,
            x_max=30,
            z_max=40,
            center_x=None,
            center_z=None,
            area=None,
        )
        self.assertEqual(
            resolve_block_range(args),
            BlockRange(-10, -20, 30, 40),
        )

    def test_center_area_compatibility_and_default(self) -> None:
        args = argparse.Namespace(
            x_min=None,
            z_min=None,
            x_max=None,
            z_max=None,
            center_x=100,
            center_z=-100,
            area=9,
        )
        self.assertEqual(
            resolve_block_range(args),
            BlockRange(96, -104, 105, -95),
        )
        args.area = None
        result = resolve_block_range(args)
        self.assertEqual(result.x_max - result.x_min, DEFAULT_AREA)
        self.assertEqual(result.z_max - result.z_min, DEFAULT_AREA)

    def test_incomplete_or_mixed_coordinate_modes_are_rejected(self) -> None:
        incomplete = argparse.Namespace(
            x_min=0,
            z_min=0,
            x_max=1,
            z_max=None,
            center_x=None,
            center_z=None,
            area=None,
        )
        with self.assertRaises(ValueError):
            resolve_block_range(incomplete)

        mixed = argparse.Namespace(
            x_min=0,
            z_min=0,
            x_max=1,
            z_max=1,
            center_x=0,
            center_z=0,
            area=1,
        )
        with self.assertRaises(ValueError):
            resolve_block_range(mixed)

    def test_parser_supports_required_cli_surface(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "--center-x",
                "-84841",
                "--center-z",
                "170857",
                "--area",
                "4096",
                "--lod",
                "3",
                "--dimension",
                "end",
                "--layer",
                "newchunks",
                "--tiles-root",
                "/tmp/tiles",
                "--out",
                "/tmp/map.webp",
                "--max-pixels",
                "1000",
                "--allow-missing",
                "--scale",
                "3",
                "--show-coordinates",
                "--grid-step",
                "128",
            ]
        )
        self.assertEqual(args.dimension, "end")
        self.assertEqual(args.layer, "newchunks")
        self.assertTrue(args.allow_missing)
        self.assertEqual(args.scale, 3)
        self.assertTrue(args.show_coordinates)
        self.assertEqual(args.grid_step, 128)


if __name__ == "__main__":
    unittest.main()
