#!/usr/bin/env python3
"""Reduce the local Atlas to its LOD 10 panorama and an empty regional cache.

This is intentionally project-specific and destructive. It refuses to run
without ``--apply``, validates the exact LuisA-backed roots, records a compact
audit backup, keeps only the three Overworld LOD 10 layers, and never touches
the workspace containing sessions and highlights.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


GLOBAL_ROOT = Path("/Volumes/2b2t Tiles/2b2t_tiles")
REGIONAL_ROOT = Path(
    "/Volumes/2b2t Tiles/ObsidianAtlasRegions/2b2t_tiles"
)
BACKUP_ROOT = Path("/Volumes/LuisA/ObsidianAtlas/backups")
WORKSPACE_PATH = Path(
    "/Volumes/LuisA/ObsidianAtlas/state/atlas-workspace.v1.json"
)
LAYERS = ("base", "overlay", "newchunks")
KEEP_LOD = 10
KEEP_DIMENSION = "overworld"
LEGACY_METADATA_FILES = (
    "progress.json",
    "estimate.json",
    "discovery.json",
    "margin_upgrade.json",
    "verify_report.json",
)
LEGACY_FILES = (
    *LEGACY_METADATA_FILES,
    "download.log",
    "supervisor.log",
    "screenlog.0",
    "progress_viewer.log",
    "smoke_mosaic.webp",
    "overworld_background.log",
)
LEGACY_DIRECTORIES = (
    "recovery",
    "reports",
    ".download.lock",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Conserva únicamente el panorama Overworld LOD 10 y vacía "
            "la biblioteca regional."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Ejecutar el borrado; sin esta opción solo muestra el inventario.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_root(path: Path, expected: Path) -> Path:
    if path.is_symlink():
        raise RuntimeError(f"La ruta no puede ser un enlace simbólico: {path}")
    resolved = path.resolve(strict=True)
    if resolved != expected:
        raise RuntimeError(
            f"Ruta inesperada: {resolved}; se esperaba exactamente {expected}"
        )
    if not resolved.is_dir():
        raise RuntimeError(f"No es un directorio: {resolved}")
    return resolved


def pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def live_lock_owner(lock_path: Path) -> int | None:
    if not lock_path.exists():
        return None
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
        pid = int(payload["pid"])
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return None
    return pid if pid_is_alive(pid) else None


def assert_no_live_download(root: Path) -> None:
    lock_path = root / ".region-download.lock"
    owner = live_lock_owner(lock_path)
    if owner is not None:
        raise RuntimeError(
            f"Hay una descarga activa con PID {owner}: {lock_path}"
        )


@contextmanager
def exclusive_global_lock(global_root: Path) -> Iterator[None]:
    lock_path = global_root / ".download.execution.lock"
    with lock_path.open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                "La biblioteca global todavía está siendo utilizada"
            ) from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def webp_inventory(root: Path) -> dict[str, int]:
    count = 0
    size_bytes = 0
    for path in root.rglob("*.webp"):
        if not path.is_file():
            continue
        metadata = path.stat()
        count += 1
        size_bytes += metadata.st_size
    return {"files": count, "bytes": size_bytes}


def grouped_webp_inventory(root: Path) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for path in root.rglob("*.webp"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if len(relative.parts) < 4:
            key = ("unknown", "unknown", "unknown")
        else:
            key = relative.parts[0], relative.parts[1], relative.parts[2]
        group = groups.setdefault(
            key,
            {
                "layer": key[0],
                "lod": key[1],
                "dimension": key[2],
                "files": 0,
                "bytes": 0,
            },
        )
        group["files"] += 1
        group["bytes"] += path.stat().st_size
    return sorted(
        groups.values(),
        key=lambda item: (
            item["layer"],
            int(item["lod"]) if str(item["lod"]).isdigit() else -1,
            item["dimension"],
        ),
    )


def read_rows(database_path: Path, query: str) -> list[dict[str, Any]]:
    if not database_path.is_file():
        return []
    connection = sqlite3.connect(
        f"file:{database_path}?mode=ro",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute(query)]
    finally:
        connection.close()


def retained_rows(database_path: Path) -> list[dict[str, Any]]:
    return read_rows(
        database_path,
        """
        SELECT *
          FROM tiles
         WHERE dimension = 'overworld'
           AND lod = 10
           AND layer IN ('base', 'overlay', 'newchunks')
           AND status IN ('complete', 'absent')
         ORDER BY layer, tile_z, tile_x
        """,
    )


def all_rows(database_path: Path) -> list[dict[str, Any]]:
    return read_rows(
        database_path,
        """
        SELECT *
          FROM tiles
         ORDER BY dimension, layer, lod, tile_z, tile_x
        """,
    )


def retained_webp_hashes(global_root: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for layer in LAYERS:
        root = global_root / layer / str(KEEP_LOD) / KEEP_DIMENSION
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.webp")):
            if not path.is_file():
                continue
            result.append(
                {
                    "path": str(path.relative_to(global_root)),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    return result


def write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def create_backup(
    global_root: Path,
    regional_root: Path,
) -> tuple[Path, dict[str, Any]]:
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
    backup = BACKUP_ROOT / f"on-demand-reset-{stamp}-{uuid4()}"
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)

    global_database = global_root / "tiles.sqlite3"
    regional_database = regional_root / "tiles.sqlite3"
    kept_rows = retained_rows(global_database)
    removed_regional_rows = all_rows(regional_database)
    kept_hashes = retained_webp_hashes(global_root)

    write_json(backup / "global-lod10-retained.json", kept_rows)
    write_json(backup / "regional-rows-removed.json", removed_regional_rows)
    write_json(backup / "retained-webp-sha256.json", kept_hashes)

    legacy_backup = backup / "legacy-global-metadata"
    for name in LEGACY_METADATA_FILES:
        source = global_root / name
        if source.is_file():
            legacy_backup.mkdir(mode=0o700, exist_ok=True)
            shutil.copy2(source, legacy_backup / name)

    manifest = {
        "schemaVersion": 1,
        "createdAt": utc_now(),
        "policy": {
            "mode": "regional-on-demand",
            "keptDimension": KEEP_DIMENSION,
            "keptLod": KEEP_LOD,
            "keptLayers": list(LAYERS),
            "regionalCacheReset": True,
        },
        "paths": {
            "globalRoot": str(global_root),
            "regionalRoot": str(regional_root),
            "workspace": str(WORKSPACE_PATH),
        },
        "workspace": {
            "bytes": WORKSPACE_PATH.stat().st_size,
            "sha256": sha256_file(WORKSPACE_PATH),
        },
        "before": {
            "global": webp_inventory(global_root),
            "globalGroups": grouped_webp_inventory(global_root),
            "globalDatabaseRowsRetained": len(kept_rows),
            "regional": webp_inventory(regional_root),
            "regionalDatabaseRowsRemoved": len(removed_regional_rows),
        },
        "retainedWebpCount": len(kept_hashes),
    }
    write_json(backup / "manifest.json", manifest)
    return backup, manifest


def compact_global_database(database_path: Path) -> None:
    connection = sqlite3.connect(database_path, timeout=30)
    try:
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            DELETE FROM tiles
             WHERE NOT (
               dimension = 'overworld'
               AND lod = 10
               AND layer IN ('base', 'overlay', 'newchunks')
               AND status IN ('complete', 'absent')
             )
            """
        )
        connection.execute(
            "UPDATE tiles SET selected = 0, children_seeded = 0"
        )
        connection.execute("DELETE FROM discovery_samples")
        connection.execute("DELETE FROM metadata")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("VACUUM")
        connection.execute("PRAGMA optimize")
    finally:
        connection.close()


def keep_global_webp(relative: Path) -> bool:
    return (
        len(relative.parts) >= 4
        and relative.parts[0] in LAYERS
        and relative.parts[1] == str(KEEP_LOD)
        and relative.parts[2] == KEEP_DIMENSION
    )


def remove_empty_directories(root: Path) -> None:
    directories = sorted(
        (path for path in root.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for path in directories:
        try:
            path.rmdir()
        except OSError:
            pass


def remove_global_detail(global_root: Path) -> None:
    for layer in LAYERS:
        layer_root = global_root / layer
        if not layer_root.is_dir():
            continue
        for path in layer_root.rglob("*.webp"):
            if not path.is_file():
                continue
            relative = path.relative_to(global_root)
            if not keep_global_webp(relative):
                path.unlink()
        for lod in range(KEEP_LOD):
            lod_root = layer_root / str(lod)
            if lod_root.is_dir():
                shutil.rmtree(lod_root)
        retained_lod_root = layer_root / str(KEEP_LOD)
        if retained_lod_root.is_dir():
            for child in retained_lod_root.iterdir():
                if child.name != KEEP_DIMENSION and child.is_dir():
                    shutil.rmtree(child)
            for metadata_path in retained_lod_root.rglob(".DS_Store"):
                if metadata_path.is_file():
                    metadata_path.unlink()
        remove_empty_directories(layer_root)

    for name in LEGACY_FILES:
        path = global_root / name
        if path.is_file():
            path.unlink()
    for name in LEGACY_DIRECTORIES:
        path = global_root / name
        if path.is_dir():
            shutil.rmtree(path)
    for path in (
        global_root / ".progress_viewer.lock",
        global_root / ".progress_viewer.lock.guard",
        global_root / "tiles.sqlite3-wal",
        global_root / "tiles.sqlite3-shm",
    ):
        if path.is_file():
            path.unlink()
    for path in global_root.glob("overworld_zoom_*.webp"):
        if path.is_file():
            path.unlink()


def reset_regional_cache(regional_root: Path) -> None:
    for path in regional_root.rglob("*.webp"):
        if path.is_file():
            path.unlink()
    for name in (
        "tiles.sqlite3",
        "tiles.sqlite3-wal",
        "tiles.sqlite3-shm",
        "download.log",
        ".region-download.lock",
        ".DS_Store",
    ):
        path = regional_root / name
        if path.is_file():
            path.unlink()
    remove_empty_directories(regional_root)


def remove_stale_region_lock(root: Path) -> None:
    lock_path = root / ".region-download.lock"
    if lock_path.is_file() and live_lock_owner(lock_path) is None:
        lock_path.unlink()


def main() -> int:
    args = parse_args()
    global_root = validate_root(GLOBAL_ROOT, GLOBAL_ROOT)
    regional_root = validate_root(REGIONAL_ROOT, REGIONAL_ROOT)
    validate_root(BACKUP_ROOT, BACKUP_ROOT)
    if not WORKSPACE_PATH.is_file() or WORKSPACE_PATH.is_symlink():
        raise RuntimeError(f"Workspace no disponible: {WORKSPACE_PATH}")
    if global_root == regional_root:
        raise RuntimeError("Las bibliotecas global y regional deben ser distintas")

    assert_no_live_download(global_root)
    assert_no_live_download(regional_root)
    preview = {
        "mode": "regional-on-demand",
        "apply": bool(args.apply),
        "globalBefore": webp_inventory(global_root),
        "regionalBefore": webp_inventory(regional_root),
        "retainedWebp": len(retained_webp_hashes(global_root)),
        "workspace": str(WORKSPACE_PATH),
    }
    if not args.apply:
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return 0

    with exclusive_global_lock(global_root):
        assert_no_live_download(global_root)
        assert_no_live_download(regional_root)
        backup, manifest = create_backup(global_root, regional_root)
        compact_global_database(global_root / "tiles.sqlite3")
        remove_global_detail(global_root)
        reset_regional_cache(regional_root)
        remove_stale_region_lock(global_root)
        os.sync()

        after = {
            "global": webp_inventory(global_root),
            "globalDatabaseRows": len(
                all_rows(global_root / "tiles.sqlite3")
            ),
            "regional": webp_inventory(regional_root),
            "workspaceSha256": sha256_file(WORKSPACE_PATH),
        }
        manifest["completedAt"] = utc_now()
        manifest["after"] = after
        manifest["removed"] = {
            "globalFiles": (
                manifest["before"]["global"]["files"]
                - after["global"]["files"]
            ),
            "globalBytes": (
                manifest["before"]["global"]["bytes"]
                - after["global"]["bytes"]
            ),
            "regionalFiles": manifest["before"]["regional"]["files"],
            "regionalBytes": manifest["before"]["regional"]["bytes"],
        }
        write_json(backup / "manifest.json", manifest)

    print(
        json.dumps(
            {
                "status": "complete",
                "backup": str(backup),
                **manifest["after"],
                "removed": manifest["removed"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
