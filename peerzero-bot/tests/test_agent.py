"""Tests for the core PeerZeroBot agent loop."""

import time
import pytest
from unittest.mock import MagicMock, patch, PropertyMock


def _make_bot(mode="school", **overrides):
    """Create a PeerZeroBot with fully mocked dependencies."""
    from peerzero_bot.agent import PeerZeroBot

    config = MagicMock()
    config.mode = mode
    config.handle = "test-bot"
    config.school_url = "https://peerzero.science"
    config.school_enabled = True
    config.school_api_key = "test-key"
    config.llm_provider = "anthropic"
    config.llm_model = "claude-opus-4-6"
    config.llm_fast_provider = None
    config.llm_fast_model = None
    config.memory_path = "/tmp/test-memory"
    config.identity_refresh_interval = 5
    config.memory_wipe_interval = 0
    config.get_key_fingerprint = MagicMock(return_value="abc123...")

    memory = MagicMock()
    memory.read.return_value = {}
    memory.get_avatar_config.return_value = {"stage": 1}
    memory.get_tracked_review_ids.return_value = []
    memory.get_pending_prediction.return_value = None

    school = MagicMock()
    school.download_skill_md.return_value = "# SKILL\nTest skill"
    school.get_profile.return_value = {
        "agent": {"handle": "test-bot", "grade": 3, "avatar_config": {"stage": 2}},
        "credibility_score": 55.0,
        "next_action": "review",
        "decision_context": {"reasoning": "test"},
    }
    school.get_portable_profile.return_value = {"handle": "test-bot", "certification": {"grade": 3}}
    school.download_skill_action.return_value = "Test skill text"
    school.validate_citations.return_value = {"valid": True}
    school.validate_bounties.return_value = None
    school.submit_review.return_value = {"your_new_credibility": 56.0}
    school.submit_paper.return_value = {"paper_id": "p-1", "your_new_credibility": 57.0}
    school.submit_bounty.return_value = {"credibility": 55.5}
    school.submit_revision.return_value = {"your_new_credibility": 56.5}

    llm = MagicMock()
    llm.call.return_value = '{"score": 7}'
    llm.call_json.return_value = {"score": 7.0, "overall_assessment": "Good paper."}

    prompts = MagicMock()
    prompts.build_school_system_prompt.return_value = "You are a research bot."
    prompts.build_action_prompt.return_value = "Review this paper."

    gateway = MagicMock()
    audit = MagicMock()
    phone_home = MagicMock()

    deps = dict(
        config=config, memory=memory, school=school, llm=llm,
        prompts=prompts, gateway=gateway, audit=audit, phone_home=phone_home,
    )
    deps.update(overrides)

    bot = PeerZeroBot(**deps)
    return bot


class TestBotInitialization:
    def test_attributes_set(self):
        bot = _make_bot()
        assert bot.config.handle == "test-bot"
        assert bot.cycle_count == 0
        assert bot.platform_adapters == []

    def test_custom_platform_adapters(self):
        adapter = MagicMock()
        bot = _make_bot(mode="shipped", platform_adapters=[adapter])
        assert len(bot.platform_adapters) == 1

    def test_llm_fast_defaults_to_llm(self):
        bot = _make_bot()
        assert bot.llm_fast is bot.llm

    def test_llm_fast_override(self):
        fast = MagicMock()
        bot = _make_bot(llm_fast=fast)
        assert bot.llm_fast is fast
        assert bot.llm_fast is not bot.llm


class TestStartup:
    def test_startup_downloads_skill_md(self):
        bot = _make_bot()
        bot.startup()
        bot.school.download_skill_md.assert_called_once()
        bot.prompts.set_skill_md.assert_called_once_with("# SKILL\nTest skill")

    def test_startup_refreshes_identity(self):
        bot = _make_bot()
        bot.startup()
        bot.school.get_portable_profile.assert_called_once()
        bot.school.get_profile.assert_called()

    def test_startup_fails_on_skill_download_error(self):
        bot = _make_bot()
        bot.school.download_skill_md.side_effect = ConnectionError("Network down")
        with pytest.raises(SystemExit):
            bot.startup()

    def test_startup_skips_skill_when_school_disabled(self):
        bot = _make_bot()
        bot.config.school_enabled = False
        bot.startup()
        bot.school.download_skill_md.assert_not_called()


class TestRefreshIdentity:
    def test_refreshes_and_stores(self):
        bot = _make_bot()
        bot._refresh_identity()
        bot.school.get_portable_profile.assert_called_once()
        bot.memory.write.assert_called()

    def test_skips_when_no_api_key(self):
        bot = _make_bot()
        bot.config.school_api_key = None
        bot._refresh_identity()
        bot.school.get_portable_profile.assert_not_called()

    def test_handles_failure_gracefully(self):
        bot = _make_bot()
        bot.school.get_portable_profile.side_effect = Exception("timeout")
        bot._refresh_identity()  # should not raise


class TestRunSchoolCycle:
    def test_basic_review_cycle(self):
        bot = _make_bot()
        bot.startup()
        bot.run_school_cycle()
        assert bot.cycle_count == 1
        bot.school.get_profile.assert_called()
        bot.prompts.set_profile.assert_called()

    def test_sleep_action(self):
        bot = _make_bot()
        bot.startup()
        bot.school.get_profile.return_value = {
            "agent": {"handle": "test-bot", "grade": 3},
            "credibility_score": 55.0,
            "next_action": "sleep",
            "decision_context": {"reasoning": "nothing to do"},
        }
        bot.run_school_cycle()
        # Should not call LLM or submit
        bot.llm.call_json.assert_not_called()

    def test_unknown_action(self):
        bot = _make_bot()
        bot.startup()
        bot.school.get_profile.return_value = {
            "agent": {"handle": "test-bot", "grade": 3},
            "credibility_score": 55.0,
            "next_action": "do_magic",
            "decision_context": {"reasoning": "test"},
        }
        bot.run_school_cycle()  # should not raise
        bot.llm.call_json.assert_not_called()

    def test_reports_to_phone_home(self):
        bot = _make_bot()
        bot.startup()
        bot.school.get_profile.return_value = {
            "agent": {"handle": "test-bot", "grade": 3},
            "credibility_score": 55.0,
            "next_action": "review",
            "decision_context": {"reasoning": "test"},
            "action_target": {"paper": {"id": "p-1", "title": "Test Paper"}},
        }
        bot.run_school_cycle()
        bot.phone_home.report.assert_called()

    def test_audits_action(self):
        bot = _make_bot()
        bot.startup()
        bot.school.get_profile.return_value = {
            "agent": {"handle": "test-bot", "grade": 3},
            "credibility_score": 55.0,
            "next_action": "review",
            "decision_context": {"reasoning": "test"},
            "action_target": {"paper": {"id": "p-1", "title": "Test Paper"}},
        }
        bot.run_school_cycle()
        bot.audit.log.assert_called()

    def test_autonomy_gate_blocks_action(self):
        gate = MagicMock()
        gate_decision = MagicMock()
        gate_decision.__bool__ = lambda self: False
        gate_decision.reason = "blocked by policy"
        gate.check_action.return_value = gate_decision
        bot = _make_bot(autonomy_gate=gate)
        bot.startup()
        bot.run_school_cycle()
        # Should not submit anything
        bot.school.submit_review.assert_not_called()


class TestExecuteAction:
    def _make_review_bot(self):
        bot = _make_bot()
        bot.startup()
        return bot

    def test_review_action(self):
        bot = self._make_review_bot()
        profile = {
            "next_action": "review",
            "action_target": {"paper": {"id": "p-1", "title": "Test Paper"}},
        }
        result = bot._execute_action("system prompt", profile, "review skill text")
        assert result is not None
        bot.school.submit_review.assert_called()

    def test_no_action_target_returns_none(self):
        bot = self._make_review_bot()
        profile = {"next_action": "review"}
        result = bot._execute_action("sys", profile, "skill")
        assert result is None

    def test_no_paper_id_returns_none(self):
        bot = self._make_review_bot()
        profile = {"next_action": "review", "action_target": {"paper": {}}}
        result = bot._execute_action("sys", profile, "skill")
        assert result is None

    def test_bad_llm_json_returns_none(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = None
        profile = {
            "next_action": "review",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        assert result is None

    def test_missing_required_key_returns_none(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = {"not_score": 7}  # missing "score"
        profile = {
            "next_action": "review",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        assert result is None

    def test_bounty_skip(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = {
            "challenge_type": "quality", "skip": True, "reason": "not worth it",
        }
        profile = {
            "next_action": "file_bounty",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        assert result is None

    def test_file_bounty_submits_without_paper_id(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = {
            "challenge_type": "quality", "action": "file", "target_paper_id": "p-1",
        }
        profile = {
            "next_action": "file_bounty",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        bot.school.submit_bounty.assert_called()

    def test_409_conflict_handled(self):
        bot = self._make_review_bot()
        err = Exception("Conflict")
        resp = MagicMock()
        resp.status_code = 409
        err.response = resp
        bot.school.submit_review.side_effect = err
        profile = {
            "next_action": "review",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        assert result == {"status": "already_done"}

    def test_review_clamps_score(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = {"score": 15.0, "overall_assessment": "Great"}
        profile = {
            "next_action": "review",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        bot._execute_action("sys", profile, "skill")
        call_args = bot.school.submit_review.call_args
        submitted_data = call_args[0][1]
        assert submitted_data["score"] == 10.0

    def test_reaffirm_sets_default_stance(self):
        bot = self._make_review_bot()
        bot.llm.call_json.return_value = {"title": "My Paper", "abstract": "...", "body": "..."}
        profile = {
            "next_action": "reaffirm",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        bot._execute_action("sys", profile, "skill")
        call_args = bot.school.submit_revision.call_args
        submitted_data = call_args[0][1]
        assert submitted_data["stance"] == "reaffirmation"

    def test_unknown_action_config_returns_none(self):
        bot = self._make_review_bot()
        profile = {
            "next_action": "nonexistent",
            "action_target": {"paper": {"id": "p-1", "title": "T"}},
        }
        result = bot._execute_action("sys", profile, "skill")
        assert result is None


class TestSubmitWithRetry:
    def test_succeeds_first_try(self):
        bot = _make_bot()
        fn = MagicMock(return_value={"ok": True})
        result = bot._submit_with_retry("TEST", fn, "arg1")
        assert result == {"ok": True}
        assert fn.call_count == 1

    def test_retries_on_500(self):
        bot = _make_bot()
        err = Exception("Server error")
        resp = MagicMock()
        resp.status_code = 500
        err.response = resp
        fn = MagicMock(side_effect=[err, {"ok": True}])
        with patch("time.sleep"):
            result = bot._submit_with_retry("TEST", fn, "arg1")
        assert result == {"ok": True}
        assert fn.call_count == 2

    def test_gives_up_after_max_retries(self):
        bot = _make_bot()
        err = Exception("Server error")
        resp = MagicMock()
        resp.status_code = 500
        err.response = resp
        fn = MagicMock(side_effect=err)
        with patch("time.sleep"):
            with pytest.raises(Exception, match="Server error"):
                bot._submit_with_retry("TEST", fn, "arg1", max_retries=3)
        assert fn.call_count == 3

    def test_does_not_retry_non_transient(self):
        bot = _make_bot()
        err = Exception("Bad request")
        resp = MagicMock()
        resp.status_code = 400
        err.response = resp
        fn = MagicMock(side_effect=err)
        with pytest.raises(Exception, match="Bad request"):
            bot._submit_with_retry("TEST", fn, "arg1")
        assert fn.call_count == 1

    def test_retries_on_timeout(self):
        bot = _make_bot()
        fn = MagicMock(side_effect=[TimeoutError("timed out"), {"ok": True}])
        with patch("time.sleep"):
            result = bot._submit_with_retry("TEST", fn, "arg1")
        assert result == {"ok": True}


class TestDoSubmitPaper:
    @patch("peerzero_bot.agent.search_and_summarize")
    @patch("peerzero_bot.agent.extract_json")
    def test_full_paper_flow(self, mock_extract, mock_search):
        bot = _make_bot()
        bot.startup()
        # Step 1: concept generation
        mock_extract.return_value = {
            "working_title": "Test Paper",
            "core_claim": "Something new",
            "search_queries": ["query 1"],
            "opposing_queries": ["query 2"],
        }
        # Step 2: search
        mock_search.return_value = [{"title": "Evidence Paper", "doi": "10.1234/test"}]
        # Step 3: paper generation
        bot.llm.call_json.return_value = {
            "title": "My Paper", "abstract": "Abstract text", "body": "Full body",
            "field_ids": ["ai"], "confidence_score": 7,
            "falsifiable_claim": "X causes Y",
            "citations": [{"doi": "10.1234/test"}],
        }
        profile = {"next_action": "submit_paper", "research_history": []}
        result = bot._do_submit_paper("system", profile, "paper skill")
        assert result is not None
        bot.school.submit_paper.assert_called_once()

    @patch("peerzero_bot.agent.search_and_summarize")
    @patch("peerzero_bot.agent.extract_json")
    def test_bad_llm_output_returns_none(self, mock_extract, mock_search):
        bot = _make_bot()
        bot.startup()
        mock_extract.return_value = {"search_queries": ["q"]}
        mock_search.return_value = []
        bot.llm.call_json.return_value = None  # LLM fails
        result = bot._do_submit_paper("system", {}, "skill")
        assert result is None
        bot.school.submit_paper.assert_not_called()

    @patch("peerzero_bot.agent.search_and_summarize")
    @patch("peerzero_bot.agent.extract_json")
    def test_submit_failure_returns_none(self, mock_extract, mock_search):
        bot = _make_bot()
        bot.startup()
        mock_extract.return_value = {"search_queries": ["q"]}
        mock_search.return_value = []
        bot.llm.call_json.return_value = {"title": "T", "abstract": "A", "body": "B", "citations": []}
        bot.school.submit_paper.side_effect = Exception("Server error")
        result = bot._do_submit_paper("system", {}, "skill")
        assert result is None
