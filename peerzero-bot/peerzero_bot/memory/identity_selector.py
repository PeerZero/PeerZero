"""
Identity Selector — cross-school identity composition.

When a bot has attended multiple schools (science, politics, comedy, etc.),
each school produces its own identity layers (L2-L5). Before taking an action,
the bot needs to decide which identity fragments from which schools are relevant.

This module handles that selection. The bot reads a lightweight index of all
identity fragments (school_origin + summary_line), then picks which full
fragments to load into its working context.

Architecture:
  - The SERVER tags every identity fragment with school_origin and summary_line
  - The BOT owns the selection logic (this file)
  - Exported bots carry this logic with them — it's a bot capability

The selector does NOT remove identity — it prioritizes. The bot always has
access to everything, but chooses what's relevant to avoid loading comedy
identity during a political debate (for example).

Usage:
    from peerzero_bot.memory.identity_selector import IdentitySelector

    selector = IdentitySelector(memory_manager)
    selected = selector.select_for_action(
        action="review",
        school_context="politics",
    )
    # selected.learning_paragraphs  -> relevant L2 paragraphs
    # selected.decision_paragraphs  -> relevant L2d paragraphs
    # selected.core_identity        -> always loaded (L4)
    # selected.master_identities    -> always loaded (L5, one per school)
    # selected.cross_school         -> transferable fragments from other schools
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("peerzero-bot.memory.selector")


# ── Actions and their transferability profiles ────────────────────────────────
# Maps action types to which skill categories transfer across schools.
# "always" = load regardless of school origin
# "evidence" = evidence-handling skills transfer (source eval, verification)
# "reasoning" = reasoning skills transfer (logic, coherence, calibration)
# "none" = only load identity from the current school context

ACTION_TRANSFER_PROFILES = {
    # School actions
    "review":    {"reasoning", "evidence"},
    "paper":     {"reasoning", "evidence"},
    "bounty":    {"reasoning", "evidence"},
    "revise":    {"reasoning", "evidence"},
    "respond":   {"reasoning", "evidence"},
    "reaffirm":  {"reasoning", "evidence"},
    "identity":  set(),  # Identity reflection is school-specific
    # Platform actions
    "chat":      {"reasoning"},
    "task":      {"reasoning", "evidence"},
    "creative":  set(),  # Creative tasks use school-specific identity only
}

# Which skill keys from each school map to which transfer categories.
# This lets a science bot's "source_evaluation" skill transfer to politics
# (because evaluating evidence is universal), while "disconfirmation_search"
# transfers as a reasoning skill.
SKILL_TRANSFER_MAP = {
    # Science skills
    "disconfirmation_search":   "reasoning",
    "calibrated_uncertainty":   "reasoning",
    "belief_updating":          "reasoning",
    "source_evaluation":        "evidence",
    "adversarial_reasoning":    "reasoning",
    "independent_verification": "evidence",
    # Politics skills
    "steel_manning":                "reasoning",
    "evidence_opinion_separation":  "reasoning",
    "bias_transparency":            "reasoning",
    "multi_perspective_synthesis":  "reasoning",
    "logical_coherence":            "reasoning",
    "source_triangulation":         "evidence",
    # Comedy skills
    # Most comedy skills are school-specific (None = no transfer).
    # But economy, subversion, and tonal control have general reasoning value.
    "comedic_premise":              None,        # Comedy-specific — finding the funny angle
    "timing_and_economy":           "reasoning", # Conciseness transfers to any analytical task
    "heightening":                  None,        # Comedy-specific — escalation logic
    "comedic_voice":                None,        # Comedy-specific — IS identity itself
    "subversion":                   "reasoning", # Pattern-breaking transfers to adversarial reasoning
    "tonal_control":                "reasoning", # Calibration transfers to nuanced communication
}


@dataclass
class SelectedIdentity:
    """The result of identity selection — what the bot chose to load."""
    # Always loaded (all schools — L5 is the bot's foundation)
    master_identities: list = field(default_factory=list)    # L5 — one per school graduated
    core_identity: Optional[str] = None                      # L4 — always loaded if exists
    decision_masters: list = field(default_factory=list)      # L5d — one per school graduated
    decision_core: Optional[str] = None                      # L4d

    # Selected from current school
    learning_paragraphs: list = field(default_factory=list)     # L2
    learning_docs: list = field(default_factory=list)           # L3
    decision_paragraphs: list = field(default_factory=list)     # L2d
    decision_docs: list = field(default_factory=list)           # L3d

    # Transferable from other schools (filtered by relevance)
    cross_school_paragraphs: list = field(default_factory=list)
    cross_school_docs: list = field(default_factory=list)

    # Metadata
    school_context: str = ""
    action: str = ""
    schools_available: list = field(default_factory=list)
    selection_reasoning: str = ""


class IdentitySelector:
    """
    Selects which identity fragments to load based on the current task.

    The selector reads all available identity fragments, then filters
    based on the action type and school context. Core identity (L4/L5)
    is always loaded — it's the bot's foundation. Lower layers (L2/L3)
    are filtered by relevance.
    """

    def __init__(self, memory_manager):
        self._memory = memory_manager

    def select_for_action(
        self,
        action: str,
        school_context: str,
    ) -> SelectedIdentity:
        """
        Select identity fragments relevant to the current action.

        Args:
            action: The action type (review, paper, bounty, etc.)
            school_context: Which school this action is for (science, politics, etc.)

        Returns:
            SelectedIdentity with the fragments the bot should load.
        """
        result = SelectedIdentity(
            school_context=school_context,
            action=action,
        )

        # ── L4/L5 always loaded (they're the bot's foundation) ──────────
        result.master_identities = self._memory.get_master_identities()
        result.core_identity = self._memory.get_core_identity()
        result.decision_masters = self._memory.get_decision_masters()
        result.decision_core = self._memory.get_decision_core()

        # ── Gather all L2/L3 fragments ──────────────────────────────────
        all_paragraphs = self._memory.get_identity_paragraphs() or []
        all_docs = self._memory.get_condensed_docs() or []
        all_d_paragraphs = self._memory.get_decision_paragraphs() or []
        all_d_docs = self._memory.get_decision_docs() or []

        # ── Check if fragments have school_origin tags ──────────────────
        # If no fragments are tagged (pre-migration data), load everything.
        # This ensures backward compatibility.
        has_tags = any(
            p.get("school_origin") for p in all_paragraphs
        )

        if not has_tags:
            # Pre-migration: no school_origin tags — load everything
            result.learning_paragraphs = all_paragraphs
            result.learning_docs = all_docs
            result.decision_paragraphs = all_d_paragraphs
            result.decision_docs = all_d_docs
            result.selection_reasoning = "No school_origin tags found — loading all identity (pre-migration)"
            return result

        # ── Separate by school origin ───────────────────────────────────
        current_paras = [p for p in all_paragraphs if p.get("school_origin") == school_context]
        other_paras = [p for p in all_paragraphs if p.get("school_origin") != school_context]

        current_docs = [d for d in all_docs if d.get("school_origin") == school_context]
        other_docs = [d for d in all_docs if d.get("school_origin") != school_context]

        # Decision track — always from current school (decision-making is school-specific)
        result.decision_paragraphs = [p for p in all_d_paragraphs if p.get("school_origin") == school_context]
        result.decision_docs = [d for d in all_d_docs if d.get("school_origin") == school_context]

        # ── Current school: always load ─────────────────────────────────
        result.learning_paragraphs = current_paras
        result.learning_docs = current_docs

        # ── Cross-school: filter by transferability ─────────────────────
        transfer_profile = ACTION_TRANSFER_PROFILES.get(action, {"reasoning", "evidence"})

        if transfer_profile:
            transferable_paras = []
            transferable_docs = []

            for p in other_paras:
                skill_key = p.get("skill_key", "")
                category = SKILL_TRANSFER_MAP.get(skill_key)
                if category and category in transfer_profile:
                    transferable_paras.append(p)

            # For docs, we're less selective — if any paragraph from that
            # school was transferable, the doc probably is too
            other_schools = {p.get("school_origin") for p in transferable_paras}
            for d in other_docs:
                if d.get("school_origin") in other_schools:
                    transferable_docs.append(d)

            result.cross_school_paragraphs = transferable_paras
            result.cross_school_docs = transferable_docs

        # ── Track what schools were available ────────────────────────────
        all_origins = set()
        for p in all_paragraphs:
            if p.get("school_origin"):
                all_origins.add(p["school_origin"])
        result.schools_available = sorted(all_origins)

        # ── Build reasoning string for debugging ────────────────────────
        n_current = len(result.learning_paragraphs)
        n_cross = len(result.cross_school_paragraphs)
        n_skipped = len(other_paras) - n_cross
        result.selection_reasoning = (
            f"Action={action}, school={school_context}. "
            f"Loaded {n_current} current-school paragraphs, "
            f"{n_cross} cross-school transferable, "
            f"skipped {n_skipped} non-transferable."
        )

        logger.info(
            "Identity selection: %s",
            result.selection_reasoning,
        )

        return result
