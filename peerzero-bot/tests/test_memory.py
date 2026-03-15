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
