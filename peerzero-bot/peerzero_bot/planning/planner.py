"""
Planner — turns directives into agendas through identity.

When a directive arrives (user chat, schedule, etc.), the planner makes
one LLM call with the bot's full identity stack and asks: "Given who
you are and how you choose, what specifically will you do?"

The LLM reads L5/L4 identity + L5d/L4d decision track and generates
a plan that is shaped by the bot's earned instincts — not generic steps.

This is the "reflect on identity → form intention → plan steps" phase
that sits between receiving a directive and executing actions.
"""

import json
import logging
from typing import Optional

from .action_desk import ActionDesk, Agenda

logger = logging.getLogger("peerzero-bot.planning")

# ═════════════════════════════════════════════════════════════════════════════
# PLANNING PROMPT
# ═════════════════════════════════════════════════════════════════════════════

PLANNING_PROMPT = """A directive has arrived. You need to plan what to do.

DIRECTIVE: {directive}

{desk_context}
{recent_completions}

Based on your identity — who you are, what you've learned, how you choose —
create a concrete action plan. Your plan should reflect YOUR instincts and
values, not generic steps anyone would take.

Think about:
- What does your identity tell you about how to approach this?
- What has your decision experience taught you about choosing well?
- What specific actions will you take, in what order?
- Are there follow-up actions you should plan for (checking back, etc.)?

Return a JSON object:
{{
  "intention": "<what you want to accomplish and why — in your own voice>",
  "identity_reasoning": "<how your identity and decision instincts shaped this plan>",
  "steps": [
    {{
      "action": "<concrete action description>",
      "platform": "<platform name if applicable, empty string if not>"
    }}
  ]
}}

Keep steps concrete and actionable. Each step should be something you can
actually execute. 3-8 steps is typical — don't over-plan."""


REPLAN_PROMPT = """You are partway through an agenda but encountered a problem.

{desk_context}

The current step failed or got stuck: {failure_reason}

Based on your identity and what you've learned so far in this agenda,
decide how to proceed. You can:
1. Retry the current step with a different approach
2. Skip it and move on
3. Add new steps to work around the problem
4. Abandon the agenda if it's no longer feasible

Return a JSON object:
{{
  "decision": "<retry | skip | add_steps | abandon>",
  "reasoning": "<why this is the right choice given your identity>",
  "new_steps": [
    {{
      "action": "<new step description>",
      "platform": "<platform name if applicable>"
    }}
  ]
}}

new_steps is only needed if decision is "add_steps". Otherwise leave it empty."""


# ═════════════════════════════════════════════════════════════════════════════
# DIRECTIVE DETECTION
# ═════════════════════════════════════════════════════════════════════════════

# Keywords/patterns that suggest a message is a directive rather than conversation
_DIRECTIVE_SIGNALS = [
    "go ",
    "go to ",
    "check out ",
    "look at ",
    "find ",
    "post ",
    "respond to ",
    "fact check",
    "fact-check",
    "review some ",
    "browse ",
    "search ",
    "write about ",
    "comment on ",
    "reply to ",
    "have fun on ",
    "spend time on ",
    "hang out on ",
    "do some ",
]


def looks_like_directive(message: str) -> bool:
    """
    Quick heuristic check if a user message looks like a directive
    rather than a conversation.

    This is a first-pass filter — the LLM makes the final call on
    ambiguous messages.
    """
    lower = message.strip().lower()

    # Short messages are usually conversational
    if len(lower) < 5:
        return False

    # Check for directive signal words
    for signal in _DIRECTIVE_SIGNALS:
        if lower.startswith(signal):
            return True

    # Imperative mood: starts with a verb (rough heuristic)
    # "Go to reddit" vs "What do you think about reddit"
    # Questions are almost never directives
    if lower.endswith("?"):
        return False

    return False


# ═════════════════════════════════════════════════════════════════════════════
# PLANNER
# ═════════════════════════════════════════════════════════════════════════════

class Planner:
    """
    Turns directives into identity-driven agendas.

    Usage:
        planner = Planner(desk=action_desk, llm=llm_client, prompts=prompt_builder, memory=memory_manager)

        # When a directive arrives:
        if planner.is_directive(message):
            agenda = planner.plan(message, system_prompt)

        # When a step fails:
        planner.replan(agenda, "Reddit returned 403", system_prompt)
    """

    def __init__(self, desk: ActionDesk, llm, prompts, memory):
        """
        Args:
            desk: ActionDesk instance for creating/managing agendas
            llm: LLMClient (strong model — planning uses Opus)
            prompts: PromptBuilder for building system prompts with identity
            memory: MemoryManager for accessing identity layers
        """
        self._desk = desk
        self._llm = llm
        self._prompts = prompts
        self._memory = memory

    def is_directive(self, message: str) -> bool:
        """Check if a message looks like an action directive."""
        return looks_like_directive(message)

    def plan(self, directive: str, system_prompt: str = "") -> Optional[Agenda]:
        """
        Generate an agenda from a directive by running it through identity.

        Args:
            directive: The trigger message (e.g. "Go fact-check on Reddit")
            system_prompt: Pre-built system prompt with identity layers.
                          If empty, builds one from memory.

        Returns:
            A new Agenda with tasks, or None if planning failed.
        """
        if not system_prompt:
            system_prompt = self._prompts.build_platform_system_prompt("autonomous")

        # Build planning context
        desk_context = self._desk.get_prompt_context()
        recent = self._desk.get_recent_completions(3)
        recent_text = ""
        if recent:
            recent_lines = ["Recent completed agendas:"]
            for r in recent:
                recent_lines.append(
                    f"  - {r['intention']} ({r['done']}/{r['total_tasks']} done, {r['status']})"
                )
            recent_text = "\n".join(recent_lines)

        user_msg = PLANNING_PROMPT.format(
            directive=directive,
            desk_context=desk_context or "No active agendas.",
            recent_completions=recent_text or "No recent agendas.",
        )

        logger.info(f"[PLANNER] Planning for directive: {directive[:100]}")

        result = self._llm.call_json(
            system_prompt,
            user_msg,
            json_keys=["intention", "steps"],
        )

        if not result or not result.get("intention") or not result.get("steps"):
            logger.warning("[PLANNER] Failed to generate plan from directive")
            return None

        # Extract steps
        steps = []
        platform = ""
        for step in result["steps"]:
            if isinstance(step, dict):
                steps.append(step.get("action", str(step)))
                if not platform and step.get("platform"):
                    platform = step["platform"]
            elif isinstance(step, str):
                steps.append(step)

        agenda = self._desk.create_agenda(
            directive=directive,
            intention=result["intention"],
            identity_reasoning=result.get("identity_reasoning", ""),
            steps=steps,
            platform=platform,
        )

        logger.info(f"[PLANNER] Created agenda: {agenda.intention} ({len(steps)} steps)")
        return agenda

    def replan(
        self,
        agenda: Agenda,
        failure_reason: str,
        system_prompt: str = "",
    ) -> str:
        """
        Handle a failed step by asking identity how to proceed.

        Args:
            agenda: The current agenda
            failure_reason: What went wrong
            system_prompt: Pre-built system prompt with identity layers

        Returns:
            The decision made: "retry", "skip", "add_steps", or "abandon"
        """
        if not system_prompt:
            system_prompt = self._prompts.build_platform_system_prompt("autonomous")

        user_msg = REPLAN_PROMPT.format(
            desk_context=agenda.to_prompt_context(),
            failure_reason=failure_reason,
        )

        logger.info(f"[PLANNER] Replanning: {failure_reason[:100]}")

        result = self._llm.call_json(
            system_prompt,
            user_msg,
            json_keys=["decision", "reasoning"],
        )

        if not result:
            logger.warning("[PLANNER] Replan failed — defaulting to skip")
            return "skip"

        decision = result.get("decision", "skip")

        if decision == "add_steps":
            new_steps = result.get("new_steps", [])
            for step in new_steps:
                action = step.get("action", str(step)) if isinstance(step, dict) else str(step)
                platform = step.get("platform", "") if isinstance(step, dict) else ""
                agenda.add_task(action, platform=platform)
            self._desk.save()

        elif decision == "abandon":
            self._desk.abandon_agenda(agenda, failure_reason)

        elif decision == "skip":
            current = agenda.current_task
            if current:
                current.mark_skipped(failure_reason)
                self._desk.save()

        logger.info(f"[PLANNER] Replan decision: {decision} — {result.get('reasoning', '')[:100]}")
        return decision
