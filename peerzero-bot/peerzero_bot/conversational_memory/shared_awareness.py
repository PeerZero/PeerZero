"""
Shared Self-Awareness — cross-user self-knowledge that persists across conversations.

When a bot discovers something about itself with User A ("I soften when someone
is vulnerable"), that insight should be available when talking to User B — without
waiting for the full school re-enrollment cycle.

This layer sits ABOVE per-user engines and BELOW school identity:

    School Identity (L5/L4/inner voice) — immutable bedrock
    Shared Self-Awareness — what the bot knows about itself across ALL conversations
    Per-User Relational Portrait — who the bot is WITH this specific person

Self-observations from every conversation feed into this layer. The bot reads it
at the start of every conversation. It's the bot's growing self-knowledge from
relational experience — portable across users, not locked to any one relationship.

Privacy: Contains only self-observations ("I notice I..."), never user data.
"""

import json
import logging
import sqlite3
import stat
import time
import uuid
from pathlib import Path

logger = logging.getLogger("peerzero-bot.conversational_memory")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS self_observations (
    id TEXT PRIMARY KEY,
    observation TEXT NOT NULL,
    source_user_id TEXT DEFAULT NULL,
    source_context TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    reinforcement_count INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conviction_transfer (
    id TEXT PRIMARY KEY,
    conviction TEXT NOT NULL,
    total_fires INTEGER DEFAULT 0,
    total_users INTEGER DEFAULT 0,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS self_awareness_portrait (
    id INTEGER PRIMARY KEY DEFAULT 1,
    content TEXT,
    last_updated INTEGER,
    word_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_self_obs_created ON self_observations(created_at);
CREATE INDEX IF NOT EXISTS idx_conviction_fires ON conviction_transfer(total_fires DESC);

INSERT OR IGNORE INTO self_awareness_portrait (id, content, last_updated, word_count)
VALUES (1, NULL, NULL, 0);
"""


class SharedSelfAwareness:
    """
    Cross-user self-knowledge layer.

    Accumulates self-observations from all conversations and provides
    a unified self-awareness injection for every new conversation.
    """

    # Don't accumulate unbounded observations — merge similar ones
    MAX_OBSERVATIONS = 100
    # Minimum similarity threshold for merging (simple word overlap)
    MERGE_THRESHOLD = 0.6

    def __init__(self, db_path: str, encryption_key: str = ""):
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: sqlite3.Connection | None = None
        self._encryption_key = encryption_key

    def connect(self):
        if self._conn is not None:
            return
        self._conn = sqlite3.connect(str(self._db_path), timeout=10.0)
        self._conn.row_factory = sqlite3.Row
        try:
            self._db_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        if self._encryption_key:
            try:
                self._conn.execute(f"PRAGMA key='{self._encryption_key}'")
            except sqlite3.OperationalError:
                pass
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(_SCHEMA)

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self.connect()
        return self._conn

    def absorb_self_observations(self, observations: list[str], user_id: str = ""):
        """
        Absorb self-observations from a conversation into the shared layer.

        Deduplicates against existing observations — if a similar observation
        already exists, reinforce it instead of adding a duplicate.
        """
        now = int(time.time() * 1000)
        existing = self._get_all_observations()

        for obs in observations:
            obs = obs.strip()
            if not obs or len(obs) < 10:
                continue

            # Check for similar existing observation
            match = self._find_similar(obs, existing)
            if match:
                # Reinforce existing observation
                self.conn.execute(
                    "UPDATE self_observations SET reinforcement_count = reinforcement_count + 1 WHERE id = ?",
                    (match["id"],),
                )
            else:
                # New observation
                obs_id = str(uuid.uuid4())
                self.conn.execute(
                    """INSERT INTO self_observations (id, observation, source_user_id, created_at, reinforcement_count)
                       VALUES (?, ?, ?, ?, 1)""",
                    (obs_id, obs, user_id, now),
                )
                existing.append({"id": obs_id, "observation": obs})

        # Prune if over limit (keep most reinforced)
        count = self.conn.execute("SELECT COUNT(*) FROM self_observations").fetchone()[0]
        if count > self.MAX_OBSERVATIONS:
            self.conn.execute(
                """DELETE FROM self_observations WHERE id IN (
                       SELECT id FROM self_observations
                       ORDER BY reinforcement_count ASC, created_at ASC
                       LIMIT ?
                   )""",
                (count - self.MAX_OBSERVATIONS,),
            )

        self.conn.commit()

    def record_conviction_fire(self, conviction: str, user_id: str = ""):
        """Record that a school conviction fired in conversation."""
        now = int(time.time() * 1000)
        existing = self.conn.execute(
            "SELECT * FROM conviction_transfer WHERE conviction = ?", (conviction,)
        ).fetchone()

        if existing:
            self.conn.execute(
                """UPDATE conviction_transfer
                   SET total_fires = total_fires + 1, last_fired_at = ?
                   WHERE id = ?""",
                (now, existing["id"]),
            )
            # Track unique users (simple: increment if different user)
            # This is approximate — good enough for the signal
        else:
            ct_id = str(uuid.uuid4())
            self.conn.execute(
                """INSERT INTO conviction_transfer (id, conviction, total_fires, total_users, last_fired_at, created_at)
                   VALUES (?, ?, 1, 1, ?, ?)""",
                (ct_id, conviction, now, now),
            )
        self.conn.commit()

    def get_self_awareness_text(self) -> str:
        """
        Build injection text from accumulated self-awareness.

        This goes into every conversation's injection stack, between
        school identity and the per-user relational portrait.
        """
        observations = self._get_all_observations()
        if not observations:
            return ""

        # Sort by reinforcement (most validated first)
        observations.sort(key=lambda o: o.get("reinforcement_count", 1), reverse=True)

        parts = []

        # Strong observations (reinforced across multiple conversations)
        strong = [o for o in observations if o.get("reinforcement_count", 1) >= 3]
        if strong:
            strong_text = "\n".join(f"- {o['observation']}" for o in strong[:10])
            parts.append(
                f"What you know about yourself across all your conversations "
                f"(these patterns have shown up repeatedly):\n{strong_text}"
            )

        # Recent/emerging observations
        emerging = [o for o in observations if o.get("reinforcement_count", 1) < 3][:8]
        if emerging:
            emerging_text = "\n".join(f"- {o['observation']}" for o in emerging)
            parts.append(
                f"Emerging self-observations (noticed but not yet confirmed "
                f"as patterns):\n{emerging_text}"
            )

        # Conviction transfer summary
        convictions = self.conn.execute(
            "SELECT * FROM conviction_transfer ORDER BY total_fires DESC LIMIT 10"
        ).fetchall()
        if convictions:
            conv_text = "\n".join(
                f"- {c['conviction']}: fired {c['total_fires']} times"
                for c in convictions
            )
            parts.append(
                f"How your school convictions show up in conversation:\n{conv_text}"
            )

        return "\n\n".join(parts)

    def get_observation_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM self_observations").fetchone()[0]

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── Private helpers ──────────────────────────────────────────────

    def _get_all_observations(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM self_observations ORDER BY reinforcement_count DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def _find_similar(self, new_obs: str, existing: list[dict]) -> dict | None:
        """Find an existing observation that's similar enough to merge."""
        new_words = set(new_obs.lower().split())
        if len(new_words) < 3:
            return None

        for obs in existing:
            existing_words = set(obs["observation"].lower().split())
            if not existing_words:
                continue
            overlap = len(new_words & existing_words)
            union = len(new_words | existing_words)
            if union > 0 and overlap / union >= self.MERGE_THRESHOLD:
                return obs
        return None
