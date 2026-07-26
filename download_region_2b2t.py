#!/usr/bin/env python3
"""Download and optionally compose a bounded 2b2t.place map region.

Ranges use half-open Minecraft block coordinates:
``[x_min, x_max) × [z_min, z_max)``. X increases to the right and Z increases
downward. Existing valid WebP files are validated and reused automatically.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime
import errno
import fcntl
import json
import logging
import math
import os
import shutil
import signal
import sys
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from pathlib import Path
from typing import TextIO

from compose_mosaic import (
    DEFAULT_MAX_PIXELS,
    BlockRange,
    MosaicError,
    compose_mosaic,
)
from tile_download_core import (
    LAYERS,
    MAX_LOD,
    MIN_LOD,
    AdaptiveRateLimiter,
    DownloadResult,
    DownloadTask,
    TileDatabase,
    TileFetcher,
    TileSpec,
    configure_logging,
    validate_webp,
)


DEFAULT_OUTPUT_ROOT = Path("2b2t_tiles")
DEFAULT_LAYERS = ("base", "overlay")
DEFAULT_WORKERS = 4
DEFAULT_REQUESTS_PER_SECOND = 8.0
DEFAULT_INITIAL_REQUESTS_PER_SECOND = 4.0
MAX_WORKERS = 8
MAX_REQUESTS_PER_SECOND = 16.0
DEFAULT_TIMEOUT = 30.0
DEFAULT_RETRIES = 5
DEFAULT_MAX_TILE_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_TILES = 100_000
DEFAULT_PENDING_TASKS_PER_WORKER = 2
DEFAULT_ESTIMATED_TILE_BYTES = 1 * 1024 * 1024
DEFAULT_STORAGE_MARGIN = 1.20
DEFAULT_RUNTIME_DISK_RESERVE_BYTES = 256 * 1024 * 1024
DEFAULT_DISK_CHECK_INTERVAL = 32
DEFAULT_DATABASE_COMMIT_INTERVAL = 32
DEFAULT_DATABASE_COMMIT_SECONDS = 1.0
REGION_DOWNLOAD_LOCK_NAME = ".region-download.lock"


class RegionDownloadLockedError(RuntimeError):
    """Raised when another regional downloader owns an output directory."""

    def __init__(self, lock_path: Path, metadata: dict[str, object]) -> None:
        details: list[str] = []
        pid = metadata.get("pid")
        started_at = metadata.get("started_at")
        if isinstance(pid, int):
            details.append(f"PID {pid}")
        if isinstance(started_at, str):
            details.append(f"desde {started_at}")
        holder = f" ({', '.join(details)})" if details else ""
        super().__init__(
            "ya hay una descarga regional activa para este directorio"
            f"{holder}; lock: {lock_path}"
        )
        self.lock_path = lock_path
        self.metadata = metadata


class RegionDownloadLock:
    """Non-blocking advisory lock scoped to one canonical output directory."""

    def __init__(self, output_root: Path) -> None:
        self.path = output_root / REGION_DOWNLOAD_LOCK_NAME
        self._handle: TextIO | None = None

    @staticmethod
    def _read_metadata(handle: TextIO) -> dict[str, object]:
        try:
            handle.seek(0)
            value = json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def acquire(self) -> None:
        if self._handle is not None:
            raise RuntimeError("regional download lock is already acquired")

        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(
                handle.fileno(),
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
        except OSError as exc:
            metadata = self._read_metadata(handle)
            handle.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise RegionDownloadLockedError(self.path, metadata) from None
            raise

        metadata = {
            "pid": os.getpid(),
            "started_at": datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat(),
        }
        try:
            handle.seek(0)
            handle.truncate()
            json.dump(metadata, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()
            raise
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        self._handle = None
        if handle is None:
            return
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self) -> RegionDownloadLock:
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


@dataclasses.dataclass(frozen=True, slots=True)
class RegionDownloadSummary:
    requested: int
    complete: int
    absent: int
    failed: int
    reused: int
    downloaded_bytes: int
    interrupted: bool
    processed: int = 0
    reused_absent: int = 0
    stop_reason: str | None = None
    request_attempts: int = 0
    elapsed_seconds: float = 0.0
    tiles_per_second: float = 0.0
    bytes_per_second: float = 0.0
    effective_rps: float = 0.0
    target_rps: float = 0.0
    network_requested: int | None = None
    network_processed: int = 0
    resolved_per_second: float = 0.0
    network_tiles_per_second: float = 0.0
    achieved_rps: float = 0.0


@dataclasses.dataclass(frozen=True, slots=True)
class RegionStorageEstimate:
    requested: int
    existing_complete: int
    reusable_absent: int
    missing: int
    estimated_tile_bytes: int
    required_bytes: int


@dataclasses.dataclass(frozen=True, slots=True)
class RegionDownloadProgress:
    """Monotonic snapshot suitable for a UI or another supervising process."""

    event: str
    requested: int | None
    processed: int
    complete: int
    absent: int
    failed: int
    reused: int
    reused_absent: int
    downloaded_bytes: int
    interrupted: bool
    status: str
    stop_reason: str | None = None
    request_attempts: int = 0
    elapsed_seconds: float = 0.0
    tiles_per_second: float = 0.0
    bytes_per_second: float = 0.0
    eta_seconds: float | None = None
    effective_rps: float = 0.0
    target_rps: float = 0.0
    cooldown_seconds: float = 0.0
    network_requested: int | None = None
    network_processed: int = 0
    resolved_per_second: float = 0.0
    network_tiles_per_second: float = 0.0
    achieved_rps: float = 0.0

    @property
    def percent(self) -> float:
        if self.requested is None or self.requested <= 0:
            return 0.0
        return min(100.0, self.processed * 100.0 / self.requested)

    def as_json(self) -> dict[str, object]:
        return {
            "type": "region-download",
            "version": 1,
            "event": self.event,
            "status": self.status,
            "requested": self.requested,
            "processed": self.processed,
            "complete": self.complete,
            "absent": self.absent,
            "failed": self.failed,
            "reused": self.reused,
            "reusedAbsent": self.reused_absent,
            "downloadedBytes": self.downloaded_bytes,
            "interrupted": self.interrupted,
            "percent": round(self.percent, 4),
            "stopReason": self.stop_reason,
            "requestAttempts": self.request_attempts,
            "elapsedSeconds": round(self.elapsed_seconds, 3),
            "tilesPerSecond": round(self.tiles_per_second, 3),
            "bytesPerSecond": round(self.bytes_per_second, 3),
            "etaSeconds": (
                round(self.eta_seconds, 3)
                if self.eta_seconds is not None
                else None
            ),
            "effectiveRps": round(self.effective_rps, 3),
            "targetRps": round(self.target_rps, 3),
            "cooldownSeconds": round(self.cooldown_seconds, 3),
            "networkRequested": self.network_requested,
            "networkProcessed": self.network_processed,
            "resolvedPerSecond": round(self.resolved_per_second, 3),
            "networkTilesPerSecond": round(
                self.network_tiles_per_second,
                3,
            ),
            "achievedRps": round(self.achieved_rps, 3),
        }


class JsonlProgressReporter:
    """Write one compact, flushed JSON object per progress snapshot."""

    def __init__(
        self,
        stream: TextIO,
        *,
        minimum_interval: float = 0.25,
    ) -> None:
        if minimum_interval < 0:
            raise ValueError("minimum_interval must not be negative")
        self.stream = stream
        self.minimum_interval = minimum_interval
        self.available = True
        self.last_progress_at = 0.0

    def __call__(self, progress: RegionDownloadProgress) -> None:
        if not self.available:
            return
        now = time.monotonic()
        if (
            progress.event == "progress"
            and now - self.last_progress_at < self.minimum_interval
        ):
            return
        try:
            print(
                json.dumps(
                    progress.as_json(),
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                file=self.stream,
                flush=True,
            )
            self.last_progress_at = now
        except BrokenPipeError:
            # Losing an optional observer must not corrupt a long local job.
            self.available = False


def parse_layers(value: str) -> tuple[str, ...]:
    """Parse a comma-separated layer list while preserving its order."""

    layers = tuple(
        dict.fromkeys(
            part.strip()
            for part in value.split(",")
            if part.strip()
        )
    )
    if not layers:
        raise argparse.ArgumentTypeError("provide at least one layer")
    invalid = tuple(layer for layer in layers if layer not in LAYERS)
    if invalid:
        raise argparse.ArgumentTypeError(
            "unknown layer(s): "
            + ", ".join(invalid)
            + f"; choose from {', '.join(LAYERS)}"
        )
    return layers


def resolve_region(args: argparse.Namespace) -> BlockRange:
    """Resolve explicit bounds or center/width/height into a half-open range."""

    explicit = (args.x_min, args.z_min, args.x_max, args.z_max)
    centered = (args.center_x, args.center_z, args.width, args.height)
    has_explicit = any(value is not None for value in explicit)
    has_centered = any(value is not None for value in centered)

    if has_explicit and has_centered:
        raise ValueError(
            "use either explicit --x-min/--z-min/--x-max/--z-max bounds "
            "or --center-x/--center-z/--width/--height"
        )
    if has_explicit:
        if any(value is None for value in explicit):
            raise ValueError(
                "explicit mode requires --x-min, --z-min, --x-max, and --z-max"
            )
        return BlockRange(*explicit)

    if not has_centered:
        raise ValueError(
            "provide explicit bounds or "
            "--center-x/--center-z/--width/--height"
        )
    if any(value is None for value in centered):
        raise ValueError(
            "center mode requires --center-x, --center-z, --width, and --height"
        )
    if args.width <= 0 or args.height <= 0:
        raise ValueError("--width and --height must be positive")

    x_min = args.center_x - args.width // 2
    z_min = args.center_z - args.height // 2
    return BlockRange(
        x_min=x_min,
        z_min=z_min,
        x_max=x_min + args.width,
        z_max=z_min + args.height,
    )


@dataclasses.dataclass(frozen=True, slots=True)
class RegionSpecInventory(Sequence[TileSpec]):
    """Reiterable, indexable regional inventory that allocates no TileSpecs."""

    dimension: str
    lod: int
    layers: tuple[str, ...]
    tile_x_min: int
    tile_z_min: int
    tile_x_max: int
    tile_z_max: int

    @property
    def columns(self) -> int:
        return self.tile_x_max - self.tile_x_min + 1

    @property
    def rows(self) -> int:
        return self.tile_z_max - self.tile_z_min + 1

    def __len__(self) -> int:
        return self.columns * self.rows * len(self.layers)

    def __iter__(self) -> Iterator[TileSpec]:
        for layer in self.layers:
            for tile_z in range(self.tile_z_min, self.tile_z_max + 1):
                for tile_x in range(self.tile_x_min, self.tile_x_max + 1):
                    yield TileSpec(
                        self.dimension,
                        layer,
                        self.lod,
                        tile_x,
                        tile_z,
                    )

    def __getitem__(self, index: int | slice) -> TileSpec | tuple[TileSpec, ...]:
        if isinstance(index, slice):
            return tuple(
                self[position]
                for position in range(*index.indices(len(self)))
            )
        if index < 0:
            index += len(self)
        if index < 0 or index >= len(self):
            raise IndexError("regional tile index out of range")
        tiles_per_layer = self.columns * self.rows
        layer_index, layer_offset = divmod(index, tiles_per_layer)
        row, column = divmod(layer_offset, self.columns)
        return TileSpec(
            self.dimension,
            self.layers[layer_index],
            self.lod,
            self.tile_x_min + column,
            self.tile_z_min + row,
        )


def required_region_specs(
    block_range: BlockRange,
    *,
    lod: int,
    dimension: str,
    layers: Sequence[str],
) -> RegionSpecInventory:
    """Return a lazy direct-tile inventory ordered by layer, Z, then X."""

    if dimension != "overworld":
        raise ValueError("only the Overworld is supported")
    if not MIN_LOD <= lod <= MAX_LOD:
        raise ValueError(f"lod must be from {MIN_LOD} to {MAX_LOD}")
    if not layers:
        raise ValueError("at least one layer is required")

    tile_blocks = 512 * (1 << lod)
    return RegionSpecInventory(
        dimension=dimension,
        lod=lod,
        layers=tuple(layers),
        tile_x_min=block_range.x_min // tile_blocks,
        tile_z_min=block_range.z_min // tile_blocks,
        tile_x_max=(block_range.x_max - 1) // tile_blocks,
        tile_z_max=(block_range.z_max - 1) // tile_blocks,
    )


def region_tile_count(
    block_range: BlockRange,
    *,
    lod: int,
    layer_count: int,
) -> int:
    """Count a regional inventory without allocating its TileSpec objects."""

    if not MIN_LOD <= lod <= MAX_LOD:
        raise ValueError(f"lod must be from {MIN_LOD} to {MAX_LOD}")
    if layer_count <= 0:
        raise ValueError("layer_count must be positive")
    tile_blocks = 512 * (1 << lod)
    tile_x_min = block_range.x_min // tile_blocks
    tile_z_min = block_range.z_min // tile_blocks
    tile_x_max = (block_range.x_max - 1) // tile_blocks
    tile_z_max = (block_range.z_max - 1) // tile_blocks
    return (
        (tile_x_max - tile_x_min + 1)
        * (tile_z_max - tile_z_min + 1)
        * layer_count
    )


def estimate_region_storage(
    inventory: RegionSpecInventory,
    *,
    database: TileDatabase,
    output_root: Path,
    max_tile_bytes: int,
    fallback_tile_bytes: int = DEFAULT_ESTIMATED_TILE_BYTES,
    margin: float = DEFAULT_STORAGE_MARGIN,
) -> RegionStorageEstimate:
    """Estimate only work not already complete or durably absent."""

    if max_tile_bytes <= 0 or fallback_tile_bytes <= 0:
        raise ValueError("tile byte estimates must be positive")
    if not math.isfinite(margin) or margin < 1:
        raise ValueError("storage margin must be finite and at least 1")

    existing_complete = 0
    observed_bytes = 0
    for spec in inventory:
        catalog_validation = database.known_complete_file_validation(
            spec,
            output_root,
        )
        if catalog_validation is not None:
            if catalog_validation.valid:
                existing_complete += 1
                observed_bytes += catalog_validation.size_bytes
            continue
        validation = validate_webp(
            spec.path(output_root),
            calculate_hash=False,
        )
        if validation.valid:
            existing_complete += 1
            observed_bytes += validation.size_bytes
    reusable_absent = database.count_reusable_absent_tiles(
        output_root=output_root,
        dimension=inventory.dimension,
        lod=inventory.lod,
        layers=inventory.layers,
        tile_x_min=inventory.tile_x_min,
        tile_x_max=inventory.tile_x_max,
        tile_z_min=inventory.tile_z_min,
        tile_z_max=inventory.tile_z_max,
    )
    missing = max(
        0,
        len(inventory) - existing_complete - reusable_absent,
    )
    observed_average = (
        math.ceil(observed_bytes / existing_complete)
        if existing_complete
        else database.average_complete_tile_bytes(maximum=max_tile_bytes)
    )
    estimated_tile_bytes = min(
        max_tile_bytes,
        observed_average
        if observed_average is not None
        else fallback_tile_bytes,
    )
    return RegionStorageEstimate(
        requested=len(inventory),
        existing_complete=existing_complete,
        reusable_absent=reusable_absent,
        missing=missing,
        estimated_tile_bytes=estimated_tile_bytes,
        required_bytes=math.ceil(
            missing * estimated_tile_bytes * margin,
        ),
    )


def seed_region_tasks(
    database: TileDatabase,
    output_root: Path,
    specs: Iterable[TileSpec],
) -> tuple[DownloadTask, ...]:
    """Compatibility helper that materializes explicitly requested tasks."""

    tasks = tuple(iter_region_tasks(database, output_root, specs))
    database.connection.commit()
    return tasks


def iter_region_tasks(
    database: TileDatabase,
    output_root: Path,
    specs: Iterable[TileSpec],
    *,
    commit_interval: int = 256,
) -> Iterator[DownloadTask]:
    """Prepare tasks on demand, retaining only the executor window in memory."""

    if commit_interval <= 0:
        raise ValueError("commit_interval must be positive")
    for index, spec in enumerate(specs, start=1):
        yield database.prepare_download_task(
            spec,
            output_root,
            selected=True,
        )
        if index % commit_interval == 0:
            database.connection.commit()
    database.connection.commit()


def download_region_tasks(
    tasks: Iterable[DownloadTask],
    *,
    fetcher: TileFetcher,
    database: TileDatabase,
    output_root: Path,
    lod: int,
    workers: int,
    stop_event: threading.Event,
    logger: logging.Logger,
    total_tasks: int | None = None,
    total_network_tasks: int | None = None,
    max_pending_tasks: int | None = None,
    progress: Callable[[RegionDownloadProgress], None] | None = None,
    disk_check_path: Path | None = None,
    minimum_free_bytes: int = 0,
    disk_check_interval: int = DEFAULT_DISK_CHECK_INTERVAL,
    database_commit_interval: int = DEFAULT_DATABASE_COMMIT_INTERVAL,
    database_commit_seconds: float = DEFAULT_DATABASE_COMMIT_SECONDS,
) -> RegionDownloadSummary:
    """Fetch a lazy task stream with a fixed-size executor window."""

    if workers <= 0:
        raise ValueError("workers must be positive")
    if total_tasks is None:
        try:
            total_tasks = len(tasks)  # type: ignore[arg-type]
        except TypeError:
            pass
    if total_tasks is not None and total_tasks < 0:
        raise ValueError("total_tasks must not be negative")
    if total_network_tasks is not None and total_network_tasks < 0:
        raise ValueError("total_network_tasks must not be negative")
    if (
        total_tasks is not None
        and total_network_tasks is not None
        and total_network_tasks > total_tasks
    ):
        raise ValueError("total_network_tasks must not exceed total_tasks")
    pending_limit = (
        max_pending_tasks
        if max_pending_tasks is not None
        else workers * DEFAULT_PENDING_TASKS_PER_WORKER
    )
    if pending_limit <= 0:
        raise ValueError("max_pending_tasks must be positive")
    pending_limit = max(workers, pending_limit)
    if minimum_free_bytes < 0:
        raise ValueError("minimum_free_bytes must not be negative")
    if disk_check_interval <= 0:
        raise ValueError("disk_check_interval must be positive")
    if database_commit_interval <= 0:
        raise ValueError("database_commit_interval must be positive")
    if (
        not math.isfinite(database_commit_seconds)
        or database_commit_seconds <= 0
    ):
        raise ValueError("database_commit_seconds must be finite and positive")

    complete = 0
    absent = 0
    failed = 0
    reused = 0
    reused_absent = 0
    downloaded_bytes = 0
    request_attempts = 0
    network_processed = 0
    processed = 0
    consumed = 0
    interrupted = False
    stop_reason: str | None = None
    last_disk_check_processed = -disk_check_interval
    started_at = time.monotonic()
    last_database_commit_at = started_at
    uncommitted_results = 0
    last_human_progress_at = started_at

    def limiter_metric(name: str) -> float:
        limiter = getattr(fetcher, "limiter", None)
        value = getattr(limiter, name, 0.0)
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return 0.0

    def current_metrics() -> tuple[
        float,
        float,
        float,
        float,
        float,
        float | None,
    ]:
        elapsed = max(0.0, time.monotonic() - started_at)
        resolved_rate = processed / elapsed if elapsed > 0 else 0.0
        network_tiles_rate = (
            network_processed / elapsed
            if elapsed > 0
            else 0.0
        )
        byte_rate = downloaded_bytes / elapsed if elapsed > 0 else 0.0
        achieved_rate = request_attempts / elapsed if elapsed > 0 else 0.0
        remaining = (
            max(0, total_network_tasks - network_processed)
            if total_network_tasks is not None
            else 0
        )
        eta = (
            remaining / network_tiles_rate
            if remaining and network_tiles_rate > 0
            else None
        )
        return (
            elapsed,
            resolved_rate,
            network_tiles_rate,
            byte_rate,
            achieved_rate,
            eta,
        )

    def emit(event: str, status: str) -> None:
        if progress is None:
            return
        (
            elapsed,
            resolved_rate,
            network_tiles_rate,
            byte_rate,
            achieved_rate,
            eta,
        ) = current_metrics()
        progress(
            RegionDownloadProgress(
                event=event,
                requested=total_tasks,
                processed=processed,
                complete=complete,
                absent=absent,
                failed=failed,
                reused=reused,
                reused_absent=reused_absent,
                downloaded_bytes=downloaded_bytes,
                interrupted=interrupted,
                status=status,
                stop_reason=stop_reason,
                request_attempts=request_attempts,
                elapsed_seconds=elapsed,
                # Protocol v1 compatibility: this legacy field remains the
                # rate of all resolved tasks, including local reuse.
                tiles_per_second=resolved_rate,
                bytes_per_second=byte_rate,
                eta_seconds=eta,
                effective_rps=limiter_metric("rate"),
                target_rps=limiter_metric("target_rate"),
                cooldown_seconds=limiter_metric("cooldown_remaining"),
                network_requested=total_network_tasks,
                network_processed=network_processed,
                resolved_per_second=resolved_rate,
                network_tiles_per_second=network_tiles_rate,
                achieved_rps=achieved_rate,
            )
        )

    def flush_database(*, force: bool = False) -> None:
        nonlocal last_database_commit_at
        nonlocal uncommitted_results

        if uncommitted_results <= 0:
            return
        now = time.monotonic()
        if (
            not force
            and uncommitted_results < database_commit_interval
            and now - last_database_commit_at < database_commit_seconds
        ):
            return
        connection = getattr(database, "connection", None)
        if connection is not None:
            connection.commit()
        uncommitted_results = 0
        last_database_commit_at = now

    def database_commit_wait_timeout() -> float | None:
        if uncommitted_results <= 0:
            return None
        return max(
            0.0,
            database_commit_seconds
            - (time.monotonic() - last_database_commit_at),
        )

    def check_disk_space(*, force: bool = False) -> bool:
        nonlocal interrupted
        nonlocal last_disk_check_processed
        nonlocal stop_reason

        if disk_check_path is None:
            return True
        if (
            not force
            and processed - last_disk_check_processed < disk_check_interval
        ):
            return True
        last_disk_check_processed = processed
        free_bytes = shutil.disk_usage(disk_check_path).free
        if free_bytes >= minimum_free_bytes:
            return True
        interrupted = True
        stop_reason = "insufficient-disk"
        logger.error(
            "Espacio libre por debajo de la reserva segura: %d < %d bytes",
            free_bytes,
            minimum_free_bytes,
        )
        stop_event.set()
        return False

    def record(result: DownloadResult) -> None:
        nonlocal absent
        nonlocal complete
        nonlocal downloaded_bytes
        nonlocal failed
        nonlocal last_human_progress_at
        nonlocal network_processed
        nonlocal processed
        nonlocal request_attempts
        nonlocal reused
        nonlocal reused_absent
        nonlocal uncommitted_results

        catalog_absent = (
            result.status == "absent"
            and result.attempts == 0
            and result.task.catalog_status == "absent"
            and result.task.catalog_http_code == 404
        )
        if not catalog_absent:
            database.record_result(
                result,
                output_root,
                min_lod=lod,
                selected_lods={lod},
                commit=False,
            )
            uncommitted_results += 1
            flush_database()
        processed += 1
        downloaded_bytes += result.downloaded_bytes
        request_attempts += result.attempts
        if result.attempts > 0:
            network_processed += 1
        if result.status == "complete":
            complete += 1
            if result.attempts == 0:
                reused += 1
            action = "reutilizado" if result.attempts == 0 else "descargado"
            logger.debug(
                "%s %s (%d bytes)",
                action,
                result.task.spec.url,
                result.size_bytes,
            )
        elif result.status == "absent":
            absent += 1
            if result.attempts == 0:
                reused_absent += 1
                logger.debug(
                    "404 reutilizado del catálogo: %s",
                    result.task.spec.url,
                )
            else:
                logger.debug("no publicado (404): %s", result.task.spec.url)
        else:
            failed += 1
            logger.error(
                "%s: %s — %s",
                result.status,
                result.task.spec.url,
                result.error or "sin detalle",
            )
        now = time.monotonic()
        if now - last_human_progress_at >= 2.0:
            (
                _elapsed,
                resolved_rate,
                network_tiles_rate,
                byte_rate,
                achieved_rate,
                eta,
            ) = current_metrics()
            logger.info(
                "Progreso %s%s · %.2f resueltos/s · %.2f tiles red/s · "
                "%.2f MiB/s · %.2f req/s reales · %.2f/%.2f "
                "req/s adaptativas%s",
                f"{processed:,}",
                f"/{total_tasks:,}" if total_tasks is not None else "",
                resolved_rate,
                network_tiles_rate,
                byte_rate / (1024 * 1024),
                achieved_rate,
                limiter_metric("rate"),
                limiter_metric("target_rate"),
                f" · ETA {eta:.0f}s" if eta is not None else "",
            )
            last_human_progress_at = now
        emit("progress", "running")

    def cached_absent_result(task: DownloadTask) -> DownloadResult | None:
        if (
            task.catalog_status != "absent"
            or task.catalog_http_code != 404
            or task.spec.path(output_root).exists()
        ):
            return None
        return DownloadResult(
            task=task,
            status="absent",
            exists=False,
            http_code=404,
            attempts=0,
            error="tile no publicado (reutilizado del catálogo local)",
        )

    emit("start", "running")
    check_disk_space(force=True)
    executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="region",
    )
    task_iterator = iter(tasks)
    pending: dict[
        concurrent.futures.Future[DownloadResult],
        DownloadTask,
    ] = {}
    exhausted = False

    def fill_pending() -> None:
        nonlocal consumed
        nonlocal exhausted
        while (
            not exhausted
            and not stop_event.is_set()
            and len(pending) < pending_limit
        ):
            try:
                task = next(task_iterator)
            except StopIteration:
                exhausted = True
                break
            consumed += 1
            resumed_absent = cached_absent_result(task)
            if resumed_absent is not None:
                record(resumed_absent)
                continue
            pending[executor.submit(fetcher.fetch, task)] = task

    try:
        fill_pending()
        while pending or not exhausted:
            if stop_event.is_set():
                interrupted = True
                for future in pending:
                    future.cancel()
            if not pending:
                if stop_event.is_set() or exhausted:
                    break
                fill_pending()
                continue
            done, _ = concurrent.futures.wait(
                tuple(pending),
                timeout=database_commit_wait_timeout(),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            if not done:
                flush_database()
                continue
            for future in done:
                task = pending.pop(future)
                if future.cancelled():
                    continue
                try:
                    result = future.result()
                except Exception as exc:
                    result = DownloadResult(
                        task=task,
                        status="failed",
                        exists=False,
                        http_code=None,
                        attempts=0,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                record(result)
            check_disk_space()
            if not stop_event.is_set():
                fill_pending()
    except KeyboardInterrupt:
        interrupted = True
        stop_event.set()
        logger.warning("Interrupción recibida; cerrando sin perder el progreso.")
    finally:
        if stop_event.is_set():
            interrupted = True
            for future in pending:
                future.cancel()
        flush_database(force=True)
        executor.shutdown(wait=True, cancel_futures=True)
        flush_database(force=True)

    requested = total_tasks if total_tasks is not None else consumed
    if interrupted and stop_reason is None:
        stop_reason = "stop-requested"
    if not interrupted and processed < requested:
        failed += requested - processed
    terminal_status = (
        "interrupted"
        if interrupted
        else "error"
        if failed
        else "complete"
    )
    emit("summary", terminal_status)
    (
        elapsed,
        resolved_rate,
        network_tiles_rate,
        byte_rate,
        achieved_rate,
        _eta,
    ) = current_metrics()
    return RegionDownloadSummary(
        requested=requested,
        complete=complete,
        absent=absent,
        failed=failed,
        reused=reused,
        downloaded_bytes=downloaded_bytes,
        interrupted=interrupted,
        processed=processed,
        reused_absent=reused_absent,
        stop_reason=stop_reason,
        request_attempts=request_attempts,
        elapsed_seconds=elapsed,
        tiles_per_second=resolved_rate,
        bytes_per_second=byte_rate,
        effective_rps=limiter_metric("rate"),
        target_rps=limiter_metric("target_rate"),
        network_requested=total_network_tasks,
        network_processed=network_processed,
        resolved_per_second=resolved_rate,
        network_tiles_per_second=network_tiles_rate,
        achieved_rps=achieved_rate,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Download a bounded 2b2t.place region using half-open Minecraft "
            "X/Z coordinates, then optionally compose it into one image."
        )
    )
    bounds = parser.add_argument_group("region")
    bounds.add_argument("--x-min", type=int)
    bounds.add_argument("--z-min", type=int)
    bounds.add_argument("--x-max", type=int)
    bounds.add_argument("--z-max", type=int)
    bounds.add_argument("--center-x", type=int)
    bounds.add_argument("--center-z", type=int)
    bounds.add_argument("--width", type=int, help="Region width in blocks.")
    bounds.add_argument("--height", type=int, help="Region height in blocks.")

    parser.add_argument(
        "--dimension",
        choices=("overworld",),
        default="overworld",
        help="Minecraft dimension; only overworld is supported.",
    )
    parser.add_argument(
        "--lod",
        type=int,
        choices=range(MIN_LOD, MAX_LOD + 1),
        default=0,
        help="Tile level of detail; LOD 0 is one block per pixel.",
    )
    parser.add_argument(
        "--layers",
        type=parse_layers,
        default=DEFAULT_LAYERS,
        metavar="CSV",
        help="Comma-separated layers (default: base,overlay).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Tile/database output root (default: ./2b2t_tiles).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Concurrent workers (default: {DEFAULT_WORKERS}, max: {MAX_WORKERS}).",
    )
    parser.add_argument(
        "--requests-per-second",
        type=float,
        default=DEFAULT_REQUESTS_PER_SECOND,
        help=(
            "Global target rate with automatic slowdown/recovery "
            f"(default: {DEFAULT_REQUESTS_PER_SECOND:g}, "
            f"max: {MAX_REQUESTS_PER_SECOND:g})."
        ),
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument(
        "--max-tile-bytes",
        type=int,
        default=DEFAULT_MAX_TILE_BYTES,
    )
    parser.add_argument(
        "--max-tiles",
        type=int,
        default=DEFAULT_MAX_TILES,
        help=(
            "Refuse a larger regional inventory before scheduling it "
            f"(default: {DEFAULT_MAX_TILES:,})."
        ),
    )
    parser.add_argument(
        "--progress-jsonl",
        action="store_true",
        help=(
            "Emit machine-readable progress on stdout; human logs remain "
            "on stderr."
        ),
    )
    parser.add_argument("--verbose", action="store_true")

    output = parser.add_argument_group("optional mosaic")
    output.add_argument(
        "--compose",
        type=Path,
        help="Write a cropped .png or .webp mosaic after downloading.",
    )
    output.add_argument(
        "--scale",
        type=int,
        default=1,
        help="Nearest-neighbor output scale (default: 1).",
    )
    output.add_argument("--show-coordinates", action="store_true")
    output.add_argument(
        "--grid-step",
        type=int,
        default=64,
        help="Coordinate-grid spacing in blocks (default: 64).",
    )
    output.add_argument(
        "--max-pixels",
        type=int,
        default=DEFAULT_MAX_PIXELS,
        help="Safety limit for the scaled mosaic.",
    )
    return parser


def _validate_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.workers <= 0 or args.workers > MAX_WORKERS:
        parser.error(f"--workers must be from 1 to {MAX_WORKERS}")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.retries <= 0:
        parser.error("--retries must be positive")
    if args.max_tile_bytes <= 0:
        parser.error("--max-tile-bytes must be positive")
    if args.max_tiles <= 0:
        parser.error("--max-tiles must be positive")
    if (
        not math.isfinite(args.requests_per_second)
        or args.requests_per_second <= 0
        or args.requests_per_second > MAX_REQUESTS_PER_SECOND
    ):
        parser.error(
            "--requests-per-second must be finite and between "
            f"0 and {MAX_REQUESTS_PER_SECOND:g}"
        )
    if args.scale <= 0:
        parser.error("--scale must be positive")
    if args.grid_step <= 0:
        parser.error("--grid-step must be positive")
    if args.max_pixels <= 0:
        parser.error("--max-pixels must be positive")
    if (args.show_coordinates or args.scale != 1) and args.compose is None:
        parser.error("--scale/--show-coordinates require --compose")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _validate_args(parser, args)
    try:
        block_range = resolve_region(args)
    except (TypeError, ValueError) as exc:
        parser.error(str(exc))

    output_root = args.out.expanduser().resolve()
    logger = configure_logging(output_root, args.verbose)
    inventory_count = region_tile_count(
        block_range,
        lod=args.lod,
        layer_count=len(args.layers),
    )
    if inventory_count > args.max_tiles:
        parser.error(
            f"the region requires {inventory_count:,} tiles, above --max-tiles "
            f"{args.max_tiles:,}; reduce the bounds or raise the limit "
            "deliberately"
        )
    specs = required_region_specs(
        block_range,
        lod=args.lod,
        dimension=args.dimension,
        layers=args.layers,
    )
    output_root.mkdir(parents=True, exist_ok=True)
    download_lock = RegionDownloadLock(output_root)
    try:
        download_lock.acquire()
    except RegionDownloadLockedError as exc:
        parser.error(str(exc))

    database: TileDatabase | None = None
    fetcher: TileFetcher | None = None
    previous_handlers: dict[int, object] = {}

    def stop_handler(signum: int, _frame: object) -> None:
        if not stop_event.is_set():
            logger.warning(
                "Señal %s recibida; terminando solicitudes activas.",
                signal.Signals(signum).name,
            )
        stop_event.set()

    try:
        database = TileDatabase(output_root / "tiles.sqlite3")
        storage = estimate_region_storage(
            specs,
            database=database,
            output_root=output_root,
            max_tile_bytes=args.max_tile_bytes,
        )
        runtime_reserve = max(
            DEFAULT_RUNTIME_DISK_RESERVE_BYTES,
            args.max_tile_bytes * args.workers * 2,
        )
        free_bytes = shutil.disk_usage(output_root).free
        required_with_reserve = storage.required_bytes + runtime_reserve
        if free_bytes < required_with_reserve:
            parser.error(
                "insufficient disk for the estimated missing tiles, 20% "
                f"margin, and runtime reserve: need {required_with_reserve:,} "
                f"bytes, have {free_bytes:,}"
            )
        logger.info(
            "Preflight: %d existentes, %d ausentes reutilizables, "
            "%d faltantes; estimación %d bytes + reserva %d.",
            storage.existing_complete,
            storage.reusable_absent,
            storage.missing,
            storage.required_bytes,
            runtime_reserve,
        )

        stop_event = threading.Event()
        limiter = AdaptiveRateLimiter(
            args.requests_per_second,
            stop_event,
            initial_rate=min(
                args.requests_per_second,
                DEFAULT_INITIAL_REQUESTS_PER_SECOND,
            ),
            recovery_successes=16,
        )
        fetcher = TileFetcher(
            output_root,
            limiter=limiter,
            stop_event=stop_event,
            timeout=args.timeout,
            retries=args.retries,
            max_tile_bytes=args.max_tile_bytes,
            logger=logger,
        )
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, stop_handler)

        database.set_metadata(
            "last_region_request",
            {
                "dimension": args.dimension,
                "layers": list(args.layers),
                "lod": args.lod,
                "bounds": dataclasses.asdict(block_range),
                "tiles": inventory_count,
                "workers": args.workers,
                "target_requests_per_second": args.requests_per_second,
                "initial_requests_per_second": limiter.rate,
            },
        )
        logger.info(
            "Región X[%d,%d) Z[%d,%d), LOD %d, %d tile(s), capas %s.",
            block_range.x_min,
            block_range.x_max,
            block_range.z_min,
            block_range.z_max,
            args.lod,
            inventory_count,
            ",".join(args.layers),
        )
        progress_reporter = (
            JsonlProgressReporter(sys.stdout)
            if args.progress_jsonl
            else None
        )
        summary = download_region_tasks(
            iter_region_tasks(database, output_root, specs),
            fetcher=fetcher,
            database=database,
            output_root=output_root,
            lod=args.lod,
            workers=args.workers,
            stop_event=stop_event,
            logger=logger,
            total_tasks=inventory_count,
            total_network_tasks=storage.missing,
            progress=progress_reporter,
            disk_check_path=output_root,
            minimum_free_bytes=runtime_reserve,
        )

        human_output = sys.stderr if args.progress_jsonl else sys.stdout
        print(
            "Descarga regional: "
            f"{summary.complete} completos "
            f"({summary.reused} reutilizados), "
            f"{summary.absent} ausentes "
            f"({summary.reused_absent} reutilizados), "
            f"{summary.failed} fallidos · "
            f"{summary.resolved_per_second:.2f} resueltos/s · "
            f"{summary.network_tiles_per_second:.2f} tiles red/s · "
            f"{summary.bytes_per_second / (1024 * 1024):.2f} MiB/s · "
            f"{summary.achieved_rps:.2f} req/s reales · "
            f"{summary.effective_rps:.2f}/{summary.target_rps:.2f} "
            "req/s adaptativas.",
            file=human_output,
        )
        if summary.interrupted:
            print(
                "Interrumpido de forma segura; ejecuta el mismo comando para reanudar.",
                file=sys.stderr,
            )
            return 130
        if summary.failed:
            return 2

        if args.compose is not None:
            try:
                result = compose_mosaic(
                    block_range,
                    lod=args.lod,
                    dimension=args.dimension,
                    layer=args.layers[0],
                    layers=args.layers,
                    tiles_root=output_root,
                    output_path=args.compose.expanduser(),
                    max_pixels=args.max_pixels,
                    allow_missing=True,
                    scale=args.scale,
                    show_coordinates=args.show_coordinates,
                    grid_step=args.grid_step,
                )
            except (MosaicError, OSError, ValueError) as exc:
                print(f"No se pudo componer la imagen: {exc}", file=sys.stderr)
                return 3
            print(
                f"Imagen: {result.output_path.resolve()} "
                f"({result.width}x{result.height} px, "
                f"{len(result.missing_paths)} tiles transparentes/ausentes).",
                file=human_output,
            )
        return 0
    finally:
        try:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
        finally:
            try:
                if fetcher is not None:
                    fetcher.close()
            finally:
                try:
                    if database is not None:
                        database.close()
                finally:
                    download_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
