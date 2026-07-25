from __future__ import annotations

import concurrent.futures
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import verify_download as verifier


def create_database(path: Path, rows: int) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            CREATE TABLE tiles (
                id INTEGER PRIMARY KEY,
                relative_path TEXT NOT NULL,
                size_bytes INTEGER,
                sha256 TEXT,
                status TEXT NOT NULL,
                error_message TEXT,
                updated_at TEXT
            );
            """
        )
        connection.executemany(
            """
            INSERT INTO tiles(
                id, relative_path, size_bytes, sha256, status, updated_at
            ) VALUES (?, ?, 1, ?, 'complete', datetime('now'))
            """,
            (
                (row_id, f"tile-{row_id}.webp", "0" * 64)
                for row_id in range(1, rows + 1)
            ),
        )
        connection.commit()
    finally:
        connection.close()


class RowPagingTests(unittest.TestCase):
    def test_complete_rows_are_read_in_keyset_pages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "tiles.sqlite3"
            create_database(database, 23)
            connection = sqlite3.connect(database)
            connection.row_factory = sqlite3.Row
            statements: list[str] = []
            connection.set_trace_callback(statements.append)
            try:
                rows = list(
                    verifier.iter_complete_rows(
                        connection,
                        max_id=23,
                        page_size=5,
                    )
                )
            finally:
                connection.close()

            self.assertEqual(
                [int(row["id"]) for row in rows],
                list(range(1, 24)),
            )
            paged_selects = [
                statement
                for statement in statements
                if "SELECT id, relative_path" in statement
            ]
            self.assertEqual(len(paged_selects), 5)
            self.assertTrue(all("LIMIT 5" in query for query in paged_selects))


class BoundedConcurrencyTests(unittest.TestCase):
    def test_main_bounds_futures_to_small_worker_multiple(self) -> None:
        real_executor = concurrent.futures.ThreadPoolExecutor
        release = threading.Event()
        reached_limit = threading.Event()
        counter_lock = threading.Lock()
        workers = 2
        limit = workers * verifier.FUTURES_PER_WORKER

        class TrackingExecutor(real_executor):
            total_submitted = 0

            def submit(self, fn, /, *args, **kwargs):
                with counter_lock:
                    type(self).total_submitted += 1
                    if type(self).total_submitted >= limit:
                        reached_limit.set()
                return super().submit(fn, *args, **kwargs)

        def blocked_check(
            row_id: int,
            path: Path,
            _expected_size: int | None,
            _expected_hash: str | None,
        ) -> verifier.CheckResult:
            release.wait(timeout=10)
            return verifier.CheckResult(
                row_id,
                path,
                True,
                size_bytes=1,
                sha256="a" * 64,
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "tiles.sqlite3"
            report = root / "report.json"
            create_database(database, 50)
            outcome: list[int] = []
            failures: list[BaseException] = []

            def run_main() -> None:
                try:
                    outcome.append(
                        verifier.main(
                            [
                                "--out",
                                str(root),
                                "--database",
                                str(database),
                                "--report",
                                str(report),
                                "--workers",
                                str(workers),
                            ]
                        )
                    )
                except BaseException as exc:
                    failures.append(exc)

            with (
                mock.patch.object(
                    verifier.concurrent.futures,
                    "ThreadPoolExecutor",
                    TrackingExecutor,
                ),
                mock.patch.object(
                    verifier,
                    "check_file",
                    side_effect=blocked_check,
                ),
            ):
                thread = threading.Thread(target=run_main)
                thread.start()
                try:
                    self.assertTrue(reached_limit.wait(timeout=5))
                    time.sleep(0.1)
                    with counter_lock:
                        submitted_while_blocked = (
                            TrackingExecutor.total_submitted
                        )
                finally:
                    release.set()
                    thread.join(timeout=10)

            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertLessEqual(submitted_while_blocked, limit)
            self.assertEqual(TrackingExecutor.total_submitted, 50)
            self.assertEqual(outcome, [0])
            self.assertEqual(
                json.loads(report.read_text(encoding="utf-8"))["checked"],
                50,
            )

    def test_requeue_corrupt_behavior_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "tiles.sqlite3"
            report = root / "report.json"
            create_database(database, 2)

            def fake_check(
                row_id: int,
                path: Path,
                _expected_size: int | None,
                _expected_hash: str | None,
            ) -> verifier.CheckResult:
                if row_id == 2:
                    return verifier.CheckResult(
                        row_id,
                        path,
                        False,
                        error="WebPValidationError: corrupt",
                    )
                return verifier.CheckResult(
                    row_id,
                    path,
                    True,
                    size_bytes=1,
                    sha256="b" * 64,
                )

            with mock.patch.object(
                verifier,
                "check_file",
                side_effect=fake_check,
            ):
                exit_code = verifier.main(
                    [
                        "--out",
                        str(root),
                        "--database",
                        str(database),
                        "--report",
                        str(report),
                        "--workers",
                        "1",
                        "--requeue-corrupt",
                    ]
                )

            connection = sqlite3.connect(database)
            try:
                statuses = dict(
                    connection.execute(
                        "SELECT id, status FROM tiles ORDER BY id"
                    )
                )
            finally:
                connection.close()
            payload = json.loads(report.read_text(encoding="utf-8"))

            self.assertEqual(exit_code, 1)
            self.assertEqual(statuses, {1: "complete", 2: "pending"})
            self.assertEqual(payload["checked"], 2)
            self.assertEqual(payload["valid"], 1)
            self.assertEqual(payload["invalid"], 1)
            self.assertEqual(payload["requeued"], 1)


if __name__ == "__main__":
    unittest.main()
