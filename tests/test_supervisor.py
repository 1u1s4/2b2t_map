from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from collections import deque
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace
from unittest import mock

import supervise_full_download_luisa as supervisor


def observation(
    status: str,
    *,
    reason: str | None = None,
    errors: dict[str, int] | None = None,
) -> supervisor.ProgressObservation:
    return supervisor.ProgressObservation(
        exists=True,
        valid=True,
        status=status,
        reason=reason,
        http_errors=errors or {},
        age_seconds=120,
    )


def decide(
    value: supervisor.ProgressObservation,
    **overrides: object,
) -> supervisor.RestartDecision:
    values = {
        "output_mounted": True,
        "launcher_exists": True,
        "image_exists": True,
        "free_bytes": 1_000,
        "free_floor_bytes": 500,
        "backing_free_bytes": 1_000,
        "backing_free_floor_bytes": 500,
    }
    values.update(overrides)
    return supervisor.decide_after_process_loss(value, **values)


def margin_observation(
    *,
    valid: bool = True,
    configured_percent: float | None = 18,
    target_percent: float = 20,
    fits: bool = True,
    shortfall_bytes: int | None = 0,
    downloading_rows: int | None = 4,
    quick_check_ok: bool | None = None,
    reason: str = "test",
) -> supervisor.MarginObservation:
    return supervisor.MarginObservation(
        valid=valid,
        reason=reason,
        configured_percent=configured_percent,
        target_percent=target_percent,
        conservative_total_bytes=1_000,
        existing_complete_bytes=100,
        conservative_remaining_bytes=900,
        required_bytes=1_080,
        tile_free_bytes=2_000,
        backing_free_bytes=2_000,
        shortfall_bytes=shortfall_bytes,
        downloading_rows=downloading_rows,
        quick_check_ok=quick_check_ok,
        fits=fits,
    )


class RestartDecisionTests(unittest.TestCase):
    def test_restart_budget_counts_each_launcher_invocation(self) -> None:
        restart_times: deque[float] = deque()
        for now in (10.0, 11.0, 12.0):
            self.assertTrue(
                supervisor.claim_restart_slot(
                    restart_times,
                    now=now,
                    window_seconds=100.0,
                    maximum=3,
                )
            )
        self.assertFalse(
            supervisor.claim_restart_slot(
                restart_times,
                now=13.0,
                window_seconds=100.0,
                maximum=3,
            )
        )
        self.assertEqual(list(restart_times), [10.0, 11.0, 12.0])
        self.assertTrue(
            supervisor.claim_restart_slot(
                restart_times,
                now=111.0,
                window_seconds=100.0,
                maximum=3,
            )
        )
        self.assertEqual(list(restart_times), [11.0, 12.0, 111.0])

    def test_only_active_unclosed_state_is_restartable(self) -> None:
        self.assertEqual(decide(observation("running")).action, "restart")
        self.assertEqual(decide(observation("discovering")).action, "restart")
        for status in (
            "complete",
            "fallback_complete",
            "error",
            "incomplete",
            "preflight_blocked",
            "protection",
            "stopped",
        ):
            with self.subTest(status=status):
                self.assertNotEqual(decide(observation(status)).action, "restart")

    def test_http_protection_and_safety_reasons_never_restart(self) -> None:
        self.assertEqual(
            decide(observation("running", errors={"429": 1})).action,
            "stop",
        )
        self.assertEqual(
            decide(observation("running", errors={"403": 1})).action,
            "stop",
        )
        for reason in (
            "espacio libre por debajo del piso seguro",
            "protection HTTP",
            "interrumpido por signal",
            "schema contract changed",
        ):
            with self.subTest(reason=reason):
                self.assertEqual(
                    decide(observation("running", reason=reason)).action,
                    "stop",
                )

    def test_missing_prerequisites_and_low_space_block_restart(self) -> None:
        self.assertEqual(
            decide(observation("running"), output_mounted=False).action,
            "stop",
        )
        self.assertEqual(
            decide(observation("running"), launcher_exists=False).action,
            "stop",
        )
        self.assertEqual(
            decide(observation("running"), image_exists=False).action,
            "stop",
        )
        self.assertEqual(
            decide(
                observation("running"),
                free_bytes=499,
                free_floor_bytes=500,
            ).action,
            "stop",
        )
        self.assertEqual(
            decide(
                observation("running"),
                backing_free_bytes=499,
                backing_free_floor_bytes=500,
            ).action,
            "stop",
        )

    def test_absent_or_invalid_progress_blocks_restart(self) -> None:
        missing = supervisor.ProgressObservation(
            False, False, "", None, {}, None
        )
        invalid = supervisor.ProgressObservation(
            True, False, "", None, {}, 120
        )
        self.assertEqual(decide(missing).action, "stop")
        self.assertEqual(decide(invalid).action, "stop")


class MarginDecisionTests(unittest.TestCase):
    def test_live_transition_requires_every_safety_signal(self) -> None:
        progress = supervisor.dataclasses.replace(
            observation("running"),
            age_seconds=1,
        )
        ready = supervisor.decide_margin_transition(
            margin_observation(),
            progress,
            process_percent=18,
            maximum_heartbeat_age=30,
        )
        self.assertEqual(ready.action, "ready")

        discovering = supervisor.decide_margin_transition(
            margin_observation(),
            observation("discovering"),
            process_percent=18,
            maximum_heartbeat_age=30,
        )
        self.assertEqual(discovering.action, "wait")
        prelaunch = supervisor.decide_margin_transition(
            margin_observation(),
            progress,
            process_percent=18,
            maximum_heartbeat_age=30,
            progress_is_post_launch=False,
        )
        self.assertEqual(prelaunch.action, "wait")

        stale = supervisor.dataclasses.replace(
            progress,
            age_seconds=31,
        )
        self.assertEqual(
            supervisor.decide_margin_transition(
                margin_observation(),
                stale,
                process_percent=18,
                maximum_heartbeat_age=30,
            ).action,
            "wait",
        )
        protected = observation("running", errors={"429": 1})
        self.assertEqual(
            supervisor.decide_margin_transition(
                margin_observation(),
                protected,
                process_percent=18,
                maximum_heartbeat_age=30,
            ).action,
            "stop",
        )
        target_no_longer_fits = supervisor.dataclasses.replace(
            margin_observation(configured_percent=20),
            tile_free_bytes=1_000,
            backing_free_bytes=1_000,
            shortfall_bytes=80,
            fits=False,
        )
        self.assertEqual(
            supervisor.decide_margin_transition(
                target_no_longer_fits,
                progress,
                process_percent=20,
                maximum_heartbeat_age=30,
            ).action,
            "wait",
        )
        already_target = margin_observation(configured_percent=20)
        self.assertEqual(
            supervisor.decide_margin_transition(
                already_target,
                progress,
                process_percent=18,
                maximum_heartbeat_age=30,
            ).action,
            "stop",
        )
        self.assertEqual(
            supervisor.decide_margin_transition(
                margin_observation(),
                progress,
                process_percent=20,
                maximum_heartbeat_age=30,
            ).action,
            "stop",
        )

    def test_planned_stop_requires_exact_clean_reason(self) -> None:
        clean = observation("stopped", reason="interrumpido")
        self.assertEqual(
            supervisor.clean_planned_stop(clean).action,
            "ready",
        )
        for unsafe in (
            observation("stopped", reason="protección HTTP"),
            observation("stopped", reason="espacio insuficiente"),
            observation("stopped", reason="interrumpido", errors={"429": 1}),
            observation("error", reason="interrumpido"),
        ):
            with self.subTest(observation=unsafe):
                self.assertNotEqual(
                    supervisor.clean_planned_stop(unsafe).action,
                    "ready",
                )

    def test_replacement_loss_requires_new_active_or_clean_stop(self) -> None:
        clean = observation("stopped", reason="interrumpido")
        missing = supervisor.decide_replacement_loss_progress(
            clean,
            progress_mtime=None,
            signalled_at=100,
            launched_at=200,
        )
        self.assertEqual(missing.action, "stop")

        stale = supervisor.decide_replacement_loss_progress(
            clean,
            progress_mtime=99,
            signalled_at=100,
            launched_at=200,
        )
        self.assertEqual(stale.action, "stop")

        persisted_stop = supervisor.decide_replacement_loss_progress(
            clean,
            progress_mtime=150,
            signalled_at=100,
            launched_at=200,
        )
        self.assertEqual(persisted_stop.action, "ready")

        new_active = supervisor.decide_replacement_loss_progress(
            observation("running"),
            progress_mtime=201,
            signalled_at=100,
            launched_at=200,
        )
        self.assertEqual(new_active.action, "ready")

    def test_replacement_loss_rejects_new_unsafe_progress(self) -> None:
        invalid = supervisor.ProgressObservation(
            True,
            False,
            "",
            None,
            {},
            1,
        )
        unsafe_values = (
            invalid,
            observation("running", errors={"429": 1}),
            observation("protection"),
            observation("stopped", reason="interrumpido"),
            observation("complete"),
        )
        for unsafe in unsafe_values:
            with self.subTest(observation=unsafe):
                decision = supervisor.decide_replacement_loss_progress(
                    unsafe,
                    progress_mtime=201,
                    signalled_at=100,
                    launched_at=200,
                )
                self.assertEqual(decision.action, "stop")

    def test_three_confirmations_are_consecutive(self) -> None:
        ready = supervisor.RestartDecision("ready", "ok")
        wait = supervisor.RestartDecision("wait", "no")
        count = 0
        for expected in (1, 2):
            count = supervisor.next_margin_confirmation(count, ready)
            self.assertEqual(count, expected)
        count = supervisor.next_margin_confirmation(count, wait)
        self.assertEqual(count, 0)
        for expected in (1, 2, 3):
            count = supervisor.next_margin_confirmation(count, ready)
            self.assertEqual(count, expected)

    def test_stationary_fourth_check_selects_target_or_current(self) -> None:
        target = margin_observation(
            downloading_rows=0,
            quick_check_ok=True,
            fits=True,
        )
        self.assertEqual(
            supervisor.transition_launch_percent(
                target,
                current_percent=18,
                target_percent=20,
            ),
            20,
        )
        retry_current = supervisor.dataclasses.replace(
            target,
            fits=False,
            shortfall_bytes=1,
        )
        self.assertEqual(
            supervisor.transition_launch_percent(
                retry_current,
                current_percent=18,
                target_percent=20,
            ),
            18,
        )
        neither_fits = supervisor.dataclasses.replace(
            retry_current,
            tile_free_bytes=1_061,
            backing_free_bytes=1_061,
            shortfall_bytes=19,
        )
        self.assertIsNone(
            supervisor.transition_launch_percent(
                neither_fits,
                current_percent=18,
                target_percent=20,
            )
        )
        self.assertIsNone(
            supervisor.transition_launch_percent(
                supervisor.dataclasses.replace(
                    target,
                    downloading_rows=1,
                ),
                current_percent=18,
                target_percent=20,
            )
        )
        self.assertIsNone(
            supervisor.transition_launch_percent(
                supervisor.dataclasses.replace(
                    target,
                    configured_percent=19,
                ),
                current_percent=18,
                target_percent=20,
            )
        )

    def test_recovery_rechecks_the_persisted_selected_margin(self) -> None:
        target_does_not_fit = margin_observation(
            downloading_rows=0,
            quick_check_ok=True,
            fits=False,
            shortfall_bytes=18,
        )
        current_still_fits = supervisor.dataclasses.replace(
            target_does_not_fit,
            tile_free_bytes=1_062,
            backing_free_bytes=1_062,
        )
        self.assertTrue(
            supervisor.recovery_selected_percent_is_safe(
                current_still_fits,
                selected_percent=18,
                target_percent=20,
            )
        )
        neither_fits = supervisor.dataclasses.replace(
            current_still_fits,
            tile_free_bytes=1_061,
            backing_free_bytes=1_061,
        )
        self.assertFalse(
            supervisor.recovery_selected_percent_is_safe(
                neither_fits,
                selected_percent=18,
                target_percent=20,
            )
        )
        self.assertFalse(
            supervisor.recovery_selected_percent_is_safe(
                target_does_not_fit,
                selected_percent=20,
                target_percent=20,
            )
        )

    def test_unexpected_restart_requires_exact_current_margin(self) -> None:
        exact = margin_observation(
            configured_percent=18,
            target_percent=18,
            downloading_rows=3,
            quick_check_ok=True,
        )
        self.assertEqual(
            supervisor.decide_restart_storage(
                exact,
                restart_percent=18,
            ).action,
            "ready",
        )

        no_integrity_proof = supervisor.dataclasses.replace(
            exact,
            quick_check_ok=None,
        )
        self.assertEqual(
            supervisor.decide_restart_storage(
                no_integrity_proof,
                restart_percent=18,
            ).action,
            "stop",
        )

        insufficient_backing = supervisor.dataclasses.replace(
            exact,
            backing_free_bytes=1_061,
            fits=False,
            shortfall_bytes=1,
        )
        self.assertEqual(
            supervisor.decide_restart_storage(
                insufficient_backing,
                restart_percent=18,
            ).action,
            "stop",
        )


class MarginObservationTests(unittest.TestCase):
    def _fixture(
        self,
        directory: str,
        *,
        configured_percent: float = 18,
    ) -> tuple[Path, Path, Path, Path]:
        root = Path(directory)
        output = root / "output"
        backing = root / "backing"
        output.mkdir()
        backing.mkdir()
        estimate = output / "estimate.json"
        estimate.write_text(
            json.dumps(
                {
                    "requested": {
                        "dimensions": ["overworld"],
                        "layers": ["base"],
                        "lods": [0],
                    },
                    "plan": {
                        "fallback": False,
                        "space_headroom_percent": configured_percent,
                        "fits": True,
                        "rows": [
                            {
                                "dimension": "overworld",
                                "layer": "base",
                                "lod": 0,
                                "conservative_bytes": 1_000,
                            }
                        ],
                    },
                }
            ),
            encoding="utf-8",
        )
        database = output / "tiles.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute(
                """
                CREATE TABLE tiles(
                    dimension TEXT,
                    layer TEXT,
                    lod INTEGER,
                    status TEXT,
                    size_bytes INTEGER
                )
                """
            )
            connection.executemany(
                "INSERT INTO tiles VALUES (?, ?, ?, ?, ?)",
                [
                    ("overworld", "base", 0, "complete", 100),
                    ("overworld", "base", 0, "downloading", 0),
                    ("nether", "base", 0, "complete", 500),
                ],
            )
            connection.commit()
        finally:
            connection.close()
        return estimate, database, output, backing

    def test_exact_scope_rounding_and_both_volume_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            estimate, database, output, backing = self._fixture(directory)
            frees = {
                output: SimpleNamespace(free=2_000),
                backing: SimpleNamespace(free=1_080),
            }
            with mock.patch.object(
                supervisor.shutil,
                "disk_usage",
                side_effect=lambda path: frees[Path(path)],
            ):
                value = supervisor.read_margin_observation(
                    estimate_path=estimate,
                    database_path=database,
                    output_dir=output,
                    backing_volume=backing,
                    target_percent=20,
                )
            self.assertTrue(value.valid)
            self.assertEqual(value.existing_complete_bytes, 100)
            self.assertEqual(value.conservative_remaining_bytes, 900)
            self.assertEqual(value.required_bytes, 1_080)
            self.assertEqual(value.downloading_rows, 1)
            self.assertTrue(value.fits)

            frees[backing] = SimpleNamespace(free=1_079)
            with mock.patch.object(
                supervisor.shutil,
                "disk_usage",
                side_effect=lambda path: frees[Path(path)],
            ):
                limited = supervisor.read_margin_observation(
                    estimate_path=estimate,
                    database_path=database,
                    output_dir=output,
                    backing_volume=backing,
                    target_percent=20,
                )
            self.assertFalse(limited.fits)
            self.assertEqual(limited.shortfall_bytes, 1)

    def test_stationary_read_runs_sqlite_quick_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            estimate, database, output, backing = self._fixture(directory)
            with mock.patch.object(
                supervisor.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=2_000),
            ):
                value = supervisor.read_margin_observation(
                    estimate_path=estimate,
                    database_path=database,
                    output_dir=output,
                    backing_volume=backing,
                    target_percent=20,
                    require_quick_check=True,
                )
            self.assertTrue(value.valid)
            self.assertTrue(value.quick_check_ok)

    def test_margin_observation_rejects_missing_scope_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            estimate, database, output, backing = self._fixture(directory)
            payload = json.loads(estimate.read_text(encoding="utf-8"))
            payload["requested"]["lods"].append(1)
            estimate.write_text(json.dumps(payload), encoding="utf-8")
            value = supervisor.read_margin_observation(
                estimate_path=estimate,
                database_path=database,
                output_dir=output,
                backing_volume=backing,
                target_percent=20,
            )
            self.assertFalse(value.valid)

    def test_overfull_group_does_not_reduce_another_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            estimate, database, output, backing = self._fixture(directory)
            payload = json.loads(estimate.read_text(encoding="utf-8"))
            payload["requested"]["lods"].append(1)
            payload["plan"]["rows"].append(
                {
                    "dimension": "overworld",
                    "layer": "base",
                    "lod": 1,
                    "conservative_bytes": 1_000,
                }
            )
            estimate.write_text(json.dumps(payload), encoding="utf-8")
            connection = sqlite3.connect(database)
            try:
                connection.execute(
                    "INSERT INTO tiles VALUES (?, ?, ?, ?, ?)",
                    ("overworld", "base", 0, "complete", 1_900),
                )
                connection.commit()
            finally:
                connection.close()
            with mock.patch.object(
                supervisor.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=2_000),
            ):
                value = supervisor.read_margin_observation(
                    estimate_path=estimate,
                    database_path=database,
                    output_dir=output,
                    backing_volume=backing,
                    target_percent=20,
                )
            self.assertTrue(value.valid)
            self.assertEqual(value.conservative_total_bytes, 2_000)
            self.assertEqual(value.existing_complete_bytes, 2_000)
            self.assertEqual(value.conservative_remaining_bytes, 1_000)
            self.assertEqual(value.required_bytes, 1_200)

    def test_estimate_proof_requires_new_full_fitting_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            estimate, _, _, _ = self._fixture(
                directory,
                configured_percent=20,
            )
            timestamp = estimate.stat().st_mtime
            self.assertTrue(
                supervisor.estimate_proves_headroom(
                    estimate,
                    written_after=timestamp,
                    target_percent=20,
                )
            )
            self.assertFalse(
                supervisor.estimate_proves_headroom(
                    estimate,
                    written_after=timestamp + 1,
                    target_percent=20,
                )
            )
            payload = json.loads(estimate.read_text(encoding="utf-8"))
            payload["plan"]["fallback"] = True
            estimate.write_text(json.dumps(payload), encoding="utf-8")
            os.utime(estimate, (timestamp + 2, timestamp + 2))
            self.assertFalse(
                supervisor.estimate_proves_headroom(
                    estimate,
                    written_after=timestamp + 1,
                    target_percent=20,
                )
            )


class LockTests(unittest.TestCase):
    def test_download_lock_can_be_adopted_by_same_pid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / ".download.lock"
            self.assertTrue(supervisor.ensure_download_lock(lock, 12345))
            self.assertTrue(supervisor.ensure_download_lock(lock, 12345))
            self.assertEqual(supervisor.owner_pid(lock), 12345)


class TransitionJournalTests(unittest.TestCase):
    def test_prepared_journal_can_be_durably_cancelled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "margin_transition.json"
            path.write_text("{}\n", encoding="utf-8")
            self.assertTrue(supervisor.remove_transition_journal(path))
            self.assertFalse(path.exists())
            self.assertTrue(supervisor.remove_transition_journal(path))

    def test_transition_journal_round_trips_atomically(self) -> None:
        identity = supervisor.ProcessIdentity(
            pid=123,
            started_at="Fri Jul 24 19:00:00 2026",
            arguments="python download_all_2b2t.py --all",
            headroom_percent=18,
        )
        journal = supervisor.TransitionJournal(
            phase="stopped_clean",
            old_identity=identity,
            current_percent=18,
            target_percent=20,
            signalled_at=100,
            selected_percent=20,
            launch_started_at=101,
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transition.json"
            self.assertTrue(
                supervisor.write_transition_journal(path, journal)
            )
            self.assertEqual(
                supervisor.read_transition_journal(path),
                journal,
            )
            valid_payload = json.loads(path.read_text(encoding="utf-8"))
            invalid_payloads = []
            invalid_phase = dict(valid_payload)
            invalid_phase["phase"] = "unknown"
            invalid_payloads.append(invalid_phase)
            wrong_current = json.loads(json.dumps(valid_payload))
            wrong_current["current_percent"] = 19
            invalid_payloads.append(wrong_current)
            wrong_identity = json.loads(json.dumps(valid_payload))
            wrong_identity["old_identity"]["headroom_percent"] = 17
            invalid_payloads.append(wrong_identity)
            early_launch = json.loads(json.dumps(valid_payload))
            early_launch["launch_started_at"] = 99
            invalid_payloads.append(early_launch)
            prepared_with_selection = json.loads(json.dumps(valid_payload))
            prepared_with_selection["phase"] = "prepared"
            invalid_payloads.append(prepared_with_selection)
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    path.write_text(json.dumps(payload), encoding="utf-8")
                    self.assertIsNone(
                        supervisor.read_transition_journal(path)
                    )


class ProcessDetectionTests(unittest.TestCase):
    def test_only_exact_python_download_is_selected(self) -> None:
        project = Path("/tmp/obsidian atlas")
        script = project / "download_all_2b2t.py"
        output = Path("/Volumes/2b2t Tiles/2b2t_tiles")
        command = (
            f"{script.resolve()} --all --out {output.resolve()} --resume"
        )
        ps_output = "\n".join(
            (
                f"101 /usr/local/bin/python3 {command}",
                f"102 caffeinate -im /usr/local/bin/python3 {command}",
                f"103 /usr/local/bin/python3 {script} --out /tmp/other",
            )
        )
        completed = CompletedProcess(
            args=["ps"],
            returncode=0,
            stdout=ps_output,
            stderr="",
        )
        with mock.patch.object(
            supervisor.subprocess,
            "run",
            return_value=completed,
        ):
            self.assertEqual(
                supervisor.find_download_processes(script, output),
                [101],
            )

    def test_process_identity_requires_canonical_full_scope(self) -> None:
        project = Path("/tmp/obsidian atlas")
        script = project / "download_all_2b2t.py"
        output = Path("/Volumes/2b2t Tiles/2b2t_tiles")
        arguments = (
            f"/usr/local/bin/python3 {script.resolve()} --all "
            "--dimensions overworld,nether,end "
            "--layers base,overlay,newchunks --lods all "
            f"--out {output.resolve()} --space-headroom-percent 18 "
            "--resume --skip-smoke-test --no-fallback"
        )
        completed = CompletedProcess(
            args=["ps"],
            returncode=0,
            stdout=f"Fri Jul 24 19:00:00 2026 {arguments}\n",
            stderr="",
        )
        with mock.patch.object(
            supervisor.subprocess,
            "run",
            return_value=completed,
        ):
            identity = supervisor.read_process_identity(101, script, output)
        self.assertIsNotNone(identity)
        assert identity is not None
        self.assertEqual(identity.headroom_percent, 18)
        self.assertEqual(identity.started_at, "Fri Jul 24 19:00:00 2026")

        incomplete = CompletedProcess(
            args=["ps"],
            returncode=0,
            stdout=(
                "Fri Jul 24 19:00:00 2026 "
                + arguments.replace("--no-fallback", "")
                + "\n"
            ),
            stderr="",
        )
        with mock.patch.object(
            supervisor.subprocess,
            "run",
            return_value=incomplete,
        ):
            self.assertIsNone(
                supervisor.read_process_identity(101, script, output)
            )

        innocent_arguments = arguments.replace(
            str(script.resolve()),
            f"/tmp/innocent.py --note {script.resolve()}",
            1,
        )
        duplicate_arguments = (
            arguments + " --out /tmp/other --space-headroom-percent 20"
        )
        missing_skip_arguments = arguments.replace(
            "--skip-smoke-test",
            "",
        )
        for unsafe_arguments in (
            innocent_arguments,
            duplicate_arguments,
            missing_skip_arguments,
            arguments + " --estimate-only",
            arguments + " --smoke-test-only",
        ):
            with self.subTest(arguments=unsafe_arguments):
                unsafe = CompletedProcess(
                    args=["ps"],
                    returncode=0,
                    stdout=(
                        "Fri Jul 24 19:00:00 2026 "
                        f"{unsafe_arguments}\n"
                    ),
                    stderr="",
                )
                with mock.patch.object(
                    supervisor.subprocess,
                    "run",
                    return_value=unsafe,
                ):
                    self.assertIsNone(
                        supervisor.read_process_identity(
                            101,
                            script,
                            output,
                        )
                    )


if __name__ == "__main__":
    unittest.main()
