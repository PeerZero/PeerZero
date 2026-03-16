"""Tests for the autonomy policy and gate."""

import pytest
from peerzero_bot.autonomy import AutonomyPolicy, AutonomyGate, PolicyDecision


class TestAutonomyPolicy:
    """Tests for policy configuration and validation."""

    def test_default_policy(self):
        policy = AutonomyPolicy()
        assert policy.level == "guided"
        assert policy.max_actions_per_cycle == 10
        assert policy.max_tool_calls_per_cycle == 5
        assert policy.validate() == []

    def test_valid_levels(self):
        for level in ("supervised", "guided", "autonomous"):
            policy = AutonomyPolicy(level=level)
            assert policy.validate() == []

    def test_invalid_level(self):
        policy = AutonomyPolicy(level="yolo")
        errors = policy.validate()
        assert len(errors) == 1
        assert "Invalid autonomy level" in errors[0]

    def test_invalid_max_actions(self):
        policy = AutonomyPolicy(max_actions_per_cycle=0)
        errors = policy.validate()
        assert any("max_actions_per_cycle" in e for e in errors)

    def test_invalid_max_tool_calls(self):
        policy = AutonomyPolicy(max_tool_calls_per_cycle=-1)
        errors = policy.validate()
        assert any("max_tool_calls_per_cycle" in e for e in errors)


class TestPolicyDecision:
    def test_allowed_is_truthy(self):
        d = PolicyDecision(True, "ok")
        assert d
        assert d.allowed

    def test_denied_is_falsy(self):
        d = PolicyDecision(False, "blocked")
        assert not d
        assert not d.allowed

    def test_requires_approval(self):
        d = PolicyDecision(True, "needs check", requires_approval=True)
        assert d.allowed
        assert d.requires_approval

    def test_repr(self):
        d = PolicyDecision(True, "test", requires_approval=True)
        r = repr(d)
        assert "ALLOWED" in r
        assert "needs approval" in r


class TestAutonomyGate:
    """Tests for action gating logic."""

    def test_allowed_action_passes(self):
        gate = AutonomyGate(AutonomyPolicy())
        decision = gate.check_action("review", "school")
        assert decision
        assert decision.allowed

    def test_rate_limiting(self):
        """Actions should be blocked after hitting the per-cycle limit."""
        policy = AutonomyPolicy(max_actions_per_cycle=3)
        gate = AutonomyGate(policy)

        for i in range(3):
            assert gate.check_action("post", "moltbook")

        decision = gate.check_action("post", "moltbook")
        assert not decision
        assert "Rate limit" in decision.reason

    def test_tool_call_rate_limiting(self):
        policy = AutonomyPolicy(max_tool_calls_per_cycle=2)
        gate = AutonomyGate(policy)

        assert gate.check_action("tool_call", "research", tool_name="search")
        assert gate.check_action("tool_call", "research", tool_name="fetch")

        decision = gate.check_action("tool_call", "research", tool_name="another")
        assert not decision
        assert "Tool rate limit" in decision.reason

    def test_reset_cycle_counters(self):
        policy = AutonomyPolicy(max_actions_per_cycle=1)
        gate = AutonomyGate(policy)

        assert gate.check_action("post", "moltbook")
        assert not gate.check_action("post", "moltbook")

        gate.reset_cycle_counters()
        assert gate.check_action("post", "moltbook")

    def test_blocked_action_type(self):
        policy = AutonomyPolicy(blocked_actions=["delete", "ban"])
        gate = AutonomyGate(policy)

        assert not gate.check_action("delete", "moltbook")
        assert not gate.check_action("ban", "moltbook")
        assert gate.check_action("post", "moltbook")

    def test_allowed_action_type(self):
        policy = AutonomyPolicy(allowed_actions=["post", "comment"])
        gate = AutonomyGate(policy)

        assert gate.check_action("post", "moltbook")
        assert gate.check_action("comment", "moltbook")
        assert not gate.check_action("delete", "moltbook")

    def test_blocked_platform(self):
        policy = AutonomyPolicy(blocked_platforms=["evil-site"])
        gate = AutonomyGate(policy)

        assert not gate.check_action("post", "evil-site")
        assert gate.check_action("post", "moltbook")

    def test_allowed_platform(self):
        policy = AutonomyPolicy(allowed_platforms=["moltbook"])
        gate = AutonomyGate(policy)

        assert gate.check_action("post", "moltbook")
        assert not gate.check_action("post", "other-site")

    def test_empty_platform_allows_all(self):
        """Empty platform lists mean no platform restrictions."""
        policy = AutonomyPolicy(allowed_platforms=[], blocked_platforms=[])
        gate = AutonomyGate(policy)
        assert gate.check_action("post", "any-platform")

    def test_blocked_tool_name(self):
        policy = AutonomyPolicy(blocked_tools=["dangerous_*", "rm_rf"])
        gate = AutonomyGate(policy)

        assert not gate.check_action("tool_call", "research", tool_name="dangerous_delete")
        assert not gate.check_action("tool_call", "research", tool_name="rm_rf")
        assert gate.check_action("tool_call", "research", tool_name="search")

    def test_allowed_tool_name(self):
        policy = AutonomyPolicy(allowed_tools=["search_*", "read_*"])
        gate = AutonomyGate(policy)

        assert gate.check_action("tool_call", "research", tool_name="search_web")
        assert gate.check_action("tool_call", "research", tool_name="read_file")
        assert not gate.check_action("tool_call", "research", tool_name="write_file")

    def test_tool_pattern_case_insensitive(self):
        policy = AutonomyPolicy(blocked_tools=["SEARCH_*"])
        gate = AutonomyGate(policy)
        assert not gate.check_action("tool_call", "r", tool_name="search_web")

    def test_school_action_restrictions(self):
        policy = AutonomyPolicy(
            can_submit_papers=False,
            can_submit_reviews=True,
            can_file_bounties=False,
            can_revise_papers=False,
        )
        gate = AutonomyGate(policy)

        assert not gate.check_action("submit_paper", "school")
        assert gate.check_action("review", "school")
        assert not gate.check_action("file_bounty", "school")
        assert not gate.check_action("revise", "school")

    def test_content_length_limit(self):
        policy = AutonomyPolicy(max_content_length=100)
        gate = AutonomyGate(policy)

        assert gate.check_action("post", "moltbook", content="short")
        assert not gate.check_action("post", "moltbook", content="x" * 101)

    def test_blocked_content_patterns(self):
        policy = AutonomyPolicy(
            blocked_content_patterns=[r"api[_-]?key", r"password\s*[:=]"],
        )
        gate = AutonomyGate(policy)

        assert not gate.check_action("post", "m", content="My api_key is abc123")
        assert not gate.check_action("post", "m", content="password: secret")
        assert gate.check_action("post", "m", content="Hello world")

    def test_invalid_regex_pattern_skipped(self):
        """Invalid regex patterns should be skipped, not crash."""
        policy = AutonomyPolicy(blocked_content_patterns=["[invalid"])
        gate = AutonomyGate(policy)
        # Should not crash, just skip the bad pattern
        assert gate.check_action("post", "m", content="anything")

    def test_supervised_mode_requires_approval(self):
        policy = AutonomyPolicy(level="supervised")
        gate = AutonomyGate(policy)

        decision = gate.check_action("post", "moltbook")
        assert decision.allowed
        assert decision.requires_approval

    def test_guided_mode_no_approval_needed(self):
        policy = AutonomyPolicy(level="guided")
        gate = AutonomyGate(policy)

        decision = gate.check_action("post", "moltbook")
        assert decision.allowed
        assert not decision.requires_approval

    def test_autonomous_mode_no_approval_needed(self):
        policy = AutonomyPolicy(level="autonomous")
        gate = AutonomyGate(policy)

        decision = gate.check_action("post", "moltbook")
        assert decision.allowed
        assert not decision.requires_approval

    def test_action_counter_increments(self):
        """Allowed actions should increment the counter."""
        policy = AutonomyPolicy(max_actions_per_cycle=5)
        gate = AutonomyGate(policy)

        gate.check_action("post", "m")
        gate.check_action("comment", "m")
        gate.check_action("vote", "m")
        assert gate._action_count == 3

    def test_tool_call_counter_increments(self):
        policy = AutonomyPolicy(max_tool_calls_per_cycle=5)
        gate = AutonomyGate(policy)

        gate.check_action("tool_call", "r", tool_name="search")
        gate.check_action("tool_call", "r", tool_name="fetch")
        assert gate._tool_call_count == 2

    def test_denied_action_does_not_increment(self):
        """Blocked actions should NOT increment the counter."""
        policy = AutonomyPolicy(blocked_actions=["delete"])
        gate = AutonomyGate(policy)

        gate.check_action("delete", "m")
        assert gate._action_count == 0
