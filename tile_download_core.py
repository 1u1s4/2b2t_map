"""Shared, conservative tile I/O primitives for bounded regional work.

This module is intentionally not a command-line entry point. The supported
operator surface is ``download_region_2b2t.py``, which always requires explicit
Overworld bounds and enforces a small regional inventory.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import email.utils
import hashlib
import json
import logging
import math
import os
import random
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import requests
from PIL import Image, UnidentifiedImageError


__all__ = (
    "LAYERS",
    "MAX_LOD",
    "MIN_LOD",
    "AdaptiveRateLimiter",
    "DownloadResult",
    "DownloadTask",
    "TileDatabase",
    "TileFetcher",
    "TileSpec",
    "configure_logging",
    "validate_webp",
)

BASE_URL = "https://2b2t.place"
TILE_PIXELS = 512
MIN_LOD = 0
MAX_LOD = 10
DIMENSIONS = {"overworld": 0, "nether": 1, "end": 2}
LAYERS = ("base", "overlay", "newchunks")
USER_AGENT = (
    "obsidian-atlas-regional-downloader/3.0 "
    "(bounded Overworld tile access; conservative rate; https://github.com/)"
)

RETRYABLE_STATUSES = {408, 425, 429}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def js_trunc_div(value: int, divisor: int) -> int:
    """División entera truncada hacia cero, como `(value / divisor) >> 0`."""
    if divisor <= 0:
        raise ValueError("divisor must be positive")
    quotient = abs(value) // divisor
    return -quotient if value < 0 else quotient


def human_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB", "PiB")
    amount = float(max(0, value))
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.2f} {unit}"
        amount /= 1024
    return f"{amount:.2f} PiB"


def is_retryable_http_status(status: int) -> bool:
    return status in RETRYABLE_STATUSES or 500 <= status <= 599


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        current = (
            dt.datetime.fromtimestamp(now, tz=dt.timezone.utc)
            if now is not None
            else dt.datetime.now(dt.timezone.utc)
        )
        return max(0.0, (parsed - current).total_seconds())
    except (TypeError, ValueError, OverflowError):
        return None


@dataclasses.dataclass(frozen=True, slots=True)
class TileSpec:
    dimension: str
    layer: str
    lod: int
    tile_x: int
    tile_z: int

    def __post_init__(self) -> None:
        if self.dimension not in DIMENSIONS:
            raise ValueError(f"dimensión inválida: {self.dimension}")
        if self.layer not in LAYERS:
            raise ValueError(f"capa inválida: {self.layer}")
        if not MIN_LOD <= self.lod <= MAX_LOD:
            raise ValueError(f"LOD inválido: {self.lod}")

    @property
    def dimension_id(self) -> int:
        return DIMENSIONS[self.dimension]

    @property
    def shard_x(self) -> int:
        return js_trunc_div(self.tile_x, 32)

    @property
    def shard_z(self) -> int:
        return js_trunc_div(self.tile_z, 32)

    @property
    def url(self) -> str:
        return (
            f"{BASE_URL}/tiles/{self.layer}/{self.lod}/{self.dimension_id}/"
            f"{self.shard_x}/{self.shard_z}/"
            f"t.{self.tile_x}.{self.tile_z}.webp"
        )

    def path(self, output_root: Path) -> Path:
        return (
            output_root
            / self.layer
            / str(self.lod)
            / self.dimension
            / str(self.shard_x)
            / str(self.shard_z)
            / f"t.{self.tile_x}.{self.tile_z}.webp"
        )

    def children(self) -> tuple["TileSpec", ...]:
        if self.lod <= MIN_LOD:
            return ()
        child_lod = self.lod - 1
        child_x = self.tile_x * 2
        child_z = self.tile_z * 2
        return (
            TileSpec(self.dimension, self.layer, child_lod, child_x, child_z),
            TileSpec(self.dimension, self.layer, child_lod, child_x + 1, child_z),
            TileSpec(self.dimension, self.layer, child_lod, child_x, child_z + 1),
            TileSpec(
                self.dimension,
                self.layer,
                child_lod,
                child_x + 1,
                child_z + 1,
            ),
        )


@dataclasses.dataclass(slots=True)
class Validation:
    valid: bool
    size_bytes: int = 0
    sha256: str | None = None
    error: str | None = None


def validate_webp(path: Path, *, calculate_hash: bool = True) -> Validation:
    try:
        size = path.stat().st_size
        if size < 16:
            return Validation(False, size_bytes=size, error="archivo demasiado corto")
        with path.open("rb") as handle:
            header = handle.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WEBP":
            return Validation(False, size_bytes=size, error="firma RIFF/WEBP inválida")
        declared_size = int.from_bytes(header[4:8], "little") + 8
        if declared_size != size:
            return Validation(
                False,
                size_bytes=size,
                error=(
                    f"tamaño RIFF declarado {declared_size} != "
                    f"tamaño real {size}"
                ),
            )
        with Image.open(path) as image:
            if image.format != "WEBP":
                return Validation(
                    False, size_bytes=size, error=f"formato inesperado: {image.format}"
                )
            if image.size != (TILE_PIXELS, TILE_PIXELS):
                return Validation(
                    False,
                    size_bytes=size,
                    error=f"dimensiones inesperadas: {image.size}",
                )
            image.verify()
        with Image.open(path) as image:
            image.load()
        digest: str | None = None
        if calculate_hash:
            hasher = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
            digest = hasher.hexdigest()
        return Validation(True, size_bytes=size, sha256=digest)
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        return Validation(False, error=f"{type(exc).__name__}: {exc}")


@dataclasses.dataclass(slots=True)
class DownloadTask:
    row_id: int
    spec: TileSpec
    selected: bool


@dataclasses.dataclass(slots=True)
class DownloadResult:
    task: DownloadTask
    status: str
    exists: bool
    http_code: int | None
    attempts: int
    size_bytes: int = 0
    sha256: str | None = None
    error: str | None = None
    downloaded_bytes: int = 0
    elapsed: float = 0.0


class TileDatabase:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=30)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA busy_timeout=30000")
        self._create_schema()

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS tiles (
                id INTEGER PRIMARY KEY,
                url TEXT NOT NULL UNIQUE,
                dimension TEXT NOT NULL,
                dimension_id INTEGER NOT NULL,
                layer TEXT NOT NULL,
                lod INTEGER NOT NULL,
                tile_x INTEGER NOT NULL,
                tile_z INTEGER NOT NULL,
                shard_x INTEGER NOT NULL,
                shard_z INTEGER NOT NULL,
                relative_path TEXT NOT NULL,
                selected INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending',
                http_code INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                size_bytes INTEGER,
                sha256 TEXT,
                downloaded_at TEXT,
                error_message TEXT,
                children_seeded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                UNIQUE(layer, lod, dimension, tile_x, tile_z)
            );

            CREATE INDEX IF NOT EXISTS idx_tiles_queue
                ON tiles(status, lod DESC, id);
            CREATE INDEX IF NOT EXISTS idx_tiles_group
                ON tiles(dimension, layer, lod, status);

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.commit()
        self.connection.close()

    def set_metadata(self, key: str, value: Any) -> None:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True)
        self.connection.execute(
            """
            INSERT INTO metadata(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value=excluded.value, updated_at=excluded.updated_at
            """,
            (key, encoded, utc_now()),
        )
        self.connection.commit()

    def add_tile(self, spec: TileSpec, output_root: Path, *, selected: bool) -> int:
        relative_path = str(spec.path(output_root).relative_to(output_root))
        self.connection.execute(
            """
            INSERT OR IGNORE INTO tiles(
                url, dimension, dimension_id, layer, lod, tile_x, tile_z,
                shard_x, shard_z, relative_path, selected, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                spec.url,
                spec.dimension,
                spec.dimension_id,
                spec.layer,
                spec.lod,
                spec.tile_x,
                spec.tile_z,
                spec.shard_x,
                spec.shard_z,
                relative_path,
                int(selected),
                utc_now(),
            ),
        )
        self.connection.execute(
            """
            UPDATE tiles
            SET selected = CASE WHEN ? THEN 1 ELSE selected END, updated_at=?
            WHERE layer=? AND lod=? AND dimension=? AND tile_x=? AND tile_z=?
            """,
            (
                int(selected),
                utc_now(),
                spec.layer,
                spec.lod,
                spec.dimension,
                spec.tile_x,
                spec.tile_z,
            ),
        )
        row = self.connection.execute(
            """
            SELECT id FROM tiles
            WHERE layer=? AND lod=? AND dimension=? AND tile_x=? AND tile_z=?
            """,
            (
                spec.layer,
                spec.lod,
                spec.dimension,
                spec.tile_x,
                spec.tile_z,
            ),
        ).fetchone()
        assert row is not None
        return int(row["id"])


    def record_result(
        self,
        result: DownloadResult,
        output_root: Path,
        *,
        min_lod: int,
        selected_lods: set[int],
    ) -> None:
        downloaded_at = utc_now() if result.status == "complete" else None
        self.connection.execute(
            """
            UPDATE tiles
            SET status=?, http_code=?, attempts=attempts+?, size_bytes=?,
                sha256=?, downloaded_at=COALESCE(?, downloaded_at),
                error_message=?, updated_at=?
            WHERE id=?
            """,
            (
                result.status,
                result.http_code,
                result.attempts,
                result.size_bytes,
                result.sha256,
                downloaded_at,
                result.error,
                utc_now(),
                result.task.row_id,
            ),
        )
        if result.exists and result.task.spec.lod > min_lod:
            for child in result.task.spec.children():
                self.add_tile(
                    child,
                    output_root,
                    selected=child.lod in selected_lods,
                )
            self.connection.execute(
                "UPDATE tiles SET children_seeded=1, updated_at=? WHERE id=?",
                (utc_now(), result.task.row_id),
            )
        self.connection.commit()



class AdaptiveRateLimiter:
    """Token spacing shared by every worker, with protection-aware slowdown."""

    def __init__(self, requests_per_second: float, stop_event: threading.Event):
        if not math.isfinite(requests_per_second) or requests_per_second <= 0:
            raise ValueError("--requests-per-second debe ser finito y > 0")
        self.initial_rate = requests_per_second
        self._rate = requests_per_second
        self._next_request = 0.0
        self._lock = threading.Lock()
        self.stop_event = stop_event

    @property
    def rate(self) -> float:
        with self._lock:
            return self._rate

    def acquire(self) -> bool:
        while not self.stop_event.is_set():
            with self._lock:
                now = time.monotonic()
                wait = max(0.0, self._next_request - now)
                if wait <= 0:
                    self._next_request = max(now, self._next_request) + (
                        1.0 / self._rate
                    )
                    return True
            if self.stop_event.wait(min(wait, 1.0)):
                return False
        return False

    def slow_down(self, factor: float = 0.5) -> float:
        with self._lock:
            self._rate = max(0.05, self._rate * factor)
            return self._rate


class TileFetcher:
    def __init__(
        self,
        output_root: Path,
        *,
        limiter: AdaptiveRateLimiter,
        stop_event: threading.Event,
        timeout: float,
        retries: int,
        max_tile_bytes: int,
        logger: logging.Logger,
    ) -> None:
        self.output_root = output_root
        self.limiter = limiter
        self.stop_event = stop_event
        self.timeout = timeout
        self.retries = retries
        self.max_tile_bytes = max_tile_bytes
        self.logger = logger
        self.local = threading.local()
        self.protection_lock = threading.Lock()
        self.consecutive_403 = 0
        self.consecutive_429 = 0
        self.protection_reason: str | None = None

    def _session(self) -> requests.Session:
        session = getattr(self.local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(
                {
                    "User-Agent": USER_AGENT,
                    "Referer": f"{BASE_URL}/",
                    "Accept": "image/webp,image/*;q=0.8,*/*;q=0.1",
                }
            )
            self.local.session = session
        return session

    def _protection_response(self, status: int) -> None:
        with self.protection_lock:
            if status == 403:
                self.consecutive_403 += 1
                self.consecutive_429 = 0
                new_rate = self.limiter.slow_down(0.5)
                self.logger.warning(
                    "HTTP 403: velocidad reducida a %.3f solicitudes/s",
                    new_rate,
                )
                if self.consecutive_403 >= 3:
                    self.protection_reason = (
                        "tres respuestas HTTP 403 consecutivas; "
                        "descarga detenida sin intentar evadir el bloqueo"
                    )
                    self.stop_event.set()
            elif status == 429:
                self.consecutive_429 += 1
                self.consecutive_403 = 0
                new_rate = self.limiter.slow_down(0.5)
                self.logger.warning(
                    "HTTP 429: velocidad reducida a %.3f solicitudes/s",
                    new_rate,
                )
                if self.consecutive_429 >= 5:
                    self.protection_reason = (
                        "cinco respuestas HTTP 429 consecutivas; "
                        "descarga detenida para respetar el servidor"
                    )
                    self.stop_event.set()

    def _non_protection_response(self) -> None:
        with self.protection_lock:
            self.consecutive_403 = 0
            self.consecutive_429 = 0

    def fetch(self, task: DownloadTask) -> DownloadResult:
        started = time.monotonic()
        spec = task.spec
        destination = spec.path(self.output_root)

        if task.selected and destination.exists():
            validation = validate_webp(destination)
            if validation.valid:
                return DownloadResult(
                    task,
                    "complete",
                    True,
                    None,
                    0,
                    size_bytes=validation.size_bytes,
                    sha256=validation.sha256,
                    elapsed=time.monotonic() - started,
                )
            quarantine = destination.with_name(
                f"{destination.name}.corrupt.{int(time.time())}"
            )
            try:
                os.replace(destination, quarantine)
                self.logger.warning(
                    "Tile local corrupto movido a %s: %s",
                    quarantine,
                    validation.error,
                )
            except OSError as exc:
                return DownloadResult(
                    task,
                    "corrupt",
                    False,
                    None,
                    0,
                    error=(
                        f"tile local inválido ({validation.error}); "
                        f"no se pudo poner en cuarentena: {exc}"
                    ),
                    elapsed=time.monotonic() - started,
                )

        # La descarga regional valida y conserva el WebP con un único GET por
        # intento; no hace un HEAD previo que duplique solicitudes exitosas.
        method = "GET"
        last_error: str | None = None
        last_status: int | None = None
        attempts = 0
        downloaded_bytes = 0

        for attempt in range(1, self.retries + 1):
            if self.stop_event.is_set():
                break
            if not self.limiter.acquire():
                break
            attempts += 1
            try:
                response = self._session().request(
                    method,
                    spec.url,
                    stream=True,
                    timeout=self.timeout,
                    allow_redirects=True,
                )
                last_status = response.status_code

                if response.status_code == 404:
                    self._non_protection_response()
                    response.close()
                    return DownloadResult(
                        task,
                        "absent",
                        False,
                        404,
                        attempts,
                        error="tile no publicado",
                        elapsed=time.monotonic() - started,
                    )

                if 200 <= response.status_code < 300:
                    self._non_protection_response()
                    result = self._stream_response(task, response)
                    downloaded_bytes += result.downloaded_bytes
                    result.attempts = attempts
                    result.http_code = response.status_code
                    result.elapsed = time.monotonic() - started
                    result.downloaded_bytes = downloaded_bytes
                    if result.status not in ("corrupt", "failed"):
                        return result
                    last_error = result.error
                    if attempt >= self.retries or self.stop_event.is_set():
                        return result
                    delay = min(
                        60.0, (2 ** (attempt - 1)) + random.random()
                    )
                    if self.stop_event.wait(delay):
                        return result
                    continue

                if response.status_code in (403, 429):
                    self._protection_response(response.status_code)
                else:
                    self._non_protection_response()

                body_excerpt = ""
                try:
                    body_excerpt = response.text[:160].replace("\n", " ")
                except requests.RequestException:
                    pass
                retry_after = parse_retry_after(
                    response.headers.get("Retry-After")
                )
                response.close()
                last_error = (
                    f"HTTP {last_status}"
                    + (f": {body_excerpt}" if body_excerpt else "")
                )

                if (
                    not is_retryable_http_status(last_status)
                    and last_status != 403
                ):
                    break
                if self.stop_event.is_set():
                    break
                delay = (
                    retry_after
                    if retry_after is not None
                    else min(60.0, (2 ** (attempt - 1)) + random.random())
                )
                if self.stop_event.wait(delay):
                    break
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt < self.retries:
                    delay = min(60.0, (2 ** (attempt - 1)) + random.random())
                    if self.stop_event.wait(delay):
                        break

        status = "protection" if last_status in (403, 429) else "failed"
        if self.stop_event.is_set() and self.protection_reason:
            last_error = self.protection_reason
        return DownloadResult(
            task,
            status,
            False,
            last_status,
            attempts,
            error=last_error or "interrumpido antes de completar la petición",
            downloaded_bytes=downloaded_bytes,
            elapsed=time.monotonic() - started,
        )

    def _stream_response(
        self, task: DownloadTask, response: requests.Response
    ) -> DownloadResult:
        destination = task.spec.path(self.output_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".part",
            dir=destination.parent,
        )
        temporary = Path(temporary_name)
        size = 0
        digest = hashlib.sha256()
        try:
            with os.fdopen(descriptor, "wb") as handle:
                for chunk in response.iter_content(chunk_size=128 * 1024):
                    if self.stop_event.is_set() and self.protection_reason:
                        raise InterruptedError(self.protection_reason)
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > self.max_tile_bytes:
                        raise ValueError(
                            f"respuesta supera el límite de "
                            f"{human_bytes(self.max_tile_bytes)}"
                        )
                    handle.write(chunk)
                    digest.update(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            response.close()

            validation = validate_webp(temporary, calculate_hash=False)
            if not validation.valid:
                return DownloadResult(
                    task,
                    "corrupt",
                    False,
                    response.status_code,
                    0,
                    size_bytes=size,
                    error=f"WebP inválido: {validation.error}",
                    downloaded_bytes=size,
                )
            os.replace(temporary, destination)
            try:
                directory_descriptor = os.open(destination.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_descriptor)
                finally:
                    os.close(directory_descriptor)
            except OSError:
                pass
            return DownloadResult(
                task,
                "complete",
                True,
                response.status_code,
                0,
                size_bytes=size,
                sha256=digest.hexdigest(),
                downloaded_bytes=size,
            )
        except (OSError, ValueError, InterruptedError) as exc:
            response.close()
            return DownloadResult(
                task,
                "corrupt" if isinstance(exc, ValueError) else "failed",
                False,
                response.status_code,
                0,
                size_bytes=size,
                error=f"{type(exc).__name__}: {exc}",
                downloaded_bytes=size,
            )
        finally:
            temporary.unlink(missing_ok=True)


def configure_logging(output_root: Path, verbose: bool) -> logging.Logger:
    output_root.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("download_region_2b2t")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(threadName)s %(message)s"
    )
    file_handler = logging.FileHandler(
        output_root / "download.log", encoding="utf-8"
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.DEBUG if verbose else logging.INFO)
    console_handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(console_handler)
    return logger
