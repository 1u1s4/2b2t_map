from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import plistlib
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import resume_after_login_luisa as resume
import supervise_full_download_luisa as supervisor


BACKING_UUID = "11111111-1111-4111-8111-111111111111"
MAP_UUID = "22222222-2222-4222-8222-222222222222"


def make_config(root: Path) -> resume.RuntimeConfig:
    project = root / "project"
    backing = root / "LuisA"
    map_volume = root / "Tiles"
    output = map_volume / "2b2t_tiles"
    image = backing / "2b2t_map/2b2t_tiles.sparsebundle"
    vendor = root / "Application Support/ObsidianAtlas/py311-packages"
    project.mkdir(parents=True)
    output.mkdir(parents=True)
    image.mkdir(parents=True)
    vendor.mkdir(parents=True)
    return resume.RuntimeConfig(
        project_dir=project.resolve(),
        output_dir=output.resolve(),
        backing_volume=backing.resolve(),
        map_volume=map_volume.resolve(),
        image_path=image.resolve(),
        intent_path=(root / "state/recovery_intent.json").resolve(),
        vendor_pythonpath=vendor.resolve(),
        maximum_heartbeat_age=60.0,
        startup_timeout=5.0,
    )


def make_intent(
    config: resume.RuntimeConfig,
    *,
    state: str = "armed",
    armed_boot_id: str = "macos:100.000001",
    adopted_boot_id: str | None = None,
    headroom: float = 18.0,
    attempts: tuple[resume.RestartAttempt, ...] = (),
) -> resume.RecoveryIntent:
    adopted_at = 110.0 if state == "adopted" else None
    bound_identity = process_identity(config, percent=headroom)
    return resume.RecoveryIntent(
        state=state,
        armed_at_epoch=100.0,
        armed_boot_id=armed_boot_id,
        adopted_at_epoch=adopted_at,
        adopted_boot_id=(
            adopted_boot_id if state == "adopted" else None
        ),
        project_dir=resume.canonical_path(config.project_dir),
        output_dir=resume.canonical_path(config.output_dir),
        backing_volume=resume.canonical_path(config.backing_volume),
        map_volume=resume.canonical_path(config.map_volume),
        image_path=resume.canonical_path(config.image_path),
        backing_volume_uuid=BACKING_UUID,
        map_volume_uuid=MAP_UUID,
        dimensions=resume.CANONICAL_DIMENSIONS,
        layers=resume.CANONICAL_LAYERS,
        lods=resume.CANONICAL_LODS,
        configured_headroom_percent=headroom,
        bound_process_pid=bound_identity.pid,
        bound_process_started_at=bound_identity.started_at,
        bound_process_arguments_sha256=(
            resume.process_arguments_sha256(bound_identity)
        ),
        progress_mtime_ns_floor=1_000,
        estimate_sha256="a" * 64,
        restart_attempts=attempts,
    )


def active_progress(
    *,
    status: str = "running",
    reason: str | None = None,
    errors: dict[str, int] | None = None,
    age: float = 1.0,
) -> supervisor.ProgressObservation:
    return supervisor.ProgressObservation(
        exists=True,
        valid=True,
        status=status,
        reason=reason,
        http_errors={} if errors is None else errors,
        age_seconds=age,
    )


def process_identity(
    config: resume.RuntimeConfig,
    *,
    pid: int = 123,
    percent: float = 18.0,
) -> supervisor.ProcessIdentity:
    arguments = (
        f"/usr/bin/python3 {config.downloader_path} --all "
        "--dimensions overworld,nether,end "
        "--layers base,overlay,newchunks --lods all "
        f"--out {config.output_dir} "
        f"--space-headroom-percent {percent:g} "
        "--resume --skip-smoke-test --no-fallback"
    )
    return supervisor.ProcessIdentity(
        pid=pid,
        started_at="Fri Jul 24 19:18:27 2026",
        arguments=arguments,
        headroom_percent=percent,
    )


def supervisor_identity(pid: int = 456) -> resume.SupervisorIdentity:
    return resume.SupervisorIdentity(
        pid=pid,
        started_at="Fri Jul 24 21:55:04 2026",
        arguments="/usr/bin/python3 supervise_full_download_luisa.py",
    )


def make_snapshot(
    config: resume.RuntimeConfig,
    *,
    intent: resume.RecoveryIntent | None = None,
    intent_error: str | None = None,
    intent_exists: bool = True,
    boot_id: str = "macos:200.000002",
    now: float = 1_000.0,
    progress: supervisor.ProgressObservation | None = None,
    progress_mtime_ns: int | None = 2_000,
    estimate_sha256: str | None = "a" * 64,
    plan: resume.PlanEvidence | None = None,
    downloaders: tuple[supervisor.ProcessIdentity, ...] = (),
    invalid_downloaders: tuple[int, ...] = (),
    lock_owner: int | None = None,
    supervisors: tuple[resume.SupervisorIdentity, ...] = (),
    invalid_supervisors: tuple[int, ...] = (),
    backing_mounted: bool = True,
    backing_uuid: str | None = BACKING_UUID,
    map_mounted: bool = True,
    map_uuid: str | None = MAP_UUID,
    image_exists: bool = True,
    storage_stop: bool = False,
    transition: bool = False,
    supervisor_tool: bool = True,
    launcher_tool: bool = True,
) -> resume.RecoverySnapshot:
    if intent is None and intent_error is None and intent_exists:
        intent = make_intent(config)
    if progress is None:
        progress = active_progress()
    if plan is None:
        plan = resume.PlanEvidence(
            valid=True,
            reason="ok",
            configured_headroom_percent=(
                intent.configured_headroom_percent
                if intent is not None
                else 18.0
            ),
            full_scope=True,
            fits_configured=True,
            quick_check_ok=True,
        )
    return resume.RecoverySnapshot(
        now_epoch=now,
        boot_id=boot_id,
        intent_load=resume.IntentLoad(
            exists=intent_exists,
            intent=intent,
            error=intent_error,
        ),
        backing_volume=resume.VolumeObservation(
            mount_point=str(config.backing_volume),
            mounted=backing_mounted,
            volume_uuid=backing_uuid,
            reason="test",
        ),
        map_volume=resume.VolumeObservation(
            mount_point=str(config.map_volume),
            mounted=map_mounted,
            volume_uuid=map_uuid,
            reason="test",
        ),
        image_exists=image_exists,
        progress=progress,
        progress_mtime_ns=progress_mtime_ns,
        estimate_sha256=estimate_sha256,
        plan=plan,
        downloader_identities=downloaders,
        invalid_downloader_pids=invalid_downloaders,
        download_lock_owner=lock_owner,
        supervisor_identities=supervisors,
        invalid_supervisor_pids=invalid_supervisors,
        storage_stop_exists=storage_stop,
        margin_transition_exists=transition,
        supervisor_tool_available=supervisor_tool,
        launcher_tool_available=launcher_tool,
    )


class MacIdentityTests(unittest.TestCase):
    def test_boot_id_uses_macos_boot_time_and_is_injectable(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv: list[str], **_kwargs: object) -> object:
            calls.append(argv)
            return SimpleNamespace(
                stdout="{ sec = 1721810000, usec = 42 } Wed Jul 24"
            )

        self.assertEqual(
            resume.read_macos_boot_id(run_command=fake_run),
            "macos:1721810000.000042",
        )
        self.assertEqual(
            calls,
            [["/usr/sbin/sysctl", "-n", "kern.boottime"]],
        )

    def test_boot_id_fails_closed_on_unknown_format(self) -> None:
        def fake_run(_argv: list[str], **_kwargs: object) -> object:
            return SimpleNamespace(stdout="yesterday")

        with self.assertRaisesRegex(RuntimeError, "formato esperado"):
            resume.read_macos_boot_id(run_command=fake_run)

    def test_volume_uuid_comes_from_diskutil_plist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)

            def fake_run(argv: list[str], **_kwargs: object) -> object:
                self.assertEqual(
                    argv[:3],
                    ["/usr/sbin/diskutil", "info", "-plist"],
                )
                return SimpleNamespace(
                    stdout=plistlib.dumps({"VolumeUUID": BACKING_UUID})
                )

            observed = resume.read_volume_observation(
                mount,
                is_mount=lambda _path: True,
                run_command=fake_run,
            )
            self.assertTrue(observed.mounted)
            self.assertEqual(observed.volume_uuid, BACKING_UUID)


class DurableIntentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_atomic_round_trip_has_full_scope_uuids_and_mode_600(self) -> None:
        intent = make_intent(self.config, headroom=20.5)
        with mock.patch.object(
            resume.os,
            "fsync",
            wraps=os.fsync,
        ) as fsync:
            resume.write_intent(self.config.intent_path, intent)
        loaded = resume.read_intent(self.config.intent_path)
        self.assertEqual(loaded.intent, intent)
        self.assertIsNone(loaded.error)
        self.assertGreaterEqual(fsync.call_count, 2)
        mode = stat.S_IMODE(self.config.intent_path.stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_atomic_failure_leaves_no_target_or_temporary(self) -> None:
        with mock.patch.object(
            resume.os,
            "replace",
            side_effect=OSError("simulated"),
        ):
            with self.assertRaises(resume.DurableWriteError):
                resume.write_intent(
                    self.config.intent_path,
                    make_intent(self.config),
                )
        self.assertFalse(self.config.intent_path.exists())
        self.assertEqual(
            list(self.config.intent_path.parent.glob("*.tmp")),
            [],
        )

    def test_intent_rejects_commands_even_if_other_fields_are_valid(self) -> None:
        payload = resume._intent_payload(make_intent(self.config))
        payload["argv"] = ["/bin/rm", "-rf", "/"]
        with self.assertRaisesRegex(ValueError, "no puede contener comandos"):
            resume.parse_intent_payload(payload)

    def test_intent_rejects_narrow_or_reordered_scope(self) -> None:
        payload = resume._intent_payload(make_intent(self.config))
        scope = dict(payload["scope"])  # type: ignore[arg-type]
        scope["dimensions"] = ["overworld"]
        payload["scope"] = scope
        with self.assertRaisesRegex(ValueError, "mapa completo"):
            resume.parse_intent_payload(payload)

        payload = resume._intent_payload(make_intent(self.config))
        scope = dict(payload["scope"])  # type: ignore[arg-type]
        scope["layers"] = ["overlay", "base", "newchunks"]
        payload["scope"] = scope
        with self.assertRaisesRegex(ValueError, "mapa completo"):
            resume.parse_intent_payload(payload)

    def test_only_exact_18_or_at_least_20_is_accepted(self) -> None:
        self.assertTrue(resume.allowed_headroom_percent(18.0))
        self.assertFalse(resume.allowed_headroom_percent(18.0 - 5e-10))
        self.assertFalse(resume.allowed_headroom_percent(18.0 + 5e-10))
        self.assertFalse(resume.allowed_headroom_percent(18.1))
        self.assertFalse(resume.allowed_headroom_percent(19.999))
        self.assertTrue(resume.allowed_headroom_percent(20.0))
        self.assertTrue(resume.allowed_headroom_percent(20.5))
        self.assertFalse(resume.same_number(17.9999999995, 18.0))
        self.assertFalse(resume.same_number(19.9999999995, 20.0))

        payload = resume._intent_payload(make_intent(self.config))
        payload["configured_headroom_percent"] = 19
        with self.assertRaisesRegex(ValueError, "18 exacto"):
            resume.parse_intent_payload(payload)

    def test_intent_rejects_noncanonical_boot_and_huge_numbers(self) -> None:
        payload = resume._intent_payload(make_intent(self.config))
        payload["armed_boot_id"] = "x"
        with self.assertRaisesRegex(ValueError, "armado/adopción"):
            resume.parse_intent_payload(payload)

        payload = resume._intent_payload(make_intent(self.config))
        payload["armed_at_epoch"] = 10**400
        with self.assertRaisesRegex(ValueError, "armado/adopción"):
            resume.parse_intent_payload(payload)

        payload = resume._intent_payload(make_intent(self.config))
        payload["configured_headroom_percent"] = 10**400
        with self.assertRaisesRegex(ValueError, "reserva configurada"):
            resume.parse_intent_payload(payload)

    def test_symlink_intent_is_not_followed(self) -> None:
        other = self.root / "other.json"
        other.write_text("{}")
        self.config.intent_path.parent.mkdir(parents=True)
        self.config.intent_path.symlink_to(other)
        loaded = resume.read_intent(self.config.intent_path)
        self.assertIsNone(loaded.intent)
        self.assertIn("archivo regular", loaded.error or "")

    def test_restart_budget_survives_json_round_trip(self) -> None:
        attempts = (
            resume.RestartAttempt(
                at_epoch=900.0,
                boot_id="macos:200.000002",
                action="launch_stack",
            ),
            resume.RestartAttempt(
                at_epoch=950.0,
                boot_id="macos:200.000002",
                action="launch_transition_supervisor",
            ),
        )
        intent = make_intent(self.config, attempts=attempts)
        resume.write_intent(self.config.intent_path, intent)
        self.assertEqual(
            resume.read_intent(self.config.intent_path).intent,
            intent,
        )

    def test_clock_rollback_cannot_prune_or_reorder_budget(self) -> None:
        future = resume.RestartAttempt(
            at_epoch=1_001.0,
            boot_id="macos:200.000002",
            action="launch_stack",
        )
        intent = make_intent(self.config, attempts=(future,))
        with self.assertRaisesRegex(ValueError, "futuro"):
            resume.adopt_intent(
                intent,
                boot_id="macos:200.000002",
                now_epoch=1_000.0,
            )
        with self.assertRaisesRegex(ValueError, "futuro"):
            resume.claim_restart_attempt(
                intent,
                resume.RecoveryDecision(
                    "launch_stack",
                    "test",
                    requires_execute=True,
                    consumes_restart_budget=True,
                ),
                boot_id="macos:200.000002",
                now_epoch=1_000.0,
            )

    def test_required_bytes_supports_non_integer_percent(self) -> None:
        self.assertEqual(
            resume.required_bytes_for_percent(100, 20.5),
            121,
        )


class PureRecoveryDecisionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def decide(self, **changes: object) -> resume.RecoveryDecision:
        return resume.decide_recovery(
            make_snapshot(self.config, **changes),
            self.config,
        )

    def test_storage_stop_dominates_every_other_state(self) -> None:
        decision = self.decide(
            storage_stop=True,
            transition=True,
            supervisors=(supervisor_identity(),),
            progress=active_progress(status="complete"),
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("domina", decision.reason)

    def test_missing_or_invalid_intent_never_recovers(self) -> None:
        self.assertEqual(
            self.decide(intent_exists=False).action,
            "stop",
        )
        invalid = self.decide(intent=None, intent_error="bad")
        self.assertEqual(invalid.action, "stop")
        self.assertIn("bad", invalid.reason)

    def test_backing_volume_waits_and_wrong_uuid_stops(self) -> None:
        denied = self.decide(
            backing_mounted=False,
            backing_uuid=None,
            image_exists=False,
        )
        self.assertEqual(denied.action, "wait")
        self.assertIn("LuisA", denied.reason)

        wrong = self.decide(
            backing_uuid="33333333-3333-4333-8333-333333333333"
        )
        self.assertEqual(wrong.action, "stop")
        self.assertIn("UUID de LuisA", wrong.reason)

    def test_unmounted_tiles_only_exposes_fixed_attach(self) -> None:
        decision = self.decide(
            map_mounted=False,
            map_uuid=None,
        )
        self.assertEqual(decision.action, "attach_tiles")
        self.assertTrue(decision.requires_execute)
        self.assertFalse(decision.consumes_restart_budget)

    def test_wrong_tile_uuid_stops(self) -> None:
        decision = self.decide(
            map_uuid="33333333-3333-4333-8333-333333333333"
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("UUID del volumen", decision.reason)

    def test_transition_is_always_supervisor_only(self) -> None:
        decision = self.decide(
            transition=True,
            progress=active_progress(
                status="stopped",
                reason="interrumpido",
            ),
        )
        self.assertEqual(
            decision.action,
            "launch_transition_supervisor",
        )
        self.assertTrue(decision.consumes_restart_budget)
        self.assertNotEqual(decision.action, "launch_stack")

        adopted = self.decide(
            transition=True,
            progress=active_progress(status="stopped"),
            supervisors=(supervisor_identity(),),
        )
        self.assertEqual(adopted.action, "adopt_existing")

    def test_transition_adoption_never_rebinds_downloader(self) -> None:
        intent = make_intent(self.config, headroom=20.0)
        unsafe = process_identity(self.config, pid=321, percent=18.0)
        snapshot = make_snapshot(
            self.config,
            intent=intent,
            transition=True,
            supervisors=(supervisor_identity(),),
            downloaders=(unsafe,),
            lock_owner=999,
            plan=resume.PlanEvidence(
                True, "ok", 18.0, True, True, None
            ),
            estimate_sha256="b" * 64,
        )
        decision = resume.decide_recovery(snapshot, self.config)
        self.assertEqual(decision.action, "adopt_existing")
        adopted = resume.adopt_intent(
            intent,
            boot_id=snapshot.boot_id,
            now_epoch=snapshot.now_epoch,
            snapshot=snapshot,
            refresh_binding=False,
        )
        self.assertEqual(adopted.configured_headroom_percent, 20.0)
        self.assertEqual(
            adopted.bound_process_pid,
            intent.bound_process_pid,
        )
        self.assertEqual(adopted.estimate_sha256, intent.estimate_sha256)

    def test_transition_waits_if_supervisor_source_is_inaccessible(self) -> None:
        decision = self.decide(
            transition=True,
            supervisor_tool=False,
        )
        self.assertEqual(decision.action, "wait")
        self.assertIn("no está accesible", decision.reason)

    def test_status_gates_complete_terminal_and_safety(self) -> None:
        complete = self.decide(progress=active_progress(status="complete"))
        self.assertEqual(complete.action, "complete")

        stopped = self.decide(progress=active_progress(status="stopped"))
        self.assertEqual(stopped.action, "stop")

        protected = self.decide(
            progress=active_progress(errors={"429": 1})
        )
        self.assertEqual(protected.action, "stop")
        self.assertIn("429", protected.reason)

    def test_plan_must_be_full_valid_and_match_intent(self) -> None:
        invalid = self.decide(
            plan=resume.PlanEvidence(
                valid=False,
                reason="alcance reducido",
                configured_headroom_percent=18.0,
                full_scope=False,
                fits_configured=False,
                quick_check_ok=None,
            )
        )
        self.assertEqual(invalid.action, "stop")
        self.assertIn("reducido", invalid.reason)

        mismatch = self.decide(
            plan=resume.PlanEvidence(
                valid=True,
                reason="ok",
                configured_headroom_percent=20.0,
                full_scope=True,
                fits_configured=True,
                quick_check_ok=True,
            )
        )
        self.assertEqual(mismatch.action, "stop")
        self.assertIn("reserva armada", mismatch.reason)

    def test_invalid_or_duplicate_processes_stop(self) -> None:
        self.assertEqual(
            self.decide(invalid_downloaders=(99,)).action,
            "stop",
        )
        first = process_identity(self.config, pid=1)
        second = process_identity(self.config, pid=2)
        self.assertEqual(
            self.decide(downloaders=(first, second)).action,
            "stop",
        )
        self.assertEqual(
            self.decide(invalid_supervisors=(88,)).action,
            "stop",
        )

    def test_existing_stack_is_adopted_without_pid_change(self) -> None:
        downloader = process_identity(self.config)
        decision = self.decide(
            downloaders=(downloader,),
            lock_owner=downloader.pid,
            supervisors=(supervisor_identity(),),
        )
        self.assertEqual(decision.action, "adopt_existing")
        self.assertTrue(decision.may_adopt)
        self.assertFalse(decision.requires_execute)
        self.assertEqual(downloader.pid, 123)

    def test_live_downloader_routes_to_supervisor_without_restart(self) -> None:
        downloader = process_identity(self.config)
        decision = self.decide(
            downloaders=(downloader,),
            lock_owner=downloader.pid,
        )
        self.assertEqual(decision.action, "launch_supervisor")
        self.assertTrue(decision.requires_execute)
        self.assertFalse(decision.consumes_restart_budget)

    def test_live_downloader_requires_fresh_heartbeat(self) -> None:
        downloader = process_identity(self.config)
        decision = self.decide(
            downloaders=(downloader,),
            lock_owner=downloader.pid,
            supervisors=(supervisor_identity(),),
            progress=active_progress(age=61.0),
        )
        self.assertEqual(decision.action, "wait")
        self.assertIn("heartbeat", decision.reason)

    def test_safe_live_stack_refreshes_18_to_20_binding(self) -> None:
        intent = make_intent(self.config, headroom=18.0)
        replacement = process_identity(
            self.config,
            pid=321,
            percent=20.0,
        )
        snapshot = make_snapshot(
            self.config,
            intent=intent,
            plan=resume.PlanEvidence(
                valid=True,
                reason="ok",
                configured_headroom_percent=20.0,
                full_scope=True,
                fits_configured=True,
                quick_check_ok=None,
            ),
            downloaders=(replacement,),
            lock_owner=replacement.pid,
            supervisors=(supervisor_identity(),),
            progress_mtime_ns=3_000,
            estimate_sha256="b" * 64,
        )
        decision = resume.decide_recovery(snapshot, self.config)
        self.assertEqual(decision.action, "refresh_binding")
        self.assertTrue(decision.may_adopt)
        self.assertFalse(decision.consumes_restart_budget)

        refreshed = resume.adopt_intent(
            intent,
            boot_id=snapshot.boot_id,
            now_epoch=snapshot.now_epoch,
            snapshot=snapshot,
            refresh_binding=True,
        )
        self.assertEqual(refreshed.configured_headroom_percent, 20.0)
        self.assertEqual(refreshed.bound_process_pid, 321)
        self.assertEqual(refreshed.progress_mtime_ns_floor, 3_000)
        self.assertEqual(refreshed.estimate_sha256, "b" * 64)
        self.assertEqual(refreshed.restart_attempts, ())

    def test_margin_change_without_complete_live_stack_stops(self) -> None:
        replacement = process_identity(
            self.config,
            pid=321,
            percent=20.0,
        )
        decision = self.decide(
            plan=resume.PlanEvidence(
                valid=True,
                reason="ok",
                configured_headroom_percent=20.0,
                full_scope=True,
                fits_configured=True,
                quick_check_ok=None,
            ),
            downloaders=(replacement,),
            lock_owner=replacement.pid,
            supervisors=(),
            estimate_sha256="b" * 64,
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("reserva armada", decision.reason)

    def test_refresh_never_downgrades_or_regresses_progress_floor(self) -> None:
        intent20 = make_intent(self.config, headroom=20.0)
        process18 = process_identity(self.config, pid=321, percent=18.0)
        downgrade = self.decide(
            intent=intent20,
            plan=resume.PlanEvidence(
                True, "ok", 18.0, True, True, None
            ),
            downloaders=(process18,),
            lock_owner=process18.pid,
            supervisors=(supervisor_identity(),),
            estimate_sha256="b" * 64,
        )
        self.assertEqual(downgrade.action, "stop")

        intent18 = dataclasses.replace(
            make_intent(self.config, headroom=18.0),
            progress_mtime_ns_floor=3_000,
        )
        process20 = process_identity(self.config, pid=321, percent=20.0)
        regressive = self.decide(
            intent=intent18,
            plan=resume.PlanEvidence(
                True, "ok", 20.0, True, True, None
            ),
            downloaders=(process20,),
            lock_owner=process20.pid,
            supervisors=(supervisor_identity(),),
            progress_mtime_ns=2_000,
            estimate_sha256="b" * 64,
        )
        self.assertEqual(regressive.action, "stop")

    def test_live_downloader_headroom_and_lock_must_match(self) -> None:
        downloader = process_identity(self.config, percent=20.0)
        self.assertEqual(
            self.decide(
                downloaders=(downloader,),
                lock_owner=downloader.pid,
            ).action,
            "stop",
        )
        downloader = process_identity(self.config)
        decision = self.decide(
            downloaders=(downloader,),
            lock_owner=999,
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("lock", decision.reason)

    def test_same_boot_unbound_pid_is_not_silently_adopted(self) -> None:
        intent = make_intent(
            self.config,
            armed_boot_id="macos:200.000002",
        )
        different = process_identity(self.config, pid=321)
        decision = self.decide(
            intent=intent,
            downloaders=(different,),
            lock_owner=different.pid,
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("identidad viva", decision.reason)
        supervised = self.decide(
            intent=intent,
            downloaders=(different,),
            lock_owner=different.pid,
            supervisors=(supervisor_identity(),),
        )
        self.assertEqual(supervised.action, "stop")

    def test_reboot_with_stationary_database_exposes_stack_launch(self) -> None:
        decision = self.decide()
        self.assertEqual(decision.action, "launch_stack")
        self.assertTrue(decision.requires_execute)
        self.assertTrue(decision.consumes_restart_budget)

    def test_adopted_stack_can_recover_when_absent_in_same_boot(self) -> None:
        intent = make_intent(
            self.config,
            state="adopted",
            adopted_boot_id="macos:200.000002",
        )
        decision = self.decide(intent=intent)
        self.assertEqual(decision.action, "launch_stack")
        self.assertTrue(decision.consumes_restart_budget)

    def test_adopted_same_boot_recovery_still_respects_budget(self) -> None:
        attempts = tuple(
            resume.RestartAttempt(
                at_epoch=900.0 + index,
                boot_id="macos:200.000002",
                action="launch_stack",
            )
            for index in range(resume.MAX_RESTARTS)
        )
        intent = make_intent(
            self.config,
            state="adopted",
            adopted_boot_id="macos:200.000002",
            attempts=attempts,
        )
        decision = self.decide(intent=intent)
        self.assertEqual(decision.action, "stop")
        self.assertIn("presupuesto", decision.reason)

    def test_interrupted_stop_is_resumable_only_after_real_reboot(
        self,
    ) -> None:
        interrupted = active_progress(
            status="stopped",
            reason="interrumpido",
        )
        after_reboot = self.decide(progress=interrupted)
        self.assertEqual(after_reboot.action, "launch_stack")
        self.assertTrue(after_reboot.consumes_restart_budget)

        same_boot_intent = make_intent(
            self.config,
            armed_boot_id="macos:200.000002",
        )
        same_boot = self.decide(
            intent=same_boot_intent,
            progress=interrupted,
        )
        self.assertEqual(same_boot.action, "stop")

        adopted_this_boot = make_intent(
            self.config,
            state="adopted",
            adopted_boot_id="macos:200.000002",
        )
        manual_after_adoption = self.decide(
            intent=adopted_this_boot,
            progress=interrupted,
        )
        self.assertEqual(manual_after_adoption.action, "stop")

        protected = self.decide(
            progress=active_progress(
                status="stopped",
                reason="interrumpido",
                errors={"429": 1},
            ),
        )
        self.assertEqual(protected.action, "stop")

    def test_same_boot_without_coordinator_attempt_waits(self) -> None:
        intent = make_intent(
            self.config,
            armed_boot_id="macos:200.000002",
        )
        decision = self.decide(intent=intent)
        self.assertEqual(decision.action, "wait")
        self.assertIn("reboot", decision.reason)

    def test_same_boot_can_retry_only_after_durable_attempt(self) -> None:
        intent = make_intent(
            self.config,
            armed_boot_id="macos:200.000002",
            attempts=(
                resume.RestartAttempt(
                    at_epoch=900.0,
                    boot_id="macos:200.000002",
                    action="launch_stack",
                ),
            ),
        )
        decision = self.decide(intent=intent)
        self.assertEqual(decision.action, "launch_stack")

    def test_budget_stops_fourth_restart_in_24_hours(self) -> None:
        attempts = tuple(
            resume.RestartAttempt(
                at_epoch=900.0 + index,
                boot_id="macos:200.000002",
                action="launch_stack",
            )
            for index in range(3)
        )
        decision = self.decide(
            intent=make_intent(self.config, attempts=attempts)
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("3 reinicios", decision.reason)

    def test_future_budget_timestamp_fails_closed(self) -> None:
        attempt = resume.RestartAttempt(
            at_epoch=2_000.0,
            boot_id="macos:200.000002",
            action="launch_stack",
        )
        decision = self.decide(
            intent=make_intent(self.config, attempts=(attempt,))
        )
        self.assertEqual(decision.action, "stop")
        self.assertIn("futuro", decision.reason)

    def test_bound_artifacts_cannot_move_backwards_or_change_idle(self) -> None:
        older = self.decide(progress_mtime_ns=999)
        self.assertEqual(older.action, "stop")
        self.assertIn("piso", older.reason)

        changed = self.decide(estimate_sha256="b" * 64)
        self.assertEqual(changed.action, "stop")
        self.assertIn("cambió", changed.reason)

    def test_quick_check_and_tool_access_gate_stack_launch(self) -> None:
        no_check = self.decide(
            plan=resume.PlanEvidence(
                valid=True,
                reason="ok",
                configured_headroom_percent=18.0,
                full_scope=True,
                fits_configured=True,
                quick_check_ok=None,
            )
        )
        self.assertEqual(no_check.action, "stop")
        self.assertIn("quick_check", no_check.reason)

        denied = self.decide(launcher_tool=False)
        self.assertEqual(denied.action, "wait")
        self.assertIn("no están accesibles", denied.reason)

    def test_intent_paths_cannot_redirect_execution(self) -> None:
        intent = dataclasses.replace(
            make_intent(self.config),
            project_dir="/tmp/evil",
        )
        decision = self.decide(intent=intent)
        self.assertEqual(decision.action, "stop")
        self.assertIn("configuración local fija", decision.reason)


class ArmDecisionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)
        self.downloader = process_identity(self.config)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def snapshot(self, **changes: object) -> resume.RecoverySnapshot:
        values: dict[str, object] = {
            "downloaders": (self.downloader,),
            "lock_owner": self.downloader.pid,
        }
        values.update(changes)
        return make_snapshot(self.config, **values)

    def test_arm_requires_live_canonical_fresh_full_download(self) -> None:
        snapshot = self.snapshot()
        decision = resume.decide_arm(snapshot, self.config)
        self.assertEqual(decision.action, "arm")
        intent = resume.build_armed_intent(snapshot, self.config)
        self.assertEqual(intent.state, "armed")
        self.assertEqual(intent.dimensions, resume.CANONICAL_DIMENSIONS)
        self.assertEqual(intent.backing_volume_uuid, BACKING_UUID)
        self.assertEqual(intent.map_volume_uuid, MAP_UUID)
        self.assertEqual(intent.configured_headroom_percent, 18.0)
        self.assertEqual(intent.bound_process_pid, self.downloader.pid)
        self.assertEqual(intent.progress_mtime_ns_floor, 2_000)
        self.assertEqual(intent.estimate_sha256, "a" * 64)

    def test_arm_refuses_stale_status_transition_and_wrong_lock(self) -> None:
        stale = resume.decide_arm(
            self.snapshot(progress=active_progress(age=61.0)),
            self.config,
        )
        self.assertEqual(stale.action, "stop")
        self.assertIn("fresco", stale.reason)

        transition = resume.decide_arm(
            self.snapshot(transition=True),
            self.config,
        )
        self.assertEqual(transition.action, "stop")

        wrong_lock = resume.decide_arm(
            self.snapshot(lock_owner=999),
            self.config,
        )
        self.assertEqual(wrong_lock.action, "stop")
        self.assertIn("lock", wrong_lock.reason)

    def test_rearming_preserves_recent_durable_budget(self) -> None:
        attempt = resume.RestartAttempt(
            at_epoch=999.0,
            boot_id="macos:150.000001",
            action="launch_stack",
        )
        prior = make_intent(self.config, attempts=(attempt,))
        snapshot = self.snapshot(intent=prior)
        armed = resume.build_armed_intent(snapshot, self.config)
        self.assertEqual(armed.restart_attempts, (attempt,))
        absent = make_snapshot(
            self.config,
            intent=armed,
            boot_id=armed.armed_boot_id,
            now=1_001.0,
        )
        decision = resume.decide_recovery(absent, self.config)
        self.assertEqual(decision.action, "wait")


class CommandsAndModesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def cli_args(self, *mode: str) -> list[str]:
        return [
            *mode,
            "--project-dir",
            str(self.config.project_dir),
            "--output",
            str(self.config.output_dir),
            "--backing-volume",
            str(self.config.backing_volume),
            "--map-volume",
            str(self.config.map_volume),
            "--image",
            str(self.config.image_path),
            "--intent-path",
            str(self.config.intent_path),
            "--vendor-pythonpath",
            str(self.config.vendor_pythonpath),
        ]

    def test_default_paths_match_installed_plist_contract(self) -> None:
        args = resume.parse_args([])
        self.assertEqual(args.project_dir, resume.DEFAULT_PROJECT_DIR)
        self.assertEqual(
            args.intent_path,
            resume.DEFAULT_APPLICATION_SUPPORT
            / "recovery_intent.json",
        )
        self.assertNotIn("Obsidian Atlas", str(args.intent_path))
        self.assertEqual(
            args.vendor_pythonpath,
            resume.DEFAULT_APPLICATION_SUPPORT / "py311-packages",
        )

    def test_nonfinite_timeouts_are_rejected(self) -> None:
        for arguments in (
            ["--maximum-heartbeat-age", "nan"],
            ["--maximum-heartbeat-age", "inf"],
            ["--startup-timeout", "nan"],
            ["--startup-timeout", "inf"],
        ):
            with self.assertRaises(SystemExit):
                resume.parse_args(arguments)

    def test_canonical_config_recognizes_current_downloader_shape(self) -> None:
        config = resume.RuntimeConfig(
            project_dir=resume.DEFAULT_PROJECT_DIR,
            output_dir=Path("/Volumes/2b2t Tiles/2b2t_tiles"),
            backing_volume=Path("/Volumes/LuisA"),
            map_volume=Path("/Volumes/2b2t Tiles"),
            image_path=Path(
                "/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle"
            ),
            intent_path=(
                resume.DEFAULT_APPLICATION_SUPPORT
                / "recovery_intent.json"
            ),
            vendor_pythonpath=(
                resume.DEFAULT_APPLICATION_SUPPORT / "py311-packages"
            ),
        )
        arguments = (
            "/Library/Frameworks/Python.framework/Versions/3.14/"
            "Resources/Python.app/Contents/MacOS/Python "
            f"{config.downloader_path} --all "
            "--dimensions overworld,nether,end "
            "--layers base,overlay,newchunks --lods all "
            f"--out {config.output_dir} --workers 4 "
            "--requests-per-second 2 --timeout 30 --retries 5 "
            "--discovery-samples 25 --space-headroom-percent 18 "
            "--resume --skip-smoke-test --no-fallback"
        )
        identity = supervisor.process_identity_from_fields(
            77742,
            "Fri Jul 24 19:18:27 2026",
            arguments,
            config.downloader_path,
            config.output_dir,
        )
        self.assertIsNotNone(identity)
        self.assertEqual(identity.pid, 77742)  # type: ignore[union-attr]
        self.assertEqual(
            identity.headroom_percent,  # type: ignore[union-attr]
            18.0,
        )

    def test_fixed_commands_are_built_only_from_runtime_config(self) -> None:
        supervisor_argv = resume.fixed_supervisor_argv(self.config)
        self.assertEqual(supervisor_argv[0], os.sys.executable)
        self.assertEqual(
            supervisor_argv[1],
            str(self.config.supervisor_path),
        )
        self.assertIn(
            f"--output={self.config.output_dir}",
            supervisor_argv,
        )
        self.assertEqual(
            resume.fixed_attach_argv(self.config),
            (
                "/usr/bin/hdiutil",
                "attach",
                "-nobrowse",
                str(self.config.image_path),
            ),
        )
        environment = resume.fixed_launcher_environment(
            make_intent(self.config),
            self.config,
            base={
                "PATH": "/evil",
                "BASH_ENV": "/tmp/evil",
                "OBSIDIAN_ATLAS_DOWNLOAD_EXEC_LOCK_HELD": "1",
                "ALLOW_TEMPORARY_HEADROOM_MIGRATION": "0",
            },
        )
        self.assertEqual(
            environment["PATH"],
            "/usr/bin:/bin:/usr/sbin:/sbin",
        )
        self.assertNotIn("BASH_ENV", environment)
        self.assertNotIn(
            "OBSIDIAN_ATLAS_DOWNLOAD_EXEC_LOCK_HELD",
            environment,
        )
        self.assertEqual(environment["PYTHON_BIN"], os.sys.executable)
        self.assertEqual(
            environment["PYTHONPATH"],
            str(self.config.vendor_pythonpath),
        )
        self.assertEqual(environment["SPACE_HEADROOM_PERCENT"], "18.0")
        self.assertEqual(
            environment["OBSIDIAN_ATLAS_RECOVERY_AUTHORIZED"],
            "1",
        )
        self.assertEqual(
            environment["ALLOW_TEMPORARY_HEADROOM_MIGRATION"],
            "1",
        )
        precise = resume.fixed_launcher_environment(
            make_intent(self.config, headroom=20.123456789),
            self.config,
            base={},
        )
        self.assertEqual(
            float(precise["SPACE_HEADROOM_PERCENT"]),
            20.123456789,
        )
        supervisor_environment = resume.fixed_supervisor_environment(
            self.config,
            base={
                "PATH": "/evil",
                "PYTHON_BIN": "/evil/python",
                "PYTHONPATH": "/evil/packages",
                "BASH_ENV": "/tmp/evil",
            },
        )
        self.assertEqual(
            supervisor_environment,
            {
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "PYTHON_BIN": os.sys.executable,
                "PYTHONPATH": str(self.config.vendor_pythonpath),
            },
        )
        self.assertNotIn(
            "OBSIDIAN_ATLAS_RECOVERY_AUTHORIZED",
            supervisor_environment,
        )

    def test_supervisor_identity_accepts_legacy_and_fixed_only(self) -> None:
        legacy = resume.supervisor_identity_from_fields(
            10,
            "Fri Jul 24 21:55:04 2026",
            "/usr/bin/python3 supervise_full_download_luisa.py",
            script_path=self.config.supervisor_path,
            project_dir=self.config.project_dir,
            output_dir=self.config.output_dir,
            cwd=self.config.project_dir,
        )
        self.assertIsNotNone(legacy)
        fixed = " ".join(resume.fixed_supervisor_argv(self.config))
        self.assertIsNotNone(
            resume.supervisor_identity_from_fields(
                11,
                "Fri Jul 24 21:55:04 2026",
                fixed,
                script_path=self.config.supervisor_path,
                project_dir=self.config.project_dir,
                output_dir=self.config.output_dir,
                cwd=None,
            )
        )
        poisoned = f"{fixed} --once"
        self.assertIsNone(
            resume.supervisor_identity_from_fields(
                12,
                "Fri Jul 24 21:55:04 2026",
                poisoned,
                script_path=self.config.supervisor_path,
                project_dir=self.config.project_dir,
                output_dir=self.config.output_dir,
                cwd=None,
            )
        )

    def test_default_exposes_launch_but_never_executes(self) -> None:
        snapshot = make_snapshot(self.config)
        output = io.StringIO()
        with (
            mock.patch.object(
                resume,
                "collect_snapshot",
                return_value=snapshot,
            ),
            mock.patch.object(resume, "execute_decision") as execute,
            contextlib.redirect_stdout(output),
        ):
            code = resume.run(self.cli_args())
        self.assertEqual(code, 0)
        execute.assert_not_called()
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["action"], "launch_stack")
        self.assertFalse(payload["executed"])

    def test_check_only_never_persists_adoption(self) -> None:
        downloader = process_identity(self.config)
        snapshot = make_snapshot(
            self.config,
            downloaders=(downloader,),
            lock_owner=downloader.pid,
            supervisors=(supervisor_identity(),),
        )
        with (
            mock.patch.object(
                resume,
                "collect_snapshot",
                return_value=snapshot,
            ),
            mock.patch.object(resume, "write_intent") as write,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            code = resume.run(self.cli_args("--check-only"))
        self.assertEqual(code, 0)
        write.assert_not_called()
        self.assertFalse(self.config.intent_path.parent.exists())

    def test_default_adopts_existing_service_without_launch(self) -> None:
        downloader = process_identity(self.config)
        snapshot = make_snapshot(
            self.config,
            downloaders=(downloader,),
            lock_owner=downloader.pid,
            supervisors=(supervisor_identity(),),
        )
        with (
            mock.patch.object(
                resume,
                "collect_snapshot",
                return_value=snapshot,
            ),
            mock.patch.object(resume, "write_intent") as write,
            mock.patch.object(resume, "execute_decision") as execute,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            code = resume.run(self.cli_args())
        self.assertEqual(code, 0)
        write.assert_called_once()
        adopted = write.call_args.args[1]
        self.assertEqual(adopted.state, "adopted")
        self.assertEqual(adopted.adopted_boot_id, snapshot.boot_id)
        execute.assert_not_called()

    def test_execute_reserves_budget_before_fixed_action(self) -> None:
        snapshot = make_snapshot(self.config)
        events: list[str] = []
        observations = 0

        def collect(
            _config: resume.RuntimeConfig,
            *,
            intent_load: resume.IntentLoad | None = None,
            **_kwargs: object,
        ) -> resume.RecoverySnapshot:
            nonlocal observations
            observations += 1
            if observations <= 2:
                return snapshot
            self.assertIsNotNone(intent_load)
            downloader = process_identity(self.config, pid=321)
            return make_snapshot(
                self.config,
                intent=intent_load.intent,  # type: ignore[union-attr]
                downloaders=(downloader,),
                lock_owner=downloader.pid,
                supervisors=(supervisor_identity(),),
            )

        def write(_path: Path, intent: resume.RecoveryIntent) -> None:
            events.append(
                "claim"
                if intent.restart_attempts
                and intent.state == "armed"
                else "adopt"
            )

        def execute(
            _decision: resume.RecoveryDecision,
            observed: resume.RecoverySnapshot,
            _config: resume.RuntimeConfig,
        ) -> resume.ExecutionResult:
            self.assertEqual(
                len(
                    observed.intent_load.intent.restart_attempts  # type: ignore[union-attr]
                ),
                1,
            )
            events.append("execute")
            return resume.ExecutionResult(True, "ok")

        with (
            mock.patch.object(
                resume,
                "collect_snapshot",
                side_effect=collect,
            ),
            mock.patch.object(
                resume,
                "execution_paths_are_canonical",
                return_value=True,
            ),
            mock.patch.object(resume, "write_intent", side_effect=write),
            mock.patch.object(
                resume,
                "execute_decision",
                side_effect=execute,
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            code = resume.run(self.cli_args("--execute"))
        self.assertEqual(code, 0)
        self.assertEqual(events, ["claim", "execute", "adopt"])

    def test_execute_rechecks_uuids_before_popen(self) -> None:
        snapshot = make_snapshot(self.config)
        decision = resume.RecoveryDecision(
            "launch_stack",
            "test",
            requires_execute=True,
            consumes_restart_budget=True,
        )
        popen = mock.Mock()

        def wrong_volume(path: Path) -> resume.VolumeObservation:
            return resume.VolumeObservation(
                str(path),
                True,
                (
                    "33333333-3333-4333-8333-333333333333"
                    if path == self.config.backing_volume
                    else MAP_UUID
                ),
                "test",
            )

        with (
            mock.patch.object(
                resume,
                "execution_paths_are_canonical",
                return_value=True,
            ),
            mock.patch.object(
                resume,
                "hash_regular_file",
                return_value=snapshot.estimate_sha256,
            ),
        ):
            result = resume.execute_decision(
                decision,
                snapshot,
                self.config,
                popen=popen,
                volume_reader=wrong_volume,
            )
        self.assertFalse(result.ok)
        self.assertIn("UUID", result.reason)
        popen.assert_not_called()

    def test_execute_adopts_racing_supervisor_without_duplicate(self) -> None:
        downloader = process_identity(self.config)
        snapshot = make_snapshot(
            self.config,
            downloaders=(downloader,),
            lock_owner=downloader.pid,
        )
        decision = resume.RecoveryDecision(
            "launch_supervisor",
            "test",
            requires_execute=True,
        )
        popen = mock.Mock()

        def volume(path: Path) -> resume.VolumeObservation:
            return resume.VolumeObservation(
                str(path),
                True,
                (
                    BACKING_UUID
                    if path == self.config.backing_volume
                    else MAP_UUID
                ),
                "test",
            )

        with mock.patch.object(
            resume,
            "execution_paths_are_canonical",
            return_value=True,
        ):
            result = resume.execute_decision(
                decision,
                snapshot,
                self.config,
                popen=popen,
                volume_reader=volume,
                supervisor_finder=lambda _config: (
                    (supervisor_identity(),),
                    (),
                ),
            )
        self.assertTrue(result.ok)
        self.assertIn("otro starter", result.reason)
        popen.assert_not_called()

    def test_launched_supervisor_receives_fixed_python_environment(
        self,
    ) -> None:
        downloader = process_identity(self.config)
        snapshot = make_snapshot(
            self.config,
            downloaders=(downloader,),
            lock_owner=downloader.pid,
        )
        decision = resume.RecoveryDecision(
            "launch_supervisor",
            "test",
            requires_execute=True,
        )
        popen = mock.Mock()
        find_supervisor = mock.Mock(
            side_effect=[
                ((), ()),
                ((supervisor_identity(),), ()),
            ]
        )

        def volume(path: Path) -> resume.VolumeObservation:
            return resume.VolumeObservation(
                str(path),
                True,
                (
                    BACKING_UUID
                    if path == self.config.backing_volume
                    else MAP_UUID
                ),
                "test",
            )

        with mock.patch.object(
            resume,
            "execution_paths_are_canonical",
            return_value=True,
        ):
            result = resume.execute_decision(
                decision,
                snapshot,
                self.config,
                popen=popen,
                monotonic=lambda: 0,
                sleep=lambda _seconds: None,
                supervisor_finder=find_supervisor,
                volume_reader=volume,
            )

        self.assertTrue(result.ok)
        popen.assert_called_once()
        self.assertEqual(
            popen.call_args.kwargs["env"],
            resume.fixed_supervisor_environment(self.config),
        )
        self.assertTrue(
            popen.call_args.kwargs["start_new_session"]
        )

    def test_attach_rechecks_and_adopts_racing_exact_mount(self) -> None:
        snapshot = make_snapshot(
            self.config,
            map_mounted=False,
            map_uuid=None,
        )
        decision = resume.RecoveryDecision(
            "attach_tiles",
            "test",
            requires_execute=True,
        )
        run_command = mock.Mock()

        def volume(path: Path) -> resume.VolumeObservation:
            return resume.VolumeObservation(
                str(path),
                True,
                (
                    BACKING_UUID
                    if path == self.config.backing_volume
                    else MAP_UUID
                ),
                "test",
            )

        with mock.patch.object(
            resume,
            "execution_paths_are_canonical",
            return_value=True,
        ):
            result = resume.execute_decision(
                decision,
                snapshot,
                self.config,
                run_command=run_command,
                volume_reader=volume,
            )
        self.assertTrue(result.ok)
        self.assertIn("otro starter", result.reason)
        run_command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
