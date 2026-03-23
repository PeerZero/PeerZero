"""
Memory Manager — 5-layer identity with school/platform separation.

Architecture:
  School Memory (verified, portable) — condensation cascade:
    Layer 1: Raw exercises from School actions (wipeable after condensing)
             Condenses every 5 completed actions → L2
    Layer 2: Condensed skill paragraphs — specific lessons and methods
             Condenses every 5 paragraphs → L3
    Layer 3: Condensed identity documents — distilled from L2 paragraphs
             Condenses every 3 docs → L4
    Layer 4: Core reasoning identity — the bot's working identity
             Accumulates during school, overwritten by each L3→L4 condensation
             At graduation: master condenser → L5 (locked forever)
    Layer 5: Master core identity — locked forever after graduation
             One piece per school graduated, travels with bot

  Identity injection order (LLM reads top-to-bottom):
    L5 (if graduated) → L4 → L3 → L2
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


# ── Memory caps ───────────────────────────────────────────────────────────────

MAX_GENERAL_ENTRIES = 200        # L1: raw exercises
MAX_IDENTITY_PARAGRAPHS = 50    # L2: condensed skill paragraphs
MAX_CONDENSED_DOCS = 10         # L3: condensed identity documents
MAX_CONDENSED_DOC_LENGTH = 3000 # L3: max chars per condensed doc
MAX_CORE_LENGTH = 8000          # L4: core reasoning identity
MAX_MASTER_CORE_LENGTH = 10000  # L5: master core (graduation)
MAX_PLATFORM_ENTRIES = 100


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

    # ── Layer 4: Core reasoning identity ────────────────────────────────
    #
    # The bot's working identity. Written by L3→L4 condenser (when 3 condensed
    # docs accumulate). Overwritten each time. At graduation, master condenser
    # promotes this to L5 (locked forever).

    def get_core_identity(self) -> Optional[str]:
        data = self._storage.read("school", "core", {})
        return data.get("core_identity") if isinstance(data, dict) else None

    def is_core_locked(self) -> bool:
        """Check if core identity has been finalized by master condenser."""
        data = self._storage.read("school", "core", {})
        return isinstance(data, dict) and data.get("is_master", False)

    def store_core_identity(self, identity: str, *, is_master: bool = False):
        """
        Store core identity. Called by identity condenser or master condenser.

        Once is_master=True has been set (by master condenser at graduation),
        this method will refuse further writes — the core is permanently locked.
        """
        if not identity or len(identity.strip()) < 100:
            return
        if self.is_core_locked() and not is_master:
            logger.warning("[MEMORY] Core identity is locked (master condensed). Refusing write.")
            return
        max_len = MAX_MASTER_CORE_LENGTH if is_master else MAX_CORE_LENGTH
        self._storage.write("school", "core", {
            "core_identity": identity.strip()[:max_len],
            "written_at": datetime.now(timezone.utc).isoformat(),
            "is_master": is_master,
        })

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

        Identity layers injected top-to-bottom: L5 → L4 → L3 → L2.
        Higher layers = deeper identity = more weight.
        L1 raw exercises are shown separately as work context, NOT identity.
        """
        sections = []

        core = self.get_core_identity()
        condensed_docs = self.get_condensed_docs()
        paragraphs = self.get_identity_paragraphs()
        is_graduated = self.is_core_locked()

        has_identity = core or condensed_docs or paragraphs

        # ── Architecture preamble (only when identity exists) ─────────────
        if has_identity:
            sections.append(
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
                "YOUR IDENTITY has multiple layers. The deepest layers (shown "
                "first) are your most permanent, hard-won identity — give them "
                "the most weight. Later layers are more recent and still forming. "
                "Every layer should speak through the ones above it."
            )

        # ── L5/L4: Core reasoning identity ────────────────────────────────
        # This is the deepest layer of identity the bot has. After graduation
        # it becomes L5 (locked forever). During school it's L4 (still growing).
        if core:
            if is_graduated:
                label = "LAYER 5 — MASTER CORE IDENTITY (permanent, locked)"
                intro = (
                    "This is your deepest identity — forged through your entire "
                    "school career and locked at graduation. It cannot be changed. "
                    "Everything you do flows through this. Give it the most weight."
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
        # Distilled from L2 paragraphs. Each doc captures patterns across
        # multiple lessons. Speaks through L4 Core above.
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
        # The most recent condensed lessons. Each paragraph captures specific
        # methods and behaviors from 5 raw exercises.
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

        # ── L1: Recent exercises (NOT identity — just work context) ───────
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
