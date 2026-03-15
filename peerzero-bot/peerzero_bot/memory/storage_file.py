"""
File-backed storage — JSON files with restricted permissions.

Each namespace gets its own subdirectory.
Each key gets its own JSON file.
All files are owner-only (0o600).
"""

import json
import stat
from pathlib import Path


class FileStorage:
    """File-backed storage implementation."""

    def __init__(self, base_dir: str):
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._base.chmod(stat.S_IRWXU)

    def _path(self, namespace: str, key: str) -> Path:
        ns_dir = self._base / namespace
        ns_dir.mkdir(parents=True, exist_ok=True)
        return ns_dir / f"{key}.json"

    def _read_raw(self, path: Path, default=None):
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return default

    def _write_raw(self, path: Path, data):
        path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def read(self, namespace: str, key: str, default=None):
        return self._read_raw(self._path(namespace, key), default)

    def write(self, namespace: str, key: str, data):
        self._write_raw(self._path(namespace, key), data)

    def append(self, namespace: str, key: str, entry: dict, max_entries: int = 0):
        path = self._path(namespace, key)
        items = self._read_raw(path, [])
        if not isinstance(items, list):
            items = []
        items.append(entry)
        if max_entries > 0 and len(items) > max_entries:
            items = items[-max_entries:]
        self._write_raw(path, items)

    def clear(self, namespace: str, key: str):
        path = self._path(namespace, key)
        if path.exists():
            self._write_raw(path, [])
