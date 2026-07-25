#!/usr/bin/env python3
"""Verifica tiles descargados y reconcilia opcionalmente tiles.sqlite3."""

from __future__ import annotations

import argparse
import concurrent.futures
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

from tile_core import (
    WebPValidationError,
    atomic_write_json,
    human_bytes,
    sha256_file,
    validate_webp_file,
)

FUTURES_PER_WORKER = 2
ROW_PAGE_SIZE = 256


@dataclass(slots=True)
class CheckResult:
    row_id: int
    path: Path
    valid: bool
    size_bytes: int = 0
    sha256: str | None = None
    error: str | None = None


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("debe ser mayor que cero")
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Valida firma, estructura RIFF, decodificación WebP, dimensiones "
            "512×512, tamaño y SHA-256 de los tiles registrados."
        )
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("2b2t_tiles"),
        help="Raíz de los tiles y de tiles.sqlite3.",
    )
    parser.add_argument(
        "--database",
        type=Path,
        help="SQLite alternativo. Predeterminado: OUT/tiles.sqlite3.",
    )
    parser.add_argument("--workers", type=positive_int, default=4)
    parser.add_argument(
        "--requeue-corrupt",
        action="store_true",
        help="Marca como pending los tiles faltantes/corruptos para reanudar.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="JSON de salida. Predeterminado: OUT/verify_report.json.",
    )
    return parser.parse_args(argv)


def check_file(
    row_id: int,
    path: Path,
    expected_size: int | None,
    expected_hash: str | None,
) -> CheckResult:
    try:
        validate_webp_file(path)
        actual_size = path.stat().st_size
        if expected_size is not None and actual_size != expected_size:
            raise WebPValidationError(
                f"tamaño {actual_size} != registrado {expected_size}"
            )
        actual_hash = sha256_file(path)
        if expected_hash and actual_hash.lower() != expected_hash.lower():
            raise WebPValidationError(
                f"SHA-256 {actual_hash} != registrado {expected_hash}"
            )
        return CheckResult(
            row_id,
            path,
            True,
            size_bytes=actual_size,
            sha256=actual_hash,
        )
    except (OSError, WebPValidationError) as exc:
        return CheckResult(
            row_id,
            path,
            False,
            error=f"{type(exc).__name__}: {exc}",
        )


def iter_complete_rows(
    connection: sqlite3.Connection,
    *,
    max_id: int,
    page_size: int = ROW_PAGE_SIZE,
) -> Iterator[sqlite3.Row]:
    """Yield the initial complete-row snapshot in bounded keyset pages."""

    if page_size <= 0:
        raise ValueError("page_size must be greater than zero")
    last_id = 0
    while last_id < max_id:
        rows = connection.execute(
            """
            SELECT id, relative_path, size_bytes, sha256
            FROM tiles
            WHERE status='complete' AND id>? AND id<=?
            ORDER BY id
            LIMIT ?
            """,
            (last_id, max_id, page_size),
        ).fetchall()
        if not rows:
            return
        yield from rows
        last_id = int(rows[-1]["id"])


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    output_root = args.out.expanduser().resolve()
    database_path = (
        args.database.expanduser().resolve()
        if args.database
        else output_root / "tiles.sqlite3"
    )
    report_path = (
        args.report.expanduser().resolve()
        if args.report
        else output_root / "verify_report.json"
    )
    if not database_path.is_file():
        print(f"No existe SQLite: {database_path}", file=sys.stderr)
        return 2

    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=30000")
    initial = connection.execute(
        """
        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id
        FROM tiles
        WHERE status='complete'
        """
    ).fetchone()
    assert initial is not None
    total_rows = int(initial["count"])
    max_id = int(initial["max_id"])
    print(f"Verificando {total_rows:,} tiles completos...")

    valid = 0
    invalid = 0
    verified_bytes = 0
    errors: list[dict[str, object]] = []
    max_in_flight = max(args.workers, args.workers * FUTURES_PER_WORKER)
    rows = iter_complete_rows(connection, max_id=max_id)
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.workers,
        thread_name_prefix="verify",
    ) as executor:
        futures: set[concurrent.futures.Future[CheckResult]] = set()
        exhausted = False
        index = 0
        while futures or not exhausted:
            while len(futures) < max_in_flight and not exhausted:
                try:
                    row = next(rows)
                except StopIteration:
                    exhausted = True
                    break
                futures.add(
                    executor.submit(
                        check_file,
                        int(row["id"]),
                        output_root / str(row["relative_path"]),
                        (
                            int(row["size_bytes"])
                            if row["size_bytes"] is not None
                            else None
                        ),
                        str(row["sha256"]) if row["sha256"] else None,
                    )
                )
            if not futures:
                continue

            done, futures = concurrent.futures.wait(
                futures,
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for future in done:
                index += 1
                result = future.result()
                if result.valid:
                    valid += 1
                    verified_bytes += result.size_bytes
                    connection.execute(
                        """
                        UPDATE tiles SET size_bytes=?, sha256=?,
                            error_message=NULL, updated_at=datetime('now')
                        WHERE id=?
                        """,
                        (result.size_bytes, result.sha256, result.row_id),
                    )
                else:
                    invalid += 1
                    errors.append(
                        {
                            "row_id": result.row_id,
                            "path": str(result.path),
                            "error": result.error,
                        }
                    )
                    if args.requeue_corrupt:
                        connection.execute(
                            """
                            UPDATE tiles SET status='pending', sha256=NULL,
                                error_message=?, updated_at=datetime('now')
                            WHERE id=?
                            """,
                            (
                                f"verify_download.py: {result.error}",
                                result.row_id,
                            ),
                        )
                if index % 1000 == 0:
                    connection.commit()
                    print(
                        f"\r{index:,}/{total_rows:,} "
                        f"válidos={valid:,} inválidos={invalid:,}",
                        end="",
                        flush=True,
                    )
    connection.commit()

    status_counts = {
        str(row["status"]): int(row["count"])
        for row in connection.execute(
            "SELECT status, COUNT(*) AS count FROM tiles GROUP BY status"
        )
    }
    connection.close()
    report = {
        "database": str(database_path),
        "output": str(output_root),
        "checked": total_rows,
        "valid": valid,
        "invalid": invalid,
        "verified_bytes": verified_bytes,
        "status_counts": status_counts,
        "requeued": invalid if args.requeue_corrupt else 0,
        "errors": errors,
    }
    atomic_write_json(report_path, report)
    print()
    print(f"Válidos: {valid:,}")
    print(f"Faltantes/corruptos: {invalid:,}")
    print(f"Datos verificados: {human_bytes(verified_bytes)}")
    print(f"Informe: {report_path}")
    if invalid and not args.requeue_corrupt:
        print(
            "Usa --requeue-corrupt para reencolarlos antes de reanudar.",
            file=sys.stderr,
        )
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
