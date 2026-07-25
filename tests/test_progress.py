from __future__ import annotations

import io
import json
import logging
import tempfile
import time
import unittest
from pathlib import Path

import download_all_2b2t as downloader


class ProgressCalculationTests(unittest.TestCase):
    def test_resume_counts_existing_terminal_rows(self) -> None:
        progress = downloader.calculate_progress(
            {
                "complete": 80,
                "absent": 5,
                "pending": 10,
                "downloading": 1,
            },
            estimated_requests=100,
        )

        self.assertEqual(progress["planned_requests"], 100)
        self.assertEqual(progress["processed_requests"], 85)
        self.assertEqual(progress["known_requests"], 96)
        self.assertEqual(progress["remaining_requests"], 15)
        self.assertEqual(progress["progress_percent"], 85.0)
        self.assertEqual(progress["progress_kind"], "estimated")

    def test_dynamic_queue_can_grow_beyond_estimate(self) -> None:
        progress = downloader.calculate_progress(
            {
                "complete": 90,
                "absent": 10,
                "pending": 20,
            },
            estimated_requests=100,
        )

        self.assertEqual(progress["planned_requests"], 120)
        self.assertEqual(progress["processed_requests"], 100)
        self.assertAlmostEqual(progress["progress_percent"], 100 / 120 * 100)
        self.assertEqual(progress["progress_kind"], "dynamic")

    def test_successful_final_uses_discovered_actual_total(self) -> None:
        progress = downloader.calculate_progress(
            {"complete": 12, "absent": 3},
            estimated_requests=1_000,
            successful_final=True,
        )

        self.assertEqual(progress["planned_requests"], 15)
        self.assertEqual(progress["processed_requests"], 15)
        self.assertEqual(progress["remaining_requests"], 0)
        self.assertEqual(progress["progress_percent"], 100.0)
        self.assertEqual(progress["progress_kind"], "actual")

    def test_scope_bar_and_fallback_status(self) -> None:
        self.assertEqual(
            downloader.scope_payload(
                ["overworld", "end"],
                ["base", "overlay"],
                [3, 10, 3],
            ),
            {
                "dimensions": ["overworld", "end"],
                "layers": ["base", "overlay"],
                "lods": [3, 10],
            },
        )
        self.assertEqual(
            downloader.render_progress_bar(50, width=10),
            "[#####-----]  50.00%",
        )
        self.assertEqual(
            downloader.render_progress_bar(150, width=4),
            "[####] 100.00%",
        )
        with self.assertRaises(ValueError):
            downloader.render_progress_bar(10, width=0)
        self.assertEqual(
            downloader.final_status_for_plan("complete", fallback=True),
            "fallback_complete",
        )
        self.assertEqual(
            downloader.final_status_for_plan("complete", fallback=False),
            "complete",
        )


class ProgressTrackerTests(unittest.TestCase):
    class FakeDatabase:
        def __init__(self) -> None:
            self.status_counts = {
                "complete": 80,
                "absent": 5,
                "pending": 10,
                "downloading": 1,
            }

        def work_counts_for(self, *_args):
            return dict(self.status_counts)

        def counts_for(self, *_args):
            return dict(self.status_counts)

        def total_downloaded_bytes_for(self, *_args):
            return 123_456

        def http_errors_for(self, *_args):
            return {"404": 5}

    class FakeLimiter:
        rate = 2.0

    def test_json_and_ascii_bar_include_scope_and_resume_aware_eta(self) -> None:
        stream = io.StringIO()
        logger = logging.getLogger(
            f"test_progress_tracker_{id(self)}"
        )
        logger.handlers.clear()
        logger.propagate = False
        logger.setLevel(logging.INFO)
        logger.addHandler(logging.StreamHandler(stream))

        requested = downloader.scope_payload(
            ["overworld", "nether", "end"],
            ["base", "overlay", "newchunks"],
            range(11),
        )
        effective = downloader.scope_payload(
            ["overworld"],
            ["base"],
            range(3, 11),
        )

        with tempfile.TemporaryDirectory() as directory:
            tracker = downloader.ProgressTracker(
                output_root=Path(directory),
                database=self.FakeDatabase(),  # type: ignore[arg-type]
                planned_requests=100,
                resume_command="python download_all_2b2t.py --resume",
                logger=logger,
                limiter=self.FakeLimiter(),  # type: ignore[arg-type]
                started_completed=80,
                started_bytes=100_000,
                dimensions=["overworld"],
                layers=["base"],
                min_lod=3,
                requested_scope=requested,
                effective_scope=effective,
                fallback=True,
            )
            tracker.processed = 5
            tracker.started = time.monotonic() - 10
            tracker.report(force=True)

            payload = json.loads(
                (Path(directory) / "progress.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["planned_requests"], 100)
        self.assertEqual(payload["processed_requests"], 85)
        self.assertEqual(payload["progress_percent"], 85.0)
        self.assertEqual(payload["progress_kind"], "estimated")
        self.assertEqual(payload["requested_scope"], requested)
        self.assertEqual(payload["effective_scope"], effective)
        self.assertTrue(payload["fallback"])
        self.assertGreater(payload["eta_seconds"], 25)
        self.assertLess(payload["eta_seconds"], 35)
        self.assertIn("[########################----]", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
