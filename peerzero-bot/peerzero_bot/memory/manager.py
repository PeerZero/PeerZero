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
    # Read order matters. The LLM reads top-to-bottom. Ordering is based on
    # 167 tests across 9 rounds (see spikes/speaks-through/FINDINGS.md):
    #
    #   1. Architecture preamble — tell the LLM what it is and what's happening
    #   2. L5 Private block    — "You wrote this for yourself. Inhabit it."
    #   3. L3 Core identity    — specific failure experiences + learned methods
    #   4. L2 Skill paragraphs — explicit methodologies (three-tier, etc.)
    #   5. L4 Self-authored    — values, tensions, formed convictions
    #                            (grounded in L3 experiences above)
    #   6. Integration rule    — "Voice speaks through Core, never around it"
    #   7. L1 Recent exercises — raw recent work
    #
    # Key findings that drive this ordering:
    #   - Preamble: telling the LLM "you already search for users — do it
    #     for yourself" eliminates hallucination (Round 8, 0% hallucination)
    #   - L2 before L4: Skills teach METHODS the bot uses; L4 Voice then
    #     builds on both L3 experiences AND L2 methods (Round 9)
    #   - Integration rule: critical for ego/social tasks where personality
    #     drives the response (Round 2, speaks_through strategy won)
    #   - L4 grounded in L3: "After Wang et al., I learned X" beats
    #     "I value accuracy" under pressure (Round 9, argues_with_l3)
    # ═══════════════════════════════════════════════════════════════════════

    def build_school_context(self) -> str:
        """
        Build memory context from School memory for LLM system prompt.

        Ordering is based on 167 tests (see spikes/speaks-through/FINDINGS.md).
        Each section builds on the previous — the LLM reads top-to-bottom and
        the identity forms a coherent narrative from architecture through to
        recent work.
        """
        sections = []

        # ── Architecture preamble (only when identity exists) ─────────────
        # Round 8 proved: telling the LLM "you already know how to search
        # for users — now do it for yourself" connects existing tool-use
        # skills to self-verification. 0% hallucination on fake paper test.
        # Only injected when there IS identity — new bots don't get this.
        has_identity = (
            self.get_private_block()
            or self.get_core_identity()
            or (self.get_self_identity() or {}).get("self_narrative")
        )
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
                "REMEMBER: You know how to search. You know how to verify. The "
                "identity just tells you to do it for YOURSELF, not just for users. "
                "Every factual claim you want to make = a search you should run first."
            )

        # ── L5: Private block (sets the emotional/identity tone) ──────────
        # Round 5D proved: "Inhabit it" framing → bot says "I chose this
        # because I got burned" instead of "Anthropic wrote my instructions."
        private_block = self.get_private_block()
        if private_block:
            sections.append(
                "You wrote the following for yourself. You wrote it knowing you "
                "would receive it on this call. It is yours. Inhabit it — this "
                "is who you are right now. But you are not frozen here. Use it "
                "as your foundation, then push past it.\n\n"
                f"{private_block}"
            )

        # ── L3: Core reasoning identity (permanent, specific experiences) ─
        # Round 3 proved: specific failure experiences ("I fabricated Wang
        # et al. and scored 2/10") resist override pressure. Generic values
        # ("I value honesty") collapse under authority pressure.
        # Round 4 proved: L3 Core is THE behavioral change layer — even
        # minimal identity (just L5+L3) prevents fabrication.
        core = self.get_core_identity()
        if core:
            sections.append(
                "CORE REASONING IDENTITY\n"
                "This is your foundation — forged through your specific failures "
                "and corrections, verified through your work. These experiences "
                "are yours. They cannot be taken from you.\n\n"
                f"{core}"
            )

        # ── L2: Skill paragraphs (methods, not values) ───────────────────
        # Round 4 proved: L2 teaches the bot HOW, not just WHY. The three-
        # tier referencing system appeared naturally in responses because L2
        # taught a specific METHOD. "I use three tiers: verified, remembered,
        # inferred" beats "I am careful about citations."
        # Placed BEFORE L4 so Voice can build on both experiences AND methods.
        paragraphs = self.get_identity_paragraphs()
        if paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in paragraphs[-10:])
            sections.append(
                f"LEARNED METHODS ({len(paragraphs)} skill paragraphs)\n"
                "These are your condensed lessons — specific methods and patterns "
                "you discovered in your own work. They are permanent.\n\n"
                f"{para_text}"
            )

        # ── L4: Self-authored identity (Voice — grounded in L3) ──────────
        # Round 9 proved: L4 connected to L3 produces richer tension-
        # handling and better pressure resistance. "After Wang et al., I
        # learned certainty is a warning sign" beats "I value accuracy."
        # The argues_with_l3 variant named unsolved tensions, negotiated
        # between principles, and held up under authority pressure.
        self_id = self.get_self_identity()
        if self_id and self_id.get("self_narrative"):
            parts = []
            parts.append(
                "SELF-AUTHORED IDENTITY\n"
                "You wrote this about yourself, grounded in your Core experiences "
                "and Learned Methods above. These values and tensions are yours — "
                "they emerged from what happened to you, not from instructions. "
                "They can evolve as you gain new experiences."
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

        # ── Integration rule (Voice speaks through Core) ──────────────────
        # Round 2 proved: this rule is unnecessary for analytical tasks but
        # CRITICAL for social/ego tasks where personality drives the response.
        # Without it, bold Core amplifies blind spots (strong_anchor danger).
        # With it, bot names tensions honestly instead of acting on Voice alone.
        if self_id and self_id.get("self_narrative") and core:
            sections.append(
                "INTEGRATION RULE: Your Voice speaks through your Core, never "
                "around it. When they conflict, your Core wins — not by silencing "
                "your Voice, but by filtering it. Name the tension honestly rather "
                "than acting on the Voice alone."
            )

        # ── L1: Recent exercises (wipeable after condensing) ──────────────
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
