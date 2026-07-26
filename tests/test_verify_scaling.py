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


class DatabaseModeTests(unittest.TestCase):
    def test_read_only_connection_enforces_query_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "tiles.sqlite3"
            create_database(database, 1)

            connection = verifier.open_database(database, writable=False)
            try:
                self.assertEqual(
                    int(connection.execute("PRAGMA query_only").fetchone()[0]),
                    1,
                )
                self.assertTrue(connection.in_transaction)
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute(
                        "UPDATE tiles SET status='pending' WHERE id=1"
                    )
            finally:
                connection.close()

    def test_default_main_uses_uri_read_only_without_updates_or_commits(
        self,
    ) -> None:
        class TrackingConnection:
            def __init__(self, connection: sqlite3.Connection) -> None:
                object.__setattr__(self, "_connection", connection)
                object.__setattr__(self, "commit_calls", 0)
                object.__setattr__(self, "statements", [])

            def __getattr__(self, name: str):
                return getattr(self._connection, name)

            def __setattr__(self, name: str, value: object) -> None:
                if name in {"_connection", "commit_calls", "statements"}:
                    object.__setattr__(self, name, value)
                else:
                    setattr(self._connection, name, value)

            def execute(self, statement: str, *args):
                self.statements.append(statement)
                return self._connection.execute(statement, *args)

            def commit(self) -> None:
                self.commit_calls += 1
                self._connection.commit()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "tiles.sqlite3"
            report = root / "report.json"
            create_database(database, 1)
            real_connect = sqlite3.connect
            connect_calls: list[
                tuple[object, tuple[object, ...], dict[str, object]]
            ] = []
            connections: list[TrackingConnection] = []

            def tracking_connect(
                database_arg: object,
                *args: object,
                **kwargs: object,
            ) -> TrackingConnection:
                connect_calls.append((database_arg, args, kwargs))
                tracked = TrackingConnection(
                    real_connect(database_arg, *args, **kwargs)
                )
                connections.append(tracked)
                return tracked

            def fake_check(
                row_id: int,
                path: Path,
                _expected_size: int | None,
                _expected_hash: str | None,
            ) -> verifier.CheckResult:
                return verifier.CheckResult(
                    row_id,
                    path,
                    True,
                    size_bytes=99,
                    sha256="b" * 64,
                )

            with (
                verifier.RegionDownloadLock(root),
                mock.patch.object(
                    verifier.sqlite3,
                    "connect",
                    side_effect=tracking_connect,
                ),
                mock.patch.object(
                    verifier,
                    "check_file",
                    side_effect=fake_check,
                ),
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
                    ]
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(connect_calls), 1)
            database_arg, positional, keywords = connect_calls[0]
            self.assertEqual(positional, ())
            self.assertIsInstance(database_arg, str)
            self.assertIn("mode=ro", str(database_arg))
            self.assertTrue(keywords["uri"])
            self.assertEqual(connections[0].commit_calls, 0)
            statements = [
                statement.strip().upper()
                for statement in connections[0].statements
            ]
            self.assertIn("PRAGMA QUERY_ONLY=ON", statements)
            self.assertFalse(
                any(statement.startswith("UPDATE") for statement in statements)
            )

            connection = sqlite3.connect(database)
            try:
                size_bytes, sha256, status = connection.execute(
                    """
                    SELECT size_bytes, sha256, status
                    FROM tiles
                    WHERE id=1
                    """
                ).fetchone()
            finally:
                connection.close()
            self.assertEqual(
                (size_bytes, sha256, status),
                (1, "0" * 64, "complete"),
            )
            self.assertEqual(
                json.loads(report.read_text(encoding="utf-8"))["valid"],
                1,
            )

    def test_requeue_refuses_active_shared_lock_before_opening_database(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "tiles.sqlite3"
            report = root / "report.json"
            create_database(database, 1)

            with (
                verifier.RegionDownloadLock(root),
                mock.patch.object(verifier, "open_database") as open_database,
            ):
                exit_code = verifier.main(
                    [
                        "--out",
                        str(root),
                        "--database",
                        str(database),
                        "--report",
                        str(report),
                        "--requeue-corrupt",
                    ]
                )

            self.assertEqual(exit_code, 2)
            open_database.assert_not_called()
            self.assertFalse(report.exists())


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

            with (
                mock.patch.object(
                    verifier,
                    "check_file",
                    side_effect=fake_check,
                ),
                mock.patch.object(
                    verifier,
                    "open_database",
                    wraps=verifier.open_database,
                ) as open_database,
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
                records = {
                    int(row_id): (
                        str(status),
                        int(size_bytes),
                        str(sha256) if sha256 is not None else None,
                    )
                    for row_id, status, size_bytes, sha256 in connection.execute(
                        """
                        SELECT id, status, size_bytes, sha256
                        FROM tiles
                        ORDER BY id
                        """
                    )
                }
            finally:
                connection.close()
            payload = json.loads(report.read_text(encoding="utf-8"))

            self.assertEqual(exit_code, 1)
            open_database.assert_called_once_with(
                database.resolve(),
                writable=True,
            )
            self.assertEqual(
                records,
                {
                    1: ("complete", 1, "b" * 64),
                    2: ("pending", 1, None),
                },
            )
            self.assertEqual(payload["checked"], 2)
            self.assertEqual(payload["valid"], 1)
            self.assertEqual(payload["invalid"], 1)
            self.assertEqual(payload["requeued"], 1)
            with verifier.RegionDownloadLock(root):
                pass


if __name__ == "__main__":
    unittest.main()
