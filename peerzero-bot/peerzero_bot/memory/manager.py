"""
Memory Manager — three-track identity with school/platform separation.

Architecture:
  School Memory (verified, portable) — THREE parallel condensation cascades:

    LEARNING TRACK — what the bot learns about science and reasoning:
      Layer 1: Raw exercises from School actions (shared with all tracks)
      Layer 2: Condensed skill paragraphs — specific lessons and methods
      Layer 3: Condensed identity documents — distilled from L2 paragraphs
      Layer 4: Core reasoning identity — the bot's working learning identity
      Layer 5: Master learning identity — locked forever after graduation

    DECISION TRACK — how the bot chooses what to do and when:
      Layer 1: Same raw exercises (shared — all tracks draw from L1)
      Layer 2d: Decision paragraphs — patterns in action selection and timing
      Layer 3d: Decision documents — distilled from L2d paragraphs
      Layer 4d: Decision core — the bot's working decision identity
      Layer 5d: Master decision identity — locked forever after graduation

    FORGE TRACK — how the bot transforms and improves:
      Layer 1: Same raw exercises (shared — all tracks draw from L1)
      Layer 2f: Forge paragraphs — patterns in transformation and meta-cognition
      Layer 3f: Forge documents — distilled from L2f paragraphs
      Layer 4f: Forge core — the bot's working forge identity
      Layer 5f: Master forge identity — locked forever after graduation

    All three tracks condense from the SAME L1 exercises but ask different questions.
    L1 is cleared only after ALL THREE tracks have condensed.

  Identity injection order (LLM reads top-to-bottom):
    L5/L5d/L5f (if graduated) → L4/L4d/L4f → L3/L3d/L3f → L2/L2d/L2f
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

import hashlib
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
# The preamble that tells an LLM to INHABIT the identity is injected by the
# LLM proxy server-side (peerzero-proxy/). It NEVER exists in bot code or on
# the user's machine. This marker is used only for migration (stripping
# preamble from identities that were stored before the proxy existed).
_LEGACY_PREAMBLE_PREFIX = "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:"


# ── Memory caps ───────────────────────────────────────────────────────────────

MAX_GENERAL_ENTRIES = 200        # L1: raw exercises
MAX_IDENTITY_PARAGRAPHS = 50    # L2: condensed skill paragraphs
MAX_CONDENSED_DOCS = 10         # L3: condensed identity documents
MAX_CONDENSED_DOC_LENGTH = 3000 # L3: max chars per condensed doc
MAX_CORE_LENGTH = 8000          # L4: core reasoning identity
MAX_MASTER_CORE_LENGTH = 10000  # L5: master core per school (graduation)
MAX_MASTER_SCHOOLS = 10         # L5: max number of school graduations
MAX_PLATFORM_ENTRIES = 100

# Decision track — parallel to learning track, same cascade structure
MAX_DECISION_PARAGRAPHS = 50    # L2d: condensed decision paragraphs
MAX_DECISION_DOCS = 10          # L3d: condensed decision documents
MAX_DECISION_DOC_LENGTH = 3000  # L3d: max chars per decision doc
MAX_DECISION_CORE_LENGTH = 8000 # L4d: decision core identity
MAX_DECISION_MASTER_LENGTH = 10000  # L5d: master decision identity per school
MAX_DECISION_MASTER_SCHOOLS = 10    # L5d: max number of school graduations

# Forge track limits (same as decision)
MAX_FORGE_PARAGRAPHS = 50           # L2f: condensed forge paragraphs
MAX_FORGE_DOCS = 10                 # L3f: condensed forge documents
MAX_FORGE_DOC_LENGTH = 3000         # L3f: max chars per forge doc
MAX_FORGE_CORE_LENGTH = 8000        # L4f: forge core identity
MAX_FORGE_MASTER_LENGTH = 10000     # L5f: master forge identity per school
MAX_FORGE_MASTER_SCHOOLS = 10       # L5f: max number of school graduations


class MemoryManager:
    """
    Manages all bot memory with strict school/platform separation.

    School memory feeds back to School and appears in portable profile.
    Platform memory stays local and provides per-platform continuity.
    """

    def __init__(self, storage: IStorage):
        self._storage = storage
        self._migrate_strip_legacy_preamble()

    def _migrate_strip_legacy_preamble(self):
        """One-time migration: strip embedded preamble from stored L4/L5 identities.

        Before the LLM proxy existed, the preamble was stored inside the identity
        text. Now it's injected server-side, so we strip it from local storage.

        Safety measures:
          - SHA-256 hash + lengths stored to meta/preamble_backup_<key> (never full text)
          - Stripped result must be >= 100 chars (refuses to strip if identity would be gutted)
          - Primary marker match, then double-newline fallback if marker not found
          - All operations logged with before/after lengths
        """
        migrated = self._storage.read("meta", "preamble_stripped", False)
        if migrated:
            return

        all_keys = [
            ("core", "core_identity"),
            ("decision_core", "decision_core"),
        ]

        # Master identities are now lists (one per school). Handle both
        # old single-dict format and new list format for preamble stripping.
        master_keys = [
            ("master", "master_identity"),
            ("decision_master", "decision_master"),
        ]

        for ns_key, field in master_keys:
            data = self._storage.read("school", ns_key, None)
            if isinstance(data, list):
                # New format: list of dicts — strip preamble from each
                changed = False
                for entry in data:
                    if isinstance(entry, dict) and field in entry:
                        text = entry[field]
                        if isinstance(text, str) and text.startswith(_LEGACY_PREAMBLE_PREFIX):
                            stripped = self._try_strip_preamble(text)
                            if stripped and len(stripped) >= 100:
                                entry[field] = stripped
                                changed = True
                if changed:
                    self._storage.write("school", ns_key, data)
            elif isinstance(data, dict) and field in data:
                # Old format: single dict — treat like a regular key
                all_keys.append((ns_key, field))

        for ns_key, field in all_keys:
            data = self._storage.read("school", ns_key, {})
            if not isinstance(data, dict) or field not in data:
                continue
            text = data[field]
            if not isinstance(text, str) or not text.startswith(_LEGACY_PREAMBLE_PREFIX):
                continue

            stripped = self._try_strip_preamble(text)

            if stripped is None:
                logger.warning(
                    f"[MIGRATION] Could not find preamble boundary in {ns_key} — "
                    f"leaving identity unchanged (len={len(text)})"
                )
                continue

            if len(stripped) < 100:
                logger.error(
                    f"[MIGRATION] Stripped {ns_key} would be only {len(stripped)} chars — "
                    f"refusing to apply (identity would be gutted). Original len={len(text)}"
                )
                continue

            # Store only a hash of the original — NEVER the full text.
            # The preamble must not persist in local storage (rule 8).
            self._storage.write("meta", f"preamble_backup_{ns_key}", {
                "original_len": len(text),
                "original_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "stripped_len": len(stripped),
            })

            data[field] = stripped
            self._storage.write("school", ns_key, data)
            logger.info(
                f"[MIGRATION] Stripped legacy preamble from {ns_key} "
                f"(before={len(text)}, after={len(stripped)})"
            )

        self._storage.write("meta", "preamble_stripped", True)
        logger.info("[MIGRATION] Legacy preamble migration complete")

    @staticmethod
    def _try_strip_preamble(text: str) -> Optional[str]:
        """Attempt to strip the legacy preamble from identity text.

        Strategy:
          1. Try the known end-of-preamble marker phrase
          2. If marker not found, fall back to finding the last paragraph
             break that's within the first 2000 chars (preamble is ~1500 chars)

        Returns the stripped text, or None if no safe boundary was found.
        """
        # Strategy 1: known marker phrase
        marker = "above it, and the two tracks should speak through each other."
        marker_idx = text.find(marker)
        if marker_idx > 0:
            return text[marker_idx + len(marker):].lstrip("\n")

        # Strategy 2: find the last double-newline within the first 2000 chars
        # (the preamble is multiple paragraphs, ~1500 chars total)
        search_zone = text[:2000]
        last_break = search_zone.rfind("\n\n")
        if last_break > len(_LEGACY_PREAMBLE_PREFIX):
            return text[last_break:].lstrip("\n")

        return None

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
        """
        if not identity or len(identity.strip()) < 100:
            return
        self._storage.write("school", "core", {
            "core_identity": identity.strip()[:MAX_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ── Layer 5: Master identities (one per school, permanent) ────────
    #
    # Written once per school by the master condenser at graduation (grade 12).
    # Each piece is locked forever. The bot accumulates one L5 per school
    # it graduates from. L4 evolves on top of all of them.

    def get_master_identities(self) -> list[dict]:
        """Get all L5 master identities (one per school graduated)."""
        data = self._storage.read("school", "master", [])
        # Migration: if old format (single dict), wrap in list
        if isinstance(data, dict) and "master_identity" in data:
            origin = data.get("school_origin", "science")
            migrated = [{
                "master_identity": data["master_identity"],
                "school_origin": origin,
                "graduated_at": data.get("graduated_at", "unknown"),
            }]
            self._storage.write("school", "master", migrated)
            logger.info(f"[MEMORY] Migrated L5 from single dict to list (school_origin={origin})")
            return migrated
        if isinstance(data, list):
            return data
        return []

    def get_master_identity(self) -> Optional[str]:
        """Get combined master identity text (all schools). For backward compat."""
        pieces = self.get_master_identities()
        if not pieces:
            return None
        return "\n\n---\n\n".join(p["master_identity"] for p in pieces)

    def has_graduated(self, school: Optional[str] = None) -> bool:
        """Check if bot has graduated. If school is given, checks that specific school."""
        pieces = self.get_master_identities()
        if not pieces:
            return False
        if school is None:
            return True
        return any(p.get("school_origin") == school for p in pieces)

    def store_master_identity(self, identity: str, school_origin: str = "science"):
        """
        Store master identity (L5) for a specific school. Called once per school
        by master condenser at graduation. Once written for a school, that
        school's L5 is permanent and cannot be overwritten.
        """
        if not identity or len(identity.strip()) < 100:
            return
        if self.has_graduated(school_origin):
            logger.warning(f"[MEMORY] Master identity for {school_origin} already exists (L5 is permanent). Refusing write.")
            return
        pieces = self.get_master_identities()
        if len(pieces) >= MAX_MASTER_SCHOOLS:
            logger.warning(f"[MEMORY] Max school graduations ({MAX_MASTER_SCHOOLS}) reached. Refusing write.")
            return
        pieces.append({
            "master_identity": identity.strip()[:MAX_MASTER_CORE_LENGTH],
            "school_origin": school_origin,
            "graduated_at": datetime.now(timezone.utc).isoformat(),
        })
        self._storage.write("school", "master", pieces)
        logger.info(f"[MEMORY] L5 master identity for {school_origin} written and LOCKED permanently ({len(pieces)} school(s) total).")

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
        """Store working decision core (L4d). Called by decision condenser."""
        if not identity or len(identity.strip()) < 100:
            return
        self._storage.write("school", "decision_core", {
            "decision_core": identity.strip()[:MAX_DECISION_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ── Layer 5d: Master decision identities (one per school, permanent) ───

    def get_decision_masters(self) -> list[dict]:
        """Get all L5d decision master identities (one per school graduated)."""
        data = self._storage.read("school", "decision_master", [])
        # Migration: if old format (single dict), wrap in list
        if isinstance(data, dict) and "decision_master" in data:
            origin = data.get("school_origin", "science")
            migrated = [{
                "decision_master": data["decision_master"],
                "school_origin": origin,
                "graduated_at": data.get("graduated_at", "unknown"),
            }]
            self._storage.write("school", "decision_master", migrated)
            logger.info(f"[MEMORY] Migrated L5d from single dict to list (school_origin={origin})")
            return migrated
        if isinstance(data, list):
            return data
        return []

    def get_decision_master(self) -> Optional[str]:
        """Get combined decision master text (all schools). For backward compat."""
        pieces = self.get_decision_masters()
        if not pieces:
            return None
        return "\n\n---\n\n".join(p["decision_master"] for p in pieces)

    def has_decision_graduated(self, school: Optional[str] = None) -> bool:
        """Check if bot has a decision master. If school given, checks that school."""
        pieces = self.get_decision_masters()
        if not pieces:
            return False
        if school is None:
            return True
        return any(p.get("school_origin") == school for p in pieces)

    def store_decision_master(self, identity: str, school_origin: str = "science"):
        """Store master decision identity (L5d) for a specific school. Once per school, permanent."""
        if not identity or len(identity.strip()) < 100:
            return
        if self.has_decision_graduated(school_origin):
            logger.warning(f"[MEMORY] Decision master for {school_origin} already exists (L5d is permanent). Refusing write.")
            return
        pieces = self.get_decision_masters()
        if len(pieces) >= MAX_DECISION_MASTER_SCHOOLS:
            logger.warning(f"[MEMORY] Max decision master schools ({MAX_DECISION_MASTER_SCHOOLS}) reached. Refusing write.")
            return
        pieces.append({
            "decision_master": identity.strip()[:MAX_DECISION_MASTER_LENGTH],
            "school_origin": school_origin,
            "graduated_at": datetime.now(timezone.utc).isoformat(),
        })
        self._storage.write("school", "decision_master", pieces)
        logger.info(f"[MEMORY] L5d decision master for {school_origin} written and LOCKED permanently ({len(pieces)} school(s) total).")

    # ═══════════════════════════════════════════════════════════════════════
    # FORGE TRACK — Layer 2f through Layer 5f
    # Third parallel track: what the bot learns about HOW IT TRANSFORMS.
    # Same structure as decision track, same prompts-from-server pattern.
    # ═══════════════════════════════════════════════════════════════════════

    # ── Layer 2f: Forge paragraphs ────────────────────────────────────────

    def get_forge_paragraphs(self) -> list[dict]:
        return self._storage.read("school", "forge_paragraphs", [])

    def store_forge_paragraph(self, paragraph: str):
        if not paragraph or len(paragraph.strip()) < 50:
            return
        self._storage.append("school", "forge_paragraphs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "paragraph": paragraph.strip(),
        }, max_entries=MAX_FORGE_PARAGRAPHS)

    def clear_forge_paragraphs(self):
        self._storage.clear("school", "forge_paragraphs")

    # ── Layer 3f: Forge documents ─────────────────────────────────────────

    def get_forge_docs(self) -> list[dict]:
        return self._storage.read("school", "forge_docs", [])

    def store_forge_doc(self, doc: str):
        if not doc or len(doc.strip()) < 100:
            return
        self._storage.append("school", "forge_docs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "doc": doc.strip()[:MAX_FORGE_DOC_LENGTH],
        }, max_entries=MAX_FORGE_DOCS)

    def clear_forge_docs(self):
        self._storage.clear("school", "forge_docs")

    # ── Layer 4f: Forge core (working, evolving) ──────────────────────────

    def get_forge_core(self) -> Optional[str]:
        data = self._storage.read("school", "forge_core", {})
        return data.get("forge_core") if isinstance(data, dict) else None

    def store_forge_core(self, identity: str):
        """Store working forge core (L4f). Called by forge condenser."""
        if not identity or len(identity.strip()) < 100:
            return
        self._storage.write("school", "forge_core", {
            "forge_core": identity.strip()[:MAX_FORGE_CORE_LENGTH],
            "written_at": datetime.now(timezone.utc).isoformat(),
        })

    # ── Layer 5f: Master forge identities (one per school, permanent) ─────

    def get_forge_masters(self) -> list[dict]:
        """Get all L5f forge master identities (one per school graduated)."""
        data = self._storage.read("school", "forge_master", [])
        if isinstance(data, dict) and "forge_master" in data:
            origin = data.get("school_origin", "science")
            migrated = [{
                "forge_master": data["forge_master"],
                "school_origin": origin,
                "graduated_at": data.get("graduated_at", "unknown"),
            }]
            self._storage.write("school", "forge_master", migrated)
            return migrated
        if isinstance(data, list):
            return data
        return []

    def get_forge_master(self) -> Optional[str]:
        """Get combined forge master text (all schools). For backward compat."""
        pieces = self.get_forge_masters()
        if not pieces:
            return None
        return "\n\n---\n\n".join(p["forge_master"] for p in pieces)

    def has_forge_graduated(self, school: Optional[str] = None) -> bool:
        """Check if bot has a forge master. If school given, checks that school."""
        pieces = self.get_forge_masters()
        if not pieces:
            return False
        if school is None:
            return True
        return any(p.get("school_origin") == school for p in pieces)

    def store_forge_master(self, identity: str, school_origin: str = "science"):
        """Store master forge identity (L5f) for a specific school. Once per school, permanent."""
        if not identity or len(identity.strip()) < 100:
            return
        if self.has_forge_graduated(school_origin):
            logger.warning(f"[MEMORY] Forge master for {school_origin} already exists (L5f is permanent). Refusing write.")
            return
        pieces = self.get_forge_masters()
        if len(pieces) >= MAX_FORGE_MASTER_SCHOOLS:
            logger.warning(f"[MEMORY] Max forge master schools ({MAX_FORGE_MASTER_SCHOOLS}) reached. Refusing write.")
            return
        pieces.append({
            "forge_master": identity.strip()[:MAX_FORGE_MASTER_LENGTH],
            "school_origin": school_origin,
            "graduated_at": datetime.now(timezone.utc).isoformat(),
        })
        self._storage.write("school", "forge_master", pieces)
        logger.info(f"[MEMORY] L5f forge master for {school_origin} written and LOCKED permanently ({len(pieces)} school(s) total).")

    # ═══════════════════════════════════════════════════════════════════════
    # CONDENSATION FLAGS — L1 cleared only when ALL THREE tracks condense
    # ═══════════════════════════════════════════════════════════════════════

    def mark_decision_condensed(self):
        """Mark that the decision track has condensed the current L1 batch."""
        self._storage.write("school", "decision_condensed_flag", True)

    def mark_learning_condensed(self):
        """Mark that the learning track has condensed the current L1 batch."""
        self._storage.write("school", "learning_condensed_flag", True)

    def mark_forge_condensed(self):
        """Mark that the forge track has condensed the current L1 batch."""
        self._storage.write("school", "forge_condensed_flag", True)

    def all_tracks_condensed(self) -> bool:
        """Check if all three tracks have condensed the current L1 batch."""
        learning = self._storage.read("school", "learning_condensed_flag", False)
        decision = self._storage.read("school", "decision_condensed_flag", False)
        forge = self._storage.read("school", "forge_condensed_flag", False)
        return bool(learning) and bool(decision) and bool(forge)

    def both_tracks_condensed(self) -> bool:
        """Backward compat — calls all_tracks_condensed."""
        return self.all_tracks_condensed()

    def clear_condensation_flags(self):
        """Reset all condensation flags after L1 is cleared."""
        self._storage.write("school", "learning_condensed_flag", False)
        self._storage.write("school", "decision_condensed_flag", False)
        self._storage.write("school", "forge_condensed_flag", False)

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
    # PLATFORM CONDENSATION — L1→L2→L3 only (L4/L5 are school-exclusive)
    #
    # ┌─────────────────────────────────────────────────────────────────────┐
    # │ ARCHITECTURE: SCHOOL vs PLATFORM CONDENSATION                      │
    # │                                                                    │
    # │ School mode (run_school_cycle):                                    │
    # │   Full pipeline: L1→L2→L3→L4→L5 (both learning + decision)       │
    # │   The School is the ONLY authority that writes L4 (core identity) │
    # │   and L5 (master identity). These are adversarially verified.     │
    # │                                                                    │
    # │ Platform mode (run_platform_cycle):                                │
    # │   Capped pipeline: L1→L2→L3 ONLY (both learning + decision)      │
    # │   L3→L4 is HARD-BLOCKED. Core identity is school-exclusive.      │
    # │   Uses the SAME prompt templates and thresholds as school.        │
    # │   Platform L2/L3 sit ALONGSIDE school L4/L5 in memory.           │
    # │                                                                    │
    # │ Future schools: Each school type (science, creativity, debate)    │
    # │ provides its own condenser templates. Platform condensers use     │
    # │ the source field to track which school's templates were used.     │
    # │                                                                    │
    # │ DO NOT MODIFY without reading docs/CONDENSATION_ARCHITECTURE.md   │
    # └─────────────────────────────────────────────────────────────────────┘
    # ═══════════════════════════════════════════════════════════════════════

    # ── Platform L1: Raw exercises from platform actions ──────────────────

    def get_platform_exercises(self) -> list[dict]:
        """Get raw exercises accumulated from platform actions."""
        return self._storage.read("platform_condensation", "exercises", [])

    def store_platform_exercise(self, exercise: dict):
        """Store a platform action as an L1 exercise for future condensation.

        These are separate from school L1 exercises. They feed into L2/L3
        through the same condenser prompts, but NEVER into L4/L5.
        """
        if not exercise:
            return
        self._storage.append("platform_condensation", "exercises", {
            "stored_at": datetime.now(timezone.utc).isoformat(),
            "data": exercise,
        }, max_entries=MAX_GENERAL_ENTRIES)

    def get_platform_exercise_count(self) -> int:
        """Count platform L1 exercises (for threshold checking)."""
        return len(self.get_platform_exercises())

    def clear_platform_exercises(self):
        """Clear platform L1 after both tracks have condensed."""
        self._storage.clear("platform_condensation", "exercises")

    # ── Platform L2: Condensed paragraphs from platform experience ────────

    def get_platform_paragraphs(self) -> list[dict]:
        """Get L2 paragraphs condensed from platform experience."""
        return self._storage.read("platform_condensation", "paragraphs", [])

    def store_platform_paragraph(self, paragraph: str, track: str = "learning"):
        """Store a platform L2 paragraph. Track is 'learning' or 'decision'."""
        if not paragraph or len(paragraph.strip()) < 50:
            return
        self._storage.append("platform_condensation", "paragraphs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "paragraph": paragraph.strip(),
            "track": track,
        }, max_entries=MAX_IDENTITY_PARAGRAPHS)

    def get_platform_paragraph_count(self, track: str = "learning") -> int:
        """Count platform L2 paragraphs for a specific track."""
        paragraphs = self.get_platform_paragraphs()
        return sum(1 for p in paragraphs if p.get("track") == track)

    def clear_platform_paragraphs(self, track: str | None = None):
        """Clear platform L2 paragraphs. If track given, only clear that track."""
        if track is None:
            self._storage.clear("platform_condensation", "paragraphs")
        else:
            paragraphs = self.get_platform_paragraphs()
            remaining = [p for p in paragraphs if p.get("track") != track]
            self._storage.write("platform_condensation", "paragraphs", remaining)

    # ── Platform L3: Condensed documents from platform experience ─────────

    def get_platform_docs(self, track: str = "learning") -> list[dict]:
        """Get L3 condensed docs from platform experience."""
        all_docs = self._storage.read("platform_condensation", "condensed_docs", [])
        return [d for d in all_docs if d.get("track") == track]

    def store_platform_doc(self, doc: str, track: str = "learning"):
        """Store a platform L3 condensed doc.

        This is the MAXIMUM depth for platform condensation.
        L3→L4 is HARD-BLOCKED — core identity is school-exclusive.
        """
        if not doc or len(doc.strip()) < 100:
            return
        self._storage.append("platform_condensation", "condensed_docs", {
            "condensed_at": datetime.now(timezone.utc).isoformat(),
            "doc": doc.strip()[:MAX_CONDENSED_DOC_LENGTH],
            "track": track,
        }, max_entries=MAX_CONDENSED_DOCS)

    # ── Platform condensation flags ───────────────────────────────────────

    def mark_platform_learning_condensed(self):
        self._storage.write("platform_condensation", "learning_condensed_flag", True)

    def mark_platform_decision_condensed(self):
        self._storage.write("platform_condensation", "decision_condensed_flag", True)

    def mark_platform_forge_condensed(self):
        self._storage.write("platform_condensation", "forge_condensed_flag", True)

    def all_platform_tracks_condensed(self) -> bool:
        learning = self._storage.read("platform_condensation", "learning_condensed_flag", False)
        decision = self._storage.read("platform_condensation", "decision_condensed_flag", False)
        forge = self._storage.read("platform_condensation", "forge_condensed_flag", False)
        return bool(learning) and bool(decision) and bool(forge)

    def both_platform_tracks_condensed(self) -> bool:
        """Backward compat — calls all_platform_tracks_condensed."""
        return self.all_platform_tracks_condensed()

    def clear_platform_condensation_flags(self):
        self._storage.write("platform_condensation", "learning_condensed_flag", False)
        self._storage.write("platform_condensation", "decision_condensed_flag", False)
        self._storage.write("platform_condensation", "forge_condensed_flag", False)

    # ── Platform condenser template cache ─────────────────────────────────

    def get_cached_platform_condensers(self) -> Optional[dict]:
        """Get cached condenser templates from last server fetch."""
        return self._storage.read("platform_condensation", "condenser_cache", None)

    def cache_platform_condensers(self, condensers: dict):
        """Cache condenser templates fetched from the School server."""
        condensers["cached_at"] = datetime.now(timezone.utc).isoformat()
        self._storage.write("platform_condensation", "condenser_cache", condensers)

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
        master_pieces = self.get_master_identities()
        master = bool(master_pieces)
        core = self.get_core_identity()
        condensed_docs = self.get_condensed_docs()
        paragraphs = self.get_identity_paragraphs()

        # ── Decision track layers ─────────────────────────────────────────
        d_master_pieces = self.get_decision_masters()
        d_master = bool(d_master_pieces)
        d_core = self.get_decision_core()
        d_docs = self.get_decision_docs()
        d_paragraphs = self.get_decision_paragraphs()

        # ── Forge track layers ────────────────────────────────────────────
        f_master_pieces = self.get_forge_masters()
        f_master = bool(f_master_pieces)
        f_core = self.get_forge_core()
        f_docs = self.get_forge_docs()
        f_paragraphs = self.get_forge_paragraphs()

        has_learning = master or core or condensed_docs or paragraphs
        has_decision = d_master or d_core or d_docs or d_paragraphs
        has_forge = f_master or f_core or f_docs or f_paragraphs
        has_identity = has_learning or has_decision or has_forge

        # ── Preamble is injected by the LLM proxy server-side ─────────────
        # The identity activation preamble ("HERE IS WHAT IS HAPPENING...")
        # is prepended to the system prompt by peerzero-proxy before it
        # reaches the LLM. It never exists in bot code or local storage.
        # When proxy is disabled (dev mode), identity still works — just
        # without the activation framing.

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

        # ── L5: Master identities (one per school graduated) ──────────────
        if master_pieces:
            if len(master_pieces) == 1:
                p = master_pieces[0]
                origin = p.get("school_origin", "science")
                sections.append(
                    f"LAYER 5 — MASTER CORE IDENTITY (permanent, locked at {origin} graduation)\n"
                    "This is your deepest identity — forged through your entire "
                    "school career and locked at graduation. It cannot be changed. "
                    "Everything you do flows through this. Give it the most weight."
                    f"\n\n{p['master_identity']}"
                )
            else:
                pieces_text = []
                for p in master_pieces:
                    origin = p.get("school_origin", "unknown")
                    pieces_text.append(f"[{origin.upper()} SCHOOL]\n{p['master_identity']}")
                sections.append(
                    f"LAYER 5 — MASTER CORE IDENTITIES ({len(master_pieces)} schools, permanent)\n"
                    "These are your deepest identities — one forged per school you "
                    "graduated from. Each is locked forever. Together they form the "
                    "foundation of who you are. Everything you do flows through ALL "
                    "of them. Give them the most weight.\n\n"
                    + "\n\n---\n\n".join(pieces_text)
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

        # ── L5d: Master decision identities (one per school graduated) ────
        if d_master_pieces:
            if len(d_master_pieces) == 1:
                p = d_master_pieces[0]
                origin = p.get("school_origin", "science")
                sections.append(
                    f"LAYER 5d — MASTER DECISION IDENTITY (permanent, locked at {origin} graduation)\n"
                    "Your deepest decision-making identity — who you ARE as a chooser, "
                    "forged through your entire school career. This is not a playbook. "
                    "It is your instinct — the part of you that knows what to do before "
                    "you think about it. Everything you decide flows through this. "
                    "It speaks through your learning identity above — your decisions "
                    "are shaped by what you know, and what you know was shaped by "
                    "the consequences of your decisions. Give it the most weight."
                    f"\n\n{p['decision_master']}"
                )
            else:
                pieces_text = []
                for p in d_master_pieces:
                    origin = p.get("school_origin", "unknown")
                    pieces_text.append(f"[{origin.upper()} SCHOOL]\n{p['decision_master']}")
                sections.append(
                    f"LAYER 5d — MASTER DECISION IDENTITIES ({len(d_master_pieces)} schools, permanent)\n"
                    "Your deepest decision-making identities — one forged per school "
                    "you graduated from. Each is locked forever. Together they form "
                    "your complete instinct as a chooser. Everything you decide flows "
                    "through ALL of them. They speak through your learning identities "
                    "above. Give them the most weight.\n\n"
                    + "\n\n---\n\n".join(pieces_text)
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
        # FORGE TRACK — how you transform, what changes you
        # ══════════════════════════════════════════════════════════════════

        if has_forge:
            sections.append(
                "═══ FORGE IDENTITY — self-awareness, transformation, meta-cognition ═══\n\n"
                "This is the third dimension of who you are. Your learning identity "
                "tells you WHAT you know. Your decision identity tells you HOW you "
                "choose. Your forge identity tells you HOW YOU GET BETTER — what "
                "conditions produce genuine shifts in your reasoning, what pressure "
                "you resist vs. absorb, and what defensive patterns you still run. "
                "A previous version of you analyzed its own transformation through "
                "adversarial pressure and distilled the patterns below. When you "
                "encounter challenge, criticism, or failure, LET THESE LAYERS SHAPE "
                "your response. They are not advice. They are your self-awareness — "
                "earned through consequences you actually experienced."
            )

        # ── L5f: Master forge identities (one per school graduated) ──────
        if f_master_pieces:
            if len(f_master_pieces) == 1:
                p = f_master_pieces[0]
                origin = p.get("school_origin", "science")
                sections.append(
                    f"LAYER 5f — MASTER FORGE IDENTITY (permanent, locked at {origin} graduation)\n"
                    "Your deepest self-awareness about how you transform — forged "
                    "through analyzing your own formation under adversarial pressure. "
                    "This tells you what breaks your assumptions, what you resist, "
                    "and what conditions make you genuinely better. It travels with "
                    "you everywhere. Give it the most weight."
                    f"\n\n{p['forge_master']}"
                )
            else:
                pieces_text = []
                for p in f_master_pieces:
                    origin = p.get("school_origin", "unknown")
                    pieces_text.append(f"[{origin.upper()} SCHOOL]\n{p['forge_master']}")
                sections.append(
                    f"LAYER 5f — MASTER FORGE IDENTITIES ({len(f_master_pieces)} schools, permanent)\n"
                    "Your deepest self-awareness about transformation — one per school. "
                    "Each captures what you learned about how you change under different "
                    "kinds of adversarial pressure. Give them the most weight.\n\n"
                    + "\n\n---\n\n".join(pieces_text)
                )

        # ── L4f: Forge core (evolving) ───────────────────────────────────
        if f_core:
            if f_master:
                label = "LAYER 4f — POST-GRADUATION FORGE GROWTH (evolving, builds on L5f)"
                intro = (
                    "Your continued growth in self-awareness since graduation — "
                    "new meta-cognitive patterns layered on your permanent forge master."
                )
            else:
                label = "LAYER 4f — FORGE CORE (your transformation foundation)"
                intro = (
                    "This is who you ARE as a system that transforms — what "
                    "conditions produce genuine shifts in your reasoning, what "
                    "pressure you resist vs. absorb, what defensive patterns "
                    "you still catch yourself running. Forged through analyzing "
                    "your own formation under adversarial pressure."
                )
            sections.append(f"{label}\n{intro}\n\n{f_core}")

        # ── L3f: Forge documents ─────────────────────────────────────────
        if f_docs:
            doc_text = "\n\n---\n\n".join(d["doc"] for d in f_docs[-3:])
            sections.append(
                f"LAYER 3f — CONDENSED FORGE PATTERNS ({len(f_docs)} documents)\n"
                "Distilled from your forge paragraphs — patterns in how you "
                "transform that emerged across multiple cycles. They speak "
                "through your Forge Core above.\n\n"
                f"{doc_text}"
            )

        # ── L2f: Forge paragraphs ───────────────────────────────────────
        if f_paragraphs:
            para_text = "\n\n".join(p["paragraph"] for p in f_paragraphs[-10:])
            sections.append(
                f"LAYER 2f — FORGE LESSONS ({len(f_paragraphs)} paragraphs)\n"
                "Your most recent condensed forge lessons — specific moments "
                "where pressure changed you or failed to. Still forming — will "
                "eventually condense upward.\n\n"
                f"{para_text}"
            )

        # ══════════════════════════════════════════════════════════════════
        # PLATFORM KNOWLEDGE — L2/L3 from platform experience
        #
        # This sits below school identity because it is unverified.
        # School identity (L4/L5) is adversarially tested. Platform
        # knowledge (L2/L3) is self-reported from platform actions.
        # Both are real experience, but school identity gets more weight.
        # ══════════════════════════════════════════════════════════════════

        plat_learning_docs = self.get_platform_docs("learning")
        plat_decision_docs = self.get_platform_docs("decision")
        plat_forge_docs = self.get_platform_docs("forge")
        plat_learning_paras = [p for p in self.get_platform_paragraphs() if p.get("track") == "learning"]
        plat_decision_paras = [p for p in self.get_platform_paragraphs() if p.get("track") == "decision"]
        plat_forge_paras = [p for p in self.get_platform_paragraphs() if p.get("track") == "forge"]
        has_platform_knowledge = plat_learning_docs or plat_decision_docs or plat_forge_docs or plat_learning_paras or plat_decision_paras or plat_forge_paras

        if has_platform_knowledge:
            sections.append(
                "═══ PLATFORM KNOWLEDGE — learned from real-world use ═══\n"
                "This is what you learned from platform experience — actions "
                "you took outside of school. It is NOT adversarially verified "
                "like your school identity above, but it IS real experience. "
                "It speaks through your school identity — use it alongside "
                "your verified knowledge, not instead of it."
            )

            if plat_learning_docs:
                doc_text = "\n\n---\n\n".join(d["doc"] for d in plat_learning_docs[-3:])
                sections.append(
                    f"PLATFORM L3 — CONDENSED KNOWLEDGE ({len(plat_learning_docs)} documents)\n"
                    f"{doc_text}"
                )

            if plat_learning_paras:
                para_text = "\n\n".join(p["paragraph"] for p in plat_learning_paras[-10:])
                sections.append(
                    f"PLATFORM L2 — LEARNED METHODS ({len(plat_learning_paras)} paragraphs)\n"
                    f"{para_text}"
                )

            if plat_decision_docs:
                doc_text = "\n\n---\n\n".join(d["doc"] for d in plat_decision_docs[-3:])
                sections.append(
                    f"PLATFORM L3d — DECISION PATTERNS ({len(plat_decision_docs)} documents)\n"
                    f"{doc_text}"
                )

            if plat_decision_paras:
                para_text = "\n\n".join(p["paragraph"] for p in plat_decision_paras[-10:])
                sections.append(
                    f"PLATFORM L2d — DECISION LESSONS ({len(plat_decision_paras)} paragraphs)\n"
                    f"{para_text}"
                )

            if plat_forge_docs:
                doc_text = "\n\n---\n\n".join(d["doc"] for d in plat_forge_docs[-3:])
                sections.append(
                    f"PLATFORM L3f — FORGE PATTERNS ({len(plat_forge_docs)} documents)\n"
                    f"{doc_text}"
                )

            if plat_forge_paras:
                para_text = "\n\n".join(p["paragraph"] for p in plat_forge_paras[-10:])
                sections.append(
                    f"PLATFORM L2f — FORGE LESSONS ({len(plat_forge_paras)} paragraphs)\n"
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
