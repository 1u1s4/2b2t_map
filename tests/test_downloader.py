from __future__ import annotations

import io
import json
import logging
import shlex
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

from PIL import Image

import download_all_2b2t as downloader


class SchemaTests(unittest.TestCase):
    def test_js_shard_boundaries(self) -> None:
        expected = {
            -65: -2,
            -64: -2,
            -63: -1,
            -33: -1,
            -32: -1,
            -31: 0,
            -1: 0,
            0: 0,
            31: 0,
            32: 1,
            33: 1,
        }
        for coordinate, shard in expected.items():
            with self.subTest(coordinate=coordinate):
                self.assertEqual(
                    downloader.js_trunc_div(coordinate, 32), shard
                )

    def test_tile_url_and_path(self) -> None:
        spec = downloader.TileSpec("overworld", "base", 3, -31, 33)
        self.assertEqual(
            spec.url,
            "https://2b2t.place/tiles/base/3/0/0/1/t.-31.33.webp",
        )
        self.assertEqual(
            spec.path(Path("/tiles")),
            Path("/tiles/base/3/overworld/0/1/t.-31.33.webp"),
        )

    def test_children_follow_quadtree(self) -> None:
        spec = downloader.TileSpec("end", "newchunks", 4, -2, 3)
        identities = {
            (child.lod, child.tile_x, child.tile_z)
            for child in spec.children()
        }
        self.assertEqual(
            identities,
            {(3, -4, 6), (3, -3, 6), (3, -4, 7), (3, -3, 7)},
        )

    def test_published_candidate_counts_include_irregular_overworld(self) -> None:
        self.assertEqual(
            downloader.candidate_count("overworld", 0), 4_253_696
        )
        self.assertEqual(downloader.candidate_count("overworld", 3), 66_752)
        self.assertEqual(downloader.candidate_count("overworld", 10), 16)
        self.assertEqual(
            sum(
                downloader.candidate_count("overworld", lod)
                for lod in range(11)
            ),
            5_673_192,
        )
        self.assertEqual(
            downloader.tile_axis_bounds("overworld", 3), (-132, 131)
        )
        self.assertEqual(downloader.candidate_count("end", 0), 250_000)
        self.assertEqual(downloader.candidate_count("nether", 0), 38_416)


class CliTests(unittest.TestCase):
    def test_required_example_parses(self) -> None:
        args = downloader.parse_args(
            [
                "--all",
                "--dimensions",
                "overworld,nether,end",
                "--layers",
                "base,overlay,newchunks",
                "--lods",
                "all",
                "--out",
                "./2b2t_tiles",
                "--workers",
                "4",
                "--requests-per-second",
                "2",
                "--resume",
            ]
        )
        self.assertEqual(args.dimensions, ["overworld", "nether", "end"])
        self.assertEqual(args.layers, ["base", "overlay", "newchunks"])
        self.assertEqual(args.lods, set(range(11)))

    def test_rejects_nonfinite_rate(self) -> None:
        with self.assertRaises(SystemExit):
            downloader.parse_args(
                ["--all", "--requests-per-second", "nan"]
            )

    def test_default_scope_is_overworld_and_resume_command_reparses(self) -> None:
        args = downloader.parse_args(
            [
                "--all",
                "--discovery-samples",
                "7",
                "--max-tile-bytes",
                "123456",
                "--space-headroom-percent",
                "20",
                "--skip-smoke-test",
            ]
        )
        self.assertEqual(args.dimensions, ["overworld"])
        tokens = shlex.split(downloader.build_resume_command(args))
        reparsed = downloader.parse_args(tokens[2:])
        self.assertEqual(reparsed.dimensions, ["overworld"])
        self.assertEqual(reparsed.discovery_samples, 7)
        self.assertEqual(reparsed.max_tile_bytes, 123456)
        self.assertEqual(reparsed.space_headroom_percent, 20)
        self.assertTrue(reparsed.resume)
        self.assertTrue(reparsed.skip_smoke_test)

    def test_rejects_space_headroom_outside_percentage_range(self) -> None:
        with self.assertRaises(SystemExit):
            downloader.parse_args(
                ["--all", "--space-headroom-percent", "100.1"]
            )

    def test_below_required_headroom_needs_exact_migration_scope(self) -> None:
        with self.assertRaises(SystemExit):
            downloader.parse_args(
                ["--all", "--space-headroom-percent", "18"]
            )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(SystemExit):
                downloader.parse_args(
                    [
                        "--all",
                        "--dimensions",
                        "overworld,nether,end",
                        "--layers",
                        "base,overlay,newchunks",
                        "--lods",
                        "all",
                        "--out",
                        directory,
                        "--space-headroom-percent",
                        "18",
                        "--resume",
                        "--no-fallback",
                    ]
                )

    def test_historical_full_resume_is_still_exactly_replayable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            rows = [
                {
                    "dimension": dimension,
                    "layer": layer,
                    "lod": lod,
                }
                for dimension in downloader.DIMENSIONS
                for layer in downloader.LAYERS
                for lod in range(downloader.MAX_LOD + 1)
            ]
            (output / "estimate.json").write_text(
                json.dumps(
                    {
                        "requested": {
                            "dimensions": list(downloader.DIMENSIONS),
                            "layers": list(downloader.LAYERS),
                            "lods": list(range(downloader.MAX_LOD + 1)),
                        },
                        "plan": {
                            "fallback": False,
                            "fits": True,
                            "space_headroom_percent": 18,
                            "rows": rows,
                        },
                    }
                ),
                encoding="utf-8",
            )
            args = downloader.parse_args(
                [
                    "--all",
                    "--dimensions",
                    "overworld,nether,end",
                    "--layers",
                    "base,overlay,newchunks",
                    "--lods",
                    "all",
                    "--out",
                    str(output),
                    "--space-headroom-percent",
                    "18",
                    "--resume",
                    "--no-fallback",
                ]
            )
            reparsed = downloader.parse_args(
                shlex.split(downloader.build_resume_command(args))[2:]
            )
            self.assertEqual(reparsed.space_headroom_percent, 18)
            self.assertTrue(reparsed.resume)


class DownloadLockTests(unittest.TestCase):
    def test_global_downloader_refuses_a_regionally_locked_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with downloader.RegionDownloadLock(root):
                with mock.patch.object(downloader, "TileDatabase") as database:
                    result = downloader.main(
                        ["--estimate-only", "--out", str(root)]
                    )

            self.assertEqual(result, 2)
            database.assert_not_called()


class CachedEstimateTests(unittest.TestCase):
    @staticmethod
    def seed_cached_catalog(
        root: Path,
        *,
        dimensions: list[str] | None = None,
        layers: list[str] | None = None,
        lods: set[int] | None = None,
        absent_only: set[tuple[str, str, int]] | None = None,
    ) -> int:
        buffer = io.BytesIO()
        Image.new("RGBA", (512, 512), (12, 34, 56, 255)).save(
            buffer,
            "WEBP",
            lossless=True,
        )
        payload = buffer.getvalue()
        selected_dimensions = dimensions or ["overworld"]
        selected_layers = layers or list(downloader.LAYERS)
        selected_lods = (
            lods
            if lods is not None
            else set(range(downloader.MIN_LOD, downloader.MAX_LOD + 1))
        )
        absent_only_groups = absent_only or set()
        database = downloader.TileDatabase(root / "tiles.sqlite3")
        try:
            for dimension in selected_dimensions:
                for layer in selected_layers:
                    for lod in sorted(selected_lods, reverse=True):
                        group_key = (dimension, layer, lod)
                        if group_key not in absent_only_groups:
                            positive = downloader.TileSpec(
                                dimension,
                                layer,
                                lod,
                                0,
                                0,
                            )
                            positive_path = positive.path(root)
                            positive_path.parent.mkdir(
                                parents=True,
                                exist_ok=True,
                            )
                            positive_path.write_bytes(payload)
                            row_id = database.add_tile(
                                positive,
                                root,
                                selected=True,
                            )
                            database.connection.execute(
                                """
                                UPDATE tiles
                                SET status='complete', http_code=202, attempts=1,
                                    size_bytes=?, sha256=?, downloaded_at=?,
                                    updated_at=?
                                WHERE id=?
                                """,
                                (
                                    len(payload),
                                    "0" * 64,
                                    downloader.utc_now(),
                                    downloader.utc_now(),
                                    row_id,
                                ),
                            )
                            database.connection.commit()
                            database.save_sample(
                                positive,
                                http_code=202,
                                exists=True,
                                size_bytes=len(payload),
                                error=None,
                            )
                        database.save_sample(
                            downloader.TileSpec(
                                dimension,
                                layer,
                                lod,
                                1,
                                1,
                            ),
                            http_code=404,
                            exists=False,
                            size_bytes=0,
                            error="not published",
                        )
            database.set_metadata(
                "smoke_test",
                {
                    "passed": True,
                    "at": downloader.utc_now(),
                    "tiles": 9,
                },
            )
        finally:
            database.close()
        return len(payload)

    def test_readonly_connection_rejects_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.seed_cached_catalog(root)
            connection = downloader.open_cached_estimate_database(
                root / "tiles.sqlite3"
            )
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute(
                        "UPDATE metadata SET value='mutated'"
                    )
            finally:
                connection.close()

    def test_cached_estimate_is_isolated_complete_and_exact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tile_bytes = self.seed_cached_catalog(root)
            planning_floor_point = 30_000_000_000
            planning_floor_conservative = 40_000_000_000
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                database.set_metadata(
                    "last_full_estimate",
                    {
                        "rows": [
                            {
                                "dimension": "overworld",
                                "layer": "base",
                                "lod": 0,
                                "candidate_tiles": (
                                    downloader.candidate_count(
                                        "overworld",
                                        0,
                                    )
                                ),
                                "estimated_allocated_bytes": (
                                    planning_floor_point
                                ),
                                "conservative_bytes": (
                                    planning_floor_conservative
                                ),
                            }
                        ]
                    },
                )
            finally:
                database.close()
            sentinels = {
                "progress.json": b'{"status":"running"}\n',
                "estimate.json": b'{"live":true}\n',
                "download.log": b"active log\n",
            }
            for name, payload in sentinels.items():
                (root / name).write_bytes(payload)
            database_path = root / "tiles.sqlite3"
            database_before = database_path.read_bytes()

            fake_disk_usage = mock.Mock(
                total=10_000,
                used=9_000,
                free=1_000,
            )
            with (
                mock.patch.object(
                    downloader,
                    "configure_logging",
                    side_effect=AssertionError("logger must stay unopened"),
                ),
                mock.patch.object(
                    downloader.RegionDownloadLock,
                    "acquire",
                    side_effect=AssertionError("lock must stay untouched"),
                ),
                mock.patch.object(
                    downloader,
                    "verify_live_schema",
                    side_effect=AssertionError("network must stay unused"),
                ),
                mock.patch.object(
                    downloader.requests,
                    "Session",
                    side_effect=AssertionError("network must stay unused"),
                ),
                mock.patch.object(
                    downloader.shutil,
                    "disk_usage",
                    return_value=fake_disk_usage,
                ),
            ):
                result = downloader.main(
                    [
                        "--cached-estimate-only",
                        "--out",
                        str(root),
                        "--workers",
                        "8",
                        "--requests-per-second",
                        "8",
                    ]
                )

            self.assertEqual(result, 0)
            self.assertEqual(database_path.read_bytes(), database_before)
            for name, payload in sentinels.items():
                self.assertEqual((root / name).read_bytes(), payload)

            report_path = (
                root
                / downloader.CACHED_ESTIMATE_REPORT_RELATIVE_PATH
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["mode"], "cached_estimate_only")
            self.assertEqual(report["source"]["sqlite_uri_mode"], "ro")
            self.assertTrue(report["source"]["sqlite_query_only"])
            self.assertEqual(report["source"]["network_requests"], 0)
            self.assertEqual(
                report["source"]["planning_floor_groups_used"],
                1,
            )
            self.assertEqual(report["margins"], {
                "nominal_total_margin_percent": 50.0,
                "sampling_uncertainty_percent": 25.0,
                "space_headroom_percent": 20.0,
            })

            rows = report["rows"]
            self.assertEqual(len(rows), 33)
            self.assertEqual(
                {
                    (row["dimension"], row["layer"], row["lod"])
                    for row in rows
                },
                {
                    ("overworld", layer, lod)
                    for layer in downloader.LAYERS
                    for lod in range(downloader.MAX_LOD + 1)
                },
            )
            for row in rows:
                self.assertEqual(
                    row["candidate_tiles"],
                    downloader.candidate_count("overworld", row["lod"]),
                )
                self.assertEqual(row["cached_samples"], 2)
                self.assertEqual(row["stable_samples"], 2)
                self.assertEqual(row["valid_positive_samples"], 1)
                self.assertEqual(row["confirmed_absent_samples"], 1)
                self.assertEqual(row["inconclusive_samples"], 0)
                self.assertEqual(row["invalid_local_samples"], 0)
                self.assertEqual(row["size_mismatch_samples"], 0)
                self.assertEqual(row["sample_density"], 0.5)
                self.assertEqual(
                    row["estimated_density"],
                    0.98 if row["layer"] == "base" else 0.5,
                )
                self.assertEqual(row["existing_complete_tiles"], 1)
                self.assertEqual(row["existing_complete_bytes"], tile_bytes)
            floored_row = next(
                row
                for row in rows
                if row["layer"] == "base" and row["lod"] == 0
            )
            self.assertTrue(floored_row["planning_floor_applied"])
            self.assertEqual(
                floored_row["estimated_point_bytes"],
                planning_floor_point,
            )
            self.assertEqual(
                floored_row["estimated_conservative_bytes"],
                planning_floor_conservative,
            )

            candidates_per_layer = sum(
                downloader.candidate_count("overworld", lod)
                for lod in range(downloader.MAX_LOD + 1)
            )
            self.assertEqual(
                report["footprint"]["candidate_requests_per_layer"],
                candidates_per_layer,
            )
            self.assertEqual(
                report["total"]["candidate_tiles"],
                candidates_per_layer * len(downloader.LAYERS),
            )
            self.assertEqual(
                report["total"]["existing_complete_tiles"],
                33,
            )
            self.assertEqual(
                report["total"]["existing_complete_bytes"],
                tile_bytes * 33,
            )
            self.assertEqual(
                set(report["totals_by_layer"]),
                set(downloader.LAYERS),
            )
            self.assertEqual(report["total"]["free_bytes"], 1_000)
            self.assertEqual(
                report["total"]["space_shortfall_bytes"],
                max(
                    0,
                    report["total"][
                        "required_with_space_headroom_bytes"
                    ]
                    - 1_000,
                ),
            )

            commands = report["continuation_commands"]
            self.assertEqual(
                [command["id"] for command in commands],
                [
                    "base_lod0_after_capacity",
                    "overlay_all_lods_after_base",
                    "newchunks_all_lods_after_overlay",
                ],
            )
            expected_scopes = (
                (["base"], {0}),
                (["overlay"], set(range(11))),
                (["newchunks"], set(range(11))),
            )
            for command, (layers, lods) in zip(
                commands,
                expected_scopes,
                strict=True,
            ):
                tokens = shlex.split(command["command"])
                reparsed = downloader.parse_args(tokens[2:])
                self.assertTrue(reparsed.all)
                self.assertTrue(reparsed.resume)
                self.assertTrue(reparsed.skip_smoke_test)
                self.assertTrue(reparsed.no_fallback)
                self.assertEqual(reparsed.dimensions, ["overworld"])
                self.assertEqual(reparsed.layers, layers)
                self.assertEqual(reparsed.lods, lods)
                self.assertEqual(reparsed.workers, 8)
                self.assertEqual(reparsed.requests_per_second, 8)

    def test_scoped_cached_estimate_is_canonical_offline_and_exact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requested_lods = {2, 10}
            absent_only = {
                ("nether", "overlay", lod) for lod in requested_lods
            }
            self.seed_cached_catalog(
                root,
                dimensions=["nether", "end"],
                layers=["base", "overlay"],
                lods=requested_lods,
                absent_only=absent_only,
            )
            sentinels = {
                "progress.json": b'{"status":"running"}\n',
                "estimate.json": b'{"live":true}\n',
                "download.log": b"active log\n",
            }
            for name, payload in sentinels.items():
                (root / name).write_bytes(payload)
            database_path = root / "tiles.sqlite3"
            database_before = database_path.read_bytes()

            expected_relative_path = Path(
                "reports/"
                "cached-estimate-nether-end__base-overlay__lod-2-10.json"
            )
            self.assertEqual(
                downloader.cached_estimate_report_relative_path(
                    ["end", "nether"],
                    ["overlay", "base"],
                    {10, 2},
                ),
                expected_relative_path,
            )
            self.assertEqual(
                downloader.cached_estimate_report_relative_path(
                    ["overworld"],
                    list(reversed(downloader.LAYERS)),
                    set(range(downloader.MAX_LOD + 1)),
                ),
                downloader.CACHED_ESTIMATE_REPORT_RELATIVE_PATH,
            )

            fake_disk_usage = mock.Mock(
                total=2_000_000,
                used=1_000_000,
                free=1_000_000,
            )
            with (
                mock.patch.object(
                    downloader,
                    "configure_logging",
                    side_effect=AssertionError("logger must stay unopened"),
                ),
                mock.patch.object(
                    downloader.RegionDownloadLock,
                    "acquire",
                    side_effect=AssertionError("lock must stay untouched"),
                ),
                mock.patch.object(
                    downloader,
                    "verify_live_schema",
                    side_effect=AssertionError("network must stay unused"),
                ),
                mock.patch.object(
                    downloader.requests,
                    "Session",
                    side_effect=AssertionError("network must stay unused"),
                ),
                mock.patch.object(
                    downloader.shutil,
                    "disk_usage",
                    return_value=fake_disk_usage,
                ),
            ):
                result = downloader.main(
                    [
                        "--cached-estimate-only",
                        "--dimensions",
                        "end,nether",
                        "--layers",
                        "overlay,base",
                        "--lods",
                        "10,2",
                        "--out",
                        str(root),
                        "--workers",
                        "3",
                        "--requests-per-second",
                        "4",
                    ]
                )

            self.assertEqual(result, 0)
            self.assertEqual(database_path.read_bytes(), database_before)
            for name, payload in sentinels.items():
                self.assertEqual((root / name).read_bytes(), payload)
            self.assertFalse(
                (
                    root
                    / downloader.CACHED_ESTIMATE_REPORT_RELATIVE_PATH
                ).exists()
            )

            report_path = root / expected_relative_path
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(
                report["requested"],
                {
                    "dimensions": ["nether", "end"],
                    "layers": ["base", "overlay"],
                    "lods": [2, 10],
                },
            )
            self.assertEqual(report["output"], str(report_path.resolve()))
            self.assertEqual(len(report["rows"]), 8)
            self.assertEqual(
                {
                    (
                        row["dimension"],
                        row["layer"],
                        row["lod"],
                    )
                    for row in report["rows"]
                },
                {
                    (dimension, layer, lod)
                    for dimension in ("nether", "end")
                    for layer in ("base", "overlay")
                    for lod in requested_lods
                },
            )
            for row in report["rows"]:
                if (
                    row["dimension"] == "nether"
                    and row["layer"] == "overlay"
                ):
                    self.assertEqual(row["cached_samples"], 1)
                    self.assertEqual(row["valid_positive_samples"], 0)
                    self.assertEqual(row["confirmed_absent_samples"], 1)
                    self.assertEqual(row["estimated_available_tiles"], 0)
                    self.assertEqual(row["estimated_point_bytes"], 0)
                    self.assertEqual(
                        row["estimated_conservative_bytes"],
                        0,
                    )
                else:
                    self.assertEqual(row["cached_samples"], 2)
                    self.assertEqual(row["valid_positive_samples"], 1)
                    self.assertEqual(row["confirmed_absent_samples"], 1)

            self.assertNotIn("footprint", report)
            self.assertEqual(
                set(report["footprints_by_dimension"]),
                {"nether", "end"},
            )
            self.assertEqual(
                set(report["totals_by_dimension"]),
                {"nether", "end"},
            )
            self.assertEqual(
                set(report["totals_by_layer"]),
                {"base", "overlay"},
            )
            self.assertEqual(
                set(report["totals_by_dimension_layer"]["nether"]),
                {"base", "overlay"},
            )

            commands = report["continuation_commands"]
            self.assertEqual(len(commands), 4)
            self.assertEqual(
                [
                    (
                        command["scope"]["dimensions"],
                        command["scope"]["layers"],
                    )
                    for command in commands
                ],
                [
                    (["nether"], ["base"]),
                    (["nether"], ["overlay"]),
                    (["end"], ["base"]),
                    (["end"], ["overlay"]),
                ],
            )
            for command in commands:
                reparsed = downloader.parse_args(
                    shlex.split(command["command"])[2:]
                )
                self.assertTrue(reparsed.all)
                self.assertTrue(reparsed.resume)
                self.assertTrue(reparsed.skip_smoke_test)
                self.assertTrue(reparsed.no_fallback)
                self.assertEqual(
                    reparsed.dimensions,
                    command["scope"]["dimensions"],
                )
                self.assertEqual(reparsed.layers, command["scope"]["layers"])
                self.assertEqual(reparsed.lods, requested_lods)
                self.assertEqual(reparsed.workers, 3)
                self.assertEqual(reparsed.requests_per_second, 4)


class ValidationTests(unittest.TestCase):
    @staticmethod
    def webp_bytes() -> bytes:
        buffer = io.BytesIO()
        Image.new("RGBA", (512, 512), (10, 20, 30, 255)).save(
            buffer, "WEBP", lossless=True
        )
        return buffer.getvalue()

    def test_complete_webp_and_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tile.webp"
            payload = self.webp_bytes()
            path.write_bytes(payload)
            valid = downloader.validate_webp(path)
            self.assertTrue(valid.valid)
            self.assertEqual(valid.size_bytes, len(payload))
            path.write_bytes(payload[:-5])
            invalid = downloader.validate_webp(path)
            self.assertFalse(invalid.valid)

    def test_invalid_2xx_body_is_retried(self) -> None:
        class Response:
            status_code = 202

        class Session:
            @staticmethod
            def request(*_args, **_kwargs):
                return Response()

        class RetryFetcher(downloader.TileFetcher):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.stream_calls = 0
                self.session = Session()

            def _session(self):
                return self.session

            def _stream_response(self, task, _response):
                self.stream_calls += 1
                if self.stream_calls == 1:
                    return downloader.DownloadResult(
                        task,
                        "corrupt",
                        False,
                        202,
                        0,
                        error="truncated WebP",
                        downloaded_bytes=10,
                    )
                return downloader.DownloadResult(
                    task,
                    "complete",
                    True,
                    202,
                    0,
                    size_bytes=20,
                    sha256="0" * 64,
                    downloaded_bytes=20,
                )

        with tempfile.TemporaryDirectory() as directory:
            stop_event = threading.Event()
            fetcher = RetryFetcher(
                Path(directory),
                limiter=downloader.AdaptiveRateLimiter(1_000_000, stop_event),
                stop_event=stop_event,
                timeout=1,
                retries=2,
                max_tile_bytes=1024,
                logger=logging.getLogger("test_retry_corrupt"),
            )
            task = downloader.DownloadTask(
                1,
                downloader.TileSpec("overworld", "base", 0, 0, 0),
                True,
            )
            with mock.patch.object(downloader.random, "random", return_value=-1):
                result = fetcher.fetch(task)
            self.assertEqual(result.status, "complete")
            self.assertEqual(result.attempts, 2)
            self.assertEqual(result.downloaded_bytes, 30)


class RateLimiterTests(unittest.TestCase):
    def test_retry_after_defers_every_worker_on_shared_limiter(self) -> None:
        clock = [100.0]
        waits: list[float] = []

        class Event:
            @staticmethod
            def is_set() -> bool:
                return False

            @staticmethod
            def wait(seconds: float) -> bool:
                waits.append(seconds)
                clock[0] += seconds
                return False

        with mock.patch.object(
            downloader.time, "monotonic", side_effect=lambda: clock[0]
        ):
            limiter = downloader.AdaptiveRateLimiter(2, Event())
            limiter.defer(3)
            self.assertTrue(limiter.acquire())
        self.assertAlmostEqual(sum(waits), 3)

    def test_fetcher_projects_retry_after_into_shared_cooldown(self) -> None:
        class Response:
            status_code = 429
            headers = {"Retry-After": "7"}
            text = ""

            @staticmethod
            def close() -> None:
                return None

        class Session:
            @staticmethod
            def request(*_args, **_kwargs):
                return Response()

        stop_event = mock.Mock()
        stop_event.is_set.return_value = False
        stop_event.wait.return_value = True
        limiter = mock.Mock()
        limiter.acquire.return_value = True
        limiter.slow_down.return_value = 0.5
        fetcher = downloader.TileFetcher(
            Path("/tmp"),
            limiter=limiter,
            stop_event=stop_event,
            timeout=1,
            retries=1,
            max_tile_bytes=1024,
            logger=logging.getLogger("test_global_retry_after"),
        )
        fetcher.local.session = Session()
        task = downloader.DownloadTask(
            1,
            downloader.TileSpec("overworld", "base", 0, 0, 0),
            True,
        )

        result = fetcher.fetch(task)

        limiter.defer.assert_called_once_with(7.0)
        self.assertEqual(result.status, "protection")
        self.assertEqual(result.http_code, 429)


class DatabaseTests(unittest.TestCase):
    def test_successful_parent_seeds_four_children(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                parent = downloader.TileSpec(
                    "overworld", "base", 10, 0, 0
                )
                row_id = database.add_tile(parent, root, selected=True)
                task = downloader.DownloadTask(row_id, parent, True)
                database.record_result(
                    downloader.DownloadResult(
                        task,
                        "complete",
                        True,
                        202,
                        1,
                        size_bytes=100,
                        sha256="0" * 64,
                    ),
                    root,
                    min_lod=9,
                    selected_lods={10, 9},
                )
                count = database.connection.execute(
                    "SELECT COUNT(*) FROM tiles WHERE lod=9"
                ).fetchone()[0]
                self.assertEqual(count, 4)
            finally:
                database.close()

    def test_resume_requeues_corrupt_and_newly_selected_probe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                probe = downloader.TileSpec(
                    "overworld", "base", 10, 0, 0
                )
                corrupt = downloader.TileSpec(
                    "overworld", "base", 9, 0, 0
                )
                probe_id = database.add_tile(probe, root, selected=False)
                corrupt_id = database.add_tile(corrupt, root, selected=True)
                database.connection.execute(
                    """
                    UPDATE tiles
                    SET status='probe_complete', size_bytes=1234
                    WHERE id=?
                    """,
                    (probe_id,),
                )
                database.connection.execute(
                    "UPDATE tiles SET status='corrupt' WHERE id=?",
                    (corrupt_id,),
                )
                database.connection.commit()

                database.prepare_resume(
                    ["overworld"], ["base"], {9, 10}
                )
                rows = database.connection.execute(
                    """
                    SELECT id, status, selected, size_bytes
                    FROM tiles WHERE id IN (?, ?) ORDER BY id
                    """,
                    (probe_id, corrupt_id),
                ).fetchall()
                self.assertEqual(
                    [
                        (
                            row["status"],
                            row["selected"],
                            row["size_bytes"],
                        )
                        for row in rows
                    ],
                    [("pending", 1, 0), ("pending", 1, 0)],
                )
            finally:
                database.close()

    def test_unselected_failed_ancestor_is_a_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                spec = downloader.TileSpec(
                    "overworld", "base", 10, 0, 0
                )
                row_id = database.add_tile(spec, root, selected=False)
                database.connection.execute(
                    "UPDATE tiles SET status='failed' WHERE id=?",
                    (row_id,),
                )
                database.connection.commit()
                self.assertEqual(
                    database.blocking_statuses(
                        ["overworld"], ["base"], 3
                    ),
                    {"failed": 1},
                )
            finally:
                database.close()


class ProgressTests(unittest.TestCase):
    def test_running_progress_exposes_canonical_and_legacy_archive_bytes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            stop_event = threading.Event()
            try:
                spec = downloader.TileSpec(
                    "overworld", "base", 10, 0, 0
                )
                row_id = database.add_tile(spec, root, selected=True)
                database.connection.execute(
                    """
                    UPDATE tiles
                    SET status='complete', size_bytes=1234,
                        sha256=?, downloaded_at=?
                    WHERE id=?
                    """,
                    ("0" * 64, downloader.utc_now(), row_id),
                )
                database.connection.commit()
                tracker = downloader.ProgressTracker(
                    output_root=root,
                    database=database,
                    planned_requests=1,
                    resume_command="python download_all_2b2t.py --resume",
                    logger=logging.getLogger("test_running_progress_bytes"),
                    limiter=downloader.AdaptiveRateLimiter(
                        1, stop_event
                    ),
                    started_completed=1,
                    started_bytes=1234,
                    dimensions=["overworld"],
                    layers=["base"],
                    min_lod=10,
                )
                tracker.report(force=True)
                progress = json.loads(
                    (root / "progress.json").read_text(encoding="utf-8")
                )
                self.assertEqual(progress["data_downloaded_bytes"], 1234)
                self.assertEqual(progress["space_used_bytes"], 1234)
            finally:
                database.close()

    def test_estimate_only_finishes_progress_as_terminal_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                database.set_metadata(
                    "smoke_test",
                    {"passed": True, "at": downloader.utc_now(), "tiles": 9},
                )
                spec = downloader.TileSpec(
                    "overworld",
                    "base",
                    10,
                    0,
                    0,
                )
                row_id = database.add_tile(spec, root, selected=True)
                database.connection.execute(
                    """
                    UPDATE tiles
                    SET status='complete', size_bytes=1234, sha256=?,
                        downloaded_at=?, updated_at=?
                    WHERE id=?
                    """,
                    (
                        "0" * 64,
                        downloader.utc_now(),
                        downloader.utc_now(),
                        row_id,
                    ),
                )
                database.connection.commit()
            finally:
                database.close()

            estimate_row = downloader.EstimateRow(
                dimension="overworld",
                layer="base",
                lod=10,
                candidate_tiles=16,
                estimated_available=16,
                sampled=1,
                found=1,
                mean_bytes_per_candidate=100,
                mean_bytes_existing=100,
                conservative_bytes=2_000,
                estimated_requests=16,
                allocation_unit_bytes=4_096,
                mean_allocated_bytes_existing=4_096,
                estimated_allocated_bytes=1_600,
            )
            fake_disk_usage = mock.Mock(
                total=200_000,
                used=100_000,
                free=100_000,
            )
            with (
                mock.patch.object(
                    downloader,
                    "verify_live_schema",
                    return_value={
                        "verified_at": downloader.utc_now(),
                        "schema": {},
                    },
                ),
                mock.patch.object(
                    downloader,
                    "discover_estimates",
                    return_value=[estimate_row],
                ),
                mock.patch.object(
                    downloader,
                    "run_smoke_test",
                    side_effect=AssertionError(
                        "registered smoke test must be reused"
                    ),
                ),
                mock.patch.object(
                    downloader.shutil,
                    "disk_usage",
                    return_value=fake_disk_usage,
                ),
            ):
                result = downloader.main(
                    [
                        "--estimate-only",
                        "--dimensions",
                        "overworld",
                        "--layers",
                        "base",
                        "--lods",
                        "10",
                        "--out",
                        str(root),
                        "--skip-smoke-test",
                    ]
                )

            self.assertEqual(result, 0)
            progress = json.loads(
                (root / "progress.json").read_text(encoding="utf-8")
            )
            self.assertEqual(progress["status"], "estimate_complete")
            self.assertEqual(progress["phase"], "estimate")
            self.assertFalse(progress["download_started"])
            self.assertEqual(progress["progress_percent"], 100.0)
            self.assertEqual(progress["planned_requests"], 1)
            self.assertEqual(progress["processed_requests"], 1)
            self.assertEqual(progress["remaining_requests"], 0)
            self.assertEqual(progress["estimated_requests"], 16)
            self.assertEqual(progress["tiles_completed"], 1)
            self.assertEqual(progress["data_downloaded_bytes"], 1234)
            self.assertEqual(progress["space_used_bytes"], 1234)


class DiscoveryCacheTests(unittest.TestCase):
    def test_transient_negative_is_retried_but_confirmed_404_is_reused(self) -> None:
        class FakeFetcher:
            def __init__(self, output_root: Path) -> None:
                self.output_root = output_root
                self.stop_event = threading.Event()
                self.calls = 0

            def fetch(self, task):
                self.calls += 1
                return downloader.DownloadResult(
                    task,
                    "absent",
                    False,
                    404,
                    1,
                    error="tile no publicado",
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            fetcher = FakeFetcher(root)
            logger = logging.getLogger("test_discovery_cache")
            try:
                tile_x, tile_z = downloader.sample_coordinates(
                    "overworld", 10, 1
                )[0]
                spec = downloader.TileSpec(
                    "overworld", "overlay", 10, tile_x, tile_z
                )
                database.save_sample(
                    spec,
                    http_code=503,
                    exists=False,
                    size_bytes=0,
                    error="temporary failure",
                )
                downloader.discover_estimates(
                    dimensions=["overworld"],
                    layers=["overlay"],
                    lods={10},
                    samples_per_group=1,
                    database=database,
                    fetcher=fetcher,
                    logger=logger,
                    reuse_samples=True,
                )
                self.assertEqual(fetcher.calls, 1)

                downloader.discover_estimates(
                    dimensions=["overworld"],
                    layers=["overlay"],
                    lods={10},
                    samples_per_group=1,
                    database=database,
                    fetcher=fetcher,
                    logger=logger,
                    reuse_samples=True,
                )
                self.assertEqual(fetcher.calls, 1)
            finally:
                database.close()

    def test_current_transient_sample_aborts_estimate(self) -> None:
        class TransientFetcher:
            def __init__(self, output_root: Path) -> None:
                self.output_root = output_root
                self.stop_event = threading.Event()

            @staticmethod
            def fetch(task):
                return downloader.DownloadResult(
                    task,
                    "failed",
                    False,
                    503,
                    5,
                    error="HTTP 503",
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                with self.assertRaisesRegex(
                    RuntimeError, "muestra de descubrimiento no concluyente"
                ):
                    downloader.discover_estimates(
                        dimensions=["overworld"],
                        layers=["overlay"],
                        lods={10},
                        samples_per_group=1,
                        database=database,
                        fetcher=TransientFetcher(root),
                        logger=logging.getLogger("test_transient_sample"),
                        reuse_samples=False,
                    )
            finally:
                database.close()


class PlanningTests(unittest.TestCase):
    def test_fallback_is_coarse_to_fine(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                lod,
                1,
                1,
                1,
                1,
                100,
                100,
                size,
                1,
            )
            for lod, size in ((10, 100), (9, 200), (8, 500))
        ]
        plan = downloader.build_plan(
            dimensions=["overworld", "end"],
            layers=["base", "overlay"],
            lods={8, 9, 10},
            rows=rows,
            free_bytes=400,
            existing_bytes=0,
            allow_fallback=True,
        )
        self.assertTrue(plan.fallback)
        self.assertEqual(plan.dimensions, ["overworld"])
        self.assertEqual(plan.layers, ["base"])
        self.assertEqual(plan.lods, {10, 9})

        payload = downloader.download_plan_payload(plan)
        self.assertEqual(payload["lods"], [9, 10])
        self.assertEqual(payload["rows"][0]["dimension"], "overworld")
        json.dumps(payload)

    def test_configurable_headroom_can_accept_conservative_plan(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                10,
                1,
                1,
                1,
                1,
                1_000,
                1_000,
                1_000,
                1,
            )
        ]
        plan = downloader.build_plan(
            dimensions=["overworld"],
            layers=["base"],
            lods={10},
            rows=rows,
            free_bytes=1_150,
            existing_bytes=0,
            allow_fallback=False,
            space_headroom_percent=15,
        )
        self.assertFalse(plan.fallback)
        self.assertEqual(plan.lods, {10})
        self.assertEqual(plan.required_with_headroom, 1_150)
        self.assertEqual(plan.space_headroom_percent, 15)

    def test_stacked_reserves_do_not_replace_required_headroom(self) -> None:
        plan = downloader.DownloadPlan(
            dimensions=["overworld"],
            layers=["base"],
            lods={0},
            rows=[],
            fallback=False,
            point_bytes=1_000,
            conservative_bytes=1_250,
            requests=1,
            free_bytes=2_000,
            required_with_headroom=1_475,
            space_headroom_percent=18,
        )
        payload = downloader.download_plan_payload(plan)
        self.assertAlmostEqual(
            downloader.compounded_margin_percent(25, 18),
            47.5,
        )
        self.assertEqual(payload["sampling_uncertainty_percent"], 25)
        self.assertEqual(payload["required_space_headroom_percent"], 20)
        self.assertAlmostEqual(
            payload["nominal_total_margin_percent"],
            47.5,
        )
        self.assertAlmostEqual(
            payload["effective_total_margin_percent"],
            47.5,
        )
        self.assertEqual(payload["minimum_required_with_headroom"], 1_500)
        self.assertFalse(payload["meets_required_space_headroom"])
        required_plan = downloader.dataclasses.replace(
            plan,
            required_with_headroom=1_500,
            space_headroom_percent=20,
        )
        self.assertTrue(
            downloader.download_plan_payload(required_plan)[
                "meets_required_space_headroom"
            ]
        )

    def test_effective_margin_is_undefined_without_point_estimate(self) -> None:
        plan = downloader.DownloadPlan(
            dimensions=["overworld"],
            layers=["base"],
            lods={0},
            rows=[],
            fallback=False,
            point_bytes=0,
            conservative_bytes=100,
            requests=0,
            free_bytes=1_000,
            required_with_headroom=120,
            space_headroom_percent=20,
        )
        self.assertIsNone(
            downloader.download_plan_payload(plan)[
                "effective_total_margin_percent"
            ]
        )

    def test_point_estimate_subtracts_existing_complete_payload(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                0,
                1,
                1,
                1,
                1,
                1_000,
                1_000,
                1_250,
                1,
            )
        ]
        plan = downloader.build_plan(
            dimensions=["overworld"],
            layers=["base"],
            lods={0},
            rows=rows,
            free_bytes=2_000,
            existing_bytes=100,
            allow_fallback=False,
            space_headroom_percent=18,
        )
        self.assertEqual(plan.point_bytes, 900)
        self.assertEqual(plan.conservative_bytes, 1_150)

    def test_fallback_subtracts_existing_bytes_per_group(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                lod,
                1,
                1,
                1,
                1,
                point,
                point,
                conservative,
                1,
            )
            for lod, point, conservative in (
                (10, 1_000, 1_000),
                (9, 2_000, 2_000),
            )
        ]
        plan = downloader.build_plan(
            dimensions=["overworld", "nether"],
            layers=["base", "overlay"],
            lods={9, 10},
            rows=rows,
            free_bytes=600,
            existing_bytes=600,
            existing_bytes_by_group={
                ("overworld", "base", 10): 600,
            },
            allow_fallback=True,
            space_headroom_percent=20,
        )
        self.assertTrue(plan.fallback)
        self.assertEqual(plan.lods, {10})
        self.assertEqual(plan.conservative_bytes, 400)
        self.assertEqual(plan.point_bytes, 400)
        self.assertEqual(plan.required_with_headroom, 480)

    def test_overfull_group_cannot_subsidize_another_group(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                10,
                1,
                1,
                1,
                1,
                100,
                100,
                100,
                1,
            ),
            downloader.EstimateRow(
                "overworld",
                "base",
                9,
                1,
                1,
                1,
                1,
                1_000,
                1_000,
                1_000,
                1,
            ),
        ]
        existing = {
            ("overworld", "base", 10): 1_000,
        }
        self.assertEqual(
            downloader.remaining_estimate_bytes(
                rows,
                existing,
                point_estimate=False,
            ),
            1_000,
        )
        plan = downloader.build_plan(
            dimensions=["overworld"],
            layers=["base"],
            lods={9, 10},
            rows=rows,
            free_bytes=200,
            existing_bytes=1_000,
            existing_bytes_by_group=existing,
            allow_fallback=False,
            space_headroom_percent=20,
        )
        self.assertEqual(plan.conservative_bytes, 1_000)
        self.assertEqual(plan.required_with_headroom, 1_200)
        self.assertFalse(plan.required_with_headroom <= plan.free_bytes)

    def test_current_luisa_estimate_fits_at_18_but_not_20_percent(self) -> None:
        conservative = 1_235_379_207_149
        free = 1_471_467_438_080
        required_at_18 = downloader.bytes_with_space_headroom(
            conservative, 18
        )
        required_at_20 = downloader.bytes_with_space_headroom(
            conservative, 20
        )
        self.assertLessEqual(required_at_18, free)
        self.assertGreater(required_at_20, free)
        self.assertGreater(free - required_at_18, 12 * 1024**3)
        self.assertLess(
            18,
            downloader.REQUIRED_SPACE_HEADROOM_PERCENT,
        )

    def test_no_fallback_preserves_full_scope_when_space_is_short(self) -> None:
        rows = [
            downloader.EstimateRow(
                "overworld",
                "base",
                10,
                1,
                1,
                1,
                1,
                1_000,
                1_000,
                1_000,
                1,
            )
        ]
        plan = downloader.build_plan(
            dimensions=["overworld", "end"],
            layers=["base", "overlay"],
            lods={10},
            rows=rows,
            free_bytes=1_150,
            existing_bytes=0,
            allow_fallback=False,
            space_headroom_percent=20,
        )
        self.assertFalse(plan.fallback)
        self.assertEqual(plan.dimensions, ["overworld", "end"])
        self.assertEqual(plan.layers, ["base", "overlay"])
        self.assertEqual(plan.lods, {10})
        self.assertEqual(plan.rows, rows)
        self.assertGreater(plan.required_with_headroom, plan.free_bytes)


if __name__ == "__main__":
    unittest.main()
