from __future__ import annotations

import argparse
import logging
import tempfile
import threading
import unittest
from pathlib import Path

from PIL import Image, features

from download_all_2b2t import (
    AdaptiveRateLimiter,
    DownloadResult,
    TileDatabase,
    TileFetcher,
    TileSpec,
)
from download_region_2b2t import (
    download_region_tasks,
    parse_layers,
    region_tile_count,
    required_region_specs,
    resolve_region,
    seed_region_tasks,
)


def namespace(**values: int | None) -> argparse.Namespace:
    defaults = {
        "x_min": None,
        "z_min": None,
        "x_max": None,
        "z_max": None,
        "center_x": None,
        "center_z": None,
        "width": None,
        "height": None,
    }
    defaults.update(values)
    return argparse.Namespace(**defaults)


class RegionBoundsTests(unittest.TestCase):
    def test_explicit_bounds_remain_half_open(self) -> None:
        region = resolve_region(
            namespace(x_min=-10, z_min=20, x_max=31, z_max=45)
        )
        self.assertEqual(
            (region.x_min, region.z_min, region.x_max, region.z_max),
            (-10, 20, 31, 45),
        )

    def test_centered_capture_bounds_are_exact(self) -> None:
        region = resolve_region(
            namespace(
                center_x=-85_181,
                center_z=168_232,
                width=418,
                height=262,
            )
        )
        self.assertEqual(
            (region.x_min, region.z_min, region.x_max, region.z_max),
            (-85_390, 168_101, -84_972, 168_363),
        )

    def test_centered_odd_dimensions_keep_requested_size(self) -> None:
        region = resolve_region(
            namespace(center_x=0, center_z=0, width=3, height=5)
        )
        self.assertEqual(
            (region.x_min, region.z_min, region.x_max, region.z_max),
            (-1, -2, 2, 3),
        )

    def test_mixed_or_partial_modes_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            resolve_region(
                namespace(
                    x_min=0,
                    z_min=0,
                    x_max=1,
                    z_max=1,
                    center_x=0,
                )
            )
        with self.assertRaises(ValueError):
            resolve_region(namespace(center_x=0, center_z=0, width=1))

    def test_layer_csv_is_deduplicated_and_validated(self) -> None:
        self.assertEqual(parse_layers("base, overlay,base"), ("base", "overlay"))
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_layers("base,unknown")

    def test_huge_inventory_is_counted_without_materializing_specs(self) -> None:
        region = resolve_region(
            namespace(
                x_min=-10**12,
                z_min=-10**12,
                x_max=10**12,
                z_max=10**12,
            )
        )
        self.assertGreater(
            region_tile_count(region, lod=0, layer_count=2),
            10_000,
        )


class RegionTileTests(unittest.TestCase):
    def test_capture_requires_two_tiles_per_layer(self) -> None:
        region = resolve_region(
            namespace(
                center_x=-85_181,
                center_z=168_232,
                width=418,
                height=262,
            )
        )
        specs = required_region_specs(
            region,
            lod=0,
            dimension="overworld",
            layers=("base", "overlay"),
        )
        self.assertEqual(
            [
                (spec.layer, spec.tile_x, spec.tile_z)
                for spec in specs
            ],
            [
                ("base", -167, 328),
                ("base", -166, 328),
                ("overlay", -167, 328),
                ("overlay", -166, 328),
            ],
        )

    def test_negative_boundary_uses_floor_division(self) -> None:
        specs = required_region_specs(
            resolve_region(namespace(x_min=-513, z_min=-1, x_max=1, z_max=1)),
            lod=0,
            dimension="overworld",
            layers=("base",),
        )
        self.assertEqual(
            [(spec.tile_x, spec.tile_z) for spec in specs],
            [(-2, -1), (-1, -1), (0, -1), (-2, 0), (-1, 0), (0, 0)],
        )

    def test_seed_uses_canonical_path_and_persists_result(self) -> None:
        class AbsentFetcher:
            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                    error="tile no publicado",
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            try:
                spec = TileSpec("overworld", "overlay", 0, -33, 4)
                tasks = seed_region_tasks(database, root, (spec,))
                row = database.connection.execute(
                    "SELECT relative_path FROM tiles WHERE id=?",
                    (tasks[0].row_id,),
                ).fetchone()
                self.assertEqual(
                    row["relative_path"],
                    "overlay/0/overworld/-1/0/t.-33.4.webp",
                )

                summary = download_region_tasks(
                    tasks,
                    fetcher=AbsentFetcher(),
                    database=database,
                    output_root=root,
                    lod=0,
                    workers=1,
                    stop_event=threading.Event(),
                    logger=logging.getLogger("test_region_downloader"),
                )
                self.assertEqual(summary.absent, 1)
                status = database.connection.execute(
                    "SELECT status, http_code FROM tiles WHERE id=?",
                    (tasks[0].row_id,),
                ).fetchone()
                self.assertEqual((status["status"], status["http_code"]), ("absent", 404))
            finally:
                database.close()

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_existing_valid_webp_is_reused_without_http(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            stop_event = threading.Event()
            logger = logging.getLogger("test_region_resume")
            try:
                spec = TileSpec("overworld", "base", 0, 0, 0)
                path = spec.path(root)
                path.parent.mkdir(parents=True)
                with Image.new("RGB", (512, 512), (1, 2, 3)) as image:
                    image.save(path, "WEBP", lossless=True)
                tasks = seed_region_tasks(database, root, (spec,))
                fetcher = TileFetcher(
                    root,
                    limiter=AdaptiveRateLimiter(1, stop_event),
                    stop_event=stop_event,
                    timeout=0.01,
                    retries=1,
                    max_tile_bytes=10 * 1024 * 1024,
                    logger=logger,
                )

                summary = download_region_tasks(
                    tasks,
                    fetcher=fetcher,
                    database=database,
                    output_root=root,
                    lod=0,
                    workers=1,
                    stop_event=stop_event,
                    logger=logger,
                )
                self.assertEqual((summary.complete, summary.reused), (1, 1))
                row = database.connection.execute(
                    "SELECT status, attempts, sha256 FROM tiles WHERE id=?",
                    (tasks[0].row_id,),
                ).fetchone()
                self.assertEqual((row["status"], row["attempts"]), ("complete", 0))
                self.assertEqual(len(row["sha256"]), 64)
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
