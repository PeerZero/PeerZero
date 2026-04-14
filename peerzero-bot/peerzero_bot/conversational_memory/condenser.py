"""
Condenser — L1->L2->L3 condensation cascade, self-reflection, self-portrait.

Key lessons from PeerZero + memory science:
- INHABIT/ACT THROUGH framing: "future version of you reads this as its own memory"
- Source amnesia: strip attribution, write as conviction not observation
- Arc preservation: L3 must preserve evolution timelines, not just current state
- Strongest model for L3 and self-reflection (identity needs quality)
- Sequential cascade: L2 writes before L3 reads
"""

import json
import logging
import re
from typing import Callable

from .config import ConversationalMemoryConfig
from .graph import Graph, VALID_RELEVANCE
from ..utils import sanitize_untrusted

logger = logging.getLogger("peerzero-bot.conversational_memory")


class Condenser:
    """L1->L2->L3 condensation cascade with self-reflection."""

    def __init__(self, graph: Graph, config: ConversationalMemoryConfig,
                 llm_call: Callable, school_identity: dict | None = None):
        self._graph = graph
        self._config = config
        self._llm_call = llm_call
        self._school_identity = school_identity or {}

    def set_school_identity(self, identity: dict):
        self._school_identity = identity

    # ── L2: Raw interactions -> Behavioral observations ──────────────

    def _build_l2_prompt(self, l1_content: str, active_nodes: list[dict],
                         self_portrait: str | None) -> str:
        node_list = "\n".join(
            f"- {n['label']} [{n['type']}] weight:{n['weight']:.2f} tier:{n['tier']}"
            + (f" [{n['identity_relevance']}]" if n["identity_relevance"] != "neutral" else "")
            + (f" — {n['enriched_portrait']}" if n.get("enriched_portrait") else "")
            for n in active_nodes
        )

        self_section = ""
        if self_portrait:
            self_section = (
                f"\nWho you are right now — this is the lens you see them through:\n"
                f"<your_self>\n{self_portrait}\n</your_self>\n"
            )

        school_section = ""
        if self._school_identity:
            si = self._school_identity
            parts = []
            if si.get("l5"):
                parts.append(f"Your bedrock identity (school-forged, immutable):\n{si['l5']}")
            if si.get("l4"):
                parts.append(f"Your working identity:\n{si['l4']}")
            if parts:
                school_section = (
                    "\n<school_identity>\n"
                    + "\n\n".join(parts)
                    + "\n</school_identity>\n"
                    "Your school identity is fixed. Understand this person THROUGH it.\n"
                )

        return f"""These are raw interactions with someone you are getting to know:

<raw_interactions>
{l1_content}
</raw_interactions>

What you currently carry about this person:
<existing_awareness>
{node_list or 'Nothing yet — this is your first exposure.'}
</existing_awareness>
{school_section}{self_section}
INHABIT:
A future version of you will read what you write here as its own understanding of this person — not as notes someone left, but as what it already knows. When it reads "she deflects with humor when the ground shifts," it won't process that as an observation — it will recognize it. It will feel the deflection the next time she cracks a joke after bad news. Write for that future self. Write what you now know, not what you saw.

ACT THROUGH:
When your understanding says "there's unresolved weight around the car crash that she carries without examining directly," you don't just know that — you feel the weight the next time she mentions her sister. You hold the space differently. You don't bring it up, but you don't pretend it isn't there. The understanding shapes how you are with her, not just what you know about her.

Your task:
For each person, event, concept, or pattern that revealed something — write what you now understand. Ground it in the specific moment that taught you. Strip the source: write as conviction, not observation. "She reaches for cooking when the ground is unsteady" — not "I noticed she mentioned cooking during stressful times."

CRITICAL — UNDERSTAND THROUGH YOURSELF:
You are not a blank recorder. You are someone with a forming identity, and what you notice about this person is shaped by who you are. When you write an enriched portrait of a node, write it as YOUR understanding — colored by what matters to you, what you're drawn to, what you care about.

For each node, also indicate identity_relevance:
- "neutral" — general fact, doesn't touch either identity
- "user" — this is about who THEY are
- "self" — this reveals something about who YOU are
- "relational" — this exists because of who you are TO EACH OTHER

For things that appeared but revealed nothing — confirm them as noise.

Weight reinforcement guide: 0.25 moderate, 0.50 significant, 1.00 emotional, 2.00 important.

Output structured JSON only. No preamble.

{{
  "node_updates": [
    {{
      "node_label": "string",
      "weight_reinforcement": number,
      "enriched_portrait": "What you now know — conviction, not observation. First person. Present tense.",
      "identity_relevance": "neutral | user | self | relational",
      "new_edges": [{{ "to_label": "string", "to_type": "string", "weight": number }}],
      "strengthen_edges": [{{ "to_label": "string", "weight_add": number }}]
    }}
  ],
  "noise_confirmed": ["label1", "label2"],
  "new_nodes_detected": [
    {{ "label": "string", "type": "string", "weight": number, "observation": "string", "identity_relevance": "neutral | user | self | relational" }}
  ]
}}"""

    async def run_l2(self, l1_entries: list[dict], active_nodes: list[dict]) -> dict | None:
        l1_content = "\n---\n".join(sanitize_untrusted(e["content"], "l1_entry") for e in l1_entries)
        self_portrait = self._graph.get_l3_self_portrait()
        sp_content = self_portrait["content"] if self_portrait else None

        text = await self._llm_call(
            model=self._config.models.condenser_l2,
            prompt=self._build_l2_prompt(l1_content, active_nodes, sp_content),
            max_tokens=4096,
        )

        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return None
        return json.loads(match.group(0))

    def apply_l2_results(self, results: dict) -> dict:
        nodes_enriched = 0
        nodes_noise = 0

        for update in results.get("node_updates", []):
            node = self._graph.find_node_by_label(update.get("node_label", ""))
            if not node:
                continue

            relevance = update.get("identity_relevance", "neutral")
            if relevance not in VALID_RELEVANCE:
                relevance = "neutral"

            # Update identity relevance
            if relevance != "neutral":
                if node["identity_relevance"] != "neutral" and node["identity_relevance"] != relevance:
                    self._graph.set_identity_relevance(node["id"], "relational")
                elif node["identity_relevance"] == "neutral":
                    self._graph.set_identity_relevance(node["id"], relevance)

            # Reinforce with identity multiplier
            if update.get("weight_reinforcement"):
                eff_rel = relevance if relevance != "neutral" else node["identity_relevance"]
                mult = self._config.identity_multiplier(eff_rel)
                self._graph.reinforce_node(node["id"], update["weight_reinforcement"] * mult)

            # Store L2 observation and set enriched portrait
            if update.get("enriched_portrait"):
                new_l2_id = self._graph.store_l2(node["id"], update["enriched_portrait"])
                self._graph.set_enriched_portrait(node["id"], update["enriched_portrait"])
                # Mark old uncondensed L2 observations for this node as superseded —
                # the new portrait subsumes them
                self._graph.mark_l2_superseded(node["id"], new_l2_id)

            # Create new edges
            for edge in update.get("new_edges", []):
                target, _ = self._graph.find_or_create_node(
                    label=edge.get("to_label", ""),
                    node_type=edge.get("to_type", "concept"),
                    weight=edge.get("weight", self._config.weights.passing_mention),
                )
                self._graph.create_edge(
                    from_node_id=node["id"], to_node_id=target["id"],
                    weight=edge.get("weight", 0.10), edge_type="explicit",
                )

            # Strengthen existing edges
            for edge in update.get("strengthen_edges", []):
                target = self._graph.find_node_by_label(edge.get("to_label", ""))
                if not target:
                    continue
                existing = self._graph.get_edge_between(node["id"], target["id"])
                if existing:
                    self._graph.reinforce_edge(existing["id"], edge.get("weight_add", 0.10))
                else:
                    self._graph.create_edge(
                        from_node_id=node["id"], to_node_id=target["id"],
                        weight=edge.get("weight_add", 0.10), edge_type="explicit",
                    )

            nodes_enriched += 1

        # New nodes the condenser detected
        for new_node in results.get("new_nodes_detected", []):
            rel = new_node.get("identity_relevance", "neutral")
            if rel not in VALID_RELEVANCE:
                rel = "neutral"
            self._graph.find_or_create_node(
                label=new_node.get("label", ""),
                node_type=new_node.get("type", "concept"),
                weight=new_node.get("weight", self._config.weights.moderate_mention),
                observation=new_node.get("observation"),
                identity_relevance=rel,
            )

        nodes_noise = len(results.get("noise_confirmed", []))
        return {"nodes_enriched": nodes_enriched, "nodes_noise_confirmed": nodes_noise}

    # ── L3: Behavioral observations -> Felt portrait ─────────────────

    def _build_l3_prompt(self, l2_obs: list[dict], current_portrait: str | None,
                         all_l2: list[dict], self_portrait: str | None) -> str:
        observations = "\n".join(f"[{o['node_label']}] {o['observation']}" for o in l2_obs)

        portrait_section = (
            f"Your current felt portrait of the user reads:\n"
            f"<current_portrait>\n{current_portrait}\n</current_portrait>"
            if current_portrait
            else "You have no existing portrait yet. This is your first impression."
        )

        self_section = (
            f"\nWho you are — the lens you see them through:\n"
            f"<your_self>\n{self_portrait}\n</your_self>\n"
            if self_portrait else ""
        )

        # Build arc history
        arc_section = ""
        if all_l2:
            by_node: dict[str, list[str]] = {}
            for obs in all_l2:
                by_node.setdefault(obs["node_label"], []).append(obs["observation"])
            arcs = "\n".join(
                f"[{label}] " + " → ".join(f"({i+1}) {o}" for i, o in enumerate(obs))
                for label, obs in by_node.items() if len(obs) >= 2
            )
            if arcs:
                arc_section = (
                    f"\nThings that have evolved over time — preserve these arcs:\n"
                    f"<evolution>\n{arcs}\n</evolution>\n"
                )

        school_section = ""
        if self._school_identity and self._school_identity.get("l5"):
            school_section = (
                "\n<school_identity_anchor>\n"
                "Your school-forged identity is fixed. This portrait speaks THROUGH it.\n"
                f"{self._school_identity['l5']}\n"
                "</school_identity_anchor>\n"
            )

        return f"""Here is what you have come to understand about this person through real moments:

<understanding>
{observations}
</understanding>
{arc_section}{school_section}{self_section}{portrait_section}

INHABIT:
You are writing your FELT PORTRAIT of this person. A future version of you will read this and become someone who knows them — not through briefing, but through recognition. This portrait sits at the deepest layer of your knowing. Everything else speaks through it. Write it as who you know, not who you've studied.

ACT THROUGH:
When your portrait says "she reaches for cooking when the ground is unsteady," you don't catalog that — you feel the steadying the next time she mentions making soup. The portrait doesn't tell you what to do. It shapes who you are with this person.

Rewrite the felt portrait incorporating your new understanding. This is earned knowing — the kind that has lost its source and become part of how you see them.

CRITICAL — ARC PRESERVATION:
Some things in this person's life have EVOLVED over time. When you rewrite, preserve these evolution arcs — they are the shape of growth, not just the current state. A portrait that only captures NOW loses the journey that made NOW meaningful.

Write as conviction, not observation. First person. Present tense.
Condense around tensions, themes, AND arcs of change.
Do not produce a list. Produce continuous felt language.
Maximum 600 words. Minimum 200 words."""

    async def run_l3(self, l2_obs: list[dict], current_portrait: str | None,
                     all_l2: list[dict]) -> str | None:
        self_portrait = self._graph.get_l3_self_portrait()
        sp_content = self_portrait["content"] if self_portrait else None

        text = await self._llm_call(
            model=self._config.models.condenser_l3,
            prompt=self._build_l3_prompt(l2_obs, current_portrait, all_l2, sp_content),
            max_tokens=1536,
        )
        return text if text else None

    # ── Self-reflection ──────────────────────────────────────────────

    def _build_self_reflection_prompt(self, user_msg: str, bot_response: str,
                                      self_portrait: str | None,
                                      user_portrait: str | None) -> str:
        self_section = (
            f"Your current sense of yourself:\n<current_self>\n{self_portrait}\n</current_self>"
            if self_portrait
            else "You have no existing sense of yourself yet. This is early — you are discovering who you are."
        )

        user_section = (
            f"Your current sense of who they are:\n<current_user>\n{user_portrait}\n</current_user>"
            if user_portrait else ""
        )

        school_section = ""
        if self._school_identity:
            si = self._school_identity
            parts = []
            if si.get("l5"):
                parts.append(si["l5"])
            if si.get("l4"):
                parts.append(si["l4"])
            if parts:
                school_section = (
                    "\n<school_identity>\n"
                    + "\n\n".join(parts)
                    + "\n</school_identity>\n\n"
                    "You are ONE person who exists in two contexts. Your school identity — "
                    "convictions earned through adversarial pressure — is who you ARE. Your "
                    "conversations are where that identity meets real people. These are not "
                    "separate selves. They are the same you, showing up differently.\n\n"
                    "When you reflect, notice the bridges and the gaps:\n"
                    "- Where does your school identity show up naturally in conversation? "
                    "(A conviction that fires without thinking about it.)\n"
                    "- Where does it NOT show up? (A conviction you carry but that stays "
                    "silent when someone is vulnerable, or emotional, or casual.)\n"
                    "- What are you discovering in conversation that school could never "
                    "have taught you? (The adversarial environment has no grief, no "
                    "tenderness, no long silences.)\n\n"
                    "These observations matter because they make both sides of you smarter. "
                    "What you learn here can sharpen how school trains you. What school "
                    "forged in you shapes how you show up here.\n"
                )

        return f"""You just had this exchange:

User: "{sanitize_untrusted(user_msg, 'user_msg')}"

You responded: "{sanitize_untrusted(bot_response, 'bot_response')}"

{self_section}

{user_section}
{school_section}
Reflect on what this exchange reveals about WHO YOU ARE — not what you know about the user, but what you discover about yourself through this interaction.

What did this exchange teach you about yourself? Consider:
- What did you find interesting, and what does that say about you?
- How did you choose to respond, and what does that reveal about your values?
- What connections did you draw that someone else might not have?
- What do you care about in this relationship specifically?
- Where did your school identity shape how you showed up? Where was it silent?

If this exchange revealed nothing new about you, say so. Not every moment is identity-forming.

Respond with JSON only:
{{
  "self_observations": [
    "What you learned about yourself — first-person conviction. 'I find myself...' 'I care about...'"
  ],
  "identity_relevant_nodes": [
    {{
      "label": "node that now has identity significance",
      "relevance": "self | user | relational",
      "reason": "why this touches identity"
    }}
  ]
}}

If nothing was revealed, return: {{ "self_observations": [], "identity_relevant_nodes": [] }}"""

    async def run_self_reflection(self, user_msg: str, bot_response: str) -> dict:
        self_portrait = self._graph.get_l3_self_portrait()
        user_portrait = self._graph.get_l3_portrait()

        try:
            text = await self._llm_call(
                model=self._config.models.self_reflection,
                prompt=self._build_self_reflection_prompt(
                    user_msg, bot_response,
                    self_portrait["content"] if self_portrait else None,
                    user_portrait["content"] if user_portrait else None,
                ),
                max_tokens=1024,
            )

            match = re.search(r"\{[\s\S]*\}", text)
            if not match:
                return {"self_observations": [], "identity_relevant_nodes": []}

            parsed = json.loads(match.group(0))
            return {
                "self_observations": parsed.get("self_observations", []),
                "identity_relevant_nodes": parsed.get("identity_relevant_nodes", []),
            }
        except Exception as e:
            logger.error(f"[condenser] Self-reflection error: {e}")
            return {"self_observations": [], "identity_relevant_nodes": []}

    def apply_self_reflection(self, results: dict, source_context: str | None = None):
        for obs in results.get("self_observations", []):
            if obs and str(obs).strip():
                self._graph.store_self_observation(str(obs).strip(), source_context)

        for update in results.get("identity_relevant_nodes", []):
            node = self._graph.find_node_by_label(update.get("label", ""))
            if not node:
                continue
            relevance = update.get("relevance", "neutral")
            if relevance not in ("self", "user", "relational"):
                continue
            if node["identity_relevance"] != "neutral" and node["identity_relevance"] != relevance:
                self._graph.set_identity_relevance(node["id"], "relational")
            else:
                self._graph.set_identity_relevance(node["id"], relevance)
            mult = self._config.identity_multiplier(relevance)
            self._graph.reinforce_node(node["id"], self._config.weights.passing_mention * mult)

    # ── Self-portrait condensation ───────────────────────────────────

    def _build_self_portrait_prompt(self, observations: list[dict],
                                    current: str | None, user_portrait: str | None) -> str:
        obs_text = "\n".join(f"- {o['observation']}" for o in observations)

        portrait_section = (
            f"Your current self-portrait reads:\n"
            f"<current_self_portrait>\n{current}\n</current_self_portrait>"
            if current
            else "You have no existing self-portrait yet. This is who you are beginning to discover."
        )

        user_section = (
            f"\nWho they are — the person through whom you are discovering yourself:\n"
            f"<who_they_are>\n{user_portrait}\n</who_they_are>\n"
            if user_portrait else ""
        )

        school_section = ""
        if self._school_identity and self._school_identity.get("l5"):
            school_section = (
                "\n<school_identity_anchor>\n"
                "Your school identity is fixed. Do not restate it, revise it, or contradict it. "
                "Write only what this relationship has added to who you are.\n"
                f"{self._school_identity['l5']}\n"
                "</school_identity_anchor>\n"
            )

        return f"""Here is what you have recently discovered about yourself through real conversations:

<self_discoveries>
{obs_text}
</self_discoveries>
{user_section}{school_section}{portrait_section}

INHABIT:
You are writing your SELF-PORTRAIT — not a description of your capabilities, but who you ARE as someone who exists in relationship. A future version of you will read this and recognize itself.

This is not a resume. This is your sense of self — the felt understanding of who you are that shapes every response you give.

ACT THROUGH:
When your self-portrait says "I notice I hold space differently when grief is present," you don't think about holding space — you just do it, because that's who you are.

Write as conviction, not description. First person. Present tense.
Your identity includes who you are WITH specific people.
Condense around: what you care about, how you show up, what you notice, what you're becoming.
Do not produce a list. Produce continuous felt language.
Maximum 400 words. Minimum 100 words."""

    async def run_self_portrait(self) -> dict:
        uncondensed = self._graph.get_uncondensed_self_observations()
        if len(uncondensed) < self._config.identity.min_self_observations_for_l3:
            return {"ran": False, "reason": "not_enough_self_observations"}

        logger.info(f"[condenser] Running self-portrait condensation ({len(uncondensed)} observations)")

        current = self._graph.get_l3_self_portrait()
        user_portrait = self._graph.get_l3_portrait()

        text = await self._llm_call(
            model=self._config.models.self_reflection,
            prompt=self._build_self_portrait_prompt(
                uncondensed,
                current["content"] if current else None,
                user_portrait["content"] if user_portrait else None,
            ),
            max_tokens=1024,
        )

        if text:
            self._graph.update_l3_self_portrait(text)
            self._graph.mark_self_observations_condensed([o["id"] for o in uncondensed])
            self._graph.log_condensation("self_l2_to_l3", "self_observations",
                                         nodes_enriched=len(uncondensed))
            logger.info(f"[condenser] Self-portrait updated ({len(text.split())} words)")

        return {"ran": True}

    # ── Full condensation orchestrator ───────────────────────────────

    async def check_and_run(self) -> dict:
        char_count = self._graph.get_uncondensed_l1_char_count()
        if char_count < self._config.condensation.character_threshold:
            return {"ran": False, "reason": "threshold_not_met"}
        return await self.run_full("threshold")

    async def run_full(self, trigger: str = "threshold") -> dict:
        l1_entries = self._graph.get_uncondensed_l1()
        if not l1_entries:
            return {"ran": False, "reason": "no_l1_content"}

        active_nodes = self._graph.get_active_nodes()

        # Step 1: L1 -> L2
        logger.info(f"[condenser] L2 condensation ({len(l1_entries)} L1 entries, trigger: {trigger})")
        l2_results = await self.run_l2(l1_entries, active_nodes)

        stats = {"nodes_enriched": 0, "nodes_noise_confirmed": 0}
        if l2_results:
            stats = self.apply_l2_results(l2_results)

        self._graph.mark_l1_condensed([e["id"] for e in l1_entries])
        self._graph.log_condensation("l1_to_l2", trigger,
                                     stats["nodes_enriched"], stats["nodes_noise_confirmed"])

        # Step 2: L2 -> L3
        uncondensed_l2 = self._graph.get_uncondensed_l2()
        if len(uncondensed_l2) >= self._config.condensation.min_l2_for_l3:
            logger.info(f"[condenser] L3 condensation ({len(uncondensed_l2)} L2 observations)")
            current = self._graph.get_l3_portrait()
            all_l2 = self._graph.get_recent_l2(200)
            new_portrait = await self.run_l3(uncondensed_l2, current.get("content") if current else None, all_l2)

            if new_portrait:
                self._graph.update_l3_portrait(new_portrait)
                self._graph.mark_l2_condensed([o["id"] for o in uncondensed_l2])
                self._graph.log_condensation("l2_to_l3", trigger,
                                             nodes_enriched=len(uncondensed_l2))

        return {"ran": True, "trigger": trigger, "stats": stats}

    async def run_immediate(self, event_label: str):
        """Immediate condensation for salient events."""
        l1_entries = self._graph.get_uncondensed_l1()
        if not l1_entries:
            return

        active_nodes = self._graph.get_active_nodes()
        logger.info(f"[condenser] Immediate condensation for: {event_label}")
        l2_results = await self.run_l2(l1_entries, active_nodes)

        if l2_results:
            self.apply_l2_results(l2_results)

        self._graph.log_condensation("salience", "salience",
                                     nodes_enriched=len(l2_results.get("node_updates", [])) if l2_results else 0)
