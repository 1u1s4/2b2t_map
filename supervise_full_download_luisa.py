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
import os
import shutil
import signal
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


def configure_logging(output_dir: Path) -> logging.Logger:
    logger = logging.getLogger("obsidian_atlas_supervisor")
    logger.setLevel(logging.INFO)
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


def read_free_floor(estimate_path: Path) -> int | None:
    try:
        payload = json.loads(estimate_path.read_text(encoding="utf-8"))
        plan = payload["plan"]
        value = plan["headroom_bytes"]
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        return None
    return value if isinstance(value, int) and value >= 0 else None


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
    parser.add_argument("--max-restarts", type=int, default=3)
    parser.add_argument(
        "--restart-window-seconds",
        type=float,
        default=24 * 60 * 60,
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
    if args.max_restarts <= 0:
        parser.error("--max-restarts debe ser mayor que cero")
    if args.restart_window_seconds <= 0:
        parser.error("--restart-window-seconds debe ser mayor que cero")
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

    try:
        processes = find_download_processes(script_path, output_dir)
        if len(processes) != 1:
            logger.error(
                "Se esperaba exactamente un descargador activo para adoptar; "
                "se encontraron %d.",
                len(processes),
            )
            return 3
        adopted_pid = processes[0]
        if not ensure_download_lock(download_lock, adopted_pid):
            logger.error(
                "No se pudo adquirir el bloqueo del descargador para PID %d.",
                adopted_pid,
            )
            return 4
        logger.info("Descargador PID %d adoptado; solo se vigilará.", adopted_pid)
        if args.once:
            observation = read_progress(progress_path)
            print(
                json.dumps(
                    {
                        "pid": adopted_pid,
                        "status": observation.status,
                        "age_seconds": observation.age_seconds,
                        "http_errors": observation.http_errors,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        missing_checks = 0
        restart_times: collections.deque[float] = collections.deque()
        last_log = 0.0
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
                if current_pid != adopted_pid:
                    logger.error(
                        "Apareció un PID distinto (%d; adoptado=%d); "
                        "no se adoptará un proceso iniciado externamente.",
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
            if not clear_stale_download_lock(download_lock, adopted_pid):
                logger.error(
                    "No se pudo retirar el bloqueo del PID desaparecido %d.",
                    adopted_pid,
                )
                return 7

            logger.warning("Reanudando una única vez mediante el lanzador seguro.")
            child = subprocess.Popen([str(launcher)], cwd=project_dir)
            restart_times.append(now)
            deadline = time.monotonic() + args.startup_timeout
            replacement: list[int] = []
            while time.monotonic() < deadline and not stop_requested:
                replacement = find_download_processes(script_path, output_dir)
                if len(replacement) == 1:
                    break
                if len(replacement) > 1:
                    logger.error(
                        "El reinicio creó varias instancias; no se actuará."
                    )
                    return 8
                if child.poll() is not None:
                    break
                time.sleep(min(5.0, args.poll_seconds))
            if len(replacement) != 1:
                logger.error(
                    "El lanzador no produjo una única instancia en %.0fs "
                    "(salida=%s).",
                    args.startup_timeout,
                    child.poll(),
                )
                return 8
            adopted_pid = replacement[0]
            missing_checks = 0
            logger.info("Descarga reanudada y PID %d adoptado.", adopted_pid)
        logger.info("Supervisor detenido; el descargador no recibió señales.")
        return 0
    finally:
        supervisor_lock.close()


if __name__ == "__main__":
    raise SystemExit(run())
