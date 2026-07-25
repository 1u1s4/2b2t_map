#!/usr/bin/env python3
"""One-shot, fail-closed recovery coordinator for the LuisA download.

The durable intent written by ``--arm`` contains facts, never a command.
Every executable path and argument used by ``--execute`` is rebuilt from the
local, trusted configuration in this module.  Normal mode only adopts an
already-running canonical service or reports the action that would be taken;
``--check-only`` is completely read-only.

This coordinator deliberately does not replace
``supervise_full_download_luisa.py``.  In particular, a persisted
``margin_transition.json`` is always routed to that supervisor and is never
recovered by starting the downloader directly.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import hashlib
import json
import math
import os
import plistlib
import re
import stat
import subprocess
import sys
import time
import uuid
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import supervise_full_download_luisa as supervisor


INTENT_VERSION = 1
MAX_INTENT_BYTES = 64 * 1024
MAX_RESTARTS = 3
RESTART_WINDOW_SECONDS = 24 * 60 * 60
TEMPORARY_HEADROOM_PERCENT = 18.0
MINIMUM_NORMAL_HEADROOM_PERCENT = 20.0

CANONICAL_DIMENSIONS = ("overworld", "nether", "end")
CANONICAL_LAYERS = ("base", "overlay", "newchunks")
CANONICAL_LODS = tuple(range(11))
RESTART_ACTIONS = frozenset(
    {"launch_stack", "launch_transition_supervisor"}
)
DEFAULT_PROJECT_DIR = Path(
    "/Users/luisalvarado/Documents/GitHub/2b2t_map"
)
DEFAULT_APPLICATION_SUPPORT = (
    Path.home() / "Library/Application Support/ObsidianAtlas"
)
EXPECTED_PYTHON = Path(
    "/Users/luisalvarado/.local/share/uv/python/"
    "cpython-3.11.15-macos-aarch64-none/bin/python3.11"
)
MAX_HASHED_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_PROGRESS_BYTES = 1024 * 1024
BOOT_ID_PATTERN = re.compile(
    r"^macos:([1-9][0-9]*)\.([0-9]{6})$"
)


@dataclasses.dataclass(frozen=True, slots=True)
class RuntimeConfig:
    project_dir: Path
    output_dir: Path
    backing_volume: Path
    map_volume: Path
    image_path: Path
    intent_path: Path
    vendor_pythonpath: Path
    maximum_heartbeat_age: float = 60.0
    startup_timeout: float = 120.0

    @property
    def downloader_path(self) -> Path:
        return self.project_dir / "download_all_2b2t.py"

    @property
    def supervisor_path(self) -> Path:
        return self.project_dir / "supervise_full_download_luisa.py"

    @property
    def launcher_path(self) -> Path:
        return self.project_dir / "run_full_download_luisa.sh"

    @property
    def progress_path(self) -> Path:
        return self.output_dir / "progress.json"

    @property
    def estimate_path(self) -> Path:
        return self.output_dir / "estimate.json"

    @property
    def database_path(self) -> Path:
        return self.output_dir / "tiles.sqlite3"

    @property
    def download_lock(self) -> Path:
        return self.output_dir / ".download.lock"

    @property
    def storage_stop_path(self) -> Path:
        return self.output_dir / "storage_stop.json"

    @property
    def margin_transition_path(self) -> Path:
        return self.output_dir / "margin_transition.json"


@dataclasses.dataclass(frozen=True, slots=True)
class VolumeObservation:
    mount_point: str
    mounted: bool
    volume_uuid: str | None
    reason: str


@dataclasses.dataclass(frozen=True, slots=True)
class SupervisorIdentity:
    pid: int
    started_at: str
    arguments: str


@dataclasses.dataclass(frozen=True, slots=True)
class RestartAttempt:
    at_epoch: float
    boot_id: str
    action: str


@dataclasses.dataclass(frozen=True, slots=True)
class RecoveryIntent:
    state: str
    armed_at_epoch: float
    armed_boot_id: str
    adopted_at_epoch: float | None
    adopted_boot_id: str | None
    project_dir: str
    output_dir: str
    backing_volume: str
    map_volume: str
    image_path: str
    backing_volume_uuid: str
    map_volume_uuid: str
    dimensions: tuple[str, ...]
    layers: tuple[str, ...]
    lods: tuple[int, ...]
    configured_headroom_percent: float
    bound_process_pid: int
    bound_process_started_at: str
    bound_process_arguments_sha256: str
    progress_mtime_ns_floor: int
    estimate_sha256: str
    restart_attempts: tuple[RestartAttempt, ...] = ()


@dataclasses.dataclass(frozen=True, slots=True)
class IntentLoad:
    exists: bool
    intent: RecoveryIntent | None
    error: str | None


@dataclasses.dataclass(frozen=True, slots=True)
class PlanEvidence:
    valid: bool
    reason: str
    configured_headroom_percent: float | None
    full_scope: bool
    fits_configured: bool
    quick_check_ok: bool | None


@dataclasses.dataclass(frozen=True, slots=True)
class RecoverySnapshot:
    now_epoch: float
    boot_id: str
    intent_load: IntentLoad
    backing_volume: VolumeObservation
    map_volume: VolumeObservation
    image_exists: bool
    progress: supervisor.ProgressObservation
    progress_mtime_ns: int | None
    estimate_sha256: str | None
    plan: PlanEvidence
    downloader_identities: tuple[supervisor.ProcessIdentity, ...]
    invalid_downloader_pids: tuple[int, ...]
    download_lock_owner: int | None
    supervisor_identities: tuple[SupervisorIdentity, ...]
    invalid_supervisor_pids: tuple[int, ...]
    storage_stop_exists: bool
    margin_transition_exists: bool
    supervisor_tool_available: bool = True
    launcher_tool_available: bool = True


@dataclasses.dataclass(frozen=True, slots=True)
class RecoveryDecision:
    action: str
    reason: str
    requires_execute: bool = False
    consumes_restart_budget: bool = False
    may_adopt: bool = False


@dataclasses.dataclass(frozen=True, slots=True)
class ExecutionResult:
    ok: bool
    reason: str


class DurableWriteError(RuntimeError):
    """The durable state could not be committed."""


CommandRunner = Callable[..., Any]
ProcessLauncher = Callable[..., Any]


def canonical_path(path: Path) -> str:
    return str(path.expanduser().resolve())


def normalize_volume_uuid(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return str(uuid.UUID(value.strip())).upper()
    except (ValueError, AttributeError):
        return None


def valid_boot_id(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = BOOT_ID_PATTERN.fullmatch(value)
    return (
        match is not None
        and int(match.group(2)) < 1_000_000
    )


def allowed_headroom_percent(value: float | None) -> bool:
    try:
        numeric = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return False
    if (
        value is None
        or isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(numeric)
        or numeric < 0
    ):
        return False
    return (
        numeric == TEMPORARY_HEADROOM_PERCENT
        or numeric >= MINIMUM_NORMAL_HEADROOM_PERCENT
    )


def same_number(left: float | None, right: float | None) -> bool:
    return (
        allowed_headroom_percent(left)
        and allowed_headroom_percent(right)
        and float(left) == float(right)  # type: ignore[arg-type]
    )


def process_arguments_sha256(
    identity: supervisor.ProcessIdentity,
) -> str:
    return hashlib.sha256(
        identity.arguments.encode("utf-8")
    ).hexdigest()


def hash_regular_file(
    path: Path,
    *,
    maximum_bytes: int = MAX_HASHED_ARTIFACT_BYTES,
) -> str | None:
    """Hash a bounded regular file without following a final symlink."""

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_size < 0
            or metadata.st_size > maximum_bytes
        ):
            return None
        digest = hashlib.sha256()
        consumed = 0
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, maximum_bytes + 1))
            if not chunk:
                break
            consumed += len(chunk)
            if consumed > maximum_bytes:
                return None
            digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None
    finally:
        os.close(descriptor)


def read_stable_progress(
    path: Path,
    *,
    now_epoch: float | None = None,
) -> tuple[supervisor.ProgressObservation, int | None]:
    """Read progress content and mtime from the same regular-file inode."""

    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
    except FileNotFoundError:
        return (
            supervisor.ProgressObservation(
                False, False, "", None, {}, None
            ),
            None,
        )
    except OSError:
        return (
            supervisor.ProgressObservation(
                True, False, "", None, {}, None
            ),
            None,
        )
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_size > MAX_PROGRESS_BYTES
        ):
            raise ValueError
        chunks: list[bytes] = []
        consumed = 0
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            consumed += len(chunk)
            if consumed > MAX_PROGRESS_BYTES:
                raise ValueError
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ValueError
        payload = json.loads(b"".join(chunks).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
        raw_errors = payload.get("http_errors")
        http_errors: dict[str, int] = {}
        if isinstance(raw_errors, dict):
            for code, count in raw_errors.items():
                if (
                    isinstance(count, int)
                    and not isinstance(count, bool)
                    and count > 0
                ):
                    http_errors[str(code)] = count
        reason = payload.get("reason")
        observed_now = time.time() if now_epoch is None else now_epoch
        return (
            supervisor.ProgressObservation(
                True,
                True,
                str(payload.get("status") or "").strip().lower(),
                (
                    reason.strip()
                    if isinstance(reason, str) and reason.strip()
                    else None
                ),
                http_errors,
                max(0.0, observed_now - after.st_mtime),
            ),
            after.st_mtime_ns,
        )
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        ValueError,
    ):
        return (
            supervisor.ProgressObservation(
                True, False, "", None, {}, None
            ),
            None,
        )
    finally:
        if descriptor is not None:
            os.close(descriptor)


def required_bytes_for_percent(
    remaining_bytes: int | None,
    percent: float | None,
) -> int | None:
    """Return ceil(remaining * (1 + percent / 100)) for any finite percent."""

    if (
        remaining_bytes is None
        or isinstance(remaining_bytes, bool)
        or not isinstance(remaining_bytes, int)
        or remaining_bytes < 0
        or not allowed_headroom_percent(percent)
    ):
        return None
    try:
        multiplier = (
            Decimal(100) + Decimal(str(float(percent)))
        ) / Decimal(100)
        required = (
            Decimal(remaining_bytes) * multiplier
        ).to_integral_value(rounding=ROUND_CEILING)
    except (InvalidOperation, ValueError):
        return None
    return int(required)


def _run_capture(
    argv: Sequence[str],
    *,
    run_command: CommandRunner,
    timeout: float = 10.0,
) -> Any:
    return run_command(
        list(argv),
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def read_macos_boot_id(
    *,
    run_command: CommandRunner = subprocess.run,
) -> str:
    """Read a boot-session identity from macOS, with an injectable runner."""

    try:
        result = _run_capture(
            ["/usr/sbin/sysctl", "-n", "kern.boottime"],
            run_command=run_command,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("no se pudo leer kern.boottime") from exc
    output = str(result.stdout).strip()
    match = re.search(
        r"\bsec\s*=\s*([0-9]+)\s*,\s*usec\s*=\s*([0-9]+)",
        output,
    )
    if match is None:
        raise RuntimeError("kern.boottime no tiene el formato esperado")
    seconds = int(match.group(1))
    microseconds = int(match.group(2))
    if seconds <= 0 or not 0 <= microseconds < 1_000_000:
        raise RuntimeError("kern.boottime contiene valores inválidos")
    return f"macos:{seconds}.{microseconds:06d}"


def read_volume_observation(
    mount_point: Path,
    *,
    is_mount: Callable[[os.PathLike[str] | str], bool] = os.path.ismount,
    run_command: CommandRunner = subprocess.run,
) -> VolumeObservation:
    path = mount_point.expanduser().resolve()
    if not path.is_dir() or not is_mount(path):
        return VolumeObservation(
            mount_point=str(path),
            mounted=False,
            volume_uuid=None,
            reason="el volumen no está montado",
        )
    try:
        result = run_command(
            ["/usr/sbin/diskutil", "info", "-plist", str(path)],
            check=True,
            capture_output=True,
            timeout=10.0,
        )
        raw = result.stdout
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        payload = plistlib.loads(raw)
        volume_uuid = normalize_volume_uuid(payload.get("VolumeUUID"))
    except (
        OSError,
        subprocess.SubprocessError,
        plistlib.InvalidFileException,
        AttributeError,
        TypeError,
    ):
        volume_uuid = None
    if volume_uuid is None:
        return VolumeObservation(
            mount_point=str(path),
            mounted=True,
            volume_uuid=None,
            reason="diskutil no devolvió un VolumeUUID válido",
        )
    return VolumeObservation(
        mount_point=str(path),
        mounted=True,
        volume_uuid=volume_uuid,
        reason="volumen montado con UUID verificable",
    )


def _intent_payload(intent: RecoveryIntent) -> dict[str, object]:
    return {
        "version": INTENT_VERSION,
        "state": intent.state,
        "armed_at_epoch": intent.armed_at_epoch,
        "armed_boot_id": intent.armed_boot_id,
        "adopted_at_epoch": intent.adopted_at_epoch,
        "adopted_boot_id": intent.adopted_boot_id,
        "project_dir": intent.project_dir,
        "output_dir": intent.output_dir,
        "backing_volume": intent.backing_volume,
        "map_volume": intent.map_volume,
        "image_path": intent.image_path,
        "backing_volume_uuid": intent.backing_volume_uuid,
        "map_volume_uuid": intent.map_volume_uuid,
        "scope": {
            "dimensions": list(intent.dimensions),
            "layers": list(intent.layers),
            "lods": list(intent.lods),
        },
        "configured_headroom_percent": (
            intent.configured_headroom_percent
        ),
        "binding": {
            "process_pid": intent.bound_process_pid,
            "process_started_at": intent.bound_process_started_at,
            "process_arguments_sha256": (
                intent.bound_process_arguments_sha256
            ),
            "progress_mtime_ns_floor": (
                intent.progress_mtime_ns_floor
            ),
            "estimate_sha256": intent.estimate_sha256,
        },
        "restart_attempts": [
            dataclasses.asdict(attempt)
            for attempt in intent.restart_attempts
        ],
    }


def _finite_epoch(value: object) -> float | None:
    try:
        numeric = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(numeric)
        or numeric < 0
    ):
        return None
    return numeric


def parse_intent_payload(payload: object) -> RecoveryIntent:
    if not isinstance(payload, dict):
        raise ValueError("la intención no es un objeto JSON")
    if isinstance(payload.get("version"), bool) or payload.get(
        "version"
    ) != INTENT_VERSION:
        raise ValueError("versión de intención no compatible")
    prohibited_fields = {
        "argv",
        "command",
        "commands",
        "environment",
        "resume_command",
        "shell",
    }
    if prohibited_fields.intersection(payload):
        raise ValueError("la intención no puede contener comandos")
    state = payload.get("state")
    if state not in {"armed", "adopted"}:
        raise ValueError("estado de intención inválido")

    armed_at = _finite_epoch(payload.get("armed_at_epoch"))
    adopted_raw = payload.get("adopted_at_epoch")
    adopted_at = (
        None if adopted_raw is None else _finite_epoch(adopted_raw)
    )
    armed_boot_id = payload.get("armed_boot_id")
    adopted_boot_id = payload.get("adopted_boot_id")
    if (
        armed_at is None
        or not valid_boot_id(armed_boot_id)
        or (
            adopted_boot_id is not None
            and not valid_boot_id(adopted_boot_id)
        )
        or (adopted_raw is not None and adopted_at is None)
        or (
            state == "armed"
            and (
                adopted_at is not None
                or adopted_boot_id is not None
            )
        )
        or (
            state == "adopted"
            and (
                adopted_at is None
                or adopted_boot_id is None
                or adopted_at < armed_at
            )
        )
    ):
        raise ValueError("marcas de armado/adopción inválidas")

    path_fields: dict[str, str] = {}
    for field in (
        "project_dir",
        "output_dir",
        "backing_volume",
        "map_volume",
        "image_path",
    ):
        value = payload.get(field)
        if (
            not isinstance(value, str)
            or not value
            or not Path(value).is_absolute()
            or canonical_path(Path(value)) != value
        ):
            raise ValueError(f"{field} no es una ruta absoluta canónica")
        path_fields[field] = value

    backing_uuid = normalize_volume_uuid(
        payload.get("backing_volume_uuid")
    )
    map_uuid = normalize_volume_uuid(payload.get("map_volume_uuid"))
    if backing_uuid is None or map_uuid is None:
        raise ValueError("la intención no contiene ambos UUID de volumen")

    scope = payload.get("scope")
    if not isinstance(scope, dict):
        raise ValueError("la intención no contiene alcance")
    dimensions = scope.get("dimensions")
    layers = scope.get("layers")
    lods = scope.get("lods")
    if (
        dimensions != list(CANONICAL_DIMENSIONS)
        or layers != list(CANONICAL_LAYERS)
        or lods != list(CANONICAL_LODS)
    ):
        raise ValueError("la intención no cubre exactamente el mapa completo")

    headroom_raw = payload.get("configured_headroom_percent")
    if (
        isinstance(headroom_raw, bool)
        or not isinstance(headroom_raw, (int, float))
        or not allowed_headroom_percent(headroom_raw)
    ):
        raise ValueError("la reserva configurada no es 18 exacto ni >=20")

    binding = payload.get("binding")
    if not isinstance(binding, dict):
        raise ValueError("la intención no contiene binding de artefactos")
    bound_pid = binding.get("process_pid")
    bound_started_at = binding.get("process_started_at")
    bound_arguments_sha256 = binding.get("process_arguments_sha256")
    progress_floor = binding.get("progress_mtime_ns_floor")
    estimate_sha256 = binding.get("estimate_sha256")
    sha256_pattern = re.compile(r"^[0-9a-f]{64}$")
    if (
        isinstance(bound_pid, bool)
        or not isinstance(bound_pid, int)
        or bound_pid <= 0
        or not isinstance(bound_started_at, str)
        or not bound_started_at
        or not isinstance(bound_arguments_sha256, str)
        or sha256_pattern.fullmatch(bound_arguments_sha256) is None
        or isinstance(progress_floor, bool)
        or not isinstance(progress_floor, int)
        or progress_floor <= 0
        or not isinstance(estimate_sha256, str)
        or sha256_pattern.fullmatch(estimate_sha256) is None
    ):
        raise ValueError("el binding de proceso/artefactos no es válido")

    raw_attempts = payload.get("restart_attempts")
    if not isinstance(raw_attempts, list) or len(raw_attempts) > 100:
        raise ValueError("historial de reinicios inválido")
    attempts: list[RestartAttempt] = []
    previous_epoch = -1.0
    for row in raw_attempts:
        if not isinstance(row, dict):
            raise ValueError("un intento de reinicio no es un objeto")
        at_epoch = _finite_epoch(row.get("at_epoch"))
        boot_id = row.get("boot_id")
        action = row.get("action")
        if (
            at_epoch is None
            or at_epoch < previous_epoch
            or not valid_boot_id(boot_id)
            or action not in RESTART_ACTIONS
        ):
            raise ValueError("historial de reinicios no es canónico")
        attempts.append(
            RestartAttempt(
                at_epoch=at_epoch,
                boot_id=boot_id,
                action=action,
            )
        )
        previous_epoch = at_epoch

    return RecoveryIntent(
        state=state,
        armed_at_epoch=armed_at,
        armed_boot_id=armed_boot_id,
        adopted_at_epoch=adopted_at,
        adopted_boot_id=adopted_boot_id,
        project_dir=path_fields["project_dir"],
        output_dir=path_fields["output_dir"],
        backing_volume=path_fields["backing_volume"],
        map_volume=path_fields["map_volume"],
        image_path=path_fields["image_path"],
        backing_volume_uuid=backing_uuid,
        map_volume_uuid=map_uuid,
        dimensions=CANONICAL_DIMENSIONS,
        layers=CANONICAL_LAYERS,
        lods=CANONICAL_LODS,
        configured_headroom_percent=float(headroom_raw),
        bound_process_pid=bound_pid,
        bound_process_started_at=bound_started_at,
        bound_process_arguments_sha256=bound_arguments_sha256,
        progress_mtime_ns_floor=progress_floor,
        estimate_sha256=estimate_sha256,
        restart_attempts=tuple(attempts),
    )


def read_intent(path: Path) -> IntentLoad:
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
    except FileNotFoundError:
        return IntentLoad(False, None, None)
    except OSError as exc:
        return IntentLoad(
            True,
            None,
            f"la intención no es un archivo regular: {exc}",
        )
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return IntentLoad(
                True,
                None,
                "la intención no es un archivo regular",
            )
        if metadata.st_size > MAX_INTENT_BYTES:
            return IntentLoad(True, None, "la intención excede 64 KiB")
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = None
            text = handle.read(MAX_INTENT_BYTES + 1)
        if len(text.encode("utf-8")) > MAX_INTENT_BYTES:
            return IntentLoad(True, None, "la intención excede 64 KiB")
        payload = json.loads(text)
        intent = parse_intent_payload(payload)
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        return IntentLoad(True, None, str(exc))
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return IntentLoad(True, intent, None)


def atomic_write_json(path: Path, payload: Mapping[str, object]) -> None:
    """Write JSON via fsync(file), replace, and fsync(parent directory)."""

    parent = path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = parent / (
        f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    descriptor: int | None = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(
            parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except (OSError, TypeError, ValueError) as exc:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise DurableWriteError(
            f"no se pudo persistir {path.name}: {exc}"
        ) from exc


def write_intent(path: Path, intent: RecoveryIntent) -> None:
    atomic_write_json(path, _intent_payload(intent))


def acquire_intent_lock(path: Path) -> Any:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    handle = lock_path.open("a+", encoding="ascii")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise RuntimeError("ya existe otro coordinador activo") from exc
    return handle


def _read_process_cwd(
    pid: int,
    *,
    run_command: CommandRunner,
) -> Path | None:
    try:
        result = _run_capture(
            [
                "/usr/sbin/lsof",
                "-a",
                "-p",
                str(pid),
                "-d",
                "cwd",
                "-Fn",
            ],
            run_command=run_command,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in str(result.stdout).splitlines():
        if line.startswith("n") and len(line) > 1:
            try:
                return Path(line[1:]).resolve()
            except OSError:
                return None
    return None


def supervisor_identity_from_fields(
    pid: int,
    started_at: str,
    arguments: str,
    *,
    script_path: Path,
    project_dir: Path,
    output_dir: Path,
    cwd: Path | None,
) -> SupervisorIdentity | None:
    """Validate only the no-options legacy service or our fixed argv."""

    if (
        isinstance(pid, bool)
        or not isinstance(pid, int)
        or pid <= 0
        or not started_at
        or not arguments
    ):
        return None
    fields = arguments.split(None, 1)
    if len(fields) != 2:
        return None
    executable, tail = fields
    if "python" not in Path(executable).name.casefold():
        return None

    absolute_script = str(script_path.resolve())
    relative_script = script_path.name
    if tail == absolute_script:
        options = ""
    elif tail.startswith(f"{absolute_script} "):
        options = tail[len(absolute_script) + 1 :]
    elif cwd == project_dir.resolve() and tail == relative_script:
        options = ""
    elif (
        cwd == project_dir.resolve()
        and tail.startswith(f"{relative_script} ")
    ):
        options = tail[len(relative_script) + 1 :]
    else:
        return None

    canonical_options = (
        f"--project-dir={project_dir.resolve()} "
        f"--output={output_dir.resolve()}"
    )
    if options not in {"", canonical_options}:
        return None
    return SupervisorIdentity(
        pid=pid,
        started_at=started_at,
        arguments=arguments,
    )


def find_supervisor_identities(
    config: RuntimeConfig,
    *,
    run_command: CommandRunner = subprocess.run,
) -> tuple[tuple[SupervisorIdentity, ...], tuple[int, ...]]:
    try:
        result = _run_capture(
            ["ps", "-ww", "-axo", "pid=,lstart=,args="],
            run_command=run_command,
        )
    except (OSError, subprocess.SubprocessError):
        return (), (-1,)
    valid: list[SupervisorIdentity] = []
    invalid: list[int] = []
    marker = config.supervisor_path.name
    for raw_line in str(result.stdout).splitlines():
        fields = raw_line.strip().split(None, 6)
        if len(fields) != 7:
            continue
        raw_pid, *rest = fields
        arguments = rest[5]
        if marker not in arguments:
            continue
        executable = arguments.split(None, 1)[0]
        if "python" not in Path(executable).name.casefold():
            # screen/login/shell wrappers may repeat the script text in
            # their argv, but they are not independent supervisor services.
            continue
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        cwd = _read_process_cwd(pid, run_command=run_command)
        identity = supervisor_identity_from_fields(
            pid,
            " ".join(rest[:5]),
            arguments,
            script_path=config.supervisor_path,
            project_dir=config.project_dir,
            output_dir=config.output_dir,
            cwd=cwd,
        )
        if identity is None:
            invalid.append(pid)
        else:
            valid.append(identity)
    return (
        tuple(sorted(valid, key=lambda value: value.pid)),
        tuple(sorted(set(invalid))),
    )


def read_plan_evidence(
    config: RuntimeConfig,
    *,
    require_quick_check: bool,
) -> PlanEvidence:
    margin = supervisor.read_margin_observation(
        estimate_path=config.estimate_path,
        database_path=config.database_path,
        output_dir=config.output_dir,
        backing_volume=config.backing_volume,
        target_percent=MINIMUM_NORMAL_HEADROOM_PERCENT,
        require_quick_check=require_quick_check,
        expected_scope=supervisor.FULL_MAP_SCOPE,
    )
    configured = margin.configured_percent
    if not margin.valid:
        return PlanEvidence(
            False,
            margin.reason,
            configured,
            False,
            False,
            margin.quick_check_ok,
        )
    if not allowed_headroom_percent(configured):
        return PlanEvidence(
            False,
            "estimate.json no usa 18 exacto ni una reserva >=20",
            configured,
            False,
            False,
            margin.quick_check_ok,
        )
    required = required_bytes_for_percent(
        margin.conservative_remaining_bytes,
        configured,
    )
    free_values = (margin.tile_free_bytes, margin.backing_free_bytes)
    fits = (
        required is not None
        and all(
            isinstance(value, int)
            and not isinstance(value, bool)
            and value >= required
            for value in free_values
        )
    )
    if not fits:
        return PlanEvidence(
            False,
            (
                f"la reserva configurada de {configured:g} % "
                "no cabe en ambos volúmenes"
            ),
            configured,
            True,
            False,
            margin.quick_check_ok,
        )
    return PlanEvidence(
        True,
        "plan completo y reserva vigente verificados",
        configured,
        True,
        True,
        margin.quick_check_ok,
    )


def collect_snapshot(
    config: RuntimeConfig,
    *,
    intent_load: IntentLoad | None = None,
    now_epoch: float | None = None,
    boot_id_reader: Callable[[], str] = read_macos_boot_id,
    volume_reader: Callable[[Path], VolumeObservation] = (
        read_volume_observation
    ),
    supervisor_finder: Callable[
        [RuntimeConfig],
        tuple[tuple[SupervisorIdentity, ...], tuple[int, ...]],
    ] = find_supervisor_identities,
) -> RecoverySnapshot:
    now = time.time() if now_epoch is None else now_epoch
    boot_id = boot_id_reader()
    backing = volume_reader(config.backing_volume)
    map_volume = volume_reader(config.map_volume)
    loaded = read_intent(config.intent_path) if intent_load is None else intent_load

    downloader_identities: list[supervisor.ProcessIdentity] = []
    invalid_downloaders: list[int] = []
    try:
        downloader_pids = supervisor.find_download_processes(
            config.downloader_path,
            config.output_dir,
        )
    except (OSError, subprocess.SubprocessError):
        downloader_pids = [-1]
    for pid in downloader_pids:
        if pid <= 0:
            invalid_downloaders.append(pid)
            continue
        identity = supervisor.read_process_identity(
            pid,
            config.downloader_path,
            config.output_dir,
        )
        if identity is None:
            invalid_downloaders.append(pid)
        else:
            downloader_identities.append(identity)

    supervisor_identities, invalid_supervisors = supervisor_finder(config)
    transition_exists = config.margin_transition_path.exists()
    storage_stop_exists = config.storage_stop_path.exists()
    require_quick_check = (
        map_volume.mounted
        and not downloader_identities
        and not transition_exists
    )
    if map_volume.mounted:
        progress, observed_progress_mtime_ns = read_stable_progress(
            config.progress_path,
            now_epoch=now,
        )
        estimate_sha256_before = hash_regular_file(
            config.estimate_path
        )
        plan = read_plan_evidence(
            config,
            require_quick_check=require_quick_check,
        )
        estimate_sha256_after = hash_regular_file(
            config.estimate_path
        )
        if (
            estimate_sha256_before is None
            or estimate_sha256_before != estimate_sha256_after
        ):
            plan = PlanEvidence(
                False,
                "estimate.json cambió durante la observación",
                None,
                False,
                False,
                plan.quick_check_ok,
            )
            observed_estimate_sha256 = None
        else:
            observed_estimate_sha256 = estimate_sha256_after
        lock_owner = supervisor.owner_pid(config.download_lock)
    else:
        progress = supervisor.ProgressObservation(
            False,
            False,
            "",
            None,
            {},
            None,
        )
        plan = PlanEvidence(
            False,
            "el volumen de tiles no está montado",
            None,
            False,
            False,
            None,
        )
        lock_owner = None
        observed_progress_mtime_ns = None
        observed_estimate_sha256 = None

    return RecoverySnapshot(
        now_epoch=now,
        boot_id=boot_id,
        intent_load=loaded,
        backing_volume=backing,
        map_volume=map_volume,
        image_exists=config.image_path.is_dir(),
        progress=progress,
        progress_mtime_ns=observed_progress_mtime_ns,
        estimate_sha256=observed_estimate_sha256,
        plan=plan,
        downloader_identities=tuple(
            sorted(downloader_identities, key=lambda value: value.pid)
        ),
        invalid_downloader_pids=tuple(
            sorted(set(invalid_downloaders))
        ),
        download_lock_owner=lock_owner,
        supervisor_identities=supervisor_identities,
        invalid_supervisor_pids=invalid_supervisors,
        storage_stop_exists=storage_stop_exists,
        margin_transition_exists=transition_exists,
        supervisor_tool_available=(
            config.supervisor_path.is_file()
            and os.access(config.supervisor_path, os.R_OK)
        ),
        launcher_tool_available=(
            config.launcher_path.is_file()
            and os.access(config.launcher_path, os.R_OK | os.X_OK)
            and config.downloader_path.is_file()
            and os.access(config.downloader_path, os.R_OK)
            and config.vendor_pythonpath.is_dir()
            and os.access(config.vendor_pythonpath, os.R_OK | os.X_OK)
        ),
    )


def intent_matches_config(
    intent: RecoveryIntent,
    config: RuntimeConfig,
) -> bool:
    return (
        intent.project_dir == canonical_path(config.project_dir)
        and intent.output_dir == canonical_path(config.output_dir)
        and intent.backing_volume
        == canonical_path(config.backing_volume)
        and intent.map_volume == canonical_path(config.map_volume)
        and intent.image_path == canonical_path(config.image_path)
        and intent.dimensions == CANONICAL_DIMENSIONS
        and intent.layers == CANONICAL_LAYERS
        and intent.lods == CANONICAL_LODS
        and allowed_headroom_percent(
            intent.configured_headroom_percent
        )
    )


def recent_restart_attempts(
    intent: RecoveryIntent,
    *,
    now_epoch: float,
) -> tuple[tuple[RestartAttempt, ...], str | None]:
    recent: list[RestartAttempt] = []
    for attempt in intent.restart_attempts:
        if attempt.at_epoch > now_epoch:
            return (), "el historial contiene un intento en el futuro"
        if now_epoch - attempt.at_epoch <= RESTART_WINDOW_SECONDS:
            recent.append(attempt)
    return tuple(recent), None


def identity_matches_binding(
    identity: supervisor.ProcessIdentity,
    intent: RecoveryIntent,
) -> bool:
    return (
        identity.pid == intent.bound_process_pid
        and identity.started_at == intent.bound_process_started_at
        and process_arguments_sha256(identity)
        == intent.bound_process_arguments_sha256
    )


def artifacts_are_not_older(
    snapshot: RecoverySnapshot,
    intent: RecoveryIntent,
) -> bool:
    return (
        snapshot.progress_mtime_ns is not None
        and snapshot.progress_mtime_ns
        >= intent.progress_mtime_ns_floor
        and snapshot.estimate_sha256 is not None
    )


def replacement_identity_is_authorized(
    snapshot: RecoverySnapshot,
    intent: RecoveryIntent,
) -> bool:
    if snapshot.boot_id != intent.armed_boot_id:
        return True
    attempts, error = recent_restart_attempts(
        intent,
        now_epoch=snapshot.now_epoch,
    )
    return error is None and any(
        attempt.boot_id == snapshot.boot_id
        and attempt.at_epoch >= intent.armed_at_epoch
        for attempt in attempts
    )


def restart_budget_decision(
    intent: RecoveryIntent,
    *,
    now_epoch: float,
) -> RecoveryDecision | None:
    recent, error = recent_restart_attempts(
        intent,
        now_epoch=now_epoch,
    )
    if error is not None:
        return RecoveryDecision("stop", error)
    if len(recent) >= MAX_RESTARTS:
        return RecoveryDecision(
            "stop",
            "se agotó el presupuesto durable de 3 reinicios en 24 horas",
        )
    return None


def _progress_gate(
    progress: supervisor.ProgressObservation,
) -> RecoveryDecision | None:
    if not progress.exists:
        return RecoveryDecision("stop", "progress.json no existe")
    if not progress.valid:
        return RecoveryDecision(
            "stop",
            "progress.json no contiene JSON válido",
        )
    if progress.status in supervisor.COMPLETE_STATUSES:
        return RecoveryDecision(
            "complete",
            f"la descarga terminó con estado {progress.status}",
        )
    if progress.status not in supervisor.ACTIVE_STATUSES:
        return RecoveryDecision(
            "stop",
            f"estado no reanudable: {progress.status or 'vacío'}",
        )
    signal = supervisor.safety_signal(progress)
    if signal is not None:
        return RecoveryDecision("stop", signal)
    return None


def safe_live_stack_for_refresh(
    snapshot: RecoverySnapshot,
    config: RuntimeConfig,
    intent: RecoveryIntent,
) -> bool:
    """Authorize only the supervisor-owned upgrade from 18 to >=20."""

    if (
        snapshot.storage_stop_exists
        or snapshot.margin_transition_exists
        or snapshot.invalid_downloader_pids
        or snapshot.invalid_supervisor_pids
        or len(snapshot.downloader_identities) != 1
        or len(snapshot.supervisor_identities) != 1
        or not snapshot.plan.valid
        or not snapshot.plan.full_scope
        or not snapshot.plan.fits_configured
        or not allowed_headroom_percent(
            snapshot.plan.configured_headroom_percent
        )
        or snapshot.progress_mtime_ns is None
        or snapshot.progress_mtime_ns
        < intent.progress_mtime_ns_floor
        or snapshot.estimate_sha256 is None
        or intent.configured_headroom_percent
        != TEMPORARY_HEADROOM_PERCENT
        or snapshot.plan.configured_headroom_percent is None
        or snapshot.plan.configured_headroom_percent
        < MINIMUM_NORMAL_HEADROOM_PERCENT
    ):
        return False
    identity = snapshot.downloader_identities[0]
    return (
        snapshot.download_lock_owner == identity.pid
        and same_number(
            identity.headroom_percent,
            snapshot.plan.configured_headroom_percent,
        )
        and supervisor.healthy_active_heartbeat(
            snapshot.progress,
            maximum_age_seconds=config.maximum_heartbeat_age,
        )
    )


def decide_recovery(
    snapshot: RecoverySnapshot,
    config: RuntimeConfig,
) -> RecoveryDecision:
    """Pure decision function; it never writes, launches, mounts, or signals."""

    if snapshot.storage_stop_exists:
        return RecoveryDecision(
            "stop",
            "storage_stop.json domina toda recuperación automática",
        )
    if not valid_boot_id(snapshot.boot_id):
        return RecoveryDecision(
            "stop",
            "el boot ID observado no es canónico",
        )
    loaded = snapshot.intent_load
    if not loaded.exists:
        return RecoveryDecision(
            "stop",
            "no existe intención durable; primero use --arm",
        )
    if loaded.intent is None:
        return RecoveryDecision(
            "stop",
            f"intención durable inválida: {loaded.error or 'sin detalle'}",
        )
    intent = loaded.intent
    if not intent_matches_config(intent, config):
        return RecoveryDecision(
            "stop",
            "la intención no coincide con la configuración local fija",
        )
    if (
        intent.armed_at_epoch > snapshot.now_epoch
        or (
            intent.adopted_at_epoch is not None
            and intent.adopted_at_epoch > snapshot.now_epoch
        )
    ):
        return RecoveryDecision(
            "stop",
            "la intención contiene una marca temporal en el futuro",
        )
    _recent_attempts, attempts_error = recent_restart_attempts(
        intent,
        now_epoch=snapshot.now_epoch,
    )
    if attempts_error is not None:
        return RecoveryDecision("stop", attempts_error)

    if not snapshot.backing_volume.mounted:
        return RecoveryDecision(
            "wait",
            "la unidad LuisA todavía no está montada",
        )
    if (
        snapshot.backing_volume.volume_uuid is None
        or snapshot.backing_volume.volume_uuid
        != intent.backing_volume_uuid
    ):
        return RecoveryDecision(
            "stop",
            "el UUID de LuisA no coincide con la intención armada",
        )
    if not snapshot.image_exists:
        return RecoveryDecision(
            "stop",
            "no existe el sparsebundle fijo esperado",
        )
    if not snapshot.map_volume.mounted:
        return RecoveryDecision(
            "attach_tiles",
            "LuisA es auténtica; falta adjuntar el sparsebundle fijo",
            requires_execute=True,
        )
    if (
        snapshot.map_volume.volume_uuid is None
        or snapshot.map_volume.volume_uuid != intent.map_volume_uuid
    ):
        return RecoveryDecision(
            "stop",
            "el UUID del volumen de tiles no coincide con la intención",
        )

    if snapshot.invalid_downloader_pids:
        return RecoveryDecision(
            "stop",
            "hay un proceso descargador que no tiene identidad canónica",
        )
    if len(snapshot.downloader_identities) > 1:
        return RecoveryDecision(
            "stop",
            "hay más de un descargador canónico",
        )
    if snapshot.invalid_supervisor_pids:
        return RecoveryDecision(
            "stop",
            "hay un proceso supervisor que no tiene identidad canónica",
        )
    if len(snapshot.supervisor_identities) > 1:
        return RecoveryDecision(
            "stop",
            "hay más de un supervisor canónico",
        )

    # A transition journal represents a supervisor-owned transaction.  Its
    # expected stopped status and storage proof are validated by that module.
    if snapshot.margin_transition_exists:
        if snapshot.supervisor_identities:
            return RecoveryDecision(
                "adopt_existing",
                "el supervisor existente es dueño de margin_transition.json",
                may_adopt=True,
            )
        if not snapshot.supervisor_tool_available:
            return RecoveryDecision(
                "wait",
                "el supervisor fijo no está accesible en este contexto",
            )
        budget_stop = restart_budget_decision(
            intent,
            now_epoch=snapshot.now_epoch,
        )
        if budget_stop is not None:
            return budget_stop
        return RecoveryDecision(
            "launch_transition_supervisor",
            "margin_transition.json solo puede recuperarlo el supervisor",
            requires_execute=True,
            consumes_restart_budget=True,
        )

    interrupted_by_prior_boot = (
        snapshot.boot_id != intent.armed_boot_id
        and not (
            intent.state == "adopted"
            and intent.adopted_boot_id == snapshot.boot_id
        )
        and not snapshot.storage_stop_exists
        and not snapshot.margin_transition_exists
        and not snapshot.downloader_identities
        and not snapshot.supervisor_identities
        and snapshot.progress.exists
        and snapshot.progress.valid
        and snapshot.progress.status == "stopped"
        and snapshot.progress.reason == "interrumpido"
        and snapshot.progress.http_errors.get("403", 0) == 0
        and snapshot.progress.http_errors.get("429", 0) == 0
    )
    progress_gate = (
        None
        if interrupted_by_prior_boot
        else _progress_gate(snapshot.progress)
    )
    if progress_gate is not None:
        return progress_gate
    if not snapshot.plan.valid or not snapshot.plan.full_scope:
        return RecoveryDecision("stop", snapshot.plan.reason)
    if not same_number(
        snapshot.plan.configured_headroom_percent,
        intent.configured_headroom_percent,
    ):
        if safe_live_stack_for_refresh(snapshot, config, intent):
            return RecoveryDecision(
                "refresh_binding",
                (
                    "stack canónico sano; se actualizará la reserva y "
                    "el binding durable"
                ),
                may_adopt=True,
            )
        return RecoveryDecision(
            "stop",
            "estimate.json ya no coincide con la reserva armada",
        )
    if not snapshot.plan.fits_configured:
        return RecoveryDecision(
            "stop",
            "la reserva vigente ya no cabe en ambos volúmenes",
        )
    if (
        snapshot.progress_mtime_ns is None
        or snapshot.progress_mtime_ns
        < intent.progress_mtime_ns_floor
    ):
        return RecoveryDecision(
            "stop",
            "progress.json es anterior al piso ligado por --arm",
        )
    if snapshot.estimate_sha256 is None:
        return RecoveryDecision(
            "stop",
            "no se pudo verificar el hash de estimate.json",
        )

    downloader = (
        snapshot.downloader_identities[0]
        if snapshot.downloader_identities
        else None
    )
    if downloader is not None:
        if not supervisor.healthy_active_heartbeat(
            snapshot.progress,
            maximum_age_seconds=config.maximum_heartbeat_age,
        ):
            return RecoveryDecision(
                "wait",
                "el descargador está vivo, pero su heartbeat no está fresco",
            )
        if not same_number(
            downloader.headroom_percent,
            snapshot.plan.configured_headroom_percent,
        ):
            return RecoveryDecision(
                "stop",
                "la reserva del PID no coincide con estimate.json",
            )
        if snapshot.download_lock_owner != downloader.pid:
            return RecoveryDecision(
                "stop",
                "el lock no pertenece al descargador canónico",
            )
        bound_identity = identity_matches_binding(downloader, intent)
        replacement_allowed = replacement_identity_is_authorized(
            snapshot,
            intent,
        )
        estimate_matches = (
            snapshot.estimate_sha256 == intent.estimate_sha256
        )
        if (
            (not bound_identity or not estimate_matches)
            and safe_live_stack_for_refresh(snapshot, config, intent)
        ):
            return RecoveryDecision(
                "refresh_binding",
                "stack canónico sano; se renovará el binding durable",
                may_adopt=True,
            )
        if not bound_identity and not replacement_allowed:
            return RecoveryDecision(
                "stop",
                "la identidad viva no coincide con la ligada por --arm",
            )
        if (
            not estimate_matches
            and not replacement_allowed
        ):
            return RecoveryDecision(
                "stop",
                "estimate.json cambió sin un reboot o intento durable",
            )
        if snapshot.supervisor_identities:
            return RecoveryDecision(
                "adopt_existing",
                "descargador y supervisor canónicos ya están activos",
                may_adopt=True,
            )
        if not snapshot.supervisor_tool_available:
            return RecoveryDecision(
                "wait",
                "el supervisor fijo no está accesible en este contexto",
            )
        return RecoveryDecision(
            "launch_supervisor",
            "se adoptará el descargador vivo sin cambiar su PID",
            requires_execute=True,
        )

    if snapshot.estimate_sha256 != intent.estimate_sha256:
        return RecoveryDecision(
            "stop",
            "estimate.json cambió desde que se armó la recuperación",
        )
    if snapshot.supervisor_identities:
        return RecoveryDecision(
            "adopt_existing",
            "el supervisor canónico ya gestiona la recuperación",
            may_adopt=True,
        )
    if snapshot.plan.quick_check_ok is not True:
        return RecoveryDecision(
            "stop",
            "tiles.sqlite3 no superó PRAGMA quick_check antes del reinicio",
        )
    if (
        not snapshot.launcher_tool_available
        or not snapshot.supervisor_tool_available
    ):
        return RecoveryDecision(
            "wait",
            "los ejecutables fijos no están accesibles en este contexto",
        )

    attempts, attempts_error = recent_restart_attempts(
        intent,
        now_epoch=snapshot.now_epoch,
    )
    if attempts_error is not None:
        return RecoveryDecision("stop", attempts_error)
    attempted_this_boot = any(
        attempt.boot_id == snapshot.boot_id
        and attempt.at_epoch >= intent.armed_at_epoch
        for attempt in attempts
    )
    reboot_observed = snapshot.boot_id != intent.armed_boot_id
    adopted_this_boot = (
        intent.state == "adopted"
        and intent.adopted_boot_id == snapshot.boot_id
    )
    if (
        not reboot_observed
        and not attempted_this_boot
        and not adopted_this_boot
    ):
        return RecoveryDecision(
            "wait",
            "no se observó un reboot ni un intento previo de esta recuperación",
        )
    budget_stop = restart_budget_decision(
        intent,
        now_epoch=snapshot.now_epoch,
    )
    if budget_stop is not None:
        return budget_stop
    return RecoveryDecision(
        "launch_stack",
        "reboot confirmado; se puede lanzar el stack fijo una vez",
        requires_execute=True,
        consumes_restart_budget=True,
    )


def decide_arm(
    snapshot: RecoverySnapshot,
    config: RuntimeConfig,
) -> RecoveryDecision:
    """Pure gate for persisting a new intent."""

    if not valid_boot_id(snapshot.boot_id):
        return RecoveryDecision(
            "stop",
            "el boot ID observado no es canónico",
        )
    if snapshot.storage_stop_exists:
        return RecoveryDecision(
            "stop",
            "storage_stop.json impide armar recuperación",
        )
    if snapshot.margin_transition_exists:
        return RecoveryDecision(
            "stop",
            "no se arma durante una transición de margen",
        )
    if (
        not snapshot.backing_volume.mounted
        or snapshot.backing_volume.volume_uuid is None
    ):
        return RecoveryDecision(
            "stop",
            "LuisA no está montada con UUID verificable",
        )
    if (
        not snapshot.map_volume.mounted
        or snapshot.map_volume.volume_uuid is None
    ):
        return RecoveryDecision(
            "stop",
            "el volumen de tiles no está montado con UUID verificable",
        )
    if not snapshot.image_exists:
        return RecoveryDecision(
            "stop",
            "no existe el sparsebundle fijo esperado",
        )
    if (
        snapshot.invalid_downloader_pids
        or len(snapshot.downloader_identities) != 1
    ):
        return RecoveryDecision(
            "stop",
            "se requiere exactamente un descargador canónico vivo",
        )
    if snapshot.invalid_supervisor_pids or len(
        snapshot.supervisor_identities
    ) > 1:
        return RecoveryDecision(
            "stop",
            "el supervisor existente no es único y canónico",
        )
    downloader = snapshot.downloader_identities[0]
    if snapshot.download_lock_owner != downloader.pid:
        return RecoveryDecision(
            "stop",
            "el lock no pertenece al descargador canónico",
        )
    progress_gate = _progress_gate(snapshot.progress)
    if progress_gate is not None:
        return RecoveryDecision("stop", progress_gate.reason)
    if (
        snapshot.progress.age_seconds is None
        or snapshot.progress.age_seconds
        > config.maximum_heartbeat_age
    ):
        return RecoveryDecision(
            "stop",
            "el heartbeat activo no está fresco",
        )
    if (
        not snapshot.plan.valid
        or not snapshot.plan.full_scope
        or not snapshot.plan.fits_configured
    ):
        return RecoveryDecision("stop", snapshot.plan.reason)
    if (
        snapshot.progress_mtime_ns is None
        or snapshot.estimate_sha256 is None
    ):
        return RecoveryDecision(
            "stop",
            "no se pudieron ligar progress.json y estimate.json",
        )
    if not same_number(
        downloader.headroom_percent,
        snapshot.plan.configured_headroom_percent,
    ):
        return RecoveryDecision(
            "stop",
            "la reserva del PID no coincide con estimate.json",
        )
    return RecoveryDecision(
        "arm",
        "descarga completa viva, alcance, UUIDs y reserva verificados",
    )


def prune_attempts(
    attempts: Sequence[RestartAttempt],
    *,
    now_epoch: float,
) -> tuple[RestartAttempt, ...]:
    recent: list[RestartAttempt] = []
    for attempt in attempts:
        if attempt.at_epoch > now_epoch:
            raise ValueError(
                "el historial contiene un intento en el futuro"
            )
        if now_epoch - attempt.at_epoch <= RESTART_WINDOW_SECONDS:
            recent.append(attempt)
    return tuple(recent)


def build_armed_intent(
    snapshot: RecoverySnapshot,
    config: RuntimeConfig,
) -> RecoveryIntent:
    configured = snapshot.plan.configured_headroom_percent
    if (
        configured is None
        or snapshot.backing_volume.volume_uuid is None
        or snapshot.map_volume.volume_uuid is None
        or snapshot.progress_mtime_ns is None
        or snapshot.estimate_sha256 is None
        or len(snapshot.downloader_identities) != 1
    ):
        raise ValueError("snapshot no satisface las compuertas de armado")
    prior_attempts: tuple[RestartAttempt, ...] = ()
    prior = snapshot.intent_load.intent
    if (
        prior is not None
        and intent_matches_config(prior, config)
        and prior.backing_volume_uuid
        == snapshot.backing_volume.volume_uuid
        and prior.map_volume_uuid == snapshot.map_volume.volume_uuid
    ):
        prior_attempts = prune_attempts(
            prior.restart_attempts,
            now_epoch=snapshot.now_epoch,
        )
    return RecoveryIntent(
        state="armed",
        armed_at_epoch=snapshot.now_epoch,
        armed_boot_id=snapshot.boot_id,
        adopted_at_epoch=None,
        adopted_boot_id=None,
        project_dir=canonical_path(config.project_dir),
        output_dir=canonical_path(config.output_dir),
        backing_volume=canonical_path(config.backing_volume),
        map_volume=canonical_path(config.map_volume),
        image_path=canonical_path(config.image_path),
        backing_volume_uuid=snapshot.backing_volume.volume_uuid,
        map_volume_uuid=snapshot.map_volume.volume_uuid,
        dimensions=CANONICAL_DIMENSIONS,
        layers=CANONICAL_LAYERS,
        lods=CANONICAL_LODS,
        configured_headroom_percent=configured,
        bound_process_pid=snapshot.downloader_identities[0].pid,
        bound_process_started_at=(
            snapshot.downloader_identities[0].started_at
        ),
        bound_process_arguments_sha256=process_arguments_sha256(
            snapshot.downloader_identities[0]
        ),
        progress_mtime_ns_floor=int(snapshot.progress_mtime_ns),
        estimate_sha256=str(snapshot.estimate_sha256),
        restart_attempts=prior_attempts,
    )


def adopt_intent(
    intent: RecoveryIntent,
    *,
    boot_id: str,
    now_epoch: float,
    snapshot: RecoverySnapshot | None = None,
    refresh_binding: bool = False,
) -> RecoveryIntent:
    already_adopted_this_boot = (
        intent.state == "adopted"
        and intent.adopted_boot_id == boot_id
    )
    replacements: dict[str, object] = {
        "state": "adopted",
        "adopted_at_epoch": (
            intent.adopted_at_epoch
            if already_adopted_this_boot
            else now_epoch
        ),
        "adopted_boot_id": boot_id,
        "restart_attempts": prune_attempts(
            intent.restart_attempts,
            now_epoch=now_epoch,
        ),
    }
    if (
        refresh_binding
        and snapshot is not None
        and len(snapshot.downloader_identities) == 1
        and snapshot.progress_mtime_ns is not None
        and snapshot.estimate_sha256 is not None
        and allowed_headroom_percent(
            snapshot.plan.configured_headroom_percent
        )
    ):
        identity = snapshot.downloader_identities[0]
        arguments_hash = process_arguments_sha256(identity)
        binding_changed = (
            not same_number(
                snapshot.plan.configured_headroom_percent,
                intent.configured_headroom_percent,
            )
            or identity.pid != intent.bound_process_pid
            or identity.started_at != intent.bound_process_started_at
            or arguments_hash
            != intent.bound_process_arguments_sha256
            or snapshot.estimate_sha256 != intent.estimate_sha256
        )
        replacements.update(
            {
                "configured_headroom_percent": (
                    snapshot.plan.configured_headroom_percent
                ),
                "bound_process_pid": identity.pid,
                "bound_process_started_at": identity.started_at,
                "bound_process_arguments_sha256": arguments_hash,
                "progress_mtime_ns_floor": (
                    snapshot.progress_mtime_ns
                    if binding_changed
                    else intent.progress_mtime_ns_floor
                ),
                "estimate_sha256": snapshot.estimate_sha256,
            }
        )
    candidate = dataclasses.replace(
        intent,
        **replacements,
    )
    return intent if candidate == intent else candidate


def claim_restart_attempt(
    intent: RecoveryIntent,
    decision: RecoveryDecision,
    *,
    boot_id: str,
    now_epoch: float,
) -> RecoveryIntent:
    if (
        not decision.consumes_restart_budget
        or decision.action not in RESTART_ACTIONS
    ):
        raise ValueError("la acción no consume un intento durable")
    budget_stop = restart_budget_decision(
        intent,
        now_epoch=now_epoch,
    )
    if budget_stop is not None:
        raise ValueError(budget_stop.reason)
    recent, error = recent_restart_attempts(
        intent,
        now_epoch=now_epoch,
    )
    if error is not None:
        raise ValueError(error)
    return dataclasses.replace(
        intent,
        restart_attempts=(
            *recent,
            RestartAttempt(
                at_epoch=now_epoch,
                boot_id=boot_id,
                action=decision.action,
            ),
        ),
    )


def fixed_supervisor_argv(config: RuntimeConfig) -> tuple[str, ...]:
    return (
        sys.executable,
        str(config.supervisor_path),
        f"--project-dir={config.project_dir}",
        f"--output={config.output_dir}",
    )


def fixed_attach_argv(config: RuntimeConfig) -> tuple[str, ...]:
    return (
        "/usr/bin/hdiutil",
        "attach",
        "-nobrowse",
        str(config.image_path),
    )


def execution_paths_are_canonical(config: RuntimeConfig) -> bool:
    """The current shell launcher hard-codes these production volume paths."""

    return (
        config.project_dir == DEFAULT_PROJECT_DIR
        and config.vendor_pythonpath
        == DEFAULT_APPLICATION_SUPPORT / "py311-packages"
        and Path(sys.executable).resolve() == EXPECTED_PYTHON
        and config.backing_volume == Path("/Volumes/LuisA")
        and config.map_volume == Path("/Volumes/2b2t Tiles")
        and config.output_dir
        == Path("/Volumes/2b2t Tiles/2b2t_tiles")
        and config.image_path
        == Path(
            "/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle"
        )
    )


def fixed_launcher_environment(
    intent: RecoveryIntent,
    config: RuntimeConfig,
    *,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the only permitted launcher environment from validated facts."""

    del base  # The caller environment is intentionally not inherited.
    environment = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    }
    percent = intent.configured_headroom_percent
    if not allowed_headroom_percent(percent):
        raise ValueError("la intención no contiene una reserva permitida")
    # Keep TCC attribution on the exact interpreter that launchd used; the
    # shell launcher must not fall back to Apple's /usr/bin/python3.
    environment["PYTHON_BIN"] = sys.executable
    environment["PYTHONPATH"] = str(config.vendor_pythonpath)
    environment["SPACE_HEADROOM_PERCENT"] = repr(float(percent))
    environment["OBSIDIAN_ATLAS_RECOVERY_AUTHORIZED"] = "1"
    environment.pop("ALLOW_TEMPORARY_HEADROOM_MIGRATION", None)
    if percent == TEMPORARY_HEADROOM_PERCENT:
        environment["ALLOW_TEMPORARY_HEADROOM_MIGRATION"] = "1"
    return environment


def fixed_supervisor_environment(
    config: RuntimeConfig,
    *,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Keep every supervisor replacement on the authorized Python runtime."""

    del base
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHON_BIN": sys.executable,
        "PYTHONPATH": str(config.vendor_pythonpath),
    }


def _launch_detached(
    argv: Sequence[str],
    *,
    cwd: Path,
    environment: Mapping[str, str] | None,
    popen: ProcessLauncher,
) -> None:
    popen(
        list(argv),
        cwd=cwd,
        env=None if environment is None else dict(environment),
        start_new_session=True,
        close_fds=True,
    )


def _wait_for_downloader(
    config: RuntimeConfig,
    *,
    expected_percent: float,
    launched_after: float,
    deadline: float,
    monotonic: Callable[[], float],
    sleep: Callable[[float], None],
) -> bool:
    while monotonic() < deadline:
        try:
            pids = supervisor.find_download_processes(
                config.downloader_path,
                config.output_dir,
            )
        except (OSError, subprocess.SubprocessError):
            pids = []
        if len(pids) == 1:
            identity = supervisor.read_process_identity(
                pids[0],
                config.downloader_path,
                config.output_dir,
            )
            if (
                identity is not None
                and same_number(
                    identity.headroom_percent,
                    expected_percent,
                )
                and supervisor.owner_pid(config.download_lock)
                == identity.pid
            ):
                progress, observed_mtime_ns = read_stable_progress(
                    config.progress_path
                )
                progress_is_new = (
                    observed_mtime_ns is not None
                    and observed_mtime_ns
                    >= int(launched_after * 1_000_000_000)
                )
                if (
                    progress_is_new
                    and supervisor.healthy_active_heartbeat(
                        progress,
                        maximum_age_seconds=(
                            config.maximum_heartbeat_age
                        ),
                    )
                ):
                    return True
        if len(pids) > 1:
            return False
        sleep(1.0)
    return False


def _wait_for_supervisor(
    config: RuntimeConfig,
    *,
    deadline: float,
    monotonic: Callable[[], float],
    sleep: Callable[[float], None],
    supervisor_finder: Callable[
        [RuntimeConfig],
        tuple[tuple[SupervisorIdentity, ...], tuple[int, ...]],
    ],
) -> bool:
    while monotonic() < deadline:
        identities, invalid = supervisor_finder(config)
        if len(identities) == 1 and not invalid:
            return True
        if len(identities) > 1 or invalid:
            return False
        sleep(1.0)
    return False


def execute_decision(
    decision: RecoveryDecision,
    snapshot: RecoverySnapshot,
    config: RuntimeConfig,
    *,
    run_command: CommandRunner = subprocess.run,
    popen: ProcessLauncher = subprocess.Popen,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    supervisor_finder: Callable[
        [RuntimeConfig],
        tuple[tuple[SupervisorIdentity, ...], tuple[int, ...]],
    ] = find_supervisor_identities,
    volume_reader: Callable[[Path], VolumeObservation] = (
        read_volume_observation
    ),
) -> ExecutionResult:
    """Execute one fixed action.  No argv is ever loaded from the intent."""

    if not decision.requires_execute:
        return ExecutionResult(True, "la decisión no requiere ejecución")
    if not execution_paths_are_canonical(config):
        return ExecutionResult(
            False,
            "las rutas o el intérprete no coinciden con el contrato fijo",
        )
    if config.storage_stop_path.exists():
        return ExecutionResult(
            False,
            "storage_stop.json apareció antes de ejecutar; no se actuó",
        )
    if (
        decision.action == "launch_stack"
        and config.margin_transition_path.exists()
    ):
        return ExecutionResult(
            False,
            "margin_transition.json apareció; el downloader no se lanzó",
        )
    if (
        decision.action == "launch_stack"
        and (
            snapshot.estimate_sha256 is None
            or hash_regular_file(config.estimate_path)
            != snapshot.estimate_sha256
        )
    ):
        return ExecutionResult(
            False,
            "estimate.json cambió antes del lanzamiento",
        )
    if decision.action == "attach_tiles":
        intent = snapshot.intent_load.intent
        if intent is None:
            return ExecutionResult(False, "falta la intención validada")
        backing = volume_reader(config.backing_volume)
        if (
            not backing.mounted
            or backing.volume_uuid != intent.backing_volume_uuid
            or not config.image_path.is_dir()
        ):
            return ExecutionResult(
                False,
                "LuisA/UUID/sparsebundle cambiaron antes de adjuntar",
            )
        tiles = volume_reader(config.map_volume)
        if tiles.mounted:
            if tiles.volume_uuid == intent.map_volume_uuid:
                return ExecutionResult(
                    True,
                    "otro starter ya adjuntó el volumen correcto",
                )
            return ExecutionResult(
                False,
                "apareció un volumen de tiles con UUID incorrecto",
            )
    if decision.action in {
        "launch_stack",
        "launch_supervisor",
        "launch_transition_supervisor",
    }:
        intent = snapshot.intent_load.intent
        if intent is None:
            return ExecutionResult(False, "falta la intención validada")
        backing = volume_reader(config.backing_volume)
        tiles = volume_reader(config.map_volume)
        if (
            not backing.mounted
            or backing.volume_uuid != intent.backing_volume_uuid
            or not tiles.mounted
            or tiles.volume_uuid != intent.map_volume_uuid
        ):
            return ExecutionResult(
                False,
                "los mounts/UUID cambiaron antes del lanzamiento",
            )
        existing_supervisors, invalid_supervisors = supervisor_finder(
            config
        )
        if invalid_supervisors or len(existing_supervisors) > 1:
            return ExecutionResult(
                False,
                "la identidad del supervisor cambió antes del lanzamiento",
            )
        if existing_supervisors:
            if decision.action == "launch_stack":
                return ExecutionResult(
                    False,
                    "apareció un supervisor; el stack no se lanzó",
                )
            return ExecutionResult(
                True,
                "otro starter ya lanzó el supervisor canónico",
            )
    if decision.action == "attach_tiles":
        try:
            run_command(
                list(fixed_attach_argv(config)),
                check=True,
                cwd=config.project_dir,
                timeout=config.startup_timeout,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return ExecutionResult(
                False,
                f"no se pudo adjuntar el sparsebundle fijo: {exc}",
            )
        return ExecutionResult(
            True,
            "se solicitó adjuntar el sparsebundle fijo",
        )

    if decision.action in {
        "launch_supervisor",
        "launch_transition_supervisor",
    }:
        try:
            _launch_detached(
                fixed_supervisor_argv(config),
                cwd=config.project_dir,
                environment=fixed_supervisor_environment(config),
                popen=popen,
            )
        except OSError as exc:
            return ExecutionResult(
                False,
                f"no se pudo lanzar el supervisor fijo: {exc}",
            )
        deadline = monotonic() + config.startup_timeout
        if not _wait_for_supervisor(
            config,
            deadline=deadline,
            monotonic=monotonic,
            sleep=sleep,
            supervisor_finder=supervisor_finder,
        ):
            return ExecutionResult(
                False,
                "no apareció un supervisor canónico único",
            )
        return ExecutionResult(True, "supervisor canónico iniciado")

    if decision.action == "launch_stack":
        if not execution_paths_are_canonical(config):
            return ExecutionResult(
                False,
                "el lanzador fijo solo admite las rutas canónicas de LuisA",
            )
        intent = snapshot.intent_load.intent
        if intent is None:
            return ExecutionResult(False, "falta la intención validada")
        percent = intent.configured_headroom_percent
        environment = fixed_launcher_environment(intent, config)
        try:
            launched_after = time.time()
            _launch_detached(
                ("/bin/bash", str(config.launcher_path)),
                cwd=config.project_dir,
                environment=environment,
                popen=popen,
            )
        except OSError as exc:
            return ExecutionResult(
                False,
                f"no se pudo lanzar el descargador fijo: {exc}",
            )
        deadline = monotonic() + config.startup_timeout
        if not _wait_for_downloader(
            config,
            expected_percent=percent,
            launched_after=launched_after,
            deadline=deadline,
            monotonic=monotonic,
            sleep=sleep,
        ):
            return ExecutionResult(
                False,
                "no apareció un descargador canónico único",
            )
        existing_supervisors, invalid_supervisors = supervisor_finder(
            config
        )
        if invalid_supervisors or len(existing_supervisors) > 1:
            return ExecutionResult(
                False,
                "el descargador arrancó, pero el supervisor es ambiguo",
            )
        if not existing_supervisors:
            try:
                _launch_detached(
                    fixed_supervisor_argv(config),
                    cwd=config.project_dir,
                    environment=fixed_supervisor_environment(config),
                    popen=popen,
                )
            except OSError as exc:
                return ExecutionResult(
                    False,
                    (
                        "el descargador arrancó, pero no se pudo lanzar "
                        f"el supervisor: {exc}"
                    ),
                )
        supervisor_deadline = monotonic() + config.startup_timeout
        if not _wait_for_supervisor(
            config,
            deadline=supervisor_deadline,
            monotonic=monotonic,
            sleep=sleep,
            supervisor_finder=supervisor_finder,
        ):
            return ExecutionResult(
                False,
                "el descargador arrancó, pero el supervisor no fue adoptable",
            )
        return ExecutionResult(True, "stack canónico iniciado")

    return ExecutionResult(False, "acción ejecutable desconocida")


def _decision_payload(
    decision: RecoveryDecision,
    *,
    mode: str,
    executed: bool,
    execution_reason: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "mode": mode,
        "action": decision.action,
        "reason": decision.reason,
        "requires_execute": decision.requires_execute,
        "consumes_restart_budget": (
            decision.consumes_restart_budget
        ),
        "executed": executed,
    }
    if execution_reason is not None:
        payload["execution_reason"] = execution_reason
    return payload


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    project_dir = DEFAULT_PROJECT_DIR
    default_state = DEFAULT_APPLICATION_SUPPORT / "recovery_intent.json"
    parser = argparse.ArgumentParser(
        description=(
            "Coordina una sola pasada de recuperación segura tras login."
        )
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--arm",
        action="store_true",
        help="Persiste intención solo desde una descarga canónica viva.",
    )
    mode.add_argument(
        "--check-only",
        action="store_true",
        help="No escribe ni ejecuta; solo informa la decisión.",
    )
    mode.add_argument(
        "--execute",
        action="store_true",
        help="Permite una acción fija después de todas las compuertas.",
    )
    parser.add_argument("--project-dir", type=Path, default=project_dir)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/Volumes/2b2t Tiles/2b2t_tiles"),
    )
    parser.add_argument(
        "--backing-volume",
        type=Path,
        default=Path("/Volumes/LuisA"),
    )
    parser.add_argument(
        "--map-volume",
        type=Path,
        default=Path("/Volumes/2b2t Tiles"),
    )
    parser.add_argument(
        "--image",
        type=Path,
        default=Path(
            "/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle"
        ),
    )
    parser.add_argument("--intent-path", type=Path, default=default_state)
    parser.add_argument(
        "--vendor-pythonpath",
        type=Path,
        default=DEFAULT_APPLICATION_SUPPORT / "py311-packages",
        help=(
            "Directorio fijo de dependencias vendorizadas para Python 3.11."
        ),
    )
    parser.add_argument(
        "--maximum-heartbeat-age",
        type=float,
        default=60.0,
    )
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    args = parser.parse_args(argv)
    if (
        not math.isfinite(args.maximum_heartbeat_age)
        or args.maximum_heartbeat_age <= 0
    ):
        parser.error("--maximum-heartbeat-age debe ser mayor que cero")
    if (
        not math.isfinite(args.startup_timeout)
        or args.startup_timeout <= 0
    ):
        parser.error("--startup-timeout debe ser mayor que cero")
    return args


def config_from_args(args: argparse.Namespace) -> RuntimeConfig:
    return RuntimeConfig(
        project_dir=args.project_dir.expanduser().resolve(),
        output_dir=args.output.expanduser().resolve(),
        backing_volume=args.backing_volume.expanduser().resolve(),
        map_volume=args.map_volume.expanduser().resolve(),
        image_path=args.image.expanduser().resolve(),
        intent_path=args.intent_path.expanduser().resolve(),
        vendor_pythonpath=args.vendor_pythonpath.expanduser().resolve(),
        maximum_heartbeat_age=args.maximum_heartbeat_age,
        startup_timeout=args.startup_timeout,
    )


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    config = config_from_args(args)
    lock: Any | None = None
    if not args.check_only:
        try:
            lock = acquire_intent_lock(config.intent_path)
        except (OSError, RuntimeError) as exc:
            print(
                json.dumps(
                    {
                        "mode": "startup",
                        "action": "stop",
                        "reason": str(exc),
                        "executed": False,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 4
    try:
        try:
            snapshot = collect_snapshot(config)
        except RuntimeError as exc:
            print(
                json.dumps(
                    {
                        "mode": "startup",
                        "action": "stop",
                        "reason": str(exc),
                        "executed": False,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 4

        if args.arm:
            decision = decide_arm(snapshot, config)
            if decision.action != "arm":
                print(
                    json.dumps(
                        _decision_payload(
                            decision,
                            mode="arm",
                            executed=False,
                        ),
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 2
            try:
                intent = build_armed_intent(snapshot, config)
                write_intent(config.intent_path, intent)
            except (ValueError, DurableWriteError) as exc:
                print(
                    json.dumps(
                        _decision_payload(
                            RecoveryDecision("stop", str(exc)),
                            mode="arm",
                            executed=False,
                        ),
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 4
            print(
                json.dumps(
                    _decision_payload(
                        decision,
                        mode="arm",
                        executed=True,
                        execution_reason="intención persistida con fsync",
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        decision = decide_recovery(snapshot, config)
        mode = (
            "check-only"
            if args.check_only
            else ("execute" if args.execute else "default")
        )
        if args.check_only:
            print(
                json.dumps(
                    _decision_payload(
                        decision,
                        mode=mode,
                        executed=False,
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0 if decision.action not in {"stop"} else 2

        intent = snapshot.intent_load.intent
        if decision.may_adopt and intent is not None:
            adopted = adopt_intent(
                intent,
                boot_id=snapshot.boot_id,
                now_epoch=snapshot.now_epoch,
                snapshot=snapshot,
                refresh_binding=(
                    decision.action == "refresh_binding"
                    or (
                        decision.action == "adopt_existing"
                        and not snapshot.margin_transition_exists
                        and len(snapshot.downloader_identities) == 1
                    )
                ),
            )
            if adopted != intent:
                try:
                    write_intent(config.intent_path, adopted)
                except DurableWriteError as exc:
                    decision = RecoveryDecision("stop", str(exc))
                    print(
                        json.dumps(
                            _decision_payload(
                                decision,
                                mode=mode,
                                executed=False,
                            ),
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                    return 4
            print(
                json.dumps(
                    _decision_payload(
                        decision,
                        mode=mode,
                        executed=False,
                        execution_reason=(
                            "servicio existente adoptado; PID sin cambios"
                        ),
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        if not args.execute or not decision.requires_execute:
            print(
                json.dumps(
                    _decision_payload(
                        decision,
                        mode=mode,
                        executed=False,
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            if decision.action == "stop":
                return 2
            if decision.action == "wait":
                return 3
            return 0

        if intent is None:
            print(
                json.dumps(
                    _decision_payload(
                        RecoveryDecision(
                            "stop",
                            "falta la intención validada",
                        ),
                        mode=mode,
                        executed=False,
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 2

        try:
            prelaunch_snapshot = collect_snapshot(config)
        except RuntimeError as exc:
            print(
                json.dumps(
                    _decision_payload(
                        RecoveryDecision("stop", str(exc)),
                        mode=mode,
                        executed=False,
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 4
        prelaunch_decision = decide_recovery(
            prelaunch_snapshot,
            config,
        )
        if prelaunch_decision.action != decision.action:
            print(
                json.dumps(
                    _decision_payload(
                        prelaunch_decision,
                        mode=mode,
                        executed=False,
                        execution_reason=(
                            "el estado cambió antes del lanzamiento"
                        ),
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 2 if prelaunch_decision.action == "stop" else 3
        snapshot = prelaunch_snapshot
        decision = prelaunch_decision
        intent = snapshot.intent_load.intent
        if intent is None:
            return 2

        if decision.consumes_restart_budget:
            try:
                claimed = claim_restart_attempt(
                    intent,
                    decision,
                    boot_id=snapshot.boot_id,
                    now_epoch=snapshot.now_epoch,
                )
                write_intent(config.intent_path, claimed)
            except (ValueError, DurableWriteError) as exc:
                print(
                    json.dumps(
                        _decision_payload(
                            RecoveryDecision("stop", str(exc)),
                            mode=mode,
                            executed=False,
                        ),
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 4
            snapshot = dataclasses.replace(
                snapshot,
                intent_load=IntentLoad(True, claimed, None),
            )
            intent = claimed

        result = execute_decision(decision, snapshot, config)
        if result.ok and decision.action != "attach_tiles":
            try:
                post_snapshot = collect_snapshot(
                    config,
                    intent_load=IntentLoad(True, intent, None),
                )
                post_decision = decide_recovery(
                    post_snapshot,
                    config,
                )
            except RuntimeError as exc:
                result = ExecutionResult(
                    False,
                    (
                        f"{result.reason}; no se pudo verificar el estado "
                        f"posterior: {exc}"
                    ),
                )
            else:
                if not post_decision.may_adopt:
                    result = ExecutionResult(
                        False,
                        (
                            f"{result.reason}; el estado posterior no fue "
                            f"adoptable: {post_decision.reason}"
                        ),
                    )
                else:
                    adopted = adopt_intent(
                        intent,
                        boot_id=post_snapshot.boot_id,
                        now_epoch=post_snapshot.now_epoch,
                        snapshot=post_snapshot,
                        refresh_binding=(
                            post_decision.action == "refresh_binding"
                            or (
                                post_decision.action
                                == "adopt_existing"
                                and not post_snapshot.margin_transition_exists
                                and len(
                                    post_snapshot.downloader_identities
                                )
                                == 1
                            )
                        ),
                    )
                    try:
                        write_intent(config.intent_path, adopted)
                    except DurableWriteError as exc:
                        result = ExecutionResult(
                            False,
                            (
                                f"{result.reason}; el servicio quedó activo, "
                                "pero no se persistió la adopción: "
                                f"{exc}"
                            ),
                        )
        print(
            json.dumps(
                _decision_payload(
                    decision,
                    mode=mode,
                    executed=result.ok,
                    execution_reason=result.reason,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if result.ok else 4
    finally:
        if lock is not None:
            lock.close()


if __name__ == "__main__":
    raise SystemExit(run())
