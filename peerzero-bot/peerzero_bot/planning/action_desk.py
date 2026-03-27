"""
Action Desk — the bot's self-managed task queue.

The bot generates tasks through its identity layers and decision logic,
then executes them step by step. Tasks persist across sessions so the
bot can pick up where it left off.

This is NOT a memory layer. Completed tasks feed into L1 exercises
(which eventually condense into identity), but the task list itself
is purely operational.

Flow:
  1. User directive arrives (via app chat, scheduled trigger, etc.)
  2. Bot makes a planning LLM call through its full identity stack
  3. LLM returns an Agenda (intention + steps)
  4. Bot works through steps, updating status as it goes
  5. Bot can add new steps mid-execution (e.g. "check back on this post")
  6. Completed agenda → L1 exercise for identity condensation
  7. Task list is cleared; identity keeps the lessons
"""

import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("peerzero-bot.planning")


# ═════════════════════════════════════════════════════════════════════════════
# DATA STRUCTURES
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class Task:
    """A single step in an agenda."""

    action: str                          # What to do (human-readable)
    status: str = "pending"              # pending | in_progress | done | failed | skipped
    result: str = ""                     # Outcome summary (filled after execution)
    added_at: str = ""                   # ISO timestamp
    completed_at: str = ""               # ISO timestamp (filled when done/failed/skipped)
    platform: str = ""                   # Target platform (if applicable)
    metadata: dict = field(default_factory=dict)  # Flexible extra data

    def __post_init__(self):
        if not self.added_at:
            self.added_at = datetime.now(timezone.utc).isoformat()

    def mark_in_progress(self):
        self.status = "in_progress"

    def mark_done(self, result: str = ""):
        self.status = "done"
        self.result = result
        self.completed_at = datetime.now(timezone.utc).isoformat()

    def mark_failed(self, reason: str = ""):
        self.status = "failed"
        self.result = reason
        self.completed_at = datetime.now(timezone.utc).isoformat()

    def mark_skipped(self, reason: str = ""):
        self.status = "skipped"
        self.result = reason
        self.completed_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Task":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class Agenda:
    """
    A set of tasks generated from a single directive.

    The bot creates agendas by running directives through its identity
    and decision logic. Each agenda has an intention (what the bot wants
    to accomplish) and a list of concrete steps.
    """

    directive: str                       # What triggered this (user message, schedule, etc.)
    intention: str                       # Bot's self-generated purpose (from identity)
    identity_reasoning: str = ""         # Why identity chose this approach
    tasks: list[Task] = field(default_factory=list)
    status: str = "active"               # active | completed | abandoned
    created_at: str = ""
    completed_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat()

    @property
    def current_task(self) -> Optional[Task]:
        """Get the next pending or in-progress task."""
        for task in self.tasks:
            if task.status == "in_progress":
                return task
        for task in self.tasks:
            if task.status == "pending":
                return task
        return None

    @property
    def is_complete(self) -> bool:
        """True when all tasks are done/failed/skipped."""
        return all(t.status in ("done", "failed", "skipped") for t in self.tasks)

    @property
    def progress_summary(self) -> str:
        """Human-readable progress string."""
        total = len(self.tasks)
        done = sum(1 for t in self.tasks if t.status == "done")
        failed = sum(1 for t in self.tasks if t.status == "failed")
        skipped = sum(1 for t in self.tasks if t.status == "skipped")
        pending = sum(1 for t in self.tasks if t.status in ("pending", "in_progress"))
        parts = []
        if done:
            parts.append(f"{done}/{total} done")
        if failed:
            parts.append(f"{failed} failed")
        if skipped:
            parts.append(f"{skipped} skipped")
        if pending:
            parts.append(f"{pending} remaining")
        return ", ".join(parts) if parts else "empty"

    def add_task(self, action: str, platform: str = "", metadata: dict | None = None) -> Task:
        """Add a new task mid-execution (bot adding follow-up work)."""
        task = Task(action=action, platform=platform, metadata=metadata or {})
        self.tasks.append(task)
        logger.info(f"[DESK] Added follow-up task: {action}")
        return task

    def mark_completed(self):
        self.status = "completed"
        self.completed_at = datetime.now(timezone.utc).isoformat()

    def mark_abandoned(self, reason: str = ""):
        self.status = "abandoned"
        self.completed_at = datetime.now(timezone.utc).isoformat()
        # Mark remaining pending tasks as skipped
        for task in self.tasks:
            if task.status in ("pending", "in_progress"):
                task.mark_skipped(reason or "agenda abandoned")

    def to_dict(self) -> dict:
        return {
            "directive": self.directive,
            "intention": self.intention,
            "identity_reasoning": self.identity_reasoning,
            "tasks": [t.to_dict() for t in self.tasks],
            "status": self.status,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Agenda":
        tasks = [Task.from_dict(t) for t in data.get("tasks", [])]
        return cls(
            directive=data.get("directive", ""),
            intention=data.get("intention", ""),
            identity_reasoning=data.get("identity_reasoning", ""),
            tasks=tasks,
            status=data.get("status", "active"),
            created_at=data.get("created_at", ""),
            completed_at=data.get("completed_at", ""),
        )

    def to_prompt_context(self) -> str:
        """Format agenda as context for the LLM during step execution."""
        lines = [
            f"CURRENT AGENDA: {self.intention}",
            f"Directive: {self.directive}",
            f"Progress: {self.progress_summary}",
            "",
            "Steps:",
        ]
        for i, task in enumerate(self.tasks, 1):
            status_icon = {
                "pending": "[ ]",
                "in_progress": "[>]",
                "done": "[x]",
                "failed": "[!]",
                "skipped": "[-]",
            }.get(task.status, "[ ]")
            line = f"  {status_icon} {i}. {task.action}"
            if task.result:
                line += f" — {task.result[:100]}"
            lines.append(line)
        return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# ACTION DESK
# ═════════════════════════════════════════════════════════════════════════════

# Storage limits
MAX_COMPLETED_AGENDAS = 20   # Keep last N completed agendas for L1 exercise generation
MAX_ACTIVE_AGENDAS = 3       # Bot shouldn't juggle too many things at once


class ActionDesk:
    """
    The bot's self-managed task queue.

    Persists to SQLite via the same storage backend as memory layers.
    The bot reads it at session start, works through tasks, and writes
    new tasks as it goes. Completed agendas are converted to L1
    exercises for identity condensation, then archived.

    Usage:
        desk = ActionDesk(storage)
        desk.load()

        # Bot creates an agenda from a directive
        agenda = desk.create_agenda(
            directive="Go fact-check on Reddit",
            intention="Find and correct bad science claims",
            identity_reasoning="My training in evidence evaluation...",
            steps=["Browse r/science", "Find 3 bad claims", "Write corrections"],
        )

        # Bot works through steps
        task = agenda.current_task
        task.mark_in_progress()
        desk.save()
        # ... execute task ...
        task.mark_done("Found 5 trending posts")
        desk.save()

        # Bot adds follow-up work
        agenda.add_task("Check back on vaccine post for replies", platform="reddit")
        desk.save()

        # When agenda is done, convert to L1 exercise
        exercise = desk.complete_agenda(agenda)
    """

    NAMESPACE = "action_desk"

    def __init__(self, storage):
        """
        Args:
            storage: SqliteStorage or FileStorage instance (same as memory manager uses).
        """
        self._storage = storage
        self._active_agendas: list[Agenda] = []
        self._completed_agendas: list[dict] = []  # Summaries only

    # ── Persistence ───────────────────────────────────────────────────────

    def load(self):
        """Load active agendas and completed history from storage."""
        raw_active = self._storage.read(self.NAMESPACE, "active_agendas", [])
        self._active_agendas = [Agenda.from_dict(a) for a in raw_active]
        self._completed_agendas = self._storage.read(
            self.NAMESPACE, "completed_agendas", [],
        )
        active_count = len(self._active_agendas)
        if active_count:
            logger.info(f"[DESK] Loaded {active_count} active agenda(s)")
            for agenda in self._active_agendas:
                logger.info(f"[DESK]   - {agenda.intention} ({agenda.progress_summary})")

    def save(self):
        """Persist current state to storage."""
        self._storage.write(
            self.NAMESPACE, "active_agendas",
            [a.to_dict() for a in self._active_agendas],
        )
        self._storage.write(
            self.NAMESPACE, "completed_agendas",
            self._completed_agendas[-MAX_COMPLETED_AGENDAS:],
        )

    # ── Agenda management ─────────────────────────────────────────────────

    @property
    def active_agendas(self) -> list[Agenda]:
        return list(self._active_agendas)

    @property
    def has_work(self) -> bool:
        """True if there's any active agenda with pending tasks."""
        return any(a.current_task is not None for a in self._active_agendas)

    def create_agenda(
        self,
        directive: str,
        intention: str,
        identity_reasoning: str = "",
        steps: list[str] | None = None,
        platform: str = "",
    ) -> Agenda:
        """
        Create a new agenda from a directive.

        Args:
            directive: What triggered this (user message, etc.)
            intention: Bot's self-generated purpose
            identity_reasoning: Why identity chose this approach
            steps: List of action descriptions
            platform: Default platform for all steps

        Returns:
            The new Agenda, already added to active list.
        """
        if len(self._active_agendas) >= MAX_ACTIVE_AGENDAS:
            # Abandon oldest active agenda to make room
            oldest = self._active_agendas[0]
            logger.warning(
                f"[DESK] Too many active agendas ({MAX_ACTIVE_AGENDAS}). "
                f"Abandoning oldest: {oldest.intention}"
            )
            self._finalize_agenda(oldest, abandoned=True)

        tasks = [Task(action=s, platform=platform) for s in (steps or [])]
        agenda = Agenda(
            directive=directive,
            intention=intention,
            identity_reasoning=identity_reasoning,
            tasks=tasks,
        )
        self._active_agendas.append(agenda)
        self.save()

        logger.info(f"[DESK] New agenda: {intention} ({len(tasks)} steps)")
        return agenda

    def complete_agenda(self, agenda: Agenda) -> dict:
        """
        Mark an agenda as completed and generate an L1 exercise summary.

        Returns:
            An L1 exercise dict ready for memory.store_platform_exercise().
        """
        return self._finalize_agenda(agenda, abandoned=False)

    def abandon_agenda(self, agenda: Agenda, reason: str = "") -> dict:
        """Abandon an agenda and generate an L1 exercise from partial work."""
        return self._finalize_agenda(agenda, abandoned=True, reason=reason)

    def _finalize_agenda(
        self, agenda: Agenda, abandoned: bool = False, reason: str = ""
    ) -> dict:
        """Finalize an agenda (complete or abandon) and return L1 exercise."""
        if abandoned:
            agenda.mark_abandoned(reason)
        else:
            agenda.mark_completed()

        # Build L1 exercise from completed work
        exercise = self._build_exercise(agenda)

        # Archive summary
        summary = {
            "directive": agenda.directive,
            "intention": agenda.intention,
            "status": agenda.status,
            "total_tasks": len(agenda.tasks),
            "done": sum(1 for t in agenda.tasks if t.status == "done"),
            "failed": sum(1 for t in agenda.tasks if t.status == "failed"),
            "created_at": agenda.created_at,
            "completed_at": agenda.completed_at,
        }
        self._completed_agendas.append(summary)

        # Remove from active
        self._active_agendas = [a for a in self._active_agendas if a is not agenda]
        self.save()

        logger.info(
            f"[DESK] Agenda {'abandoned' if abandoned else 'completed'}: "
            f"{agenda.intention} ({summary['done']}/{summary['total_tasks']} done)"
        )
        return exercise

    def _build_exercise(self, agenda: Agenda) -> dict:
        """
        Convert a completed agenda into an L1 exercise for identity condensation.

        The exercise is structured to feed BOTH learning and decision condensers:
        - Learning track sees: what happened, what worked, what was learned
        - Decision track sees: what was chosen, why, what consequences followed,
          how identity shaped the plan, what the bot would choose differently

        When routed through school L1 (school mode), this reaches L4d/L5d.
        When routed through platform L1 (shipped mode), this caps at L3.
        """
        # Build a narrative of what happened
        step_summaries = []
        successes = []
        failures = []
        for i, task in enumerate(agenda.tasks, 1):
            status_label = task.status.upper()
            line = f"Step {i} [{status_label}]: {task.action}"
            if task.result:
                line += f" — {task.result[:200]}"
            step_summaries.append(line)
            if task.status == "done":
                successes.append(task.action)
            elif task.status in ("failed", "skipped"):
                failures.append(f"{task.action}: {task.result[:100]}")

        # Decision-track-friendly framing: what was chosen and what happened
        decision_narrative = (
            f"Directive: {agenda.directive}\n"
            f"I chose this intention: {agenda.intention}\n"
            f"My identity reasoning: {agenda.identity_reasoning[:300]}\n"
        )
        if successes:
            decision_narrative += f"Steps that worked: {'; '.join(s[:80] for s in successes[:5])}\n"
        if failures:
            decision_narrative += f"Steps that failed: {'; '.join(f[:80] for f in failures[:5])}\n"
        decision_narrative += f"Outcome: {agenda.status}"

        return {
            "interaction_type": "autonomous_agenda",
            "skill": "directive_planning",
            "hit": agenda.status == "completed" and len(failures) == 0,
            "directive": agenda.directive,
            "intention": agenda.intention,
            "identity_reasoning": agenda.identity_reasoning[:300],
            "decision_narrative": decision_narrative,
            "steps_narrative": "\n".join(step_summaries),
            "outcome": agenda.status,
            "tasks_done": sum(1 for t in agenda.tasks if t.status == "done"),
            "tasks_failed": sum(1 for t in agenda.tasks if t.status == "failed"),
            "tasks_total": len(agenda.tasks),
        }

    # ── Context for LLM ──────────────────────────────────────────────────

    def get_prompt_context(self) -> str:
        """
        Build Action Desk context for injection into LLM prompts.

        Returns a formatted string showing active agendas and their progress,
        or empty string if no active work.
        """
        if not self._active_agendas:
            return ""

        parts = ["ACTION DESK — Your current tasks:"]
        for agenda in self._active_agendas:
            parts.append(agenda.to_prompt_context())
        return "\n\n".join(parts)

    def get_recent_completions(self, limit: int = 5) -> list[dict]:
        """Get recent completed agenda summaries (for reflection/planning context)."""
        return self._completed_agendas[-limit:]
