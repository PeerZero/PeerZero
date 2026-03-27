"""
Planning — the bot's Action Desk for autonomous task management.

The Action Desk is NOT an identity layer. It does not condense, does not
flow into L2/L3/L4/L5, and does not shape who the bot is. It is a
persistent task queue that the bot writes for itself and reads back
each session.

Identity tells the bot WHO it is.
Decision track tells it HOW it chooses.
The Action Desk tells it WHAT it's doing right now.

Completed tasks become L1 exercises that feed into identity condensation.
The task list itself is operational — a to-do list, not memory.
"""

from .action_desk import ActionDesk, Task, Agenda

__all__ = ["ActionDesk", "Task", "Agenda"]
