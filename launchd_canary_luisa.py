#!/usr/bin/env python3
"""One-shot, read-only health canary for the full LuisA download.

The download output is never modified.  The only write probe is a short-lived
sentinel below ``~/Library/Application Support/ObsidianAtlas/canary``.  A
durable JSON result is atomically published beside that directory.

This file intentionally remains compatible with Python 3.9 even though the
launchd source uses the TCC-authorized Python 3.11 interpreter on the target
machine.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import os
import plistlib
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Tuple


SCHEMA_VERSION = 1
EXPECTED_REPOSITORY = Path(
    "/Users/luisalvarado/Documents/GitHub/2b2t_map"
)
EXPECTED_OUTPUT = Path("/Volumes/2b2t Tiles/2b2t_tiles")
EXPECTED_LUISA_MOUNT = Path("/Volumes/LuisA")
EXPECTED_APFS_MOUNT = Path("/Volumes/2b2t Tiles")
EXPECTED_LUISA_UUID = "D1445254-D3DC-3AE9-9BE7-E55D401ACE68"
EXPECTED_APFS_UUID = "CBBDD2B8-D219-446C-AFDA-088E2E68C409"
EXPECTED_SPARSEBUNDLE = Path(
    "/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle"
)
APP_SUPPORT = Path(
    "/Users/luisalvarado/Library/Application Support/ObsidianAtlas"
)
SENTINEL_DIRECTORY = APP_SUPPORT / "canary"
RESULT_PATH = APP_SUPPORT / "canary-result.json"
DISKUTIL = Path("/usr/sbin/diskutil")
HDIUTIL = Path("/usr/bin/hdiutil")
ACTIVE_PROGRESS_STATUSES = frozenset(("running", "discovering"))
COMPLETE_PROGRESS_STATUSES = frozenset(("complete",))
MAXIMUM_PROGRESS_BYTES = 2 * 1024 * 1024
MAXIMUM_HDIUTIL_INFO_PLIST_BYTES = 8 * 1024 * 1024
HDIUTIL_TIMEOUT_SECONDS = 30.0


class CanaryError(RuntimeError):
    """A health check could not prove its invariant."""


@dataclasses.dataclass(frozen=True)
class CanaryConfig:
    repository: Path = EXPECTED_REPOSITORY
    output: Path = EXPECTED_OUTPUT
    luisa_mount: Path = EXPECTED_LUISA_MOUNT
    apfs_mount: Path = EXPECTED_APFS_MOUNT
    expected_luisa_uuid: str = EXPECTED_LUISA_UUID
    expected_apfs_uuid: str = EXPECTED_APFS_UUID
    app_support: Path = APP_SUPPORT
    sentinel_directory: Path = SENTINEL_DIRECTORY
    result_path: Path = RESULT_PATH
    maximum_progress_age_seconds: float = 15 * 60
    sqlite_timeout_seconds: float = 15.0
    required_repository_files: Tuple[str, ...] = (
        "download_all_2b2t.py",
        "supervise_full_download_luisa.py",
    )

    @property
    def progress_path(self) -> Path:
        return self.output / "progress.json"

    @property
    def database_path(self) -> Path:
        return self.output / "tiles.sqlite3"


DiskInfoReader = Callable[[Path], Mapping[str, Any]]
CommandRunner = Callable[..., subprocess.CompletedProcess]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def isoformat_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def normalized_uuid(value: Any) -> str:
    if not isinstance(value, str):
        raise CanaryError("diskutil no devolvió un UUID de volumen")
    try:
        return str(uuid.UUID(value)).upper()
    except (ValueError, AttributeError) as exc:
        raise CanaryError("diskutil devolvió un UUID inválido") from exc


def absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.path.expanduser(str(path))))


def ensure_fixed_write_paths(config: CanaryConfig) -> None:
    app_support = absolute_lexical(config.app_support)
    sentinel = absolute_lexical(config.sentinel_directory)
    result = absolute_lexical(config.result_path)
    if not config.app_support.is_absolute():
        raise CanaryError("la ruta de Application Support no es absoluta")
    if sentinel != app_support / "canary":
        raise CanaryError("el sentinel no está confinado al directorio canary")
    if result.parent != app_support or result.name != "canary-result.json":
        raise CanaryError(
            "el resultado no está confinado a ObsidianAtlas en App Support"
        )
    output = absolute_lexical(config.output)
    if sentinel == output or output in sentinel.parents:
        raise CanaryError("el sentinel no puede residir en el output")
    if result == output or output in result.parents:
        raise CanaryError("el resultado no puede residir en el output")


def ensure_plain_directory(path: Path, mode: int = 0o700) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        path.mkdir(mode=mode, parents=True, exist_ok=False)
        info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise CanaryError("{} no es un directorio real".format(path))


def open_directory(path: Path) -> int:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(str(path), flags)
    except OSError as exc:
        raise CanaryError(
            "no se pudo abrir el directorio {}".format(path)
        ) from exc


def write_all(file_descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(file_descriptor, payload[offset:])
        if written <= 0:
            raise CanaryError("la escritura del sentinel no avanzó")
        offset += written


def check_sentinel(config: CanaryConfig) -> Dict[str, Any]:
    """Create, fsync and remove one sentinel in the approved local directory."""

    ensure_fixed_write_paths(config)
    ensure_plain_directory(config.app_support)
    ensure_plain_directory(config.sentinel_directory)
    directory_fd = open_directory(config.sentinel_directory)
    sentinel_name = ".sentinel-{}-{}".format(
        os.getpid(), secrets.token_hex(12)
    )
    sentinel_fd = -1
    created = False
    removed = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        sentinel_fd = os.open(
            sentinel_name,
            flags,
            0o600,
            dir_fd=directory_fd,
        )
        created = True
        write_all(sentinel_fd, b"obsidian-atlas-canary-v1\n")
        os.fsync(sentinel_fd)
        os.close(sentinel_fd)
        sentinel_fd = -1
        os.unlink(sentinel_name, dir_fd=directory_fd)
        created = False
        removed = True
        os.fsync(directory_fd)
    except OSError as exc:
        raise CanaryError(
            "falló el ciclo escribir/fsync/eliminar del sentinel"
        ) from exc
    finally:
        if sentinel_fd >= 0:
            os.close(sentinel_fd)
        if created:
            try:
                os.unlink(sentinel_name, dir_fd=directory_fd)
                os.fsync(directory_fd)
                removed = True
            except OSError:
                removed = False
        os.close(directory_fd)
    if not removed:
        raise CanaryError("no se pudo confirmar la eliminación del sentinel")
    return {
        "ok": True,
        "directory": str(config.sentinel_directory),
        "fsync": True,
        "removed": True,
    }


def read_small_regular_file(path: Path, maximum_bytes: int) -> bytes:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        file_descriptor = os.open(str(path), flags)
    except OSError as exc:
        raise CanaryError("no se pudo abrir {}".format(path)) from exc
    try:
        info = os.fstat(file_descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise CanaryError("{} no es un archivo regular".format(path))
        if info.st_size > maximum_bytes:
            raise CanaryError("{} excede el límite de lectura".format(path))
        chunks = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(file_descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > maximum_bytes:
            raise CanaryError("{} excede el límite de lectura".format(path))
        return payload
    finally:
        os.close(file_descriptor)


def check_repository(config: CanaryConfig) -> Dict[str, Any]:
    repository_fd = open_directory(config.repository)
    os.close(repository_fd)
    git_marker = config.repository / ".git"
    try:
        git_info = git_marker.lstat()
    except OSError as exc:
        raise CanaryError("el repo no contiene un marcador .git legible") from exc
    if stat.S_ISDIR(git_info.st_mode):
        git_fd = open_directory(git_marker)
        os.close(git_fd)
    elif stat.S_ISREG(git_info.st_mode):
        read_small_regular_file(git_marker, 64 * 1024)
    else:
        raise CanaryError("el marcador .git no es un archivo o directorio")

    checked_files = []
    for relative_name in config.required_repository_files:
        if Path(relative_name).is_absolute() or ".." in Path(relative_name).parts:
            raise CanaryError("la lista de archivos requeridos no es segura")
        path = config.repository / relative_name
        payload = read_small_regular_file(path, 8 * 1024 * 1024)
        if not payload:
            raise CanaryError("{} está vacío".format(relative_name))
        checked_files.append(relative_name)
    return {
        "ok": True,
        "path": str(config.repository),
        "required_files": checked_files,
    }


def read_disk_info(mount: Path) -> Mapping[str, Any]:
    try:
        completed = subprocess.run(
            [str(DISKUTIL), "info", "-plist", str(mount)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15.0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise CanaryError("no se pudo ejecutar diskutil") from exc
    if completed.returncode != 0:
        raise CanaryError(
            "diskutil no pudo consultar {}".format(mount)
        )
    try:
        value = plistlib.loads(completed.stdout)
    except (plistlib.InvalidFileException, ValueError) as exc:
        raise CanaryError("diskutil devolvió un plist inválido") from exc
    if not isinstance(value, dict):
        raise CanaryError("diskutil no devolvió un diccionario")
    return value


def check_volume(
    mount: Path,
    expected_uuid: str,
    expected_filesystem: str,
    disk_info_reader: DiskInfoReader,
) -> Dict[str, Any]:
    directory_fd = open_directory(mount)
    os.close(directory_fd)
    info = disk_info_reader(mount)
    observed_mount = info.get("MountPoint")
    if observed_mount != str(mount):
        raise CanaryError(
            "diskutil devolvió un punto de montaje inesperado"
        )
    observed_uuid = normalized_uuid(info.get("VolumeUUID"))
    wanted_uuid = normalized_uuid(expected_uuid)
    if observed_uuid != wanted_uuid:
        raise CanaryError(
            "el UUID de {} no coincide con el esperado".format(mount)
        )
    observed_filesystem = info.get("FilesystemType")
    if (
        not isinstance(observed_filesystem, str)
        or observed_filesystem.lower() != expected_filesystem.lower()
    ):
        raise CanaryError(
            "el sistema de archivos de {} no es {}".format(
                mount, expected_filesystem
            )
        )
    if info.get("WritableVolume") is not True:
        raise CanaryError("{} no está montado como escribible".format(mount))
    return {
        "ok": True,
        "mount": str(mount),
        "uuid": observed_uuid,
        "filesystem": observed_filesystem.lower(),
        "writable": True,
    }


def check_sparsebundle(
    runner: CommandRunner = subprocess.run,
) -> Dict[str, Any]:
    """Confirm the exact sparsebundle is already attached at the right mount.

    ``hdiutil imageinfo`` attempts to open the image and fails while a live
    sparsebundle is busy.  ``hdiutil info`` only reads the attachment
    inventory, so this check does not open, attach, mount or modify the image.
    """

    arguments = [
        str(HDIUTIL),
        "info",
        "-plist",
    ]
    try:
        completed = runner(
            arguments,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=HDIUTIL_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise CanaryError(
            "hdiutil no pudo inspeccionar el sparsebundle"
        ) from exc
    if completed.returncode != 0:
        raise CanaryError(
            "hdiutil info terminó con código {}".format(
                completed.returncode
            )
        )
    stdout = completed.stdout
    if not isinstance(stdout, bytes):
        raise CanaryError("hdiutil no devolvió un plist binario legible")
    if not stdout or len(stdout) > MAXIMUM_HDIUTIL_INFO_PLIST_BYTES:
        raise CanaryError(
            "el plist de hdiutil está vacío o excede el límite"
        )
    try:
        value = plistlib.loads(stdout)
    except (plistlib.InvalidFileException, ValueError) as exc:
        raise CanaryError("hdiutil devolvió un plist inválido") from exc
    if not isinstance(value, dict):
        raise CanaryError("hdiutil no devolvió un inventario")
    images = value.get("images")
    if not isinstance(images, list):
        raise CanaryError("hdiutil no devolvió una lista de imágenes")

    expected_image_path = str(
        absolute_lexical(EXPECTED_SPARSEBUNDLE)
    )
    matching_images = []
    for image in images:
        if not isinstance(image, dict):
            continue
        image_path = image.get("image-path")
        if not isinstance(image_path, str) or not image_path:
            continue
        if str(absolute_lexical(Path(image_path))) == expected_image_path:
            matching_images.append(image)
    if len(matching_images) != 1:
        raise CanaryError(
            "hdiutil debe listar exactamente una imagen para el sparsebundle; "
            "encontró {}".format(len(matching_images))
        )

    image = matching_images[0]
    entities = image.get("system-entities")
    if not isinstance(entities, list):
        raise CanaryError(
            "la imagen no contiene una lista de entidades"
        )
    expected_mount_point = str(
        absolute_lexical(EXPECTED_APFS_MOUNT)
    )
    matching_entities = []
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        mount_point = entity.get("mount-point")
        if not isinstance(mount_point, str) or not mount_point:
            continue
        if str(absolute_lexical(Path(mount_point))) == expected_mount_point:
            matching_entities.append(entity)
    if len(matching_entities) != 1:
        raise CanaryError(
            "la imagen debe tener exactamente una entidad montada en {}; "
            "encontró {}".format(
                EXPECTED_APFS_MOUNT, len(matching_entities)
            )
        )

    entity = matching_entities[0]
    result = {
        "ok": True,
        "image_path": str(EXPECTED_SPARSEBUNDLE),
        "mount_point": str(EXPECTED_APFS_MOUNT),
        "tool": str(HDIUTIL),
        "operation": "info",
        "plist": True,
        "matching_images": 1,
        "matching_mounted_entities": 1,
    }
    image_type = image.get("image-type")
    if isinstance(image_type, str) and image_type:
        result["image_type"] = image_type
    device = entity.get("dev-entry")
    if isinstance(device, str) and device:
        result["device"] = device
    return result


def parse_progress_time(value: Any) -> dt.datetime:
    if not isinstance(value, str) or not value.strip():
        raise CanaryError("progress.json no contiene updated_at")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise CanaryError("updated_at no es una fecha ISO válida") from exc
    if parsed.tzinfo is None:
        raise CanaryError("updated_at no contiene zona horaria")
    return parsed.astimezone(dt.timezone.utc)


def require_nonnegative_integer(payload: Mapping[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CanaryError("{} no es un entero no negativo".format(key))
    return value


def check_progress(
    config: CanaryConfig,
    now: dt.datetime,
) -> Dict[str, Any]:
    raw = read_small_regular_file(
        config.progress_path, MAXIMUM_PROGRESS_BYTES
    )
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CanaryError("progress.json no contiene JSON UTF-8 válido") from exc
    if not isinstance(payload, dict):
        raise CanaryError("progress.json no contiene un objeto JSON")

    status_value = payload.get("status")
    if not isinstance(status_value, str):
        raise CanaryError("progress.json no contiene status válido")
    status = status_value.strip().lower()
    accepted_statuses = ACTIVE_PROGRESS_STATUSES | COMPLETE_PROGRESS_STATUSES
    if status not in accepted_statuses:
        raise CanaryError(
            "progress.json no describe una descarga activa o completa"
        )

    processed = require_nonnegative_integer(payload, "processed_requests")
    planned = require_nonnegative_integer(payload, "planned_requests")
    remaining = require_nonnegative_integer(payload, "remaining_requests")
    if planned <= 0:
        raise CanaryError("planned_requests debe ser mayor que cero")
    if processed > planned or remaining > planned:
        raise CanaryError("los contadores de progress.json son incoherentes")
    percent_value = payload.get("progress_percent")
    if (
        isinstance(percent_value, bool)
        or not isinstance(percent_value, (int, float))
        or not 0.0 <= float(percent_value) <= 100.0
    ):
        raise CanaryError("progress_percent está fuera de rango")

    updated_at = parse_progress_time(payload.get("updated_at"))
    age_seconds = (now - updated_at).total_seconds()
    if age_seconds < -5 * 60:
        raise CanaryError("updated_at está demasiado adelantado")
    if (
        status in ACTIVE_PROGRESS_STATUSES
        and age_seconds > config.maximum_progress_age_seconds
    ):
        raise CanaryError("progress.json está estancado")
    return {
        "ok": True,
        "status": status,
        "processed_requests": processed,
        "planned_requests": planned,
        "remaining_requests": remaining,
        "progress_percent": float(percent_value),
        "updated_at": isoformat_utc(updated_at),
        "age_seconds": max(0.0, round(age_seconds, 3)),
    }


def check_sqlite(config: CanaryConfig) -> Dict[str, Any]:
    try:
        info = config.database_path.lstat()
    except OSError as exc:
        raise CanaryError("tiles.sqlite3 no existe") from exc
    if not stat.S_ISREG(info.st_mode):
        raise CanaryError("tiles.sqlite3 no es un archivo regular")
    database_uri = "{}?mode=ro".format(
        config.database_path.absolute().as_uri()
    )
    try:
        connection = sqlite3.connect(
            database_uri,
            uri=True,
            timeout=config.sqlite_timeout_seconds,
        )
        try:
            connection.execute("PRAGMA query_only=ON")
            query_only = connection.execute(
                "PRAGMA query_only"
            ).fetchone()
            if query_only is None or int(query_only[0]) != 1:
                raise CanaryError(
                    "SQLite no confirmó el modo query_only"
                )
            rows = connection.execute("PRAGMA quick_check").fetchmany(2)
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise CanaryError(
            "no se pudo ejecutar PRAGMA quick_check en modo de solo lectura"
        ) from exc
    if len(rows) != 1 or str(rows[0][0]).strip().lower() != "ok":
        raise CanaryError("PRAGMA quick_check no devolvió exactamente ok")
    return {
        "ok": True,
        "database": str(config.database_path),
        "open_mode": "ro",
        "query_only": True,
        "quick_check": "ok",
    }


def safe_check(
    function: Callable[[], Dict[str, Any]],
) -> Dict[str, Any]:
    try:
        result = function()
        if result.get("ok") is not True:
            raise CanaryError("el check no confirmó ok")
        return result
    except Exception as exc:  # Each check must report; one must not mask others.
        return {
            "ok": False,
            "error": "{}: {}".format(type(exc).__name__, str(exc)),
        }


def build_result(
    config: CanaryConfig,
    now: Optional[dt.datetime] = None,
    disk_info_reader: DiskInfoReader = read_disk_info,
    image_info_runner: CommandRunner = subprocess.run,
) -> Dict[str, Any]:
    started = time.monotonic()
    observed_now = now if now is not None else utc_now()
    if observed_now.tzinfo is None:
        raise CanaryError("el reloj del canary debe incluir zona horaria")
    checks = {
        "repository": safe_check(lambda: check_repository(config)),
        "luisa_volume": safe_check(
            lambda: check_volume(
                config.luisa_mount,
                config.expected_luisa_uuid,
                "exfat",
                disk_info_reader,
            )
        ),
        "apfs_volume": safe_check(
            lambda: check_volume(
                config.apfs_mount,
                config.expected_apfs_uuid,
                "apfs",
                disk_info_reader,
            )
        ),
        "sparsebundle": safe_check(
            lambda: check_sparsebundle(image_info_runner)
        ),
        "progress": safe_check(
            lambda: check_progress(config, observed_now)
        ),
        "sqlite": safe_check(lambda: check_sqlite(config)),
        "sentinel": safe_check(lambda: check_sentinel(config)),
    }
    healthy = all(check.get("ok") is True for check in checks.values())
    return {
        "schema_version": SCHEMA_VERSION,
        "checked_at": isoformat_utc(observed_now),
        "healthy": healthy,
        "checks": checks,
        "duration_seconds": round(time.monotonic() - started, 6),
    }


def atomic_write_result(config: CanaryConfig, payload: Mapping[str, Any]) -> None:
    ensure_fixed_write_paths(config)
    ensure_plain_directory(config.app_support)
    directory_fd = open_directory(config.app_support)
    temporary_name = ".canary-result-{}-{}.tmp".format(
        os.getpid(), secrets.token_hex(12)
    )
    file_descriptor = -1
    temporary_exists = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        file_descriptor = os.open(
            temporary_name,
            flags,
            0o600,
            dir_fd=directory_fd,
        )
        temporary_exists = True
        encoded = (
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")
        write_all(file_descriptor, encoded)
        os.fsync(file_descriptor)
        os.close(file_descriptor)
        file_descriptor = -1
        os.replace(
            temporary_name,
            config.result_path.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        temporary_exists = False
        os.fsync(directory_fd)
    except OSError as exc:
        raise CanaryError("no se pudo publicar el resultado JSON") from exc
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except OSError:
                pass
        os.close(directory_fd)


def run_once(
    config: Optional[CanaryConfig] = None,
    now: Optional[dt.datetime] = None,
    disk_info_reader: DiskInfoReader = read_disk_info,
    image_info_runner: CommandRunner = subprocess.run,
) -> Tuple[int, Dict[str, Any]]:
    selected_config = config if config is not None else CanaryConfig()
    result = build_result(
        selected_config,
        now=now,
        disk_info_reader=disk_info_reader,
        image_info_runner=image_info_runner,
    )
    try:
        atomic_write_result(selected_config, result)
    except Exception as exc:
        failed_result = dict(result)
        failed_result["healthy"] = False
        failed_result["result_write_error"] = "{}: {}".format(
            type(exc).__name__, str(exc)
        )
        return 2, failed_result
    return (0 if result["healthy"] else 1), result


def main(argv: Optional[Sequence[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        print(
            "launchd_canary_luisa.py no acepta argumentos",
            file=sys.stderr,
        )
        return 64
    exit_code, result = run_once()
    print(
        json.dumps(
            {
                "checked_at": result.get("checked_at"),
                "healthy": result.get("healthy"),
                "result": str(RESULT_PATH),
            },
            sort_keys=True,
        )
    )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
