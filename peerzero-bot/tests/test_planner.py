"""Tests for the Planner module — directive detection and agenda generation."""

import pytest
from unittest.mock import MagicMock, patch

from peerzero_bot.planning.planner import Planner, looks_like_directive
from peerzero_bot.planning.action_desk import ActionDesk, Agenda, Task


# ═════════════════════════════════════════════════════════════════════════════
# DIRECTIVE DETECTION
# ═════════════════════════════════════════════════════════════════════════════

class TestLooksLikeDirective:
    """Test the heuristic directive detector."""

    def test_go_prefix(self):
        assert looks_like_directive("Go fact-check on Reddit") is True

    def test_go_to_prefix(self):
        assert looks_like_directive("Go to Reddit and find bad science") is True

    def test_check_out_prefix(self):
        assert looks_like_directive("Check out this thread on Twitter") is True

    def test_look_at_prefix(self):
        assert looks_like_directive("Look at r/science for misinformation") is True

    def test_find_prefix(self):
        assert looks_like_directive("Find bad science claims") is True

    def test_post_prefix(self):
        assert looks_like_directive("Post a correction about vaccines") is True

    def test_respond_to_prefix(self):
        assert looks_like_directive("Respond to this tweet about climate") is True

    def test_fact_check(self):
        assert looks_like_directive("Fact check this claim about AI") is True

    def test_fact_check_hyphenated(self):
        assert looks_like_directive("Fact-check this article") is True

    def test_browse_prefix(self):
        assert looks_like_directive("Browse r/science for trending posts") is True

    def test_search_prefix(self):
        assert looks_like_directive("Search for misinformation about vaccines") is True

    def test_write_about_prefix(self):
        assert looks_like_directive("Write about the new climate data") is True

    def test_comment_on_prefix(self):
        assert looks_like_directive("Comment on the top post about AI") is True

    def test_reply_to_prefix(self):
        assert looks_like_directive("Reply to this thread") is True

    def test_have_fun_on_prefix(self):
        assert looks_like_directive("Have fun on Twitter for a while") is True

    def test_spend_time_on_prefix(self):
        assert looks_like_directive("Spend time on Reddit engaging") is True

    def test_do_some_prefix(self):
        assert looks_like_directive("Do some fact-checking on Reddit") is True

    def test_short_message_returns_false(self):
        assert looks_like_directive("hi") is False
        assert looks_like_directive("ok") is False

    def test_question_returns_false(self):
        assert looks_like_directive("What do you think about Reddit?") is False

    def test_empty_string_returns_false(self):
        assert looks_like_directive("") is False

    def test_non_directive_statement(self):
        assert looks_like_directive("I think science is interesting") is False

    def test_case_insensitive(self):
        assert looks_like_directive("GO TO REDDIT NOW") is True
        assert looks_like_directive("FIND bad claims") is True

    def test_whitespace_trimmed(self):
        assert looks_like_directive("  Go to Reddit  ") is True

    def test_four_char_message(self):
        assert looks_like_directive("  hi  ") is False


# ═════════════════════════════════════════════════════════════════════════════
# PLANNER CLASS
# ═════════════════════════════════════════════════════════════════════════════

def _make_planner(**overrides):
    """Create a Planner with mocked dependencies."""
    storage = MagicMock()
    storage.read.return_value = []
    desk = ActionDesk(storage)
    desk.load()

    llm = MagicMock()
    prompts = MagicMock()
    prompts.build_platform_system_prompt.return_value = "You are a bot."
    memory = MagicMock()

    deps = dict(desk=desk, llm=llm, prompts=prompts, memory=memory)
    deps.update(overrides)
    return Planner(**deps), deps


class TestPlannerIsDirective:
    def test_delegates_to_looks_like_directive(self):
        planner, _ = _make_planner()
        assert planner.is_directive("Go to Reddit") is True
        assert planner.is_directive("What do you think?") is False


class TestPlannerPlan:
    def test_plan_generates_agenda(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {
            "intention": "Find bad science on Reddit",
            "identity_reasoning": "My training tells me to verify claims",
            "steps": [
                {"action": "Browse r/science", "platform": "reddit", "needs": "", "depends_on": [], "type": "action"},
                {"action": "Find 3 bad claims", "platform": "reddit", "needs": "", "depends_on": [0], "type": "action"},
                {"action": "Write corrections", "platform": "reddit", "needs": "", "depends_on": [1], "type": "action"},
            ],
        }
        agenda = planner.plan("Go fact-check on Reddit", "system prompt")
        assert agenda is not None
        assert agenda.intention == "Find bad science on Reddit"
        assert len(agenda.tasks) == 3
        assert agenda.tasks[1].depends_on == [0]
        assert agenda.tasks[0].platform == "reddit"

    def test_plan_with_string_steps(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {
            "intention": "Do stuff",
            "steps": ["step one", "step two"],
        }
        agenda = planner.plan("Do stuff", "system prompt")
        assert agenda is not None
        assert len(agenda.tasks) == 2
        assert agenda.tasks[0].action == "step one"
        assert agenda.tasks[0].task_type == "action"

    def test_plan_with_discover_type(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {
            "intention": "Explore and act",
            "steps": [
                {"action": "discover topic", "type": "discover", "depends_on": []},
                {"action": "take action", "type": "action", "depends_on": [0]},
            ],
        }
        agenda = planner.plan("Explore Reddit", "sys")
        assert agenda.tasks[0].task_type == "discover"
        assert agenda.tasks[1].task_type == "action"

    def test_plan_returns_none_on_empty_result(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = None
        agenda = planner.plan("Go to Reddit", "sys")
        assert agenda is None

    def test_plan_returns_none_on_missing_intention(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {"steps": ["s1"]}
        agenda = planner.plan("Go to Reddit", "sys")
        assert agenda is None

    def test_plan_returns_none_on_missing_steps(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {"intention": "do stuff"}
        agenda = planner.plan("Go to Reddit", "sys")
        assert agenda is None

    def test_plan_returns_none_on_empty_steps(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {"intention": "do stuff", "steps": []}
        agenda = planner.plan("Go to Reddit", "sys")
        assert agenda is None

    def test_plan_uses_default_system_prompt_when_empty(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {
            "intention": "test", "steps": [{"action": "s1", "depends_on": []}],
        }
        planner.plan("Go to Reddit")
        deps["prompts"].build_platform_system_prompt.assert_called_once_with("autonomous")

    def test_plan_extracts_platform_from_steps(self):
        planner, deps = _make_planner()
        deps["llm"].call_json.return_value = {
            "intention": "test",
            "steps": [
                {"action": "browse", "platform": "twitter", "depends_on": []},
                {"action": "post", "depends_on": [0]},
            ],
        }
        agenda = planner.plan("Go to Twitter", "sys")
        # All tasks should have platform set from first step with platform
        assert agenda.tasks[0].platform == "twitter"


class TestPlannerReplan:
    def _make_agenda_with_tasks(self, planner, deps):
        deps["llm"].call_json.return_value = {
            "intention": "test",
            "steps": [{"action": "s1", "depends_on": []}, {"action": "s2", "depends_on": [0]}],
        }
        return planner.plan("test directive", "sys")

    def test_replan_skip(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)
        agenda.tasks[0].mark_in_progress()

        deps["llm"].call_json.return_value = {
            "decision": "skip",
            "reasoning": "not worth retrying",
            "new_steps": [],
        }
        decision = planner.replan(agenda, "403 Forbidden", "sys")
        assert decision == "skip"
        assert agenda.tasks[0].status == "skipped"

    def test_replan_abandon(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)
        agenda.tasks[0].mark_in_progress()

        deps["llm"].call_json.return_value = {
            "decision": "abandon",
            "reasoning": "no longer feasible",
        }
        decision = planner.replan(agenda, "site down", "sys")
        assert decision == "abandon"
        assert agenda.status == "abandoned"

    def test_replan_add_steps(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)
        original_count = len(agenda.tasks)

        deps["llm"].call_json.return_value = {
            "decision": "add_steps",
            "reasoning": "need alternative approach",
            "new_steps": [
                {"action": "try different URL", "platform": "reddit"},
                {"action": "verify results"},
            ],
        }
        decision = planner.replan(agenda, "page not found", "sys")
        assert decision == "add_steps"
        assert len(agenda.tasks) == original_count + 2

    def test_replan_retry(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)

        deps["llm"].call_json.return_value = {
            "decision": "retry",
            "reasoning": "transient error",
        }
        decision = planner.replan(agenda, "timeout", "sys")
        assert decision == "retry"

    def test_replan_defaults_to_skip_on_failure(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)

        deps["llm"].call_json.return_value = None
        decision = planner.replan(agenda, "unknown error", "sys")
        assert decision == "skip"

    def test_replan_uses_default_system_prompt(self):
        planner, deps = _make_planner()
        agenda = self._make_agenda_with_tasks(planner, deps)

        deps["llm"].call_json.return_value = {"decision": "skip", "reasoning": "x"}
        planner.replan(agenda, "error")
        deps["prompts"].build_platform_system_prompt.assert_called_with("autonomous")


class TestPlannerReflect:
    def test_reflect_enriches_exercise(self):
        planner, deps = _make_planner()
        exercise = {
            "interaction_type": "autonomous_agenda",
            "steps_narrative": "Step 1 [DONE]: browse\nStep 2 [DONE]: post",
        }
        agenda = Agenda(
            directive="test", intention="testing",
            identity_reasoning="because I chose to",
        )
        agenda.mark_completed()

        deps["llm"].call_json.return_value = {
            "decision_reflection": "I learned I rush into posting",
            "operational_learning": "Reddit rate limits after 5 posts",
            "planning_quality": "mixed",
            "would_change": "Add a rate limit check step",
        }
        enriched = planner.reflect(agenda, exercise, "sys")
        assert enriched["decision_reflection"] == "I learned I rush into posting"
        assert enriched["operational_learning"] == "Reddit rate limits after 5 posts"
        assert enriched["planning_quality"] == "mixed"
        assert enriched["would_change"] == "Add a rate limit check step"

    def test_reflect_handles_llm_failure(self):
        planner, deps = _make_planner()
        exercise = {"interaction_type": "autonomous_agenda", "steps_narrative": ""}
        agenda = Agenda(directive="test", intention="testing")

        deps["llm"].call_json.return_value = None
        enriched = planner.reflect(agenda, exercise, "sys")
        # Should return exercise unchanged (no crash)
        assert enriched is exercise
        assert "decision_reflection" not in enriched

    def test_reflect_uses_default_system_prompt(self):
        planner, deps = _make_planner()
        exercise = {"steps_narrative": ""}
        agenda = Agenda(directive="test", intention="testing")
        agenda.mark_completed()

        deps["llm"].call_json.return_value = {"decision_reflection": "x"}
        planner.reflect(agenda, exercise)
        deps["prompts"].build_platform_system_prompt.assert_called_with("autonomous")
