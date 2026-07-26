from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import logging
import math
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import requests
from PIL import Image, features
from requests.adapters import HTTPAdapter

from tile_download_core import (
    AdaptiveRateLimiter,
    DownloadResult,
    DownloadTask,
    TileDatabase,
    TileFetcher,
    TileSpec,
    parse_retry_after,
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


class AdaptiveRateLimiterTests(unittest.TestCase):
    def test_retry_after_rejects_nonfinite_and_negative_values(self) -> None:
        self.assertEqual(parse_retry_after("1.5"), 1.5)
        self.assertEqual(parse_retry_after("0"), 0.0)
        for value in ("-1", "nan", "inf", "-inf", ""):
            with self.subTest(value=value):
                self.assertIsNone(parse_retry_after(value))

    def test_constructor_and_mutators_require_strict_finite_values(self) -> None:
        stop_event = threading.Event()
        for value in (0, -1, math.inf, -math.inf, math.nan, True):
            with self.subTest(rate=value):
                with self.assertRaises(ValueError):
                    AdaptiveRateLimiter(value, stop_event)
        with self.assertRaises(ValueError):
            AdaptiveRateLimiter(1, stop_event, initial_rate=2)
        with self.assertRaises(ValueError):
            AdaptiveRateLimiter(1, stop_event, initial_rate=math.nan)
        with self.assertRaises(ValueError):
            AdaptiveRateLimiter(1, stop_event, recovery_successes=0)

        limiter = AdaptiveRateLimiter(1, stop_event)
        for value in (0, -1, math.inf, math.nan, True):
            with self.subTest(factor=value):
                with self.assertRaises(ValueError):
                    limiter.slow_down(value)
        for value in (-1, math.inf, math.nan, True):
            with self.subTest(cooldown=value):
                with self.assertRaises(ValueError):
                    limiter.defer(value)
        self.assertEqual(limiter.defer(0), 0)

    def test_global_cooldown_delays_the_next_acquisition(self) -> None:
        clock = [100.0]
        waits: list[float] = []

        class AdvancingEvent:
            @staticmethod
            def is_set() -> bool:
                return False

            @staticmethod
            def wait(seconds: float) -> bool:
                waits.append(seconds)
                clock[0] += seconds
                return False

        with patch(
            "tile_download_core.time.monotonic",
            side_effect=lambda: clock[0],
        ):
            limiter = AdaptiveRateLimiter(1, AdvancingEvent())
            self.assertTrue(limiter.acquire())
            limiter.defer(3)
            self.assertAlmostEqual(limiter.cooldown_remaining, 3)
            self.assertTrue(limiter.acquire())

        self.assertGreaterEqual(clock[0], 103)
        self.assertGreaterEqual(sum(waits), 3)
        self.assertTrue(all(0 < wait <= 1 for wait in waits))

    def test_clean_successes_recover_gradually_without_crossing_ceiling(
        self,
    ) -> None:
        limiter = AdaptiveRateLimiter(
            2,
            threading.Event(),
            initial_rate=0.5,
            recovery_successes=2,
        )
        self.assertEqual(limiter.target_rate, 2)
        self.assertEqual(limiter.rate, 0.5)
        self.assertEqual(limiter.record_success(), 0.5)
        self.assertEqual(limiter.record_success(), 0.625)

        observed = [limiter.rate]
        for _ in range(40):
            observed.append(limiter.record_success())
        self.assertTrue(all(rate <= limiter.target_rate for rate in observed))
        self.assertEqual(limiter.rate, limiter.target_rate)

        self.assertEqual(limiter.slow_down(0.5), 1)
        self.assertEqual(limiter.record_success(), 1)
        self.assertEqual(limiter.record_success(), 1.25)


class TileFetcherTransportTests(unittest.TestCase):
    class FakeResponse:
        def __init__(
            self,
            status_code: int,
            body: bytes = b"",
            *,
            headers: dict[str, str] | None = None,
            stop_after_first: threading.Event | None = None,
        ) -> None:
            self.status_code = status_code
            self.headers = headers or {}
            self.body = body
            self.stop_after_first = stop_after_first
            self.closed = False
            self.bytes_yielded = 0
            self.chunk_sizes: list[int] = []

        def iter_content(self, chunk_size: int):
            self.chunk_sizes.append(chunk_size)
            for offset in range(0, len(self.body), chunk_size):
                chunk = self.body[offset : offset + chunk_size]
                self.bytes_yielded += len(chunk)
                yield chunk
                if offset == 0 and self.stop_after_first is not None:
                    self.stop_after_first.set()

        def close(self) -> None:
            self.closed = True

    class FakeRequestSession:
        def __init__(self, responses) -> None:
            self.responses = iter(responses)
            self.requests: list[dict[str, object]] = []

        def request(self, method, url, **kwargs):
            self.requests.append(
                {"method": method, "url": url, **kwargs}
            )
            return next(self.responses)

    @staticmethod
    def fetcher(
        root: Path,
        limiter: AdaptiveRateLimiter,
        stop_event: threading.Event,
        *,
        timeout: float | tuple[float, float] = 1,
        retries: int = 1,
    ) -> TileFetcher:
        return TileFetcher(
            root,
            limiter=limiter,
            stop_event=stop_event,
            timeout=timeout,
            retries=retries,
            max_tile_bytes=10 * 1024 * 1024,
            logger=logging.getLogger("test_tile_fetcher_transport"),
        )

    @staticmethod
    def task(tile_x: int = 0) -> DownloadTask:
        return DownloadTask(
            row_id=tile_x + 1,
            spec=TileSpec("overworld", "base", 0, tile_x, 0),
            selected=True,
        )

    def test_per_thread_sessions_mount_bounded_adapters_and_close(self) -> None:
        class TrackingSession:
            def __init__(self) -> None:
                self.headers: dict[str, str] = {}
                self.adapters: dict[str, HTTPAdapter] = {}
                self.closed = False

            def mount(self, scheme: str, adapter: HTTPAdapter) -> None:
                self.adapters[scheme] = adapter

            def close(self) -> None:
                self.closed = True

        sessions: list[TrackingSession] = []

        def make_session() -> TrackingSession:
            session = TrackingSession()
            sessions.append(session)
            return session

        stop_event = threading.Event()
        fetcher = self.fetcher(
            Path("/tmp/unused-session-pool"),
            AdaptiveRateLimiter(1, stop_event),
            stop_event,
            timeout=(2, 3),
        )
        with patch("tile_download_core.requests.Session", side_effect=make_session):
            main_session = fetcher._session()
            self.assertIs(fetcher._session(), main_session)
            worker_sessions: list[TrackingSession] = []
            worker = threading.Thread(
                target=lambda: worker_sessions.append(fetcher._session())
            )
            worker.start()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())

        self.assertEqual(len(sessions), 2)
        self.assertIsNot(main_session, worker_sessions[0])
        for session in sessions:
            self.assertEqual(set(session.adapters), {"http://", "https://"})
            for adapter in session.adapters.values():
                self.assertIsInstance(adapter, HTTPAdapter)
                self.assertEqual(adapter._pool_connections, 1)
                self.assertEqual(adapter._pool_maxsize, 1)
                self.assertTrue(adapter._pool_block)

        fetcher.close()
        fetcher.close()
        self.assertTrue(all(session.closed for session in sessions))
        with self.assertRaises(requests.RequestException):
            fetcher._session()

    def test_retry_after_applies_global_cooldown_to_retryable_responses(
        self,
    ) -> None:
        for status in (403, 429, 502, 503):
            with (
                self.subTest(status=status),
                tempfile.TemporaryDirectory() as directory,
            ):
                stop_event = threading.Event()
                limiter = AdaptiveRateLimiter(2, stop_event)
                limiter.acquire = lambda: True  # type: ignore[method-assign]
                fetcher = self.fetcher(Path(directory), limiter, stop_event)
                response = self.FakeResponse(
                    status,
                    b"x" * 10_000,
                    headers={"Retry-After": "3"},
                )
                session = self.FakeRequestSession([response])
                with patch.object(fetcher, "_session", return_value=session):
                    result = fetcher.fetch(self.task())

                self.assertEqual(result.http_code, status)
                self.assertGreater(limiter.cooldown_remaining, 2.5)
                self.assertLessEqual(response.bytes_yielded, 160)
                self.assertTrue(response.closed)
                self.assertIn("x" * 160, result.error or "")
                self.assertEqual(
                    limiter.rate,
                    1 if status in (403, 429) else 2,
                )

    def test_impractical_retry_after_stops_for_later_resume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            stop_event = threading.Event()
            limiter = AdaptiveRateLimiter(2, stop_event)
            limiter.acquire = lambda: True  # type: ignore[method-assign]
            fetcher = self.fetcher(Path(directory), limiter, stop_event)
            response = self.FakeResponse(
                429,
                b"slow down",
                headers={"Retry-After": "1000000000000"},
            )
            session = self.FakeRequestSession([response])
            with patch.object(fetcher, "_session", return_value=session):
                result = fetcher.fetch(self.task())

        self.assertTrue(stop_event.is_set())
        self.assertEqual(result.status, "protection")
        self.assertIn("reanudarse más tarde", result.error or "")
        self.assertEqual(limiter.cooldown_remaining, 0)

    def test_repeated_5xx_and_timeouts_apply_moderate_aimd_slowdown(
        self,
    ) -> None:
        class TimeoutSession:
            @staticmethod
            def request(*_args, **_kwargs):
                raise requests.Timeout("timed out")

        for failure in ("503", "timeout"):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as directory,
            ):
                stop_event = threading.Event()
                limiter = AdaptiveRateLimiter(2, stop_event)
                limiter.acquire = lambda: True  # type: ignore[method-assign]
                fetcher = self.fetcher(
                    Path(directory),
                    limiter,
                    stop_event,
                    retries=4,
                )
                session = (
                    self.FakeRequestSession(
                        [self.FakeResponse(503) for _ in range(4)]
                    )
                    if failure == "503"
                    else TimeoutSession()
                )
                with (
                    patch.object(fetcher, "_session", return_value=session),
                    patch.object(fetcher, "_wait", return_value=False),
                ):
                    result = fetcher.fetch(self.task())

                self.assertEqual(result.attempts, 4)
                self.assertAlmostEqual(limiter.rate, 1.6)
                self.assertFalse(stop_event.is_set())

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_http_success_and_404_feed_gradual_recovery(self) -> None:
        image_bytes = io.BytesIO()
        with Image.new("RGB", (512, 512), (9, 8, 7)) as image:
            image.save(image_bytes, "WEBP", lossless=True)

        with tempfile.TemporaryDirectory() as directory:
            stop_event = threading.Event()
            limiter = AdaptiveRateLimiter(
                1,
                stop_event,
                initial_rate=0.5,
                recovery_successes=1,
            )
            limiter.acquire = lambda: True  # type: ignore[method-assign]
            fetcher = self.fetcher(Path(directory), limiter, stop_event)
            responses = [
                self.FakeResponse(404),
                self.FakeResponse(200, image_bytes.getvalue()),
            ]
            session = self.FakeRequestSession(responses)
            with patch.object(fetcher, "_session", return_value=session):
                absent = fetcher.fetch(self.task(0))
                rate_after_absent = limiter.rate
                complete = fetcher.fetch(self.task(1))

        self.assertEqual(absent.status, "absent")
        self.assertEqual(complete.status, "complete")
        self.assertEqual(rate_after_absent, 0.625)
        self.assertEqual(limiter.rate, 0.78125)

    def test_manual_stop_interrupts_stream_and_removes_partial_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stop_event = threading.Event()
            limiter = AdaptiveRateLimiter(1, stop_event)
            fetcher = self.fetcher(root, limiter, stop_event)
            response = self.FakeResponse(
                200,
                b"a" * (256 * 1024),
                stop_after_first=stop_event,
            )
            task = self.task()

            result = fetcher._stream_response(task, response)
            destination = task.spec.path(root)

            self.assertEqual(result.status, "failed")
            self.assertIn("InterruptedError", result.error or "")
            self.assertFalse(destination.exists())
            self.assertEqual(
                list(destination.parent.glob(f".{destination.name}.*.part")),
                [],
            )
            self.assertTrue(response.closed)


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
                self.assertEqual(
                    (status["status"], status["http_code"]),
                    ("absent", 404),
                )
            finally:
                database.close()

    def test_record_result_commits_by_default_and_can_defer_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "tiles.sqlite3"
            database = TileDatabase(database_path)
            observer = sqlite3.connect(database_path)
            try:
                deferred_task = database.prepare_download_task(
                    TileSpec("overworld", "base", 0, 0, 0),
                    root,
                    selected=True,
                )
                default_task = database.prepare_download_task(
                    TileSpec("overworld", "base", 0, 1, 0),
                    root,
                    selected=True,
                )
                database.connection.commit()

                database.record_result(
                    DownloadResult(
                        task=deferred_task,
                        status="absent",
                        exists=False,
                        http_code=404,
                        attempts=1,
                    ),
                    root,
                    min_lod=0,
                    selected_lods={0},
                    commit=False,
                )
                observer.rollback()
                self.assertEqual(
                    observer.execute(
                        "SELECT status FROM tiles WHERE id=?",
                        (deferred_task.row_id,),
                    ).fetchone()[0],
                    "pending",
                )

                database.connection.commit()
                observer.rollback()
                self.assertEqual(
                    observer.execute(
                        "SELECT status FROM tiles WHERE id=?",
                        (deferred_task.row_id,),
                    ).fetchone()[0],
                    "absent",
                )

                database.record_result(
                    DownloadResult(
                        task=default_task,
                        status="absent",
                        exists=False,
                        http_code=404,
                        attempts=1,
                    ),
                    root,
                    min_lod=0,
                    selected_lods={0},
                )
                observer.rollback()
                self.assertEqual(
                    observer.execute(
                        "SELECT status FROM tiles WHERE id=?",
                        (default_task.row_id,),
                    ).fetchone()[0],
                    "absent",
                )
            finally:
                observer.close()
                database.close()

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_catalog_hash_reuses_verified_tile_without_decoding_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            stop_event = threading.Event()
            try:
                spec = TileSpec("overworld", "base", 0, 4, 5)
                path = spec.path(root)
                path.parent.mkdir(parents=True)
                with Image.new("RGB", (512, 512), (17, 34, 51)) as image:
                    image.save(path, "WEBP", lossless=True)
                payload = path.read_bytes()
                first_task = database.prepare_download_task(
                    spec,
                    root,
                    selected=True,
                )
                database.record_result(
                    DownloadResult(
                        task=first_task,
                        status="complete",
                        exists=True,
                        http_code=200,
                        attempts=1,
                        size_bytes=len(payload),
                        sha256=hashlib.sha256(payload).hexdigest(),
                    ),
                    root,
                    min_lod=0,
                    selected_lods={0},
                )
                resumed_task = database.prepare_download_task(
                    spec,
                    root,
                    selected=True,
                )
                fetcher = TileFetcher(
                    root,
                    limiter=AdaptiveRateLimiter(1, stop_event),
                    stop_event=stop_event,
                    timeout=1,
                    retries=1,
                    max_tile_bytes=10 * 1024 * 1024,
                    logger=logging.getLogger("test_catalog_hash_resume"),
                )
                with patch(
                    "tile_download_core.Image.open",
                    side_effect=AssertionError("Pillow should not run"),
                ):
                    result = fetcher.fetch(resumed_task)
                fetcher.close()
            finally:
                database.close()

        self.assertEqual(result.status, "complete")
        self.assertEqual(result.attempts, 0)
        self.assertEqual(result.sha256, hashlib.sha256(payload).hexdigest())

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_catalog_hash_detects_same_size_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = TileDatabase(root / "tiles.sqlite3")
            try:
                spec = TileSpec("overworld", "base", 0, 7, 8)
                path = spec.path(root)
                path.parent.mkdir(parents=True)
                with Image.new("RGB", (512, 512), (70, 80, 90)) as image:
                    image.save(path, "WEBP", lossless=True)
                payload = path.read_bytes()
                task = database.prepare_download_task(
                    spec,
                    root,
                    selected=True,
                )
                database.record_result(
                    DownloadResult(
                        task=task,
                        status="complete",
                        exists=True,
                        http_code=200,
                        attempts=1,
                        size_bytes=len(payload),
                        sha256=hashlib.sha256(payload).hexdigest(),
                    ),
                    root,
                    min_lod=0,
                    selected_lods={0},
                )
                resumed_task = database.prepare_download_task(
                    spec,
                    root,
                    selected=True,
                )
                changed = bytearray(payload)
                changed[-1] ^= 1
                path.write_bytes(changed)
                validation = TileFetcher._validate_existing(
                    resumed_task,
                    path,
                )
            finally:
                database.close()

        self.assertFalse(validation.valid)
        self.assertIn("SHA-256", validation.error or "")

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

    def test_progress_reports_live_speed_rate_and_eta_metrics(self) -> None:
        class Limiter:
            rate = 6.5
            target_rate = 16.0
            cooldown_remaining = 0.0

        class Fetcher:
            limiter = Limiter()

            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200,
                    attempts=1,
                    size_bytes=4_096,
                    downloaded_bytes=4_096,
                )

        class NoopDatabase:
            @staticmethod
            def record_result(*_args, **_kwargs):
                return None

        output = io.StringIO()
        summary = download_region_tasks(
            (
                DownloadTask(
                    row_id=index + 1,
                    spec=TileSpec("overworld", "base", 0, index, 0),
                    selected=True,
                )
                for index in range(3)
            ),
            fetcher=Fetcher(),
            database=NoopDatabase(),
            output_root=Path("/tmp/unused-region-speed-progress"),
            lod=0,
            workers=2,
            stop_event=threading.Event(),
            logger=logging.getLogger("test_speed_progress"),
            total_tasks=3,
            total_network_tasks=3,
            progress=JsonlProgressReporter(output, minimum_interval=0),
        )

        terminal = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(terminal["event"], "summary")
        self.assertEqual(terminal["requestAttempts"], 3)
        self.assertEqual(terminal["downloadedBytes"], 12_288)
        self.assertEqual(terminal["effectiveRps"], 6.5)
        self.assertEqual(terminal["targetRps"], 16.0)
        self.assertEqual(terminal["cooldownSeconds"], 0.0)
        self.assertEqual(terminal["networkRequested"], 3)
        self.assertEqual(terminal["networkProcessed"], 3)
        self.assertGreater(terminal["tilesPerSecond"], 0)
        self.assertEqual(
            terminal["tilesPerSecond"],
            terminal["resolvedPerSecond"],
        )
        self.assertGreater(terminal["resolvedPerSecond"], 0)
        self.assertGreater(terminal["achievedRps"], 0)
        self.assertGreater(terminal["bytesPerSecond"], 0)
        self.assertIsNone(terminal["etaSeconds"])
        self.assertEqual(summary.request_attempts, 3)
        self.assertEqual(summary.target_rps, 16.0)
        self.assertEqual(summary.network_processed, 3)

    def test_network_eta_and_rates_exclude_cached_resolutions(self) -> None:
        class Fetcher:
            @staticmethod
            def fetch(task):
                attempts = 0 if task.spec.tile_x == 0 else task.spec.tile_x
                return DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200 if attempts else None,
                    attempts=attempts,
                    size_bytes=100,
                    downloaded_bytes=100 if attempts else 0,
                )

        class NoopDatabase:
            @staticmethod
            def record_result(*_args, **_kwargs):
                return None

        output = io.StringIO()
        summary = download_region_tasks(
            (
                DownloadTask(
                    row_id=index + 1,
                    spec=TileSpec("overworld", "base", 0, index, 0),
                    selected=True,
                )
                for index in range(3)
            ),
            fetcher=Fetcher(),
            database=NoopDatabase(),
            output_root=Path("/tmp/unused-region-network-metrics"),
            lod=0,
            workers=1,
            stop_event=threading.Event(),
            logger=logging.getLogger("test_network_metrics"),
            total_tasks=3,
            total_network_tasks=2,
            progress=JsonlProgressReporter(output, minimum_interval=0),
        )

        messages = [
            json.loads(line)
            for line in output.getvalue().splitlines()
        ]
        midflight = next(
            message
            for message in messages
            if message["networkProcessed"] == 1
        )
        terminal = messages[-1]
        self.assertIsNotNone(midflight["etaSeconds"])
        self.assertGreater(
            midflight["resolvedPerSecond"],
            midflight["networkTilesPerSecond"],
        )
        self.assertEqual(terminal["networkRequested"], 2)
        self.assertEqual(terminal["networkProcessed"], 2)
        self.assertEqual(
            terminal["tilesPerSecond"],
            terminal["resolvedPerSecond"],
        )
        self.assertGreater(
            terminal["tilesPerSecond"],
            terminal["networkTilesPerSecond"],
        )
        self.assertGreater(
            terminal["achievedRps"],
            terminal["networkTilesPerSecond"],
        )
        self.assertIsNone(terminal["etaSeconds"])
        self.assertEqual(summary.request_attempts, 3)
        self.assertEqual(summary.network_processed, 2)

    def test_database_results_are_committed_in_bounded_batches(self) -> None:
        state = SimpleNamespace(record_flags=[], commits=0)

        class Connection:
            @staticmethod
            def commit():
                state.commits += 1

        class RecordingDatabase:
            connection = Connection()

            @staticmethod
            def record_result(*_args, **kwargs):
                state.record_flags.append(kwargs.get("commit"))

        class Fetcher:
            @staticmethod
            def fetch(task):
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                )

        task_count = 70
        summary = download_region_tasks(
            (
                DownloadTask(
                    row_id=index + 1,
                    spec=TileSpec("overworld", "base", 0, index, 0),
                    selected=True,
                )
                for index in range(task_count)
            ),
            fetcher=Fetcher(),
            database=RecordingDatabase(),
            output_root=Path("/tmp/unused-region-batched-db"),
            lod=0,
            workers=4,
            stop_event=threading.Event(),
            logger=logging.getLogger("test_batched_db"),
            total_tasks=task_count,
            database_commit_interval=16,
            database_commit_seconds=60,
        )

        self.assertEqual(summary.absent, task_count)
        self.assertEqual(state.record_flags, [False] * task_count)
        self.assertEqual(state.commits, math.ceil(task_count / 16))

    def test_database_commit_deadline_fires_while_requests_are_pending(
        self,
    ) -> None:
        first_recorded = threading.Event()
        slow_started = threading.Event()
        release_slow = threading.Event()
        committed = threading.Event()
        state = SimpleNamespace(records=0)

        class Connection:
            @staticmethod
            def commit():
                committed.set()

        class RecordingDatabase:
            connection = Connection()

            @staticmethod
            def record_result(*_args, **_kwargs):
                state.records += 1
                if state.records == 1:
                    first_recorded.set()

        class Fetcher:
            @staticmethod
            def fetch(task):
                if task.spec.tile_x == 1:
                    slow_started.set()
                    release_slow.wait(2)
                return DownloadResult(
                    task=task,
                    status="absent",
                    exists=False,
                    http_code=404,
                    attempts=1,
                )

        tasks = [
            DownloadTask(
                row_id=index + 1,
                spec=TileSpec("overworld", "base", 0, index, 0),
                selected=True,
            )
            for index in range(2)
        ]
        result: list[object] = []
        runner = threading.Thread(
            target=lambda: result.append(
                download_region_tasks(
                    tasks,
                    fetcher=Fetcher(),
                    database=RecordingDatabase(),
                    output_root=Path("/tmp/unused-region-commit-deadline"),
                    lod=0,
                    workers=2,
                    stop_event=threading.Event(),
                    logger=logging.getLogger("test_commit_deadline"),
                    total_tasks=2,
                    database_commit_interval=100,
                    database_commit_seconds=0.05,
                )
            )
        )
        runner.start()
        try:
            self.assertTrue(first_recorded.wait(1))
            self.assertTrue(slow_started.wait(1))
            self.assertTrue(committed.wait(0.5))
            self.assertTrue(runner.is_alive())
        finally:
            release_slow.set()
            runner.join(timeout=2)

        self.assertFalse(runner.is_alive())
        self.assertEqual(len(result), 1)

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
    def test_preflight_trusts_unchanged_catalogued_hash_without_decode(
        self,
    ) -> None:
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
            spec = inventory[0]
            path = spec.path(root)
            path.parent.mkdir(parents=True)
            with Image.new("RGB", (512, 512), (3, 4, 5)) as image:
                image.save(path, "WEBP", lossless=True)
            payload = path.read_bytes()
            task = database.prepare_download_task(
                spec,
                root,
                selected=True,
            )
            database.record_result(
                DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200,
                    attempts=1,
                    size_bytes=len(payload),
                    sha256=hashlib.sha256(payload).hexdigest(),
                ),
                root,
                min_lod=0,
                selected_lods={0},
            )
            try:
                with patch(
                    "download_region_2b2t.validate_webp",
                    side_effect=AssertionError("preflight decode is redundant"),
                ):
                    estimate = estimate_region_storage(
                        inventory,
                        database=database,
                        output_root=root,
                        max_tile_bytes=10 * 1024 * 1024,
                    )
                resumed_task = database.prepare_download_task(
                    spec,
                    root,
                    selected=True,
                )
                self.assertIsNotNone(resumed_task.catalog_file_identity)
                with patch(
                    "tile_download_core.sha256_file",
                    side_effect=AssertionError(
                        "preflight hash must be reused when identity is stable"
                    ),
                ):
                    validation = TileFetcher._validate_existing(
                        resumed_task,
                        path,
                    )
                changed = bytearray(payload)
                changed[-1] ^= 1
                path.write_bytes(changed)
                changed_validation = TileFetcher._validate_existing(
                    resumed_task,
                    path,
                )
            finally:
                database.close()

        self.assertEqual(estimate.existing_complete, 1)
        self.assertEqual(estimate.missing, 0)
        self.assertEqual(estimate.required_bytes, 0)
        self.assertTrue(validation.valid)
        self.assertFalse(changed_validation.valid)
        self.assertIn("SHA-256", changed_validation.error or "")

    @unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
    def test_preflight_rejects_same_size_catalog_hash_mismatch(self) -> None:
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
            spec = inventory[0]
            path = spec.path(root)
            path.parent.mkdir(parents=True)
            with Image.new("RGB", (512, 512), (20, 40, 60)) as image:
                image.save(path, "WEBP", lossless=True)
            payload = path.read_bytes()
            task = database.prepare_download_task(
                spec,
                root,
                selected=True,
            )
            database.record_result(
                DownloadResult(
                    task=task,
                    status="complete",
                    exists=True,
                    http_code=200,
                    attempts=1,
                    size_bytes=len(payload),
                    sha256=hashlib.sha256(payload).hexdigest(),
                ),
                root,
                min_lod=0,
                selected_lods={0},
            )
            changed = bytearray(payload)
            changed[-1] ^= 1
            path.write_bytes(changed)
            try:
                with patch(
                    "download_region_2b2t.validate_webp",
                    side_effect=AssertionError(
                        "a catalog hash mismatch must require redownload"
                    ),
                ):
                    estimate = estimate_region_storage(
                        inventory,
                        database=database,
                        output_root=root,
                        max_tile_bytes=10 * 1024 * 1024,
                    )
            finally:
                database.close()

        self.assertEqual(len(changed), len(payload))
        self.assertEqual(estimate.existing_complete, 0)
        self.assertEqual(estimate.missing, 1)
        self.assertGreater(estimate.required_bytes, 0)

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
