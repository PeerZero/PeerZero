"""
File-backed storage — JSON files with restricted permissions.

Each namespace gets its own subdirectory.
Each key gets its own JSON file.
All files are owner-only (0o600).

Thread safety: all read-modify-write operations use a per-path lock
to prevent concurrent writes from losing data.

⚠️ REVIEW NOTE (not a bug): This module IS thread-safe. Every write and
append operation acquires a per-path threading.Lock before reading or
writing the file. The _locks dict maps file paths to Lock objects, and
_locks_guard protects the _locks dict itself. This prevents data loss
from concurrent access within a single process. For multi-process safety,
use storage_sqlite.py instead (SQLite handles its own locking).
"""

import json
import logging
import stat
import threading
from pathlib import Path
from typing import Any

from .integrity import compute_hmac, verify_hmac

logger = logging.getLogger("peerzero-bot.memory")

# Size limits for deserialization safety
_WARN_SIZE = 1 * 1024 * 1024     # 1 MB — log a warning
_MAX_SIZE = 10 * 1024 * 1024     # 10 MB — refuse to load


class FileStorage:
    """File-backed storage implementation with thread-safe writes."""

    def __init__(self, base_dir: str, hmac_key: bytes = b""):
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._base.chmod(stat.S_IRWXU)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._hmac_key = hmac_key

    def _get_lock(self, path: Path) -> threading.Lock:
        """Get or create a per-path lock for thread-safe file access."""
        key = str(path)
        with self._locks_guard:
            if key not in self._locks:
                self._locks[key] = threading.Lock()
            return self._locks[key]

    def _path(self, namespace: str, key: str) -> Path:
        ns_dir = self._base / namespace
        ns_dir.mkdir(parents=True, exist_ok=True)
        return ns_dir / f"{key}.json"

    def _read_raw(self, path: Path, default: Any = None) -> Any:
        if not path.exists():
            return default
        try:
            size = path.stat().st_size
            if size > _MAX_SIZE:
                logger.error(
                    f"[MEMORY] File {path.name} is {size / 1024 / 1024:.1f} MB — "
                    f"exceeds {_MAX_SIZE / 1024 / 1024:.0f} MB safety limit. "
                    f"Refusing to load. This file may be corrupt."
                )
                return default
            if size > _WARN_SIZE:
                logger.warning(
                    f"[MEMORY] File {path.name} is {size / 1024:.0f} KB — "
                    f"approaching safety limit. Consider investigating."
                )
            content = path.read_text(encoding="utf-8")

            # Verify HMAC if key is configured
            if self._hmac_key:
                hmac_path = path.with_suffix(path.suffix + ".hmac")
                if hmac_path.exists():
                    try:
                        expected = hmac_path.read_text(encoding="utf-8").strip()
                        if not verify_hmac(self._hmac_key, content, expected):
                            logger.warning(
                                f"Memory integrity check failed for {path} — possible tampering"
                            )
                    except OSError:
                        logger.warning(
                            f"Memory integrity check failed for {path} — possible tampering"
                        )

            return json.loads(content)
        except (json.JSONDecodeError, OSError):
            return default

    def _write_raw(self, path: Path, data: Any) -> None:
        # SECURITY: Check serialized size before writing, matching the read-side
        # limits in _read_raw. This prevents unbounded memory file growth from
        # bugs or adversarial data accumulation.
        serialized = json.dumps(data, indent=2, default=str)
        size = len(serialized.encode("utf-8"))
        if size > _MAX_SIZE:
            logger.error(
                f"[MEMORY] Refusing to write {path.name} — serialized size "
                f"{size / 1024 / 1024:.1f} MB exceeds {_MAX_SIZE / 1024 / 1024:.0f} MB limit."
            )
            return
        if size > _WARN_SIZE:
            logger.warning(
                f"[MEMORY] Writing {path.name} at {size / 1024:.0f} KB — "
                f"approaching safety limit. Consider investigating."
            )
        path.write_text(serialized, encoding="utf-8")
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)

        # Write HMAC sidecar file for tamper detection
        if self._hmac_key:
            hmac_path = path.with_suffix(path.suffix + ".hmac")
            hmac_path.write_text(compute_hmac(self._hmac_key, serialized), encoding="utf-8")
            hmac_path.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def read(self, namespace: str, key: str, default: Any = None) -> Any:
        return self._read_raw(self._path(namespace, key), default)

    def write(self, namespace: str, key: str, data: Any) -> None:
        path = self._path(namespace, key)
        with self._get_lock(path):
            self._write_raw(path, data)

    def append(self, namespace: str, key: str, entry: dict, max_entries: int = 0) -> None:
        path = self._path(namespace, key)
        with self._get_lock(path):
            items = self._read_raw(path, [])
            if not isinstance(items, list):
                logger.warning(
                    f"Corrupt data in {path}: expected list, got {type(items).__name__}. Resetting to empty list."
                )
                items = []
            items.append(entry)
            if max_entries > 0 and len(items) > max_entries:
                items = items[-max_entries:]
            self._write_raw(path, items)

    def clear(self, namespace: str, key: str) -> None:
        path = self._path(namespace, key)
        with self._get_lock(path):
            if path.exists():
                self._write_raw(path, [])
