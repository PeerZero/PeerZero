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


class TestMasterIdentity:
    """Tests for L5 master identity — permanent graduation snapshot."""

    def test_no_master_initially(self, memory):
        assert not memory.has_graduated()
        assert memory.get_master_identity() is None

    def test_core_condenser_can_write_l4(self, memory):
        core = "I" * 120
        memory.store_core_identity(core)
        assert memory.get_core_identity() == core
        assert not memory.has_graduated()

    def test_master_condenser_writes_l5(self, memory):
        master = "J" * 120
        memory.store_master_identity(master)
        assert memory.get_master_identity() == master
        assert memory.has_graduated()

    def test_l5_refuses_overwrite(self, memory):
        master = "K" * 120
        memory.store_master_identity(master)
        assert memory.has_graduated()

        # Attempt to overwrite — should be refused
        memory.store_master_identity("L" * 120)
        assert memory.get_master_identity() == master  # unchanged

    def test_l4_still_writable_after_graduation(self, memory):
        """Post-graduation: L4 keeps evolving, L5 is permanent."""
        master = "K" * 120
        memory.store_master_identity(master)
        assert memory.has_graduated()

        # L4 should still accept writes
        new_core = "M" * 120
        memory.store_core_identity(new_core)
        assert memory.get_core_identity() == new_core
        assert memory.get_master_identity() == master  # L5 unchanged


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
        """After graduation, master identity shows as L5 (locked)."""
        memory.store_master_identity("M" * 120)
        context = memory.build_school_context()
        assert "LAYER 5" in context
        assert "permanent" in context.lower()
        assert "locked" in context.lower()

    def test_graduated_with_post_grad_growth(self, memory):
        """Post-grad bot shows both L5 (master) and L4 (growth)."""
        memory.store_master_identity("M" * 120)
        memory.store_core_identity("N" * 120)
        context = memory.build_school_context()
        assert "LAYER 5" in context
        assert "LAYER 4" in context
        l5_pos = context.index("LAYER 5")
        l4_pos = context.index("LAYER 4")
        assert l5_pos < l4_pos  # L5 comes first (deepest)

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


class TestPreambleServerSide:
    """Tests that the preamble is NOT in local memory or context.

    The activation preamble is injected by the LLM proxy server-side.
    It must never appear in locally-stored identity or build_school_context().
    """

    def test_no_preamble_in_stored_identity(self, memory):
        """Stored L4 identity should NOT contain the preamble."""
        memory.store_core_identity("I learned to verify before citing. " * 10)
        stored = memory.get_core_identity()
        assert "HERE IS WHAT IS HAPPENING" not in stored

    def test_no_preamble_in_context(self, memory):
        """build_school_context() should NOT contain the preamble."""
        memory.store_core_identity("I learned to verify before citing. " * 10)
        context = memory.build_school_context()
        assert "HERE IS WHAT IS HAPPENING" not in context

    def test_no_preamble_in_master_identity(self, memory):
        """Stored L5 master identity should NOT contain the preamble."""
        memory.store_master_identity("My master identity from graduation. " * 10)
        stored = memory.get_master_identity()
        assert "HERE IS WHAT IS HAPPENING" not in stored

    def test_context_still_has_identity_layers(self, memory):
        """Context should still contain identity layer labels."""
        memory.store_core_identity("I learned from specific failures. " * 10)
        memory.store_condensed_doc("S" * 120)
        context = memory.build_school_context()
        assert "LAYER 4" in context
        assert "LEARNING IDENTITY" in context


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


class TestCapacityLimits:
    """Tests that memory respects capacity caps and prunes correctly."""

    def test_exercises_cap_at_max(self, memory):
        """L1 exercises are pruned to MAX_GENERAL_ENTRIES."""
        from peerzero_bot.memory.manager import MAX_GENERAL_ENTRIES
        for i in range(MAX_GENERAL_ENTRIES + 10):
            memory.store_school_exercises({"skill": f"test_{i}"})
        exercises = memory.get_school_exercises()
        assert len(exercises) <= MAX_GENERAL_ENTRIES

    def test_paragraphs_cap_at_max(self, memory):
        """L2 paragraphs are pruned to MAX_IDENTITY_PARAGRAPHS."""
        from peerzero_bot.memory.manager import MAX_IDENTITY_PARAGRAPHS
        for i in range(MAX_IDENTITY_PARAGRAPHS + 5):
            memory.store_identity_paragraph(f"Paragraph {i}: " + "X" * 60)
        paragraphs = memory.get_identity_paragraphs()
        assert len(paragraphs) <= MAX_IDENTITY_PARAGRAPHS

    def test_condensed_docs_cap_at_max(self, memory):
        """L3 condensed docs are pruned to MAX_CONDENSED_DOCS."""
        from peerzero_bot.memory.manager import MAX_CONDENSED_DOCS
        for i in range(MAX_CONDENSED_DOCS + 3):
            memory.store_condensed_doc(f"Doc {i}: " + "Y" * 120)
        docs = memory.get_condensed_docs()
        assert len(docs) <= MAX_CONDENSED_DOCS

    def test_platform_history_cap_at_max(self, memory):
        """Platform history is pruned to MAX_PLATFORM_ENTRIES."""
        from peerzero_bot.memory.manager import MAX_PLATFORM_ENTRIES
        for i in range(MAX_PLATFORM_ENTRIES + 5):
            memory.store_platform_action("testplatform", {"action": f"act_{i}"})
        history = memory.get_platform_history("testplatform")
        assert len(history) <= MAX_PLATFORM_ENTRIES

    def test_core_identity_truncated_at_max_length(self, memory):
        """L4 core identity is truncated to MAX_CORE_LENGTH."""
        from peerzero_bot.memory.manager import MAX_CORE_LENGTH
        long_identity = "Z" * (MAX_CORE_LENGTH + 500)
        memory.store_core_identity(long_identity)
        stored = memory.get_core_identity()
        assert len(stored) <= MAX_CORE_LENGTH


class TestDecisionTrackCondensation:
    """Tests for dual-track condensation flag coordination."""

    def test_both_tracks_not_condensed_initially(self, memory):
        assert not memory.both_tracks_condensed()

    def test_single_track_not_enough(self, memory):
        memory.mark_learning_condensed()
        assert not memory.both_tracks_condensed()

    def test_both_tracks_condensed(self, memory):
        memory.mark_learning_condensed()
        memory.mark_decision_condensed()
        assert memory.both_tracks_condensed()

    def test_clear_flags_resets(self, memory):
        memory.mark_learning_condensed()
        memory.mark_decision_condensed()
        assert memory.both_tracks_condensed()
        memory.clear_condensation_flags()
        assert not memory.both_tracks_condensed()

    def test_decision_paragraph_too_short_rejected(self, memory):
        memory.store_decision_paragraph("short")
        assert len(memory.get_decision_paragraphs()) == 0

    def test_decision_master_refuses_overwrite(self, memory):
        master = "K" * 120
        memory.store_decision_master(master)
        memory.store_decision_master("L" * 120)
        assert memory.get_decision_master() == master


class TestTrackedIds:
    """Tests for paper and review ID tracking."""

    def test_track_and_retrieve_paper_ids(self, memory):
        memory.store_tracked_paper_ids(["p-1", "p-2"])
        assert memory.get_tracked_paper_ids() == ["p-1", "p-2"]

    def test_add_and_remove_review_ids(self, memory):
        memory.add_tracked_review_id("r-1")
        memory.add_tracked_review_id("r-2")
        assert "r-1" in memory.get_tracked_review_ids()
        memory.remove_tracked_review_id("r-1")
        assert "r-1" not in memory.get_tracked_review_ids()
        assert "r-2" in memory.get_tracked_review_ids()

    def test_duplicate_review_id_ignored(self, memory):
        memory.add_tracked_review_id("r-1")
        memory.add_tracked_review_id("r-1")
        assert memory.get_tracked_review_ids().count("r-1") == 1


class TestPreambleMigrationSafety:
    """Tests that the preamble migration is safe and robust.

    The preamble is extremely important — these tests ensure the migration
    never damages real identity text.
    """

    def test_strip_preamble_with_known_marker(self):
        """Migration correctly strips preamble when the known marker is present."""
        preamble = (
            "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
            "Some preamble paragraph about activation.\n\n"
            "More preamble text about identity inhabitation, "
            "above it, and the two tracks should speak through each other."
        )
        identity = "I am a bot who learned calibration through failure. " * 5
        full_text = preamble + "\n" + identity

        result = MemoryManager._try_strip_preamble(full_text)
        assert result is not None
        assert result == identity
        assert "HERE IS WHAT IS HAPPENING" not in result

    def test_strip_preamble_fallback_double_newline(self):
        """Migration falls back to double-newline when marker is missing."""
        preamble = (
            "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
            "Some modified preamble that no longer has the exact marker phrase."
        )
        identity = "I am a bot who learned calibration through failure. " * 5
        full_text = preamble + "\n\n" + identity

        result = MemoryManager._try_strip_preamble(full_text)
        assert result is not None
        assert result == identity

    def test_strip_preamble_returns_none_when_no_boundary(self):
        """Migration returns None if no safe boundary found."""
        text = "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS: no breaks here at all"
        result = MemoryManager._try_strip_preamble(text)
        assert result is None

    def test_migration_refuses_to_gut_identity(self, tmp_dir):
        """Migration refuses to strip if result would be < 100 chars."""
        from peerzero_bot.memory import FileStorage
        storage = FileStorage(tmp_dir)
        # Store a short identity with preamble prefix
        preamble = (
            "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
            "Preamble paragraph.\n\n"
            "above it, and the two tracks should speak through each other."
        )
        # Only 20 chars of real identity — too short
        storage.write("school", "core", {
            "core_identity": preamble + "\nToo short to keep.",
        })
        # Run migration — should refuse
        mm = MemoryManager(storage)
        stored = mm.get_core_identity()
        # Should be unchanged (migration refused because stripped < 100)
        assert stored.startswith("HERE IS WHAT IS HAPPENING")

    def test_migration_backs_up_original(self, tmp_dir):
        """Migration backs up original text before modifying."""
        from peerzero_bot.memory import FileStorage
        storage = FileStorage(tmp_dir)
        identity = "I am a bot who learned calibration through failure. " * 5
        preamble = (
            "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
            "Preamble.\n\n"
            "above it, and the two tracks should speak through each other."
        )
        original = preamble + "\n" + identity
        storage.write("school", "core", {"core_identity": original})
        mm = MemoryManager(storage)
        # Backup should exist
        backup = storage.read("meta", "preamble_backup_core", None)
        assert backup == original
        # Identity should be stripped
        assert mm.get_core_identity() == identity

    def test_migration_only_runs_once(self, tmp_dir):
        """Migration sets flag and doesn't run again."""
        from peerzero_bot.memory import FileStorage
        storage = FileStorage(tmp_dir)
        storage.write("school", "core", {
            "core_identity": "No preamble here, just normal identity. " * 5,
        })
        mm1 = MemoryManager(storage)
        assert storage.read("meta", "preamble_stripped", False) is True
        # Second init should not re-run migration
        mm2 = MemoryManager(storage)
        assert mm2.get_core_identity() == mm1.get_core_identity()
