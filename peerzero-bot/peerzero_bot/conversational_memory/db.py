"""
Conversational Memory Database — SQLite schema, initialization, and helpers.

Each bot-user pair gets its own encrypted SQLite database file.
Graph operations are frequent small transactions — exactly what SQLite excels at.
"""

import logging
import os
import sqlite3
import stat
from pathlib import Path

logger = logging.getLogger("peerzero-bot.conversational_memory")

_SCHEMA = """
-- Nodes: people, concepts, events, emotions, patterns, places
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('person','concept','event','emotion','pattern','place')),
    weight REAL NOT NULL DEFAULT 0.10,
    tier TEXT NOT NULL DEFAULT 'ephemeral' CHECK(tier IN ('ephemeral','pattern','significant','permanent')),
    decay_rate REAL NOT NULL DEFAULT 0.10,
    salience_flagged INTEGER DEFAULT 0,
    raw_observations TEXT DEFAULT '[]',
    enriched_portrait TEXT DEFAULT NULL,
    identity_relevance TEXT DEFAULT 'neutral' CHECK(identity_relevance IN ('neutral','self','user','relational')),
    provenance TEXT DEFAULT 'conversation' CHECK(provenance IN ('school','conversation','relational')),
    created_at INTEGER NOT NULL,
    last_reinforced INTEGER NOT NULL
);

-- Edges: connections between nodes
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0.10,
    co_occurrence_count INTEGER DEFAULT 1,
    type TEXT DEFAULT 'explicit' CHECK(type IN ('explicit','co_occurrence','ripple')),
    created_at INTEGER NOT NULL,
    last_reinforced INTEGER NOT NULL,
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- L1 Raw Interactions
CREATE TABLE IF NOT EXISTS l1_interactions (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    character_count INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    condensed INTEGER DEFAULT 0
);

-- L2 Behavioral Observations
CREATE TABLE IF NOT EXISTS l2_observations (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    observation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    condensed_to_l3 INTEGER DEFAULT 0,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- L3 Felt Portrait (single living document — understanding of the user)
CREATE TABLE IF NOT EXISTS l3_portrait (
    id INTEGER PRIMARY KEY DEFAULT 1,
    content TEXT,
    last_updated INTEGER,
    word_count INTEGER
);

-- L3 Self Portrait (single living document — relational self-model)
CREATE TABLE IF NOT EXISTS l3_self_portrait (
    id INTEGER PRIMARY KEY DEFAULT 1,
    content TEXT,
    last_updated INTEGER,
    word_count INTEGER
);

-- L2 Self Observations (what the bot discovers about itself through conversation)
CREATE TABLE IF NOT EXISTS l2_self_observations (
    id TEXT PRIMARY KEY,
    observation TEXT NOT NULL,
    source_context TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    condensed_to_l3 INTEGER DEFAULT 0
);

-- Short Term Memory (current session)
CREATE TABLE IF NOT EXISTS short_term (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','bot')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Conviction Reinforcement Log (tracks which school convictions fire in conversation)
CREATE TABLE IF NOT EXISTS conviction_log (
    id TEXT PRIMARY KEY,
    node_label TEXT NOT NULL,
    school_conviction TEXT NOT NULL,
    reinforcement_weight REAL NOT NULL,
    created_at INTEGER NOT NULL
);

-- Condensation Log
CREATE TABLE IF NOT EXISTS condensation_log (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    trigger TEXT NOT NULL,
    nodes_enriched INTEGER DEFAULT 0,
    nodes_noise_confirmed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Sleep Log
CREATE TABLE IF NOT EXISTS sleep_log (
    id TEXT PRIMARY KEY,
    nodes_decayed INTEGER DEFAULT 0,
    nodes_deleted INTEGER DEFAULT 0,
    nodes_promoted INTEGER DEFAULT 0,
    edges_created INTEGER DEFAULT 0,
    edges_deleted INTEGER DEFAULT 0,
    ran_at INTEGER NOT NULL
);

-- Indexes for fast graph traversal
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight);
CREATE INDEX IF NOT EXISTS idx_nodes_weight ON nodes(weight);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_provenance ON nodes(provenance);
CREATE INDEX IF NOT EXISTS idx_l1_condensed ON l1_interactions(condensed);
CREATE INDEX IF NOT EXISTS idx_l1_session ON l1_interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_l2_node ON l2_observations(node_id);
CREATE INDEX IF NOT EXISTS idx_l2_condensed ON l2_observations(condensed_to_l3);
CREATE INDEX IF NOT EXISTS idx_l2_self_condensed ON l2_self_observations(condensed_to_l3);
CREATE INDEX IF NOT EXISTS idx_short_term_session ON short_term(session_id);
CREATE INDEX IF NOT EXISTS idx_conviction_log_label ON conviction_log(node_label);

-- Ensure L3 portrait rows exist
INSERT OR IGNORE INTO l3_portrait (id, content, last_updated, word_count)
VALUES (1, NULL, NULL, 0);

INSERT OR IGNORE INTO l3_self_portrait (id, content, last_updated, word_count)
VALUES (1, NULL, NULL, 0);
"""


class ConversationalMemoryDB:
    """SQLite database for a single bot-user conversational memory."""

    def __init__(self, db_path: str, encryption_key: str = ""):
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: sqlite3.Connection | None = None
        self._encryption_key = encryption_key

    def connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn

        self._conn = sqlite3.connect(str(self._db_path), timeout=10.0)
        self._conn.row_factory = sqlite3.Row

        # Set file permissions (owner-only)
        try:
            self._db_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass

        # Apply encryption if configured
        if self._encryption_key:
            try:
                # Use parameterized form to prevent SQL injection via key contents
                self._conn.execute("PRAGMA key=?", (self._encryption_key,))
            except sqlite3.OperationalError:
                logger.debug("SQLite encryption not available — continuing unencrypted")

        # Performance pragmas
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA mmap_size = 67108864")  # 64MB mmap (was 256MB — reduced to prevent memory exhaustion at scale)

        self._conn.executescript(_SCHEMA)
        return self._conn

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            return self.connect()
        return self._conn

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, params)

    def executemany(self, sql: str, params_seq) -> sqlite3.Cursor:
        return self.conn.executemany(sql, params_seq)

    def commit(self):
        self.conn.commit()

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    def reset(self):
        """Clear all data — used for testing only."""
        c = self.conn
        c.executescript("""
            DELETE FROM short_term;
            DELETE FROM condensation_log;
            DELETE FROM sleep_log;
            DELETE FROM conviction_log;
            DELETE FROM l2_observations;
            DELETE FROM l2_self_observations;
            DELETE FROM l1_interactions;
            DELETE FROM edges;
            DELETE FROM nodes;
            UPDATE l3_portrait SET content = NULL, last_updated = NULL, word_count = 0 WHERE id = 1;
            UPDATE l3_self_portrait SET content = NULL, last_updated = NULL, word_count = 0 WHERE id = 1;
        """)
        logger.info("Conversational memory database reset complete")
