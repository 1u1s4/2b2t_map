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
from pathlib import Path
from typing import Iterable, Sequence, TextIO

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
DEFAULT_REQUESTS_PER_SECOND = 2.0
DEFAULT_TIMEOUT = 30.0
DEFAULT_RETRIES = 5
DEFAULT_MAX_TILE_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_TILES = 10_000
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


def parse_layers(value: str) -> tuple[str, ...]:
    """Parse a comma-separated layer list while preserving its order."""

    layers = tuple(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))
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


def required_region_specs(
    block_range: BlockRange,
    *,
    lod: int,
    dimension: str,
    layers: Sequence[str],
) -> tuple[TileSpec, ...]:
    """Return every direct tile needed by a region, layer then Z then X."""

    if dimension != "overworld":
        raise ValueError("only the Overworld is supported")
    if not MIN_LOD <= lod <= MAX_LOD:
        raise ValueError(f"lod must be from {MIN_LOD} to {MAX_LOD}")
    if not layers:
        raise ValueError("at least one layer is required")

    tile_blocks = 512 * (1 << lod)
    tile_x_min = block_range.x_min // tile_blocks
    tile_z_min = block_range.z_min // tile_blocks
    tile_x_max = (block_range.x_max - 1) // tile_blocks
    tile_z_max = (block_range.z_max - 1) // tile_blocks
    return tuple(
        TileSpec(dimension, layer, lod, tile_x, tile_z)
        for layer in layers
        for tile_z in range(tile_z_min, tile_z_max + 1)
        for tile_x in range(tile_x_min, tile_x_max + 1)
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


def seed_region_tasks(
    database: TileDatabase,
    output_root: Path,
    specs: Iterable[TileSpec],
) -> tuple[DownloadTask, ...]:
    """Persist the requested inventory and return tasks for the exact region."""

    tasks = tuple(
        DownloadTask(
            row_id=database.add_tile(spec, output_root, selected=True),
            spec=spec,
            selected=True,
        )
        for spec in specs
    )
    database.connection.commit()
    return tasks


def download_region_tasks(
    tasks: Sequence[DownloadTask],
    *,
    fetcher: TileFetcher,
    database: TileDatabase,
    output_root: Path,
    lod: int,
    workers: int,
    stop_event: threading.Event,
    logger: logging.Logger,
) -> RegionDownloadSummary:
    """Fetch exact tasks concurrently while serializing SQLite writes."""

    results: list[DownloadResult] = []
    interrupted = False
    executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="region",
    )
    futures = {executor.submit(fetcher.fetch, task): task for task in tasks}
    try:
        for future in concurrent.futures.as_completed(futures):
            task = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # Defensive boundary around worker failures.
                result = DownloadResult(
                    task=task,
                    status="failed",
                    exists=False,
                    http_code=None,
                    attempts=0,
                    error=f"{type(exc).__name__}: {exc}",
                )
            database.record_result(
                result,
                output_root,
                min_lod=lod,
                selected_lods={lod},
            )
            results.append(result)
            if result.status == "complete":
                action = "reutilizado" if result.attempts == 0 else "descargado"
                logger.info(
                    "%s %s (%d bytes)",
                    action,
                    result.task.spec.url,
                    result.size_bytes,
                )
            elif result.status == "absent":
                logger.info("no publicado (404): %s", result.task.spec.url)
            else:
                logger.error(
                    "%s: %s — %s",
                    result.status,
                    result.task.spec.url,
                    result.error or "sin detalle",
                )
            if stop_event.is_set():
                interrupted = True
    except KeyboardInterrupt:
        interrupted = True
        stop_event.set()
        logger.warning("Interrupción recibida; cerrando sin perder el progreso.")
    finally:
        if stop_event.is_set():
            interrupted = True
            for future in futures:
                future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)

    complete = sum(result.status == "complete" for result in results)
    absent = sum(result.status == "absent" for result in results)
    failed = len(results) - complete - absent
    reused = sum(
        result.status == "complete" and result.attempts == 0 for result in results
    )
    return RegionDownloadSummary(
        requested=len(tasks),
        complete=complete,
        absent=absent,
        failed=failed,
        reused=reused,
        downloaded_bytes=sum(result.downloaded_bytes for result in results),
        interrupted=interrupted,
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
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument(
        "--requests-per-second",
        type=float,
        default=DEFAULT_REQUESTS_PER_SECOND,
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
    if args.workers <= 0:
        parser.error("--workers must be positive")
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
    ):
        parser.error("--requests-per-second must be finite and positive")
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
    previous_handlers: dict[int, object] = {}

    def stop_handler(signum: int, _frame: object) -> None:
        if not stop_event.is_set():
            logger.warning(
                "Señal %s recibida; terminando solicitudes activas.",
                signal.Signals(signum).name,
            )
        stop_event.set()

    try:
        # This intentionally uses the configured response ceiling, not an average:
        # it is a strict upper-bound preflight for small targeted captures.
        missing_tiles = sum(
            not validate_webp(
                spec.path(output_root), calculate_hash=False
            ).valid
            for spec in specs
        )
        required_upper_bound = math.ceil(
            missing_tiles * args.max_tile_bytes * 1.20
        )
        free_bytes = shutil.disk_usage(output_root).free
        if free_bytes < required_upper_bound:
            parser.error(
                "insufficient disk for the regional upper bound plus 20%: "
                f"need {required_upper_bound:,} bytes, have {free_bytes:,}"
            )

        stop_event = threading.Event()
        limiter = AdaptiveRateLimiter(args.requests_per_second, stop_event)
        fetcher = TileFetcher(
            output_root,
            limiter=limiter,
            stop_event=stop_event,
            timeout=args.timeout,
            retries=args.retries,
            max_tile_bytes=args.max_tile_bytes,
            logger=logger,
        )
        database = TileDatabase(output_root / "tiles.sqlite3")

        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, stop_handler)

        tasks = seed_region_tasks(database, output_root, specs)
        database.set_metadata(
            "last_region_request",
            {
                "dimension": args.dimension,
                "layers": list(args.layers),
                "lod": args.lod,
                "bounds": dataclasses.asdict(block_range),
                "tiles": len(tasks),
            },
        )
        logger.info(
            "Región X[%d,%d) Z[%d,%d), LOD %d, %d tile(s), capas %s.",
            block_range.x_min,
            block_range.x_max,
            block_range.z_min,
            block_range.z_max,
            args.lod,
            len(tasks),
            ",".join(args.layers),
        )
        summary = download_region_tasks(
            tasks,
            fetcher=fetcher,
            database=database,
            output_root=output_root,
            lod=args.lod,
            workers=args.workers,
            stop_event=stop_event,
            logger=logger,
        )

        print(
            "Descarga regional: "
            f"{summary.complete} completos "
            f"({summary.reused} reutilizados), "
            f"{summary.absent} ausentes, "
            f"{summary.failed} fallidos."
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
                f"{len(result.missing_paths)} tiles transparentes/ausentes)."
            )
        return 0
    finally:
        try:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
        finally:
            try:
                if database is not None:
                    database.close()
            finally:
                download_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
