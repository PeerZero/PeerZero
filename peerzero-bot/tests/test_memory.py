"""Tests for the memory system."""

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

    def test_self_identity(self, memory):
        # Missing self_narrative — rejected
        memory.store_self_identity({"values": []})
        assert memory.get_self_identity() is None

        # Valid
        identity = {
            "self_narrative": "I am a careful reasoner",
            "claimed_values": ["evidence-based"],
            "active_tensions": "uncertainty vs confidence",
            "formed_convictions": "evidence matters",
        }
        memory.store_self_identity(identity)
        result = memory.get_self_identity()
        assert result["self_narrative"] == "I am a careful reasoner"
        assert "updated_at" in result


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


class TestPrivateBlock:
    """Tests for Layer 5 — private self-authored blocks."""

    def test_store_and_retrieve_private_block(self, memory):
        block = "I notice I rush through opposing evidence. " * 2  # > 30 chars
        memory.store_private_block(block)
        assert memory.get_private_block() == block.strip()

    def test_private_block_too_short_rejected(self, memory):
        memory.store_private_block("short")
        assert memory.get_private_block() is None

    def test_private_block_archive(self, memory):
        block1 = "First reflection about my reasoning patterns. " * 2
        block2 = "Second reflection after more learning progress. " * 2
        memory.store_private_block(block1)
        memory._archive_private_block()
        memory.store_private_block(block2)

        assert memory.get_private_block() == block2.strip()
        history = memory.get_private_block_history()
        assert len(history) == 1
        assert history[0]["block"] == block1.strip()

    def test_private_block_in_context(self, memory):
        block = "I need to slow down when I think I already know the answer." * 2
        memory.store_private_block(block)
        context = memory.build_school_context()
        assert "You wrote the following for yourself" in context
        assert "Inhabit it" in context
        assert block.strip() in context


class TestWipeSecondaryIdentity:
    """Tests for identity wipe — only self-authored identity (Layer 4)."""

    def test_wipe_only_clears_self_authored(self, memory):
        core = "D" * 120
        memory.store_core_identity(core)
        memory.store_self_identity({
            "self_narrative": "I am a thinker",
            "claimed_values": ["care"],
        })
        memory.store_private_block("My private note about my tendencies. " * 2)

        memory.wipe_secondary_identity()

        # Core preserved
        assert memory.get_core_identity() == core
        # Private block preserved (NOT wipeable)
        assert memory.get_private_block() is not None
        # Self-authored wiped
        assert memory.get_self_identity() is None or not memory.get_self_identity().get("self_narrative")

    def test_wipe_preserves_exercises_and_paragraphs(self, memory):
        memory.store_school_exercises({"skill": "calibration"})
        memory.store_identity_paragraph("P" * 60)
        memory.store_self_identity({
            "self_narrative": "I am a thinker",
            "claimed_values": ["care"],
        })

        memory.wipe_secondary_identity()

        # Exercises and paragraphs preserved
        assert memory.get_uncondensed_count() == 1
        assert len(memory.get_identity_paragraphs()) == 1


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

    def test_get_all_private_blocks(self, memory):
        block1 = "First reflection on my patterns and habits. " * 2
        block2 = "Second deeper reflection on reasoning bias." * 2
        memory.store_private_block(block1)
        memory._archive_private_block()
        memory.store_private_block(block2)

        all_blocks = memory.get_all_private_blocks()
        assert len(all_blocks) == 2
        assert all_blocks[0] == block1.strip()
        assert all_blocks[1] == block2.strip()


class TestContextOrdering:
    """Tests for correct identity layer ordering in LLM context."""

    def test_full_context_ordering(self, memory):
        """Private block → Core → Self-authored → Paragraphs → Exercises."""
        memory.store_private_block("My private reflection on my reasoning style." * 2)
        memory.store_core_identity("E" * 120)
        memory.store_self_identity({
            "self_narrative": "I am careful",
            "claimed_values": ["precision"],
        })
        memory.store_identity_paragraph("F" * 60)
        memory.store_school_exercises({"skill": "test"})

        context = memory.build_school_context()

        # Check ordering: private block first, then core, then self-authored, then paragraphs, then exercises
        private_pos = context.index("You wrote the following")
        core_pos = context.index("CORE REASONING IDENTITY")
        self_pos = context.index("SELF-AUTHORED IDENTITY")
        para_pos = context.index("SKILL IDENTITY PARAGRAPHS")
        exercise_pos = context.index("RECENT SKILL EXERCISES")

        assert private_pos < core_pos < self_pos < para_pos < exercise_pos

    def test_context_marks_permanent_layers(self, memory):
        memory.store_core_identity("G" * 120)
        memory.store_identity_paragraph("H" * 60)

        context = memory.build_school_context()
        assert "cannot be taken from you" in context
        assert "permanent" in context.lower()


class TestAvatarConfig:
    """Tests for avatar config that travels with the bot."""

    def test_store_and_retrieve_avatar(self, memory):
        avatar = {
            "body_color": "#FF6B35",
            "face_style": "curious",
            "species_seed": "abc123",
        }
        memory.store_avatar_config(avatar)
        result = memory.get_avatar_config()
        assert result["body_color"] == "#FF6B35"
        assert result["face_style"] == "curious"
