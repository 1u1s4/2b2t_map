from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
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


class RestartDecisionTests(unittest.TestCase):
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


class LockTests(unittest.TestCase):
    def test_download_lock_can_be_adopted_by_same_pid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / ".download.lock"
            self.assertTrue(supervisor.ensure_download_lock(lock, 12345))
            self.assertTrue(supervisor.ensure_download_lock(lock, 12345))
            self.assertEqual(supervisor.owner_pid(lock), 12345)


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


if __name__ == "__main__":
    unittest.main()
