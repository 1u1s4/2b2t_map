from __future__ import annotations

import logging
import tempfile
import threading
import unittest
from pathlib import Path

import download_all_2b2t as downloader


class AllocationEstimateTests(unittest.TestCase):
    def test_every_5xx_status_is_retryable(self) -> None:
        self.assertTrue(downloader.is_retryable_http_status(408))
        self.assertTrue(downloader.is_retryable_http_status(429))
        for status in range(500, 600):
            with self.subTest(status=status):
                self.assertTrue(downloader.is_retryable_http_status(status))
        self.assertFalse(downloader.is_retryable_http_status(404))
        self.assertFalse(downloader.is_retryable_http_status(499))

    def test_allocated_payload_rounds_to_filesystem_unit(self) -> None:
        self.assertEqual(downloader.allocated_payload_bytes(0, 4096), 0)
        self.assertEqual(downloader.allocated_payload_bytes(1, 4096), 4096)
        self.assertEqual(downloader.allocated_payload_bytes(4096, 4096), 4096)
        self.assertEqual(downloader.allocated_payload_bytes(4097, 4096), 8192)

    def test_base_estimate_uses_existing_tile_size_after_density_floor(self) -> None:
        class FakeFetcher:
            def __init__(self, output_root: Path) -> None:
                self.output_root = output_root
                self.stop_event = threading.Event()
                self.calls = 0

            def fetch(self, task: downloader.DownloadTask) -> downloader.DownloadResult:
                self.calls += 1
                if self.calls == 1:
                    return downloader.DownloadResult(
                        task,
                        "complete",
                        True,
                        200,
                        1,
                        size_bytes=100,
                        sha256="0" * 64,
                    )
                return downloader.DownloadResult(
                    task,
                    "absent",
                    False,
                    404,
                    1,
                    error="not published",
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = downloader.TileDatabase(root / "tiles.sqlite3")
            try:
                row = downloader.discover_estimates(
                    dimensions=["overworld"],
                    layers=["base"],
                    lods={10},
                    samples_per_group=3,
                    database=database,
                    fetcher=FakeFetcher(root),
                    logger=logging.getLogger("allocation_estimate"),
                    reuse_samples=False,
                )[0]
                expected_unit = downloader.filesystem_allocation_unit(root)
                self.assertEqual(row.estimated_available, 4)
                self.assertEqual(row.allocation_unit_bytes, expected_unit)
                self.assertEqual(
                    row.estimated_allocated_bytes,
                    4 * downloader.allocated_payload_bytes(100, expected_unit),
                )
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
