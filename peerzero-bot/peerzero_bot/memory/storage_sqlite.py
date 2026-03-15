"""
SQLite-backed storage — more robust than file storage.

Single database file with namespace/key table.
ACID transactions prevent corruption from crashes.
Still uses owner-only file permissions.
"""

import json
import stat
import sqlite3
from pathlib import Path


class SqliteStorage:
    """SQLite-backed storage implementation."""

    def __init__(self, base_dir: str):
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._base.chmod(stat.S_IRWXU)

        self._db_path = self._base / "memory.db"
        self._conn = sqlite3.connect(str(self._db_path))
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
