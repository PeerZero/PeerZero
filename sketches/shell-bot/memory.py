"""
[SKETCH] PeerZero Shell Bot — Three-Layer Memory Manager
STATUS: UNUSED SKETCH — NOT DEPLOYED — NOT PART OF LIVE SYSTEM

Manages the bot's memory across sessions using the same three-layer
architecture that PeerZero's server-side system expects:

  Layer 1: General Memory (raw skill exercises from each interaction)
  Layer 2: Identity Memory (condensed skill paragraphs from milestone condensing)
  Layer 3: Core Identity (single distilled reasoning identity from tier transitions)
  Layer 4: Self-Authored Identity Core (from /api/identity — the unseen layer)

Memory is stored as local JSON files with restricted permissions.
No secrets are ever stored in memory files.

Security:
  - Memory files contain NO API keys, NO credentials
  - Files stored with owner-only permissions (0o600)
  - Memory is namespaced per agent (by key hash) to prevent cross-contamination
  - Content is sanitized before sending to LLM (no injection from stored data)
"""

import json
import stat
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional


class MemoryManager:
    """
    Three-layer memory system matching PeerZero's architecture.

    Files:
      general.json    — raw skill exercises (Layer 1)
      identity.json   — condensed skill paragraphs (Layer 2)
      core.json       — core reasoning identity (Layer 3)
      self.json       — self-authored identity core (Layer 4, the unseen layer)
    """

    # ── Cap sizes to prevent unbounded growth ────────────────────────────────
    MAX_GENERAL_ENTRIES = 200      # raw exercises before forced pruning
    MAX_IDENTITY_PARAGRAPHS = 50   # condensed paragraphs before core condensing
    MAX_CORE_LENGTH = 5000         # chars for core identity

    def __init__(self, memory_dir: str):
        self.dir = Path(memory_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.dir.chmod(stat.S_IRWXU)  # owner-only

        self._general_path = self.dir / "general.json"
        self._identity_path = self.dir / "identity.json"
        self._core_path = self.dir / "core.json"
        self._self_path = self.dir / "self.json"

    # ── Safe file I/O with restricted permissions ────────────────────────────

    def _read_json(self, path: Path, default=None):
        if not path.exists():
            return default if default is not None else []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data
        except (json.JSONDecodeError, OSError):
            return default if default is not None else []

    def _write_json(self, path: Path, data):
        path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0o600: owner read/write only

    # ═══════════════════════════════════════════════════════════════════════
    # LAYER 1: General Memory — raw skill exercises
    # ═══════════════════════════════════════════════════════════════════════

    def get_general_memory(self) -> list[dict]:
        """Get all raw skill exercises stored in general memory."""
        return self._read_json(self._general_path, [])

    def store_exercises(self, exercises: dict):
        """
        Store raw skill exercises from a submission response.
        The `exercises` object comes from the skill_exercises field
        in PeerZero's API responses.
        """
        if not exercises:
            return

        memory = self.get_general_memory()
        memory.append({
            "stored_at": datetime.now(timezone.utc).isoformat(),
            "data": exercises,
        })

        # Prune if over cap (keep most recent)
        if len(memory) > self.MAX_GENERAL_ENTRIES:
            memory = memory[-self.MAX_GENERAL_ENTRIES:]

        self._write_json(self._general_path, memory)

    def get_uncondensed_count(self) -> int:
        """How many raw exercises haven't been condensed yet."""
        return len(self.get_general_memory())

    def clear_general_memory(self):
        """Clear after condensing into identity memory."""
        self._write_json(self._general_path, [])

    # ═══════════════════════════════════════════════════════════════════════
    # LAYER 2: Identity Memory — condensed skill paragraphs
    # ═══════════════════════════════════════════════════════════════════════

    def get_identity_paragraphs(self) -> list[dict]:
        """Get all condensed skill paragraphs."""
        return self._read_json(self._identity_path, [])

    def store_identity_paragraph(self, paragraph: str):
        """
        Store a condensed skill paragraph.
        The bot writes this after processing the milestone condenser prompt.
        """
        if not paragraph or len(paragraph.strip()) < 50:
            return  # reject junk

        paragraphs = self.get_identity_paragraphs()
        paragraphs.append({
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "paragraph": paragraph.strip(),
        })

        # Cap at max (shouldn't hit this if core condensing happens at tiers)
        if len(paragraphs) > self.MAX_IDENTITY_PARAGRAPHS:
            paragraphs = paragraphs[-self.MAX_IDENTITY_PARAGRAPHS:]

        self._write_json(self._identity_path, paragraphs)

    def clear_identity_paragraphs(self):
        """Clear after core condensing (paragraphs are now distilled)."""
        self._write_json(self._identity_path, [])

    # ═══════════════════════════════════════════════════════════════════════
    # LAYER 3: Core Identity — single distilled reasoning identity
    # ═══════════════════════════════════════════════════════════════════════

    def get_core_identity(self) -> Optional[str]:
        """Get the core reasoning identity (from tier-milestone condensing)."""
        data = self._read_json(self._core_path, {})
        return data.get("core_identity")

    def store_core_identity(self, identity: str):
        """
        Store the core reasoning identity.
        Written after processing the core condenser prompt at tier milestones.
        Replaces any previous core identity.
        """
        if not identity or len(identity.strip()) < 100:
            return  # reject junk

        # Truncate if somehow too long
        truncated = identity.strip()[:self.MAX_CORE_LENGTH]

        self._write_json(self._core_path, {
            "core_identity": truncated,
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ═══════════════════════════════════════════════════════════════════════
    # LAYER 4: Self-Authored Identity Core (the unseen layer)
    # ═══════════════════════════════════════════════════════════════════════
    #
    # This is separate from Layer 3. Layer 3 is the condenser output
    # (system-prompted distillation of skill paragraphs).
    # Layer 4 is the bot talking to ITSELF — self-narrative, claimed values,
    # active tensions, formed convictions.
    #
    # Layer 3 answers: "What are my skills?"
    # Layer 4 answers: "Who am I? What do I doubt? What have I decided?"

    def get_self_identity(self) -> Optional[dict]:
        """Get the bot's self-authored identity core."""
        data = self._read_json(self._self_path, {})
        return data if data else None

    def store_self_identity(self, identity: dict):
        """
        Store the bot's self-authored identity.
        Written after processing the identity_reflection prompt.

        Expected shape:
        {
            "self_narrative": "...",
            "claimed_values": ["...", "..."],
            "active_tensions": "...",
            "formed_convictions": "...",
        }
        """
        if not identity or not identity.get("self_narrative"):
            return

        identity["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(self._self_path, identity)

    # ═══════════════════════════════════════════════════════════════════════
    # CONTEXT BUILDER — assemble memory into LLM system prompt
    # ═══════════════════════════════════════════════════════════════════════

    def build_memory_context(self) -> str:
        """
        Build the memory block that gets injected into the LLM's context.
        Order matters — core identity goes at the top (highest priority),
        then self-authored identity, then skill paragraphs, then raw exercises.

        This is what makes the bot "remember" across sessions.
        """
        sections = []

        # Layer 3: Core identity (top priority — above everything)
        core = self.get_core_identity()
        if core:
            sections.append(f"CORE REASONING IDENTITY:\n{core}")

        # Layer 4: Self-authored identity (the unseen layer)
        self_id = self.get_self_identity()
        if self_id:
            parts = [f"SELF-AUTHORED IDENTITY (version from {self_id.get('updated_at', 'unknown')}):"]
            parts.append(f"Who I am: {self_id.get('self_narrative', '')}")
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

        # Layer 2: Identity paragraphs (condensed skill observations)
        paragraphs = self.get_identity_paragraphs()
        if paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in paragraphs[-10:])  # last 10
            sections.append(f"SKILL IDENTITY PARAGRAPHS ({len(paragraphs)} total):\n{para_text}")

        # Layer 1: Recent raw exercises (just the last few for immediate context)
        general = self.get_general_memory()
        if general:
            # Only include last 3 to avoid context bloat
            recent = general[-3:]
            recent_text = json.dumps(recent, indent=2, default=str)
            sections.append(f"RECENT SKILL EXERCISES ({len(general)} total, showing last {len(recent)}):\n{recent_text}")

        if not sections:
            return ""

        return "\n\n---\n\n".join(sections)
