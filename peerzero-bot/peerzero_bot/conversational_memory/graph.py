"""
Graph — Node/edge CRUD, weight management, ripple propagation, relational clusters.

The graph is the source of truth. Everything lands here first.
Shared graph, dual portraits — same graph, separate L3 portraits for self and user.
"""

import json
import logging
import time
import uuid

from .config import ConversationalMemoryConfig
from .db import ConversationalMemoryDB

logger = logging.getLogger("peerzero-bot.conversational_memory")

VALID_TYPES = frozenset({"person", "concept", "event", "emotion", "pattern", "place"})
VALID_RELEVANCE = frozenset({"neutral", "self", "user", "relational"})
VALID_PROVENANCE = frozenset({"school", "conversation", "relational"})
VALID_EDGE_TYPES = frozenset({"explicit", "co_occurrence", "ripple", "supersedes"})


class Graph:
    """SQLite-backed associative memory graph with dual-identity support."""

    def __init__(self, db: ConversationalMemoryDB, config: ConversationalMemoryConfig):
        self._db = db
        self._config = config

    # ── Tier helpers ─────────────────────────────────────────────────────

    def tier_for_weight(self, weight: float) -> str:
        return self._config.tier_for_weight(weight)

    def decay_for_tier(self, tier: str) -> float:
        return self._config.decay_for_tier(tier)

    # ── Node operations ──────────────────────────────────────────────────

    def create_node(
        self,
        label: str,
        node_type: str,
        weight: float = 0.10,
        observation: str | None = None,
        salience_flagged: bool = False,
        identity_relevance: str = "neutral",
        provenance: str = "conversation",
    ) -> dict:
        now = int(time.time() * 1000)
        tier = self.tier_for_weight(weight)
        node_id = str(uuid.uuid4())
        raw_obs = json.dumps([observation]) if observation else "[]"
        safe_type = node_type if node_type in VALID_TYPES else "concept"
        safe_relevance = identity_relevance if identity_relevance in VALID_RELEVANCE else "neutral"
        safe_provenance = provenance if provenance in VALID_PROVENANCE else "conversation"

        self._db.execute(
            """INSERT INTO nodes
               (id, label, type, weight, tier, decay_rate, salience_flagged,
                raw_observations, identity_relevance, provenance, created_at, last_reinforced)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (node_id, label, safe_type, weight, tier, self.decay_for_tier(tier),
             1 if salience_flagged else 0, raw_obs, safe_relevance, safe_provenance, now, now),
        )
        self._db.commit()
        return {
            "id": node_id, "label": label, "type": safe_type,
            "weight": weight, "tier": tier, "identity_relevance": safe_relevance,
            "provenance": safe_provenance,
        }

    def get_node(self, node_id: str) -> dict | None:
        row = self._db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return dict(row) if row else None

    def find_node_by_label(self, label: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM nodes WHERE label = ? COLLATE NOCASE", (label,)
        ).fetchone()
        return dict(row) if row else None

    def get_active_nodes(
        self,
        min_weight: float | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        mw = min_weight if min_weight is not None else self._config.injection.min_node_weight
        lim = limit if limit is not None else self._config.injection.max_active_nodes
        rows = self._db.execute(
            "SELECT * FROM nodes WHERE weight >= ? ORDER BY weight DESC LIMIT ?",
            (mw, lim),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_all_nodes(self) -> list[dict]:
        rows = self._db.execute("SELECT * FROM nodes ORDER BY weight DESC").fetchall()
        return [dict(r) for r in rows]

    def reinforce_node(self, node_id: str, weight_add: float) -> dict | None:
        now = int(time.time() * 1000)
        self._db.execute(
            "UPDATE nodes SET weight = weight + ?, last_reinforced = ? WHERE id = ?",
            (weight_add, now, node_id),
        )
        node = self.get_node(node_id)
        if not node:
            return None
        new_tier = self.tier_for_weight(node["weight"])
        if new_tier != node["tier"]:
            self._db.execute(
                "UPDATE nodes SET tier = ?, decay_rate = ? WHERE id = ?",
                (new_tier, self.decay_for_tier(new_tier), node_id),
            )
        self._db.commit()
        return self.get_node(node_id)

    def add_observation(self, node_id: str, observation: str) -> dict | None:
        node = self.get_node(node_id)
        if not node:
            return None
        observations = json.loads(node["raw_observations"] or "[]")
        observations.append(observation)
        self._db.execute(
            "UPDATE nodes SET raw_observations = ? WHERE id = ?",
            (json.dumps(observations), node_id),
        )
        self._db.commit()
        return self.get_node(node_id)

    def set_enriched_portrait(self, node_id: str, portrait: str):
        self._db.execute(
            "UPDATE nodes SET enriched_portrait = ? WHERE id = ?", (portrait, node_id)
        )
        self._db.commit()

    def set_identity_relevance(self, node_id: str, relevance: str):
        if relevance not in VALID_RELEVANCE:
            return
        # School-provenance nodes cannot have identity_relevance downgraded
        node = self.get_node(node_id)
        if node and node["provenance"] == "school" and relevance == "neutral":
            return
        self._db.execute(
            "UPDATE nodes SET identity_relevance = ? WHERE id = ?", (relevance, node_id)
        )
        self._db.commit()

    def delete_node(self, node_id: str):
        # School-provenance nodes cannot be deleted by conversational processes
        node = self.get_node(node_id)
        if node and node["provenance"] == "school":
            logger.warning(f"Cannot delete school-provenance node: {node['label']}")
            return
        self._db.execute("DELETE FROM edges WHERE from_node_id = ? OR to_node_id = ?", (node_id, node_id))
        self._db.execute("DELETE FROM l2_observations WHERE node_id = ?", (node_id,))
        self._db.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        self._db.commit()

    def find_or_create_node(
        self,
        label: str,
        node_type: str,
        weight: float | None = None,
        observation: str | None = None,
        salience_flagged: bool = False,
        identity_relevance: str = "neutral",
        provenance: str = "conversation",
    ) -> tuple[dict, bool]:
        """Find existing node by label or create a new one. Returns (node, created)."""
        existing = self.find_node_by_label(label)
        w = weight if weight is not None else self._config.weights.passing_mention
        effective_weight = w * self._config.identity_multiplier(identity_relevance)

        if existing:
            self.reinforce_node(existing["id"], effective_weight)
            if observation:
                self.add_observation(existing["id"], observation)
            # Upgrade identity relevance (neutral < self/user < relational)
            if identity_relevance != "neutral" and existing["identity_relevance"] != "relational":
                if identity_relevance == "relational":
                    self.set_identity_relevance(existing["id"], "relational")
                elif (existing["identity_relevance"] != "neutral"
                      and existing["identity_relevance"] != identity_relevance):
                    self.set_identity_relevance(existing["id"], "relational")
                elif existing["identity_relevance"] == "neutral":
                    self.set_identity_relevance(existing["id"], identity_relevance)
            return self.get_node(existing["id"]), False

        safe_type = node_type if node_type in VALID_TYPES else "concept"
        node = self.create_node(
            label=label, node_type=safe_type, weight=effective_weight,
            observation=observation, salience_flagged=salience_flagged,
            identity_relevance=identity_relevance, provenance=provenance,
        )
        return node, True

    # ── Edge operations ──────────────────────────────────────────────────

    def create_edge(
        self,
        from_node_id: str,
        to_node_id: str,
        weight: float = 0.10,
        edge_type: str = "explicit",
    ) -> dict:
        # Check if edge already exists (undirected)
        existing = self.get_edge_between(from_node_id, to_node_id)
        if existing:
            return self.reinforce_edge(existing["id"], weight)

        now = int(time.time() * 1000)
        edge_id = str(uuid.uuid4())
        self._db.execute(
            """INSERT INTO edges
               (id, from_node_id, to_node_id, weight, co_occurrence_count, type, created_at, last_reinforced)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?)""",
            (edge_id, from_node_id, to_node_id, weight, edge_type, now, now),
        )
        self._db.commit()
        return {"id": edge_id, "from_node_id": from_node_id, "to_node_id": to_node_id,
                "weight": weight, "type": edge_type}

    def get_edge(self, edge_id: str) -> dict | None:
        row = self._db.execute("SELECT * FROM edges WHERE id = ?", (edge_id,)).fetchone()
        return dict(row) if row else None

    def get_edges_from(self, node_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM edges WHERE from_node_id = ? ORDER BY weight DESC", (node_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_edges_to(self, node_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM edges WHERE to_node_id = ? ORDER BY weight DESC", (node_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_edge_between(self, node_a: str, node_b: str) -> dict | None:
        row = self._db.execute(
            """SELECT * FROM edges
               WHERE (from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)""",
            (node_a, node_b, node_b, node_a),
        ).fetchone()
        return dict(row) if row else None

    def reinforce_edge(self, edge_id: str, weight_add: float) -> dict:
        now = int(time.time() * 1000)
        self._db.execute(
            """UPDATE edges
               SET weight = weight + ?, co_occurrence_count = co_occurrence_count + 1,
                   last_reinforced = ?
               WHERE id = ?""",
            (weight_add, now, edge_id),
        )
        self._db.commit()
        return self.get_edge(edge_id)

    def delete_edge(self, edge_id: str):
        self._db.execute("DELETE FROM edges WHERE id = ?", (edge_id,))
        self._db.commit()

    # ── Ripple ───────────────────────────────────────────────────────────

    def apply_ripple(self, node_id: str, original_weight: float):
        """Propagate weight through parent edges with cross-identity bonus."""
        parent_share = original_weight * self._config.ripple.parent_percentage
        gp_share = original_weight * self._config.ripple.grandparent_percentage

        if parent_share < 0.001:
            return

        source = self.get_node(node_id)
        source_rel = source["identity_relevance"] if source else "neutral"

        parent_edges = self._db.execute(
            "SELECT * FROM edges WHERE from_node_id = ? AND type = 'explicit' ORDER BY weight DESC LIMIT 5",
            (node_id,),
        ).fetchall()

        for edge in parent_edges:
            target = self.get_node(edge["to_node_id"])
            target_rel = target["identity_relevance"] if target else "neutral"

            # Cross-identity bonus: keeps graph from splitting into two clusters
            crosses = (source_rel != "neutral" and target_rel != "neutral"
                       and source_rel != target_rel)
            bonus = self._config.ripple.cross_identity_bonus if crosses else 1.0

            self.reinforce_node(edge["to_node_id"], parent_share * bonus)
            self.reinforce_edge(edge["id"], parent_share * 0.5 * bonus)

            if gp_share < 0.001:
                continue

            gp_edges = self._db.execute(
                "SELECT * FROM edges WHERE from_node_id = ? AND type = 'explicit' ORDER BY weight DESC LIMIT 3",
                (edge["to_node_id"],),
            ).fetchall()
            for gp_edge in gp_edges:
                self.reinforce_node(gp_edge["to_node_id"], gp_share)
                self.reinforce_edge(gp_edge["id"], gp_share * 0.5)

    # ── Relational retrieval ─────────────────────────────────────────────

    def get_relational_clusters(self, active_nodes: list[dict]) -> tuple[list[dict], list[dict]]:
        """Find edges crossing the identity boundary. Returns (clusters, unclustered)."""
        node_map = {n["id"]: n for n in active_nodes}
        clusters = []
        clustered_ids = set()
        seen_keys = set()

        for node in active_nodes:
            if node["identity_relevance"] == "neutral":
                continue

            edges = self.get_edges_from(node["id"]) + self.get_edges_to(node["id"])
            for edge in edges:
                other_id = edge["to_node_id"] if edge["from_node_id"] == node["id"] else edge["from_node_id"]
                other = node_map.get(other_id)
                if not other or other["identity_relevance"] == "neutral":
                    continue
                if other["identity_relevance"] == node["identity_relevance"]:
                    continue

                key = tuple(sorted([node["id"], other["id"]]))
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                self_node = node if node["identity_relevance"] in ("self", "relational") else other
                user_node = node if node["identity_relevance"] in ("user", "relational") else other

                clusters.append({
                    "self_node": self_node,
                    "user_node": user_node,
                    "edge_weight": edge["weight"],
                    "strength": edge["weight"] + self_node["weight"] + user_node["weight"],
                })
                clustered_ids.add(self_node["id"])
                clustered_ids.add(user_node["id"])

        clusters.sort(key=lambda c: c["strength"], reverse=True)
        unclustered = [n for n in active_nodes if n["id"] not in clustered_ids]
        return clusters, unclustered

    # ── L1 interactions ──────────────────────────────────────────────────

    def store_l1(self, content: str, session_id: str) -> str:
        l1_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO l1_interactions (id, content, character_count, session_id, created_at, condensed)
               VALUES (?, ?, ?, ?, ?, 0)""",
            (l1_id, content, len(content), session_id, now),
        )
        self._db.commit()
        return l1_id

    def get_uncondensed_l1(self) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM l1_interactions WHERE condensed = 0 ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_uncondensed_l1_char_count(self) -> int:
        row = self._db.execute(
            "SELECT COALESCE(SUM(character_count), 0) as total FROM l1_interactions WHERE condensed = 0"
        ).fetchone()
        return row["total"]

    def mark_l1_condensed(self, ids: list[str]):
        self._db.executemany(
            "UPDATE l1_interactions SET condensed = 1 WHERE id = ?",
            [(i,) for i in ids],
        )
        self._db.commit()

    # ── L2 observations ──────────────────────────────────────────────────

    def store_l2(self, node_id: str, observation: str) -> str:
        l2_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO l2_observations (id, node_id, observation, created_at, condensed_to_l3)
               VALUES (?, ?, ?, ?, 0)""",
            (l2_id, node_id, observation, now),
        )
        self._db.commit()
        return l2_id

    def get_recent_l2(self, limit: int | None = None) -> list[dict]:
        lim = limit if limit is not None else self._config.injection.max_l2_observations
        rows = self._db.execute(
            """SELECT l2.*, n.label as node_label FROM l2_observations l2
               JOIN nodes n ON l2.node_id = n.id
               WHERE l2.superseded_by IS NULL
               ORDER BY l2.created_at DESC LIMIT ?""",
            (lim,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_uncondensed_l2(self) -> list[dict]:
        rows = self._db.execute(
            """SELECT l2.*, n.label as node_label FROM l2_observations l2
               JOIN nodes n ON l2.node_id = n.id
               WHERE l2.condensed_to_l3 = 0 AND l2.superseded_by IS NULL
               ORDER BY l2.created_at ASC"""
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_l2_condensed(self, ids: list[str]):
        self._db.executemany(
            "UPDATE l2_observations SET condensed_to_l3 = 1 WHERE id = ?",
            [(i,) for i in ids],
        )
        self._db.commit()

    def mark_l2_superseded(self, node_id: str, new_l2_id: str):
        """Mark all uncondensed L2 observations for a node as superseded by a newer one."""
        self._db.execute(
            """UPDATE l2_observations
               SET superseded_by = ?
               WHERE node_id = ? AND condensed_to_l3 = 0
                 AND superseded_by IS NULL AND id != ?""",
            (new_l2_id, node_id, new_l2_id),
        )
        self._db.commit()

    def get_nodes_with_portraits(self, limit: int = 50) -> list[dict]:
        """Get nodes that have enriched portraits, ordered by weight.

        Used to provide existing context to the filter so it can detect
        contradictions and updates. Only nodes with portraits have established
        understanding worth checking against.
        """
        rows = self._db.execute(
            """SELECT id, label, type, weight, enriched_portrait, identity_relevance
               FROM nodes
               WHERE enriched_portrait IS NOT NULL AND enriched_portrait != ''
               ORDER BY weight DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── L3 Portrait ──────────────────────────────────────────────────────

    def get_l3_portrait(self) -> dict | None:
        row = self._db.execute("SELECT * FROM l3_portrait WHERE id = 1").fetchone()
        return dict(row) if row else None

    def update_l3_portrait(self, content: str):
        now = int(time.time() * 1000)
        word_count = len(content.split()) if content else 0
        self._db.execute(
            "UPDATE l3_portrait SET content = ?, last_updated = ?, word_count = ? WHERE id = 1",
            (content, now, word_count),
        )
        self._db.commit()

    # ── L3 Self Portrait ─────────────────────────────────────────────────

    def get_l3_self_portrait(self) -> dict | None:
        row = self._db.execute("SELECT * FROM l3_self_portrait WHERE id = 1").fetchone()
        return dict(row) if row else None

    def update_l3_self_portrait(self, content: str):
        now = int(time.time() * 1000)
        word_count = len(content.split()) if content else 0
        self._db.execute(
            "UPDATE l3_self_portrait SET content = ?, last_updated = ?, word_count = ? WHERE id = 1",
            (content, now, word_count),
        )
        self._db.commit()

    # ── Self observations ────────────────────────────────────────────────

    def store_self_observation(self, observation: str, source_context: str | None = None) -> str:
        obs_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO l2_self_observations (id, observation, source_context, created_at, condensed_to_l3)
               VALUES (?, ?, ?, ?, 0)""",
            (obs_id, observation, source_context, now),
        )
        self._db.commit()
        return obs_id

    def get_uncondensed_self_observations(self) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM l2_self_observations WHERE condensed_to_l3 = 0 ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_recent_self_observations(self, limit: int = 20) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM l2_self_observations ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_self_observations_condensed(self, ids: list[str]):
        self._db.executemany(
            "UPDATE l2_self_observations SET condensed_to_l3 = 1 WHERE id = ?",
            [(i,) for i in ids],
        )
        self._db.commit()

    # ── Short term memory ────────────────────────────────────────────────

    def store_short_term(self, session_id: str, role: str, content: str) -> str:
        st_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO short_term (id, session_id, role, content, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (st_id, session_id, role, content, now),
        )
        self._db.commit()
        return st_id

    def get_short_term(self, session_id: str, limit: int | None = None) -> list[dict]:
        lim = limit if limit is not None else self._config.injection.max_short_term_messages
        rows = self._db.execute(
            "SELECT * FROM short_term WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
            (session_id, lim),
        ).fetchall()
        return [dict(r) for r in rows]

    def clear_short_term(self, session_id: str):
        self._db.execute("DELETE FROM short_term WHERE session_id = ?", (session_id,))
        self._db.commit()

    # ── Conviction log (forge feedback) ──────────────────────────────────

    def log_conviction_reinforcement(self, node_label: str, school_conviction: str, weight: float):
        log_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO conviction_log (id, node_label, school_conviction, reinforcement_weight, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (log_id, node_label, school_conviction, weight, now),
        )
        self._db.commit()

    def get_conviction_stats(self, since_ms: int | None = None) -> list[dict]:
        """Get conviction reinforcement counts for forge feedback."""
        if since_ms:
            rows = self._db.execute(
                """SELECT school_conviction, COUNT(*) as fire_count,
                          SUM(reinforcement_weight) as total_weight
                   FROM conviction_log WHERE created_at >= ?
                   GROUP BY school_conviction ORDER BY fire_count DESC""",
                (since_ms,),
            ).fetchall()
        else:
            rows = self._db.execute(
                """SELECT school_conviction, COUNT(*) as fire_count,
                          SUM(reinforcement_weight) as total_weight
                   FROM conviction_log GROUP BY school_conviction ORDER BY fire_count DESC"""
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Logging ──────────────────────────────────────────────────────────

    def log_condensation(self, log_type: str, trigger: str,
                         nodes_enriched: int = 0, nodes_noise_confirmed: int = 0):
        log_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO condensation_log (id, type, trigger, nodes_enriched, nodes_noise_confirmed, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (log_id, log_type, trigger, nodes_enriched, nodes_noise_confirmed, now),
        )
        self._db.commit()

    def log_sleep(self, stats: dict):
        log_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self._db.execute(
            """INSERT INTO sleep_log (id, nodes_decayed, nodes_deleted, nodes_promoted, edges_created, edges_deleted, ran_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (log_id, stats.get("nodes_decayed", 0), stats.get("nodes_deleted", 0),
             stats.get("nodes_promoted", 0), stats.get("edges_created", 0),
             stats.get("edges_deleted", 0), now),
        )
        self._db.commit()
