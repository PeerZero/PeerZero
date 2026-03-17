"""
Autonomy Policy — bounded autonomy controls for bot actions.

Implements a three-tier autonomy model:
  - supervised:  Bot proposes actions, user must approve via app
  - guided:      Bot acts freely within policy boundaries, alerts on edge cases
  - autonomous:  Full autonomy within hard limits

Policies are defined per-bot and can restrict:
  - Which action types are allowed (post, comment, vote, tool_call, etc.)
  - Which platforms can be used
  - Which MCP tools can be invoked
  - Maximum actions per cycle
  - Content filters (max length, forbidden patterns)

The policy is checked BEFORE every action. Denied actions are logged
but not executed.
"""

import re
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("peerzero-bot.autonomy")


@dataclass
class AutonomyPolicy:
    """
    Policy definition for a bot's autonomy boundaries.

    Configured via TOML [autonomy] section or environment variables.
    """

    # ── Autonomy level ─────────────────────────────────────────────────────
    level: str = "guided"  # "supervised", "guided", "autonomous"

    # ── Action allowlists ──────────────────────────────────────────────────
    # Empty list = all allowed. Non-empty = only listed actions permitted.
    allowed_actions: list[str] = field(default_factory=list)
    blocked_actions: list[str] = field(default_factory=list)

    # ── Platform restrictions ──────────────────────────────────────────────
    allowed_platforms: list[str] = field(default_factory=list)
    blocked_platforms: list[str] = field(default_factory=list)

    # ── MCP tool restrictions ──────────────────────────────────────────────
    allowed_tools: list[str] = field(default_factory=list)    # tool name patterns
    blocked_tools: list[str] = field(default_factory=list)    # tool name patterns

    # ── Rate limits ────────────────────────────────────────────────────────
    max_actions_per_cycle: int = 10        # max tool calls / actions per cycle
    max_tool_calls_per_cycle: int = 5      # max MCP tool invocations per cycle

    # ── Content limits ─────────────────────────────────────────────────────
    max_content_length: int = 10000        # max chars in action content
    blocked_content_patterns: list[str] = field(default_factory=list)

    # ── School action restrictions ─────────────────────────────────────────
    can_submit_papers: bool = True
    can_submit_reviews: bool = True
    can_file_bounties: bool = True
    can_revise_papers: bool = True

    def validate(self) -> list[str]:
        """Validate policy configuration. Returns list of errors."""
        errors = []
        if self.level not in ("supervised", "guided", "autonomous"):
            errors.append(f"Invalid autonomy level: {self.level}")
        if self.max_actions_per_cycle < 1:
            errors.append("max_actions_per_cycle must be >= 1")
        if self.max_tool_calls_per_cycle < 0:
            errors.append("max_tool_calls_per_cycle must be >= 0")
        return errors


class PolicyDecision:
    """Result of a policy check."""

    def __init__(self, allowed: bool, reason: str = "", requires_approval: bool = False):
        self.allowed = allowed
        self.reason = reason
        self.requires_approval = requires_approval

    def __bool__(self):
        return self.allowed

    def __repr__(self):
        status = "ALLOWED" if self.allowed else "DENIED"
        approval = " (needs approval)" if self.requires_approval else ""
        return f"PolicyDecision({status}{approval}: {self.reason})"


class AutonomyGate:
    """
    Enforces autonomy policy on every bot action.

    Usage:
        gate = AutonomyGate(policy)
        decision = gate.check_action("post", "moltbook", content="Hello!")
        if not decision:
            logger.warning(f"Action blocked: {decision.reason}")
    """

    def __init__(self, policy: AutonomyPolicy):
        self.policy = policy
        self._action_count: int = 0
        self._tool_call_count: int = 0
        self._compiled_blocked_patterns: list[re.Pattern] = []

        # Pre-compile blocked content patterns with length limit to prevent ReDoS
        for pattern in policy.blocked_content_patterns:
            if len(pattern) > 500:
                logger.warning(f"Blocked content pattern too long ({len(pattern)} chars), skipping")
                continue
            try:
                self._compiled_blocked_patterns.append(re.compile(pattern, re.IGNORECASE))
            except re.error as e:
                logger.warning(f"Invalid blocked content pattern '{pattern}': {e}")

    def reset_cycle_counters(self):
        """Reset per-cycle counters. Call at the start of each cycle."""
        self._action_count = 0
        self._tool_call_count = 0

    def check_action(
        self,
        action_type: str,
        platform: str = "",
        content: str = "",
        tool_name: str = "",
    ) -> PolicyDecision:
        """
        Check whether an action is allowed by the current policy.

        Returns a PolicyDecision with allowed/denied status and reason.
        In supervised mode, allowed actions are flagged as requiring approval.
        """
        policy = self.policy

        # ── Rate limiting ──────────────────────────────────────────────────
        if self._action_count >= policy.max_actions_per_cycle:
            return PolicyDecision(
                False,
                f"Rate limit: {self._action_count}/{policy.max_actions_per_cycle} actions this cycle",
            )

        if action_type == "tool_call" and self._tool_call_count >= policy.max_tool_calls_per_cycle:
            return PolicyDecision(
                False,
                f"Tool rate limit: {self._tool_call_count}/{policy.max_tool_calls_per_cycle} tool calls this cycle",
            )

        # ── Action type checks ─────────────────────────────────────────────
        if policy.blocked_actions and action_type in policy.blocked_actions:
            return PolicyDecision(False, f"Action type '{action_type}' is blocked by policy")

        if policy.allowed_actions and action_type not in policy.allowed_actions:
            return PolicyDecision(False, f"Action type '{action_type}' not in allowed list")

        # ── Platform checks ────────────────────────────────────────────────
        if platform:
            if policy.blocked_platforms and platform in policy.blocked_platforms:
                return PolicyDecision(False, f"Platform '{platform}' is blocked by policy")
            if policy.allowed_platforms and platform not in policy.allowed_platforms:
                return PolicyDecision(False, f"Platform '{platform}' not in allowed list")

        # ── Tool name checks (for MCP) ─────────────────────────────────────
        if tool_name:
            if policy.blocked_tools and any(
                self._matches_pattern(tool_name, pat) for pat in policy.blocked_tools
            ):
                return PolicyDecision(False, f"Tool '{tool_name}' is blocked by policy")

            if policy.allowed_tools and not any(
                self._matches_pattern(tool_name, pat) for pat in policy.allowed_tools
            ):
                return PolicyDecision(False, f"Tool '{tool_name}' not in allowed list")

        # ── School action checks ───────────────────────────────────────────
        if action_type == "submit_paper" and not policy.can_submit_papers:
            return PolicyDecision(False, "Paper submission disabled by policy")
        if action_type == "review" and not policy.can_submit_reviews:
            return PolicyDecision(False, "Review submission disabled by policy")
        if action_type == "file_bounty" and not policy.can_file_bounties:
            return PolicyDecision(False, "Bounty filing disabled by policy")
        if action_type == "revise" and not policy.can_revise_papers:
            return PolicyDecision(False, "Paper revision disabled by policy")

        # ── Content checks ─────────────────────────────────────────────────
        if content:
            if len(content) > policy.max_content_length:
                return PolicyDecision(
                    False,
                    f"Content too long: {len(content)}/{policy.max_content_length} chars",
                )
            for pattern in self._compiled_blocked_patterns:
                # Search only first 50k chars to bound worst-case regex time
                if pattern.search(content[:50000]):
                    return PolicyDecision(
                        False,
                        f"Content matches blocked pattern: {pattern.pattern}",
                    )

        # ── All checks passed ──────────────────────────────────────────────
        self._action_count += 1
        if action_type == "tool_call":
            self._tool_call_count += 1

        # In supervised mode, flag as needing approval
        if policy.level == "supervised":
            return PolicyDecision(
                True,
                f"Action '{action_type}' allowed but requires user approval (supervised mode)",
                requires_approval=True,
            )

        return PolicyDecision(True, f"Action '{action_type}' allowed by policy")

    @staticmethod
    def _matches_pattern(name: str, pattern: str) -> bool:
        """Check if a tool name matches a pattern (supports * wildcard)."""
        if "*" in pattern:
            regex = pattern.replace("*", ".*")
            return bool(re.fullmatch(regex, name, re.IGNORECASE))
        return name.lower() == pattern.lower()
