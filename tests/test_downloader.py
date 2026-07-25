from __future__ import annotations

import io
import json
import logging
import shlex
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

    def test_published_candidate_counts(self) -> None:
        self.assertEqual(downloader.candidate_count("overworld", 0), 4_000_000)
        self.assertEqual(downloader.candidate_count("overworld", 10), 4)
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
                "--skip-smoke-test",
            ]
        )
        self.assertEqual(args.dimensions, ["overworld"])
        tokens = shlex.split(downloader.build_resume_command(args))
        reparsed = downloader.parse_args(tokens[2:])
        self.assertEqual(reparsed.dimensions, ["overworld"])
        self.assertEqual(reparsed.discovery_samples, 7)
        self.assertEqual(reparsed.max_tile_bytes, 123456)
        self.assertTrue(reparsed.resume)
        self.assertTrue(reparsed.skip_smoke_test)


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


if __name__ == "__main__":
    unittest.main()
