"""Tests for the ActionDesk planning module — Task, Agenda, and ActionDesk."""

import pytest
from unittest.mock import MagicMock
from datetime import datetime, timezone

from peerzero_bot.planning.action_desk import (
    Task, Agenda, ActionDesk,
    MAX_COMPLETED_AGENDAS, MAX_ACTIVE_AGENDAS,
)


# ═════════════════════════════════════════════════════════════════════════════
# TASK DATACLASS
# ═════════════════════════════════════════════════════════════════════════════

class TestTask:
    def test_default_values(self):
        task = Task(action="Do something")
        assert task.status == "pending"
        assert task.result == ""
        assert task.platform == ""
        assert task.depends_on == []
        assert task.task_type == "action"
        assert task.metadata == {}

    def test_added_at_auto_set(self):
        task = Task(action="Do something")
        assert task.added_at != ""
        # Should be valid ISO format
        datetime.fromisoformat(task.added_at)

    def test_added_at_preserved_if_set(self):
        task = Task(action="Do something", added_at="2024-01-01T00:00:00+00:00")
        assert task.added_at == "2024-01-01T00:00:00+00:00"

    def test_mark_in_progress(self):
        task = Task(action="Do something")
        task.mark_in_progress()
        assert task.status == "in_progress"

    def test_mark_done(self):
        task = Task(action="Do something")
        task.mark_done("success")
        assert task.status == "done"
        assert task.result == "success"
        assert task.completed_at != ""

    def test_mark_done_without_result(self):
        task = Task(action="Do something")
        task.mark_done()
        assert task.status == "done"
        assert task.result == ""

    def test_mark_failed(self):
        task = Task(action="Do something")
        task.mark_failed("connection error")
        assert task.status == "failed"
        assert task.result == "connection error"
        assert task.completed_at != ""

    def test_mark_skipped(self):
        task = Task(action="Do something")
        task.mark_skipped("agenda abandoned")
        assert task.status == "skipped"
        assert task.result == "agenda abandoned"
        assert task.completed_at != ""

    def test_status_transition_pending_to_in_progress_to_done(self):
        task = Task(action="multi-step")
        assert task.status == "pending"
        task.mark_in_progress()
        assert task.status == "in_progress"
        task.mark_done("finished")
        assert task.status == "done"

    def test_status_transition_pending_to_in_progress_to_failed(self):
        task = Task(action="will fail")
        task.mark_in_progress()
        task.mark_failed("timeout")
        assert task.status == "failed"

    def test_to_dict(self):
        task = Task(action="test", platform="reddit", depends_on=[0, 1])
        d = task.to_dict()
        assert d["action"] == "test"
        assert d["platform"] == "reddit"
        assert d["depends_on"] == [0, 1]
        assert d["status"] == "pending"
        assert "added_at" in d

    def test_from_dict(self):
        data = {
            "action": "browse reddit",
            "status": "done",
            "result": "found 3 posts",
            "platform": "reddit",
            "depends_on": [0],
            "task_type": "discover",
            "added_at": "2024-01-01T00:00:00+00:00",
            "completed_at": "2024-01-01T01:00:00+00:00",
            "needs": "logged in",
            "metadata": {"key": "val"},
        }
        task = Task.from_dict(data)
        assert task.action == "browse reddit"
        assert task.status == "done"
        assert task.result == "found 3 posts"
        assert task.platform == "reddit"
        assert task.depends_on == [0]
        assert task.task_type == "discover"
        assert task.metadata == {"key": "val"}

    def test_from_dict_ignores_unknown_keys(self):
        data = {"action": "test", "unknown_field": "should be ignored"}
        task = Task.from_dict(data)
        assert task.action == "test"
        assert not hasattr(task, "unknown_field")

    def test_roundtrip_serialization(self):
        original = Task(
            action="fact check",
            status="done",
            result="verified",
            platform="twitter",
            depends_on=[0, 2],
            task_type="discover",
            metadata={"confidence": 0.9},
        )
        restored = Task.from_dict(original.to_dict())
        assert restored.action == original.action
        assert restored.status == original.status
        assert restored.result == original.result
        assert restored.platform == original.platform
        assert restored.depends_on == original.depends_on
        assert restored.task_type == original.task_type
        assert restored.metadata == original.metadata


# ═════════════════════════════════════════════════════════════════════════════
# AGENDA DATACLASS
# ═════════════════════════════════════════════════════════════════════════════

class TestAgenda:
    def _make_agenda(self, tasks=None, **kwargs):
        defaults = dict(
            directive="Go fact-check on Reddit",
            intention="Find and correct bad science",
        )
        defaults.update(kwargs)
        agenda = Agenda(**defaults)
        if tasks:
            agenda.tasks = tasks
        return agenda

    def test_default_values(self):
        agenda = self._make_agenda()
        assert agenda.status == "active"
        assert agenda.tasks == []
        assert agenda.created_at != ""
        assert agenda.completed_at == ""

    def test_created_at_auto_set(self):
        agenda = self._make_agenda()
        datetime.fromisoformat(agenda.created_at)

    def test_created_at_preserved_if_set(self):
        agenda = self._make_agenda(created_at="2024-01-01T00:00:00+00:00")
        assert agenda.created_at == "2024-01-01T00:00:00+00:00"

    # ── current_task ──

    def test_current_task_returns_in_progress_first(self):
        t1 = Task(action="step 1", status="pending")
        t2 = Task(action="step 2", status="in_progress")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.current_task is t2

    def test_current_task_returns_first_ready_pending(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="pending")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.current_task is t2

    def test_current_task_none_when_all_done(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="done")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.current_task is None

    def test_current_task_none_when_empty(self):
        agenda = self._make_agenda()
        assert agenda.current_task is None

    def test_current_task_respects_dependencies(self):
        t1 = Task(action="step 1", status="pending")
        t2 = Task(action="step 2", status="pending", depends_on=[0])
        agenda = self._make_agenda(tasks=[t1, t2])
        # Only t1 should be ready (t2 depends on t1)
        assert agenda.current_task is t1

    def test_current_task_unblocks_after_dep_done(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="pending", depends_on=[0])
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.current_task is t2

    def test_current_task_unblocks_after_dep_skipped(self):
        t1 = Task(action="step 1", status="skipped")
        t2 = Task(action="step 2", status="pending", depends_on=[0])
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.current_task is t2

    def test_current_task_blocked_when_dep_failed(self):
        t1 = Task(action="step 1", status="failed")
        t2 = Task(action="step 2", status="pending", depends_on=[0])
        t3 = Task(action="step 3", status="pending")  # no deps
        agenda = self._make_agenda(tasks=[t1, t2, t3])
        # t2 is blocked (dep failed), but t3 is ready
        assert agenda.current_task is t3

    def test_current_task_invalid_dep_index_treated_as_satisfied(self):
        t1 = Task(action="step 1", status="pending", depends_on=[99])
        agenda = self._make_agenda(tasks=[t1])
        assert agenda.current_task is t1

    # ── ready_tasks ──

    def test_ready_tasks_all_independent(self):
        t1 = Task(action="step 1", status="pending")
        t2 = Task(action="step 2", status="pending")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert len(agenda.ready_tasks) == 2

    def test_ready_tasks_respects_deps(self):
        t1 = Task(action="step 1", status="pending")
        t2 = Task(action="step 2", status="pending", depends_on=[0])
        agenda = self._make_agenda(tasks=[t1, t2])
        ready = agenda.ready_tasks
        assert len(ready) == 1
        assert ready[0] is t1

    def test_ready_tasks_excludes_done(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="pending")
        agenda = self._make_agenda(tasks=[t1, t2])
        ready = agenda.ready_tasks
        assert len(ready) == 1
        assert ready[0] is t2

    def test_ready_tasks_empty_when_all_complete(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="skipped")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.ready_tasks == []

    # ── is_complete ──

    def test_is_complete_all_done(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="done")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.is_complete is True

    def test_is_complete_mixed_terminal(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="failed")
        t3 = Task(action="step 3", status="skipped")
        agenda = self._make_agenda(tasks=[t1, t2, t3])
        assert agenda.is_complete is True

    def test_is_complete_false_with_pending(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="pending")
        agenda = self._make_agenda(tasks=[t1, t2])
        assert agenda.is_complete is False

    def test_is_complete_false_with_in_progress(self):
        t1 = Task(action="step 1", status="in_progress")
        agenda = self._make_agenda(tasks=[t1])
        assert agenda.is_complete is False

    def test_is_complete_empty_agenda(self):
        agenda = self._make_agenda()
        assert agenda.is_complete is True

    # ── progress_summary ──

    def test_progress_summary_all_done(self):
        t1 = Task(action="s1", status="done")
        t2 = Task(action="s2", status="done")
        agenda = self._make_agenda(tasks=[t1, t2])
        summary = agenda.progress_summary
        assert "2/2 done" in summary

    def test_progress_summary_mixed(self):
        t1 = Task(action="s1", status="done")
        t2 = Task(action="s2", status="failed")
        t3 = Task(action="s3", status="pending")
        agenda = self._make_agenda(tasks=[t1, t2, t3])
        summary = agenda.progress_summary
        assert "1/3 done" in summary
        assert "1 failed" in summary
        assert "1 remaining" in summary

    def test_progress_summary_empty(self):
        agenda = self._make_agenda()
        assert agenda.progress_summary == "empty"

    def test_progress_summary_skipped(self):
        t1 = Task(action="s1", status="skipped")
        agenda = self._make_agenda(tasks=[t1])
        assert "1 skipped" in agenda.progress_summary

    # ── add_task ──

    def test_add_task(self):
        agenda = self._make_agenda()
        task = agenda.add_task("check back later", platform="reddit")
        assert len(agenda.tasks) == 1
        assert task.action == "check back later"
        assert task.platform == "reddit"
        assert task.status == "pending"

    def test_add_task_with_metadata(self):
        agenda = self._make_agenda()
        task = agenda.add_task("follow up", metadata={"post_id": "abc"})
        assert task.metadata == {"post_id": "abc"}

    # ── mark_completed / mark_abandoned ──

    def test_mark_completed(self):
        agenda = self._make_agenda()
        agenda.mark_completed()
        assert agenda.status == "completed"
        assert agenda.completed_at != ""

    def test_mark_abandoned(self):
        t1 = Task(action="step 1", status="done")
        t2 = Task(action="step 2", status="pending")
        t3 = Task(action="step 3", status="in_progress")
        agenda = self._make_agenda(tasks=[t1, t2, t3])
        agenda.mark_abandoned("lost interest")
        assert agenda.status == "abandoned"
        assert t1.status == "done"  # already done, not touched
        assert t2.status == "skipped"
        assert t2.result == "lost interest"
        assert t3.status == "skipped"

    def test_mark_abandoned_default_reason(self):
        t1 = Task(action="step 1", status="pending")
        agenda = self._make_agenda(tasks=[t1])
        agenda.mark_abandoned()
        assert t1.result == "agenda abandoned"

    # ── serialization ──

    def test_to_dict(self):
        t1 = Task(action="step 1")
        agenda = self._make_agenda(
            tasks=[t1],
            identity_reasoning="because I know better",
        )
        d = agenda.to_dict()
        assert d["directive"] == "Go fact-check on Reddit"
        assert d["intention"] == "Find and correct bad science"
        assert d["identity_reasoning"] == "because I know better"
        assert len(d["tasks"]) == 1
        assert d["tasks"][0]["action"] == "step 1"

    def test_from_dict(self):
        data = {
            "directive": "do stuff",
            "intention": "accomplish things",
            "identity_reasoning": "my identity says so",
            "tasks": [
                {"action": "step 1", "status": "done", "result": "ok"},
                {"action": "step 2", "status": "pending", "depends_on": [0]},
            ],
            "status": "active",
            "created_at": "2024-01-01T00:00:00+00:00",
            "completed_at": "",
        }
        agenda = Agenda.from_dict(data)
        assert agenda.directive == "do stuff"
        assert agenda.intention == "accomplish things"
        assert len(agenda.tasks) == 2
        assert agenda.tasks[0].status == "done"
        assert agenda.tasks[1].depends_on == [0]

    def test_roundtrip_serialization(self):
        t1 = Task(action="step 1", depends_on=[])
        t2 = Task(action="step 2", depends_on=[0], task_type="discover")
        agenda = self._make_agenda(tasks=[t1, t2])
        restored = Agenda.from_dict(agenda.to_dict())
        assert restored.directive == agenda.directive
        assert restored.intention == agenda.intention
        assert len(restored.tasks) == 2
        assert restored.tasks[1].depends_on == [0]
        assert restored.tasks[1].task_type == "discover"

    # ── to_prompt_context ──

    def test_to_prompt_context_format(self):
        t1 = Task(action="browse reddit", status="done", result="found posts")
        t2 = Task(action="write corrections", status="pending", depends_on=[0])
        agenda = self._make_agenda(tasks=[t1, t2])
        ctx = agenda.to_prompt_context()
        assert "CURRENT AGENDA" in ctx
        assert "browse reddit" in ctx
        assert "[x]" in ctx
        assert "[ ]" in ctx
        assert "after step 1" in ctx

    def test_to_prompt_context_discover_tag(self):
        t1 = Task(action="explore topic", task_type="discover", status="pending")
        agenda = self._make_agenda(tasks=[t1])
        ctx = agenda.to_prompt_context()
        assert "(discover)" in ctx


# ═════════════════════════════════════════════════════════════════════════════
# ACTION DESK
# ═════════════════════════════════════════════════════════════════════════════

def _make_storage():
    """Create a mock storage backend."""
    storage = MagicMock()
    storage.read.return_value = []
    return storage


class TestActionDeskLoad:
    def test_load_empty(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        assert desk.active_agendas == []
        assert desk.has_work is False

    def test_load_restores_active_agendas(self):
        storage = _make_storage()
        agenda_data = [{
            "directive": "test", "intention": "testing",
            "tasks": [{"action": "step 1", "status": "pending"}],
            "status": "active", "created_at": "", "completed_at": "",
            "identity_reasoning": "",
        }]
        storage.read.side_effect = lambda ns, key, default: (
            agenda_data if key == "active_agendas" else default
        )
        desk = ActionDesk(storage)
        desk.load()
        assert len(desk.active_agendas) == 1
        assert desk.has_work is True


class TestActionDeskSave:
    def test_save_persists_data(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        desk.create_agenda(
            directive="test", intention="testing", steps=["step 1"],
        )
        # create_agenda calls save internally
        assert storage.write.call_count >= 1

    def test_save_limits_completed_agendas(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        # Manually add more than MAX_COMPLETED_AGENDAS
        desk._completed_agendas = [{"i": i} for i in range(MAX_COMPLETED_AGENDAS + 10)]
        desk.save()
        # Check the second write call (completed_agendas)
        calls = storage.write.call_args_list
        completed_call = [c for c in calls if c[0][1] == "completed_agendas"]
        assert len(completed_call) > 0
        saved = completed_call[-1][0][2]
        assert len(saved) == MAX_COMPLETED_AGENDAS


class TestActionDeskCreateAgenda:
    def test_creates_agenda_with_steps(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="Go to Reddit",
            intention="Find bad science",
            identity_reasoning="My training...",
            steps=["Browse r/science", "Find claims", "Write corrections"],
        )
        assert agenda.directive == "Go to Reddit"
        assert agenda.intention == "Find bad science"
        assert len(agenda.tasks) == 3
        assert agenda.tasks[0].action == "Browse r/science"

    def test_creates_agenda_with_deps_and_types(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test",
            intention="testing",
            steps=["discover", "act"],
            step_deps=[[], [0]],
            step_types=["discover", "action"],
        )
        assert agenda.tasks[0].task_type == "discover"
        assert agenda.tasks[1].depends_on == [0]

    def test_creates_agenda_with_needs(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test",
            intention="testing",
            steps=["login", "post"],
            step_needs=["", "must be logged in"],
        )
        assert agenda.tasks[1].needs == "must be logged in"

    def test_max_active_agendas_abandons_oldest(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        # Fill to MAX_ACTIVE_AGENDAS
        agendas = []
        for i in range(MAX_ACTIVE_AGENDAS):
            a = desk.create_agenda(
                directive=f"dir-{i}", intention=f"int-{i}", steps=[f"step-{i}"],
            )
            agendas.append(a)
        assert len(desk.active_agendas) == MAX_ACTIVE_AGENDAS

        # Creating one more should abandon the oldest
        new_agenda = desk.create_agenda(
            directive="new", intention="new intent", steps=["new step"],
        )
        assert len(desk.active_agendas) == MAX_ACTIVE_AGENDAS
        # The new one should be in the list
        assert new_agenda in desk.active_agendas
        # The oldest should be gone
        assert agendas[0] not in desk.active_agendas

    def test_adds_to_active_list(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(directive="d", intention="i", steps=["s"])
        assert agenda in desk.active_agendas

    def test_creates_agenda_no_steps(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(directive="d", intention="i")
        assert len(agenda.tasks) == 0


class TestActionDeskCompleteAgenda:
    def test_complete_agenda_returns_exercise(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test",
            intention="testing",
            steps=["step 1", "step 2"],
        )
        agenda.tasks[0].mark_done("ok")
        agenda.tasks[1].mark_done("also ok")
        exercise = desk.complete_agenda(agenda)
        assert exercise["interaction_type"] == "autonomous_agenda"
        assert exercise["skill"] == "directive_planning"
        assert exercise["hit"] is True
        assert exercise["tasks_done"] == 2
        assert exercise["tasks_total"] == 2
        assert agenda not in desk.active_agendas

    def test_complete_agenda_with_failures(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing", steps=["s1", "s2"],
        )
        agenda.tasks[0].mark_done("ok")
        agenda.tasks[1].mark_failed("timeout")
        exercise = desk.complete_agenda(agenda)
        assert exercise["hit"] is False
        assert exercise["tasks_failed"] == 1

    def test_complete_agenda_adds_to_completed_list(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing", steps=["s1"],
        )
        agenda.tasks[0].mark_done("ok")
        desk.complete_agenda(agenda)
        completions = desk.get_recent_completions()
        assert len(completions) == 1
        assert completions[0]["directive"] == "test"


class TestActionDeskAbandonAgenda:
    def test_abandon_agenda(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing", steps=["s1", "s2"],
        )
        exercise = desk.abandon_agenda(agenda, reason="lost interest")
        assert agenda.status == "abandoned"
        assert exercise["outcome"] == "abandoned"
        assert agenda not in desk.active_agendas

    def test_abandon_skips_pending_tasks(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing", steps=["s1", "s2"],
        )
        agenda.tasks[0].mark_done("ok")
        desk.abandon_agenda(agenda)
        assert agenda.tasks[0].status == "done"
        assert agenda.tasks[1].status == "skipped"


class TestActionDeskBuildExercise:
    def test_exercise_includes_discover_results(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing",
            steps=["explore", "act"],
            step_types=["discover", "action"],
        )
        agenda.tasks[0].mark_done("found 3 items")
        agenda.tasks[1].mark_done("posted")
        exercise = desk._build_exercise(agenda)
        assert exercise["used_discover"] is True
        assert "found 3 items" in exercise.get("discover_results", "")

    def test_exercise_includes_dependency_info(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="test", intention="testing",
            steps=["s1", "s2"],
            step_deps=[[], [0]],
        )
        agenda.tasks[0].mark_done("ok")
        agenda.tasks[1].mark_done("ok")
        exercise = desk._build_exercise(agenda)
        assert exercise["used_dependencies"] is True

    def test_exercise_decision_narrative_format(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        agenda = desk.create_agenda(
            directive="Go to Reddit",
            intention="Find bad science",
            identity_reasoning="My training says so",
            steps=["browse", "correct"],
        )
        agenda.tasks[0].mark_done("found posts")
        agenda.tasks[1].mark_failed("blocked")
        exercise = desk._build_exercise(agenda)
        narrative = exercise["decision_narrative"]
        assert "Go to Reddit" in narrative
        assert "Find bad science" in narrative
        assert "My training says so" in narrative
        assert "Steps that worked" in narrative
        assert "Steps that failed" in narrative


class TestActionDeskPromptContext:
    def test_empty_when_no_agendas(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        assert desk.get_prompt_context() == ""

    def test_includes_active_agendas(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        desk.create_agenda(
            directive="test", intention="testing", steps=["s1"],
        )
        ctx = desk.get_prompt_context()
        assert "ACTION DESK" in ctx
        assert "testing" in ctx


class TestActionDeskRecentCompletions:
    def test_empty_by_default(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        assert desk.get_recent_completions() == []

    def test_returns_limited_results(self):
        storage = _make_storage()
        desk = ActionDesk(storage)
        desk.load()
        for i in range(10):
            agenda = desk.create_agenda(
                directive=f"d-{i}", intention=f"i-{i}", steps=[f"s-{i}"],
            )
            agenda.tasks[0].mark_done("ok")
            desk.complete_agenda(agenda)
        recent = desk.get_recent_completions(limit=3)
        assert len(recent) == 3
