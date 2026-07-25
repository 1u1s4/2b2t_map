#!/usr/bin/env python3
"""Supervisa una descarga larga sin evadir sus paradas de seguridad.

El supervisor adopta una única instancia ya activa. Solo puede reanudarla si
ese PID desaparece sin escribir un estado final y ``progress.json`` sigue en
``running`` o ``discovering`` durante varias comprobaciones. Nunca reinicia
errores, paradas manuales, protección HTTP ni bloqueos de almacenamiento.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import fcntl
import json
import logging
import math
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence


ACTIVE_STATUSES = frozenset({"running", "discovering"})
COMPLETE_STATUSES = frozenset({"complete", "fallback_complete"})
STOP_STATUSES = frozenset(
    {
        "error",
        "incomplete",
        "preflight_blocked",
        "protection",
        "smoke_test_complete",
        "stopped",
    }
)
SAFETY_TERMS = (
    "403",
    "429",
    "bloqueo",
    "contract",
    "contrato",
    "corrupt",
    "disk",
    "disco",
    "enospc",
    "espacio",
    "interrumpido",
    "margen",
    "no cabe",
    "permission",
    "permiso",
    "piso seguro",
    "preflight",
    "protección",
    "protection",
    "rate limit",
    "retry-after",
    "schema",
    "signal",
    "space",
    "user stop",
)
FULL_MAP_DIMENSIONS = frozenset({"overworld", "nether", "end"})
FULL_MAP_LAYERS = frozenset({"base", "overlay", "newchunks"})
FULL_MAP_LODS = frozenset(range(11))
TEMPORARY_MIGRATION_HEADROOM_PERCENT = 18.0
REQUIRED_HEADROOM_PERCENT = 20.0


@dataclasses.dataclass(frozen=True, slots=True)
class ProgressObservation:
    exists: bool
    valid: bool
    status: str
    reason: str | None
    http_errors: dict[str, int]
    age_seconds: float | None


@dataclasses.dataclass(frozen=True, slots=True)
class RestartDecision:
    action: str
    reason: str


@dataclasses.dataclass(frozen=True, slots=True)
class MarginObservation:
    valid: bool
    reason: str
    configured_percent: float | None
    target_percent: float
    conservative_total_bytes: int | None
    existing_complete_bytes: int | None
    conservative_remaining_bytes: int | None
    required_bytes: int | None
    tile_free_bytes: int | None
    backing_free_bytes: int | None
    shortfall_bytes: int | None
    downloading_rows: int | None
    quick_check_ok: bool | None
    fits: bool


@dataclasses.dataclass(frozen=True, slots=True)
class PlanScope:
    dimensions: frozenset[str]
    layers: frozenset[str]
    lods: frozenset[int]


@dataclasses.dataclass(frozen=True, slots=True)
class ProcessIdentity:
    pid: int
    started_at: str
    arguments: str
    headroom_percent: float


@dataclasses.dataclass(frozen=True, slots=True)
class TransitionJournal:
    phase: str
    old_identity: ProcessIdentity
    current_percent: float
    target_percent: float
    signalled_at: float
    selected_percent: float | None = None
    launch_started_at: float | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class StorageStopJournal:
    phase: str
    identity: ProcessIdentity
    process_percent: float
    target_percent: float
    armed_at: float
    progress_written_after: float
    committed_at: float | None = None
    signal_sent_at: float | None = None
    stopped_at: float | None = None


class StorageStopTerminal(RuntimeError):
    """A durable storage stop must never enter restart/recovery logic."""


FULL_MAP_SCOPE = PlanScope(
    dimensions=FULL_MAP_DIMENSIONS,
    layers=FULL_MAP_LAYERS,
    lods=FULL_MAP_LODS,
)


def configure_logging(output_dir: Path) -> logging.Logger:
    logger = logging.getLogger("obsidian_atlas_supervisor")
    logger.setLevel(logging.INFO)
    for handler in logger.handlers:
        handler.close()
    logger.handlers.clear()
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s"
    )
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)
    if output_dir.is_dir():
        file_handler = logging.FileHandler(
            output_dir / "supervisor.log",
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    return logger


def read_progress(path: Path) -> ProgressObservation:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return ProgressObservation(False, False, "", None, {}, None)
    age_seconds = max(0.0, time.time() - stat.st_mtime)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ProgressObservation(
            True, False, "", None, {}, age_seconds
        )
    if not isinstance(payload, dict):
        return ProgressObservation(
            True, False, "", None, {}, age_seconds
        )
    raw_errors = payload.get("http_errors")
    http_errors: dict[str, int] = {}
    if isinstance(raw_errors, dict):
        for code, count in raw_errors.items():
            if isinstance(count, int) and count > 0:
                http_errors[str(code)] = count
    reason = payload.get("reason")
    return ProgressObservation(
        exists=True,
        valid=True,
        status=str(payload.get("status") or "").strip().lower(),
        reason=reason.strip() if isinstance(reason, str) and reason.strip() else None,
        http_errors=http_errors,
        age_seconds=age_seconds,
    )


def safety_signal(observation: ProgressObservation) -> str | None:
    if observation.http_errors.get("403", 0) > 0:
        return "progress.json registra HTTP 403"
    if observation.http_errors.get("429", 0) > 0:
        return "progress.json registra HTTP 429"
    text = (observation.reason or "").casefold()
    for term in SAFETY_TERMS:
        if term in text:
            return f"la razón contiene la señal de seguridad «{term}»"
    return None


def healthy_active_heartbeat(
    observation: ProgressObservation,
    *,
    maximum_age_seconds: float,
) -> bool:
    """Accept only a fresh active heartbeat without a safety signal."""

    return (
        observation.valid
        and observation.status in ACTIVE_STATUSES
        and observation.age_seconds is not None
        and observation.age_seconds <= maximum_age_seconds
        and safety_signal(observation) is None
    )


def clean_planned_stop(observation: ProgressObservation) -> RestartDecision:
    """Accept only the exact final state produced by the requested SIGINT."""

    if not observation.valid:
        return RestartDecision("wait", "progress.json no contiene JSON válido")
    if observation.status != "stopped":
        return RestartDecision(
            "wait",
            f"estado final todavía no es stopped: {observation.status or 'vacío'}",
        )
    if observation.http_errors.get("403", 0) > 0:
        return RestartDecision("stop", "la parada registra HTTP 403")
    if observation.http_errors.get("429", 0) > 0:
        return RestartDecision("stop", "la parada registra HTTP 429")
    if observation.reason != "interrumpido":
        return RestartDecision(
            "stop",
            "la razón final no corresponde al SIGINT planificado",
        )
    return RestartDecision("ready", "parada limpia confirmada")


def decide_replacement_loss_progress(
    observation: ProgressObservation,
    *,
    progress_mtime: float | None,
    signalled_at: float,
    launched_at: float,
) -> RestartDecision:
    """Authorize recovery only from the clean stop or a new active heartbeat."""

    if progress_mtime is None:
        return RestartDecision("stop", "progress.json no existe")
    if progress_mtime >= launched_at:
        if not observation.valid:
            return RestartDecision(
                "stop",
                "progress.json nuevo no contiene JSON válido",
            )
        signal_reason = safety_signal(observation)
        if signal_reason:
            return RestartDecision("stop", signal_reason)
        if observation.status not in ACTIVE_STATUSES:
            return RestartDecision(
                "stop",
                f"el reemplazo terminó con estado {observation.status}",
            )
        return RestartDecision(
            "ready",
            "el reemplazo desapareció dejando un heartbeat activo",
        )
    if progress_mtime < signalled_at:
        return RestartDecision(
            "stop",
            "progress.json es anterior a la transición",
        )
    clean = clean_planned_stop(observation)
    if clean.action != "ready":
        return RestartDecision("stop", clean.reason)
    return clean


def claim_restart_slot(
    restart_times: collections.deque[float],
    *,
    now: float,
    window_seconds: float,
    maximum: int,
) -> bool:
    """Atomically account for one launcher invocation within this process."""

    while restart_times and now - restart_times[0] > window_seconds:
        restart_times.popleft()
    if len(restart_times) >= maximum:
        return False
    restart_times.append(now)
    return True


def decide_after_process_loss(
    observation: ProgressObservation,
    *,
    output_mounted: bool,
    launcher_exists: bool,
    image_exists: bool,
    free_bytes: int | None,
    free_floor_bytes: int | None,
    backing_free_bytes: int | None,
    backing_free_floor_bytes: int | None,
) -> RestartDecision:
    """Return the only safe action after an adopted PID has disappeared."""

    if not observation.exists:
        return RestartDecision("stop", "progress.json no existe")
    if not observation.valid:
        return RestartDecision("stop", "progress.json no contiene JSON válido")
    if observation.status in COMPLETE_STATUSES:
        return RestartDecision("complete", f"estado {observation.status}")
    if observation.status in STOP_STATUSES:
        return RestartDecision("stop", f"estado {observation.status}")
    if observation.status not in ACTIVE_STATUSES:
        return RestartDecision(
            "stop",
            f"estado no reanudable: {observation.status or 'vacío'}",
        )
    signal_reason = safety_signal(observation)
    if signal_reason:
        return RestartDecision("stop", signal_reason)
    if not output_mounted:
        return RestartDecision(
            "stop", "el volumen APFS de tiles no está montado"
        )
    if not image_exists:
        return RestartDecision(
            "stop", "el sparsebundle esperado no está disponible"
        )
    if not launcher_exists:
        return RestartDecision("stop", "el lanzador no existe")
    if free_floor_bytes is None:
        return RestartDecision(
            "stop", "no se pudo determinar el piso seguro de espacio"
        )
    if free_bytes is None:
        return RestartDecision(
            "stop", "no se pudo consultar el espacio libre"
        )
    if free_bytes < free_floor_bytes:
        return RestartDecision(
            "stop",
            "el espacio libre del volumen de tiles está por debajo del piso seguro",
        )
    if backing_free_floor_bytes is None:
        return RestartDecision(
            "stop", "no se pudo determinar el piso seguro de la unidad LuisA"
        )
    if backing_free_bytes is None:
        return RestartDecision(
            "stop", "no se pudo consultar el espacio libre de la unidad LuisA"
        )
    if backing_free_bytes < backing_free_floor_bytes:
        return RestartDecision(
            "stop",
            "el espacio libre de la unidad LuisA está por debajo del piso seguro",
        )
    return RestartDecision(
        "restart",
        "el PID adoptado desapareció y el estado activo quedó sin cierre",
    )


def find_download_processes(
    script_path: Path,
    output_dir: Path,
) -> list[int]:
    """Find only Python processes for this exact script and output."""

    result = subprocess.run(
        ["ps", "-ww", "-axo", "pid=,args="],
        check=True,
        capture_output=True,
        text=True,
    )
    script_text = str(script_path.resolve())
    output_marker = f"--out {output_dir.resolve()}"
    matches: list[int] = []
    for raw_line in result.stdout.splitlines():
        fields = raw_line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        raw_pid, arguments = fields
        executable = arguments.split(None, 1)[0]
        if "python" not in Path(executable).name.casefold():
            continue
        if script_text not in arguments or output_marker not in arguments:
            continue
        try:
            matches.append(int(raw_pid))
        except ValueError:
            continue
    return sorted(set(matches))


def process_identity_from_fields(
    pid: int,
    started_at: str,
    arguments: str,
    script_path: Path,
    output_dir: Path,
) -> ProcessIdentity | None:
    if not arguments:
        return None
    executable = arguments.split(None, 1)[0]
    script_text = str(script_path.resolve())
    output_text = str(output_dir.resolve())
    singleton_patterns = (
        (r"(?:^|\s)--all(?=\s|$)", None),
        (
            r"(?:^|\s)--dimensions(?:=|\s+)",
            r"(?:^|\s)--dimensions(?:=|\s+)"
            r"overworld,nether,end(?=\s|$)",
        ),
        (
            r"(?:^|\s)--layers(?:=|\s+)",
            r"(?:^|\s)--layers(?:=|\s+)"
            r"base,overlay,newchunks(?=\s|$)",
        ),
        (
            r"(?:^|\s)--lods(?:=|\s+)",
            r"(?:^|\s)--lods(?:=|\s+)all(?=\s|$)",
        ),
        (r"(?:^|\s)--resume(?=\s|$)", None),
        (r"(?:^|\s)--skip-smoke-test(?=\s|$)", None),
        (r"(?:^|\s)--no-fallback(?=\s|$)", None),
        (r"(?:^|\s)--out(?:=|\s+)", None),
        (r"(?:^|\s)--space-headroom-percent(?:=|\s+)", None),
    )
    forbidden_mode_patterns = (
        r"(?:^|\s)--estimate-only(?=\s|$)",
        r"(?:^|\s)--smoke-test-only(?=\s|$)",
    )
    output_pattern = (
        r"(?:^|\s)--out(?:=|\s+)"
        + re.escape(output_text)
        + r"(?=\s--|$)"
    )
    headroom_matches = re.findall(
        r"(?:^|\s)--space-headroom-percent(?:=|\s+)"
        r"([0-9]+(?:\.[0-9]+)?)(?=\s|$)",
        arguments,
    )
    if (
        "python" not in Path(executable).name.casefold()
        or not arguments.startswith(f"{executable} {script_text} ")
        or arguments.count(script_text) != 1
        or not re.search(output_pattern, arguments)
        or any(
            re.search(pattern, arguments)
            for pattern in forbidden_mode_patterns
        )
        or any(
            len(re.findall(token_pattern, arguments)) != 1
            or (
                value_pattern is not None
                and not re.search(value_pattern, arguments)
            )
            for token_pattern, value_pattern in singleton_patterns
        )
        or len(headroom_matches) != 1
    ):
        return None
    try:
        headroom_percent = float(headroom_matches[0])
    except ValueError:
        return None
    if not math.isfinite(headroom_percent) or headroom_percent < 0:
        return None
    return ProcessIdentity(
        pid=pid,
        started_at=started_at,
        arguments=arguments,
        headroom_percent=headroom_percent,
    )


def read_process_identity(
    pid: int,
    script_path: Path,
    output_dir: Path,
) -> ProcessIdentity | None:
    """Fingerprint the exact canonical full-map downloader process."""

    try:
        result = subprocess.run(
            [
                "ps",
                "-ww",
                "-p",
                str(pid),
                "-o",
                "lstart=",
                "-o",
                "args=",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    fields = result.stdout.strip().split(None, 5)
    if len(fields) != 6:
        return None
    return process_identity_from_fields(
        pid,
        " ".join(fields[:5]),
        fields[5],
        script_path,
        output_dir,
    )


def read_configured_headroom_percent(path: Path) -> float | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        value = payload["plan"]["space_headroom_percent"]
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
    ):
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or float(value) < 0
    ):
        return None
    return float(value)


def parse_plan_scope(requested: object) -> PlanScope | None:
    if not isinstance(requested, dict):
        return None
    dimensions = requested.get("dimensions")
    layers = requested.get("layers")
    lods = requested.get("lods")
    if (
        not isinstance(dimensions, list)
        or not dimensions
        or not all(isinstance(value, str) and value for value in dimensions)
        or len(set(dimensions)) != len(dimensions)
        or not isinstance(layers, list)
        or not layers
        or not all(isinstance(value, str) and value for value in layers)
        or len(set(layers)) != len(layers)
        or not isinstance(lods, list)
        or not lods
        or not all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in lods
        )
        or len(set(lods)) != len(lods)
    ):
        return None
    return PlanScope(
        dimensions=frozenset(dimensions),
        layers=frozenset(layers),
        lods=frozenset(lods),
    )


def decide_margin_transition(
    observation: MarginObservation,
    progress: ProgressObservation,
    *,
    process_percent: float | None,
    maximum_heartbeat_age: float,
    progress_is_post_launch: bool = True,
) -> RestartDecision:
    """Decide whether one live observation can count toward migration."""

    if not observation.valid:
        return RestartDecision("wait", observation.reason)
    if observation.configured_percent is None:
        return RestartDecision("wait", "falta el porcentaje configurado")
    if not progress.valid or progress.status != "running":
        return RestartDecision(
            "wait",
            f"estado de progreso no es running: {progress.status or 'inválido'}",
        )
    if not progress_is_post_launch:
        return RestartDecision(
            "wait",
            "progress.json todavía es anterior al PID adoptado",
        )
    signal_reason = safety_signal(progress)
    if signal_reason:
        return RestartDecision("stop", signal_reason)
    if (
        progress.age_seconds is None
        or progress.age_seconds > maximum_heartbeat_age
    ):
        return RestartDecision("wait", "el heartbeat no está fresco")
    if process_percent is None:
        return RestartDecision(
            "stop", "no se pudo leer el porcentaje del PID adoptado"
        )
    if not math.isclose(
        process_percent,
        observation.configured_percent,
        rel_tol=0.0,
        abs_tol=1e-9,
    ):
        return RestartDecision(
            "stop",
            "el porcentaje del PID no coincide con estimate.json",
        )
    if not observation.fits or not margin_fits_percent(
        observation,
        observation.target_percent,
    ):
        return RestartDecision(
            "wait",
            f"faltan {observation.shortfall_bytes or 0} bytes",
        )
    if observation.configured_percent >= observation.target_percent:
        return RestartDecision(
            "complete",
            "el proceso ya usa el porcentaje objetivo y todavía cabe",
        )
    return RestartDecision(
        "ready",
        "el margen objetivo cabe y el proceso activo es seguro",
    )


def next_margin_confirmation(
    current: int,
    decision: RestartDecision,
) -> int:
    return max(0, current) + 1 if decision.action == "ready" else 0


def required_storage_bytes(
    conservative_remaining_bytes: int | None,
    percent: float,
) -> int | None:
    if (
        conservative_remaining_bytes is None
        or isinstance(conservative_remaining_bytes, bool)
        or not isinstance(conservative_remaining_bytes, int)
        or conservative_remaining_bytes < 0
        or isinstance(percent, bool)
        or not isinstance(percent, (int, float))
        or not math.isfinite(percent)
        or not float(percent).is_integer()
        or percent < 0
    ):
        return None
    return (
        conservative_remaining_bytes * (100 + int(percent)) + 99
    ) // 100


def margin_fits_percent(
    observation: MarginObservation,
    percent: float,
) -> bool:
    required = required_storage_bytes(
        observation.conservative_remaining_bytes,
        percent,
    )
    free_values = (
        observation.tile_free_bytes,
        observation.backing_free_bytes,
    )
    if (
        required is None
        or any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for value in free_values
        )
    ):
        return False
    return required <= min(free_values)


def decide_restart_storage(
    observation: MarginObservation,
    *,
    restart_percent: float,
) -> RestartDecision:
    """Gate an unexpected restart on the exact remaining-space proof."""

    if not observation.valid:
        return RestartDecision("stop", observation.reason)
    if observation.quick_check_ok is not True:
        return RestartDecision(
            "stop",
            "tiles.sqlite3 no superó PRAGMA quick_check",
        )
    if (
        observation.configured_percent is None
        or not math.isclose(
            observation.configured_percent,
            restart_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not math.isclose(
            observation.target_percent,
            restart_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
    ):
        return RestartDecision(
            "stop",
            "el porcentaje del plan no coincide con el reinicio",
        )
    if not observation.fits or not margin_fits_percent(
        observation,
        restart_percent,
    ):
        return RestartDecision(
            "stop",
            f"el almacenamiento no conserva {restart_percent:g} % "
            "sobre los bytes restantes",
        )
    return RestartDecision(
        "ready",
        "ambos volúmenes conservan la reserva exacta del reinicio",
    )


def decide_live_storage_stop(
    observation: MarginObservation,
    progress: ProgressObservation,
    *,
    process_percent: float,
    maximum_heartbeat_age: float,
    progress_is_post_launch: bool,
) -> RestartDecision:
    """Authorize a clean stop only when the live reserve truly no longer fits."""

    if not observation.valid:
        return RestartDecision("wait", observation.reason)
    if (
        observation.configured_percent is None
        or not math.isclose(
            observation.configured_percent,
            process_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
    ):
        return RestartDecision(
            "stop",
            "el porcentaje del PID no coincide con estimate.json",
        )
    if margin_fits_percent(observation, process_percent):
        return RestartDecision(
            "complete",
            f"la reserva vigente de {process_percent:g} % todavía cabe",
        )
    if not progress.valid or progress.status != "running":
        return RestartDecision(
            "wait",
            f"estado de progreso no es running: {progress.status or 'inválido'}",
        )
    if not progress_is_post_launch:
        return RestartDecision(
            "wait",
            "progress.json todavía es anterior al PID adoptado",
        )
    if (
        progress.age_seconds is None
        or progress.age_seconds > maximum_heartbeat_age
    ):
        return RestartDecision("wait", "el heartbeat no está fresco")
    return RestartDecision(
        "ready",
        f"la reserva vigente de {process_percent:g} % ya no cabe",
    )


def transition_launch_percent(
    stationary: MarginObservation,
    *,
    current_percent: float,
    target_percent: float,
) -> float | None:
    """Choose the only safe post-stop launch percentage."""

    if (
        not stationary.valid
        or stationary.downloading_rows != 0
        or stationary.quick_check_ok is not True
        or stationary.configured_percent is None
        or not math.isclose(
            stationary.configured_percent,
            current_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not math.isclose(
            stationary.target_percent,
            target_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
    ):
        return None
    if stationary.fits and margin_fits_percent(
        stationary,
        target_percent,
    ):
        return target_percent
    if margin_fits_percent(stationary, current_percent):
        return current_percent
    return None


def recovery_selected_percent_is_safe(
    stationary: MarginObservation,
    *,
    selected_percent: float,
    target_percent: float,
) -> bool:
    """Recheck the persisted selection against both current volumes."""

    if not stationary.valid or not margin_fits_percent(
        stationary,
        selected_percent,
    ):
        return False
    return (
        stationary.fits
        if selected_percent >= target_percent
        else True
    )


def write_margin_observation(path: Path, value: MarginObservation) -> bool:
    payload = dataclasses.asdict(value)
    payload["checked_at_epoch"] = time.time()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    return True


def write_transition_journal(
    path: Path,
    journal: TransitionJournal,
) -> bool:
    payload = dataclasses.asdict(journal)
    payload["version"] = 1
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    return True


def remove_transition_journal(path: Path) -> bool:
    """Durably cancel a prepared journal before any signal was sent."""

    try:
        path.unlink(missing_ok=True)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        return False
    return True


def read_transition_journal(path: Path) -> TransitionJournal | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        identity_payload = payload["old_identity"]
        identity = ProcessIdentity(
            pid=identity_payload["pid"],
            started_at=identity_payload["started_at"],
            arguments=identity_payload["arguments"],
            headroom_percent=float(identity_payload["headroom_percent"]),
        )
        journal = TransitionJournal(
            phase=payload["phase"],
            old_identity=identity,
            current_percent=float(payload["current_percent"]),
            target_percent=float(payload["target_percent"]),
            signalled_at=float(payload["signalled_at"]),
            selected_percent=(
                None
                if payload.get("selected_percent") is None
                else float(payload["selected_percent"])
            ),
            launch_started_at=(
                None
                if payload.get("launch_started_at") is None
                else float(payload["launch_started_at"])
            ),
        )
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        ValueError,
    ):
        return None
    numeric_values = (
        identity.headroom_percent,
        journal.current_percent,
        journal.target_percent,
        journal.signalled_at,
    )
    optional_values = (
        journal.selected_percent,
        journal.launch_started_at,
    )
    prepared_fields_are_valid = (
        journal.phase in {"prepared", "signal_sent"}
        and journal.selected_percent is None
        and journal.launch_started_at is None
    )
    stopped_fields_are_valid = (
        journal.phase == "stopped_clean"
        and journal.selected_percent is not None
        and (
            math.isclose(
                journal.selected_percent,
                journal.current_percent,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
            or math.isclose(
                journal.selected_percent,
                journal.target_percent,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
        )
        and (
            journal.launch_started_at is None
            or journal.launch_started_at >= journal.signalled_at
        )
    )
    if (
        isinstance(payload.get("version"), bool)
        or payload.get("version") != 1
        or journal.phase not in {"prepared", "signal_sent", "stopped_clean"}
        or isinstance(identity.pid, bool)
        or not isinstance(identity.pid, int)
        or identity.pid <= 0
        or not isinstance(identity.started_at, str)
        or not identity.started_at
        or not isinstance(identity.arguments, str)
        or not identity.arguments
        or any(not math.isfinite(value) or value < 0 for value in numeric_values)
        or any(
            value is not None
            and (not math.isfinite(value) or value < 0)
            for value in optional_values
        )
        or not math.isclose(
            identity.headroom_percent,
            journal.current_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not math.isclose(
            journal.current_percent,
            TEMPORARY_MIGRATION_HEADROOM_PERCENT,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not math.isclose(
            journal.target_percent,
            REQUIRED_HEADROOM_PERCENT,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not (
            prepared_fields_are_valid
            or stopped_fields_are_valid
        )
    ):
        return None
    return journal


def write_storage_stop_journal(
    path: Path,
    journal: StorageStopJournal,
) -> bool:
    """Atomically persist the terminal latch and fsync its directory."""

    payload = dataclasses.asdict(journal)
    payload["version"] = 1
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    return True


def remove_storage_stop_journal(path: Path) -> bool:
    """Durably cancel only an armed latch, before it is committed."""

    if not path.exists():
        return True
    journal = read_storage_stop_journal(path)
    if journal is None or journal.phase != "armed":
        return False
    return remove_transition_journal(path)


def read_storage_stop_journal(path: Path) -> StorageStopJournal | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        identity_payload = payload["identity"]
        raw_required_numbers = (
            identity_payload["headroom_percent"],
            payload["process_percent"],
            payload["target_percent"],
            payload["armed_at"],
            payload["progress_written_after"],
        )
        raw_optional_numbers = (
            payload.get("committed_at"),
            payload.get("signal_sent_at"),
            payload.get("stopped_at"),
        )
        if any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            for value in raw_required_numbers
        ) or any(
            value is not None
            and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
            )
            for value in raw_optional_numbers
        ):
            return None
        identity = ProcessIdentity(
            pid=identity_payload["pid"],
            started_at=identity_payload["started_at"],
            arguments=identity_payload["arguments"],
            headroom_percent=float(identity_payload["headroom_percent"]),
        )
        journal = StorageStopJournal(
            phase=payload["phase"],
            identity=identity,
            process_percent=float(payload["process_percent"]),
            target_percent=float(payload["target_percent"]),
            armed_at=float(payload["armed_at"]),
            progress_written_after=float(
                payload["progress_written_after"]
            ),
            committed_at=(
                None
                if payload.get("committed_at") is None
                else float(payload["committed_at"])
            ),
            signal_sent_at=(
                None
                if payload.get("signal_sent_at") is None
                else float(payload["signal_sent_at"])
            ),
            stopped_at=(
                None
                if payload.get("stopped_at") is None
                else float(payload["stopped_at"])
            ),
        )
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        ValueError,
    ):
        return None

    required_numbers = (
        identity.headroom_percent,
        journal.process_percent,
        journal.target_percent,
        journal.armed_at,
        journal.progress_written_after,
    )
    optional_numbers = (
        journal.committed_at,
        journal.signal_sent_at,
        journal.stopped_at,
    )
    armed_fields_are_valid = (
        journal.phase == "armed"
        and all(value is None for value in optional_numbers)
    )
    committed_fields_are_valid = (
        journal.phase == "committed"
        and journal.committed_at is not None
        and journal.committed_at >= journal.armed_at
        and journal.signal_sent_at is None
        and journal.stopped_at is None
    )
    signal_fields_are_valid = (
        journal.phase == "signal_sent"
        and journal.committed_at is not None
        and journal.signal_sent_at is not None
        and journal.committed_at >= journal.armed_at
        and journal.signal_sent_at >= journal.committed_at
        and journal.stopped_at is None
    )
    stopped_fields_are_valid = (
        journal.phase == "stopped_clean"
        and journal.committed_at is not None
        and journal.signal_sent_at is not None
        and journal.stopped_at is not None
        and journal.committed_at >= journal.armed_at
        and journal.signal_sent_at >= journal.committed_at
        and journal.stopped_at >= journal.signal_sent_at
    )
    process_percent_is_allowed = (
        math.isclose(
            journal.process_percent,
            TEMPORARY_MIGRATION_HEADROOM_PERCENT,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or journal.process_percent >= REQUIRED_HEADROOM_PERCENT
    )
    if (
        isinstance(payload.get("version"), bool)
        or payload.get("version") != 1
        or not isinstance(journal.phase, str)
        or journal.phase
        not in {"armed", "committed", "signal_sent", "stopped_clean"}
        or isinstance(identity.pid, bool)
        or not isinstance(identity.pid, int)
        or identity.pid <= 0
        or not isinstance(identity.started_at, str)
        or not identity.started_at
        or not isinstance(identity.arguments, str)
        or not identity.arguments
        or any(
            not math.isfinite(value) or value < 0
            for value in required_numbers
        )
        or any(
            value is not None
            and (not math.isfinite(value) or value < 0)
            for value in optional_numbers
        )
        or journal.progress_written_after > journal.armed_at
        or not math.isclose(
            identity.headroom_percent,
            journal.process_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not process_percent_is_allowed
        or not math.isclose(
            journal.target_percent,
            REQUIRED_HEADROOM_PERCENT,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not (
            armed_fields_are_valid
            or committed_fields_are_valid
            or signal_fields_are_valid
            or stopped_fields_are_valid
        )
    ):
        return None
    return journal


def estimate_proves_headroom(
    path: Path,
    *,
    written_after: float,
    target_percent: float,
    expected_scope: PlanScope | None = None,
) -> bool:
    try:
        stat = path.stat()
        payload = json.loads(path.read_text(encoding="utf-8"))
        plan = payload["plan"]
        requested = payload["requested"]
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        ValueError,
    ):
        return False
    if not isinstance(plan, dict):
        return False
    configured_raw = plan.get("space_headroom_percent")
    if (
        isinstance(configured_raw, bool)
        or not isinstance(configured_raw, (int, float))
        or not math.isfinite(float(configured_raw))
    ):
        return False
    configured = float(configured_raw)
    scope = parse_plan_scope(requested)
    return (
        stat.st_mtime >= written_after
        and plan.get("fallback") is False
        and plan.get("fits") is True
        and configured >= target_percent
        and scope is not None
        and (expected_scope is None or scope == expected_scope)
    )


def read_free_floor(estimate_path: Path) -> int | None:
    try:
        payload = json.loads(estimate_path.read_text(encoding="utf-8"))
        plan = payload["plan"]
        value = plan["headroom_bytes"]
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        return None
    return value if isinstance(value, int) and value >= 0 else None


def invalid_margin_observation(
    reason: str,
    *,
    target_percent: float,
    configured_percent: float | None = None,
) -> MarginObservation:
    return MarginObservation(
        valid=False,
        reason=reason,
        configured_percent=configured_percent,
        target_percent=target_percent,
        conservative_total_bytes=None,
        existing_complete_bytes=None,
        conservative_remaining_bytes=None,
        required_bytes=None,
        tile_free_bytes=None,
        backing_free_bytes=None,
        shortfall_bytes=None,
        downloading_rows=None,
        quick_check_ok=None,
        fits=False,
    )


def read_margin_observation(
    *,
    estimate_path: Path,
    database_path: Path,
    output_dir: Path,
    backing_volume: Path,
    target_percent: float,
    require_quick_check: bool = False,
    expected_scope: PlanScope | None = None,
) -> MarginObservation:
    """Calculate the exact future preflight gate without mutating the DB."""

    try:
        payload = json.loads(estimate_path.read_text(encoding="utf-8"))
        plan = payload["plan"]
        requested = payload["requested"]
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
    ):
        return invalid_margin_observation(
            "estimate.json no contiene el plan esperado",
            target_percent=target_percent,
        )
    if not isinstance(plan, dict) or not isinstance(requested, dict):
        return invalid_margin_observation(
            "el plan de almacenamiento no es un objeto",
            target_percent=target_percent,
        )
    configured_raw = plan.get("space_headroom_percent")
    if (
        isinstance(configured_raw, bool)
        or not isinstance(configured_raw, (int, float))
        or not math.isfinite(float(configured_raw))
        or float(configured_raw) < 0
    ):
        return invalid_margin_observation(
            "el porcentaje configurado no es válido",
            target_percent=target_percent,
        )
    configured_percent = float(configured_raw)
    if plan.get("fallback") is not False:
        return invalid_margin_observation(
            "el plan activo es reducido o no declara fallback=false",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )

    scope = parse_plan_scope(requested)
    rows = plan.get("rows")
    if scope is None or not isinstance(rows, list) or not rows:
        return invalid_margin_observation(
            "el alcance del plan no es válido",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )
    if expected_scope is not None and scope != expected_scope:
        return invalid_margin_observation(
            "el alcance del plan no coincide con el mapa completo",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )

    conservative_total = 0
    conservative_by_group: dict[tuple[str, str, int], int] = {}
    row_scope: set[tuple[str, str, int]] = set()
    expected_rows = {
        (dimension, layer, lod)
        for dimension in scope.dimensions
        for layer in scope.layers
        for lod in scope.lods
    }
    for row in rows:
        if not isinstance(row, dict):
            return invalid_margin_observation(
                "una fila de estimación no es un objeto",
                target_percent=target_percent,
                configured_percent=configured_percent,
            )
        row_key = (row.get("dimension"), row.get("layer"), row.get("lod"))
        if (
            not isinstance(row_key[0], str)
            or not isinstance(row_key[1], str)
            or isinstance(row_key[2], bool)
            or not isinstance(row_key[2], int)
            or row_key not in expected_rows
            or row_key in row_scope
        ):
            return invalid_margin_observation(
                "las filas no describen exactamente el alcance solicitado",
                target_percent=target_percent,
                configured_percent=configured_percent,
            )
        row_scope.add(row_key)
        value = row.get("conservative_bytes")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return invalid_margin_observation(
                "una fila tiene conservative_bytes inválido",
                target_percent=target_percent,
                configured_percent=configured_percent,
            )
        conservative_total += value
        conservative_by_group[row_key] = value
    if row_scope != expected_rows:
        return invalid_margin_observation(
            "faltan filas para una parte del alcance solicitado",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )

    dimensions = sorted(scope.dimensions)
    layers = sorted(scope.layers)
    lods = sorted(scope.lods)
    dimension_marks = ",".join("?" for _ in dimensions)
    layer_marks = ",".join("?" for _ in layers)
    lod_marks = ",".join("?" for _ in lods)
    try:
        connection = sqlite3.connect(
            f"{database_path.resolve().as_uri()}?mode=ro",
            uri=True,
            timeout=5.0,
        )
        try:
            connection.execute("PRAGMA query_only=ON")
            quick_check_ok: bool | None = None
            if require_quick_check:
                quick_check_row = connection.execute(
                    "PRAGMA quick_check"
                ).fetchone()
                quick_check_ok = (
                    quick_check_row is not None
                    and str(quick_check_row[0]).strip().lower() == "ok"
                )
                if not quick_check_ok:
                    return invalid_margin_observation(
                        "PRAGMA quick_check no devolvió ok",
                        target_percent=target_percent,
                        configured_percent=configured_percent,
                    )
            summary_rows = connection.execute(
                f"""
                SELECT
                    dimension,
                    layer,
                    lod,
                    COALESCE(SUM(
                        CASE WHEN status='complete' THEN size_bytes ELSE 0 END
                    ), 0) AS complete_bytes,
                    COALESCE(SUM(
                        CASE WHEN status='downloading' THEN 1 ELSE 0 END
                    ), 0) AS downloading_rows
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND lod IN ({lod_marks})
                GROUP BY dimension, layer, lod
                """,
                [*dimensions, *layers, *lods],
            ).fetchall()
        finally:
            connection.close()
    except (OSError, sqlite3.Error):
        return invalid_margin_observation(
            "no se pudo consultar tiles.sqlite3 en modo de solo lectura",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )
    existing_by_group = {
        (str(row[0]), str(row[1]), int(row[2])): max(0, int(row[3]))
        for row in summary_rows
    }
    existing_complete_bytes = sum(existing_by_group.values())
    downloading_rows = sum(max(0, int(row[4])) for row in summary_rows)
    conservative_remaining = sum(
        max(0, conservative - existing_by_group.get(group, 0))
        for group, conservative in conservative_by_group.items()
    )
    if not float(target_percent).is_integer():
        return invalid_margin_observation(
            "el porcentaje objetivo debe ser entero",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )
    required_bytes = required_storage_bytes(
        conservative_remaining,
        target_percent,
    )
    if required_bytes is None:
        return invalid_margin_observation(
            "no se pudo calcular la reserva objetivo",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )
    try:
        tile_free_bytes = shutil.disk_usage(output_dir).free
        backing_free_bytes = shutil.disk_usage(backing_volume).free
    except OSError:
        return invalid_margin_observation(
            "no se pudo consultar el espacio de ambos volúmenes",
            target_percent=target_percent,
            configured_percent=configured_percent,
        )
    limiting_free = min(tile_free_bytes, backing_free_bytes)
    shortfall_bytes = max(0, required_bytes - limiting_free)
    return MarginObservation(
        valid=True,
        reason=(
            "el porcentaje objetivo todavía no cabe"
            if shortfall_bytes
            else (
                "el porcentaje objetivo ya está configurado y cabe"
                if configured_percent >= target_percent
                else "el porcentaje objetivo cabe"
            )
        ),
        configured_percent=configured_percent,
        target_percent=target_percent,
        conservative_total_bytes=conservative_total,
        existing_complete_bytes=existing_complete_bytes,
        conservative_remaining_bytes=conservative_remaining,
        required_bytes=required_bytes,
        tile_free_bytes=tile_free_bytes,
        backing_free_bytes=backing_free_bytes,
        shortfall_bytes=shortfall_bytes,
        downloading_rows=downloading_rows,
        quick_check_ok=quick_check_ok,
        fits=shortfall_bytes == 0,
    )


def owner_pid(lock_dir: Path) -> int | None:
    try:
        return int((lock_dir / "pid").read_text(encoding="ascii").strip())
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        return None


def ensure_download_lock(lock_dir: Path, pid: int) -> bool:
    """Create/adopt the launch lock without removing a live owner's lock."""

    try:
        lock_dir.mkdir()
    except FileExistsError:
        owner = owner_pid(lock_dir)
        if owner == pid:
            return True
        if owner is not None:
            try:
                os.kill(owner, 0)
            except ProcessLookupError:
                pass
            except PermissionError:
                return False
            else:
                return False
        return False
    (lock_dir / "pid").write_text(f"{pid}\n", encoding="ascii")
    return True


def clear_stale_download_lock(lock_dir: Path, expected_pid: int) -> bool:
    if not lock_dir.exists():
        return True
    if owner_pid(lock_dir) != expected_pid:
        return False
    try:
        os.kill(expected_pid, 0)
    except ProcessLookupError:
        pass
    except PermissionError:
        return False
    else:
        return False
    try:
        (lock_dir / "pid").unlink(missing_ok=True)
        lock_dir.rmdir()
    except OSError:
        return False
    return True


def acquire_supervisor_lock() -> Any:
    path = Path(tempfile.gettempdir()) / "obsidian-atlas-full-supervisor.lock"
    handle = path.open("a+", encoding="ascii")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise RuntimeError("ya existe otro supervisor activo")
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n")
    handle.flush()
    return handle


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    project_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description=(
            "Adopta y vigila la descarga completa de LuisA; solo reanuda "
            "una desaparición inesperada confirmada."
        )
    )
    parser.add_argument("--project-dir", type=Path, default=project_dir)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/Volumes/2b2t Tiles/2b2t_tiles"),
    )
    parser.add_argument("--poll-seconds", type=float, default=30.0)
    parser.add_argument("--missing-confirmations", type=int, default=3)
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    parser.add_argument(
        "--target-validation-timeout",
        type=float,
        default=30 * 60,
        help=(
            "Ventana para validar el preflight nuevo; se renueva mientras "
            "el heartbeat siga sano."
        ),
    )
    parser.add_argument("--max-restarts", type=int, default=3)
    parser.add_argument(
        "--restart-window-seconds",
        type=float,
        default=24 * 60 * 60,
    )
    parser.add_argument(
        "--target-space-headroom-percent",
        type=int,
        default=20,
        help="Reserva independiente que debe validar el preflight final.",
    )
    parser.add_argument(
        "--margin-check-seconds",
        type=float,
        default=5 * 60,
    )
    parser.add_argument("--margin-confirmations", type=int, default=3)
    parser.add_argument(
        "--margin-retry-cooldown-seconds",
        type=float,
        default=24 * 60 * 60,
    )
    parser.add_argument(
        "--transition-shutdown-timeout",
        type=float,
        default=3 * 60,
    )
    parser.add_argument(
        "--maximum-heartbeat-age",
        type=float,
        default=30.0,
    )
    parser.add_argument(
        "--no-auto-margin-upgrade",
        action="store_true",
        help="Solo informa el margen; no hace la transición limpia.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Inspecciona el proceso actual sin quedarse vigilando.",
    )
    args = parser.parse_args(argv)
    if args.poll_seconds <= 0:
        parser.error("--poll-seconds debe ser mayor que cero")
    if args.missing_confirmations <= 0:
        parser.error("--missing-confirmations debe ser mayor que cero")
    if args.startup_timeout <= 0:
        parser.error("--startup-timeout debe ser mayor que cero")
    if args.target_validation_timeout <= 0:
        parser.error("--target-validation-timeout debe ser mayor que cero")
    if args.max_restarts <= 0:
        parser.error("--max-restarts debe ser mayor que cero")
    if args.restart_window_seconds <= 0:
        parser.error("--restart-window-seconds debe ser mayor que cero")
    if args.target_space_headroom_percent != int(REQUIRED_HEADROOM_PERCENT):
        parser.error(
            "--target-space-headroom-percent debe ser exactamente 20"
        )
    if args.margin_check_seconds <= 0:
        parser.error("--margin-check-seconds debe ser mayor que cero")
    if args.margin_confirmations <= 0:
        parser.error("--margin-confirmations debe ser mayor que cero")
    if args.margin_retry_cooldown_seconds <= 0:
        parser.error(
            "--margin-retry-cooldown-seconds debe ser mayor que cero"
        )
    if args.transition_shutdown_timeout <= 0:
        parser.error(
            "--transition-shutdown-timeout debe ser mayor que cero"
        )
    if args.maximum_heartbeat_age <= 0:
        parser.error("--maximum-heartbeat-age debe ser mayor que cero")
    return args


def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    project_dir = args.project_dir.expanduser().resolve()
    output_dir = args.output.expanduser().resolve()
    script_path = project_dir / "download_all_2b2t.py"
    launcher = project_dir / "run_full_download_luisa.sh"
    backing_volume = Path("/Volumes/LuisA")
    image_path = backing_volume / "2b2t_map/2b2t_tiles.sparsebundle"
    progress_path = output_dir / "progress.json"
    estimate_path = output_dir / "estimate.json"
    database_path = output_dir / "tiles.sqlite3"
    margin_path = output_dir / "margin_upgrade.json"
    transition_path = output_dir / "margin_transition.json"
    storage_stop_path = output_dir / "storage_stop.json"
    download_lock = output_dir / ".download.lock"
    logger = configure_logging(output_dir)
    try:
        supervisor_lock = acquire_supervisor_lock()
    except RuntimeError as exc:
        logger.error("%s", exc)
        return 4

    stop_requested = False

    def request_stop(_signum: int, _frame: Any) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    restart_times: collections.deque[float] = collections.deque()

    def launch_and_wait(
        headroom_percent: float,
    ) -> tuple[ProcessIdentity | None, str | None]:
        if storage_stop_path.exists():
            raise StorageStopTerminal(
                "storage_stop.json existe; se prohíbe cualquier relanzamiento"
            )
        environment = os.environ.copy()
        environment["SPACE_HEADROOM_PERCENT"] = f"{headroom_percent:g}"
        environment.pop("ALLOW_TEMPORARY_HEADROOM_MIGRATION", None)
        if headroom_percent < args.target_space_headroom_percent:
            environment["ALLOW_TEMPORARY_HEADROOM_MIGRATION"] = "1"
        if not claim_restart_slot(
            restart_times,
            now=time.monotonic(),
            window_seconds=args.restart_window_seconds,
            maximum=args.max_restarts,
        ):
            return (
                None,
                "se alcanzó el límite de reinicios antes de invocar "
                "el lanzador",
            )
        child = subprocess.Popen(
            [str(launcher)],
            cwd=project_dir,
            env=environment,
        )
        deadline = time.monotonic() + args.startup_timeout
        while time.monotonic() < deadline and not stop_requested:
            replacement = find_download_processes(script_path, output_dir)
            if len(replacement) == 1:
                identity = read_process_identity(
                    replacement[0],
                    script_path,
                    output_dir,
                )
                if (
                    identity is not None
                    and math.isclose(
                        identity.headroom_percent,
                        headroom_percent,
                        rel_tol=0.0,
                        abs_tol=1e-9,
                    )
                    and owner_pid(download_lock) == identity.pid
                ):
                    return identity, None
            if len(replacement) > 1:
                return None, "el lanzador creó varias instancias"
            if child.poll() is not None:
                break
            time.sleep(min(5.0, args.poll_seconds))
        return (
            None,
            "el lanzador no produjo una única instancia "
            f"en {args.startup_timeout:.0f}s (salida={child.poll()})",
        )

    def wait_for_clean_planned_stop(
        expected_identity: ProcessIdentity,
        *,
        signalled_at: float,
    ) -> tuple[MarginObservation | None, str | None]:
        deadline = time.monotonic() + args.transition_shutdown_timeout
        while time.monotonic() < deadline:
            processes = find_download_processes(script_path, output_dir)
            if len(processes) > 1:
                return None, "aparecieron varios descargadores durante la parada"
            if len(processes) == 1:
                current_identity = read_process_identity(
                    processes[0],
                    script_path,
                    output_dir,
                )
                if current_identity != expected_identity:
                    return None, "apareció un PID distinto durante la parada"
                time.sleep(2.0)
                continue

            progress = read_progress(progress_path)
            if progress.valid and progress.status in (
                "protection",
                "error",
                "preflight_blocked",
            ):
                return None, f"la parada terminó con estado {progress.status}"
            try:
                progress_is_new = progress_path.stat().st_mtime >= signalled_at
            except OSError:
                progress_is_new = False
            if not progress_is_new:
                time.sleep(2.0)
                continue
            stop_decision = clean_planned_stop(progress)
            if stop_decision.action == "stop":
                return None, stop_decision.reason
            if stop_decision.action != "ready":
                time.sleep(2.0)
                continue
            stationary = read_margin_observation(
                estimate_path=estimate_path,
                database_path=database_path,
                output_dir=output_dir,
                backing_volume=backing_volume,
                target_percent=args.target_space_headroom_percent,
                require_quick_check=True,
                expected_scope=FULL_MAP_SCOPE,
            )
            if not stationary.valid:
                return None, stationary.reason
            if stationary.downloading_rows != 0:
                time.sleep(2.0)
                continue
            return stationary, None
        return (
            None,
            "la parada limpia agotó el timeout; no se usó SIGKILL "
            "ni se retiró el bloqueo",
        )

    def exact_live_identity(identity: ProcessIdentity) -> bool:
        return (
            find_download_processes(script_path, output_dir)
            == [identity.pid]
            and read_process_identity(
                identity.pid,
                script_path,
                output_dir,
            )
            == identity
            and owner_pid(download_lock) == identity.pid
        )

    def clear_stale_lock_if_storage_allows(expected_pid: int) -> bool:
        if storage_stop_path.exists():
            raise StorageStopTerminal(
                "storage_stop.json existe; no se retirará ningún lock"
            )
        return clear_stale_download_lock(download_lock, expected_pid)

    def commit_and_stop_for_storage(
        expected_identity: ProcessIdentity,
        *,
        progress_written_after: float,
        armed_journal: StorageStopJournal | None = None,
    ) -> bool:
        """Cancel an armed false alarm or commit one terminal clean stop."""

        process_percent = expected_identity.headroom_percent
        if armed_journal is None:
            armed_journal = StorageStopJournal(
                phase="armed",
                identity=expected_identity,
                process_percent=process_percent,
                target_percent=float(
                    args.target_space_headroom_percent
                ),
                armed_at=time.time(),
                progress_written_after=progress_written_after,
            )
            if not write_storage_stop_journal(
                storage_stop_path,
                armed_journal,
            ):
                raise StorageStopTerminal(
                    "no se pudo persistir el latch armado; no se envió señal"
                )
        elif (
            armed_journal.phase != "armed"
            or armed_journal.identity != expected_identity
            or not math.isclose(
                armed_journal.process_percent,
                process_percent,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
            or not math.isclose(
                armed_journal.progress_written_after,
                progress_written_after,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
        ):
            raise StorageStopTerminal(
                "el latch armado no coincide con el proceso esperado"
            )

        def final_gate() -> tuple[MarginObservation, RestartDecision, bool]:
            margin = read_margin_observation(
                estimate_path=estimate_path,
                database_path=database_path,
                output_dir=output_dir,
                backing_volume=backing_volume,
                target_percent=args.target_space_headroom_percent,
                expected_scope=FULL_MAP_SCOPE,
            )
            write_margin_observation(margin_path, margin)
            progress = read_progress(progress_path)
            try:
                progress_is_post_launch = (
                    progress_path.stat().st_mtime
                    >= progress_written_after
                )
            except OSError:
                progress_is_post_launch = False
            decision = decide_live_storage_stop(
                margin,
                progress,
                process_percent=process_percent,
                maximum_heartbeat_age=args.maximum_heartbeat_age,
                progress_is_post_launch=progress_is_post_launch,
            )
            return margin, decision, exact_live_identity(expected_identity)

        _margin, decision, identity_is_safe = final_gate()
        if decision.action == "complete" and identity_is_safe:
            if not remove_storage_stop_journal(storage_stop_path):
                raise StorageStopTerminal(
                    "el espacio se recuperó, pero el latch armado no pudo "
                    "cancelarse durablemente"
                )
            logger.info(
                "El gate final confirmó que %.0f %% vuelve a caber; "
                "storage_stop.json se canceló sin señal.",
                process_percent,
            )
            return False
        if decision.action != "ready" or not identity_is_safe:
            raise StorageStopTerminal(
                "el gate armado quedó incierto sin enviar señal: "
                + (
                    "cambió la identidad o el bloqueo"
                    if not identity_is_safe
                    else decision.reason
                )
            )

        committed_at = time.time()
        committed = dataclasses.replace(
            armed_journal,
            phase="committed",
            committed_at=committed_at,
        )
        if not write_storage_stop_journal(storage_stop_path, committed):
            raise StorageStopTerminal(
                "no se pudo comprometer durablemente el freno; "
                "no se envió señal"
            )

        _margin, committed_decision, committed_identity_is_safe = final_gate()
        if (
            committed_decision.action != "ready"
            or not committed_identity_is_safe
        ):
            raise StorageStopTerminal(
                "el gate cambió después del commit; el latch queda terminal "
                "sin señal: "
                + (
                    "cambió la identidad o el bloqueo"
                    if not committed_identity_is_safe
                    else committed_decision.reason
                )
            )

        signal_sent_at = time.time()
        try:
            os.kill(expected_identity.pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError) as exc:
            raise StorageStopTerminal(
                f"el latch quedó comprometido y SIGINT no pudo enviarse: {exc}"
            ) from exc

        signalled = dataclasses.replace(
            committed,
            phase="signal_sent",
            signal_sent_at=signal_sent_at,
        )
        if not write_storage_stop_journal(storage_stop_path, signalled):
            logger.error(
                "SIGINT fue enviado, pero el latch durable permanece en "
                "committed; una recuperación no volverá a señalizar."
            )
        logger.critical(
            "Se envió como máximo un SIGINT porque la reserva vigente de "
            "%.0f %% dejó de caber.",
            process_percent,
        )
        stationary, stop_error = wait_for_clean_planned_stop(
            expected_identity,
            signalled_at=signal_sent_at,
        )
        if stationary is None:
            raise StorageStopTerminal(
                "el freno comprometido no confirmó una parada limpia: "
                f"{stop_error}"
            )

        stopped = dataclasses.replace(
            signalled,
            phase="stopped_clean",
            stopped_at=max(time.time(), signal_sent_at),
        )
        if not write_storage_stop_journal(storage_stop_path, stopped):
            logger.error(
                "La parada fue limpia, pero el latch no pudo registrar "
                "stopped_clean; sigue siendo terminal."
            )
        raise StorageStopTerminal(
            "descarga detenida limpiamente para conservar espacio"
        )

    def reconcile_committed_storage_stop(
        journal: StorageStopJournal,
    ) -> None:
        """Observe a prior committed stop without signalling or relaunching."""

        if journal.phase == "stopped_clean":
            raise StorageStopTerminal(
                "storage_stop.json ya confirma una parada limpia"
            )
        if journal.phase not in {"committed", "signal_sent"}:
            raise StorageStopTerminal(
                "la reconciliación solo acepta un latch comprometido"
            )
        processes = find_download_processes(script_path, output_dir)
        if processes:
            raise StorageStopTerminal(
                "el latch comprometido conserva un descargador presente; "
                "no se volverá a señalizar"
            )
        progress = read_progress(progress_path)
        try:
            progress_is_post_commit = (
                journal.committed_at is not None
                and progress_path.stat().st_mtime >= journal.committed_at
            )
        except OSError:
            progress_is_post_commit = False
        clean = clean_planned_stop(progress)
        if not progress_is_post_commit or clean.action != "ready":
            raise StorageStopTerminal(
                "el latch comprometido no tiene evidencia nueva de una "
                "parada limpia"
            )
        stationary = read_margin_observation(
            estimate_path=estimate_path,
            database_path=database_path,
            output_dir=output_dir,
            backing_volume=backing_volume,
            target_percent=args.target_space_headroom_percent,
            require_quick_check=True,
            expected_scope=FULL_MAP_SCOPE,
        )
        if (
            not stationary.valid
            or stationary.downloading_rows != 0
            or stationary.quick_check_ok is not True
        ):
            raise StorageStopTerminal(
                "la parada observada no tiene DB inmóvil e íntegra"
            )
        if find_download_processes(script_path, output_dir):
            raise StorageStopTerminal(
                "apareció un descargador durante la reconciliación; "
                "no se modificará el latch"
            )
        signal_lower_bound = (
            journal.signal_sent_at
            if journal.signal_sent_at is not None
            else journal.committed_at
        )
        if signal_lower_bound is None:
            raise StorageStopTerminal(
                "el latch comprometido no contiene un timestamp válido"
            )
        stopped = dataclasses.replace(
            journal,
            phase="stopped_clean",
            signal_sent_at=signal_lower_bound,
            stopped_at=max(time.time(), signal_lower_bound),
        )
        if not write_storage_stop_journal(storage_stop_path, stopped):
            raise StorageStopTerminal(
                "la parada es limpia, pero no pudo reconciliarse durablemente"
            )
        raise StorageStopTerminal(
            "parada limpia reconciliada sin reenviar señal"
        )

    def wait_for_target_validation(
        expected_identity: ProcessIdentity,
        *,
        launched_after: float,
        target_percent: float,
    ) -> str | None:
        deadline = time.monotonic() + args.target_validation_timeout
        storage_stop_checks = 0
        last_storage_check = 0.0
        while time.monotonic() < deadline:
            processes = find_download_processes(script_path, output_dir)
            if processes != [expected_identity.pid]:
                return "el proceso nuevo desapareció o dejó de ser único"
            if (
                read_process_identity(
                    expected_identity.pid,
                    script_path,
                    output_dir,
                )
                != expected_identity
            ):
                return "cambió la identidad del proceso nuevo"
            if owner_pid(download_lock) != expected_identity.pid:
                return "el bloqueo ya no pertenece al proceso nuevo"
            progress = read_progress(progress_path)
            try:
                progress_is_new = (
                    progress_path.stat().st_mtime >= launched_after
                )
            except OSError:
                progress_is_new = False
            now = time.monotonic()
            if now - last_storage_check >= args.margin_check_seconds:
                storage_margin = read_margin_observation(
                    estimate_path=estimate_path,
                    database_path=database_path,
                    output_dir=output_dir,
                    backing_volume=backing_volume,
                    target_percent=target_percent,
                    expected_scope=FULL_MAP_SCOPE,
                )
                write_margin_observation(margin_path, storage_margin)
                storage_decision = decide_live_storage_stop(
                    storage_margin,
                    progress,
                    process_percent=expected_identity.headroom_percent,
                    maximum_heartbeat_age=args.maximum_heartbeat_age,
                    progress_is_post_launch=progress_is_new,
                )
                storage_stop_checks = next_margin_confirmation(
                    storage_stop_checks,
                    storage_decision,
                )
                last_storage_check = now
                if storage_decision.action == "ready":
                    logger.error(
                        "La reserva del reemplazo %.0f %% no cabe durante "
                        "validación: confirmación %d/%d.",
                        expected_identity.headroom_percent,
                        storage_stop_checks,
                        args.margin_confirmations,
                    )
                if storage_stop_checks >= args.margin_confirmations:
                    commit_and_stop_for_storage(
                        expected_identity,
                        progress_written_after=launched_after,
                    )
                    storage_stop_checks = 0
            if progress_is_new:
                signal_reason = safety_signal(progress)
                if signal_reason:
                    return signal_reason
                if healthy_active_heartbeat(
                    progress,
                    maximum_age_seconds=args.maximum_heartbeat_age,
                ):
                    healthy_extension = args.target_validation_timeout
                    if storage_stop_checks > 0:
                        healthy_extension = max(
                            healthy_extension,
                            args.margin_check_seconds
                            + args.maximum_heartbeat_age,
                        )
                    deadline = max(
                        deadline,
                        time.monotonic() + healthy_extension,
                    )
            if (
                progress_is_new
                and healthy_active_heartbeat(
                    progress,
                    maximum_age_seconds=args.maximum_heartbeat_age,
                )
                and progress.status == "running"
            ):
                process_percent = expected_identity.headroom_percent
                if (
                    process_percent is not None
                    and math.isclose(
                        process_percent,
                        target_percent,
                        rel_tol=0.0,
                        abs_tol=1e-9,
                    )
                    and estimate_proves_headroom(
                        estimate_path,
                        written_after=launched_after,
                        target_percent=target_percent,
                        expected_scope=FULL_MAP_SCOPE,
                    )
                ):
                    target_margin = read_margin_observation(
                        estimate_path=estimate_path,
                        database_path=database_path,
                        output_dir=output_dir,
                        backing_volume=backing_volume,
                        target_percent=target_percent,
                        expected_scope=FULL_MAP_SCOPE,
                    )
                    if (
                        target_margin.valid
                        and target_margin.fits
                        and target_margin.configured_percent is not None
                        and target_margin.configured_percent >= target_percent
                    ):
                        write_margin_observation(margin_path, target_margin)
                        return None
            if (
                progress_is_new
                and progress.valid
                and progress.status in STOP_STATUSES
            ):
                return f"el proceso nuevo terminó con estado {progress.status}"
            time.sleep(min(5.0, args.poll_seconds))
        return "el nuevo preflight dejó de producir un heartbeat sano"

    def wait_for_resume_health(
        expected_identity: ProcessIdentity,
        *,
        launched_after: float,
    ) -> str | None:
        deadline = time.monotonic() + args.target_validation_timeout
        storage_stop_checks = 0
        last_storage_check = 0.0
        storage_gate_is_safe = False
        while time.monotonic() < deadline:
            if (
                find_download_processes(script_path, output_dir)
                != [expected_identity.pid]
                or read_process_identity(
                    expected_identity.pid,
                    script_path,
                    output_dir,
                )
                != expected_identity
                or owner_pid(download_lock) != expected_identity.pid
            ):
                return "el proceso reanudado cambió de identidad o bloqueo"
            progress = read_progress(progress_path)
            try:
                progress_is_new = (
                    progress_path.stat().st_mtime >= launched_after
                )
            except OSError:
                progress_is_new = False
            now = time.monotonic()
            if now - last_storage_check >= args.margin_check_seconds:
                storage_margin = read_margin_observation(
                    estimate_path=estimate_path,
                    database_path=database_path,
                    output_dir=output_dir,
                    backing_volume=backing_volume,
                    target_percent=args.target_space_headroom_percent,
                    expected_scope=FULL_MAP_SCOPE,
                )
                write_margin_observation(margin_path, storage_margin)
                storage_decision = decide_live_storage_stop(
                    storage_margin,
                    progress,
                    process_percent=expected_identity.headroom_percent,
                    maximum_heartbeat_age=args.maximum_heartbeat_age,
                    progress_is_post_launch=progress_is_new,
                )
                storage_stop_checks = next_margin_confirmation(
                    storage_stop_checks,
                    storage_decision,
                )
                storage_gate_is_safe = (
                    storage_decision.action == "complete"
                )
                last_storage_check = now
                if storage_decision.action == "ready":
                    logger.error(
                        "La reserva del reemplazo temporal %.0f %% no cabe: "
                        "confirmación %d/%d.",
                        expected_identity.headroom_percent,
                        storage_stop_checks,
                        args.margin_confirmations,
                    )
                if storage_stop_checks >= args.margin_confirmations:
                    commit_and_stop_for_storage(
                        expected_identity,
                        progress_written_after=launched_after,
                    )
                    storage_stop_checks = 0
                    storage_gate_is_safe = False
            if progress_is_new:
                signal_reason = safety_signal(progress)
                if signal_reason:
                    return signal_reason
                heartbeat_is_healthy = healthy_active_heartbeat(
                    progress,
                    maximum_age_seconds=args.maximum_heartbeat_age,
                )
                if heartbeat_is_healthy and storage_stop_checks > 0:
                    deadline = max(
                        deadline,
                        time.monotonic()
                        + args.margin_check_seconds
                        + args.maximum_heartbeat_age,
                    )
                if heartbeat_is_healthy and storage_gate_is_safe:
                    return None
                if progress.valid and progress.status in STOP_STATUSES:
                    return (
                        "el proceso reanudado terminó con estado "
                        f"{progress.status}"
                    )
            time.sleep(min(5.0, args.poll_seconds))
        return "el proceso reanudado no produjo un heartbeat sano"

    def recover_transition(
        journal: TransitionJournal,
    ) -> tuple[
        ProcessIdentity | None,
        float | None,
        bool,
        str | None,
    ]:
        if storage_stop_path.exists():
            raise StorageStopTerminal(
                "storage_stop.json domina la recuperación de margen"
            )
        if (
            process_identity_from_fields(
                journal.old_identity.pid,
                journal.old_identity.started_at,
                journal.old_identity.arguments,
                script_path,
                output_dir,
            )
            != journal.old_identity
        ):
            return None, None, False, (
                "el journal no contiene una identidad canónica"
            )
        if not math.isclose(
            journal.target_percent,
            float(args.target_space_headroom_percent),
            rel_tol=0.0,
            abs_tol=1e-9,
        ):
            return None, None, False, (
                "el objetivo del journal no coincide con el supervisor"
            )
        processes = find_download_processes(script_path, output_dir)
        if len(processes) > 1:
            return None, None, False, (
                "hay varios descargadores durante la recuperación"
            )
        selected_percent: float | None = None
        lock_pid_to_clear = journal.old_identity.pid
        if len(processes) == 1:
            current_identity = read_process_identity(
                processes[0],
                script_path,
                output_dir,
            )
            if current_identity == journal.old_identity:
                if journal.phase == "stopped_clean":
                    return None, None, False, (
                        "el proceso antiguo reapareció tras una parada validada"
                    )
                stationary, stop_error = wait_for_clean_planned_stop(
                    journal.old_identity,
                    signalled_at=journal.signalled_at,
                )
                if stationary is None:
                    progress = read_progress(progress_path)
                    if (
                        journal.phase == "prepared"
                        and read_process_identity(
                            journal.old_identity.pid,
                            script_path,
                            output_dir,
                        )
                        == journal.old_identity
                        and progress.valid
                        and progress.status in ACTIVE_STATUSES
                        and safety_signal(progress) is None
                        and progress.age_seconds is not None
                        and progress.age_seconds
                        <= args.maximum_heartbeat_age
                    ):
                        try:
                            transition_path.unlink(missing_ok=True)
                        except OSError:
                            return None, None, False, (
                                "no se pudo cancelar el journal preparado"
                            )
                        return (
                            journal.old_identity,
                            journal.current_percent,
                            False,
                            None,
                        )
                    return None, None, False, stop_error
            else:
                if (
                    journal.phase != "stopped_clean"
                    or journal.selected_percent is None
                    or journal.launch_started_at is None
                    or current_identity is None
                    or not math.isclose(
                        current_identity.headroom_percent,
                        journal.selected_percent,
                        rel_tol=0.0,
                        abs_tol=1e-9,
                    )
                    or owner_pid(download_lock) != current_identity.pid
                ):
                    return None, None, False, (
                        "el proceso presente no pertenece a la transición"
                    )
                validation_error = (
                    wait_for_target_validation(
                        current_identity,
                        launched_after=journal.launch_started_at,
                        target_percent=journal.target_percent,
                    )
                    if journal.selected_percent >= journal.target_percent
                    else wait_for_resume_health(
                        current_identity,
                        launched_after=journal.launch_started_at,
                    )
                )
                if validation_error is not None:
                    return None, None, False, validation_error
                try:
                    transition_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(
                        "La transición se recuperó, pero el journal no se "
                        "pudo retirar."
                    )
                return (
                    current_identity,
                    journal.selected_percent,
                    journal.selected_percent >= journal.target_percent,
                    None,
                )
        elif (
            journal.phase == "stopped_clean"
            and journal.selected_percent is not None
            and journal.launch_started_at is not None
        ):
            progress = read_progress(progress_path)
            try:
                progress_mtime = progress_path.stat().st_mtime
            except OSError:
                progress_mtime = None
            progress_decision = decide_replacement_loss_progress(
                progress,
                progress_mtime=progress_mtime,
                signalled_at=journal.signalled_at,
                launched_at=journal.launch_started_at,
            )
            if progress_decision.action != "ready":
                return None, None, False, progress_decision.reason
            stationary = read_margin_observation(
                estimate_path=estimate_path,
                database_path=database_path,
                output_dir=output_dir,
                backing_volume=backing_volume,
                target_percent=journal.target_percent,
                require_quick_check=True,
                expected_scope=FULL_MAP_SCOPE,
            )
            if not stationary.valid:
                return None, None, False, stationary.reason
            selected_percent = journal.selected_percent
            if not recovery_selected_percent_is_safe(
                stationary,
                selected_percent=selected_percent,
                target_percent=journal.target_percent,
            ):
                return None, None, False, (
                    f"el reemplazo {selected_percent:g} % cayó y su margen "
                    "ya no cabe en ambos volúmenes"
                )
            if download_lock.exists():
                replacement_owner = owner_pid(download_lock)
                if replacement_owner is None:
                    return None, None, False, (
                        "el bloqueo del reemplazo no contiene un PID válido"
                    )
                lock_pid_to_clear = replacement_owner
        else:
            stationary, stop_error = wait_for_clean_planned_stop(
                journal.old_identity,
                signalled_at=journal.signalled_at,
            )
            if stationary is None:
                return None, None, False, stop_error

        if selected_percent is None:
            selected_percent = transition_launch_percent(
                stationary,
                current_percent=journal.current_percent,
                target_percent=journal.target_percent,
            )
        if selected_percent is None:
            return None, None, False, (
                "la comprobación inmóvil del journal no autoriza relanzar"
            )
        journal = dataclasses.replace(
            journal,
            phase="stopped_clean",
            selected_percent=selected_percent,
            launch_started_at=None,
        )
        if not write_transition_journal(transition_path, journal):
            return None, None, False, (
                "no se pudo persistir la parada limpia recuperada"
            )
        if not clear_stale_lock_if_storage_allows(lock_pid_to_clear):
            return None, None, False, (
                "no se pudo retirar el bloqueo stale durante la recuperación"
            )
        launched_at = time.time()
        journal = dataclasses.replace(
            journal,
            launch_started_at=launched_at,
        )
        if not write_transition_journal(transition_path, journal):
            return None, None, False, (
                "no se pudo persistir el inicio del relanzamiento"
            )
        replacement_identity, launch_error = launch_and_wait(
            selected_percent
        )
        if replacement_identity is None:
            return None, None, False, launch_error
        validation_error = (
            wait_for_target_validation(
                replacement_identity,
                launched_after=launched_at,
                target_percent=journal.target_percent,
            )
            if selected_percent >= journal.target_percent
            else wait_for_resume_health(
                replacement_identity,
                launched_after=launched_at,
            )
        )
        if validation_error is not None:
            return None, None, False, validation_error
        try:
            transition_path.unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "La transición se recuperó, pero el journal no se pudo retirar."
            )
        return (
            replacement_identity,
            selected_percent,
            selected_percent >= journal.target_percent,
            None,
        )

    def recover_transition_with_retries(
        journal: TransitionJournal,
        *,
        attempts: int,
    ) -> tuple[
        ProcessIdentity | None,
        float | None,
        bool,
        str | None,
    ]:
        latest = journal
        last_error: str | None = None
        for attempt in range(max(1, attempts)):
            result = recover_transition(latest)
            if result[0] is not None and result[1] is not None:
                return result
            last_error = result[3]
            if find_download_processes(script_path, output_dir):
                return result
            refreshed = read_transition_journal(transition_path)
            if refreshed is None:
                return result
            progress = read_progress(progress_path)
            progress_is_new = False
            if refreshed.launch_started_at is not None:
                try:
                    progress_is_new = (
                        progress_path.stat().st_mtime
                        >= refreshed.launch_started_at
                    )
                except OSError:
                    pass
            if progress_is_new and (
                not progress.valid
                or safety_signal(progress) is not None
                or progress.status in STOP_STATUSES
                or progress.status in COMPLETE_STATUSES
            ):
                return result
            if attempt + 1 >= max(1, attempts):
                break
            logger.warning(
                "El reemplazo desapareció durante la recuperación; "
                "reintento %d/%d con el mismo porcentaje.",
                attempt + 2,
                max(1, attempts),
            )
            latest = refreshed
        return None, None, False, last_error or (
            "se agotaron los reintentos de recuperación"
        )

    try:
        if storage_stop_path.exists():
            storage_journal = read_storage_stop_journal(storage_stop_path)
            if storage_journal is None:
                raise StorageStopTerminal(
                    "storage_stop.json existe pero no es válido"
                )
            if (
                process_identity_from_fields(
                    storage_journal.identity.pid,
                    storage_journal.identity.started_at,
                    storage_journal.identity.arguments,
                    script_path,
                    output_dir,
                )
                != storage_journal.identity
            ):
                raise StorageStopTerminal(
                    "storage_stop.json no contiene una identidad canónica"
                )
            if not math.isclose(
                storage_journal.target_percent,
                float(args.target_space_headroom_percent),
                rel_tol=0.0,
                abs_tol=1e-9,
            ):
                raise StorageStopTerminal(
                    "el objetivo de storage_stop.json no coincide"
                )
            if storage_journal.phase != "armed":
                reconcile_committed_storage_stop(storage_journal)
            if not exact_live_identity(storage_journal.identity):
                raise StorageStopTerminal(
                    "el latch armado no conserva el PID, identidad y lock "
                    "exactos; no se actuará"
                )
            commit_and_stop_for_storage(
                storage_journal.identity,
                progress_written_after=(
                    storage_journal.progress_written_after
                ),
                armed_journal=storage_journal,
            )
            logger.info(
                "El latch armado fue cancelado porque la reserva vuelve "
                "a caber; se continúa la adopción normal."
            )

        recovered_upgrade_confirmed = False
        if transition_path.exists():
            journal = read_transition_journal(transition_path)
            if journal is None:
                logger.error(
                    "margin_transition.json existe pero no es válido; "
                    "no se actuará."
                )
                return 11
            if (
                process_identity_from_fields(
                    journal.old_identity.pid,
                    journal.old_identity.started_at,
                    journal.old_identity.arguments,
                    script_path,
                    output_dir,
                )
                != journal.old_identity
            ):
                logger.error(
                    "El journal no contiene una identidad canónica del "
                    "descargador completo."
                )
                return 11
            (
                adopted_identity,
                validated_restart_percent,
                recovered_upgrade_confirmed,
                recovery_error,
            ) = recover_transition_with_retries(
                journal,
                attempts=args.max_restarts,
            )
            if (
                adopted_identity is None
                or validated_restart_percent is None
                or recovery_error is not None
            ):
                logger.error(
                    "No se pudo recuperar la transición: %s.",
                    recovery_error or "estado incompleto",
                )
                return 11
            adopted_pid = adopted_identity.pid
            logger.info(
                "Transición recuperada; PID %d adoptado al %.2f %%.",
                adopted_pid,
                validated_restart_percent,
            )
        else:
            processes = find_download_processes(script_path, output_dir)
            if len(processes) != 1:
                logger.error(
                    "Se esperaba exactamente un descargador activo para "
                    "adoptar; se encontraron %d.",
                    len(processes),
                )
                return 3
            adopted_identity = read_process_identity(
                processes[0],
                script_path,
                output_dir,
            )
            if adopted_identity is None:
                logger.error(
                    "El proceso encontrado no coincide con el comando "
                    "canónico del mapa completo."
                )
                return 4
            adopted_pid = adopted_identity.pid
            if not ensure_download_lock(download_lock, adopted_pid):
                logger.error(
                    "No se pudo adquirir el bloqueo del descargador para "
                    "PID %d.",
                    adopted_pid,
                )
                return 4
            validated_restart_percent = read_configured_headroom_percent(
                estimate_path
            )
            process_percent = adopted_identity.headroom_percent
            if (
                validated_restart_percent is None
                or not math.isclose(
                    validated_restart_percent,
                    process_percent,
                    rel_tol=0.0,
                    abs_tol=1e-9,
                )
                or (
                    process_percent < args.target_space_headroom_percent
                    and not math.isclose(
                        process_percent,
                        TEMPORARY_MIGRATION_HEADROOM_PERCENT,
                        rel_tol=0.0,
                        abs_tol=1e-9,
                    )
                )
            ):
                logger.error(
                    "El porcentaje del PID no coincide con estimate.json "
                    "o no es una reserva admitida (18 %% temporal o al "
                    "menos 20 %%)."
                )
                return 4
        logger.info("Descargador PID %d adoptado; solo se vigilará.", adopted_pid)
        if args.once:
            observation = read_progress(progress_path)
            margin = read_margin_observation(
                estimate_path=estimate_path,
                database_path=database_path,
                output_dir=output_dir,
                backing_volume=backing_volume,
                target_percent=args.target_space_headroom_percent,
                expected_scope=FULL_MAP_SCOPE,
            )
            print(
                json.dumps(
                    {
                        "pid": adopted_pid,
                        "status": observation.status,
                        "age_seconds": observation.age_seconds,
                        "http_errors": observation.http_errors,
                        "margin": dataclasses.asdict(margin),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        missing_checks = 0
        last_log = 0.0
        last_margin_check = 0.0
        margin_fit_checks = 0
        storage_stop_checks = 0
        margin_cooldown_until = 0.0
        margin_upgrade_confirmed = recovered_upgrade_confirmed
        margin_progress_written_after = time.time()
        while not stop_requested:
            processes = find_download_processes(script_path, output_dir)
            if len(processes) > 1:
                logger.error(
                    "Se detectaron varios descargadores (%s); no se actuará.",
                    ",".join(str(pid) for pid in processes),
                )
                return 5
            if len(processes) == 1:
                current_pid = processes[0]
                current_identity = read_process_identity(
                    current_pid,
                    script_path,
                    output_dir,
                )
                if current_identity != adopted_identity:
                    logger.error(
                        "Cambió la identidad del proceso (%d; adoptado=%d); "
                        "no se actuará sobre un proceso distinto.",
                        current_pid,
                        adopted_pid,
                    )
                    return 5
                missing_checks = 0
                now = time.monotonic()
                if now - last_log >= 600:
                    observation = read_progress(progress_path)
                    logger.info(
                        "Vigilando PID %d: estado=%s, heartbeat=%.1fs.",
                        adopted_pid,
                        observation.status or "desconocido",
                        observation.age_seconds or 0.0,
                    )
                    last_log = now
                if (
                    now - last_margin_check >= args.margin_check_seconds
                ):
                    margin = read_margin_observation(
                        estimate_path=estimate_path,
                        database_path=database_path,
                        output_dir=output_dir,
                        backing_volume=backing_volume,
                        target_percent=(
                            args.target_space_headroom_percent
                        ),
                        expected_scope=FULL_MAP_SCOPE,
                    )
                    write_margin_observation(margin_path, margin)
                    progress = read_progress(progress_path)
                    progress_is_post_launch = True
                    if margin_progress_written_after is not None:
                        try:
                            progress_is_post_launch = (
                                progress_path.stat().st_mtime
                                >= margin_progress_written_after
                            )
                        except OSError:
                            progress_is_post_launch = False
                    process_percent = adopted_identity.headroom_percent
                    storage_stop_decision = (
                        decide_live_storage_stop(
                            margin,
                            progress,
                            process_percent=process_percent,
                            maximum_heartbeat_age=(
                                args.maximum_heartbeat_age
                            ),
                            progress_is_post_launch=(
                                progress_is_post_launch
                            ),
                        )
                        if owner_pid(download_lock) == adopted_pid
                        else RestartDecision(
                            "stop",
                            "el lock ya no pertenece al PID adoptado",
                        )
                    )
                    margin_decision = decide_margin_transition(
                        margin,
                        progress,
                        process_percent=process_percent,
                        maximum_heartbeat_age=(
                            args.maximum_heartbeat_age
                        ),
                        progress_is_post_launch=progress_is_post_launch,
                    )
                    last_margin_check = now
                    if storage_stop_decision.action == "ready":
                        storage_stop_checks = next_margin_confirmation(
                            storage_stop_checks,
                            storage_stop_decision,
                        )
                        logger.error(
                            "La reserva vigente de %.0f %% no cabe: "
                            "confirmación de freno %d/%d.",
                            process_percent,
                            storage_stop_checks,
                            args.margin_confirmations,
                        )
                    else:
                        if storage_stop_checks:
                            logger.info(
                                "Se reinician las confirmaciones del freno "
                                "de almacenamiento: %s.",
                                storage_stop_decision.reason,
                            )
                        storage_stop_checks = 0
                        if storage_stop_decision.action == "stop":
                            logger.error(
                                "No se evaluará el freno automático: %s.",
                                storage_stop_decision.reason,
                            )

                    if margin_decision.action == "complete":
                        margin_fit_checks = 0
                        margin_upgrade_confirmed = True
                        validated_restart_percent = max(
                            validated_restart_percent,
                            float(args.target_space_headroom_percent),
                        )
                        logger.info(
                            "Reserva independiente ya validada al %.2f %%.",
                            validated_restart_percent,
                        )
                    elif (
                        margin_decision.action == "ready"
                        and now >= margin_cooldown_until
                    ):
                        margin_upgrade_confirmed = False
                        margin_fit_checks = next_margin_confirmation(
                            margin_fit_checks,
                            margin_decision,
                        )
                        logger.warning(
                            "El margen de %.0f %% cabe: confirmación "
                            "%d/%d.",
                            args.target_space_headroom_percent,
                            margin_fit_checks,
                            args.margin_confirmations,
                        )
                    elif margin_decision.action == "ready":
                        if margin_fit_checks:
                            logger.info(
                                "Se reinician las confirmaciones del margen "
                                "durante el cooldown."
                            )
                        margin_fit_checks = 0
                    else:
                        if (
                            process_percent
                            >= args.target_space_headroom_percent
                        ):
                            margin_upgrade_confirmed = False
                        if margin_fit_checks:
                            logger.info(
                                "Se reinician las confirmaciones del margen: "
                                "%s.",
                                margin_decision.reason,
                            )
                        margin_fit_checks = next_margin_confirmation(
                            margin_fit_checks,
                            margin_decision,
                        )
                        if margin.valid and margin.shortfall_bytes:
                            if (
                                process_percent
                                >= args.target_space_headroom_percent
                            ):
                                logger.warning(
                                    "La reserva %.0f %% ya no cabe; faltan "
                                    "%.2f GiB en el volumen limitante.",
                                    args.target_space_headroom_percent,
                                    margin.shortfall_bytes / 1024**3,
                                )
                            else:
                                logger.info(
                                    "Transición a %.0f %% pendiente; faltan "
                                    "%.2f GiB en el volumen limitante.",
                                    args.target_space_headroom_percent,
                                    margin.shortfall_bytes / 1024**3,
                                )
                        elif margin_decision.action == "stop":
                            logger.error(
                                "No se intentará la transición: %s.",
                                margin_decision.reason,
                            )

                    if (
                        storage_stop_decision.action == "ready"
                        and storage_stop_checks
                        >= args.margin_confirmations
                    ):
                        commit_and_stop_for_storage(
                            adopted_identity,
                            progress_written_after=(
                                margin_progress_written_after
                            ),
                        )
                        storage_stop_checks = 0
                        last_margin_check = time.monotonic()
                        time.sleep(args.poll_seconds)
                        continue

                    if (
                        margin_decision.action == "ready"
                        and margin_fit_checks
                        >= args.margin_confirmations
                        and not args.no_auto_margin_upgrade
                    ):
                        immediate_margin = read_margin_observation(
                            estimate_path=estimate_path,
                            database_path=database_path,
                            output_dir=output_dir,
                            backing_volume=backing_volume,
                            target_percent=(
                                args.target_space_headroom_percent
                            ),
                            expected_scope=FULL_MAP_SCOPE,
                        )
                        immediate_progress = read_progress(progress_path)
                        immediate_decision = decide_margin_transition(
                            immediate_margin,
                            immediate_progress,
                            process_percent=(
                                adopted_identity.headroom_percent
                            ),
                            maximum_heartbeat_age=(
                                args.maximum_heartbeat_age
                            ),
                            progress_is_post_launch=progress_is_post_launch,
                        )
                        if (
                            immediate_decision.action != "ready"
                            or find_download_processes(
                                script_path, output_dir
                            )
                            != [adopted_pid]
                            or read_process_identity(
                                adopted_pid,
                                script_path,
                                output_dir,
                            )
                            != adopted_identity
                            or owner_pid(download_lock) != adopted_pid
                        ):
                            logger.warning(
                                "La verificación inmediata canceló el "
                                "intento de transición: %s.",
                                immediate_decision.reason,
                            )
                            margin_fit_checks = 0
                            time.sleep(args.poll_seconds)
                            continue

                        restart_now = time.monotonic()
                        while (
                            restart_times
                            and restart_now - restart_times[0]
                            > args.restart_window_seconds
                        ):
                            restart_times.popleft()
                        if len(restart_times) >= args.max_restarts:
                            logger.error(
                                "No se hará la transición: se alcanzó el "
                                "límite de reinicios."
                            )
                            margin_fit_checks = 0
                            margin_cooldown_until = (
                                restart_now
                                + args.margin_retry_cooldown_seconds
                            )
                            time.sleep(args.poll_seconds)
                            continue

                        if (
                            read_process_identity(
                                adopted_pid,
                                script_path,
                                output_dir,
                            )
                            != adopted_identity
                            or owner_pid(download_lock) != adopted_pid
                        ):
                            logger.error(
                                "La identidad o el bloqueo cambió justo "
                                "antes de la transición; no se enviará señal."
                            )
                            return 9
                        signalled_at = time.time()
                        transition_journal = TransitionJournal(
                            phase="prepared",
                            old_identity=adopted_identity,
                            current_percent=validated_restart_percent,
                            target_percent=float(
                                args.target_space_headroom_percent
                            ),
                            signalled_at=signalled_at,
                        )
                        if not write_transition_journal(
                            transition_path,
                            transition_journal,
                        ):
                            logger.error(
                                "No se pudo persistir el journal; no se "
                                "enviará señal."
                            )
                            return 9
                        final_margin = read_margin_observation(
                            estimate_path=estimate_path,
                            database_path=database_path,
                            output_dir=output_dir,
                            backing_volume=backing_volume,
                            target_percent=(
                                args.target_space_headroom_percent
                            ),
                            expected_scope=FULL_MAP_SCOPE,
                        )
                        final_progress = read_progress(progress_path)
                        try:
                            final_progress_is_post_launch = (
                                progress_path.stat().st_mtime
                                >= margin_progress_written_after
                            )
                        except OSError:
                            final_progress_is_post_launch = False
                        final_decision = decide_margin_transition(
                            final_margin,
                            final_progress,
                            process_percent=(
                                adopted_identity.headroom_percent
                            ),
                            maximum_heartbeat_age=(
                                args.maximum_heartbeat_age
                            ),
                            progress_is_post_launch=(
                                final_progress_is_post_launch
                            ),
                        )
                        final_identity_is_safe = (
                            find_download_processes(
                                script_path,
                                output_dir,
                            )
                            == [adopted_pid]
                            and read_process_identity(
                                adopted_pid,
                                script_path,
                                output_dir,
                            )
                            == adopted_identity
                            and owner_pid(download_lock) == adopted_pid
                        )
                        if (
                            final_decision.action != "ready"
                            or not final_identity_is_safe
                        ):
                            if not remove_transition_journal(transition_path):
                                logger.error(
                                    "El gate final cambió y no se pudo "
                                    "cancelar durablemente el journal; no se "
                                    "enviará señal."
                                )
                                return 9
                            logger.warning(
                                "El gate final cambió después de persistir "
                                "el journal; transición cancelada sin señal: "
                                "%s.",
                                (
                                    final_decision.reason
                                    if final_decision.action != "ready"
                                    else "cambió la identidad o el bloqueo"
                                ),
                            )
                            margin_fit_checks = 0
                            last_margin_check = time.monotonic()
                            time.sleep(args.poll_seconds)
                            continue
                        if (
                            read_process_identity(
                                adopted_pid,
                                script_path,
                                output_dir,
                            )
                            != adopted_identity
                            or owner_pid(download_lock) != adopted_pid
                        ):
                            logger.error(
                                "La identidad o el bloqueo cambió después "
                                "de persistir el journal; no se enviará señal."
                            )
                            return 9
                        if storage_stop_path.exists():
                            raise StorageStopTerminal(
                                "storage_stop.json apareció antes de la "
                                "transición; no se enviará señal"
                            )
                        try:
                            os.kill(adopted_pid, signal.SIGINT)
                        except (ProcessLookupError, PermissionError) as exc:
                            logger.error(
                                "No se pudo solicitar la parada limpia: %s.",
                                exc,
                            )
                            return 9
                        logger.warning(
                            "Transición limpia de %.2f %% a %.2f %%: se "
                            "envió un único SIGINT.",
                            validated_restart_percent,
                            args.target_space_headroom_percent,
                        )
                        transition_journal = dataclasses.replace(
                            transition_journal,
                            phase="signal_sent",
                        )
                        if not write_transition_journal(
                            transition_path,
                            transition_journal,
                        ):
                            logger.warning(
                                "No se pudo confirmar signal_sent en disco; "
                                "el journal prepared permite recuperación."
                            )
                        stationary, stop_error = wait_for_clean_planned_stop(
                            adopted_identity,
                            signalled_at=signalled_at,
                        )
                        if stationary is None:
                            logger.error(
                                "Transición cancelada después del SIGINT: %s.",
                                stop_error,
                            )
                            return 9

                        target_percent = float(
                            args.target_space_headroom_percent
                        )
                        selected_percent = transition_launch_percent(
                            stationary,
                            current_percent=validated_restart_percent,
                            target_percent=target_percent,
                        )
                        if selected_percent is None:
                            logger.error(
                                "La comprobación inmóvil no autorizó ningún "
                                "relanzamiento."
                            )
                            return 9
                        launch_percent = selected_percent
                        transition_journal = dataclasses.replace(
                            transition_journal,
                            phase="stopped_clean",
                            selected_percent=launch_percent,
                        )
                        if not write_transition_journal(
                            transition_path,
                            transition_journal,
                        ):
                            logger.error(
                                "No se pudo persistir la parada limpia; no "
                                "se retirará el bloqueo."
                            )
                            return 9
                        if launch_percent >= target_percent:
                            # Impide un downgrade mientras el nuevo proceso
                            # todavía está reescribiendo estimate.json.
                            validated_restart_percent = target_percent
                        else:
                            margin_cooldown_until = (
                                time.monotonic()
                                + args.margin_retry_cooldown_seconds
                            )
                            logger.warning(
                                "La comprobación inmóvil ya no cabe; se "
                                "reanudará %.2f %% y se reintentará después.",
                                launch_percent,
                            )
                        if not clear_stale_lock_if_storage_allows(adopted_pid):
                            logger.error(
                                "No se retiró el bloqueo tras la parada "
                                "limpia; no se relanzará."
                            )
                            return 9
                        launched_at = time.time()
                        transition_journal = dataclasses.replace(
                            transition_journal,
                            launch_started_at=launched_at,
                        )
                        if not write_transition_journal(
                            transition_path,
                            transition_journal,
                        ):
                            logger.error(
                                "No se pudo persistir el relanzamiento; no "
                                "se iniciará un proceso nuevo."
                            )
                            return 9
                        replacement_identity, launch_error = launch_and_wait(
                            launch_percent
                        )
                        if replacement_identity is None:
                            logger.error(
                                "No se pudo reanudar tras la transición: %s.",
                                launch_error,
                            )
                            return 8
                        adopted_identity = replacement_identity
                        adopted_pid = replacement_identity.pid
                        missing_checks = 0
                        margin_fit_checks = 0
                        storage_stop_checks = 0
                        last_margin_check = time.monotonic()
                        margin_progress_written_after = launched_at
                        if launch_percent >= target_percent:
                            validation_error = wait_for_target_validation(
                                adopted_identity,
                                launched_after=launched_at,
                                target_percent=target_percent,
                            )
                            if validation_error is not None:
                                logger.warning(
                                    "El nuevo proceso no validó %.0f %%: %s; "
                                    "se intentará recuperar el journal.",
                                    target_percent,
                                    validation_error,
                                )
                                if len(restart_times) >= args.max_restarts:
                                    return 10
                                (
                                    recovered_identity,
                                    recovered_percent,
                                    recovered_confirmed,
                                    recovery_error,
                                ) = recover_transition_with_retries(
                                    transition_journal,
                                    attempts=max(
                                        1,
                                        args.max_restarts
                                        - len(restart_times),
                                    ),
                                )
                                if (
                                    recovered_identity is None
                                    or recovered_percent is None
                                    or recovery_error is not None
                                ):
                                    logger.error(
                                        "La recuperación del reemplazo "
                                        "falló: %s.",
                                        recovery_error or "estado incompleto",
                                    )
                                    return 10
                                adopted_identity = recovered_identity
                                adopted_pid = recovered_identity.pid
                                validated_restart_percent = recovered_percent
                                margin_upgrade_confirmed = recovered_confirmed
                                margin_fit_checks = 0
                                storage_stop_checks = 0
                                last_margin_check = time.monotonic()
                                margin_progress_written_after = time.time()
                                logger.info(
                                    "Reemplazo recuperado con PID %d al "
                                    "%.2f %%.",
                                    adopted_pid,
                                    recovered_percent,
                                )
                                continue
                            margin_upgrade_confirmed = True
                            logger.info(
                                "Transición confirmada: PID %d, plan "
                                "completo y reserva %.0f %%.",
                                adopted_pid,
                                target_percent,
                            )
                        else:
                            validation_error = wait_for_resume_health(
                                adopted_identity,
                                launched_after=launched_at,
                            )
                            if validation_error is not None:
                                logger.warning(
                                    "El proceso temporal no confirmó salud: "
                                    "%s; se intentará recuperar el journal.",
                                    validation_error,
                                )
                                if len(restart_times) >= args.max_restarts:
                                    return 10
                                (
                                    recovered_identity,
                                    recovered_percent,
                                    recovered_confirmed,
                                    recovery_error,
                                ) = recover_transition_with_retries(
                                    transition_journal,
                                    attempts=max(
                                        1,
                                        args.max_restarts
                                        - len(restart_times),
                                    ),
                                )
                                if (
                                    recovered_identity is None
                                    or recovered_percent is None
                                    or recovery_error is not None
                                ):
                                    logger.error(
                                        "La recuperación del reemplazo "
                                        "temporal falló: %s.",
                                        recovery_error or "estado incompleto",
                                    )
                                    return 10
                                adopted_identity = recovered_identity
                                adopted_pid = recovered_identity.pid
                                validated_restart_percent = recovered_percent
                                margin_upgrade_confirmed = recovered_confirmed
                                margin_fit_checks = 0
                                storage_stop_checks = 0
                                last_margin_check = time.monotonic()
                                margin_progress_written_after = time.time()
                                logger.info(
                                    "Reemplazo temporal recuperado con PID "
                                    "%d al %.2f %%.",
                                    adopted_pid,
                                    recovered_percent,
                                )
                                continue
                            logger.info(
                                "PID %d reanudado temporalmente con %.2f %%.",
                                adopted_pid,
                                launch_percent,
                            )
                        try:
                            transition_path.unlink(missing_ok=True)
                        except OSError:
                            logger.warning(
                                "La transición terminó, pero no se pudo "
                                "retirar margin_transition.json."
                            )
                        continue
                time.sleep(args.poll_seconds)
                continue

            observation = read_progress(progress_path)
            free_floor = read_free_floor(estimate_path)
            free_bytes: int | None = None
            backing_free_bytes: int | None = None
            if output_dir.is_dir():
                try:
                    free_bytes = shutil.disk_usage(output_dir).free
                except OSError:
                    pass
            if backing_volume.is_dir():
                try:
                    backing_free_bytes = shutil.disk_usage(
                        backing_volume
                    ).free
                except OSError:
                    pass
            decision = decide_after_process_loss(
                observation,
                output_mounted=os.path.ismount(output_dir.parent),
                launcher_exists=launcher.is_file(),
                image_exists=image_path.is_dir(),
                free_bytes=free_bytes,
                free_floor_bytes=free_floor,
                backing_free_bytes=backing_free_bytes,
                backing_free_floor_bytes=free_floor,
            )
            if decision.action == "complete":
                logger.info("Descarga terminada: %s.", decision.reason)
                return 0
            if decision.action == "stop":
                logger.error(
                    "No se reanudará automáticamente: %s.", decision.reason
                )
                return 6

            missing_checks += 1
            logger.warning(
                "PID ausente, confirmación %d/%d: %s.",
                missing_checks,
                args.missing_confirmations,
                decision.reason,
            )
            if missing_checks < args.missing_confirmations:
                time.sleep(args.poll_seconds)
                continue

            now = time.monotonic()
            while (
                restart_times
                and now - restart_times[0] > args.restart_window_seconds
            ):
                restart_times.popleft()
            if len(restart_times) >= args.max_restarts:
                logger.error(
                    "Se alcanzó el límite de %d reinicios en la ventana.",
                    args.max_restarts,
                )
                return 7
            if find_download_processes(script_path, output_dir):
                missing_checks = 0
                continue
            restart_margin = read_margin_observation(
                estimate_path=estimate_path,
                database_path=database_path,
                output_dir=output_dir,
                backing_volume=backing_volume,
                target_percent=validated_restart_percent,
                require_quick_check=True,
                expected_scope=FULL_MAP_SCOPE,
            )
            restart_storage_decision = decide_restart_storage(
                restart_margin,
                restart_percent=validated_restart_percent,
            )
            if restart_storage_decision.action != "ready":
                logger.error(
                    "No se reanudará automáticamente: %s.",
                    restart_storage_decision.reason,
                )
                return 6
            if not clear_stale_lock_if_storage_allows(adopted_pid):
                logger.error(
                    "No se pudo retirar el bloqueo del PID desaparecido %d.",
                    adopted_pid,
                )
                return 7

            logger.warning(
                "Reanudando mediante el lanzador seguro con %.2f %% de "
                "reserva.",
                validated_restart_percent,
            )
            restart_launched_at = time.time()
            replacement_identity, launch_error = launch_and_wait(
                validated_restart_percent
            )
            if replacement_identity is None:
                logger.error("%s.", launch_error)
                return 8
            validation_error = wait_for_resume_health(
                replacement_identity,
                launched_after=restart_launched_at,
            )
            if validation_error is not None:
                logger.error(
                    "El reemplazo no produjo un heartbeat nuevo y sano: %s.",
                    validation_error,
                )
                return 8
            adopted_identity = replacement_identity
            adopted_pid = replacement_identity.pid
            missing_checks = 0
            margin_fit_checks = 0
            storage_stop_checks = 0
            last_margin_check = time.monotonic()
            margin_upgrade_confirmed = False
            margin_progress_written_after = restart_launched_at
            logger.info("Descarga reanudada y PID %d adoptado.", adopted_pid)
        logger.info("Supervisor detenido; el descargador no recibió señales.")
        return 0
    except StorageStopTerminal as exc:
        logger.critical(
            "Freno de almacenamiento terminal: %s. No se limpiará el "
            "bloqueo, no se enviará otra señal y no se relanzará.",
            exc,
        )
        return 12
    finally:
        supervisor_lock.close()


if __name__ == "__main__":
    raise SystemExit(run())
