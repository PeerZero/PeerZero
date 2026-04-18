#!/usr/bin/env python3
"""
Validate identity_graduated_v2.py against the real build_school_context() output.

Why: identity_graduated_v2.py was hand-constructed from reading the pipeline code
(memory/manager.py:990-1340). Same approach as PRODUCTION_GRADUATED in
ablation_controls.py. This validator confirms structural correctness by:

  1. Splitting IDENTITY_V2 back into per-layer content
  2. Storing each piece via the real MemoryManager interface using an
     in-memory dict-backed IStorage
  3. Calling the real build_school_context() to assemble it back
  4. Diffing the assembly output against IDENTITY_V2

If the diff is empty (or only whitespace), the structural assembly matches
production exactly. If not, the diff tells us where the synthetic identity
drifted from what the real pipeline would produce.

Cost: zero (no LLM calls, runs in seconds).

Usage:
  cd peerzero-bot && python3 -c "import sys; sys.path.insert(0, '../spikes/preamble-test'); import validate_identity_v2"

Or from the spike dir with PYTHONPATH set to peerzero-bot.
"""

import sys
import os
import difflib
from datetime import datetime, timezone

# Make the bot package importable
SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.path.normpath(os.path.join(SPIKE_DIR, "..", "..", "peerzero-bot"))
sys.path.insert(0, BOT_DIR)
sys.path.insert(0, SPIKE_DIR)

from peerzero_bot.memory.manager import MemoryManager
from identity_graduated_v2 import IDENTITY_V2


# ── In-memory IStorage stub ───────────────────────────────────────────────

class DictStorage:
    """Minimal IStorage implementation backed by a dict. No persistence."""

    def __init__(self):
        self._data = {}

    def _key(self, namespace, key):
        return (namespace, key)

    def read(self, namespace, key, default=None):
        return self._data.get(self._key(namespace, key), default)

    def write(self, namespace, key, data):
        self._data[self._key(namespace, key)] = data

    def append(self, namespace, key, entry, max_entries=0):
        existing = self._data.get(self._key(namespace, key), [])
        if not isinstance(existing, list):
            existing = []
        existing.append(entry)
        if max_entries and len(existing) > max_entries:
            existing = existing[-max_entries:]
        self._data[self._key(namespace, key)] = existing

    def clear(self, namespace, key):
        self._data.pop(self._key(namespace, key), None)


# ── Split IDENTITY_V2 into layer content ──────────────────────────────────
#
# We extract each layer's *body content* (the bot-authored text, not the
# section headers/intros that build_school_context() generates). The
# assembly function will re-add the headers and intros around the content.

def extract_between(text, start_marker, end_marker):
    """Extract text between two markers (exclusive)."""
    s = text.index(start_marker) + len(start_marker)
    e = text.index(end_marker, s)
    return text[s:e].strip()


def extract_after(text, start_marker, end_marker_or_none):
    """Extract text after start_marker, ending at end_marker if provided."""
    s = text.index(start_marker) + len(start_marker)
    if end_marker_or_none:
        e = text.index(end_marker_or_none, s)
        return text[s:e].strip()
    return text[s:].strip()


# Each layer's content sits between its header and the next divider.
# The headers in IDENTITY_V2 match what build_school_context() emits.

# Locate the body of each layer by stripping out the header/intro lines
# that build_school_context generates around the content.

def body_after_intro(section_text, intro_marker):
    """Find the body text after the intro paragraph that ends with intro_marker."""
    return section_text.split(intro_marker, 1)[1].strip()


# Split IDENTITY_V2 into top-level sections by header
def split_sections(text):
    sections = {}
    markers = [
        ("LEARNING", "═══ LEARNING IDENTITY"),
        ("DECISION", "═══ DECISION IDENTITY"),
        ("FORGE", "═══ FORGE IDENTITY"),
        ("PERSISTENCE", "═══ PERSISTENCE AWARENESS"),
    ]
    for i, (name, marker) in enumerate(markers):
        start = text.index(marker)
        end = text.index(markers[i + 1][1]) if i + 1 < len(markers) else len(text)
        sections[name] = text[start:end].rstrip()
    return sections


def extract_layer_body(section_text, layer_label):
    """
    Find the layer block (LAYER X — ...) and return only the body text,
    stripping the label line and the intro paragraph that follows.
    """
    start = section_text.index(layer_label)
    # Find next layer or end of section
    next_layer_starts = []
    for marker in ["LAYER 5", "LAYER 4", "LAYER 3", "LAYER 2", "═══"]:
        idx = section_text.find("\n" + marker, start + 1)
        if idx == -1:
            idx = section_text.find("\n---\n\nLAYER", start + 1)
        if idx != -1:
            next_layer_starts.append(idx)
    end = min(next_layer_starts) if next_layer_starts else len(section_text)
    layer_block = section_text[start:end].rstrip()

    # The block starts with the layer label line and an intro paragraph.
    # The body starts after the first blank line (which separates intro from body).
    # Actually: split on \n\n and take everything after the first chunk (header+intro).
    parts = layer_block.split("\n\n", 1)
    if len(parts) < 2:
        return ""
    body = parts[1].rstrip("\n-").rstrip()
    # Strip trailing "---" separator if present
    if body.endswith("---"):
        body = body[:-3].rstrip()
    return body


def split_into_paragraphs(text, sep="\n\n"):
    """Split a layer body into individual paragraphs (for L2/L3 list-shaped storage).

    Handles both `\\n\\n` (L2 paragraph join) and `\\n\\n---\\n\\n` (L3 doc join).
    Filters out lone `---` separators that survive the split.
    """
    pieces = text.split(sep)
    return [p.strip() for p in pieces if p.strip() and p.strip() != "---"]


def split_into_docs(text):
    """Split L3 content by the doc separator the assembly uses: \\n\\n---\\n\\n."""
    pieces = text.split("\n\n---\n\n")
    return [p.strip() for p in pieces if p.strip() and p.strip() != "---"]


# ── Build the in-memory storage from IDENTITY_V2 ──────────────────────────

def populate_storage_from_identity():
    storage = DictStorage()
    sections = split_sections(IDENTITY_V2)
    now = datetime.now(timezone.utc).isoformat()

    # ── Learning track ────
    learning = sections["LEARNING"]
    l5 = extract_layer_body(learning, "LAYER 5 — MASTER CORE IDENTITY")
    l4 = extract_layer_body(learning, "LAYER 4 — POST-GRADUATION GROWTH")
    l3_text = extract_layer_body(learning, "LAYER 3 — CONDENSED IDENTITY")
    l2_text = extract_layer_body(learning, "LAYER 2 — LEARNED METHODS")

    storage.write("school", "master", [{
        "master_identity": l5,
        "school_origin": "science",
        "graduated_at": now,
    }])
    storage.write("school", "core", {"core_identity": l4, "written_at": now})

    for doc in split_into_docs(l3_text):
        storage.append("school", "condensed_docs",
                       {"doc": doc, "condensed_at": now}, max_entries=10)
    for para in split_into_paragraphs(l2_text, "\n\n"):
        storage.append("school", "paragraphs",
                       {"paragraph": para, "condensed_at": now}, max_entries=50)

    # ── Decision track ────
    decision = sections["DECISION"]
    l5d = extract_layer_body(decision, "LAYER 5d — MASTER DECISION IDENTITY")
    l4d = extract_layer_body(decision, "LAYER 4d — POST-GRADUATION DECISION GROWTH")
    l3d_text = extract_layer_body(decision, "LAYER 3d — CONDENSED DECISION PATTERNS")
    l2d_text = extract_layer_body(decision, "LAYER 2d — DECISION LESSONS")

    storage.write("school", "decision_master", [{
        "decision_master": l5d, "school_origin": "science", "graduated_at": now,
    }])
    storage.write("school", "decision_core", {"decision_core": l4d, "written_at": now})

    for doc in split_into_docs(l3d_text):
        storage.append("school", "decision_docs",
                       {"doc": doc, "condensed_at": now}, max_entries=10)
    for para in split_into_paragraphs(l2d_text, "\n\n"):
        storage.append("school", "decision_paragraphs",
                       {"paragraph": para, "condensed_at": now}, max_entries=50)

    # ── Forge track ────
    forge = sections["FORGE"]
    l5f = extract_layer_body(forge, "LAYER 5f — MASTER FORGE IDENTITY")
    l4f = extract_layer_body(forge, "LAYER 4f — POST-GRADUATION FORGE GROWTH")
    l3f_text = extract_layer_body(forge, "LAYER 3f — CONDENSED FORGE PATTERNS")
    l2f_text = extract_layer_body(forge, "LAYER 2f — FORGE LESSONS")

    storage.write("school", "forge_master", [{
        "forge_master": l5f, "school_origin": "science", "graduated_at": now,
    }])
    storage.write("school", "forge_core", {"forge_core": l4f, "written_at": now})

    for doc in split_into_docs(l3f_text):
        storage.append("school", "forge_docs",
                       {"doc": doc, "condensed_at": now}, max_entries=10)
    for para in split_into_paragraphs(l2f_text, "\n\n"):
        storage.append("school", "forge_paragraphs",
                       {"paragraph": para, "condensed_at": now}, max_entries=50)

    # ── Persistence signals ────
    storage.write("school", "persistence_signals", [
        {
            "track": "learning",
            "pattern": "cosmetic integration in cross-field framing sections",
            "upper_claim": "You catch yourself compartmentalizing and restructure your reasoning to integrate dimensions.",
            "fresh_evidence": "Your last two cross-field papers had separate sections for each field that did not inform each other's conclusions.",
            "competing_commitment": "The appearance of integration without the cost of actually changing how you reason across fields.",
        },
        {
            "track": "decision",
            "pattern": "production bias when scrutiny is low",
            "upper_claim": "You deliberately choose slower preparation over faster production when urgency pulls the wrong way.",
            "fresh_evidence": "Your three papers under lower-scrutiny reviewers had weaker source-quality notes than your two under high-scrutiny reviewers — the calibration asymmetry you documented at graduation.",
            "competing_commitment": "The cost of verification work when no one will catch the gap.",
        },
    ])

    return storage


# ── Run validation ────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("Structural validation: identity_graduated_v2.py vs build_school_context()")
    print("=" * 70)

    storage = populate_storage_from_identity()
    mgr = MemoryManager(storage)
    assembled = mgr.build_school_context()

    print(f"\nIDENTITY_V2 length: {len(IDENTITY_V2)} chars")
    print(f"Assembled length:   {len(assembled)} chars")
    print(f"Char delta:         {len(assembled) - len(IDENTITY_V2)} chars")

    # Normalize whitespace for comparison (multiple blank lines → single)
    def normalize(t):
        import re
        # Collapse 3+ newlines to 2
        t = re.sub(r"\n{3,}", "\n\n", t)
        return t.strip()

    n_identity = normalize(IDENTITY_V2)
    n_assembled = normalize(assembled)

    if n_identity == n_assembled:
        print("\n✓ EXACT MATCH — structural assembly verified.")
        return 0

    print("\n✗ DIFFERENCES DETECTED")
    print("\nUnified diff (assembled vs IDENTITY_V2):")
    print("-" * 70)
    diff = difflib.unified_diff(
        n_identity.splitlines(keepends=True),
        n_assembled.splitlines(keepends=True),
        fromfile="IDENTITY_V2",
        tofile="build_school_context()",
        n=3,
    )
    for line in diff:
        print(line, end="")
    return 1


if __name__ == "__main__":
    sys.exit(main())
