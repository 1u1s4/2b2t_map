#!/usr/bin/env python3
"""
Descargador reanudable y conservador de los tiles WebP de https://2b2t.place.

La descarga se descubre como un quadtree desde LOD 10 hasta el LOD mínimo
solicitado. Un 404 poda toda esa rama; así se evitan barridos ciegos de rangos
gigantes y se conservan también las extensiones irregulares del mapa publicado.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import email.utils
import hashlib
import json
import logging
import math
import os
import random
import shlex
import shutil
import signal
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

import requests
from PIL import Image, UnidentifiedImageError

from download_lock import RegionDownloadLock, RegionDownloadLockedError


BASE_URL = "https://2b2t.place"
TILE_PIXELS = 512
MIN_LOD = 0
MAX_LOD = 10
DIMENSIONS = {"overworld": 0, "nether": 1, "end": 2}
LAYERS = ("base", "overlay", "newchunks")
USER_AGENT = (
    "2b2t-place-offline-map-downloader/2.0 "
    "(direct tile archival; conservative rate; https://github.com/)"
)

# Límites del núcleo publicados por el proyecto. Los roots LOD 10 incluyen las
# extensiones irregulares descritas en el repositorio oficial.
COVERAGE = {
    "overworld": {
        "min_block": -512_000,
        "max_block_exclusive": 512_000,
        "root_min": -2,
        "root_max": 1,
        "source": "https://github.com/2b2tplace/1m_release",
    },
    "nether": {
        "min_block": -50_000,
        "max_block_exclusive": 50_000,
        "root_min": -1,
        "root_max": 0,
        "source": "https://github.com/2b2tplace/1m_release",
    },
    "end": {
        "min_block": -128_000,
        "max_block_exclusive": 128_000,
        "root_min": -1,
        "root_max": 0,
        "source": "https://github.com/2b2tplace/1m_release",
    },
}

# Huella irregular observada y verificada del Overworld. El catálogo base LOD
# 3 contiene 66,464 WebP completos; los candidatos de LOD 10–3 son exactamente
# las raíces o los cuatro hijos de cada padre disponible. Para LOD 2–0 se usa
# el límite superior conservador de cuatro hijos por tile LOD 3 en cada nivel.
# Esto evita estimar únicamente el núcleo nominal de 1,024,000² y perder las
# extensiones publicadas alrededor de sus bordes.
OVERWORLD_OBSERVED_FOOTPRINT = {
    "mask_lod": 3,
    "available_tiles_at_mask_lod": 66_464,
    "observed_bounds_blocks": {
        "min_x": -540_672,
        "min_z": -540_672,
        "max_x_exclusive": 540_672,
        "max_z_exclusive": 536_576,
    },
    "candidate_requests_by_lod": {
        10: 16,
        9: 56,
        8: 128,
        7: 368,
        6: 1_232,
        5: 4_496,
        4: 17_168,
        3: 66_752,
        2: 265_856,
        1: 1_063_424,
        0: 4_253_696,
    },
    "catalog_updated_at": "2026-07-24T20:27:11.719325+00:00",
    "catalog_database_sha256": (
        "8891d3f5e9e38c1b06489a9d1f4557701d4299e07a0f3e0f8abaa14ff6593e1f"
    ),
}

# Envolvente cuadrada de esos candidatos para distribuir el muestreo. La
# máscara real sigue siendo irregular y la cola quadtree poda cada 404.
OVERWORLD_OBSERVED_CANDIDATE_AXIS_BOUNDS = {
    10: (-2, 1),
    9: (-4, 3),
    8: (-6, 5),
    7: (-10, 9),
    6: (-18, 17),
    5: (-34, 33),
    4: (-66, 65),
    3: (-132, 131),
    2: (-264, 263),
    1: (-528, 527),
    0: (-1_056, 1_055),
}

SCHEMA_SOURCES = {
    "tiles": f"{BASE_URL}/scripts/tiles.js",
    "draw": f"{BASE_URL}/scripts/drawHelpers.js",
    "globals": f"{BASE_URL}/scripts/globals.js",
    "project": (
        "https://raw.githubusercontent.com/2b2tplace/"
        "1m_release/main/README.md"
    ),
}

RETRYABLE_STATUSES = {408, 425, 429}
TERMINAL_STATUSES = {"complete", "absent", "probe_complete"}
DEFAULT_SPACE_HEADROOM_PERCENT = 20.0
SAMPLING_UNCERTAINTY_PERCENT = 25.0
REQUIRED_SPACE_HEADROOM_PERCENT = 20.0
TEMPORARY_MIGRATION_HEADROOM_PERCENT = 18.0
CACHED_ESTIMATE_REPORT_RELATIVE_PATH = (
    Path("reports") / "overworld-estimate.json"
)


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


def human_duration(seconds: float | None) -> str:
    if seconds is None or not math.isfinite(seconds):
        return "desconocido"
    seconds = max(0, int(seconds))
    days, seconds = divmod(seconds, 86_400)
    hours, seconds = divmod(seconds, 3_600)
    minutes, seconds = divmod(seconds, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    if minutes or hours or days:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)


def filesystem_allocation_unit(path: Path) -> int:
    """Return the smallest filesystem allocation unit used for new files."""

    try:
        stats = os.statvfs(path)
        return max(1, int(stats.f_frsize or stats.f_bsize or 1))
    except OSError:
        return 4096


def allocated_payload_bytes(size_bytes: int, allocation_unit: int) -> int:
    """Estimate physical bytes consumed by one payload on the destination."""

    if size_bytes <= 0:
        return 0
    unit = max(1, allocation_unit)
    return math.ceil(size_bytes / unit) * unit


def bytes_with_space_headroom(
    conservative_bytes: int,
    space_headroom_percent: float,
) -> int:
    """Add the configured free-space reserve to a conservative estimate."""

    return math.ceil(
        max(0, conservative_bytes)
        * (1.0 + space_headroom_percent / 100.0)
    )


def compounded_margin_percent(*percentages: float) -> float:
    """Combine sequential percentage reserves without adding them linearly."""

    multiplier = 1.0
    for percentage in percentages:
        multiplier *= 1.0 + max(0.0, percentage) / 100.0
    return (multiplier - 1.0) * 100.0


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


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


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

            CREATE TABLE IF NOT EXISTS discovery_samples (
                dimension TEXT NOT NULL,
                layer TEXT NOT NULL,
                lod INTEGER NOT NULL,
                tile_x INTEGER NOT NULL,
                tile_z INTEGER NOT NULL,
                url TEXT NOT NULL,
                http_code INTEGER,
                exists_flag INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                sampled_at TEXT NOT NULL,
                PRIMARY KEY(dimension, layer, lod, tile_x, tile_z)
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

    def add_roots(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        selected_lods: set[int],
        output_root: Path,
    ) -> None:
        for dimension in dimensions:
            bounds = COVERAGE[dimension]
            for layer in layers:
                for tile_z in range(bounds["root_min"], bounds["root_max"] + 1):
                    for tile_x in range(
                        bounds["root_min"], bounds["root_max"] + 1
                    ):
                        spec = TileSpec(
                            dimension, layer, MAX_LOD, tile_x, tile_z
                        )
                        self.add_tile(
                            spec,
                            output_root,
                            selected=MAX_LOD in selected_lods,
                        )
        self.connection.commit()

    def prepare_resume(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        selected_lods: set[int],
    ) -> None:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        parameters: list[Any] = [*dimensions, *layers]
        self.connection.execute(
            f"""
            UPDATE tiles
            SET status='pending', size_bytes=0, sha256=NULL,
                downloaded_at=NULL, error_message=NULL, updated_at=?
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND status IN (
                  'downloading', 'error', 'failed', 'protection', 'corrupt'
              )
            """,
            [utc_now(), *parameters],
        )
        lod_marks = ",".join("?" for _ in selected_lods)
        self.connection.execute(
            f"""
            UPDATE tiles
            SET selected = CASE WHEN lod IN ({lod_marks}) THEN 1 ELSE 0 END,
                updated_at=?
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
            """,
            [*sorted(selected_lods), utc_now(), *parameters],
        )
        # A probe validates a parent only long enough to discover its children;
        # its temporary body is deliberately removed. If a later plan selects
        # that LOD as output, it must be fetched again into the canonical path.
        self.connection.execute(
            f"""
            UPDATE tiles
            SET status='pending', size_bytes=0, sha256=NULL,
                downloaded_at=NULL, error_message=NULL, updated_at=?
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND selected=1
              AND status='probe_complete'
            """,
            [utc_now(), *parameters],
        )
        self.connection.commit()

    def expand_successful(
        self,
        output_root: Path,
        *,
        min_lod: int,
        selected_lods: set[int],
        dimensions: Sequence[str],
        layers: Sequence[str],
    ) -> int:
        total_added = 0
        while True:
            dimension_marks = ",".join("?" for _ in dimensions)
            layer_marks = ",".join("?" for _ in layers)
            rows = self.connection.execute(
                f"""
                SELECT * FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND status IN ('complete', 'probe_complete')
                  AND lod > ?
                  AND children_seeded=0
                LIMIT 1000
                """,
                [*dimensions, *layers, min_lod],
            ).fetchall()
            if not rows:
                break
            for row in rows:
                spec = self._row_spec(row)
                for child in spec.children():
                    before = self.connection.total_changes
                    self.add_tile(
                        child,
                        output_root,
                        selected=child.lod in selected_lods,
                    )
                    if self.connection.total_changes > before:
                        total_added += 1
                self.connection.execute(
                    "UPDATE tiles SET children_seeded=1, updated_at=? WHERE id=?",
                    (utc_now(), row["id"]),
                )
            self.connection.commit()
        return total_added

    def reset_expansion_for_deeper_run(
        self,
        *,
        min_lod: int,
        dimensions: Sequence[str],
        layers: Sequence[str],
    ) -> None:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        self.connection.execute(
            f"""
            UPDATE tiles SET children_seeded=0, updated_at=?
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod > ?
              AND status IN ('complete', 'probe_complete')
            """,
            [utc_now(), *dimensions, *layers, min_lod],
        )
        self.connection.commit()

    @staticmethod
    def _row_spec(row: sqlite3.Row) -> TileSpec:
        return TileSpec(
            str(row["dimension"]),
            str(row["layer"]),
            int(row["lod"]),
            int(row["tile_x"]),
            int(row["tile_z"]),
        )

    def claim_next(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        min_lod: int,
    ) -> DownloadTask | None:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        self.connection.execute("BEGIN IMMEDIATE")
        row = self.connection.execute(
            f"""
            SELECT * FROM tiles
            WHERE status='pending'
              AND dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod >= ?
            ORDER BY lod DESC, selected DESC, id
            LIMIT 1
            """,
            [*dimensions, *layers, min_lod],
        ).fetchone()
        if row is None:
            self.connection.commit()
            return None
        self.connection.execute(
            "UPDATE tiles SET status='downloading', updated_at=? WHERE id=?",
            (utc_now(), row["id"]),
        )
        self.connection.commit()
        return DownloadTask(
            int(row["id"]), self._row_spec(row), bool(row["selected"])
        )

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

    def record_smoke_result(
        self, result: DownloadResult, output_root: Path
    ) -> None:
        row_id = self.add_tile(
            result.task.spec, output_root, selected=True
        )
        result.task.row_id = row_id
        self.record_result(
            result,
            output_root,
            min_lod=result.task.spec.lod,
            selected_lods={result.task.spec.lod},
        )

    def save_sample(
        self,
        spec: TileSpec,
        *,
        http_code: int | None,
        exists: bool,
        size_bytes: int,
        error: str | None,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO discovery_samples(
                dimension, layer, lod, tile_x, tile_z, url, http_code,
                exists_flag, size_bytes, error_message, sampled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dimension, layer, lod, tile_x, tile_z) DO UPDATE SET
                url=excluded.url, http_code=excluded.http_code,
                exists_flag=excluded.exists_flag,
                size_bytes=excluded.size_bytes,
                error_message=excluded.error_message,
                sampled_at=excluded.sampled_at
            """,
            (
                spec.dimension,
                spec.layer,
                spec.lod,
                spec.tile_x,
                spec.tile_z,
                spec.url,
                http_code,
                int(exists),
                size_bytes,
                error,
                utc_now(),
            ),
        )
        self.connection.commit()

    def get_sample(self, spec: TileSpec) -> sqlite3.Row | None:
        return self.connection.execute(
            """
            SELECT * FROM discovery_samples
            WHERE dimension=? AND layer=? AND lod=? AND tile_x=? AND tile_z=?
            """,
            (
                spec.dimension,
                spec.layer,
                spec.lod,
                spec.tile_x,
                spec.tile_z,
            ),
        ).fetchone()

    def counts(self) -> dict[str, int]:
        return {
            str(row["status"]): int(row["count"])
            for row in self.connection.execute(
                "SELECT status, COUNT(*) AS count FROM tiles GROUP BY status"
            )
        }

    def counts_for(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
    ) -> dict[str, int]:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        return {
            str(row["status"]): int(row["count"])
            for row in self.connection.execute(
                f"""
                SELECT status, COUNT(*) AS count
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND selected=1
                GROUP BY status
                """,
                [*dimensions, *layers],
            )
        }

    def work_counts_for(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        min_lod: int,
    ) -> dict[str, int]:
        """Count selected tiles and discovery ancestors in the active queue."""

        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        return {
            str(row["status"]): int(row["count"])
            for row in self.connection.execute(
                f"""
                SELECT status, COUNT(*) AS count
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND lod >= ?
                GROUP BY status
                """,
                [*dimensions, *layers, min_lod],
            )
        }

    def http_errors(self) -> dict[str, int]:
        return {
            str(row["code"]): int(row["count"])
            for row in self.connection.execute(
                """
                SELECT http_code AS code, COUNT(*) AS count
                FROM tiles
                WHERE http_code IS NOT NULL AND http_code >= 400
                GROUP BY http_code ORDER BY http_code
                """
            )
        }

    def http_errors_for(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
    ) -> dict[str, int]:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        return {
            str(row["code"]): int(row["count"])
            for row in self.connection.execute(
                f"""
                SELECT http_code AS code, COUNT(*) AS count
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND selected=1
                  AND http_code IS NOT NULL
                  AND http_code >= 400
                GROUP BY http_code ORDER BY http_code
                """,
                [*dimensions, *layers],
            )
        }

    def total_downloaded_bytes(self) -> int:
        row = self.connection.execute(
            """
            SELECT COALESCE(SUM(size_bytes), 0) AS total
            FROM tiles WHERE status='complete'
            """
        ).fetchone()
        return int(row["total"])

    def total_downloaded_bytes_for(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
    ) -> int:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        row = self.connection.execute(
            f"""
            SELECT COALESCE(SUM(size_bytes), 0) AS total
            FROM tiles
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND selected=1
              AND status='complete'
            """,
            [*dimensions, *layers],
        ).fetchone()
        return int(row["total"])

    def completed_for(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        lods: set[int],
    ) -> tuple[int, int]:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        lod_marks = ",".join("?" for _ in lods)
        row = self.connection.execute(
            f"""
            SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
            FROM tiles
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod IN ({lod_marks})
              AND status='complete'
            """,
            [*dimensions, *layers, *sorted(lods)],
        ).fetchone()
        return int(row["count"]), int(row["bytes"])

    def completed_bytes_by_group(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        lods: set[int],
    ) -> dict[tuple[str, str, int], int]:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        lod_marks = ",".join("?" for _ in lods)
        return {
            (
                str(row["dimension"]),
                str(row["layer"]),
                int(row["lod"]),
            ): int(row["bytes"])
            for row in self.connection.execute(
                f"""
                SELECT dimension, layer, lod,
                       COALESCE(SUM(size_bytes), 0) AS bytes
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND lod IN ({lod_marks})
                  AND status='complete'
                GROUP BY dimension, layer, lod
                """,
                [*dimensions, *layers, *sorted(lods)],
            )
        }

    def has_pending(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        min_lod: int,
    ) -> bool:
        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        row = self.connection.execute(
            f"""
            SELECT 1 FROM tiles
            WHERE status='pending'
              AND dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod >= ?
            LIMIT 1
            """,
            [*dimensions, *layers, min_lod],
        ).fetchone()
        return row is not None

    def blocking_statuses(
        self,
        dimensions: Sequence[str],
        layers: Sequence[str],
        min_lod: int,
    ) -> dict[str, int]:
        """Return unresolved rows, including unselected discovery ancestors."""

        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        return {
            str(row["status"]): int(row["count"])
            for row in self.connection.execute(
                f"""
                SELECT status, COUNT(*) AS count
                FROM tiles
                WHERE dimension IN ({dimension_marks})
                  AND layer IN ({layer_marks})
                  AND lod >= ?
                  AND status IN (
                      'pending', 'downloading', 'error', 'failed',
                      'corrupt', 'protection'
                  )
                GROUP BY status
                """,
                [*dimensions, *layers, min_lod],
            )
        }


class AdaptiveRateLimiter:
    """Token spacing shared by every worker, with protection-aware slowdown."""

    def __init__(self, requests_per_second: float, stop_event: threading.Event):
        if not math.isfinite(requests_per_second) or requests_per_second <= 0:
            raise ValueError("--requests-per-second debe ser finito y > 0")
        self.initial_rate = requests_per_second
        self._rate = requests_per_second
        self._next_request = 0.0
        self._blocked_until = 0.0
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
                wait = max(
                    0.0,
                    self._next_request - now,
                    self._blocked_until - now,
                )
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

    def defer(self, seconds: float) -> None:
        if not math.isfinite(seconds) or seconds < 0:
            raise ValueError("Retry-After debe ser finito y no negativo")
        with self._lock:
            self._blocked_until = max(
                self._blocked_until,
                time.monotonic() + seconds,
            )


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

        # El descubrimiento usa el mismo GET que la descarga para validar y
        # conservar el WebP en una sola transferencia; no se hace un barrido
        # HEAD separado que luego duplique las solicitudes exitosas.
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
                    if not task.selected:
                        result = self._stream_probe_response(task, response)
                    else:
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
                if retry_after is not None:
                    self.limiter.defer(retry_after)
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

    def _stream_probe_response(
        self, task: DownloadTask, response: requests.Response
    ) -> DownloadResult:
        temporary_directory = self.output_root / ".discovery_tmp"
        temporary_directory.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="tile.", suffix=".part", dir=temporary_directory
        )
        temporary = Path(temporary_name)
        size = 0
        try:
            with os.fdopen(descriptor, "wb") as handle:
                for chunk in response.iter_content(chunk_size=128 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > self.max_tile_bytes:
                        raise ValueError(
                            f"respuesta supera el límite de "
                            f"{human_bytes(self.max_tile_bytes)}"
                        )
                    handle.write(chunk)
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
                    error=f"WebP de descubrimiento inválido: {validation.error}",
                    downloaded_bytes=size,
                )
            return DownloadResult(
                task,
                "probe_complete",
                True,
                response.status_code,
                0,
                size_bytes=size,
                downloaded_bytes=size,
            )
        except (OSError, ValueError) as exc:
            response.close()
            return DownloadResult(
                task,
                "failed",
                False,
                response.status_code,
                0,
                size_bytes=size,
                error=f"{type(exc).__name__}: {exc}",
                downloaded_bytes=size,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def probe(self, spec: TileSpec) -> DownloadResult:
        return self.fetch(DownloadTask(-1, spec, False))


@dataclasses.dataclass(slots=True)
class EstimateRow:
    dimension: str
    layer: str
    lod: int
    candidate_tiles: int
    estimated_available: int
    sampled: int
    found: int
    mean_bytes_per_candidate: float
    mean_bytes_existing: float
    conservative_bytes: int
    estimated_requests: int
    allocation_unit_bytes: int = 1
    mean_allocated_bytes_existing: float = 0.0
    estimated_allocated_bytes: int = 0


@dataclasses.dataclass(slots=True)
class DownloadPlan:
    dimensions: list[str]
    layers: list[str]
    lods: set[int]
    rows: list[EstimateRow]
    fallback: bool
    point_bytes: int
    conservative_bytes: int
    requests: int
    free_bytes: int
    required_with_headroom: int
    space_headroom_percent: float


PROGRESS_PROCESSED_STATUSES = frozenset(
    {
        "complete",
        "absent",
        "probe_complete",
        "failed",
        "error",
        "corrupt",
        "protection",
    }
)


def scope_payload(
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: Iterable[int],
) -> dict[str, Any]:
    """Return a stable description of a requested or effective download scope."""

    return {
        "dimensions": list(dimensions),
        "layers": list(layers),
        "lods": sorted(set(lods)),
    }


def calculate_progress(
    status_counts: dict[str, int],
    *,
    estimated_requests: int,
    successful_final: bool = False,
) -> dict[str, Any]:
    """Calculate resume-aware progress from the persistent queue.

    The estimate covers work not discovered in the quadtree yet. The known row
    count takes over when irregular extensions make the estimate too small.
    Existing terminal rows are included, so resuming does not restart at 0 %.
    """

    normalized = {
        str(status): max(0, int(count))
        for status, count in status_counts.items()
    }
    known_requests = sum(normalized.values())
    processed_requests = sum(
        normalized.get(status, 0)
        for status in PROGRESS_PROCESSED_STATUSES
    )
    estimate = max(0, int(estimated_requests))

    if successful_final:
        # At a successful queue drain the discovered tree is authoritative.
        # Sparse 404-pruned layers may legitimately finish below the original
        # rectangular estimate.
        planned_requests = processed_requests
        progress_percent = 100.0
        progress_kind = "actual"
    else:
        planned_requests = max(1, estimate, known_requests)
        progress_percent = min(
            100.0,
            processed_requests * 100.0 / planned_requests,
        )
        progress_kind = (
            "dynamic" if known_requests > estimate else "estimated"
        )

    return {
        "planned_requests": planned_requests,
        "processed_requests": processed_requests,
        "known_requests": known_requests,
        "progress_percent": progress_percent,
        "progress_kind": progress_kind,
        "remaining_requests": max(
            0, planned_requests - processed_requests
        ),
    }


def render_progress_bar(percent: float, *, width: int = 28) -> str:
    """Render a compact ASCII-only progress bar for terminals and log files."""

    if width <= 0:
        raise ValueError("width debe ser mayor que cero")
    value = min(100.0, max(0.0, float(percent)))
    filled = min(width, max(0, round(width * value / 100.0)))
    return f"[{'#' * filled}{'-' * (width - filled)}] {value:6.2f}%"


def final_status_for_plan(status: str, *, fallback: bool) -> str:
    """Avoid presenting a completed reduced plan as the full requested scope."""

    if status == "complete" and fallback:
        return "fallback_complete"
    return status


def download_plan_payload(plan: DownloadPlan) -> dict[str, Any]:
    """Return a deterministic JSON-serializable representation of a plan."""

    minimum_required_with_headroom = bytes_with_space_headroom(
        plan.conservative_bytes,
        REQUIRED_SPACE_HEADROOM_PERCENT,
    )
    effective_total_margin_percent = (
        max(
            0.0,
            (plan.required_with_headroom / plan.point_bytes - 1.0) * 100.0,
        )
        if plan.point_bytes > 0
        else None
    )
    return {
        "dimensions": list(plan.dimensions),
        "layers": list(plan.layers),
        "lods": sorted(plan.lods),
        "rows": [dataclasses.asdict(row) for row in plan.rows],
        "fallback": plan.fallback,
        "point_bytes": plan.point_bytes,
        "conservative_bytes": plan.conservative_bytes,
        "requests": plan.requests,
        "free_bytes": plan.free_bytes,
        "required_with_headroom": plan.required_with_headroom,
        "space_headroom_percent": plan.space_headroom_percent,
        "sampling_uncertainty_percent": SAMPLING_UNCERTAINTY_PERCENT,
        "required_space_headroom_percent": REQUIRED_SPACE_HEADROOM_PERCENT,
        "nominal_total_margin_percent": compounded_margin_percent(
            SAMPLING_UNCERTAINTY_PERCENT,
            plan.space_headroom_percent,
        ),
        "effective_total_margin_percent": effective_total_margin_percent,
        "minimum_required_with_headroom": minimum_required_with_headroom,
        "meets_required_space_headroom": (
            plan.space_headroom_percent >= REQUIRED_SPACE_HEADROOM_PERCENT
            and plan.required_with_headroom
            >= minimum_required_with_headroom
        ),
        "headroom_bytes": max(
            0, plan.required_with_headroom - plan.conservative_bytes
        ),
        "space_shortfall_bytes": max(
            0, plan.required_with_headroom - plan.free_bytes
        ),
        "fits": plan.required_with_headroom <= plan.free_bytes,
    }


def tile_axis_bounds(dimension: str, lod: int) -> tuple[int, int]:
    if dimension == "overworld":
        return OVERWORLD_OBSERVED_CANDIDATE_AXIS_BOUNDS[lod]
    coverage = COVERAGE[dimension]
    span = TILE_PIXELS * (1 << lod)
    minimum = math.floor(coverage["min_block"] / span)
    maximum = math.floor((coverage["max_block_exclusive"] - 1) / span)
    return minimum, maximum


def candidate_count(dimension: str, lod: int) -> int:
    if dimension == "overworld":
        return int(
            OVERWORLD_OBSERVED_FOOTPRINT[
                "candidate_requests_by_lod"
            ][lod]
        )
    minimum, maximum = tile_axis_bounds(dimension, lod)
    side = maximum - minimum + 1
    return side * side


def sample_coordinates(
    dimension: str, lod: int, requested: int
) -> list[tuple[int, int]]:
    minimum, maximum = tile_axis_bounds(dimension, lod)
    side = maximum - minimum + 1
    if side <= 0:
        return []
    requested = max(1, min(requested, side * side))
    grid_side = max(1, math.ceil(math.sqrt(requested)))
    if grid_side == 1:
        points = [(minimum + maximum) // 2]
    else:
        points = sorted(
            {
                minimum
                + round(index * (side - 1) / (grid_side - 1))
                for index in range(grid_side)
            }
        )
    coordinates: list[tuple[int, int]] = []
    for z in points:
        for x in points:
            coordinates.append((x, z))
    center = ((minimum + maximum) // 2, (minimum + maximum) // 2)
    if center in coordinates:
        coordinates.remove(center)
        coordinates.insert(0, center)
    return coordinates[:requested]


def verify_live_schema(
    session: requests.Session,
    limiter: AdaptiveRateLimiter,
    stop_event: threading.Event,
    timeout: float,
) -> dict[str, Any]:
    fetched: dict[str, dict[str, Any]] = {}
    bodies: dict[str, str] = {}
    for name, url in SCHEMA_SOURCES.items():
        if not limiter.acquire():
            raise RuntimeError("descubrimiento interrumpido")
        response = session.get(url, timeout=timeout)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(
                f"no se pudo verificar {name}: HTTP {response.status_code}"
            )
        body = response.text
        bodies[name] = body
        fetched[name] = {
            "url": url,
            "http_code": response.status_code,
            "sha256": hashlib.sha256(response.content).hexdigest(),
            "bytes": len(response.content),
        }

    tiles = bodies["tiles"]
    draw = bodies["draw"]
    globals_source = bodies["globals"]
    project = bodies["project"]
    required_signals = {
        "tile_url_base": "/tiles/base/${thisLod}/${currentDimension}/${sx}/${sy}/",
        "tile_url_overlay": "/tiles/overlay/${thisLod}/${currentDimension}/${sx}/${sy}/",
        "tile_url_newchunks": (
            "/tiles/newchunks/${thisLod}/${currentDimension}/${sx}/${sy}/"
        ),
        "shard_x": "(tx / 32) >> 0",
        "shard_z": "(ty / 32) >> 0",
        "tile_pixels": "512 * 2 ** lod",
        "lod_cap": "Math.min(10, lod)",
        "dimensions": "id: 'overworld'",
        "layers": "type: 'newchunks'",
        "overworld_coverage": "1,024,000",
        "nether_coverage": "100,000",
        "end_coverage": "256,000",
    }
    haystacks = {
        "tile_url_base": tiles,
        "tile_url_overlay": tiles,
        "tile_url_newchunks": tiles,
        "shard_x": tiles,
        "shard_z": tiles,
        "tile_pixels": draw,
        "lod_cap": draw,
        "dimensions": globals_source,
        "layers": globals_source,
        "overworld_coverage": project,
        "nether_coverage": project,
        "end_coverage": project,
    }
    missing = [
        name
        for name, signal in required_signals.items()
        if signal not in haystacks[name]
    ]
    if missing:
        raise RuntimeError(
            "el contrato público del sitio cambió; señales ausentes: "
            + ", ".join(missing)
        )
    return {
        "verified_at": utc_now(),
        "sources": fetched,
        "schema": {
            "url": (
                f"{BASE_URL}/tiles/{{layer}}/{{lod}}/{{dimension_id}}/"
                "{shard_x}/{shard_z}/t.{tile_x}.{tile_z}.webp"
            ),
            "lods": list(range(MIN_LOD, MAX_LOD + 1)),
            "dimensions": DIMENSIONS,
            "layers": list(LAYERS),
            "tile_pixels": TILE_PIXELS,
            "blocks_per_pixel": "2**lod",
            "tile_blocks": "512 * 2**lod",
            "axis_x": "aumenta hacia la derecha",
            "axis_z": "aumenta hacia abajo",
            "shard": "trunc(tile_coordinate / 32) toward zero",
            "coverage": COVERAGE,
            "observed_overworld_footprint": OVERWORLD_OBSERVED_FOOTPRINT,
        },
    }


def configure_logging(output_root: Path, verbose: bool) -> logging.Logger:
    output_root.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("download_all_2b2t")
    logger.setLevel(logging.DEBUG)
    for handler in tuple(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
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


def discover_estimates(
    *,
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: set[int],
    samples_per_group: int,
    database: TileDatabase,
    fetcher: TileFetcher,
    logger: logging.Logger,
    reuse_samples: bool,
) -> list[EstimateRow]:
    rows: list[EstimateRow] = []
    total_groups = len(dimensions) * len(layers) * len(lods)
    group_index = 0
    allocation_unit = filesystem_allocation_unit(fetcher.output_root)
    discovery_started = time.monotonic()
    requested_scope = scope_payload(dimensions, layers, lods)

    def report_discovery_progress() -> None:
        elapsed = max(0.001, time.monotonic() - discovery_started)
        group_rate = group_index / elapsed
        remaining_groups = max(0, total_groups - group_index)
        percent = (
            group_index * 100.0 / total_groups if total_groups else 100.0
        )
        counts = database.counts_for(dimensions, layers)
        space_used_bytes = database.total_downloaded_bytes_for(
            dimensions, layers
        )
        payload = {
            "updated_at": utc_now(),
            "status": "discovering",
            "phase": "discovery",
            "planned_requests": total_groups,
            "processed_requests": group_index,
            "known_requests": total_groups,
            "estimated_requests": total_groups,
            "remaining_requests": remaining_groups,
            "progress_percent": percent,
            "progress_kind": "phase",
            "download_started": False,
            "requested_scope": requested_scope,
            "effective_scope": requested_scope,
            "fallback": False,
            "tiles_completed": counts.get("complete", 0),
            "tiles_pending": counts.get("pending", 0)
            + counts.get("downloading", 0),
            "tiles_absent": counts.get("absent", 0),
            "tiles_corrupt": counts.get("corrupt", 0),
            "tiles_failed": counts.get("failed", 0)
            + counts.get("error", 0)
            + counts.get("protection", 0),
            "data_downloaded_bytes": space_used_bytes,
            "space_used_bytes": space_used_bytes,
            "eta_seconds": (
                remaining_groups / group_rate if group_rate > 0 else None
            ),
            "http_errors": database.http_errors_for(dimensions, layers),
            "effective_requests_per_second": getattr(
                getattr(fetcher, "limiter", None),
                "rate",
                None,
            ),
            "output": str(fetcher.output_root.resolve()),
        }
        atomic_write_json(fetcher.output_root / "progress.json", payload)

    logger.info(
        "Fase de descubrimiento: %d grupos, hasta %d muestras GET por grupo.",
        total_groups,
        samples_per_group,
    )
    logger.info(
        "Unidad de asignación del destino: %s por archivo.",
        human_bytes(allocation_unit),
    )
    report_discovery_progress()

    for dimension in dimensions:
        for layer in layers:
            for lod in sorted(lods, reverse=True):
                group_index += 1
                existing_sizes: list[int] = []
                allocated_existing_sizes: list[int] = []
                found = 0
                coordinates = sample_coordinates(
                    dimension, lod, samples_per_group
                )
                for tile_x, tile_z in coordinates:
                    spec = TileSpec(dimension, layer, lod, tile_x, tile_z)
                    cached = database.get_sample(spec) if reuse_samples else None
                    if cached is not None:
                        if bool(cached["exists_flag"]):
                            local_validation = validate_webp(
                                spec.path(fetcher.output_root),
                                calculate_hash=False,
                            )
                            if not local_validation.valid:
                                cached = None
                        elif int(cached["http_code"] or 0) != 404:
                            # Only a confirmed 404 is a stable negative sample.
                            # Timeouts, 5xx, protection responses, and invalid
                            # bodies must be retried on the next discovery run.
                            cached = None
                    if cached is not None:
                        exists = bool(cached["exists_flag"])
                        size = int(cached["size_bytes"])
                        status_code = cached["http_code"]
                        error = cached["error_message"]
                    else:
                        # La muestra es un GET real, validado y conservado en la
                        # estructura final. Así no se duplica la transferencia
                        # durante la descarga posterior.
                        row_id = database.add_tile(
                            spec, fetcher.output_root, selected=True
                        )
                        result = fetcher.fetch(
                            DownloadTask(row_id, spec, True)
                        )
                        database.record_result(
                            result,
                            fetcher.output_root,
                            min_lod=lod,
                            selected_lods={lod},
                        )
                        exists = result.exists
                        size = result.size_bytes
                        status_code = result.http_code
                        error = result.error
                        database.save_sample(
                            spec,
                            http_code=status_code,
                            exists=exists,
                            size_bytes=size,
                            error=error,
                        )
                    if not exists and int(status_code or 0) != 404:
                        raise RuntimeError(
                            "muestra de descubrimiento no concluyente para "
                            f"{spec.url}: HTTP {status_code!r}; "
                            f"{error or 'sin respuesta WebP válida'}"
                        )
                    if exists:
                        found += 1
                        existing_sizes.append(size)
                        allocated_existing_sizes.append(
                            allocated_payload_bytes(size, allocation_unit)
                        )
                    if fetcher.stop_event.is_set():
                        raise RuntimeError(
                            fetcher.protection_reason
                            or "descubrimiento interrumpido"
                        )

                candidates = candidate_count(dimension, lod)
                sample_count = len(coordinates)
                density = found / sample_count if sample_count else 0.0

                # La capa base cubre el rectángulo publicado. Las capas
                # dispersas se estiman con la fracción encontrada.
                if layer == "base" and found > 0:
                    density = max(density, 0.98)
                estimated_available = min(
                    candidates, math.ceil(candidates * density)
                )
                mean_existing = (
                    statistics.fmean(existing_sizes) if existing_sizes else 0.0
                )
                mean_allocated_existing = (
                    statistics.fmean(allocated_existing_sizes)
                    if allocated_existing_sizes
                    else 0.0
                )
                point_bytes = 0.0

                # Evita que una muestra casual de tiles transparentes produzca
                # una falsa estimación de cero para capas dispersas.
                if found:
                    logical_point = estimated_available * mean_existing
                    allocated_point = (
                        estimated_available * mean_allocated_existing
                    )
                    point_bytes = max(logical_point, allocated_point)
                elif rows:
                    previous = rows[-1]
                    if (
                        previous.dimension == dimension
                        and previous.layer == layer
                        and previous.lod == lod + 1
                        and previous.estimated_allocated_bytes > 0
                    ):
                        # Si el muestreo fino falla por dispersión, conserva
                        # como piso 1.5× el tamaño total del LOD padre.
                        point_bytes = (
                            previous.estimated_allocated_bytes * 1.5
                        )
                mean_candidate = (
                    point_bytes / candidates if candidates else 0.0
                )
                # Margen de incertidumbre de 25 %, independiente de la reserva
                # adicional configurable exigida en el preflight.
                conservative = math.ceil(
                    point_bytes
                    * (1.0 + SAMPLING_UNCERTAINTY_PERCENT / 100.0)
                )
                estimated_requests = candidates
                row = EstimateRow(
                    dimension=dimension,
                    layer=layer,
                    lod=lod,
                    candidate_tiles=candidates,
                    estimated_available=estimated_available,
                    sampled=sample_count,
                    found=found,
                    mean_bytes_per_candidate=mean_candidate,
                    mean_bytes_existing=mean_existing,
                    conservative_bytes=conservative,
                    estimated_requests=estimated_requests,
                    allocation_unit_bytes=allocation_unit,
                    mean_allocated_bytes_existing=mean_allocated_existing,
                    estimated_allocated_bytes=math.ceil(point_bytes),
                )
                rows.append(row)
                report_discovery_progress()
                logger.info(
                    "%s [%d/%d] %s/%s LOD %d: candidatos=%s, "
                    "muestras=%d/%d, tamaño conservador=%s",
                    render_progress_bar(
                        group_index * 100.0 / total_groups,
                        width=20,
                    ),
                    group_index,
                    total_groups,
                    dimension,
                    layer,
                    lod,
                    f"{candidates:,}",
                    found,
                    sample_count,
                    human_bytes(conservative),
                )
    return rows


def print_estimate_table(rows: Sequence[EstimateRow], logger: logging.Logger) -> None:
    logger.info("")
    logger.info(
        "%-10s %-10s %3s %12s %12s %12s %12s",
        "Dimensión",
        "Capa",
        "LOD",
        "Candidatos",
        "Disponibles",
        "Promedio",
        "Estimado",
    )
    logger.info("-" * 90)
    for row in rows:
        logger.info(
            "%-10s %-10s %3d %12s %12s %12s %12s",
            row.dimension,
            row.layer,
            row.lod,
            f"{row.candidate_tiles:,}",
            f"{row.estimated_available:,}",
            human_bytes(row.mean_bytes_existing),
            human_bytes(row.conservative_bytes),
        )
    logger.info("")


def remaining_estimate_bytes(
    rows: Sequence[EstimateRow],
    existing_bytes_by_group: dict[tuple[str, str, int], int],
    *,
    point_estimate: bool,
) -> int:
    total = 0
    for row in rows:
        existing = existing_bytes_by_group.get(
            (row.dimension, row.layer, row.lod),
            0,
        )
        estimated = (
            row.candidate_tiles * row.mean_bytes_per_candidate
            if point_estimate
            else row.conservative_bytes
        )
        total += max(0, math.ceil(estimated) - existing)
    return total


def build_plan(
    *,
    dimensions: list[str],
    layers: list[str],
    lods: set[int],
    rows: list[EstimateRow],
    free_bytes: int,
    existing_bytes: int,
    allow_fallback: bool,
    space_headroom_percent: float = DEFAULT_SPACE_HEADROOM_PERCENT,
    existing_bytes_by_group: dict[tuple[str, str, int], int] | None = None,
) -> DownloadPlan:
    if existing_bytes_by_group is None:
        if existing_bytes > 0 and len(rows) > 1:
            raise ValueError(
                "se requieren bytes existentes por grupo para evitar "
                "compensar estimaciones independientes"
            )
        existing_bytes_by_group = (
            {
                (rows[0].dimension, rows[0].layer, rows[0].lod): existing_bytes
            }
            if rows
            else {}
        )
    else:
        if any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for value in existing_bytes_by_group.values()
        ):
            raise ValueError("el desglose existente contiene bytes inválidos")
        if sum(existing_bytes_by_group.values()) != existing_bytes:
            raise ValueError(
                "el total existente no coincide con el desglose por grupo"
            )

    point_total = remaining_estimate_bytes(
        rows,
        existing_bytes_by_group,
        point_estimate=True,
    )
    conservative_total = remaining_estimate_bytes(
        rows,
        existing_bytes_by_group,
        point_estimate=False,
    )
    required = bytes_with_space_headroom(
        conservative_total,
        space_headroom_percent,
    )
    requests = sum(row.estimated_requests for row in rows)
    if free_bytes >= required:
        return DownloadPlan(
            dimensions,
            layers,
            set(lods),
            rows,
            False,
            point_total,
            conservative_total,
            requests,
            free_bytes,
            required,
            space_headroom_percent,
        )

    if not allow_fallback:
        return DownloadPlan(
            dimensions,
            layers,
            set(lods),
            rows,
            False,
            point_total,
            conservative_total,
            requests,
            free_bytes,
            required,
            space_headroom_percent,
        )

    if "base" not in layers or "overworld" not in dimensions:
        return DownloadPlan(
            dimensions,
            layers,
            set(),
            [],
            True,
            point_total,
            conservative_total,
            requests,
            free_bytes,
            required,
            space_headroom_percent,
        )

    base_rows = sorted(
        (
            row
            for row in rows
            if row.dimension == "overworld"
            and row.layer == "base"
            and row.lod in lods
        ),
        key=lambda row: row.lod,
        reverse=True,
    )
    selected_rows: list[EstimateRow] = []
    selected_lods: set[int] = set()
    running = 0

    for row in base_rows:
        tentative = running + remaining_estimate_bytes(
            [row],
            existing_bytes_by_group,
            point_estimate=False,
        )
        if (
            bytes_with_space_headroom(
                tentative,
                space_headroom_percent,
            )
            <= free_bytes
        ):
            selected_rows.append(row)
            selected_lods.add(row.lod)
            running = tentative
        else:
            break

    # La navegación jerárquica requiere un intervalo contiguo desde LOD 10.
    if selected_lods:
        finest = min(selected_lods)
        contiguous = {lod for lod in lods if finest <= lod <= MAX_LOD}
        selected_lods = contiguous
        selected_rows = [
            row
            for row in base_rows
            if row.lod in selected_lods
        ]
        running = sum(
            remaining_estimate_bytes(
                [row],
                existing_bytes_by_group,
                point_estimate=False,
            )
            for row in selected_rows
        )

    return DownloadPlan(
        ["overworld"],
        ["base"],
        selected_lods,
        selected_rows,
        True,
        math.ceil(
            sum(
                remaining_estimate_bytes(
                    [row],
                    existing_bytes_by_group,
                    point_estimate=True,
                )
                for row in selected_rows
            )
        ),
        running,
        sum(row.estimated_requests for row in selected_rows),
        free_bytes,
        bytes_with_space_headroom(running, space_headroom_percent),
        space_headroom_percent,
    )


def run_smoke_test(
    *,
    output_root: Path,
    database: TileDatabase,
    fetcher: TileFetcher,
    logger: logging.Logger,
    lod: int = 0,
) -> None:
    logger.info(
        "Prueba previa: cuadrícula 3×3, overworld/base, LOD %d.", lod
    )
    failures: list[str] = []
    for tile_z in range(-1, 2):
        for tile_x in range(-1, 2):
            spec = TileSpec("overworld", "base", lod, tile_x, tile_z)
            row_id = database.add_tile(spec, output_root, selected=True)
            result = fetcher.fetch(DownloadTask(row_id, spec, True))
            database.record_result(
                result,
                output_root,
                min_lod=lod,
                selected_lods={lod},
            )
            if result.status != "complete":
                failures.append(
                    f"{tile_x},{tile_z}: {result.status} ({result.error})"
                )
    if failures:
        raise RuntimeError(
            "falló la prueba 3×3; no se iniciará la descarga completa: "
            + "; ".join(failures)
        )
    logger.info("Prueba 3×3 superada: 9 WebP de 512×512 válidos.")


class ProgressTracker:
    def __init__(
        self,
        *,
        output_root: Path,
        database: TileDatabase,
        planned_requests: int,
        resume_command: str,
        logger: logging.Logger,
        limiter: AdaptiveRateLimiter,
        started_completed: int,
        started_bytes: int,
        dimensions: Sequence[str],
        layers: Sequence[str],
        min_lod: int = MIN_LOD,
        requested_scope: dict[str, Any] | None = None,
        effective_scope: dict[str, Any] | None = None,
        fallback: bool = False,
    ) -> None:
        self.output_root = output_root
        self.database = database
        self.estimated_requests = max(0, int(planned_requests))
        self.planned_requests = self.estimated_requests
        self.resume_command = resume_command
        self.logger = logger
        self.limiter = limiter
        self.started = time.monotonic()
        self.last_report = 0.0
        self.processed = 0
        self.session_completed = 0
        self.session_absent = 0
        self.session_corrupt = 0
        self.session_failed = 0
        self.session_bytes = 0
        self.started_completed = started_completed
        self.started_bytes = started_bytes
        self.dimensions = list(dimensions)
        self.layers = list(layers)
        self.min_lod = min_lod
        default_scope = scope_payload(
            self.dimensions,
            self.layers,
            range(min_lod, MAX_LOD + 1),
        )
        self.requested_scope = dict(requested_scope or default_scope)
        self.effective_scope = dict(effective_scope or default_scope)
        self.fallback = bool(fallback)
        self.latencies: list[float] = []
        self.http_errors: Counter[int] = Counter()

    def update(self, result: DownloadResult, *, force: bool = False) -> None:
        self.processed += 1
        self.session_bytes += result.downloaded_bytes
        self.latencies.append(result.elapsed)
        if len(self.latencies) > 500:
            self.latencies.pop(0)
        if result.status == "complete":
            self.session_completed += 1
        elif result.status == "absent":
            self.session_absent += 1
        elif result.status == "corrupt":
            self.session_corrupt += 1
        elif result.status in ("failed", "error", "protection"):
            self.session_failed += 1
        if result.http_code is not None and result.http_code >= 400:
            self.http_errors[result.http_code] += 1
        self.report(force=force)

    def _progress_metrics(
        self, *, successful_final: bool = False
    ) -> dict[str, Any]:
        work_counts = self.database.work_counts_for(
            self.dimensions,
            self.layers,
            self.min_lod,
        )
        return calculate_progress(
            work_counts,
            estimated_requests=self.estimated_requests,
            successful_final=successful_final,
        )

    def report(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_report < 5:
            return
        self.last_report = now
        elapsed = max(0.001, now - self.started)
        tile_rate = self.processed / elapsed
        byte_rate = self.session_bytes / elapsed
        progress = self._progress_metrics()
        eta = (
            progress["remaining_requests"] / tile_rate
            if tile_rate > 0
            else None
        )
        counts = self.database.counts_for(self.dimensions, self.layers)
        space_used_bytes = self.database.total_downloaded_bytes_for(
            self.dimensions, self.layers
        )
        payload = {
            "updated_at": utc_now(),
            "status": "running",
            "planned_requests": progress["planned_requests"],
            "processed_requests": progress["processed_requests"],
            "known_requests": progress["known_requests"],
            "remaining_requests": progress["remaining_requests"],
            "session_processed_requests": self.processed,
            "estimated_requests": self.estimated_requests,
            "progress_percent": progress["progress_percent"],
            "progress_kind": progress["progress_kind"],
            "phase": "download",
            "download_started": True,
            "requested_scope": self.requested_scope,
            "effective_scope": self.effective_scope,
            "fallback": self.fallback,
            "tiles_completed": counts.get("complete", 0),
            "tiles_pending": counts.get("pending", 0)
            + counts.get("downloading", 0),
            "tiles_absent": counts.get("absent", 0),
            "tiles_corrupt": counts.get("corrupt", 0),
            "tiles_per_second": tile_rate,
            "megabytes_per_second": byte_rate / 1_000_000,
            "data_downloaded_bytes": space_used_bytes,
            "space_used_bytes": space_used_bytes,
            "session_downloaded_bytes": self.session_bytes,
            "eta_seconds": eta,
            "http_errors": self.database.http_errors_for(
                self.dimensions, self.layers
            ),
            "effective_requests_per_second": self.limiter.rate,
            "resume_command": self.resume_command,
            "output": str(self.output_root.resolve()),
        }
        atomic_write_json(self.output_root / "progress.json", payload)
        self.logger.info(
            "%s Progreso: procesadas=%s/%s | completados=%s "
            "pendientes=%s | %.2f tiles/s | "
            "%.2f MB/s | datos=%s | ETA=%s | HTTP=%s",
            render_progress_bar(payload["progress_percent"]),
            f"{payload['processed_requests']:,}",
            f"{payload['planned_requests']:,}",
            f"{payload['tiles_completed']:,}",
            f"{payload['tiles_pending']:,}",
            tile_rate,
            byte_rate / 1_000_000,
            human_bytes(payload["data_downloaded_bytes"]),
            human_duration(eta),
            payload["http_errors"],
        )

    def finalize(self, status: str, reason: str | None = None) -> dict[str, Any]:
        self.report(force=True)
        successful_final = status in ("complete", "fallback_complete")
        progress = self._progress_metrics(successful_final=successful_final)
        counts = self.database.counts_for(self.dimensions, self.layers)
        payload = {
            "updated_at": utc_now(),
            "status": status,
            "reason": reason,
            "planned_requests": progress["planned_requests"],
            "processed_requests": progress["processed_requests"],
            "known_requests": progress["known_requests"],
            "remaining_requests": progress["remaining_requests"],
            "session_processed_requests": self.processed,
            "estimated_requests": self.estimated_requests,
            "progress_percent": progress["progress_percent"],
            "progress_kind": progress["progress_kind"],
            "phase": "download",
            "download_started": True,
            "requested_scope": self.requested_scope,
            "effective_scope": self.effective_scope,
            "fallback": self.fallback,
            "tiles_completed": counts.get("complete", 0),
            "tiles_pending": counts.get("pending", 0)
            + counts.get("downloading", 0),
            "tiles_absent": counts.get("absent", 0),
            "tiles_corrupt": counts.get("corrupt", 0),
            "tiles_failed": counts.get("failed", 0)
            + counts.get("error", 0)
            + counts.get("protection", 0),
            "space_used_bytes": self.database.total_downloaded_bytes_for(
                self.dimensions, self.layers
            ),
            "http_errors": self.database.http_errors_for(
                self.dimensions, self.layers
            ),
            "resume_command": self.resume_command,
            "output": str(self.output_root.resolve()),
        }
        atomic_write_json(self.output_root / "progress.json", payload)
        self.logger.info(
            "%s Solicitudes procesadas: %s/%s (%s)",
            render_progress_bar(payload["progress_percent"]),
            f"{payload['processed_requests']:,}",
            f"{payload['planned_requests']:,}",
            payload["progress_kind"],
        )
        return payload


def run_download_queue(
    *,
    plan: DownloadPlan,
    output_root: Path,
    database: TileDatabase,
    fetcher: TileFetcher,
    workers: int,
    stop_event: threading.Event,
    logger: logging.Logger,
    resume_command: str,
    requested_scope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not plan.lods:
        raise RuntimeError("no hay ningún LOD que quepa con el margen requerido")
    min_lod = min(plan.lods)
    database.prepare_resume(plan.dimensions, plan.layers, plan.lods)
    database.add_roots(plan.dimensions, plan.layers, plan.lods, output_root)
    database.reset_expansion_for_deeper_run(
        min_lod=min_lod,
        dimensions=plan.dimensions,
        layers=plan.layers,
    )
    database.expand_successful(
        output_root,
        min_lod=min_lod,
        selected_lods=plan.lods,
        dimensions=plan.dimensions,
        layers=plan.layers,
    )
    started_completed, started_bytes = database.completed_for(
        plan.dimensions, plan.layers, plan.lods
    )
    progress = ProgressTracker(
        output_root=output_root,
        database=database,
        planned_requests=plan.requests,
        resume_command=resume_command,
        logger=logger,
        limiter=fetcher.limiter,
        started_completed=started_completed,
        started_bytes=started_bytes,
        dimensions=plan.dimensions,
        layers=plan.layers,
        min_lod=min_lod,
        requested_scope=requested_scope,
        effective_scope=scope_payload(
            plan.dimensions,
            plan.layers,
            plan.lods,
        ),
        fallback=plan.fallback,
    )
    free_floor = max(
        512 * 1024 * 1024,
        max(
            0,
            bytes_with_space_headroom(
                plan.conservative_bytes,
                plan.space_headroom_percent,
            )
            - plan.conservative_bytes,
        ),
    )
    logger.info(
        "Descarga: dimensiones=%s capas=%s LODs=%s workers=%d "
        "piso de espacio libre=%s",
        ",".join(plan.dimensions),
        ",".join(plan.layers),
        ",".join(str(lod) for lod in sorted(plan.lods, reverse=True)),
        workers,
        human_bytes(free_floor),
    )

    futures: dict[
        concurrent.futures.Future[DownloadResult], DownloadTask
    ] = {}
    reason: str | None = None
    final_status = "complete"
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=workers, thread_name_prefix="tile"
    ) as executor:
        while not stop_event.is_set():
            while len(futures) < workers and not stop_event.is_set():
                task = database.claim_next(
                    plan.dimensions, plan.layers, min_lod
                )
                if task is None:
                    break
                futures[executor.submit(fetcher.fetch, task)] = task

            if not futures:
                if database.has_pending(
                    plan.dimensions, plan.layers, min_lod
                ):
                    continue
                break

            done, _ = concurrent.futures.wait(
                futures,
                timeout=1,
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            if not done:
                progress.report()
                continue
            for future in done:
                task = futures.pop(future)
                try:
                    result = future.result()
                except Exception as exc:  # defensa: preservar reanudación
                    logger.exception("Fallo inesperado en worker para %s", task.spec)
                    result = DownloadResult(
                        task,
                        "failed",
                        False,
                        None,
                        0,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                database.record_result(
                    result,
                    output_root,
                    min_lod=min_lod,
                    selected_lods=plan.lods,
                )
                progress.update(result)
                if result.status == "protection":
                    reason = result.error
                free_now = shutil.disk_usage(output_root).free
                if free_now < free_floor:
                    reason = (
                        f"espacio libre {human_bytes(free_now)} por debajo "
                        f"del piso seguro {human_bytes(free_floor)}"
                    )
                    logger.error(reason)
                    stop_event.set()
                    break

        if stop_event.is_set():
            final_status = "stopped"
            reason = reason or fetcher.protection_reason or "interrumpido"
            # Los workers observan stop_event. Se recogen sus resultados para
            # no dejar filas en `downloading`.
            for future, task in list(futures.items()):
                try:
                    result = future.result(timeout=max(1.0, fetcher.timeout + 2))
                except Exception as exc:
                    result = DownloadResult(
                        task,
                        "pending",
                        False,
                        None,
                        0,
                        error=f"interrumpido: {type(exc).__name__}: {exc}",
                    )
                if result.status == "pending":
                    database.connection.execute(
                        """
                        UPDATE tiles SET status='pending', error_message=?,
                            updated_at=? WHERE id=?
                        """,
                        (result.error, utc_now(), task.row_id),
                    )
                    database.connection.commit()
                else:
                    database.record_result(
                        result,
                        output_root,
                        min_lod=min_lod,
                        selected_lods=plan.lods,
                    )
                    progress.update(result)

    if final_status == "complete":
        blocking = database.blocking_statuses(
            plan.dimensions, plan.layers, min_lod
        )
        if blocking:
            final_status = "incomplete"
            reason = "filas sin resolver al agotar la cola: " + ", ".join(
                f"{status}={count}"
                for status, count in sorted(blocking.items())
            )
            logger.error(reason)

    final_status = final_status_for_plan(
        final_status,
        fallback=plan.fallback,
    )
    if final_status == "fallback_complete" and reason is None:
        reason = (
            "plan priorizado completado; la selección solicitada completa "
            "no cabía con el margen de espacio requerido"
        )
    return progress.finalize(final_status, reason)


def parse_csv_choices(
    raw: str,
    *,
    allowed: Sequence[str],
    option_name: str,
) -> list[str]:
    values = [part.strip().lower() for part in raw.split(",") if part.strip()]
    if not values:
        raise argparse.ArgumentTypeError(f"{option_name} no puede estar vacío")
    invalid = sorted(set(values) - set(allowed))
    if invalid:
        raise argparse.ArgumentTypeError(
            f"{option_name} inválido: {', '.join(invalid)}; "
            f"permitidos: {', '.join(allowed)}"
        )
    return list(dict.fromkeys(values))


def parse_lods(raw: str) -> set[int]:
    if raw.strip().lower() == "all":
        return set(range(MIN_LOD, MAX_LOD + 1))
    values: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            lod = int(part)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                f"LOD no entero: {part}"
            ) from exc
        if not MIN_LOD <= lod <= MAX_LOD:
            raise argparse.ArgumentTypeError(
                f"LOD fuera de rango {MIN_LOD}..{MAX_LOD}: {lod}"
            )
        values.add(lod)
    if not values:
        raise argparse.ArgumentTypeError("--lods no puede estar vacío")
    return values


def positive_finite(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("debe ser un número") from exc
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("debe ser finito y mayor que cero")
    return value


def positive_int(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("debe ser entero") from exc
    if value <= 0:
        raise argparse.ArgumentTypeError("debe ser mayor que cero")
    return value


def nonnegative_percentage(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("debe ser un porcentaje") from exc
    if not math.isfinite(value) or not 0 <= value <= 100:
        raise argparse.ArgumentTypeError("debe estar entre 0 y 100")
    return value


def is_exact_full_scope(
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: set[int],
) -> bool:
    return (
        set(dimensions) == set(DIMENSIONS)
        and set(layers) == set(LAYERS)
        and lods == set(range(MAX_LOD + 1))
    )


def legacy_migration_estimate_allows(args: argparse.Namespace) -> bool:
    """Recognize only the already-running full-map 18% migration plan."""

    if (
        not args.all
        or not args.resume
        or not args.no_fallback
        or not is_exact_full_scope(args.dimensions, args.layers, args.lods)
        or not math.isclose(
            args.space_headroom_percent,
            TEMPORARY_MIGRATION_HEADROOM_PERCENT,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
    ):
        return False
    try:
        payload = json.loads(
            (args.out.expanduser().resolve() / "estimate.json").read_text(
                encoding="utf-8"
            )
        )
        requested = payload["requested"]
        plan = payload["plan"]
        configured = plan["space_headroom_percent"]
        rows = plan["rows"]
    except (
        FileNotFoundError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
    ):
        return False
    if (
        not isinstance(requested, dict)
        or not isinstance(plan, dict)
        or plan.get("fallback") is not False
        or plan.get("fits") is not True
        or isinstance(configured, bool)
        or not isinstance(configured, (int, float))
        or not math.isfinite(float(configured))
        or not math.isclose(
            float(configured),
            args.space_headroom_percent,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or not isinstance(rows, list)
    ):
        return False
    try:
        requested_scope_matches = (
            set(requested["dimensions"]) == set(DIMENSIONS)
            and set(requested["layers"]) == set(LAYERS)
            and set(requested["lods"]) == set(range(MAX_LOD + 1))
        )
    except (KeyError, TypeError):
        return False
    expected_rows = {
        (dimension, layer, lod)
        for dimension in DIMENSIONS
        for layer in LAYERS
        for lod in range(MAX_LOD + 1)
    }
    try:
        actual_rows = {
            (row["dimension"], row["layer"], row["lod"])
            for row in rows
            if isinstance(row, dict)
        }
    except (KeyError, TypeError):
        return False
    return (
        requested_scope_matches
        and len(rows) == len(expected_rows)
        and actual_rows == expected_rows
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Descarga todos los tiles descubiertos de 2b2t.place con "
            "reanudación SQLite, validación WebP y escritura atómica."
        )
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Descubre y descarga todos los tiles que coincidan con los filtros.",
    )
    parser.add_argument(
        "--dimensions",
        default="overworld",
        help="Lista CSV (predeterminado actual: overworld).",
    )
    parser.add_argument(
        "--layers",
        default="base,overlay,newchunks",
        help="Lista CSV: base,overlay,newchunks.",
    )
    parser.add_argument(
        "--lods",
        default="all",
        help="`all` o lista CSV de LODs 0..10.",
    )
    parser.add_argument("--out", type=Path, default=Path("2b2t_tiles"))
    parser.add_argument(
        "--workers",
        type=positive_int,
        default=4,
        help="Concurrencia conservadora. Predeterminado: 4.",
    )
    parser.add_argument(
        "--requests-per-second",
        type=positive_finite,
        default=2.0,
        help="Límite global, compartido por todos los workers.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Reanuda exactamente desde tiles.sqlite3.",
    )
    parser.add_argument(
        "--revalidate",
        action="store_true",
        help="Revalida todos los archivos completos antes de continuar.",
    )
    parser.add_argument(
        "--timeout",
        type=positive_finite,
        default=30.0,
        help="Timeout HTTP en segundos.",
    )
    parser.add_argument(
        "--retries",
        type=positive_int,
        default=5,
        help="Intentos máximos por petición.",
    )
    parser.add_argument(
        "--discovery-samples",
        type=positive_int,
        default=25,
        help=(
            "Muestras GET por dimensión/capa/LOD para estimar tamaño "
            "(predeterminado: 25)."
        ),
    )
    parser.add_argument(
        "--max-tile-bytes",
        type=positive_int,
        default=16 * 1024 * 1024,
        help="Límite de seguridad por respuesta.",
    )
    parser.add_argument(
        "--space-headroom-percent",
        type=nonnegative_percentage,
        default=DEFAULT_SPACE_HEADROOM_PERCENT,
        help=(
            "Reserva adicional sobre la estimación ya conservadora "
            f"(predeterminado: {DEFAULT_SPACE_HEADROOM_PERCENT:g} %%)."
        ),
    )
    parser.add_argument(
        "--estimate-only",
        action="store_true",
        help="Descubre y estima, pero no inicia la descarga.",
    )
    parser.add_argument(
        "--cached-estimate-only",
        action="store_true",
        help=(
            "Genera una estimación del alcance solicitado usando únicamente "
            "SQLite y los WebP cacheados; no usa red ni toma el lock de "
            "descarga."
        ),
    )
    parser.add_argument(
        "--smoke-test-only",
        action="store_true",
        help="Ejecuta únicamente la prueba en vivo 3×3.",
    )
    parser.add_argument(
        "--skip-smoke-test",
        action="store_true",
        help="Omite la prueba solo si ya fue registrada como exitosa.",
    )
    parser.add_argument(
        "--refresh-discovery",
        action="store_true",
        help="No reutiliza muestras GET guardadas en SQLite.",
    )
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Si no cabe todo, no prioriza base/overworld.",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    try:
        args.dimensions = parse_csv_choices(
            args.dimensions,
            allowed=tuple(DIMENSIONS),
            option_name="--dimensions",
        )
        args.layers = parse_csv_choices(
            args.layers,
            allowed=LAYERS,
            option_name="--layers",
        )
        args.lods = parse_lods(args.lods)
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    if args.cached_estimate_only:
        if args.all or args.estimate_only or args.smoke_test_only:
            parser.error(
                "--cached-estimate-only no se combina con --all, "
                "--estimate-only ni --smoke-test-only"
            )
        if args.revalidate or args.refresh_discovery:
            parser.error(
                "--cached-estimate-only no admite --revalidate ni "
                "--refresh-discovery"
            )
    elif not args.all and not args.estimate_only and not args.smoke_test_only:
        parser.error(
            "usa --all, --estimate-only, --cached-estimate-only o "
            "--smoke-test-only"
        )
    if args.skip_smoke_test and args.smoke_test_only:
        parser.error("--skip-smoke-test y --smoke-test-only son incompatibles")
    if (
        args.space_headroom_percent < REQUIRED_SPACE_HEADROOM_PERCENT
    ):
        if not legacy_migration_estimate_allows(args):
            parser.error(
                "--space-headroom-percent debe ser al menos "
                f"{REQUIRED_SPACE_HEADROOM_PERCENT:g}; la excepción temporal "
                "solo pertenece al supervisor de migración del mapa completo"
            )
    return args


def build_resume_command(args: argparse.Namespace) -> str:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--all",
        "--dimensions",
        ",".join(args.dimensions),
        "--layers",
        ",".join(args.layers),
        "--lods",
        ",".join(str(lod) for lod in sorted(args.lods, reverse=True)),
        "--out",
        str(args.out.resolve()),
        "--workers",
        str(args.workers),
        "--requests-per-second",
        str(args.requests_per_second),
        "--timeout",
        str(args.timeout),
        "--retries",
        str(args.retries),
        "--discovery-samples",
        str(args.discovery_samples),
        "--max-tile-bytes",
        str(args.max_tile_bytes),
        "--space-headroom-percent",
        str(args.space_headroom_percent),
        "--resume",
    ]
    if args.skip_smoke_test:
        command.append("--skip-smoke-test")
    if args.no_fallback:
        command.append("--no-fallback")
    if args.verbose:
        command.append("--verbose")
    return shlex.join(command)


def open_cached_estimate_database(database_path: Path) -> sqlite3.Connection:
    """Open an existing catalog in a hard read-only SQLite connection."""

    resolved = database_path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(
            f"no existe el catálogo SQLite: {resolved}"
        )
    connection = sqlite3.connect(
        f"{resolved.as_uri()}?mode=ro",
        uri=True,
        timeout=5,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    if int(connection.execute("PRAGMA query_only").fetchone()[0]) != 1:
        connection.close()
        raise RuntimeError("SQLite no confirmó el modo query_only")
    return connection


def canonical_cached_estimate_scope(
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: Iterable[int],
) -> tuple[list[str], list[str], list[int]]:
    """Return one deterministic order for cached reports and file names."""

    requested_dimensions = set(dimensions)
    requested_layers = set(layers)
    requested_lods = set(lods)
    return (
        [
            dimension
            for dimension in DIMENSIONS
            if dimension in requested_dimensions
        ],
        [layer for layer in LAYERS if layer in requested_layers],
        sorted(requested_lods),
    )


def cached_estimate_report_relative_path(
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: Iterable[int],
) -> Path:
    """Choose a stable report path while preserving the Overworld contract."""

    canonical_dimensions, canonical_layers, canonical_lods = (
        canonical_cached_estimate_scope(dimensions, layers, lods)
    )
    if (
        canonical_dimensions == ["overworld"]
        and canonical_layers == list(LAYERS)
        and canonical_lods == list(range(MIN_LOD, MAX_LOD + 1))
    ):
        return CACHED_ESTIMATE_REPORT_RELATIVE_PATH

    dimension_slug = "-".join(canonical_dimensions)
    layer_slug = "-".join(canonical_layers)
    lod_slug = (
        "all"
        if canonical_lods == list(range(MIN_LOD, MAX_LOD + 1))
        else "-".join(str(lod) for lod in canonical_lods)
    )
    return (
        Path("reports")
        / (
            f"cached-estimate-{dimension_slug}__{layer_slug}"
            f"__lod-{lod_slug}.json"
        )
    )


def build_cached_continuation_command(
    args: argparse.Namespace,
    *,
    dimensions: Sequence[str],
    layers: Sequence[str],
    lods: Iterable[int],
    skip_smoke_test: bool,
) -> str:
    """Build an exact, capacity-gated continuation command for one stage."""

    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--all",
        "--dimensions",
        ",".join(dimensions),
        "--layers",
        ",".join(layers),
        "--lods",
        ",".join(str(lod) for lod in sorted(set(lods), reverse=True)),
        "--out",
        str(args.out.expanduser().resolve()),
        "--workers",
        str(args.workers),
        "--requests-per-second",
        str(args.requests_per_second),
        "--timeout",
        str(args.timeout),
        "--retries",
        str(args.retries),
        "--discovery-samples",
        str(args.discovery_samples),
        "--max-tile-bytes",
        str(args.max_tile_bytes),
        "--space-headroom-percent",
        str(args.space_headroom_percent),
        "--resume",
    ]
    if skip_smoke_test:
        command.append("--skip-smoke-test")
    command.append("--no-fallback")
    if args.verbose:
        command.append("--verbose")
    return shlex.join(command)


_CACHED_ESTIMATE_SUM_FIELDS = (
    "candidate_tiles",
    "estimated_available_tiles",
    "cached_samples",
    "stable_samples",
    "valid_positive_samples",
    "confirmed_absent_samples",
    "inconclusive_samples",
    "invalid_local_samples",
    "size_mismatch_samples",
    "estimated_point_bytes",
    "estimated_conservative_bytes",
    "existing_complete_tiles",
    "existing_complete_bytes",
    "known_absent_tiles",
    "known_terminal_requests",
    "estimated_remaining_available_tiles",
    "estimated_remaining_requests",
    "estimated_remaining_point_bytes",
    "estimated_remaining_conservative_bytes",
)


def summarize_cached_estimate_rows(
    rows: Sequence[dict[str, Any]],
    *,
    free_bytes: int,
    space_headroom_percent: float,
) -> dict[str, Any]:
    """Aggregate cached-estimate rows without letting groups subsidize others."""

    summary = {
        key: sum(int(row[key]) for row in rows)
        for key in _CACHED_ESTIMATE_SUM_FIELDS
    }
    stable = int(summary["stable_samples"])
    summary["sample_density"] = (
        int(summary["valid_positive_samples"]) / stable
        if stable
        else None
    )
    required = bytes_with_space_headroom(
        int(summary["estimated_remaining_conservative_bytes"]),
        space_headroom_percent,
    )
    summary.update(
        {
            "free_bytes": int(free_bytes),
            "space_headroom_percent": space_headroom_percent,
            "required_with_space_headroom_bytes": required,
            "space_shortfall_bytes": max(0, required - int(free_bytes)),
            "fits": required <= int(free_bytes),
        }
    )
    return summary


def _cached_smoke_test_passed(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        "SELECT value FROM metadata WHERE key='smoke_test'"
    ).fetchone()
    if row is None:
        return False
    try:
        payload = json.loads(str(row["value"]))
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("passed") is True


def build_cached_estimate(
    *,
    output_root: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Build a scoped offline report from a consistent read-only snapshot."""

    database_path = output_root / "tiles.sqlite3"
    dimensions, layers, lods = canonical_cached_estimate_scope(
        args.dimensions,
        args.layers,
        args.lods,
    )
    if not dimensions or not layers or not lods:
        raise ValueError("el alcance cacheado no puede estar vacío")
    connection = open_cached_estimate_database(database_path)
    try:
        connection.execute("BEGIN")
        required_tables = {"tiles", "metadata", "discovery_samples"}
        actual_tables = {
            str(row["name"])
            for row in connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type='table' AND name IN (
                    'tiles', 'metadata', 'discovery_samples'
                )
                """
            )
        }
        missing_tables = sorted(required_tables - actual_tables)
        if missing_tables:
            raise RuntimeError(
                "el catálogo no contiene las tablas requeridas: "
                + ", ".join(missing_tables)
            )

        dimension_marks = ",".join("?" for _ in dimensions)
        layer_marks = ",".join("?" for _ in layers)
        lod_marks = ",".join("?" for _ in lods)
        scope_parameters: list[Any] = [*dimensions, *layers, *lods]

        sample_groups: dict[
            tuple[str, str, int], list[sqlite3.Row]
        ] = {}
        for sample in connection.execute(
            f"""
            SELECT dimension, layer, lod, tile_x, tile_z,
                   http_code, exists_flag,
                   size_bytes, sampled_at
            FROM discovery_samples
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod IN ({lod_marks})
            ORDER BY dimension, layer, lod DESC, tile_z, tile_x
            """,
            scope_parameters,
        ):
            sample_groups.setdefault(
                (
                    str(sample["dimension"]),
                    str(sample["layer"]),
                    int(sample["lod"]),
                ),
                [],
            ).append(sample)

        status_groups: dict[
            tuple[str, str, int], dict[str, tuple[int, int]]
        ] = {}
        for status_row in connection.execute(
            f"""
            SELECT dimension, layer, lod, status, COUNT(*) AS count,
                   COALESCE(SUM(size_bytes), 0) AS bytes
            FROM tiles
            WHERE dimension IN ({dimension_marks})
              AND layer IN ({layer_marks})
              AND lod IN ({lod_marks})
            GROUP BY dimension, layer, lod, status
            """,
            scope_parameters,
        ):
            status_groups.setdefault(
                (
                    str(status_row["dimension"]),
                    str(status_row["layer"]),
                    int(status_row["lod"]),
                ),
                {},
            )[str(status_row["status"])] = (
                int(status_row["count"]),
                int(status_row["bytes"]),
            )

        planning_floor_rows: dict[
            tuple[str, str, int], dict[str, Any]
        ] = {}
        planning_floor_updated_at: str | None = None
        planning_floor_metadata = connection.execute(
            """
            SELECT value, updated_at FROM metadata
            WHERE key='last_full_estimate'
            """
        ).fetchone()
        if planning_floor_metadata is not None:
            try:
                planning_floor_payload = json.loads(
                    str(planning_floor_metadata["value"])
                )
                raw_floor_rows = planning_floor_payload.get("rows", [])
                if not isinstance(raw_floor_rows, list):
                    raw_floor_rows = []
            except (json.JSONDecodeError, TypeError, ValueError):
                raw_floor_rows = []
            for raw_floor in raw_floor_rows:
                if not isinstance(raw_floor, dict):
                    continue
                try:
                    key = (
                        str(raw_floor["dimension"]),
                        str(raw_floor["layer"]),
                        int(raw_floor["lod"]),
                    )
                except (KeyError, TypeError, ValueError):
                    continue
                planning_floor_rows[key] = raw_floor
            planning_floor_updated_at = str(
                planning_floor_metadata["updated_at"]
            )

        allocation_unit = filesystem_allocation_unit(output_root)
        estimate_rows: list[dict[str, Any]] = []
        sampled_timestamps: list[str] = []
        planning_floor_groups_used = 0

        for dimension in dimensions:
            for layer, lod in (
                (layer, lod)
                for layer in layers
                for lod in sorted(lods, reverse=True)
            ):
                group = sample_groups.get(
                    (dimension, layer, lod),
                    [],
                )
                valid_sizes: list[int] = []
                allocated_sizes: list[int] = []
                confirmed_absent = 0
                invalid_local = 0
                size_mismatches = 0

                for sample in group:
                    sampled_timestamps.append(str(sample["sampled_at"]))
                    if bool(sample["exists_flag"]):
                        spec = TileSpec(
                            dimension,
                            layer,
                            lod,
                            int(sample["tile_x"]),
                            int(sample["tile_z"]),
                        )
                        validation = validate_webp(
                            spec.path(output_root),
                            calculate_hash=False,
                        )
                        if not validation.valid:
                            invalid_local += 1
                            continue
                        valid_sizes.append(validation.size_bytes)
                        allocated_sizes.append(
                            allocated_payload_bytes(
                                validation.size_bytes,
                                allocation_unit,
                            )
                        )
                        if validation.size_bytes != int(sample["size_bytes"]):
                            size_mismatches += 1
                    elif int(sample["http_code"] or 0) == 404:
                        confirmed_absent += 1

                stable_samples = len(valid_sizes) + confirmed_absent
                if stable_samples == 0:
                    raise RuntimeError(
                        "faltan muestras cacheadas concluyentes para "
                        f"{dimension}/{layer}/LOD {lod}"
                    )
                if not valid_sizes:
                    if layer == "base" or confirmed_absent != len(group):
                        raise RuntimeError(
                            "falta una muestra WebP válida para estimar "
                            f"tamaño en {dimension}/{layer}/LOD {lod}"
                        )

                sample_density = len(valid_sizes) / stable_samples
                estimated_density = (
                    max(sample_density, 0.98)
                    if layer == "base"
                    else sample_density
                )
                candidates = candidate_count(dimension, lod)
                estimated_available = min(
                    candidates,
                    math.ceil(candidates * estimated_density),
                )
                mean_existing = (
                    statistics.fmean(valid_sizes) if valid_sizes else 0.0
                )
                mean_allocated = (
                    statistics.fmean(allocated_sizes)
                    if allocated_sizes
                    else 0.0
                )
                point_bytes_value = max(
                    estimated_available * mean_existing,
                    estimated_available * mean_allocated,
                )
                cached_point_bytes = math.ceil(point_bytes_value)
                cached_conservative_bytes = math.ceil(
                    point_bytes_value
                    * (1.0 + SAMPLING_UNCERTAINTY_PERCENT / 100.0)
                )
                point_bytes = cached_point_bytes
                conservative_bytes = cached_conservative_bytes
                planning_floor = planning_floor_rows.get(
                    (dimension, layer, lod)
                )
                planning_floor_point_bytes = 0
                planning_floor_conservative_bytes = 0
                planning_floor_applied = False
                if planning_floor is not None:
                    try:
                        planning_candidates = int(
                            planning_floor["candidate_tiles"]
                        )
                        planning_floor_point_bytes = max(
                            0,
                            int(
                                planning_floor.get(
                                    "estimated_allocated_bytes",
                                    0,
                                )
                            ),
                        )
                        planning_floor_conservative_bytes = max(
                            0,
                            int(
                                planning_floor.get(
                                    "conservative_bytes",
                                    0,
                                )
                            ),
                        )
                    except (KeyError, TypeError, ValueError):
                        planning_candidates = -1
                        planning_floor_point_bytes = 0
                        planning_floor_conservative_bytes = 0
                    if planning_candidates == candidates:
                        point_bytes = max(
                            point_bytes,
                            planning_floor_point_bytes,
                        )
                        conservative_bytes = max(
                            conservative_bytes,
                            planning_floor_conservative_bytes,
                        )
                        planning_floor_applied = (
                            point_bytes > cached_point_bytes
                            or conservative_bytes
                            > cached_conservative_bytes
                        )
                        if planning_floor_applied:
                            planning_floor_groups_used += 1
                    else:
                        planning_floor_point_bytes = 0
                        planning_floor_conservative_bytes = 0

                statuses = status_groups.get(
                    (dimension, layer, lod),
                    {},
                )
                existing_complete_tiles, existing_complete_bytes = (
                    statuses.get("complete", (0, 0))
                )
                known_absent_tiles = statuses.get("absent", (0, 0))[0]
                known_terminal_requests = sum(
                    statuses.get(status, (0, 0))[0]
                    for status in TERMINAL_STATUSES
                )
                row_timestamps = [
                    str(sample["sampled_at"]) for sample in group
                ]
                estimate_rows.append(
                    {
                        "dimension": dimension,
                        "layer": layer,
                        "lod": lod,
                        "candidate_tiles": candidates,
                        "estimated_available_tiles": estimated_available,
                        "cached_samples": len(group),
                        "stable_samples": stable_samples,
                        "valid_positive_samples": len(valid_sizes),
                        "confirmed_absent_samples": confirmed_absent,
                        "inconclusive_samples": (
                            len(group) - stable_samples
                        ),
                        "invalid_local_samples": invalid_local,
                        "size_mismatch_samples": size_mismatches,
                        "sample_density": sample_density,
                        "estimated_density": estimated_density,
                        "sampled_at_min": min(row_timestamps),
                        "sampled_at_max": max(row_timestamps),
                        "allocation_unit_bytes": allocation_unit,
                        "mean_bytes_existing": mean_existing,
                        "mean_allocated_bytes_existing": mean_allocated,
                        "mean_bytes_per_candidate": (
                            point_bytes / candidates
                            if candidates
                            else 0.0
                        ),
                        "cached_estimated_point_bytes": (
                            cached_point_bytes
                        ),
                        "cached_estimated_conservative_bytes": (
                            cached_conservative_bytes
                        ),
                        "planning_floor_point_bytes": (
                            planning_floor_point_bytes
                        ),
                        "planning_floor_conservative_bytes": (
                            planning_floor_conservative_bytes
                        ),
                        "planning_floor_applied": planning_floor_applied,
                        "estimated_point_bytes": point_bytes,
                        "estimated_conservative_bytes": conservative_bytes,
                        "existing_complete_tiles": existing_complete_tiles,
                        "existing_complete_bytes": existing_complete_bytes,
                        "known_absent_tiles": known_absent_tiles,
                        "known_terminal_requests": known_terminal_requests,
                        "estimated_remaining_available_tiles": max(
                            0,
                            estimated_available - existing_complete_tiles,
                        ),
                        "estimated_remaining_requests": max(
                            0,
                            candidates - known_terminal_requests,
                        ),
                        "estimated_remaining_point_bytes": max(
                            0,
                            point_bytes - existing_complete_bytes,
                        ),
                        "estimated_remaining_conservative_bytes": max(
                            0,
                            conservative_bytes - existing_complete_bytes,
                        ),
                        "status_counts": {
                            status: count
                            for status, (count, _bytes) in sorted(
                                statuses.items()
                            )
                        },
                    }
                )

        expected_groups = {
            (dimension, layer, lod)
            for dimension in dimensions
            for layer in layers
            for lod in lods
        }
        actual_groups = {
            (
                str(row["dimension"]),
                str(row["layer"]),
                int(row["lod"]),
            )
            for row in estimate_rows
        }
        if (
            len(estimate_rows) != len(expected_groups)
            or actual_groups != expected_groups
        ):
            raise RuntimeError(
                "el informe cacheado no produjo todas las filas del alcance: "
                f"esperadas={len(expected_groups)}, "
                f"producidas={len(estimate_rows)}"
            )

        free_bytes = shutil.disk_usage(output_root).free
        totals_by_layer = {
            layer: summarize_cached_estimate_rows(
                [
                    row
                    for row in estimate_rows
                    if row["layer"] == layer
                ],
                free_bytes=free_bytes,
                space_headroom_percent=args.space_headroom_percent,
            )
            for layer in layers
        }
        totals_by_dimension = {
            dimension: summarize_cached_estimate_rows(
                [
                    row
                    for row in estimate_rows
                    if row["dimension"] == dimension
                ],
                free_bytes=free_bytes,
                space_headroom_percent=args.space_headroom_percent,
            )
            for dimension in dimensions
        }
        totals_by_dimension_layer = {
            dimension: {
                layer: summarize_cached_estimate_rows(
                    [
                        row
                        for row in estimate_rows
                        if row["dimension"] == dimension
                        and row["layer"] == layer
                    ],
                    free_bytes=free_bytes,
                    space_headroom_percent=args.space_headroom_percent,
                )
                for layer in layers
            }
            for dimension in dimensions
        }
        total = summarize_cached_estimate_rows(
            estimate_rows,
            free_bytes=free_bytes,
            space_headroom_percent=args.space_headroom_percent,
        )
        smoke_test_passed = _cached_smoke_test_passed(connection)

        legacy_overworld_scope = (
            dimensions == ["overworld"]
            and layers == list(LAYERS)
            and lods == list(range(MIN_LOD, MAX_LOD + 1))
        )
        if legacy_overworld_scope:
            continuation_scopes = [
                (
                    "base_lod0_after_capacity",
                    1,
                    ["overworld"],
                    ["base"],
                    [0],
                    (
                        "Después de completar base LOD 10..1 y añadir la "
                        "capacidad que exija este preflight."
                    ),
                ),
                (
                    "overlay_all_lods_after_base",
                    2,
                    ["overworld"],
                    ["overlay"],
                    list(range(MAX_LOD, MIN_LOD - 1, -1)),
                    "Después de completar base en todos los LOD.",
                ),
                (
                    "newchunks_all_lods_after_overlay",
                    3,
                    ["overworld"],
                    ["newchunks"],
                    list(range(MAX_LOD, MIN_LOD - 1, -1)),
                    (
                        "Después de completar base; se recomienda después "
                        "de overlay."
                    ),
                ),
            ]
        else:
            lod_identifier = (
                "all"
                if lods == list(range(MIN_LOD, MAX_LOD + 1))
                else "-".join(str(lod) for lod in lods)
            )
            continuation_scopes = [
                (
                    (
                        f"{dimension}_{layer}_lod_{lod_identifier}"
                        "_after_capacity"
                    ),
                    priority,
                    [dimension],
                    [layer],
                    list(reversed(lods)),
                    (
                        "Cuando el preflight exacto de este alcance confirme "
                        "espacio suficiente con la reserva requerida."
                    ),
                )
                for priority, (dimension, layer) in enumerate(
                    (
                        (dimension, layer)
                        for dimension in dimensions
                        for layer in layers
                    ),
                    start=1,
                )
            ]
        continuation_commands = [
            {
                "id": identifier,
                "priority": priority,
                "run_after": run_after,
                "scope": scope_payload(
                    command_dimensions,
                    command_layers,
                    command_lods,
                ),
                "lod_order": "coarse_to_fine",
                "preflight_must_fit": True,
                "command": build_cached_continuation_command(
                    args,
                    dimensions=command_dimensions,
                    layers=command_layers,
                    lods=command_lods,
                    skip_smoke_test=smoke_test_passed,
                ),
            }
            for (
                identifier,
                priority,
                command_dimensions,
                command_layers,
                command_lods,
                run_after,
            )
            in continuation_scopes
        ]

        footprints_by_dimension: dict[str, dict[str, Any]] = {}
        for dimension in dimensions:
            footprint: dict[str, Any] = (
                dict(OVERWORLD_OBSERVED_FOOTPRINT)
                if dimension == "overworld"
                else {"published_coverage": dict(COVERAGE[dimension])}
            )
            footprint.update(
                {
                    "candidate_requests_by_lod": {
                        str(lod): candidate_count(dimension, lod)
                        for lod in sorted(lods, reverse=True)
                    },
                    "candidate_axis_bounds_by_lod": {
                        str(lod): {
                            "min_tile": tile_axis_bounds(dimension, lod)[0],
                            "max_tile": tile_axis_bounds(dimension, lod)[1],
                        }
                        for lod in sorted(lods, reverse=True)
                    },
                    "candidate_requests_per_layer": sum(
                        candidate_count(dimension, lod)
                        for lod in lods
                    ),
                }
            )
            footprints_by_dimension[dimension] = footprint
        report_path = (
            output_root
            / cached_estimate_report_relative_path(
                dimensions,
                layers,
                lods,
            )
        ).resolve()
        report = {
            "schema_version": 1,
            "created_at": utc_now(),
            "mode": "cached_estimate_only",
            "requested": {
                "dimensions": dimensions,
                "layers": layers,
                "lods": lods,
            },
            "source": {
                "database": str(database_path.resolve()),
                "sqlite_uri_mode": "ro",
                "sqlite_query_only": True,
                "network_requests": 0,
                "sample_policy": (
                    "todas las muestras cacheadas concluyentes; los WebP "
                    "positivos se validan localmente"
                ),
                "sampled_at_min": min(sampled_timestamps),
                "sampled_at_max": max(sampled_timestamps),
                "smoke_test_passed": smoke_test_passed,
                "planning_floor_metadata": "last_full_estimate",
                "planning_floor_updated_at": planning_floor_updated_at,
                "planning_floor_groups_used": planning_floor_groups_used,
            },
            "output": str(report_path),
            "margins": {
                "sampling_uncertainty_percent": (
                    SAMPLING_UNCERTAINTY_PERCENT
                ),
                "space_headroom_percent": args.space_headroom_percent,
                "nominal_total_margin_percent": compounded_margin_percent(
                    SAMPLING_UNCERTAINTY_PERCENT,
                    args.space_headroom_percent,
                ),
            },
            "rows": estimate_rows,
            "totals_by_layer": totals_by_layer,
            "totals_by_dimension": totals_by_dimension,
            "totals_by_dimension_layer": totals_by_dimension_layer,
            "total": total,
            "continuation_commands": continuation_commands,
        }
        if len(dimensions) == 1:
            report["footprint"] = footprints_by_dimension[dimensions[0]]
        report["footprints_by_dimension"] = footprints_by_dimension
        return report
    finally:
        connection.close()


def build_cached_overworld_estimate(
    *,
    output_root: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Backward-compatible name for callers of the original report builder."""

    return build_cached_estimate(output_root=output_root, args=args)


def run_cached_estimate_only(args: argparse.Namespace) -> int:
    """Generate the isolated cached report without logging, locks, or network."""

    output_root = args.out.expanduser().resolve()
    report_path = (
        output_root
        / cached_estimate_report_relative_path(
            args.dimensions,
            args.layers,
            args.lods,
        )
    )
    try:
        payload = build_cached_estimate(
            output_root=output_root,
            args=args,
        )
        atomic_write_json(report_path, payload)
    except Exception as exc:
        print(
            f"No se pudo generar la estimación cacheada: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1
    print(f"Estimación cacheada guardada en: {report_path}")
    return 0


def revalidate_database(
    database: TileDatabase,
    output_root: Path,
    logger: logging.Logger,
) -> tuple[int, int]:
    snapshot = database.connection.execute(
        """
        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id
        FROM tiles WHERE status='complete'
        """
    ).fetchone()
    assert snapshot is not None
    total = int(snapshot["count"])
    max_id = int(snapshot["max_id"])
    last_id = 0
    valid = 0
    invalid = 0
    checked = 0
    while last_id < max_id:
        rows = database.connection.execute(
            """
            SELECT id, relative_path
            FROM tiles
            WHERE status='complete' AND id>? AND id<=?
            ORDER BY id
            LIMIT 256
            """,
            (last_id, max_id),
        ).fetchall()
        if not rows:
            break
        for row in rows:
            path = output_root / str(row["relative_path"])
            validation = validate_webp(path)
            if validation.valid:
                valid += 1
                database.connection.execute(
                    """
                    UPDATE tiles SET size_bytes=?, sha256=?,
                        error_message=NULL, updated_at=? WHERE id=?
                    """,
                    (
                        validation.size_bytes,
                        validation.sha256,
                        utc_now(),
                        row["id"],
                    ),
                )
            else:
                invalid += 1
                database.connection.execute(
                    """
                    UPDATE tiles SET status='pending', sha256=NULL,
                        error_message=?, updated_at=? WHERE id=?
                    """,
                    (
                        f"revalidación: {validation.error}",
                        utc_now(),
                        row["id"],
                    ),
                )
            checked += 1
            if checked % 1000 == 0:
                database.connection.commit()
                logger.info(
                    "Revalidación: %d/%d (válidos=%d, inválidos=%d)",
                    checked,
                    total,
                    valid,
                    invalid,
                )
        last_id = int(rows[-1]["id"])
    database.connection.commit()
    return valid, invalid


def print_final_summary(
    summary: dict[str, Any],
    logger: logging.Logger,
) -> None:
    logger.info("")
    logger.info("Estado final: %s", summary["status"])
    if summary.get("reason"):
        logger.info("Motivo: %s", summary["reason"])
    if summary.get("requested_scope"):
        logger.info(
            "Alcance solicitado: %s",
            json.dumps(summary["requested_scope"], ensure_ascii=False),
        )
    if summary.get("effective_scope"):
        logger.info(
            "Alcance efectivo: %s%s",
            json.dumps(summary["effective_scope"], ensure_ascii=False),
            " (fallback)" if summary.get("fallback") else "",
        )
    if "processed_requests" in summary:
        logger.info(
            "Progreso final: %s %s/%s solicitudes (%s)",
            render_progress_bar(summary.get("progress_percent", 0.0)),
            f"{summary['processed_requests']:,}",
            f"{summary.get('planned_requests', 0):,}",
            summary.get("progress_kind", "desconocido"),
        )
    logger.info("Descargados: %s", f"{summary['tiles_completed']:,}")
    logger.info("Ausentes: %s", f"{summary['tiles_absent']:,}")
    logger.info("Corruptos: %s", f"{summary['tiles_corrupt']:,}")
    logger.info("Pendientes: %s", f"{summary['tiles_pending']:,}")
    logger.info("Espacio utilizado: %s", human_bytes(summary["space_used_bytes"]))
    logger.info("Ruta de salida: %s", summary["output"])
    logger.info("Comando exacto para reanudar:")
    logger.info("%s", summary["resume_command"])


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.cached_estimate_only:
        return run_cached_estimate_only(args)
    output_root = args.out.expanduser().resolve()
    logger = configure_logging(output_root, args.verbose)
    download_lock = RegionDownloadLock(output_root)
    try:
        download_lock.acquire()
    except RegionDownloadLockedError as exc:
        logger.error("%s", exc)
        return 2
    stop_event = threading.Event()
    interrupted = {"value": False}

    def handle_signal(signum: int, _frame: Any) -> None:
        if not interrupted["value"]:
            interrupted["value"] = True
            logger.warning(
                "Señal %s recibida: parada limpia en curso; vuelve a pulsar "
                "Ctrl+C solo si necesitas forzar la salida.",
                signum,
            )
            stop_event.set()
        else:
            logger.error("Segunda interrupción: salida forzada.")
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        database = TileDatabase(output_root / "tiles.sqlite3")
    except BaseException:
        download_lock.release()
        raise
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
    resume_command = build_resume_command(args)
    plan: DownloadPlan | None = None
    preflight_blocked = False

    try:
        logger.info("Salida: %s", output_root)
        if (
            args.space_headroom_percent
            < REQUIRED_SPACE_HEADROOM_PERCENT
        ):
            logger.warning(
                "Reserva posterior a la incertidumbre reducida a %.2f %% "
                "(requerido: %.2f %%); se aceptó únicamente como "
                "continuación temporal controlada y debe migrar al "
                "porcentaje requerido cuando el preflight demuestre que cabe.",
                args.space_headroom_percent,
                REQUIRED_SPACE_HEADROOM_PERCENT,
            )
        logger.info(
            "Margen nominal total sobre la estimación puntual: %.2f %% "
            "(%.2f %% de incertidumbre y %.2f %% de reserva posterior; "
            "reserva posterior requerida: %.2f %%).",
            compounded_margin_percent(
                SAMPLING_UNCERTAINTY_PERCENT,
                args.space_headroom_percent,
            ),
            SAMPLING_UNCERTAINTY_PERCENT,
            args.space_headroom_percent,
            REQUIRED_SPACE_HEADROOM_PERCENT,
        )
        logger.info("Verificando el contrato público de 2b2t.place...")
        schema_session = requests.Session()
        schema_session.headers["User-Agent"] = USER_AGENT
        discovery = verify_live_schema(
            schema_session, limiter, stop_event, args.timeout
        )
        atomic_write_json(output_root / "discovery.json", discovery)
        database.set_metadata("discovery", discovery)
        logger.info(
            "Contrato verificado: LOD 0–10, tiles 512×512, "
            "dimensiones overworld/nether/end."
        )

        if args.revalidate:
            valid, invalid = revalidate_database(database, output_root, logger)
            logger.info(
                "Revalidación terminada: válidos=%d, reencolados=%d",
                valid,
                invalid,
            )

        smoke_metadata = database.connection.execute(
            "SELECT value FROM metadata WHERE key='smoke_test'"
        ).fetchone()
        smoke_already_passed = False
        if smoke_metadata is not None:
            try:
                smoke_already_passed = bool(
                    json.loads(smoke_metadata["value"]).get("passed")
                )
            except (json.JSONDecodeError, AttributeError):
                pass
        if args.skip_smoke_test and not smoke_already_passed:
            raise RuntimeError(
                "--skip-smoke-test solo se acepta después de una prueba "
                "exitosa registrada en tiles.sqlite3"
            )
        if not args.skip_smoke_test:
            run_smoke_test(
                output_root=output_root,
                database=database,
                fetcher=fetcher,
                logger=logger,
            )
            database.set_metadata(
                "smoke_test", {"passed": True, "at": utc_now(), "tiles": 9}
            )
        if args.smoke_test_only:
            smoke_progress = calculate_progress(
                {"complete": 9},
                estimated_requests=9,
                successful_final=True,
            )
            smoke_scope = scope_payload(
                ["overworld"],
                ["base"],
                [0],
            )
            summary = {
                "status": "smoke_test_complete",
                "reason": None,
                **{
                    key: smoke_progress[key]
                    for key in (
                        "planned_requests",
                        "processed_requests",
                        "known_requests",
                        "progress_percent",
                        "progress_kind",
                    )
                },
                "requested_scope": smoke_scope,
                "effective_scope": smoke_scope,
                "fallback": False,
                "tiles_completed": database.counts().get("complete", 0),
                "tiles_absent": database.counts().get("absent", 0),
                "tiles_corrupt": database.counts().get("corrupt", 0),
                "tiles_pending": database.counts().get("pending", 0),
                "space_used_bytes": database.total_downloaded_bytes(),
                "output": str(output_root),
                "resume_command": resume_command,
            }
            atomic_write_json(output_root / "progress.json", summary)
            print_final_summary(summary, logger)
            return 0

        estimate_rows = discover_estimates(
            dimensions=args.dimensions,
            layers=args.layers,
            lods=args.lods,
            samples_per_group=args.discovery_samples,
            database=database,
            fetcher=fetcher,
            logger=logger,
            reuse_samples=not args.refresh_discovery,
        )
        print_estimate_table(estimate_rows, logger)
        _, existing_bytes = database.completed_for(
            args.dimensions, args.layers, args.lods
        )
        existing_bytes_by_group = database.completed_bytes_by_group(
            args.dimensions,
            args.layers,
            args.lods,
        )
        free_bytes = shutil.disk_usage(output_root).free
        full_conservative_bytes = remaining_estimate_bytes(
            estimate_rows,
            existing_bytes_by_group,
            point_estimate=False,
        )
        full_required_with_headroom = bytes_with_space_headroom(
            full_conservative_bytes,
            args.space_headroom_percent,
        )
        plan = build_plan(
            dimensions=args.dimensions,
            layers=args.layers,
            lods=args.lods,
            rows=estimate_rows,
            free_bytes=free_bytes,
            existing_bytes=existing_bytes,
            allow_fallback=not args.no_fallback,
            space_headroom_percent=args.space_headroom_percent,
            existing_bytes_by_group=existing_bytes_by_group,
        )
        full_plan = build_plan(
            dimensions=args.dimensions,
            layers=args.layers,
            lods=args.lods,
            rows=estimate_rows,
            free_bytes=free_bytes,
            existing_bytes=existing_bytes,
            allow_fallback=False,
            space_headroom_percent=args.space_headroom_percent,
            existing_bytes_by_group=existing_bytes_by_group,
        )
        plan_payload = download_plan_payload(plan)
        full_plan_payload = download_plan_payload(full_plan)
        database.set_metadata("last_estimate", plan_payload)
        database.set_metadata("last_full_estimate", full_plan_payload)
        full_requests = sum(row.estimated_requests for row in estimate_rows)
        logger.info("Tiles candidatos de la selección completa: %s", f"{full_requests:,}")
        logger.info(
            "Almacenamiento conservador restante (selección completa): %s",
            human_bytes(full_conservative_bytes),
        )
        logger.info(
            "Requerido con %.2f %% adicional: %s",
            args.space_headroom_percent,
            human_bytes(full_required_with_headroom),
        )
        logger.info("Espacio libre: %s", human_bytes(plan.free_bytes))
        logger.info(
            "Tiempo mínimo de la selección completa a "
            "%.3f solicitudes/s: %s",
            args.requests_per_second,
            human_duration(full_requests / args.requests_per_second),
        )
        full_fits = full_required_with_headroom <= plan.free_bytes
        if not full_fits:
            missing = max(0, full_required_with_headroom - plan.free_bytes)
            if full_conservative_bytes <= plan.free_bytes:
                logger.warning(
                    "La estimación conservadora cabe, pero faltan %s para "
                    "cumplir la reserva adicional de %.2f %%. "
                    "No se eliminará ningún archivo.",
                    human_bytes(missing),
                    args.space_headroom_percent,
                )
            else:
                logger.warning(
                    "La estimación conservadora no cabe. Faltan al menos %s. "
                    "No se eliminará ningún archivo.",
                    human_bytes(missing),
                )
        if plan.fallback:
            if plan.lods:
                logger.warning(
                    "Prioridad automática: base/overworld, LODs %s "
                    "(estimado conservador %s; con margen %s).",
                    ",".join(
                        str(lod) for lod in sorted(plan.lods, reverse=True)
                    ),
                    human_bytes(plan.conservative_bytes),
                    human_bytes(plan.required_with_headroom),
                )
                logger.warning(
                    "Tiempo mínimo del plan priorizado: %s "
                    "(%s solicitudes estimadas).",
                    human_duration(
                        plan.requests / args.requests_per_second
                    ),
                    f"{plan.requests:,}",
                )
            else:
                raise RuntimeError(
                    "ni siquiera el primer LOD priorizado cabe con "
                    f"{args.space_headroom_percent:g} % de espacio adicional"
                )

        estimate_payload = {
            "created_at": utc_now(),
            "requested": {
                "dimensions": args.dimensions,
                "layers": args.layers,
                "lods": sorted(args.lods),
            },
            "plan": plan_payload,
            "full_plan": full_plan_payload,
            "full_resume_command": resume_command,
        }
        atomic_write_json(output_root / "estimate.json", estimate_payload)
        if args.estimate_only:
            estimate_counts = database.counts_for(
                args.dimensions,
                args.layers,
            )
            estimate_space_used = database.total_downloaded_bytes_for(
                args.dimensions,
                args.layers,
            )
            estimate_groups = len(estimate_rows)
            estimate_progress = {
                "updated_at": utc_now(),
                "status": "estimate_complete",
                "phase": "estimate",
                "download_started": False,
                "planned_requests": estimate_groups,
                "processed_requests": estimate_groups,
                "known_requests": estimate_groups,
                "remaining_requests": 0,
                "estimated_requests": full_requests,
                "progress_percent": 100.0,
                "progress_kind": "actual",
                "requested_scope": scope_payload(
                    args.dimensions,
                    args.layers,
                    args.lods,
                ),
                "effective_scope": scope_payload(
                    plan.dimensions,
                    plan.layers,
                    plan.lods,
                ),
                "fallback": plan.fallback,
                "tiles_completed": estimate_counts.get("complete", 0),
                "tiles_pending": estimate_counts.get("pending", 0)
                + estimate_counts.get("downloading", 0),
                "tiles_absent": estimate_counts.get("absent", 0),
                "tiles_corrupt": estimate_counts.get("corrupt", 0),
                "tiles_failed": estimate_counts.get("failed", 0)
                + estimate_counts.get("error", 0)
                + estimate_counts.get("protection", 0),
                "data_downloaded_bytes": estimate_space_used,
                "space_used_bytes": estimate_space_used,
                "http_errors": database.http_errors_for(
                    args.dimensions,
                    args.layers,
                ),
                "free_bytes": plan.free_bytes,
                "required_with_headroom_bytes": (
                    full_required_with_headroom
                ),
                "space_shortfall_bytes": max(
                    0,
                    full_required_with_headroom - plan.free_bytes,
                ),
                "resume_command": resume_command,
                "output": str(output_root),
            }
            atomic_write_json(
                output_root / "progress.json",
                estimate_progress,
            )
            logger.info("Estimación terminada; no se inició la descarga.")
            return 0
        if not full_fits and args.no_fallback:
            missing = full_required_with_headroom - plan.free_bytes
            preflight_blocked = True
            raise RuntimeError(
                "la selección completa requiere "
                f"{human_bytes(full_required_with_headroom)} con "
                f"{args.space_headroom_percent:g} % de margen; faltan "
                f"{human_bytes(missing)}"
            )

        summary = run_download_queue(
            plan=plan,
            output_root=output_root,
            database=database,
            fetcher=fetcher,
            workers=args.workers,
            stop_event=stop_event,
            logger=logger,
            resume_command=resume_command,
            requested_scope=scope_payload(
                args.dimensions,
                args.layers,
                args.lods,
            ),
        )
        print_final_summary(summary, logger)
        if summary["status"] in ("complete", "fallback_complete"):
            return 0
        if summary["status"] == "stopped":
            return 130
        return 2
    except KeyboardInterrupt:
        logger.error("Salida forzada por segunda interrupción.")
        return 130
    except Exception as exc:
        logger.exception("No se pudo continuar: %s", exc)
        effective_dimensions = (
            plan.dimensions if plan is not None else args.dimensions
        )
        effective_layers = plan.layers if plan is not None else args.layers
        effective_lods = (
            plan.lods
            if plan is not None and plan.lods
            else args.lods
        )
        counts = database.counts_for(
            effective_dimensions,
            effective_layers,
        )
        error_progress = calculate_progress(
            database.work_counts_for(
                effective_dimensions,
                effective_layers,
                min(effective_lods),
            ),
            estimated_requests=plan.requests if plan is not None else 0,
        )
        summary = {
            "updated_at": utc_now(),
            "status": "preflight_blocked" if preflight_blocked else "error",
            "phase": "preflight" if preflight_blocked else None,
            "download_started": False if preflight_blocked else None,
            "reason": f"{type(exc).__name__}: {exc}",
            **{
                key: error_progress[key]
                for key in (
                    "planned_requests",
                    "processed_requests",
                    "known_requests",
                    "progress_percent",
                    "progress_kind",
                    "remaining_requests",
                )
            },
            "requested_scope": scope_payload(
                args.dimensions,
                args.layers,
                args.lods,
            ),
            "effective_scope": scope_payload(
                effective_dimensions,
                effective_layers,
                effective_lods,
            ),
            "fallback": bool(plan is not None and plan.fallback),
            "tiles_completed": counts.get("complete", 0),
            "tiles_pending": counts.get("pending", 0)
            + counts.get("downloading", 0),
            "tiles_absent": counts.get("absent", 0),
            "tiles_corrupt": counts.get("corrupt", 0),
            "tiles_failed": counts.get("failed", 0)
            + counts.get("error", 0)
            + counts.get("protection", 0),
            "space_used_bytes": database.total_downloaded_bytes_for(
                effective_dimensions, effective_layers
            ),
            "http_errors": database.http_errors_for(
                effective_dimensions, effective_layers
            ),
            "resume_command": resume_command,
            "output": str(output_root),
        }
        atomic_write_json(output_root / "progress.json", summary)
        print_final_summary(summary, logger)
        return 1
    finally:
        database.close()
        download_lock.release()


if __name__ == "__main__":
    raise SystemExit(main())
