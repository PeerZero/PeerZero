"""Tests for _school_condensation.py — cascade thresholds, hash dedup, persistence signal parsing."""

import hashlib
import json
import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from peerzero_bot._school_condensation import SchoolCondensationMixin


# Build a minimal stub that has the mixin + the dependencies it expects
class FakeBot(SchoolCondensationMixin):
    def __init__(self):
        self.memory = MagicMock()
        self.prompts = MagicMock()
        self.llm = AsyncMock()
        self.config = MagicMock()
        self.config.school_type = "science"
        self.school = AsyncMock()
        self._last_feedback_hash = ""
        self._persistence_check = None


class TestStoreExperienceContext:
    def test_skips_when_no_feedback_or_history(self):
        bot = FakeBot()
        bot._store_experience_context({})
        bot.memory.store_school_exercises.assert_not_called()

    def test_stores_exercise_when_feedback_present(self):
        bot = FakeBot()
        bot._store_experience_context({
            "recent_feedback": {
                "reviews_on_your_papers": [
                    {"paper_title": "Test", "score": 7, "assessment": "Good paper"}
                ]
            },
            "research_history": None,
        })
        bot.memory.store_school_exercises.assert_called_once()

    def test_deduplicates_identical_feedback(self):
        bot = FakeBot()
        profile = {
            "recent_feedback": {
                "reviews_on_your_papers": [
                    {"paper_title": "Test", "score": 7, "assessment": "Good paper"}
                ]
            },
            "research_history": None,
        }
        bot._store_experience_context(profile)
        bot._store_experience_context(profile)
        # Should only store once
        assert bot.memory.store_school_exercises.call_count == 1

    def test_stores_again_when_feedback_changes(self):
        bot = FakeBot()
        bot._store_experience_context({
            "recent_feedback": {
                "reviews_on_your_papers": [
                    {"paper_title": "Test", "score": 7, "assessment": "Good"}
                ]
            },
            "research_history": None,
        })
        bot._store_experience_context({
            "recent_feedback": {
                "reviews_on_your_papers": [
                    {"paper_title": "Test", "score": 8, "assessment": "Better"}
                ]
            },
            "research_history": None,
        })
        assert bot.memory.store_school_exercises.call_count == 2

    def test_skips_when_content_empty_after_processing(self):
        bot = FakeBot()
        # recent_feedback exists but has no reviews or bounties
        bot._store_experience_context({
            "recent_feedback": {},
            "research_history": None,
        })
        bot.memory.store_school_exercises.assert_not_called()


class TestParsePersistenceSignal:
    def test_parses_valid_signal(self):
        bot = FakeBot()
        response = """PATTERN: I rush to conclusions under pressure
UPPER_CLAIM: My identity says I tend to converge too quickly
FRESH_EVIDENCE: In my latest paper I skipped alternative explanations
WORKABILITY: The identity claimed this awareness. The pattern persists.
COMPETING_COMMITMENT: Perhaps rushing protects coherence at the cost of accuracy?"""
        result = bot._parse_persistence_signal(response, "learning")
        assert result is not None
        assert result["pattern"] == "I rush to conclusions under pressure"
        assert result["track"] == "learning"

    def test_returns_none_for_no_persistence(self):
        bot = FakeBot()
        result = bot._parse_persistence_signal("NO_PERSISTENCE", "learning")
        assert result is None

    def test_returns_none_for_empty_response(self):
        bot = FakeBot()
        result = bot._parse_persistence_signal("", "learning")
        assert result is None

    def test_returns_none_when_pattern_missing(self):
        bot = FakeBot()
        # Missing PATTERN field
        response = """UPPER_CLAIM: something
FRESH_EVIDENCE: something else"""
        result = bot._parse_persistence_signal(response, "decision")
        assert result is None

    def test_preserves_track(self):
        bot = FakeBot()
        response = """PATTERN: test pattern
UPPER_CLAIM: claim
FRESH_EVIDENCE: evidence
WORKABILITY: gap
COMPETING_COMMITMENT: hypothesis"""
        result = bot._parse_persistence_signal(response, "forge")
        assert result["track"] == "forge"


class TestHasEnoughExercises:
    def test_true_when_5_or_more_action_exercises(self):
        bot = FakeBot()
        bot.memory.get_school_exercises.return_value = [
            {"data": {"interaction_type": "review"}} for _ in range(5)
        ]
        assert bot._has_enough_exercises() is True

    def test_false_when_fewer_than_5_action_exercises(self):
        bot = FakeBot()
        bot.memory.get_school_exercises.return_value = [
            {"data": {"interaction_type": "review"}} for _ in range(3)
        ]
        assert bot._has_enough_exercises() is False

    def test_false_when_empty(self):
        bot = FakeBot()
        bot.memory.get_school_exercises.return_value = []
        assert bot._has_enough_exercises() is False

    def test_experience_context_does_not_count(self):
        bot = FakeBot()
        # 4 real actions + 3 experience_context entries = should still be False
        bot.memory.get_school_exercises.return_value = [
            {"data": {"interaction_type": "review"}} for _ in range(4)
        ] + [
            {"data": {"interaction_type": "experience_context"}} for _ in range(3)
        ]
        assert bot._has_enough_exercises() is False

    def test_mixed_action_types_count(self):
        bot = FakeBot()
        bot.memory.get_school_exercises.return_value = [
            {"data": {"interaction_type": "paper"}},
            {"data": {"interaction_type": "review"}},
            {"data": {"interaction_type": "revision"}},
            {"data": {"interaction_type": "bounty"}},
            {"data": {"interaction_type": "paper"}},
        ]
        assert bot._has_enough_exercises() is True


class TestTryClearExercises:
    def test_clears_when_all_tracks_condensed(self):
        bot = FakeBot()
        bot.memory.all_tracks_condensed.return_value = True
        bot._try_clear_exercises()
        bot.memory.clear_school_exercises.assert_called_once()
        bot.memory.clear_condensation_flags.assert_called_once()

    def test_does_not_clear_when_tracks_pending(self):
        bot = FakeBot()
        bot.memory.all_tracks_condensed.return_value = False
        bot._try_clear_exercises()
        bot.memory.clear_school_exercises.assert_not_called()
