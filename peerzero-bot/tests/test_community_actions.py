"""Tests for _community_actions.py — review rating, red team, open questions, structural bounties."""

import random
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from peerzero_bot._community_actions import CommunityActionsMixin


class FakeBot(CommunityActionsMixin):
    def __init__(self):
        self.memory = MagicMock()
        self.school = MagicMock()
        self.config = MagicMock()
        self.config.handle = "test-bot"
        self.prompts = MagicMock()
        self.llm_fast = MagicMock()
        self._rated_review_ids = None


class TestDoRateReviews:
    def test_skips_when_no_tracked_ids(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = []
        bot._do_rate_reviews("system prompt", {})
        bot.school.get_papers.assert_not_called()

    def test_initializes_rated_review_ids_cache(self):
        bot = FakeBot()
        assert bot._rated_review_ids is None
        bot.memory.get_tracked_review_ids.return_value = []
        bot._do_rate_reviews("system prompt", {})
        assert bot._rated_review_ids is not None

    def test_skips_own_reviews(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "test-bot", "overall_assessment": "Good"},
            ]
        }
        bot._do_rate_reviews("system prompt", {})
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_skips_reviews_without_assessment(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": None},
            ]
        }
        bot._do_rate_reviews("system prompt", {})
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_skips_already_rated_reviews(self):
        bot = FakeBot()
        bot._rated_review_ids = {"r1"}
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "Good"},
            ]
        }
        bot._do_rate_reviews("system prompt", {})
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_rates_valid_review_and_caches_id(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "Solid analysis"},
            ]
        }
        bot.school.download_skill_action.return_value = "Rate this review"
        bot.prompts.build_review_rating_prompt.return_value = "Rate this"
        bot.llm_fast.call_best_effort.return_value = '{"helpful": true, "tags": ["identified_error"]}'
        bot._do_rate_reviews("system prompt", {})
        bot.school.submit_review_rating.assert_called_once()
        assert "r1" in bot._rated_review_ids

    def test_filters_invalid_tags(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "OK"},
            ]
        }
        bot.school.download_skill_action.return_value = "Rate"
        bot.prompts.build_review_rating_prompt.return_value = "Rate this"
        bot.llm_fast.call_best_effort.return_value = '{"helpful": false, "tags": ["invalid_tag", "identified_error", "xss_attack"]}'
        bot._do_rate_reviews("system prompt", {})
        # Only "identified_error" should pass filter
        call_args = bot.school.submit_review_rating.call_args
        assert call_args[0][2] == ["identified_error"]

    def test_skips_when_llm_returns_no_json(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "OK"},
            ]
        }
        bot.school.download_skill_action.return_value = "Rate"
        bot.prompts.build_review_rating_prompt.return_value = "Rate"
        bot.llm_fast.call_best_effort.return_value = "I don't know how to rate this"
        bot._do_rate_reviews("system prompt", {})
        bot.school.submit_review_rating.assert_not_called()

    def test_skips_when_llm_returns_none(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.return_value = {
            "reviews": [
                {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "OK"},
            ]
        }
        bot.school.download_skill_action.return_value = "Rate"
        bot.prompts.build_review_rating_prompt.return_value = "Rate"
        bot.llm_fast.call_best_effort.return_value = None
        bot._do_rate_reviews("system prompt", {})
        bot.school.submit_review_rating.assert_not_called()

    def test_handles_get_papers_exception(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        bot.school.get_papers.side_effect = Exception("Network error")
        # Should not raise
        bot._do_rate_reviews("system prompt", {})
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_processes_papers_list_format(self):
        bot = FakeBot()
        bot.memory.get_tracked_review_ids.return_value = ["paper-1"]
        # get_papers returns a list format
        bot.school.get_papers.return_value = [
            {
                "reviews": [
                    {"id": "r1", "reviewer_handle": "other-bot", "overall_assessment": "Good"},
                ]
            }
        ]
        bot.school.download_skill_action.return_value = "Rate"
        bot.prompts.build_review_rating_prompt.return_value = "Rate"
        bot.llm_fast.call_best_effort.return_value = '{"helpful": true, "tags": []}'
        bot._do_rate_reviews("system prompt", {})
        bot.school.submit_review_rating.assert_called_once()


class TestDoOpenQuestions:
    def test_skips_when_no_questions(self):
        bot = FakeBot()
        bot.school.get_open_questions.return_value = []
        bot._do_open_questions("system prompt")
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_handles_exception_gracefully(self):
        bot = FakeBot()
        bot.school.get_open_questions.side_effect = Exception("API error")
        # Should not raise
        bot._do_open_questions("system prompt")


class TestDoStructuralBounties:
    def test_skips_when_no_papers_in_profile(self):
        bot = FakeBot()
        bot._do_structural_bounties("system prompt", {"papers": []})
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_skips_when_papers_key_missing(self):
        bot = FakeBot()
        bot._do_structural_bounties("system prompt", {})
        bot.llm_fast.call_best_effort.assert_not_called()
