"""Tests for _platform_condensation.py — L1→L2→L3 platform pipeline, caching, thresholds."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from peerzero_bot._platform_condensation import PlatformCondensationMixin


class FakeBot(PlatformCondensationMixin):
    def __init__(self):
        self.memory = MagicMock()
        self.school = MagicMock()
        self.llm = MagicMock()
        self.config = MagicMock()


class TestRefreshPlatformCondensers:
    def test_fetches_and_caches_templates(self):
        bot = FakeBot()
        bot.school.get_platform_condensers.return_value = {
            "learning": {"milestone": "condense learning"},
            "decision": {"milestone": "condense decisions"},
        }
        bot._refresh_platform_condensers()
        bot.school.get_platform_condensers.assert_called_once()
        bot.memory.cache_platform_condensers.assert_called_once()

    def test_does_not_cache_empty_result(self):
        bot = FakeBot()
        bot.school.get_platform_condensers.return_value = None
        bot._refresh_platform_condensers()
        bot.memory.cache_platform_condensers.assert_not_called()

    def test_handles_server_error_gracefully(self):
        bot = FakeBot()
        bot.school.get_platform_condensers.side_effect = Exception("Server down")
        # Should not raise
        bot._refresh_platform_condensers()


class TestTryClearPlatformExercises:
    def test_clears_when_both_tracks_done(self):
        bot = FakeBot()
        bot.memory.both_platform_tracks_condensed.return_value = True
        bot._try_clear_platform_exercises()
        bot.memory.clear_platform_exercises.assert_called_once()
        bot.memory.clear_platform_condensation_flags.assert_called_once()

    def test_does_not_clear_when_tracks_pending(self):
        bot = FakeBot()
        bot.memory.both_platform_tracks_condensed.return_value = False
        bot._try_clear_platform_exercises()
        bot.memory.clear_platform_exercises.assert_not_called()
