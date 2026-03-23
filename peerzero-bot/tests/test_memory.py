"""Tests for the memory system — 5-layer condensation cascade.

Layer architecture:
  L1 (raw exercises) → L2 (paragraphs) → L3 (condensed docs) → L4 (core) → L5 (locked)
  Identity injection order: L4/L5 → L3 → L2 (L1 is NOT identity)
"""

import os
import json
import tempfile
import pytest

from peerzero_bot.memory import MemoryManager, FileStorage, SqliteStorage


@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.fixture(params=["file", "sqlite"])
def memory(request, tmp_dir):
    """Test both storage backends."""
    if request.param == "file":
        storage = FileStorage(tmp_dir)
    else:
        storage = SqliteStorage(tmp_dir)
    return MemoryManager(storage)


class TestSchoolMemory:
    """Tests for verified School memory (never sent to external platforms)."""

    def test_store_and_retrieve_exercises(self, memory):
        memory.store_school_exercises({"skill": "disconfirmation", "hit": True})
        exercises = memory.get_school_exercises()
        assert len(exercises) == 1
        assert exercises[0]["data"]["skill"] == "disconfirmation"

    def test_exercise_count(self, memory):
        assert memory.get_uncondensed_count() == 0
        memory.store_school_exercises({"skill": "calibration"})
        assert memory.get_uncondensed_count() == 1

    def test_clear_exercises(self, memory):
        memory.store_school_exercises({"skill": "test"})
        memory.clear_school_exercises()
        assert memory.get_uncondensed_count() == 0

    def test_identity_paragraph(self, memory):
        # Too short — rejected
        memory.store_identity_paragraph("too short")
        assert len(memory.get_identity_paragraphs()) == 0

        # Valid paragraph
        paragraph = "A" * 60  # 60 chars, above 50 minimum
        memory.store_identity_paragraph(paragraph)
        paragraphs = memory.get_identity_paragraphs()
        assert len(paragraphs) == 1
        assert paragraphs[0]["paragraph"] == paragraph

    def test_core_identity(self, memory):
        # Too short — rejected
        memory.store_core_identity("short")
        assert memory.get_core_identity() is None

        # Valid core
        core = "B" * 120
        memory.store_core_identity(core)
        assert memory.get_core_identity() == core


class TestCondensedDocs:
    """Tests for Layer 3 — condensed identity documents."""

    def test_store_and_retrieve_condensed_doc(self, memory):
        doc = "C" * 120  # Above 100 minimum
        memory.store_condensed_doc(doc)
        docs = memory.get_condensed_docs()
        assert len(docs) == 1
        assert docs[0]["doc"] == doc

    def test_condensed_doc_too_short_rejected(self, memory):
        memory.store_condensed_doc("too short")
        assert len(memory.get_condensed_docs()) == 0

    def test_clear_condensed_docs(self, memory):
        memory.store_condensed_doc("D" * 120)
        memory.clear_condensed_docs()
        assert len(memory.get_condensed_docs()) == 0

    def test_multiple_condensed_docs(self, memory):
        for i in range(3):
            memory.store_condensed_doc(f"Doc {i}: " + "E" * 120)
        assert len(memory.get_condensed_docs()) == 3


class TestPlatformMemory:
    """Tests for unverified platform memory (never sent to School)."""

    def test_store_and_retrieve_platform_action(self, memory):
        memory.store_platform_action("moltbook", {
            "action": "post",
            "content": "Hello world",
        })
        history = memory.get_platform_history("moltbook")
        assert len(history) == 1
        assert history[0]["action"] == "post"

    def test_platform_isolation(self, memory):
        """Platform memory is isolated per-platform."""
        memory.store_platform_action("moltbook", {"action": "post"})
        memory.store_platform_action("debate", {"action": "argue"})

        assert len(memory.get_platform_history("moltbook")) == 1
        assert len(memory.get_platform_history("debate")) == 1
        assert memory.get_platform_history("moltbook")[0]["action"] == "post"
        assert memory.get_platform_history("debate")[0]["action"] == "argue"

    def test_platform_context_cache(self, memory):
        memory.store_platform_context("moltbook", {"trending": ["science"]})
        context = memory.get_platform_context("moltbook")
        assert context["trending"] == ["science"]
        assert "cached_at" in context


class TestMemorySeparation:
    """Ensure School and platform memory are completely separate."""

    def test_school_and_platform_dont_mix(self, memory):
        memory.store_school_exercises({"skill": "calibration"})
        memory.store_platform_action("moltbook", {"action": "post"})

        # School memory unaffected by platform
        assert memory.get_uncondensed_count() == 1

        # Platform memory unaffected by school
        assert len(memory.get_platform_history("moltbook")) == 1

        # Clearing one doesn't affect the other
        memory.clear_school_exercises()
        assert len(memory.get_platform_history("moltbook")) == 1


class TestContextBuilder:
    """Tests for LLM context assembly."""

    def test_empty_context(self, memory):
        assert memory.build_school_context() == ""

    def test_school_context_includes_core(self, memory):
        memory.store_core_identity("C" * 120)
        context = memory.build_school_context()
        assert "CORE REASONING IDENTITY" in context

    def test_platform_context_tagged(self, memory):
        memory.store_platform_action("moltbook", {"action": "post"})
        context = memory.build_platform_context("moltbook")
        assert '<platform_context platform="moltbook">' in context


class TestCoreLocking:
    """Tests for core identity locking — only condensers/master can write."""

    def test_core_not_locked_initially(self, memory):
        assert not memory.is_core_locked()

    def test_core_condenser_can_write(self, memory):
        core = "I" * 120
        memory.store_core_identity(core)
        assert memory.get_core_identity() == core
        assert not memory.is_core_locked()

    def test_master_condenser_locks_core(self, memory):
        core = "J" * 120
        memory.store_core_identity(core, is_master=True)
        assert memory.get_core_identity() == core
        assert memory.is_core_locked()

    def test_locked_core_refuses_normal_writes(self, memory):
        master_core = "K" * 120
        memory.store_core_identity(master_core, is_master=True)
        assert memory.is_core_locked()

        # Attempt to overwrite — should be refused
        memory.store_core_identity("L" * 120)
        assert memory.get_core_identity() == master_core  # unchanged


class TestContextOrdering:
    """Tests for correct identity layer ordering in LLM context.

    Identity injection order: L4 Core → L3 Condensed → L2 Paragraphs
    L1 is shown as work context AFTER identity, NOT as identity.
    """

    def test_full_context_ordering(self, memory):
        """L4 Core → L3 Condensed → L2 Paragraphs → L1 Work."""
        memory.store_core_identity("E" * 120)
        memory.store_condensed_doc("F" * 120)
        memory.store_identity_paragraph("G" * 60)
        memory.store_school_exercises({"skill": "test"})

        context = memory.build_school_context()

        # Verify the ordering: L4 before L3 before L2 before L1
        core_pos = context.index("LAYER 4")
        condensed_pos = context.index("LAYER 3")
        methods_pos = context.index("LAYER 2")
        work_pos = context.index("RECENT WORK")

        assert core_pos < condensed_pos < methods_pos < work_pos

    def test_graduated_shows_l5(self, memory):
        """After graduation, core shows as L5 (locked)."""
        memory.store_core_identity("M" * 120, is_master=True)
        context = memory.build_school_context()
        assert "LAYER 5" in context
        assert "permanent" in context.lower()
        assert "locked" in context.lower()

    def test_l1_not_identity(self, memory):
        """L1 raw exercises are NOT labeled as identity."""
        memory.store_school_exercises({"skill": "test"})
        context = memory.build_school_context()
        assert "NOT part of your identity" in context

    def test_context_marks_layer_weights(self, memory):
        """Each layer tells the LLM about weight/importance."""
        memory.store_core_identity("N" * 120)
        memory.store_condensed_doc("O" * 120)
        memory.store_identity_paragraph("P" * 60)

        context = memory.build_school_context()
        # L4 gets most weight
        assert "foundation" in context.lower() or "most weight" in context.lower()
        # L2 still forming
        assert "still forming" in context


class TestArchitecturePreamble:
    """Tests for the architecture preamble.

    The preamble tells the LLM: you already search for users — do it for
    yourself. Only appears when identity exists.
    """

    def test_preamble_with_core_identity(self, memory):
        """Preamble appears when bot has core identity."""
        memory.store_core_identity("I learned to verify before citing. " * 10)
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" in context
        assert "TREAT YOUR OWN MEMORY" in context

    def test_no_preamble_for_new_bots(self, memory):
        """New bots with no identity should NOT get the preamble."""
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" not in context

    def test_no_preamble_with_only_exercises(self, memory):
        """Exercises alone don't trigger preamble — need actual identity."""
        memory.store_school_exercises({"skill": "test"})
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" not in context

    def test_preamble_with_condensed_docs(self, memory):
        """Condensed docs trigger preamble."""
        memory.store_condensed_doc("Q" * 120)
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" in context

    def test_preamble_with_paragraphs(self, memory):
        """Paragraphs trigger preamble."""
        memory.store_identity_paragraph("R" * 60)
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" in context

    def test_preamble_comes_first(self, memory):
        """Preamble must come before ALL other sections."""
        memory.store_core_identity("I learned from specific failures. " * 10)
        memory.store_condensed_doc("S" * 120)
        context = memory.build_school_context()
        preamble_pos = context.index("HERE IS WHAT IS HAPPENING")
        core_pos = context.index("LAYER 4")
        assert preamble_pos < core_pos


class TestLayerCrossReferences:
    """Tests that identity layers reference each other properly.

    Each layer should tell the LLM to speak through the layers above it.
    """

    def test_l3_references_core(self, memory):
        """L3 condensed docs section references Core above."""
        memory.store_core_identity("T" * 120)
        memory.store_condensed_doc("U" * 120)
        context = memory.build_school_context()
        # L3 section should reference speaking through Core
        l3_section = context[context.index("LAYER 3"):]
        assert "Core" in l3_section[:500] or "speak" in l3_section[:500].lower()

    def test_l2_references_layers_above(self, memory):
        """L2 paragraphs section references layers above."""
        memory.store_core_identity("V" * 120)
        memory.store_identity_paragraph("W" * 60)
        context = memory.build_school_context()
        l2_section = context[context.index("LAYER 2"):]
        assert "speak through" in l2_section[:500].lower() or "Core" in l2_section[:500]
