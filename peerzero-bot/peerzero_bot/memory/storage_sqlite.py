"""
SQLite-backed storage — more robust than file storage.

Single database file with namespace/key table.
ACID transactions prevent corruption from crashes.
Still uses owner-only file permissions.
"""

import json
import logging
import stat
import sqlite3
from pathlib import Path

logger = logging.getLogger("peerzero-bot.memory")

# Size limits for deserialization safety
_WARN_SIZE = 1 * 1024 * 1024     # 1 MB — log a warning
_MAX_SIZE = 10 * 1024 * 1024     # 10 MB — refuse to load


class SqliteStorage:
    """SQLite-backed storage implementation."""

    def __init__(self, base_dir: str):
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._base.chmod(stat.S_IRWXU)

        self._db_path = self._base / "memory.db"
        self._conn = sqlite3.connect(str(self._db_path), timeout=10.0)
        self._db_path.chmod(stat.S_IRUSR | stat.S_IWUSR)

        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS memory (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (namespace, key)
            )
        """)
        self._conn.commit()

    def read(self, namespace: str, key: str, default=None):
        # SECURITY: Check size BEFORE fetching the full blob to prevent OOM
        # from corrupted/malicious entries. LENGTH() is evaluated in SQLite
        # without loading the data into Python memory.
        size_row = self._conn.execute(
            "SELECT LENGTH(data) FROM memory WHERE namespace = ? AND key = ?",
            (namespace, key),
        ).fetchone()
        if size_row is None:
            return default
        size = size_row[0] or 0
        if size > _MAX_SIZE:
            logger.error(
                f"[MEMORY] Row {namespace}/{key} is {size / 1024 / 1024:.1f} MB — "
                f"exceeds {_MAX_SIZE / 1024 / 1024:.0f} MB safety limit. "
                f"Refusing to load. This row may be corrupt."
            )
            return default
        if size > _WARN_SIZE:
            logger.warning(
                f"[MEMORY] Row {namespace}/{key} is {size / 1024:.0f} KB — "
                f"approaching safety limit. Consider investigating."
            )
        row = self._conn.execute(
            "SELECT data FROM memory WHERE namespace = ? AND key = ?",
            (namespace, key),
        ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row[0])
        except json.JSONDecodeError:
            return default

    def write(self, namespace: str, key: str, data):
        self._conn.execute(
            "INSERT OR REPLACE INTO memory (namespace, key, data) VALUES (?, ?, ?)",
            (namespace, key, json.dumps(data, default=str)),
        )
        self._conn.commit()

    def append(self, namespace: str, key: str, entry: dict, max_entries: int = 0):
        items = self.read(namespace, key, [])
        if not isinstance(items, list):
            items = []
        items.append(entry)
        if max_entries > 0 and len(items) > max_entries:
            items = items[-max_entries:]
        self.write(namespace, key, items)

    def clear(self, namespace: str, key: str):
        self.write(namespace, key, [])

    def close(self):
        self._conn.close()
