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

from .integrity import compute_hmac, verify_hmac

logger = logging.getLogger("peerzero-bot.memory")

# Size limits for deserialization safety
_WARN_SIZE = 1 * 1024 * 1024     # 1 MB — log a warning
_MAX_SIZE = 10 * 1024 * 1024     # 10 MB — refuse to load


class SqliteStorage:
    """SQLite-backed storage implementation."""

    def __init__(self, base_dir: str, hmac_key: bytes = b""):
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._base.chmod(stat.S_IRWXU)
        self._hmac_key = hmac_key

        self._db_path = self._base / "memory.db"
        self._conn = sqlite3.connect(str(self._db_path), timeout=30.0)
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA busy_timeout = 30000")
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

        # Add hmac column if it doesn't exist (migration for existing DBs)
        try:
            self._conn.execute("SELECT hmac FROM memory LIMIT 0")
        except sqlite3.OperationalError:
            self._conn.execute("ALTER TABLE memory ADD COLUMN hmac TEXT DEFAULT ''")
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
            "SELECT data, hmac FROM memory WHERE namespace = ? AND key = ?",
            (namespace, key),
        ).fetchone()
        if row is None:
            return default

        data_str, stored_hmac = row[0], (row[1] or "")

        # Verify HMAC if key is configured
        if self._hmac_key and stored_hmac:
            if not verify_hmac(self._hmac_key, data_str, stored_hmac):
                logger.warning(
                    f"Memory integrity check failed for {namespace}/{key} — possible tampering"
                )

        try:
            return json.loads(data_str)
        except json.JSONDecodeError:
            return default

    def write(self, namespace: str, key: str, data):
        serialized = json.dumps(data, default=str)
        hmac_hex = compute_hmac(self._hmac_key, serialized) if self._hmac_key else ""
        self._conn.execute(
            "INSERT OR REPLACE INTO memory (namespace, key, data, hmac) VALUES (?, ?, ?, ?)",
            (namespace, key, serialized, hmac_hex),
        )
        self._conn.commit()

    def append(self, namespace: str, key: str, entry: dict, max_entries: int = 0):
        with self._conn:
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
        try:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception as e:
            logger.warning(f"[memory] WAL checkpoint failed on close: {e}")
        self._conn.close()
