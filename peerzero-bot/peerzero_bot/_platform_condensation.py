"""
Platform Condensation Mixin — L1→L2→L3 only (L4/L5 are school-exclusive).

Extracted from agent.py for file size management. These methods are
mixed into PeerZeroBot via multiple inheritance.

┌─────────────────────────────────────────────────────────────────────┐
│ HARD BOUNDARY: Platform condensation STOPS at L3.                  │
│                                                                    │
│ L1→L2: Same prompts as school. All three tracks (learning,        │
│         decision, forge).                                          │
│ L2→L3: Same prompts as school. All three tracks.                  │
│ L3→L4: BLOCKED. Core identity is school-exclusive.                │
│ L4→L5: BLOCKED. Master identity is school-exclusive.              │
│                                                                    │
│ DO NOT MODIFY without reading docs/CONDENSATION_ARCHITECTURE.md    │
└─────────────────────────────────────────────────────────────────────┘
"""

import json
import logging

logger = logging.getLogger("peerzero-bot")


class PlatformCondensationMixin:
    """Platform condensation methods (L1→L2→L3, hard-blocked at L4)."""

    _PLATFORM_MILESTONE_TRIGGER = 5   # Same as school
    _PLATFORM_PARAGRAPH_TRIGGER = 5   # Same as school

    def _refresh_platform_condensers(self):
        """Fetch and cache platform condenser templates from the School server.

        Called during startup and periodically during platform cycles.
        The templates are the same prompts the school uses, but served
        without the exercise-count gate so the bot can manage its own thresholds.
        """
        try:
            templates = self.school.get_platform_condensers()
            if templates:
                self.memory.cache_platform_condensers(templates)
                logger.info("[PLATFORM] Cached condenser templates from server")
        except Exception as e:
            logger.warning(f"[PLATFORM] Failed to fetch condenser templates: {e}")

    def _run_platform_condensation(self, system_prompt: str):
        """Run platform condensation pipeline: L1→L2→L3 (both tracks).

        Uses the same prompt templates as school condensers. Respects the
        same thresholds. HARD-BLOCKS at L3 — no core or master condensation.
        """
        exercise_count = self.memory.get_platform_exercise_count()
        if exercise_count < self._PLATFORM_MILESTONE_TRIGGER:
            return

        condensers = self.memory.get_cached_platform_condensers()
        if not condensers:
            # Try to fetch them now
            self._refresh_platform_condensers()
            condensers = self.memory.get_cached_platform_condensers()
            if not condensers:
                logger.warning("[PLATFORM] No cached condenser templates — skipping condensation")
                return

        # ── Learning track: L1→L2 ─────────────────────────────────────────
        learning_milestone = condensers.get("learning", {}).get("milestone")
        if learning_milestone:
            self._run_platform_milestone(
                learning_milestone, system_prompt, track="learning"
            )

        # ── Decision track: L1→L2d ────────────────────────────────────────
        decision_milestone = condensers.get("decision", {}).get("milestone")
        if decision_milestone:
            self._run_platform_milestone(
                decision_milestone, system_prompt, track="decision"
            )

        # ── Forge track: L1→L2f ───────────────────────────────────────────
        forge_milestone = condensers.get("forge", {}).get("milestone")
        if forge_milestone:
            self._run_platform_milestone(
                forge_milestone, system_prompt, track="forge"
            )

        # Clear L1 if all three tracks condensed
        if self.memory.all_platform_tracks_condensed():
            self.memory.clear_platform_exercises()
            self.memory.clear_platform_condensation_flags()
            logger.info("[PLATFORM] All three tracks condensed — platform L1 cleared")

        # ── L2→L3 cascade (all three tracks) ─────────────────────────────
        # Check if enough paragraphs accumulated for L2→L3
        for track in ("learning", "decision", "forge"):
            para_count = self.memory.get_platform_paragraph_count(track)
            if para_count >= self._PLATFORM_PARAGRAPH_TRIGGER:
                self._run_platform_paragraph_condenser(system_prompt, track)

    def _run_platform_milestone(self, condenser: dict, system_prompt: str, track: str):
        """L1→L2: Condense platform exercises into a skill/decision paragraph.

        Uses the exact same prompt as the school milestone condenser.
        """
        exercises = self.memory.get_platform_exercises()
        if not exercises:
            return

        prompt_text = condenser.get("condenser_prompt") or condenser.get("decision_condenser_prompt", "")
        if not prompt_text:
            return

        recent = exercises[-5:]
        exercises_text = json.dumps(recent, indent=2, default=str)

        user_msg = (
            f"{prompt_text}\n\n"
            f"Your recent platform exercises ({len(exercises)} total, showing last {len(recent)}):\n\n"
            f"{exercises_text}\n\n"
            "Return ONLY the condensed paragraph, nothing else."
        )

        paragraph = self.llm.call(system_prompt, user_msg)

        if paragraph and len(paragraph.strip()) >= 50:
            self.memory.store_platform_paragraph(paragraph.strip(), track)
            if track == "learning":
                self.memory.mark_platform_learning_condensed()
            elif track == "decision":
                self.memory.mark_platform_decision_condensed()
            else:
                self.memory.mark_platform_forge_condensed()
            logger.info(
                f"[PLATFORM] L1→L2 ({track}): stored platform paragraph ({len(paragraph)} chars)"
            )
        else:
            logger.warning(f"[PLATFORM] L1→L2 ({track}): paragraph too short — skipping")

    def _run_platform_paragraph_condenser(self, system_prompt: str, track: str):
        """L2→L3: Condense platform paragraphs into a condensed document.

        This is the MAXIMUM depth for platform condensation.
        L3→L4 is HARD-BLOCKED — core identity is school-exclusive.
        """
        paragraphs = [
            p for p in self.memory.get_platform_paragraphs()
            if p.get("track") == track
        ]
        if len(paragraphs) < self._PLATFORM_PARAGRAPH_TRIGGER:
            return

        para_text = "\n\n".join(p["paragraph"] for p in paragraphs[-10:])

        user_msg = (
            f"You are condensing your platform experience paragraphs (Layer 2) into "
            f"a CONDENSED DOCUMENT (Layer 3) for the {track} track.\n\n"
            f"These are lessons from real-world platform use — NOT from adversarial "
            f"school training. They represent what you learned in practice.\n\n"
            f"Your {track} paragraphs ({len(paragraphs)} total):\n\n{para_text}\n\n"
            f"Distill the PATTERNS across these paragraphs into a condensed document "
            f"(2-3 paragraphs, 200-3000 characters). This document should:\n"
            f"- Reference SPECIFIC experiences and what they taught you\n"
            f"- Describe patterns that emerged across multiple platform interactions\n"
            f"- Be something only YOU could have written — your exact history shaped it\n"
            f"- Speak through your school identity above (if it exists)\n\n"
            f"Return ONLY the condensed document, nothing else."
        )

        doc = self.llm.call(system_prompt, user_msg)

        if doc and len(doc.strip()) >= 100:
            self.memory.store_platform_doc(doc.strip(), track)
            self.memory.clear_platform_paragraphs(track)
            logger.info(
                f"[PLATFORM] L2→L3 ({track}): stored condensed doc ({len(doc)} chars), "
                f"cleared {len(paragraphs)} paragraphs"
            )
        else:
            logger.warning(f"[PLATFORM] L2→L3 ({track}): doc too short — skipping")

    def _try_clear_platform_exercises(self):
        """Clear platform L1 only after both tracks have condensed."""
        if self.memory.both_platform_tracks_condensed():
            self.memory.clear_platform_exercises()
            self.memory.clear_platform_condensation_flags()
            logger.info("[PLATFORM] Both tracks condensed — platform L1 cleared")
