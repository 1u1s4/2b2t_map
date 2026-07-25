from __future__ import annotations

import argparse
import contextlib
import io
import json
import logging
import math
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, features

from tile_download_core import (
    AdaptiveRateLimiter,
    DownloadResult,
    DownloadTask,
    TileDatabase,
    TileFetcher,
    TileSpec,
)
from download_region_2b2t import (
    DEFAULT_ESTIMATED_TILE_BYTES,
    JsonlProgressReporter,
    REGION_DOWNLOAD_LOCK_NAME,
    RegionDownloadLock,
    RegionDownloadLockedError,
    download_region_tasks,
    estimate_region_storage,
    iter_region_tasks,
    main,
    parse_layers,
    region_tile_count,
    required_region_specs,
    resolve_region,
    seed_region_tasks,
)


class RegionDownloadLockTests(unittest.TestCase):
    def test_residual_lock_file_is_reused_and_metadata_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path = root / REGION_DOWNLOAD_LOCK_NAME
            lock_path.write_text(
                '{"pid":999999,"started_at":"stale"}\n',
                encoding="utf-8",
            )

            lock = RegionDownloadLock(root)
            lock.acquire()
            try:
                metadata = json.loads(lock_path.read_text(encoding="utf-8"))
                self.assertEqual(metadata["pid"], os.getpid())
                self.assertNotEqual(metadata["started_at"], "stale")
            finally:
                lock.release()

            self.assertTrue(lock_path.exists())

    def test_second_lock_is_refused_until_first_is_released(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = RegionDownloadLock(root)
            second = RegionDownloadLock(root)
            first.acquire()
            try:
                with self.assertRaises(RegionDownloadLockedError) as caught:
                    second.acquire()
                self.assertEqual(caught.exception.metadata["pid"], os.getpid())
            finally:
                first.release()

            second.acquire()
            second.release()

    def test_context_manager_releases_lock_after_exception(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "sentinel"):
                with RegionDownloadLock(root):
                    raise RuntimeError("sentinel")

            with RegionDownloadLock(root):
                pass


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

    def test_full_atlas_sector_inventory_is_lazy_and_indexable(self) -> None:
        region = resolve_region(
            namespace(
                x_min=0,
                z_min=0,
                x_max=32_768,
                z_max=32_768,
            )
        )
        specs = required_region_specs(
            region,
            lod=0,
            dimension="overworld",
            layers=("base", "overlay", "newchunks"),
        )

        self.assertEqual(len(specs), 12_288)
        self.assertEqual(
            (specs[0].layer, specs[0].tile_x, specs[0].tile_z),
            ("base", 0, 0),
        )
        self.assertEqual(
            (specs[-1].layer, specs[-1].tile_x, specs[-1].tile_z),
            ("newchunks", 63, 63),
        )
        self.assertFalse(isinstance(specs, tuple))


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


class RegionPipelineTests(unittest.TestCase):
    def test_confirmed_absent_row_is_reused_without_fetching(self) -> None:
        class AbsentFetcher:
            calls = 0

            @classmethod
            def fetch(cls, task):
                cls.calls += 1
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                    error="tile no publicado",
                )

        class FetchMustNotRun:
            @staticmethod
            def fetch(_task):
                raise AssertionError("a confirmed 404 must not be requested again")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            specs = required_region_specs(
                resolve_region(
                    namespace(x_min=0, z_min=0, x_max=512, z_max=512)
                ),
                lod=0,
                dimension="overworld",
                layers=("base",),
            )
            try:
                first = download_region_tasks(
                    iter_region_tasks(database, root, specs),
                    fetcher=AbsentFetcher(),
                    database=database,
                    output_root=root,
                    lod=0,
                    workers=1,
                    stop_event=threading.Event(),
                    logger=logging.getLogger("test_first_404"),
                    total_tasks=1,
                )
                self.assertEqual((first.absent, AbsentFetcher.calls), (1, 1))

                resumed = download_region_tasks(
                    iter_region_tasks(database, root, specs),
                    fetcher=FetchMustNotRun(),
                    database=database,
                    output_root=root,
                    lod=0,
                    workers=1,
                    stop_event=threading.Event(),
                    logger=logging.getLogger("test_resumed_404"),
                    total_tasks=1,
                )
                self.assertEqual(resumed.absent, 1)
                self.assertEqual(resumed.reused_absent, 1)
                self.assertEqual(resumed.failed, 0)
            finally:
                database.close()

    def test_executor_consumes_only_the_bounded_pending_window(self) -> None:
        state = SimpleNamespace(yielded=0, recorded=0, maximum_ahead=0)

        class Tasks:
            def __iter__(self):
                for index in range(2_000):
                    state.yielded += 1
                    state.maximum_ahead = max(
                        state.maximum_ahead,
                        state.yielded - state.recorded,
                    )
                    yield DownloadTask(
                        row_id=index + 1,
                        spec=TileSpec("overworld", "base", 0, index, 0),
                        selected=True,
                    )

        class ImmediateFetcher:
            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200,
                    attempts=1,
                    size_bytes=100,
                )

        class RecordingDatabase:
            @staticmethod
            def record_result(*_args, **_kwargs):
                state.recorded += 1

        summary = download_region_tasks(
            Tasks(),
            fetcher=ImmediateFetcher(),
            database=RecordingDatabase(),
            output_root=Path("/tmp/unused-region-pipeline"),
            lod=0,
            workers=2,
            stop_event=threading.Event(),
            logger=logging.getLogger("test_bounded_pipeline"),
            total_tasks=2_000,
            max_pending_tasks=7,
        )

        self.assertEqual((summary.complete, summary.failed), (2_000, 0))
        self.assertLessEqual(state.maximum_ahead, 7)

    def test_progress_jsonl_is_parseable_and_monotonic(self) -> None:
        class MixedFetcher:
            @staticmethod
            def fetch(task):
                if task.spec.tile_x == 0:
                    return DownloadResult(
                        task=task,
                        status="complete",
                        exists=True,
                        http_code=None,
                        attempts=0,
                        size_bytes=50,
                    )
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                )

        class NoopDatabase:
            @staticmethod
            def record_result(*_args, **_kwargs):
                return None

        tasks = (
            DownloadTask(
                row_id=index + 1,
                spec=TileSpec("overworld", "base", 0, index, 0),
                selected=True,
            )
            for index in range(2)
        )
        output = io.StringIO()
        summary = download_region_tasks(
            tasks,
            fetcher=MixedFetcher(),
            database=NoopDatabase(),
            output_root=Path("/tmp/unused-region-progress"),
            lod=0,
            workers=1,
            stop_event=threading.Event(),
            logger=logging.getLogger("test_jsonl_progress"),
            total_tasks=2,
            progress=JsonlProgressReporter(output),
        )

        messages = [
            json.loads(line)
            for line in output.getvalue().splitlines()
        ]
        self.assertEqual(messages[0]["event"], "start")
        self.assertEqual(messages[-1]["event"], "summary")
        self.assertEqual(messages[-1]["status"], "complete")
        self.assertEqual(messages[-1]["processed"], 2)
        self.assertEqual(messages[-1]["percent"], 100.0)
        self.assertEqual(
            [message["processed"] for message in messages],
            sorted(message["processed"] for message in messages),
        )
        self.assertEqual((summary.complete, summary.absent), (1, 1))

    def test_disk_is_rechecked_by_batch_and_stops_safely(self) -> None:
        class CompleteFetcher:
            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200,
                    attempts=1,
                    size_bytes=100,
                )

        class NoopDatabase:
            @staticmethod
            def record_result(*_args, **_kwargs):
                return None

        tasks = (
            DownloadTask(
                row_id=index + 1,
                spec=TileSpec("overworld", "base", 0, index, 0),
                selected=True,
            )
            for index in range(10)
        )
        with patch(
            "download_region_2b2t.shutil.disk_usage",
            side_effect=[
                SimpleNamespace(free=10_000),
                SimpleNamespace(free=99),
            ],
        ):
            summary = download_region_tasks(
                tasks,
                fetcher=CompleteFetcher(),
                database=NoopDatabase(),
                output_root=Path("/tmp/unused-region-disk"),
                lod=0,
                workers=1,
                stop_event=threading.Event(),
                logger=logging.getLogger("test_disk_batches"),
                total_tasks=10,
                max_pending_tasks=1,
                disk_check_path=Path("/tmp/unused-region-disk"),
                minimum_free_bytes=100,
                disk_check_interval=1,
            )

        self.assertTrue(summary.interrupted)
        self.assertEqual(summary.stop_reason, "insufficient-disk")
        self.assertEqual(summary.processed, 1)

    def test_cli_jsonl_stdout_contains_no_human_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            spec = TileSpec("overworld", "base", 0, 0, 0)
            task = database.prepare_download_task(
                spec,
                root,
                selected=True,
            )
            database.record_result(
                DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                ),
                root,
                min_lod=0,
                selected_lods={0},
            )
            database.close()

            stdout = io.StringIO()
            stderr = io.StringIO()
            try:
                with (
                    contextlib.redirect_stdout(stdout),
                    contextlib.redirect_stderr(stderr),
                ):
                    exit_code = main(
                        [
                            "--x-min",
                            "0",
                            "--z-min",
                            "0",
                            "--x-max",
                            "512",
                            "--z-max",
                            "512",
                            "--layers",
                            "base",
                            "--out",
                            str(root),
                            "--max-tiles",
                            "1",
                            "--progress-jsonl",
                        ]
                    )
            finally:
                logger = logging.getLogger("download_region_2b2t")
                for handler in logger.handlers:
                    handler.close()
                logger.handlers.clear()

        messages = [
            json.loads(line)
            for line in stdout.getvalue().splitlines()
        ]
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [message["event"] for message in messages],
            ["start", "summary"],
        )
        self.assertTrue(
            all(message["type"] == "region-download" for message in messages)
        )
        self.assertIn("Descarga regional:", stderr.getvalue())


class RegionStorageTests(unittest.TestCase):
    def test_preflight_uses_one_mib_fallback_not_response_ceiling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            inventory = required_region_specs(
                resolve_region(
                    namespace(x_min=0, z_min=0, x_max=512, z_max=512)
                ),
                lod=0,
                dimension="overworld",
                layers=("base",),
            )
            try:
                estimate = estimate_region_storage(
                    inventory,
                    database=database,
                    output_root=root,
                    max_tile_bytes=10 * 1024 * 1024,
                )
            finally:
                database.close()

        self.assertEqual(estimate.missing, 1)
        self.assertEqual(
            estimate.estimated_tile_bytes,
            DEFAULT_ESTIMATED_TILE_BYTES,
        )
        self.assertEqual(
            estimate.required_bytes,
            math.ceil(DEFAULT_ESTIMATED_TILE_BYTES * 1.20),
        )
        self.assertLess(estimate.required_bytes, 10 * 1024 * 1024)

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_preflight_excludes_valid_and_confirmed_absent_tiles(self) -> None:
        class AbsentFetcher:
            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            inventory = required_region_specs(
                resolve_region(
                    namespace(x_min=0, z_min=0, x_max=1_536, z_max=512)
                ),
                lod=0,
                dimension="overworld",
                layers=("base",),
            )
            valid_path = inventory[0].path(root)
            valid_path.parent.mkdir(parents=True)
            with Image.new("RGB", (512, 512), (1, 2, 3)) as image:
                image.save(valid_path, "WEBP", lossless=True)
            try:
                absent_task = database.prepare_download_task(
                    inventory[1],
                    root,
                    selected=True,
                )
                database.record_result(
                    AbsentFetcher.fetch(absent_task),
                    root,
                    min_lod=0,
                    selected_lods={0},
                )
                estimate = estimate_region_storage(
                    inventory,
                    database=database,
                    output_root=root,
                    max_tile_bytes=10 * 1024 * 1024,
                )
            finally:
                database.close()

        self.assertEqual(estimate.requested, 3)
        self.assertEqual(estimate.existing_complete, 1)
        self.assertEqual(estimate.reusable_absent, 1)
        self.assertEqual(estimate.missing, 1)


if __name__ == "__main__":
    unittest.main()
