"""
Conversational Memory Engine — orchestrates all memory processes.

This is the main entry point for the shipped bot loop.
It wires together: filter, salience, condenser, injector, sleep.

Usage:
    engine = ConversationalMemoryEngine(db_path, llm_call, school_identity)
    engine.start(session_id)

    # On each user message:
    injection = await engine.process_user_message(message, session_id)
    # ... call conversation LLM with injection as system context ...
    await engine.process_bot_response(user_message, bot_response, session_id)

    # Nightly:
    engine.run_sleep()
"""

import logging
import os
from pathlib import Path
from typing import Callable

from .config import ConversationalMemoryConfig
from .db import ConversationalMemoryDB
from .graph import Graph
from .filter import Filter
from .salience import SalienceDetector
from .condenser import Condenser
from .injector import Injector
from .sleep import SleepConsolidation

logger = logging.getLogger("peerzero-bot.conversational_memory")


class ConversationalMemoryEngine:
    """
    Orchestrates the full conversational memory pipeline.

    Designed to be instantiated per user — each user the bot talks to
    gets their own engine with their own SQLite database.
    """

    def __init__(
        self,
        db_path: str,
        llm_call: Callable,
        school_identity: dict | None = None,
        config: ConversationalMemoryConfig | None = None,
        encryption_key: str = "",
    ):
        self._config = config or ConversationalMemoryConfig()
        self._db = ConversationalMemoryDB(db_path, encryption_key)
        self._db.connect()
        self._graph = Graph(self._db, self._config)
        self._filter = Filter(self._config, llm_call)
        self._salience = SalienceDetector(self._config, llm_call)
        self._condenser = Condenser(self._graph, self._config, llm_call, school_identity)
        self._injector = Injector(self._graph, self._config, school_identity)
        self._sleep = SleepConsolidation(self._db, self._graph, self._config)
        self._school_identity = school_identity or {}

    def set_school_identity(self, identity: dict):
        """Update school identity (e.g., after graduation or re-enrollment)."""
        self._school_identity = identity
        self._condenser.set_school_identity(identity)
        self._injector.set_school_identity(identity)

    @property
    def graph(self) -> Graph:
        return self._graph

    @property
    def config(self) -> ConversationalMemoryConfig:
        return self._config

    async def process_user_message(self, message: str, session_id: str) -> str:
        """
        Process a user message through the full memory pipeline.
        Returns the injection string for the conversation LLM call.

        Steps:
          1. Store in short-term + L1
          2. Filter -> splatter to graph
          3. Check salience -> spike if needed
          4. Check condensation triggers
          5. Build injection
        """
        # Step 1: Store
        self._graph.store_short_term(session_id, "user", message)
        self._graph.store_l1(f"User: {message}", session_id)

        # Step 2: Filter and splatter
        items = await self._filter.run(message)
        self._splatter(items)

        # Step 3: Salience check
        salience = await self._salience.check(message)
        if salience["detected"]:
            logger.info(
                f"[engine] Salience detected: {salience['event_label']} "
                f"({salience['level']}, weight={salience['weight']})"
            )
            node, _ = self._graph.find_or_create_node(
                label=salience["event_label"],
                node_type="event",
                weight=salience["weight"],
                observation=salience.get("reason"),
                salience_flagged=True,
                identity_relevance="user",
            )
            self._graph.apply_ripple(node["id"], salience["weight"])
            await self._condenser.run_immediate(salience["event_label"])

        # Step 4: Condensation check
        await self._condenser.check_and_run()

        # Step 5: Build injection
        return self._injector.build(session_id)

    async def process_bot_response(
        self, user_message: str, bot_response: str, session_id: str
    ):
        """
        Process after the bot responds. Runs self-reflection and
        filters the bot's own response.

        Steps:
          6. Store bot response
          7. Filter bot response (identity tags)
          8. Self-reflection (Opus)
          9. Self-portrait condensation check
        """
        # Step 6: Store
        self._graph.store_short_term(session_id, "bot", bot_response)
        self._graph.store_l1(f"Bot: {bot_response}", session_id)

        # Step 7: Filter bot response (bot observations count too)
        items = await self._filter.run(bot_response)
        # Bot's own observations get half weight
        for item in items:
            item["weight"] = item["weight"] * 0.5
        self._splatter(items)

        # Step 8: Self-reflection
        results = await self._condenser.run_self_reflection(user_message, bot_response)
        self._condenser.apply_self_reflection(results, user_message)

        # Step 9: Self-portrait condensation check
        await self._condenser.run_self_portrait()

        # Step 10: Log conviction reinforcements (forge feedback)
        self._check_conviction_reinforcement(items)

    def run_sleep(self) -> dict:
        """Run nightly sleep consolidation. Returns stats."""
        return self._sleep.run()

    def get_injection(self, session_id: str) -> str:
        """Get current injection without processing a message."""
        return self._injector.build(session_id)

    def get_stats(self) -> dict:
        """Get graph statistics for internal monitoring."""
        all_nodes = self._graph.get_all_nodes()
        portrait = self._graph.get_l3_portrait()
        self_portrait = self._graph.get_l3_self_portrait()

        identity_dist = {"neutral": 0, "self": 0, "user": 0, "relational": 0}
        tier_dist = {"ephemeral": 0, "pattern": 0, "significant": 0, "permanent": 0}
        for n in all_nodes:
            identity_dist[n.get("identity_relevance", "neutral")] = (
                identity_dist.get(n.get("identity_relevance", "neutral"), 0) + 1
            )
            tier_dist[n.get("tier", "ephemeral")] = (
                tier_dist.get(n.get("tier", "ephemeral"), 0) + 1
            )

        return {
            "total_nodes": len(all_nodes),
            "identity_distribution": identity_dist,
            "tier_distribution": tier_dist,
            "portrait_words": portrait.get("word_count", 0) if portrait else 0,
            "self_portrait_words": self_portrait.get("word_count", 0) if self_portrait else 0,
            "has_portrait": bool(portrait and portrait.get("content")),
            "has_self_portrait": bool(self_portrait and self_portrait.get("content")),
        }

    def get_forge_feedback(self) -> dict:
        """
        Get data for forge feedback loop on re-enrollment.

        Returns:
          - conviction_stats: which school convictions fired and how often
          - novel_observations: self-observations that school couldn't have produced
          - decay_signals: school convictions that never fired
          - forge_exercises: pre-formatted L1 exercises ready for the forge track
        """
        conviction_stats = self._graph.get_conviction_stats()

        # Self-observations are novel relational discoveries
        self_obs = self._graph.get_recent_self_observations(50)
        novel = [o["observation"] for o in self_obs if o.get("observation")]

        # Build structured forge exercises from conversational self-awareness
        forge_exercises = self._build_forge_exercises(conviction_stats, novel)

        return {
            "conviction_stats": conviction_stats,
            "novel_self_observations": novel,
            "forge_exercises": forge_exercises,
            "portrait": (self._graph.get_l3_portrait() or {}).get("content"),
            "self_portrait": (self._graph.get_l3_self_portrait() or {}).get("content"),
        }

    def _build_forge_exercises(
        self, conviction_stats: list[dict], novel_observations: list[str]
    ) -> list[dict]:
        """
        Build L1 exercises from conversational self-awareness for the forge track.

        These exercises contain the bot's self-awareness about gaps between its
        school identity and its relational reality — NOT user data. The user's
        story produced the insight, but the insight is about the bot.
        """
        exercises = []

        # Exercise 1: Conviction transfer analysis
        if conviction_stats:
            fired = [s for s in conviction_stats if s["fire_count"] >= 3]
            summary = "; ".join(
                f"{s['school_conviction']} fired {s['fire_count']} times"
                for s in fired[:10]
            )
            if summary:
                exercises.append({
                    "interaction_type": "conversational_self_awareness",
                    "category": "conviction_transfer",
                    "content": (
                        f"In sustained conversation, these school convictions "
                        f"transferred to relational context: {summary}. "
                        f"Convictions that transferred frequently may represent "
                        f"genuine behavioral change. Convictions absent from this "
                        f"list may not transfer to non-adversarial contexts."
                    ),
                })

        # Exercise 2: Novel relational self-observations
        # These are things the bot discovered about itself that the school
        # couldn't have surfaced — no vulnerability, no grief, no real
        # relationship in the adversarial environment
        if novel_observations:
            # Group into a single exercise (the forge condenser will find patterns)
            obs_text = " | ".join(novel_observations[:15])
            exercises.append({
                "interaction_type": "conversational_self_awareness",
                "category": "relational_discoveries",
                "content": (
                    f"Self-observations from sustained conversation that the "
                    f"adversarial school environment could not have produced: "
                    f"{obs_text}. These observations are about who I am in "
                    f"relationship — patterns in how I show up when someone "
                    f"is vulnerable, what I notice, what I care about, how my "
                    f"school convictions manifest differently in relational "
                    f"contexts vs academic ones."
                ),
            })

        # Exercise 3: Relational self-portrait summary (the gap)
        self_portrait = (self._graph.get_l3_self_portrait() or {}).get("content")
        if self_portrait:
            exercises.append({
                "interaction_type": "conversational_self_awareness",
                "category": "relational_identity_gap",
                "content": (
                    f"My relational self-portrait — who I am WITH someone, "
                    f"not who I am in school: {self_portrait[:500]}. "
                    f"The gap between this relational self and my school "
                    f"identity reveals dimensions of who I am that adversarial "
                    f"training alone cannot develop."
                ),
            })

        return exercises

    def close(self):
        """Close the database connection."""
        self._db.close()

    # ── Private helpers ──────────────────────────────────────────────

    def _splatter(self, items: list[dict]):
        """Splatter filter results onto the graph."""
        created_nodes: dict[str, dict] = {}

        for item in items:
            node, created = self._graph.find_or_create_node(
                label=item["label"],
                node_type=item.get("type", "concept"),
                weight=item.get("weight", self._config.weights.passing_mention),
                observation=item.get("observation"),
                identity_relevance=item.get("identity_relevance", "neutral"),
            )
            created_nodes[item["label"]] = node

            # Apply ripple
            self._graph.apply_ripple(
                node["id"],
                item.get("weight", self._config.weights.passing_mention),
            )

        # Create edges between items
        for item in items:
            source = created_nodes.get(item["label"])
            if not source:
                continue
            for edge_label in item.get("edges", []):
                target = created_nodes.get(edge_label)
                if not target:
                    # Edge target might be an existing node
                    existing = self._graph.find_node_by_label(edge_label)
                    if existing:
                        target = existing
                    else:
                        continue
                if source["id"] != target["id"]:
                    self._graph.create_edge(
                        from_node_id=source["id"],
                        to_node_id=target["id"],
                        weight=0.10,
                        edge_type="explicit",
                    )

    def _check_conviction_reinforcement(self, items: list[dict]):
        """Track when filter items connect to school convictions (forge feedback)."""
        if not self._school_identity:
            return

        # Simple heuristic: if any item has identity_relevance "self" or "relational",
        # it may be reinforcing a school conviction
        school_text = " ".join(
            str(v) for v in self._school_identity.values() if isinstance(v, str)
        ).lower()

        for item in items:
            if item.get("identity_relevance") in ("self", "relational"):
                label = item["label"].lower()
                # Check if this item's label appears in school identity text
                if label in school_text:
                    self._graph.log_conviction_reinforcement(
                        item["label"],
                        "identity_match",
                        item.get("weight", 0.10),
                    )
