"""
Sleep Consolidation — nightly maintenance cycle (pure math, no LLM calls).

1. Decay all weights (tier-specific rates)
2. Delete zero-weight nodes/edges
3. Promote/demote tiers
4. Create co-occurrence edges
5. Prune redundant paths
6. Flag potential merges
"""

import logging
import time

from .config import ConversationalMemoryConfig
from .graph import Graph
from .db import ConversationalMemoryDB

logger = logging.getLogger("peerzero-bot.conversational_memory")


class SleepConsolidation:
    """Nightly consolidation — pure math, no LLM calls."""

    def __init__(self, db: ConversationalMemoryDB, graph: Graph,
                 config: ConversationalMemoryConfig):
        self._db = db
        self._graph = graph
        self._config = config

    def run(self) -> dict:
        """Run the full sleep consolidation cycle. Returns stats."""
        stats = {
            "nodes_decayed": 0,
            "nodes_deleted": 0,
            "nodes_orphaned": 0,
            "nodes_promoted": 0,
            "edges_created": 0,
            "edges_deleted": 0,
        }

        logger.info("[sleep] Starting sleep consolidation cycle...")
        conn = self._db.conn

        # ── 1. Decay ─────────────────────────────────────────────
        for tier_name, tier_cfg in self._config.tiers.items():
            cursor = conn.execute(
                "UPDATE nodes SET weight = weight - ? WHERE tier = ? AND weight > 0",
                (tier_cfg.decay, tier_name),
            )
            stats["nodes_decayed"] += cursor.rowcount

        # Decay edges (ephemeral rate — edges are fragile)
        conn.execute(
            "UPDATE edges SET weight = weight - ? WHERE weight > 0",
            (self._config.tiers["ephemeral"].decay,),
        )

        # ── 2. Delete zero-weight ────────────────────────────────
        cursor = conn.execute("DELETE FROM edges WHERE weight <= 0")
        stats["edges_deleted"] += cursor.rowcount

        # Preserve salience-flagged permanent nodes
        cursor = conn.execute(
            "DELETE FROM nodes WHERE weight <= 0 "
            "AND NOT (salience_flagged = 1 AND tier = 'permanent') "
            "AND provenance != 'school'"
        )
        stats["nodes_deleted"] += cursor.rowcount

        # Clean orphaned L2 observations
        conn.execute(
            "DELETE FROM l2_observations WHERE node_id NOT IN (SELECT id FROM nodes)"
        )

        # ── 2b. Delete orphan nodes (no remaining edges for N days) ─
        # A node whose every connecting edge has decayed away is isolated —
        # nothing links to it, nothing links from it. If it's been orphaned
        # long enough (orphan_ttl_days), it served its time and should go.
        orphan_ttl_ms = self._config.sleep.orphan_ttl_days * 24 * 60 * 60 * 1000
        cutoff = int(time.time() * 1000) - orphan_ttl_ms
        cursor = conn.execute(
            """DELETE FROM nodes WHERE id IN (
                SELECT n.id FROM nodes n
                LEFT JOIN edges e1 ON n.id = e1.from_node_id
                LEFT JOIN edges e2 ON n.id = e2.to_node_id
                WHERE e1.id IS NULL AND e2.id IS NULL
                  AND n.last_reinforced < ?
                  AND n.provenance != 'school'
                  AND NOT (n.salience_flagged = 1 AND n.tier = 'permanent')
            )""",
            (cutoff,),
        )
        stats["nodes_orphaned"] += cursor.rowcount
        if cursor.rowcount > 0:
            # Clean L2 observations for orphaned nodes
            conn.execute(
                "DELETE FROM l2_observations WHERE node_id NOT IN (SELECT id FROM nodes)"
            )

        # ── 3. Tier promotion/demotion ───────────────────────────
        rows = conn.execute("SELECT id, weight, tier FROM nodes").fetchall()
        tier_order = ["ephemeral", "pattern", "significant", "permanent"]

        for row in rows:
            correct = self._graph.tier_for_weight(row["weight"])
            if correct != row["tier"]:
                conn.execute(
                    "UPDATE nodes SET tier = ?, decay_rate = ? WHERE id = ?",
                    (correct, self._graph.decay_for_tier(correct), row["id"]),
                )
                if tier_order.index(correct) > tier_order.index(row["tier"]):
                    stats["nodes_promoted"] += 1

        # ── 4. Co-occurrence edges ───────────────────────────────
        day_ago = int(time.time() * 1000) - (24 * 60 * 60 * 1000)

        session_nodes = conn.execute(
            "SELECT DISTINCT id, label FROM nodes WHERE last_reinforced >= ?",
            (day_ago,),
        ).fetchall()

        node_list = [dict(r) for r in session_nodes]
        for i in range(len(node_list)):
            for j in range(i + 1, len(node_list)):
                existing = self._graph.get_edge_between(node_list[i]["id"], node_list[j]["id"])
                if existing:
                    conn.execute(
                        "UPDATE edges SET co_occurrence_count = co_occurrence_count + 1, "
                        "weight = weight + ?, last_reinforced = ? WHERE id = ?",
                        (self._config.co_occurrence.initial_weight,
                         int(time.time() * 1000), existing["id"]),
                    )
                else:
                    self._graph.create_edge(
                        from_node_id=node_list[i]["id"],
                        to_node_id=node_list[j]["id"],
                        weight=self._config.co_occurrence.initial_weight,
                        edge_type="co_occurrence",
                    )
                    stats["edges_created"] += 1

        # ── 5. Redundancy pruning ────────────────────────────────
        if self._config.sleep.redundancy_pruning:
            strong_paths = conn.execute(
                """SELECT e1.from_node_id as a, e1.to_node_id as b, e2.to_node_id as c,
                          e1.weight as ab_weight, e2.weight as bc_weight
                   FROM edges e1
                   JOIN edges e2 ON e1.to_node_id = e2.from_node_id
                   WHERE e1.weight > 1.0 AND e2.weight > 1.0"""
            ).fetchall()

            for path in strong_paths:
                direct = self._graph.get_edge_between(path["a"], path["c"])
                if direct and direct["weight"] < min(path["ab_weight"], path["bc_weight"]):
                    conn.execute(
                        "UPDATE edges SET weight = weight * 0.8 WHERE id = ?",
                        (direct["id"],),
                    )

        # ── 6. Merge detection (flag only) ───────────────────────
        if self._config.sleep.merge_detection:
            candidates = conn.execute(
                """SELECT n1.id as id1, n1.label as label1, n2.id as id2, n2.label as label2,
                          e.co_occurrence_count, e.weight as edge_weight
                   FROM edges e
                   JOIN nodes n1 ON e.from_node_id = n1.id
                   JOIN nodes n2 ON e.to_node_id = n2.id
                   WHERE n1.type = n2.type
                     AND e.co_occurrence_count >= 5
                     AND e.weight >= 2.0
                   ORDER BY e.co_occurrence_count DESC LIMIT 10"""
            ).fetchall()

            for c in candidates:
                logger.info(
                    f'[sleep] Merge candidate: "{c["label1"]}" <-> "{c["label2"]}" '
                    f'(co-occurrence: {c["co_occurrence_count"]}, edge: {c["edge_weight"]:.2f})'
                )

        # ── 7. Prune log tables (keep most recent 500 rows each) ───
        _LOG_ROW_CAP = 500
        for table in ("conviction_log", "condensation_log", "sleep_log"):
            try:
                count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                if count > _LOG_ROW_CAP:
                    conn.execute(
                        f"DELETE FROM {table} WHERE rowid NOT IN "
                        f"(SELECT rowid FROM {table} ORDER BY rowid DESC LIMIT ?)",
                        (_LOG_ROW_CAP,),
                    )
            except Exception:
                pass  # Table may not exist in older schemas

        conn.commit()
        self._graph.log_sleep(stats)

        logger.info(
            f"[sleep] Cycle complete: decayed={stats['nodes_decayed']} "
            f"deleted={stats['nodes_deleted']} orphaned={stats['nodes_orphaned']} "
            f"promoted={stats['nodes_promoted']} "
            f"edges_created={stats['edges_created']} edges_deleted={stats['edges_deleted']}"
        )

        return stats
