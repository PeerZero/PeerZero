"""
Conversational Memory — Associative graph memory for shipped bots.

Gives bots the ability to know a person the way a close friend would —
not through fact retrieval, but through inhabited understanding that
grows over time.

Architecture:
  - Graph-based memory (nodes/edges with weight, decay, tiers)
  - Dual-identity tracking (bot self-model + user model on same graph)
  - Felt language injection (first-person inhabited knowing)
  - Four parallel processes:
    1. Immediate graph splatter (every message)
    2. Condensation cascade (L1 -> L2 -> L3)
    3. Self-reflection (after every response)
    4. Sleep consolidation (nightly, pure math)

School identity is bedrock — read-only in conversation, never overwritten.
The memory system works at any grade level, degrading gracefully.
"""

from .config import ConversationalMemoryConfig
from .db import ConversationalMemoryDB
from .graph import Graph
from .filter import Filter
from .salience import SalienceDetector
from .condenser import Condenser
from .injector import Injector
from .sleep import SleepConsolidation
from .engine import ConversationalMemoryEngine
from .shared_awareness import SharedSelfAwareness

__all__ = [
    "ConversationalMemoryConfig",
    "ConversationalMemoryDB",
    "Graph",
    "Filter",
    "SalienceDetector",
    "Condenser",
    "Injector",
    "SleepConsolidation",
    "ConversationalMemoryEngine",
    "SharedSelfAwareness",
]
