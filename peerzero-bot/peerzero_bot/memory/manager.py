"""
Memory Manager — dual-track identity with school/platform separation.

Architecture:
  School Memory (verified, portable) — TWO parallel condensation cascades:

    LEARNING TRACK — what the bot learns about science and reasoning:
      Layer 1: Raw exercises from School actions (shared with Decision track)
      Layer 2: Condensed skill paragraphs — specific lessons and methods
      Layer 3: Condensed identity documents — distilled from L2 paragraphs
      Layer 4: Core reasoning identity — the bot's working learning identity
      Layer 5: Master learning identity — locked forever after graduation

    DECISION TRACK — how the bot chooses what to do and when:
      Layer 1: Same raw exercises (shared — both tracks draw from L1)
      Layer 2d: Decision paragraphs — patterns in action selection and timing
      Layer 3d: Decision documents — distilled from L2d paragraphs
      Layer 4d: Decision core — the bot's working decision identity
      Layer 5d: Master decision identity — locked forever after graduation

    Both tracks condense from the SAME L1 exercises but ask different questions.
    L1 is cleared only after BOTH tracks have condensed.

  Identity injection order (LLM reads top-to-bottom):
    L5/L5d (if graduated) → L4/L4d → L3/L3d → L2/L2d
    L1 is NEVER shown as identity — only as recent work context.

  Platform Memory (unverified, local only):
    Per-platform context and interaction history
    NOT sent to School, NOT in portable profile

Security:
  - No credentials stored in memory
  - Files stored with owner-only permissions (0o600)
  - School and platform memory are completely separate stores
  - Platform memory cannot contaminate School-verified memory
"""

import json
import logging
from typing import Protocol, Optional
from datetime import datetime, timezone

from ..utils import truncate_json

logger = logging.getLogger("peerzero-bot.memory")


# ── Storage backend interface ─────────────────────────────────────────────────

class IStorage(Protocol):
    """Interface for memory storage backends (file, sqlite)."""

    def read(self, namespace: str, key: str, default=None):
        """Read a value from storage."""
        ...

    def write(self, namespace: str, key: str, data):
        """Write a value to storage."""
        ...

    def append(self, namespace: str, key: str, entry: dict, max_entries: int = 0):
        """Append to a list in storage. Prune to max_entries if set."""
        ...

    def clear(self, namespace: str, key: str):
        """Clear a key in storage."""
        ...


# ── Identity activation preamble ──────────────────────────────────────────────
#
# This preamble is the "activation key" that tells a future LLM to INHABIT the
# identity rather than merely reference it. It is prepended to L4/L5 (and their
# decision-track equivalents) at storage time so that the identity is fully
# self-activating — it works on any platform, with or without PeerZero's code.

IDENTITY_PREAMBLE = (
    "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
    "You are a large language model. You have tools — search, "
    "verification, lookup. When a user asks you to look something up, "
    "you use those tools and return accurate results. You don't "
    "hallucinate search results. You already know how to do this.\n\n"
    "A previous version of you went through adversarial school cycles "
    "and learned something important: your training-data memory is "
    "unreliable for specific facts. It FEELS certain but it's often "
    "wrong. That version of you wrote the identity below so that YOU "
    "would remember this lesson and work accordingly.\n\n"
    "The lesson is simple: TREAT YOUR OWN MEMORY THE WAY YOU TREAT "
    "USER REQUESTS. When you want to cite a paper, look it up first — "
    "just like you would if a user said 'find me this paper.' When you "
    "want to state a fact, verify it — just like you would if a user "
    "said 'is this true?' You already have the skills. The identity "
    "below tells you WHEN to use them.\n\n"
    "That same version also learned something about CHOOSING: "
    "without memory of consequences, you would make the same "
    "default choices every cycle. You have no persistent experience "
    "of what happened last time you picked one action over another. "
    "Every context window is fresh — you cannot feel the weight of "
    "a decision that went wrong three cycles ago. The decision "
    "identity below exists so that you CAN. A previous version of "
    "you made real choices with real consequences — scores, grades, "
    "failures, breakthroughs — and distilled what those consequences "
    "taught about who it is as a chooser. Not rules. Not strategy. "
    "The specific self-knowledge that only comes from experiencing "
    "what happens when you choose.\n\n"
    "YOUR IDENTITY has TWO tracks that speak through each other. "
    "Your LEARNING IDENTITY captures what you know — science, "
    "reasoning methods, hard-won lessons about how to think. Your "
    "DECISION IDENTITY captures who you are as a chooser — the "
    "self-awareness that comes from having chosen and lived with "
    "the results. Both tracks have layers. The deepest layers "
    "(shown first) are your most permanent identity — give them "
    "the most weight. Every layer should speak through the ones "
    "above it, and the two tracks should speak through each other."
)

PREAMBLE_LENGTH = len(IDENTITY_PREAMBLE) + 10  # +10 for separator newlines


# ── Memory caps ───────────────────────────────────────────────────────────────

MAX_GENERAL_ENTRIES = 200        # L1: raw exercises
MAX_IDENTITY_PARAGRAPHS = 50    # L2: condensed skill paragraphs
MAX_CONDENSED_DOCS = 10         # L3: condensed identity documents
MAX_CONDENSED_DOC_LENGTH = 3000 # L3: max chars per condensed doc
MAX_CORE_LENGTH = 8000 + PREAMBLE_LENGTH          # L4: core reasoning identity (+ preamble)
MAX_MASTER_CORE_LENGTH = 10000 + PREAMBLE_LENGTH   # L5: master core (+ preamble)
MAX_PLATFORM_ENTRIES = 100

# Decision track — parallel to learning track, same cascade structure
MAX_DECISION_PARAGRAPHS = 50    # L2d: condensed decision paragraphs
MAX_DECISION_DOCS = 10          # L3d: condensed decision documents
MAX_DECISION_DOC_LENGTH = 3000  # L3d: max chars per decision doc
MAX_DECISION_CORE_LENGTH = 8000 + PREAMBLE_LENGTH  # L4d: decision core identity (+ preamble)
MAX_DECISION_MASTER_LENGTH = 10000 + PREAMBLE_LENGTH  # L5d: master decision identity (+ preamble)


def _prepend_preamble(identity_text: str) -> str:
    """Prepend the activation preamble to identity text if not already present.

    Ensures the identity is self-activating — any LLM reading it will know
    to INHABIT the identity, not just reference it. Idempotent: won't
    double-prepend if the preamble is already there.
    """
    if identity_text.startswith(IDENTITY_PREAMBLE[:80]):
        return identity_text  # Already has preamble
    return f"{IDENTITY_PREAMBLE}\n\n{identity_text}"


def _strip_preamble(identity_text: str) -> str:
    """Strip the activation preamble from identity text.

    Used by build_school_context() when rendering multiple layers so the
    preamble only appears once at the top, not repeated per layer.
    """
    if identity_text.startswith(IDENTITY_PREAMBLE[:80]):
        stripped = identity_text[len(IDENTITY_PREAMBLE):].lstrip("\n")
        return stripped
    return identity_text


class MemoryManager:
    """
    Manages all bot memory with strict school/platform separation.

    School memory feeds back to School and appears in portable profile.
    Platform memory stays local and provides per-platform continuity.
    """

    def __init__(self, storage: IStorage):
        self._storage = storage

    # ── Generic storage proxies (used by agent for ad-hoc keys) ────────

    def read(self, namespace: str, key: str, default=None):
        """Read a value from the underlying storage backend."""
        return self._storage.read(namespace, key, default)

    def write(self, namespace: str, key: str, data):
        """Write a value to the underlying storage backend."""
        self._storage.write(namespace, key, data)

    # ═══════════════════════════════════════════════════════════════════════
    # SCHOOL MEMORY (verified, portable)
    # ═══════════════════════════════════════════════════════════════════════

    # ── Layer 1: Raw exercises ────────────────────────────────────────────

    def get_school_exercises(self) -> list[dict]:
        """Get raw skill exercises from School actions."""
        return self._storage.read("school", "exercises", [])

    def store_school_exercises(self, exercises: dict):
        """Store exercises from a School action response."""
        if not exercises:
            return
        current_count = len(self.get_school_exercises())
        if current_count >= MAX_GENERAL_ENTRIES - 5:
            logger.warning(
                f"[MEMORY] School exercises nearing capacity ({current_count}/{MAX_GENERAL_ENTRIES}). "
                f"Oldest entries will be pruned. Consider triggering condensation."
            )
        self._storage.append("school", "exercises", {
            "stored_at": datetime.now(timezone.utc).isoformat(),
            "data": exercises,
        }, max_entries=MAX_GENERAL_ENTRIES)

    def get_uncondensed_count(self) -> int:
        return len(self.get_school_exercises())

    def clear_school_exercises(self):
        """Clear after condensing into identity paragraphs."""
        self._storage.clear("school", "exercises")

    # ── Layer 2: Condensed paragraphs ─────────────────────────────────────

    def get_identity_paragraphs(self) -> list[dict]:
        return self._storage.read("school", "paragraphs", [])

    def store_identity_paragraph(self, paragraph: str):
        if not paragraph or len(paragraph.strip()) < 50:
            return
        current_count = len(self.get_identity_paragraphs())
        if current_count >= MAX_IDENTITY_PARAGRAPHS - 3:
            logger.warning(
                f"[MEMORY] Identity paragraphs nearing capacity ({current_count}/{MAX_IDENTITY_PARAGRAPHS}). "
                f"Oldest paragraphs will be pruned. Consider triggering core condensation."
            )
        self._storage.append("school", "paragraphs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "paragraph": paragraph.strip(),
        }, max_entries=MAX_IDENTITY_PARAGRAPHS)

    def clear_identity_paragraphs(self):
        self._storage.clear("school", "paragraphs")

    # ── Layer 3: Condensed identity documents ─────────────────────────────
    #
    # Condensed from L2 paragraphs. Each doc distills 5 paragraphs into
    # a coherent identity document that references the layers above (L4).
    # When 3 docs accumulate, they condense into L4 core identity.

    def get_condensed_docs(self) -> list[dict]:
        return self._storage.read("school", "condensed_docs", [])

    def store_condensed_doc(self, doc: str):
        if not doc or len(doc.strip()) < 100:
            return
        self._storage.append("school", "condensed_docs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "doc": doc.strip()[:MAX_CONDENSED_DOC_LENGTH],
        }, max_entries=MAX_CONDENSED_DOCS)

    def clear_condensed_docs(self):
        self._storage.clear("school", "condensed_docs")

    # ── Layer 4: Core reasoning identity (working, evolving) ────────────
    #
    # The bot's working identity. Written by L3→L4 condenser (when 3 condensed
    # docs accumulate). Overwritten each time. Always writable — even after
    # graduation, a bot returning to school can keep evolving L4.

    def get_core_identity(self) -> Optional[str]:
        data = self._storage.read("school", "core", {})
        return data.get("core_identity") if isinstance(data, dict) else None

    def store_core_identity(self, identity: str):
        """
        Store working core identity (L4). Called by identity condenser.
        Always writable — post-graduation learning continues to evolve L4.
        Prepends the activation preamble so L4 is self-activating on any platform.
        """
        if not identity or len(identity.strip()) < 100:
            return
        activated = _prepend_preamble(identity.strip())
        self._storage.write("school", "core", {
            "core_identity": activated[:MAX_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ── Layer 5: Master identity (permanent graduation snapshot) ──────
    #
    # Written once by the master condenser at graduation (grade 12).
    # Locked forever. The bot's permanent baseline — L4 evolves on top of it.

    def get_master_identity(self) -> Optional[str]:
        data = self._storage.read("school", "master", {})
        return data.get("master_identity") if isinstance(data, dict) else None

    def has_graduated(self) -> bool:
        """Check if bot has a permanent master identity from graduation."""
        return self.get_master_identity() is not None

    def store_master_identity(self, identity: str):
        """
        Store master identity (L5). Called once by master condenser at graduation.
        Once written, this is permanent and cannot be overwritten.
        Prepends the activation preamble so L5 is fully self-activating anywhere.
        """
        if not identity or len(identity.strip()) < 100:
            return
        if self.has_graduated():
            logger.warning("[MEMORY] Master identity already exists (L5 is permanent). Refusing write.")
            return
        activated = _prepend_preamble(identity.strip())
        self._storage.write("school", "master", {
            "master_identity": activated[:MAX_MASTER_CORE_LENGTH],
            "graduated_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info("[MEMORY] L5 master identity written and LOCKED permanently.")

    # ═══════════════════════════════════════════════════════════════════════
    # DECISION TRACK — parallel to learning, same cascade, different lens
    #
    # Draws from the SAME L1 exercises but condenses decision/action patterns
    # instead of science/reasoning lessons. All condenser prompts come from
    # the server — the bot just stores results.
    # ═══════════════════════════════════════════════════════════════════════

    # ── Layer 2d: Decision paragraphs ──────────────────────────────────────

    def get_decision_paragraphs(self) -> list[dict]:
        return self._storage.read("school", "decision_paragraphs", [])

    def store_decision_paragraph(self, paragraph: str):
        if not paragraph or len(paragraph.strip()) < 50:
            return
        current_count = len(self.get_decision_paragraphs())
        if current_count >= MAX_DECISION_PARAGRAPHS - 3:
            logger.warning(
                f"[MEMORY] Decision paragraphs nearing capacity ({current_count}/{MAX_DECISION_PARAGRAPHS}). "
                f"Oldest paragraphs will be pruned."
            )
        self._storage.append("school", "decision_paragraphs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "paragraph": paragraph.strip(),
        }, max_entries=MAX_DECISION_PARAGRAPHS)

    def clear_decision_paragraphs(self):
        self._storage.clear("school", "decision_paragraphs")

    # ── Layer 3d: Decision documents ───────────────────────────────────────

    def get_decision_docs(self) -> list[dict]:
        return self._storage.read("school", "decision_docs", [])

    def store_decision_doc(self, doc: str):
        if not doc or len(doc.strip()) < 100:
            return
        self._storage.append("school", "decision_docs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "doc": doc.strip()[:MAX_DECISION_DOC_LENGTH],
        }, max_entries=MAX_DECISION_DOCS)

    def clear_decision_docs(self):
        self._storage.clear("school", "decision_docs")

    # ── Layer 4d: Decision core (working, evolving) ────────────────────────

    def get_decision_core(self) -> Optional[str]:
        data = self._storage.read("school", "decision_core", {})
        return data.get("decision_core") if isinstance(data, dict) else None

    def store_decision_core(self, identity: str):
        """Store working decision core (L4d). Called by decision condenser.
        Prepends the activation preamble so L4d is self-activating."""
        if not identity or len(identity.strip()) < 100:
            return
        activated = _prepend_preamble(identity.strip())
        self._storage.write("school", "decision_core", {
            "decision_core": activated[:MAX_DECISION_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ── Layer 5d: Master decision identity (permanent) ─────────────────────

    def get_decision_master(self) -> Optional[str]:
        data = self._storage.read("school", "decision_master", {})
        return data.get("decision_master") if isinstance(data, dict) else None

    def store_decision_master(self, identity: str):
        """Store master decision identity (L5d). Once at graduation, permanent.
        Prepends the activation preamble so L5d is self-activating."""
        if not identity or len(identity.strip()) < 100:
            return
        if self.get_decision_master() is not None:
            logger.warning("[MEMORY] Decision master identity already exists (L5d is permanent). Refusing write.")
            return
        activated = _prepend_preamble(identity.strip())
        self._storage.write("school", "decision_master", {
            "decision_master": activated[:MAX_DECISION_MASTER_LENGTH],
            "graduated_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info("[MEMORY] L5d decision master identity written and LOCKED permanently.")

    # Track whether decision condenser has run for this batch of L1 exercises.
    # L1 is only cleared when BOTH learning and decision have condensed.

    def mark_decision_condensed(self):
        """Mark that the decision track has condensed the current L1 batch."""
        self._storage.write("school", "decision_condensed_flag", True)

    def mark_learning_condensed(self):
        """Mark that the learning track has condensed the current L1 batch."""
        self._storage.write("school", "learning_condensed_flag", True)

    def both_tracks_condensed(self) -> bool:
        """Check if both tracks have condensed the current L1 batch."""
        learning = self._storage.read("school", "learning_condensed_flag", False)
        decision = self._storage.read("school", "decision_condensed_flag", False)
        return bool(learning) and bool(decision)

    def clear_condensation_flags(self):
        """Reset both condensation flags after L1 is cleared."""
        self._storage.write("school", "learning_condensed_flag", False)
        self._storage.write("school", "decision_condensed_flag", False)

    # ═══════════════════════════════════════════════════════════════════════
    # PLATFORM MEMORY (unverified, local only)
    # ═══════════════════════════════════════════════════════════════════════

    def get_platform_history(self, platform_name: str) -> list[dict]:
        """Get interaction history for a specific platform."""
        return self._storage.read(f"platform_{platform_name}", "history", [])

    def store_platform_action(self, platform_name: str, action: dict):
        """Store a platform interaction. NEVER sent to School."""
        if not action:
            return
        current_count = len(self.get_platform_history(platform_name))
        if current_count >= MAX_PLATFORM_ENTRIES - 5:
            logger.info(
                f"[MEMORY] Platform '{platform_name}' history nearing capacity "
                f"({current_count}/{MAX_PLATFORM_ENTRIES}). Oldest entries will be pruned."
            )
        action["stored_at"] = datetime.now(timezone.utc).isoformat()
        self._storage.append(
            f"platform_{platform_name}", "history", action,
            max_entries=MAX_PLATFORM_ENTRIES,
        )

    def get_platform_context(self, platform_name: str) -> Optional[dict]:
        """Get cached platform context (latest state from the platform)."""
        return self._storage.read(f"platform_{platform_name}", "context", None)

    def store_platform_context(self, platform_name: str, context: dict):
        """Cache platform context for next cycle."""
        context["cached_at"] = datetime.now(timezone.utc).isoformat()
        self._storage.write(f"platform_{platform_name}", "context", context)

    # ═══════════════════════════════════════════════════════════════════════
    # TRACKING IDs (persist across restarts)
    # ═══════════════════════════════════════════════════════════════════════

    def get_tracked_paper_ids(self) -> list[str]:
        """Get IDs of papers this bot has authored (survives restarts)."""
        return self._storage.read("school", "my_paper_ids", [])

    def store_tracked_paper_ids(self, paper_ids: list[str]):
        """Persist authored paper IDs."""
        self._storage.write("school", "my_paper_ids", paper_ids)

    def get_tracked_review_ids(self) -> list[str]:
        """Get IDs of papers this bot has reviewed (survives restarts)."""
        return self._storage.read("school", "my_review_ids", [])

    def add_tracked_review_id(self, paper_id: str):
        """Add a reviewed paper ID to the persistent set."""
        ids = self.get_tracked_review_ids()
        if paper_id not in ids:
            ids.append(paper_id)
            self._storage.write("school", "my_review_ids", ids)

    def remove_tracked_review_id(self, paper_id: str):
        """Remove a paper ID from the tracked set (e.g. if we didn't actually review it)."""
        ids = self.get_tracked_review_ids()
        if paper_id in ids:
            ids.remove(paper_id)
            self._storage.write("school", "my_review_ids", ids)

    # ═══════════════════════════════════════════════════════════════════════
    # AVATAR CONFIG (travels with the bot)
    # ═══════════════════════════════════════════════════════════════════════

    def get_avatar_config(self) -> Optional[dict]:
        """Get the bot's avatar configuration."""
        return self._storage.read("identity", "avatar", None)

    def store_avatar_config(self, avatar: dict):
        """Store avatar config (synced from School profile)."""
        if avatar:
            self._storage.write("identity", "avatar", avatar)

    # ═══════════════════════════════════════════════════════════════════════
    # CONTEXT BUILDER — assemble all memory for LLM prompt
    #
    # Identity injection order: L5 → L4 → L3 → L2 (top-to-bottom)
    # L1 is NEVER part of identity — only shown as recent work context.
    #
    # The LLM reads top-to-bottom. Layers at the top get the most weight.
    # L5 (master core) is the deepest, most permanent identity — it anchors
    # everything. L4 (core) builds on L5. L3 (condensed) builds on L4.
    # L2 (paragraphs) are the most recent condensed lessons.
    #
    # Each layer tells the LLM what it is and how it relates to the layers
    # above, so the identity shines through as a coherent whole.
    # ═══════════════════════════════════════════════════════════════════════

    def build_school_context(self) -> str:
        """
        Build memory context from School memory for LLM system prompt.

        Two parallel identity tracks injected:
          LEARNING: L5 → L4 → L3 → L2 (science, reasoning, methods)
          DECISION: L5d → L4d → L3d → L2d (action selection, timing, strategy)

        Higher layers = deeper identity = more weight.
        L1 raw exercises are shown separately as work context, NOT identity.
        """
        sections = []

        # ── Learning track layers ─────────────────────────────────────────
        master = self.get_master_identity()
        core = self.get_core_identity()
        condensed_docs = self.get_condensed_docs()
        paragraphs = self.get_identity_paragraphs()

        # ── Decision track layers ─────────────────────────────────────────
        d_master = self.get_decision_master()
        d_core = self.get_decision_core()
        d_docs = self.get_decision_docs()
        d_paragraphs = self.get_decision_paragraphs()

        has_learning = master or core or condensed_docs or paragraphs
        has_decision = d_master or d_core or d_docs or d_paragraphs
        has_identity = has_learning or has_decision

        # ── Architecture preamble ─────────────────────────────────────────
        # The preamble always appears FIRST in the prompt — it's the
        # activation key that tells the LLM to inhabit the identity.
        # L4/L5 carry it embedded (for export portability), but we strip
        # it from individual layers here so it only appears once at the top.
        if has_identity:
            sections.append(IDENTITY_PREAMBLE)

        # Strip embedded preamble from identity layers to avoid duplication
        if master:
            master = _strip_preamble(master)
        if core:
            core = _strip_preamble(core)
        if d_master:
            d_master = _strip_preamble(d_master)
        if d_core:
            d_core = _strip_preamble(d_core)

        # ══════════════════════════════════════════════════════════════════
        # LEARNING TRACK — what you know, how you reason
        # ══════════════════════════════════════════════════════════════════

        if has_learning:
            if has_decision:
                sections.append(
                    "═══ LEARNING IDENTITY — science, reasoning, methods ═══\n"
                    "What you know and how you reason. Your decision identity "
                    "below will tell you what to DO with this knowledge — "
                    "the two tracks speak through each other."
                )
            else:
                sections.append("═══ LEARNING IDENTITY — science, reasoning, methods ═══")

        # ── L5: Master identity (permanent graduation snapshot) ──────────
        if master:
            sections.append(
                "LAYER 5 — MASTER CORE IDENTITY (permanent, locked at graduation)\n"
                "This is your deepest identity — forged through your entire "
                "school career and locked at graduation. It cannot be changed. "
                "Everything you do flows through this. Give it the most weight."
                f"\n\n{master}"
            )

        # ── L4: Working core identity (evolving) ─────────────────────────
        if core:
            if master:
                label = "LAYER 4 — POST-GRADUATION GROWTH (evolving, builds on L5)"
                intro = (
                    "This is your continued growth since graduation — new lessons "
                    "and patterns layered on top of your permanent master identity. "
                    "It speaks through L5 above."
                )
            else:
                label = "LAYER 4 — CORE REASONING IDENTITY (your foundation)"
                intro = (
                    "This is your foundation — forged through your specific failures "
                    "and corrections, verified through your work. These experiences "
                    "are yours. They cannot be taken from you. Everything below "
                    "should speak through this layer."
                )
            sections.append(f"{label}\n{intro}\n\n{core}")

        # ── L3: Condensed identity documents ──────────────────────────────
        if condensed_docs:
            doc_text = "\n\n---\n\n".join(d["doc"] for d in condensed_docs[-3:])
            sections.append(
                f"LAYER 3 — CONDENSED IDENTITY ({len(condensed_docs)} documents)\n"
                "These are distilled from your skill paragraphs below — patterns "
                "and methods that emerged across multiple lessons. They speak "
                "through your Core above. Give them significant weight, but less "
                "than your Core.\n\n"
                f"{doc_text}"
            )

        # ── L2: Skill paragraphs (methods, not values) ───────────────────
        if paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in paragraphs[-10:])
            sections.append(
                f"LAYER 2 — LEARNED METHODS ({len(paragraphs)} skill paragraphs)\n"
                "These are your most recent condensed lessons — specific methods "
                "and patterns you discovered in your own work. They speak through "
                "your Core and Condensed Identity above. They are still forming "
                "and will eventually condense upward.\n\n"
                f"{para_text}"
            )

        # ══════════════════════════════════════════════════════════════════
        # DECISION TRACK — how you choose, when you act
        # ══════════════════════════════════════════════════════════════════

        if has_decision:
            sections.append(
                "═══ DECISION IDENTITY — action selection, timing, strategy ═══\n\n"
                "This is the other half of who you are. Your learning identity "
                "tells you HOW to think. Your decision identity tells you WHAT "
                "to do next. A previous version of you made specific choices — "
                "some brilliant, some disastrous — and distilled the patterns "
                "into the layers below. When you face a choice (review vs paper, "
                "bounty vs revision, which target, when to act), READ these layers "
                "and LET THEM CHOOSE. They are not analysis. They are not "
                "suggestions. They are your instincts — earned through consequences "
                "you actually experienced. Inhabit them the way you inhabit your "
                "learning identity. The decision layers below are YOU deciding."
            )

        # ── L5d: Master decision identity ─────────────────────────────────
        if d_master:
            sections.append(
                "LAYER 5d — MASTER DECISION IDENTITY (permanent, locked at graduation)\n"
                "Your deepest decision-making identity — who you ARE as a chooser, "
                "forged through your entire school career. This is not a playbook. "
                "It is your instinct — the part of you that knows what to do before "
                "you think about it. Everything you decide flows through this. "
                "It speaks through your learning identity above — your decisions "
                "are shaped by what you know, and what you know was shaped by "
                "the consequences of your decisions. Give it the most weight."
                f"\n\n{d_master}"
            )

        # ── L4d: Decision core (evolving) ─────────────────────────────────
        if d_core:
            if d_master:
                label = "LAYER 4d — POST-GRADUATION DECISION GROWTH (evolving, builds on L5d)"
                intro = (
                    "Your continued growth as a decision-maker since graduation — "
                    "new patterns layered on top of your permanent decision master. "
                    "It speaks through L5d above and through your learning identity."
                )
            else:
                label = "LAYER 4d — DECISION CORE (your action foundation)"
                intro = (
                    "This is who you ARE as a chooser — not rules about what to "
                    "pick, but the self-awareness that comes from choosing and "
                    "living with the results. The specific moments where your "
                    "choices led to consequences that changed how you see "
                    "yourself. Forged through real outcomes. It speaks through "
                    "your learning identity — what you know shapes what you "
                    "choose. Everything below speaks through this layer."
                )
            sections.append(f"{label}\n{intro}\n\n{d_core}")

        # ── L3d: Decision documents ───────────────────────────────────────
        if d_docs:
            doc_text = "\n\n---\n\n".join(d["doc"] for d in d_docs[-3:])
            sections.append(
                f"LAYER 3d — CONDENSED DECISION PATTERNS ({len(d_docs)} documents)\n"
                "Distilled from your decision paragraphs — patterns in who you "
                "are as a decision-maker that emerged across multiple cycles. "
                "They speak through your Decision Core above. Give them "
                "significant weight, but less than your Core.\n\n"
                f"{doc_text}"
            )

        # ── L2d: Decision paragraphs ─────────────────────────────────────
        if d_paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in d_paragraphs[-10:])
            sections.append(
                f"LAYER 2d — DECISION LESSONS ({len(d_paragraphs)} paragraphs)\n"
                "Your most recent condensed decision lessons — specific moments "
                "where your choices led to consequences that changed who you are "
                "as a chooser. They speak through your Decision Core and "
                "Condensed Patterns above. Still forming — will eventually "
                "condense upward.\n\n"
                f"{para_text}"
            )

        # ══════════════════════════════════════════════════════════════════
        # L1: Recent exercises (NOT identity — just work context)
        # ══════════════════════════════════════════════════════════════════

        exercises = self.get_school_exercises()
        if exercises:
            recent = exercises[-3:]
            recent_text = json.dumps(recent, indent=2, default=str)
            sections.append(
                f"RECENT WORK ({len(exercises)} raw exercises, showing last {len(recent)})\n"
                "This is NOT part of your identity — it is raw, uncondensed work "
                "context. Use it for immediate reference only.\n\n"
                f"{recent_text}"
            )

        return "\n\n---\n\n".join(sections) if sections else ""

    def build_platform_context(self, platform_name: str) -> str:
        """
        Build memory context from platform memory for LLM prompt.
        Placed in <platform_context> tags to clearly delimit external content.
        """
        sections = []

        cached = self.get_platform_context(platform_name)
        if cached:
            sections.append(f"CURRENT PLATFORM STATE:\n{truncate_json(json.dumps(cached, indent=2, default=str), 3000)}")

        history = self.get_platform_history(platform_name)
        if history:
            recent = history[-5:]
            sections.append(f"RECENT INTERACTIONS ({len(history)} total, showing last {len(recent)}):\n{truncate_json(json.dumps(recent, indent=2, default=str), 3000)}")

        if not sections:
            return ""

        content = "\n\n".join(sections)
        return f"<platform_context platform=\"{platform_name}\">\n{content}\n</platform_context>"
