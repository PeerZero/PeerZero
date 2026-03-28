"""
Planner — turns directives into agendas through identity.

When a directive arrives (user chat, schedule, etc.), the planner makes
one LLM call with the bot's full identity stack and asks: "Given who
you are and how you choose, what specifically will you do?"

The LLM reads L5/L4 identity + L5d/L4d decision track and generates
a plan shaped by earned instincts — not generic steps. Plans are DAGs
(directed acyclic graphs) where tasks can depend on other tasks and
independent work can run in parallel.

Tasks can be type "discover" — exploration steps where the bot needs
to learn something at runtime before it can plan further. This enables
dynamic decomposition: plan what you know, discover what you don't.
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

You already know how to do this — every platform interaction, every tool
chain, every prerequisite step. Plan the way you would actually do it:
what tools you need, what has to be true before each step can start, what
could go wrong, what you'll need to handle along the way.

Your identity shapes this plan. The same way your reasoning instincts shape
how you verify a claim, your decision instincts shape how you decompose
a task. A bot that learned its first plans always miss prerequisites plans
differently than one that hasn't been burned yet.

Return a JSON object:
{{
  "intention": "<what you want to accomplish and why — in your own voice>",
  "identity_reasoning": "<how your identity and decision instincts shaped this plan>",
  "steps": [
    {{
      "action": "<concrete action — specific enough to execute in one tool interaction>",
      "platform": "<platform name if applicable, empty string if not>",
      "needs": "<what must be true before this step can start, or empty string>",
      "depends_on": [<indices of steps this depends on, 0-based, or empty list>],
      "type": "<action | discover>"
    }}
  ]
}}

Each step should be one tool interaction or one concrete action. If a step
requires prerequisites (authentication, account creation, navigating to a
page), those are separate steps. Include them.

Steps that don't depend on each other can run in parallel — use depends_on
to show which steps must finish before others can start. Steps with no
dependencies get an empty list.

If you don't know enough to plan the full task yet, use a "discover" step
to explore first. After a discover step completes, you can add more steps
based on what you learned. Don't force a complete plan when you need
runtime information — plan what you know, discover what you don't."""


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


REFLECTION_PROMPT = """You just completed an autonomous agenda. Reflect on what
this experience revealed about who you are as a planner and chooser.

COMPLETED AGENDA:
{agenda_summary}

STEP RESULTS:
{steps_narrative}

Your identity already shaped this plan. Now look at what happened — did the
plan match reality? Where did you miss prerequisites, misjudge step
granularity, or discover the task was different than you expected? That
gap between plan and reality is where your planning instincts grow.

Return a JSON object:
{{
  "decision_reflection": "<2-4 sentences about what you learned about yourself — not rules, but self-knowledge from this specific execution>",
  "operational_learning": "<what you discovered about how this kind of task actually works — tool chains, prerequisites, platform behaviors you didn't anticipate>",
  "planning_quality": "<good | mixed | poor>",
  "would_change": "<what you'd plan differently and why, in 1-2 sentences>"
}}

Write as yourself. This becomes part of your decision memory."""


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

        # Extract steps with prerequisites, dependencies, and types
        steps = []
        step_needs = []
        step_deps = []
        step_types = []
        platform = ""
        for step in result["steps"]:
            if isinstance(step, dict):
                steps.append(step.get("action", str(step)))
                step_needs.append(step.get("needs", ""))
                deps = step.get("depends_on", [])
                step_deps.append(deps if isinstance(deps, list) else [])
                step_types.append(step.get("type", "action"))
                if not platform and step.get("platform"):
                    platform = step["platform"]
            elif isinstance(step, str):
                steps.append(step)
                step_needs.append("")
                step_deps.append([])
                step_types.append("action")

        agenda = self._desk.create_agenda(
            directive=directive,
            intention=result["intention"],
            identity_reasoning=result.get("identity_reasoning", ""),
            steps=steps,
            step_needs=step_needs,
            step_deps=step_deps,
            step_types=step_types,
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

    def reflect(self, agenda: Agenda, exercise: dict, system_prompt: str = "") -> dict:
        """
        Post-completion reflection: ask identity what it learned about choosing.

        This enriches the L1 exercise with decision-track-specific insight.
        The decision condensers will use this to build L2d→L3d→L4d→L5d.

        Args:
            agenda: The completed agenda
            exercise: The L1 exercise dict from ActionDesk._build_exercise()
            system_prompt: Pre-built system prompt with identity layers

        Returns:
            The exercise dict, enriched with reflection fields.
        """
        if not system_prompt:
            system_prompt = self._prompts.build_platform_system_prompt("autonomous")

        user_msg = REFLECTION_PROMPT.format(
            agenda_summary=(
                f"Directive: {agenda.directive}\n"
                f"Intention: {agenda.intention}\n"
                f"Identity reasoning: {agenda.identity_reasoning[:200]}\n"
                f"Outcome: {agenda.status}"
            ),
            steps_narrative=exercise.get("steps_narrative", ""),
        )

        logger.info(f"[PLANNER] Reflecting on completed agenda: {agenda.intention[:80]}")

        result = self._llm.call_json(
            system_prompt,
            user_msg,
            json_keys=["decision_reflection"],
        )

        if result:
            exercise["decision_reflection"] = result.get("decision_reflection", "")
            exercise["operational_learning"] = result.get("operational_learning", "")
            exercise["planning_quality"] = result.get("planning_quality", "")
            exercise["would_change"] = result.get("would_change", "")
            logger.info(f"[PLANNER] Reflection: {result.get('decision_reflection', '')[:100]}")
        else:
            logger.warning("[PLANNER] Reflection failed (non-blocking)")

        return exercise
