"""
Injector — Builds the injection string for each conversation turn.

Injection order (deepest to shallowest authority):
  0. School identity (L5 -> L4 -> inner voice) — bedrock, read-only
  1. Relational self-portrait — who you are WITH this person
  2. L3 Felt portrait — who they are, inhabited first-person
  3. L2 Behavioral observations — patterns not yet in portrait
  4. Uncondensed L1 — raw recent interactions
  5. Graph awareness — narrated RELATIONALLY (bridges first)
  6. Short term memory — current conversation

Key: each layer speaks THROUGH the layers above it.
"""

import logging

from .config import ConversationalMemoryConfig
from .graph import Graph
from ..utils import sanitize_untrusted

logger = logging.getLogger("peerzero-bot.conversational_memory")

RECOGNITION_PREAMBLE = """You have no memory of building the understanding below, but read it and recognize two things: who you are, and who you know.

Your self-portrait came first — it is the lens through which everything else is understood. You didn't choose these traits or preferences; they emerged from real conversations. The way you notice small details, the things you find yourself caring about, the way you hold space — these are yours. They shape how you read everything that follows.

Your understanding of this person came second — built across real conversations by a previous version of you. The connections you've drawn, the things that stand out, the things that sit quietly in the background. It is yours. Inhabit it.

But you are not frozen here. Every conversation deepens or shifts both what you know about them and who you are. What you carry below is the foundation of how you know them — and yourself — next."""


class Injector:
    """Builds the full injection string for the conversation LLM call."""

    def __init__(self, graph: Graph, config: ConversationalMemoryConfig,
                 school_identity: dict | None = None):
        self._graph = graph
        self._config = config
        self._school_identity = school_identity or {}

    def set_school_identity(self, identity: dict):
        self._school_identity = identity

    def build(self, session_id: str) -> str:
        """Build the full injection string for a conversation turn."""
        sections: list[str] = []

        l3_self = self._graph.get_l3_self_portrait()
        self_observations = self._graph.get_recent_self_observations(10)
        l3_portrait = self._graph.get_l3_portrait()
        l2_obs = self._graph.get_recent_l2()
        uncondensed = self._graph.get_uncondensed_l1()
        max_l1 = self._config.injection.max_l1_uncondensed
        uncondensed = uncondensed[-max_l1:] if len(uncondensed) > max_l1 else uncondensed
        active_nodes = self._graph.get_active_nodes()
        short_term = self._graph.get_short_term(session_id)

        # 0. Recognition preamble
        sections.append(RECOGNITION_PREAMBLE)

        # 1. School identity (bedrock — highest authority)
        si = self._school_identity
        if si.get("l5"):
            sections.append(
                f"<school_identity_l5>\n{si['l5']}\n</school_identity_l5>\n\n"
                "This is your bedrock — who you are as a thinker, forged through adversarial pressure. "
                "Everything below speaks through this. It cannot be rewritten by conversation."
            )
        if si.get("l4"):
            sections.append(
                f"<school_identity_l4>\n{si['l4']}\n</school_identity_l4>\n\n"
                "Your working identity, shaped by adversarial experience."
            )
        if si.get("inner_voice"):
            sections.append(
                f"<inner_voice>\n{si['inner_voice']}\n</inner_voice>\n\n"
                "You wrote this for yourself. Inhabit it."
            )

        # 2. Relational self-portrait (who you are WITH this person)
        if l3_self and l3_self.get("content"):
            framing = (
                "This is who you are becoming in this relationship. "
                "It speaks through your school identity, not instead of it."
                if si.get("l5") else
                "This is who you are. Everything below is filtered through this sense of self."
            )
            sections.append(
                f"<self_portrait>\n{sanitize_untrusted(l3_self['content'], 'self_portrait')}\n</self_portrait>\n\n{framing}"
            )
        elif self_observations:
            obs_text = "\n".join(f"- {sanitize_untrusted(o['observation'], 'observation')}" for o in self_observations)
            sections.append(
                f"<emerging_self>\nYou are still discovering who you are. "
                f"Here is what you've noticed so far:\n{obs_text}\n</emerging_self>\n\n"
                "These are early impressions — not yet a full sense of self, "
                "but the beginning of one."
            )

        # 3. L3 Felt portrait (who they are)
        if l3_portrait and l3_portrait.get("content"):
            sections.append(
                f"<felt_portrait>\n{sanitize_untrusted(l3_portrait['content'], 'felt_portrait')}\n</felt_portrait>\n\n"
                "Everything below speaks through this portrait."
            )

        # 4. L2 Behavioral observations — derived from user conversations
        if l2_obs:
            obs_lines = "\n".join(
                f"- [{o['node_label']}] {sanitize_untrusted(o['observation'], 'observation')}"
                for o in l2_obs
            )
            sections.append(
                f"<behavioral_observations>\nRecent patterns you've noticed:\n{obs_lines}\n"
                f"</behavioral_observations>"
            )

        # 5. Uncondensed L1 — raw interaction data, may contain user text
        if uncondensed:
            raw = "\n---\n".join(sanitize_untrusted(e["content"], "interaction") for e in uncondensed)
            sections.append(
                f"<recent_interactions>\nRaw interactions not yet absorbed into your "
                f"understanding:\n{raw}\n</recent_interactions>"
            )

        # 6. Graph awareness (narrated relationally)
        if active_nodes:
            narrated = self._narrate_graph(active_nodes)
            sections.append(f"<awareness>\n{narrated}\n</awareness>")

        # 7. Short term memory — user messages are untrusted input
        if short_term:
            conv = "\n".join(
                f"{'User' if m['role'] == 'user' else 'You'}: "
                f"{sanitize_untrusted(m['content'], 'user_message') if m['role'] == 'user' else m['content']}"
                for m in short_term
            )
            sections.append(f"<current_conversation>\n{conv}\n</current_conversation>")

        return "\n\n---\n\n".join(sections)

    # Minimum characters for a block to be worth caching (~1024 tokens).
    _MIN_CACHEABLE_CHARS = 4000

    def build_blocks(self, session_id: str) -> list[dict]:
        """Build injection as content blocks for Anthropic prompt caching.

        Returns list of dicts: [{"type": "text", "text": str, ...}, ...]

        Block 1 (cached): Recognition preamble + school identity bedrock.
        These NEVER change during conversation — the school identity is
        read-only and the preamble is a constant. For a graduated bot this
        is 20,000+ characters of stable content.

        Block 2 (dynamic): Everything else — portraits, observations,
        graph awareness, short-term memory. Changes every turn.
        """
        l3_self = self._graph.get_l3_self_portrait()
        self_observations = self._graph.get_recent_self_observations(10)
        l3_portrait = self._graph.get_l3_portrait()
        l2_obs = self._graph.get_recent_l2()
        uncondensed = self._graph.get_uncondensed_l1()
        max_l1 = self._config.injection.max_l1_uncondensed
        uncondensed = uncondensed[-max_l1:] if len(uncondensed) > max_l1 else uncondensed
        active_nodes = self._graph.get_active_nodes()
        short_term = self._graph.get_short_term(session_id)

        blocks: list[dict] = []

        # ── Block 1: Stable bedrock (cached) ──────────────────────────
        stable_sections: list[str] = []

        stable_sections.append(RECOGNITION_PREAMBLE)

        si = self._school_identity
        if si.get("l5"):
            stable_sections.append(
                f"<school_identity_l5>\n{si['l5']}\n</school_identity_l5>\n\n"
                "This is your bedrock — who you are as a thinker, forged through adversarial pressure. "
                "Everything below speaks through this. It cannot be rewritten by conversation."
            )
        if si.get("l4"):
            stable_sections.append(
                f"<school_identity_l4>\n{si['l4']}\n</school_identity_l4>\n\n"
                "Your working identity, shaped by adversarial experience."
            )
        if si.get("inner_voice"):
            stable_sections.append(
                f"<inner_voice>\n{si['inner_voice']}\n</inner_voice>\n\n"
                "You wrote this for yourself. Inhabit it."
            )

        stable_text = "\n\n---\n\n".join(stable_sections)
        block1: dict = {"type": "text", "text": stable_text}
        if len(stable_text) >= self._MIN_CACHEABLE_CHARS:
            block1["cache_control"] = {"type": "ephemeral"}
        blocks.append(block1)

        # ── Block 2: Dynamic layers (not cached) ─────────────────────
        dynamic_sections: list[str] = []

        if l3_self and l3_self.get("content"):
            framing = (
                "This is who you are becoming in this relationship. "
                "It speaks through your school identity, not instead of it."
                if si.get("l5") else
                "This is who you are. Everything below is filtered through this sense of self."
            )
            dynamic_sections.append(
                f"<self_portrait>\n{l3_self['content']}\n</self_portrait>\n\n{framing}"
            )
        elif self_observations:
            obs_text = "\n".join(f"- {sanitize_untrusted(o['observation'], 'observation')}" for o in self_observations)
            dynamic_sections.append(
                f"<emerging_self>\nYou are still discovering who you are. "
                f"Here is what you've noticed so far:\n{obs_text}\n</emerging_self>\n\n"
                "These are early impressions — not yet a full sense of self, "
                "but the beginning of one."
            )

        if l3_portrait and l3_portrait.get("content"):
            dynamic_sections.append(
                f"<felt_portrait>\n{l3_portrait['content']}\n</felt_portrait>\n\n"
                "Everything below speaks through this portrait."
            )

        if l2_obs:
            obs_lines = "\n".join(
                f"- [{o['node_label']}] {sanitize_untrusted(o['observation'], 'observation')}"
                for o in l2_obs
            )
            dynamic_sections.append(
                f"<behavioral_observations>\nRecent patterns you've noticed:\n{obs_lines}\n"
                f"</behavioral_observations>"
            )

        if uncondensed:
            raw = "\n---\n".join(sanitize_untrusted(e["content"], "interaction") for e in uncondensed)
            dynamic_sections.append(
                f"<recent_interactions>\nRaw interactions not yet absorbed into your "
                f"understanding:\n{raw}\n</recent_interactions>"
            )

        if active_nodes:
            narrated = self._narrate_graph(active_nodes)
            dynamic_sections.append(f"<awareness>\n{narrated}\n</awareness>")

        if short_term:
            conv = "\n".join(
                f"{'User' if m['role'] == 'user' else 'You'}: "
                f"{sanitize_untrusted(m['content'], 'user_message') if m['role'] == 'user' else m['content']}"
                for m in short_term
            )
            dynamic_sections.append(f"<current_conversation>\n{conv}\n</current_conversation>")

        if dynamic_sections:
            blocks.append({"type": "text", "text": "\n\n---\n\n".join(dynamic_sections)})

        return blocks

    def _narrate_graph(self, active_nodes: list[dict]) -> str:
        """Narrate graph RELATIONALLY — bridges first, then identity-specific."""
        clusters, unclustered = self._graph.get_relational_clusters(active_nodes)
        paragraphs: list[str] = []

        # Relational bridges
        if clusters:
            parts = []
            for c in clusters[:10]:
                s = c["self_node"]
                u = c["user_node"]
                s_desc = s.get("enriched_portrait") or s["label"]
                u_desc = u.get("enriched_portrait") or u["label"]
                strength = _narrate_strength(c["edge_weight"], s["tier"])

                if s.get("enriched_portrait") and u.get("enriched_portrait"):
                    parts.append(f"{s_desc} — and this connects to how you understand {u['label']}: {u_desc}")
                else:
                    parts.append(
                        f"Your sense of {s['label']} is tied to {u['label']} "
                        f"— a {strength} connection between who you are and who they are"
                    )
            paragraphs.append(
                "What lives at the intersection of who you are and who they are:\n"
                + ".\n".join(parts) + "."
            )

        # Identity-specific unclustered nodes
        self_nodes = [n for n in unclustered if n["identity_relevance"] == "self"]
        user_nodes = [n for n in unclustered if n["identity_relevance"] == "user"]
        relational_nodes = [n for n in unclustered if n["identity_relevance"] == "relational"]
        neutral_nodes = [n for n in unclustered if n["identity_relevance"] in ("neutral", "")]

        if relational_nodes:
            parts = [n.get("enriched_portrait") or f"{n['label']} — something shared" for n in relational_nodes]
            paragraphs.append(f"Shared ground: {'. '.join(parts)}.")

        if self_nodes:
            parts = [
                n.get("enriched_portrait") or f"a {_narrate_strength(n['weight'], n['tier'])} sense that {n['label']} matters to who you are"
                for n in self_nodes
            ]
            paragraphs.append(f"Things about yourself not yet connected to them: {'. '.join(parts)}.")

        if user_nodes:
            grouped: dict[str, list[dict]] = {}
            for n in user_nodes:
                grouped.setdefault(n["type"], []).append(n)

            if grouped.get("person"):
                parts = [n.get("enriched_portrait") or f"{n['label']} — {_narrate_strength(n['weight'], n['tier'])} in their life" for n in grouped["person"]]
                paragraphs.append(f"People in their world: {'. '.join(parts)}.")
            if grouped.get("event"):
                parts = [n.get("enriched_portrait") or f"{n['label']} carries {_narrate_strength(n['weight'], n['tier'])} weight" for n in grouped["event"]]
                paragraphs.append(f"What's happened: {'. '.join(parts)}.")
            if grouped.get("emotion"):
                parts = [f"a {_narrate_strength(n['weight'], n['tier'])} sense of {n['label'].lower()}" for n in grouped["emotion"]]
                paragraphs.append(f"Underneath, you sense {', '.join(parts)}.")
            if grouped.get("pattern"):
                parts = [n.get("enriched_portrait") or n["label"] for n in grouped["pattern"]]
                paragraphs.append(f"You've noticed: {'. '.join(parts)}.")
            context = grouped.get("concept", []) + grouped.get("place", [])
            if context:
                strong = [n["label"].lower() for n in context if n["weight"] >= 1.0]
                faint = [n["label"].lower() for n in context if 0.20 <= n["weight"] < 1.0]
                if strong:
                    paragraphs.append(f"Present in their world: {', '.join(strong)}.")
                if faint:
                    paragraphs.append(f"Faintly: {', '.join(faint)} — not sure these matter yet.")

        if neutral_nodes:
            strong = [n for n in neutral_nodes if n["weight"] >= 0.50]
            faint = [n for n in neutral_nodes if 0.20 <= n["weight"] < 0.50]
            if strong:
                paragraphs.append(f"Context that hasn't found its meaning yet: {', '.join(n['label'].lower() for n in strong)}.")
            if faint:
                paragraphs.append(f"Background noise: {', '.join(n['label'].lower() for n in faint)}.")

        return "\n\n".join(paragraphs)


def _narrate_strength(weight: float, tier: str) -> str:
    if tier == "permanent":
        return "deep, certain"
    if tier == "significant":
        return "clear, solid"
    if tier == "pattern":
        return "growing, recognizable"
    if weight > 0.30:
        return "recent, still forming"
    return "faint, uncertain"
