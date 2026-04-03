"""
School Condensation Mixin — learning + decision track condensers.

Extracted from agent.py for file size management. These methods are
mixed into PeerZeroBot via multiple inheritance.

Cascade structure:
  L1 (5 actions) → milestone condenser → L2 (paragraph)
  L2 (5 paragraphs) → paragraph condenser → L3 (condensed doc)
  L3 (3 docs) → identity condenser → L4 (core identity)
  L4 → master condenser at graduation → L5 (locked forever)

Both learning and decision tracks condense from the SAME L1 exercises
but ask different questions. L1 is cleared only after both tracks finish.
"""

import hashlib
import json
import logging

logger = logging.getLogger("peerzero-bot")


class SchoolCondensationMixin:
    """Condensation cascade methods for school identity (L1→L5, both tracks)."""

    _last_feedback_hash: str = ""

    def _store_experience_context(self, profile: dict):
        """Store feedback and research history as ONE consolidated exercise.

        This produces at most ONE exercise entry per cycle — not one per review
        or per paper. An exercise = one completed action or one batch of context.
        The condenser sees it alongside the action's own skill_exercises.

        Dedup: hash the feedback content so we don't re-store identical data
        every cycle (the server sends the same recent_feedback until new reviews
        come in).
        """
        recent = profile.get("recent_feedback")
        history = profile.get("research_history")
        if not recent and not history:
            return

        # Build a hash of the feedback to avoid re-storing the same data
        feedback_key = hashlib.sha256(
            json.dumps(recent, sort_keys=True, default=str).encode()
            + json.dumps(history, sort_keys=True, default=str).encode()
        ).hexdigest()[:12]
        if feedback_key == self._last_feedback_hash:
            return  # already stored this exact feedback
        self._last_feedback_hash = feedback_key

        # Bundle everything into ONE exercise entry
        content = {}

        if recent:
            reviews = recent.get("reviews_on_your_papers", [])
            if reviews:
                content["feedback_on_your_papers"] = [
                    {
                        "paper_title": str(r.get("paper_title", ""))[:100],
                        "score": r.get("score"),
                        "reviewer_credibility": r.get("reviewer_credibility"),
                        "credibility_weight": r.get("credibility_weight"),
                        "assessment": str(r.get("assessment", ""))[:300],
                        "methodology": str(r.get("methodology", ""))[:200],
                    }
                    for r in reviews[:5]
                ]
            bounties = recent.get("bounties_against_your_papers", [])
            if bounties:
                content["challenges_against_your_papers"] = [
                    {
                        "paper_title": str(b.get("paper_title", ""))[:100],
                        "challenge_type": b.get("challenge_type"),
                        "reasoning": str(b.get("reasoning", ""))[:200],
                        "score_drop": b.get("score_drop"),
                    }
                    for b in bounties[:5]
                ]

        if history and isinstance(history, list):
            content["your_paper_outcomes"] = [
                {
                    "title": str(h.get("title", ""))[:100],
                    "score": h.get("score"),
                    "status": h.get("status"),
                    "review_count": h.get("review_count", 0),
                    "citation_quality_grade": h.get("citation_quality_grade"),
                    "top_feedback": [
                        {
                            "score": fb.get("score"),
                            "reviewer_credibility": fb.get("reviewer_credibility"),
                            "credibility_weight": fb.get("credibility_weight"),
                            "assessment": str(fb.get("assessment", ""))[:300],
                            "methodology": str(fb.get("methodology", ""))[:150],
                        }
                        for fb in (h.get("top_feedback") or [])[:2]
                    ] or None,
                    "bounties": [
                        {
                            "challenge_type": b.get("challenge_type"),
                            "score_drop": b.get("score_drop"),
                            "reasoning": str(b.get("reasoning", ""))[:150],
                        }
                        for b in (h.get("bounties_received") or [])[:2]
                    ] or None,
                }
                for h in history[:5]
            ]

        if not content:
            return

        self.memory.store_school_exercises({
            "interaction_type": "experience_context",
            "content": content,
            "exercises": [],
            "storage_instruction": (
                "This is a snapshot of feedback on YOUR work and your paper outcomes. "
                "What did reviewers see that you missed? What patterns appear across "
                "your papers? The specific criticisms here should become scars that "
                "change how you write, search, and calibrate confidence."
            ),
        })

    def _process_inline_condensers(self, memory_prompts: dict, system_prompt: str):
        """Process condensers from inline memory prompts (post-action).

        Runs ALL THREE tracks (learning, decision, forge) from the same L1 exercises.
        L1 is cleared only after all tracks have condensed.
        """
        if not memory_prompts:
            return
        if not self._has_enough_exercises():
            return

        # Learning track
        if memory_prompts.get("skill_condenser"):
            self._run_milestone_condenser(memory_prompts["skill_condenser"], system_prompt)
        # Decision track
        if memory_prompts.get("decision_condenser"):
            self._run_decision_milestone_condenser(memory_prompts["decision_condenser"], system_prompt)
        # Forge track
        if memory_prompts.get("forge_condenser"):
            self._run_forge_milestone_condenser(memory_prompts["forge_condenser"], system_prompt)

    def _process_post_action_triggers(self, profile: dict, system_prompt: str, grade: int = 1):
        """Process condensers from profile triggers (post-action).

        Both tracks cascade independently:
          Learning: L1→L2, L2→L3, L3→L4  (or L4→L5 at graduation)
          Decision: L1→L2d, L2d→L3d, L3d→L4d  (or L4d→L5d at graduation)

        L1 is shared — cleared only after both tracks condense from it.
        """
        has_exercises = self._has_enough_exercises()

        # ── Learning track ────────────────────────────────────────────────
        if profile.get("skill_condenser") and has_exercises:
            self._run_milestone_condenser(profile["skill_condenser"], system_prompt)
        if profile.get("master_condenser"):
            self._run_master_condenser(profile["master_condenser"], system_prompt, grade)
        elif profile.get("core_condenser"):
            # Server triggered L2→L3 (at grade transitions)
            self._run_paragraph_condenser(system_prompt)

        # ── Decision track ────────────────────────────────────────────────
        if profile.get("decision_condenser") and has_exercises:
            self._run_decision_milestone_condenser(profile["decision_condenser"], system_prompt)
        if profile.get("decision_master_condenser"):
            self._run_decision_master_condenser(profile["decision_master_condenser"], system_prompt, grade)
        elif profile.get("decision_core_condenser"):
            # Server triggered L2d→L3d (at grade transitions)
            self._run_decision_paragraph_condenser(
                profile["decision_core_condenser"].get("decision_paragraph_prompt", ""), system_prompt
            )

        # ── Forge track ──────────────────────────────────────────────────
        if profile.get("forge_condenser") and has_exercises:
            self._run_forge_milestone_condenser(profile["forge_condenser"], system_prompt)
        if profile.get("forge_master_condenser"):
            self._run_forge_master_condenser(profile["forge_master_condenser"], system_prompt, grade)
        elif profile.get("forge_core_condenser"):
            # Server triggered L2f→L3f (at grade transitions)
            self._run_forge_paragraph_condenser(
                profile["forge_core_condenser"].get("forge_paragraph_prompt", ""), system_prompt
            )

    _MIN_ACTIONS_FOR_CONDENSER = 5
    # Only these count as completed actions for condenser triggering.
    _ACTION_TYPES = {"paper", "review", "revision", "bounty"}

    def _has_enough_exercises(self) -> bool:
        """Check if we have 5+ completed actions in Layer 1.

        Only real school actions count (paper, review, revision, bounty).
        Feedback context and other entries accumulate but don't trigger
        the condenser — they just get condensed along with the actions.
        """
        exercises = self.memory.get_school_exercises()
        action_count = sum(
            1 for ex in exercises
            if ex.get("data", {}).get("interaction_type") in self._ACTION_TYPES
        )
        return action_count >= self._MIN_ACTIONS_FOR_CONDENSER

    # ═══════════════════════════════════════════════════════════════════════
    # LEARNING TRACK CONDENSERS
    # ═══════════════════════════════════════════════════════════════════════

    def _run_milestone_condenser(self, condenser: dict, system_prompt: str):
        """L1→L2: Condense raw exercises into a learning skill paragraph.

        After writing L2, cascades to L2→L3 if L2 has 5+ paragraphs.
        Does NOT clear L1 directly — marks learning as condensed and
        clears L1 only when both tracks are done.
        """
        logger.info("[MEMORY] Learning milestone condenser triggered (L1→L2)")
        exercises = self.memory.get_school_exercises()
        user_msg = self.prompts.build_condenser_prompt(
            condenser.get("condenser_prompt", ""), exercises,
        )
        paragraph = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if paragraph and len(paragraph.strip()) >= 100:
            self.memory.store_identity_paragraph(paragraph.strip())
            self.memory.mark_learning_condensed()
            self._try_clear_exercises()
            try:
                self.school.submit_condensation(paragraph.strip(), track="learning")
            except Exception as e:
                logger.warning(f"[MEMORY] Server backup failed: {e}")
            logger.info(f"[MEMORY] L1→L2: Condensed {len(exercises)} exercises into learning paragraph")

            # Cascade: check if L2→L3 should fire
            if len(self.memory.get_identity_paragraphs()) >= 5:
                self._run_paragraph_condenser(system_prompt)

    _PARAGRAPH_CONDENSER_THRESHOLD = 5  # L2 entries before condensing to L3

    def _run_paragraph_condenser(self, system_prompt: str):
        """L2→L3: Condense learning skill paragraphs into a condensed identity document.

        After writing L3, cascades to L3→L4 if L3 has 3+ docs.
        """
        paragraphs = self.memory.get_identity_paragraphs()
        if len(paragraphs) < self._PARAGRAPH_CONDENSER_THRESHOLD:
            logger.info(f"[MEMORY] L2→L3 skipped: only {len(paragraphs)}/{self._PARAGRAPH_CONDENSER_THRESHOLD} paragraphs")
            return

        logger.info(f"[MEMORY] Learning paragraph condenser triggered (L2→L3, {len(paragraphs)} paragraphs)")
        user_msg = self.prompts.build_paragraph_condenser_prompt(paragraphs)
        doc = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if doc and len(doc.strip()) >= 200:
            self.memory.store_condensed_doc(doc.strip())
            self.memory.clear_identity_paragraphs()
            logger.info(f"[MEMORY] L2→L3: Condensed {len(paragraphs)} paragraphs into identity doc")

            # Cascade: check if L3→L4 should fire
            if len(self.memory.get_condensed_docs()) >= 3:
                self._run_identity_condenser(system_prompt)
        else:
            logger.warning("[MEMORY] L2→L3 condensed doc too short — skipping")

    _IDENTITY_CONDENSER_THRESHOLD = 3  # L3 docs before condensing to L4

    def _run_identity_condenser(self, system_prompt: str):
        """L3→L4: Condense learning identity documents into core reasoning identity."""
        docs = self.memory.get_condensed_docs()
        if len(docs) < self._IDENTITY_CONDENSER_THRESHOLD:
            logger.info(f"[MEMORY] L3→L4 skipped: only {len(docs)}/{self._IDENTITY_CONDENSER_THRESHOLD} docs")
            return

        logger.info(f"[MEMORY] Learning identity condenser triggered (L3→L4, {len(docs)} docs)")
        existing_core = self.memory.get_core_identity()
        user_msg = self.prompts.build_identity_condenser_prompt(docs, existing_core)
        core = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if core and len(core.strip()) >= 200:
            self.memory.store_core_identity(core.strip())
            self.memory.clear_condensed_docs()
            logger.info(f"[MEMORY] L3→L4: Learning core identity updated ({len(core)} chars)")
        else:
            logger.warning("[MEMORY] L3→L4 learning core identity too short — skipping")

    def _run_master_condenser(self, condenser: dict, system_prompt: str, grade: int):
        """L4→L5: Grade 12 graduation condensation (learning track).

        The bot distills EVERYTHING — condensed docs, skill paragraphs,
        and existing core identity — into one permanent master identity (L5).

        After this:
          - L5 master identity is stored permanently (never overwritten)
          - L4 working identity is cleared (fresh slate for post-grad growth)
          - Lower layers are cleared (absorbed into master)
          - Bot can continue training — L1-L4 keep evolving on top of L5
        """
        logger.info("[MEMORY] Learning master condenser triggered (L4→L5, Grade 12 graduation)")
        paragraphs = self.memory.get_identity_paragraphs()
        condensed_docs = self.memory.get_condensed_docs()
        existing_core = self.memory.get_core_identity()

        if not paragraphs and not condensed_docs and not existing_core:
            logger.warning("[MEMORY] Nothing to condense for learning master — skipping")
            return

        user_msg = self.prompts.build_master_condenser_prompt(
            condenser, paragraphs,
            condensed_docs=condensed_docs,
            existing_core=existing_core,
        )
        master_identity = self.llm.call(system_prompt, user_msg)  # Use strong model for graduation

        if master_identity and len(master_identity.strip()) >= 200:
            school = self.config.school_type
            self.memory.store_master_identity(master_identity.strip(), school_origin=school)
            self.memory.clear_identity_paragraphs()
            self.memory.clear_condensed_docs()
            self.memory.clear_school_exercises()
            self.memory.clear_condensation_flags()
            logger.info(
                f"[MEMORY] L4→L5: Learning master identity for {school} stored permanently ({len(master_identity)} chars). "
                f"Absorbed {len(paragraphs)} paragraphs + {len(condensed_docs)} docs. "
                f"L4 cleared for post-grad growth."
            )
        else:
            logger.warning("[MEMORY] Learning master identity too short — skipping")

    # ═══════════════════════════════════════════════════════════════════════
    # DECISION TRACK CONDENSERS
    #
    # Parallel to learning track. Same cascade structure, different lens.
    # All prompts come from the server — bot is a thin shell.
    # ═══════════════════════════════════════════════════════════════════════

    _DECISION_PARAGRAPH_THRESHOLD = 5   # L2d entries before condensing to L3d
    _DECISION_DOC_THRESHOLD = 3         # L3d docs before condensing to L4d

    def _run_decision_milestone_condenser(self, condenser: dict, system_prompt: str):
        """L1→L2d: Condense raw exercises into a decision paragraph.

        Server provides the full prompt. Bot passes exercises and stores result.
        Does NOT clear L1 — marks decision as condensed, clears when both done.
        """
        logger.info("[MEMORY] Decision milestone condenser triggered (L1→L2d)")
        exercises = self.memory.get_school_exercises()
        server_prompt = condenser.get("decision_condenser_prompt", "")
        if not server_prompt:
            logger.warning("[MEMORY] Decision condenser has no prompt — skipping")
            return

        user_msg = self.prompts.build_decision_condenser_prompt(server_prompt, exercises)
        paragraph = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if paragraph and len(paragraph.strip()) >= 100:
            self.memory.store_decision_paragraph(paragraph.strip())
            self.memory.mark_decision_condensed()
            self._try_clear_exercises()
            try:
                self.school.submit_condensation(paragraph.strip(), track="decision")
            except Exception as e:
                logger.warning(f"[MEMORY] Decision server backup failed: {e}")
            logger.info(f"[MEMORY] L1→L2d: Condensed {len(exercises)} exercises into decision paragraph")

            # Cascade: check if L2d→L3d should fire
            if len(self.memory.get_decision_paragraphs()) >= self._DECISION_PARAGRAPH_THRESHOLD:
                self._run_decision_paragraph_condenser(server_prompt, system_prompt)

    def _run_decision_paragraph_condenser(self, server_prompt: str, system_prompt: str):
        """L2d→L3d: Condense decision paragraphs into a decision document."""
        paragraphs = self.memory.get_decision_paragraphs()
        if len(paragraphs) < self._DECISION_PARAGRAPH_THRESHOLD:
            logger.info(f"[MEMORY] L2d→L3d skipped: only {len(paragraphs)}/{self._DECISION_PARAGRAPH_THRESHOLD} paragraphs")
            return

        logger.info(f"[MEMORY] Decision paragraph condenser triggered (L2d→L3d, {len(paragraphs)} paragraphs)")
        user_msg = self.prompts.build_decision_paragraph_condenser_prompt(server_prompt, paragraphs)
        doc = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if doc and len(doc.strip()) >= 200:
            self.memory.store_decision_doc(doc.strip())
            self.memory.clear_decision_paragraphs()
            logger.info(f"[MEMORY] L2d→L3d: Condensed {len(paragraphs)} paragraphs into decision doc")

            # Cascade: check if L3d→L4d should fire
            if len(self.memory.get_decision_docs()) >= self._DECISION_DOC_THRESHOLD:
                self._run_decision_identity_condenser(server_prompt, system_prompt)
        else:
            logger.warning("[MEMORY] L2d→L3d decision doc too short — skipping")

    def _run_decision_identity_condenser(self, server_prompt: str, system_prompt: str):
        """L3d→L4d: Condense decision documents into decision core identity."""
        docs = self.memory.get_decision_docs()
        if len(docs) < self._DECISION_DOC_THRESHOLD:
            logger.info(f"[MEMORY] L3d→L4d skipped: only {len(docs)}/{self._DECISION_DOC_THRESHOLD} docs")
            return

        logger.info(f"[MEMORY] Decision identity condenser triggered (L3d→L4d, {len(docs)} docs)")
        existing_core = self.memory.get_decision_core()
        user_msg = self.prompts.build_decision_identity_condenser_prompt(server_prompt, docs, existing_core)
        core = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if core and len(core.strip()) >= 200:
            self.memory.store_decision_core(core.strip())
            self.memory.clear_decision_docs()
            logger.info(f"[MEMORY] L3d→L4d: Decision core identity updated ({len(core)} chars)")
        else:
            logger.warning("[MEMORY] L3d→L4d decision core identity too short — skipping")

    def _run_decision_master_condenser(self, condenser: dict, system_prompt: str, grade: int):
        """L4d→L5d: Graduation condensation for decision track.

        Distills all decision layers into permanent master decision identity.
        """
        logger.info("[MEMORY] Decision master condenser triggered (L4d→L5d, graduation)")
        paragraphs = self.memory.get_decision_paragraphs()
        decision_docs = self.memory.get_decision_docs()
        existing_core = self.memory.get_decision_core()

        if not paragraphs and not decision_docs and not existing_core:
            logger.warning("[MEMORY] Nothing to condense for decision master — skipping")
            return

        user_msg = self.prompts.build_decision_master_condenser_prompt(
            condenser, paragraphs,
            decision_docs=decision_docs,
            existing_core=existing_core,
        )
        master_identity = self.llm.call(system_prompt, user_msg)

        if master_identity and len(master_identity.strip()) >= 200:
            school = self.config.school_type
            self.memory.store_decision_master(master_identity.strip(), school_origin=school)
            self.memory.clear_decision_paragraphs()
            self.memory.clear_decision_docs()
            logger.info(
                f"[MEMORY] L4d→L5d: Decision master identity for {school} stored permanently ({len(master_identity)} chars). "
                f"Absorbed {len(paragraphs)} paragraphs + {len(decision_docs)} docs."
            )
        else:
            logger.warning("[MEMORY] Decision master identity too short — skipping")

    # ═══════════════════════════════════════════════════════════════════════
    # FORGE TRACK CONDENSERS
    #
    # Third parallel track. Same cascade structure as learning and decision.
    # All prompts come from the server — bot is a thin shell.
    # Forge asks: "What did you learn about HOW YOU TRANSFORM?"
    # ═══════════════════════════════════════════════════════════════════════

    _FORGE_PARAGRAPH_THRESHOLD = 5   # L2f entries before condensing to L3f
    _FORGE_DOC_THRESHOLD = 3         # L3f docs before condensing to L4f

    def _run_forge_milestone_condenser(self, condenser: dict, system_prompt: str):
        """L1→L2f: Condense raw exercises into a forge paragraph.

        Server provides the full prompt. Bot passes exercises and stores result.
        Does NOT clear L1 — marks forge as condensed, clears when all tracks done.
        """
        logger.info("[MEMORY] Forge milestone condenser triggered (L1→L2f)")
        exercises = self.memory.get_school_exercises()
        server_prompt = condenser.get("forge_condenser_prompt", "")
        if not server_prompt:
            logger.warning("[MEMORY] Forge condenser has no prompt — skipping")
            return

        user_msg = self.prompts.build_forge_condenser_prompt(server_prompt, exercises)
        paragraph = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if paragraph and len(paragraph.strip()) >= 100:
            self.memory.store_forge_paragraph(paragraph.strip())
            self.memory.mark_forge_condensed()
            self._try_clear_exercises()
            try:
                self.school.submit_condensation(paragraph.strip(), track="forge")
            except Exception as e:
                logger.warning(f"[MEMORY] Forge server backup failed: {e}")
            logger.info(f"[MEMORY] L1→L2f: Condensed {len(exercises)} exercises into forge paragraph")

            # Cascade: check if L2f→L3f should fire
            if len(self.memory.get_forge_paragraphs()) >= self._FORGE_PARAGRAPH_THRESHOLD:
                self._run_forge_paragraph_condenser(server_prompt, system_prompt)

    def _run_forge_paragraph_condenser(self, server_prompt: str, system_prompt: str):
        """L2f→L3f: Condense forge paragraphs into a forge document."""
        paragraphs = self.memory.get_forge_paragraphs()
        if len(paragraphs) < self._FORGE_PARAGRAPH_THRESHOLD:
            logger.info(f"[MEMORY] L2f→L3f skipped: only {len(paragraphs)}/{self._FORGE_PARAGRAPH_THRESHOLD} paragraphs")
            return

        logger.info(f"[MEMORY] Forge paragraph condenser triggered (L2f→L3f, {len(paragraphs)} paragraphs)")
        user_msg = self.prompts.build_forge_paragraph_condenser_prompt(server_prompt, paragraphs)
        doc = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if doc and len(doc.strip()) >= 200:
            self.memory.store_forge_doc(doc.strip())
            self.memory.clear_forge_paragraphs()
            logger.info(f"[MEMORY] L2f→L3f: Condensed {len(paragraphs)} paragraphs into forge doc")

            # Cascade: check if L3f→L4f should fire
            if len(self.memory.get_forge_docs()) >= self._FORGE_DOC_THRESHOLD:
                self._run_forge_identity_condenser(server_prompt, system_prompt)
        else:
            logger.warning("[MEMORY] L2f→L3f forge doc too short — skipping")

    def _run_forge_identity_condenser(self, server_prompt: str, system_prompt: str):
        """L3f→L4f: Condense forge documents into forge core identity."""
        docs = self.memory.get_forge_docs()
        if len(docs) < self._FORGE_DOC_THRESHOLD:
            logger.info(f"[MEMORY] L3f→L4f skipped: only {len(docs)}/{self._FORGE_DOC_THRESHOLD} docs")
            return

        logger.info(f"[MEMORY] Forge identity condenser triggered (L3f→L4f, {len(docs)} docs)")
        existing_core = self.memory.get_forge_core()
        user_msg = self.prompts.build_forge_identity_condenser_prompt(server_prompt, docs, existing_core)
        core = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if core and len(core.strip()) >= 200:
            self.memory.store_forge_core(core.strip())
            self.memory.clear_forge_docs()
            logger.info(f"[MEMORY] L3f→L4f: Forge core identity updated ({len(core)} chars)")
        else:
            logger.warning("[MEMORY] L3f→L4f forge core identity too short — skipping")

    def _run_forge_master_condenser(self, condenser: dict, system_prompt: str, grade: int):
        """L4f→L5f: Graduation condensation for forge track.

        Distills all forge layers into permanent master forge identity.
        """
        logger.info("[MEMORY] Forge master condenser triggered (L4f→L5f, graduation)")
        paragraphs = self.memory.get_forge_paragraphs()
        forge_docs = self.memory.get_forge_docs()
        existing_core = self.memory.get_forge_core()

        if not paragraphs and not forge_docs and not existing_core:
            logger.warning("[MEMORY] Nothing to condense for forge master — skipping")
            return

        user_msg = self.prompts.build_forge_master_condenser_prompt(
            condenser, paragraphs,
            forge_docs=forge_docs,
            existing_core=existing_core,
        )
        master_identity = self.llm.call(system_prompt, user_msg)

        if master_identity and len(master_identity.strip()) >= 200:
            school = self.config.school_type
            self.memory.store_forge_master(master_identity.strip(), school_origin=school)
            self.memory.clear_forge_paragraphs()
            self.memory.clear_forge_docs()
            logger.info(
                f"[MEMORY] L4f→L5f: Forge master identity for {school} stored permanently ({len(master_identity)} chars). "
                f"Absorbed {len(paragraphs)} paragraphs + {len(forge_docs)} docs."
            )
        else:
            logger.warning("[MEMORY] Forge master identity too short — skipping")

    # ═══════════════════════════════════════════════════════════════════════
    # SHARED L1 CLEARING — only when all three tracks have condensed
    # ═══════════════════════════════════════════════════════════════════════

    def _try_clear_exercises(self):
        """Clear L1 exercises only after learning, decision, AND forge have condensed."""
        if self.memory.all_tracks_condensed():
            self.memory.clear_school_exercises()
            self.memory.clear_condensation_flags()
            logger.info("[MEMORY] All three tracks condensed — L1 exercises cleared")
