"""Tests for the condensation cascade — dual-track flags, platform boundaries, MCP limits.

Covers:
  - Dual-track L1 clearing (both learning + decision must condense before clear)
  - Platform condensation hard-stops at L3 (no L4/L5 methods)
  - Platform dual-track flag coordination
  - MCP output size truncation
"""

import inspect
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


class TestBothTracksMustCondenseBeforeL1Clears:
    """L1 exercises are shared — cleared only when both tracks finish."""

    def test_learning_only_not_enough(self, memory):
        memory.mark_learning_condensed()
        assert not memory.both_tracks_condensed()

    def test_decision_only_not_enough(self, memory):
        memory.mark_decision_condensed()
        assert not memory.both_tracks_condensed()

    def test_both_marks_required(self, memory):
        memory.mark_learning_condensed()
        memory.mark_decision_condensed()
        assert memory.both_tracks_condensed()

    def test_clear_resets_both(self, memory):
        memory.mark_learning_condensed()
        memory.mark_decision_condensed()
        assert memory.both_tracks_condensed()
        memory.clear_condensation_flags()
        assert not memory.both_tracks_condensed()


class TestClearCondensationFlags:
    """Verify clear_condensation_flags resets both flags to False."""

    def test_clear_after_both_set(self, memory):
        memory.mark_learning_condensed()
        memory.mark_decision_condensed()
        memory.clear_condensation_flags()
        # Both must be False individually
        assert not memory.both_tracks_condensed()

    def test_clear_is_idempotent(self, memory):
        memory.clear_condensation_flags()
        assert not memory.both_tracks_condensed()


class TestPlatformCondensationStopsAtL3:
    """Structural enforcement: platform mixin has NO L4/L5 methods."""

    def test_platform_mixin_has_no_core_or_master_methods(self):
        from peerzero_bot._platform_condensation import PlatformCondensationMixin

        forbidden = {"core", "master", "l4", "l5"}
        methods = [
            name for name, _ in inspect.getmembers(
                PlatformCondensationMixin, predicate=inspect.isfunction
            )
        ]
        violations = []
        for name in methods:
            lower = name.lower()
            for word in forbidden:
                if word in lower:
                    violations.append(f"{name} contains '{word}'")
        assert violations == [], (
            f"PlatformCondensationMixin must not have L4/L5 methods: {violations}"
        )

    def test_memory_manager_has_no_platform_core_or_master_store(self):
        forbidden_methods = [
            "store_platform_core",
            "store_platform_master",
            "store_platform_core_identity",
            "store_platform_master_identity",
        ]
        manager_methods = dir(MemoryManager)
        for method in forbidden_methods:
            assert method not in manager_methods, (
                f"MemoryManager must not have {method} — L4/L5 are school-exclusive"
            )


class TestPlatformDualTrackFlags:
    """Platform mode has its own dual-track coordination flags."""

    def test_learning_only_not_enough(self, memory):
        memory.mark_platform_learning_condensed()
        assert not memory.both_platform_tracks_condensed()

    def test_both_tracks_required(self, memory):
        memory.mark_platform_learning_condensed()
        memory.mark_platform_decision_condensed()
        assert memory.both_platform_tracks_condensed()

    def test_clear_resets_platform_flags(self, memory):
        memory.mark_platform_learning_condensed()
        memory.mark_platform_decision_condensed()
        assert memory.both_platform_tracks_condensed()
        memory.clear_platform_condensation_flags()
        assert not memory.both_platform_tracks_condensed()


class TestMcpOutputSizeLimit:
    """MCP responses exceeding 512 KB must be truncated."""

    def test_oversized_text_is_truncated(self):
        from peerzero_bot.adapters.mcp import _parse_mcp_content, MAX_MCP_OUTPUT_SIZE

        big_text = "x" * (MAX_MCP_OUTPUT_SIZE + 10_000)
        result = {"content": [{"type": "text", "text": big_text}]}
        parsed = _parse_mcp_content(result)
        assert len(parsed["output"]) < len(big_text)
        assert "truncated" in parsed["output"]

    def test_under_limit_not_truncated(self):
        from peerzero_bot.adapters.mcp import _parse_mcp_content, MAX_MCP_OUTPUT_SIZE

        small_text = "y" * 1000
        result = {"content": [{"type": "text", "text": small_text}]}
        parsed = _parse_mcp_content(result)
        assert parsed["output"] == small_text
        assert "truncated" not in parsed["output"]

    def test_multi_part_truncation(self):
        from peerzero_bot.adapters.mcp import _parse_mcp_content, MAX_MCP_OUTPUT_SIZE

        # Two parts that together exceed the limit
        half = MAX_MCP_OUTPUT_SIZE // 2
        result = {"content": [
            {"type": "text", "text": "a" * (half + 100)},
            {"type": "text", "text": "b" * (half + 100)},
        ]}
        parsed = _parse_mcp_content(result)
        assert "truncated" in parsed["output"]
