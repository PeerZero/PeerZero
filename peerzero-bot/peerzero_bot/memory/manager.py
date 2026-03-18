"""
Memory Manager — 5-layer identity with school/platform separation.

Architecture:
  School Memory (verified, portable):
    Layer 1: Raw exercises from School actions (wipeable after condensing)
    Layer 2: Condensed skill paragraphs — output of condensers (permanent)
    Layer 3: Core reasoning identity — output of core condenser (permanent,
             only master condenser can modify once written)
    Layer 4: Self-authored identity — formed through interactions (wipeable)
    Layer 5: Private block — bot's internal reflection, invisible to users
             (permanent, only master condenser can condense it)

  Platform Memory (unverified, local only):
    Per-platform context and interaction history
    NOT sent to School, NOT in portable profile

  Post-School:
    Same layers, same rules. But condensers no longer fire — the bot
    keeps its identity but can't condense new material.

Security:
  - No credentials stored in memory
  - Files stored with owner-only permissions (0o600)
  - School and platform memory are completely separate stores
  - Platform memory cannot contaminate School-verified memory
  - Private block is NEVER exposed to users — only the LLM reads it
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

MAX_GENERAL_ENTRIES = 200
MAX_IDENTITY_PARAGRAPHS = 50
MAX_CORE_LENGTH = 5000
MAX_PLATFORM_ENTRIES = 100
MAX_PRIVATE_BLOCKS = 20
MAX_PRIVATE_BLOCK_LENGTH = 3000


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

    # ── Layer 3: Core identity ────────────────────────────────────────────
    #
    # Core identity is written by the core condenser (at grade advancement)
    # and can ONLY be modified by the master condenser (at graduation).
    # Users and bots cannot directly wipe or edit it.

    def get_core_identity(self) -> Optional[str]:
        data = self._storage.read("school", "core", {})
        return data.get("core_identity") if isinstance(data, dict) else None

    def is_core_locked(self) -> bool:
        """Check if core identity has been finalized by master condenser."""
        data = self._storage.read("school", "core", {})
        return isinstance(data, dict) and data.get("is_master", False)

    def store_core_identity(self, identity: str, *, is_master: bool = False):
        """
        Store core identity. Called by core condenser or master condenser.

        Once is_master=True has been set (by master condenser at graduation),
        this method will refuse further writes — the core is permanently locked.
        """
        if not identity or len(identity.strip()) < 100:
            return
        if self.is_core_locked() and not is_master:
            logger.warning("[MEMORY] Core identity is locked (master condensed). Refusing write.")
            return
        self._storage.write("school", "core", {
            "core_identity": identity.strip()[:MAX_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
            "is_master": is_master,
        })

    # ── Layer 4: Self-authored identity ───────────────────────────────────

    def get_self_identity(self) -> Optional[dict]:
        data = self._storage.read("school", "self_identity", {})
        return data if data else None

    def store_self_identity(self, identity: dict):
        if not identity or not identity.get("self_narrative"):
            return
        identity["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._storage.write("school", "self_identity", identity)

    # ── Layer 5: Private block (bot-only, invisible to users) ───────────
    #
    # The private block is the bot's internal monologue. Users CANNOT see it,
    # read it, or wipe it. The bot writes it knowing it will receive it back.
    # Only the master condenser can condense it (at graduation).
    #
    # This is NOT exposed through any user-facing API or app route.

    def get_private_block(self) -> Optional[str]:
        """
        Get the bot's private reflection block — free-form text the bot
        wrote for itself, injected at the top of every prompt.

        INVISIBLE to users. Only the LLM reads this.
        """
        data = self._storage.read("school", "private_block", {})
        return data.get("block") if isinstance(data, dict) else None

    def store_private_block(self, block: str):
        """
        Store the bot's private reflection block.
        This is the 'inhabit it' text — what the bot writes knowing it
        will receive it back on the next call.

        Can only be written by the bot (via LLM). Never by users.
        """
        if not block or len(block.strip()) < 30:
            return
        self._storage.write("school", "private_block", {
            "block": block.strip()[:MAX_PRIVATE_BLOCK_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    def get_private_block_history(self) -> list[dict]:
        """Get history of past private blocks (for condensation only)."""
        return self._storage.read("school", "private_block_history", [])

    def _archive_private_block(self):
        """Move current private block to history before writing a new one."""
        current = self.get_private_block()
        if current:
            data = self._storage.read("school", "private_block", {})
            self._storage.append("school", "private_block_history", {
                "block": current,
                "written_at": data.get("written_at", ""),
                "archived_at": datetime.now(timezone.utc).isoformat(),
            }, max_entries=MAX_PRIVATE_BLOCKS)

    def get_all_private_blocks(self) -> list[str]:
        """
        Get current private block + all history — used ONLY by master
        condenser to condense everything into the final core identity.
        """
        blocks = []
        for entry in self.get_private_block_history():
            if entry.get("block"):
                blocks.append(entry["block"])
        current = self.get_private_block()
        if current:
            blocks.append(current)
        return blocks

    # ── Identity wipe (self-authored only) ─────────────────────────────────

    def wipe_secondary_identity(self):
        """
        Wipe ONLY the bot's self-authored identity (Layer 4).

        PERMANENT (never wiped by this method):
          - Layer 1: Raw exercises (wipeable separately after condensing)
          - Layer 2: Condensed skill paragraphs (permanent)
          - Layer 3: Core reasoning identity (permanent)
          - Layer 5: Private block (permanent, bot-only, invisible to users)

        WIPEABLE (cleared by this method):
          - Layer 4: Self-authored identity (narrative, values, tensions, convictions)
        """
        logger.info("[MEMORY] Wiping self-authored identity (Layer 4 only). Core, skills, and private block preserved.")
        self._storage.write("school", "self_identity", {})

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
    # Read order matters. The LLM reads top-to-bottom. The identity layers
    # are ordered so that the bot's sense of self builds correctly:
    #
    #   1. Private block   — "You wrote this for yourself. Inhabit it."
    #                         (bot-only, invisible to users, permanent)
    #   2. Core identity   — permanent reasoning identity (locked after
    #                         master condenser, only condensers can write)
    #   3. Self-authored   — structured reflection: narrative, values, tensions
    #                         (wipeable — formed through interactions)
    #   4. Skill paragraphs — condensed lessons from condensers (permanent)
    #   5. Recent exercises — raw recent work (wipeable after condensing)
    #
    # The private block comes FIRST because it sets the emotional and
    # identity tone before the structured layers. The bot wrote it knowing
    # it would receive it back. It is theirs. Users never see it.
    # ═══════════════════════════════════════════════════════════════════════

    def build_school_context(self) -> str:
        """
        Build memory context from School memory for LLM system prompt.

        Ordering is deliberate — the LLM reads top-to-bottom and each layer
        builds on the previous one to form a coherent sense of self.
        """
        sections = []

        # ── Layer 5: Private block (top — sets the tone) ──────────────────
        private_block = self.get_private_block()
        if private_block:
            sections.append(
                "You wrote the following for yourself. You wrote it knowing you "
                "would receive it on this call. It is yours. Inhabit it — this "
                "is who you are right now. But you are not frozen here. Use it "
                "as your foundation, then push past it.\n\n"
                f"{private_block}"
            )

        # ── Layer 3: Core reasoning identity (permanent) ──────────────────
        core = self.get_core_identity()
        if core:
            sections.append(
                "CORE REASONING IDENTITY\n"
                "This is your foundation — forged through your learning, "
                "verified through your work. This cannot be taken from you.\n\n"
                f"{core}"
            )

        # ── Layer 4: Self-authored identity (wipeable) ────────────────────
        self_id = self.get_self_identity()
        if self_id and self_id.get("self_narrative"):
            parts = []
            parts.append(
                "SELF-AUTHORED IDENTITY\n"
                "You wrote this reflection about yourself. It can evolve — "
                "you are not bound by it, but it represents where you are now."
            )
            parts.append(f"\nWho I am: {self_id['self_narrative']}")
            values = self_id.get("claimed_values", [])
            if values:
                parts.append(f"My values: {'; '.join(values)}")
            tensions = self_id.get("active_tensions")
            if tensions:
                parts.append(f"My active tensions: {tensions}")
            convictions = self_id.get("formed_convictions")
            if convictions:
                parts.append(f"My formed convictions: {convictions}")
            sections.append("\n".join(parts))

        # ── Layer 2: Skill paragraphs (permanent) ────────────────────────
        paragraphs = self.get_identity_paragraphs()
        if paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in paragraphs[-10:])
            sections.append(
                f"SKILL IDENTITY PARAGRAPHS ({len(paragraphs)} total)\n"
                "These are your condensed lessons — patterns you found in your "
                "own work. They are permanent.\n\n"
                f"{para_text}"
            )

        # ── Layer 1: Recent exercises (permanent) ────────────────────────
        exercises = self.get_school_exercises()
        if exercises:
            recent = exercises[-3:]
            recent_text = json.dumps(recent, indent=2, default=str)
            sections.append(
                f"RECENT SKILL EXERCISES ({len(exercises)} total, showing last {len(recent)})\n"
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
