"""Cross-process lock shared by every downloader for one tile library."""

from __future__ import annotations

import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
from typing import TextIO


REGION_DOWNLOAD_LOCK_NAME = ".region-download.lock"


class RegionDownloadLockedError(RuntimeError):
    """Raised when another downloader owns an output directory."""

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
            "ya hay una descarga activa para este directorio"
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
            raise RuntimeError("download lock is already acquired")

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
