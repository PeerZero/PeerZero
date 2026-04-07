"""
Conversational Memory Configuration — all tunable parameters.

Weight = Time: every weight decision maps to survival duration.
"""

from dataclasses import dataclass, field


@dataclass
class WeightConfig:
    """How much weight a mention earns on first splatter."""
    passing_mention: float = 0.10       # ~3 days survival
    moderate_mention: float = 0.25      # ~1 week
    significant_mention: float = 0.50   # ~2 weeks
    emotional_mention: float = 1.00     # ~1 month
    explicit_importance: float = 2.00   # ~2 months
    # Salience spikes — bypass normal flow
    salience_minor: float = 5.00        # ~6 months
    salience_major: float = 12.00       # ~3 years
    salience_defining: float = 36.00    # ~10 years


@dataclass
class TierConfig:
    """Tier threshold and decay rate."""
    min_weight: float
    max_weight: float
    decay: float


@dataclass
class RippleConfig:
    """Weight propagation through parent edges."""
    parent_percentage: float = 0.20
    grandparent_percentage: float = 0.10
    cross_identity_bonus: float = 1.5   # 50% bonus crossing self<->user boundary


@dataclass
class IdentityConfig:
    """The 'interested student' multiplier — identity-anchored memory sticks harder."""
    self_relevance_multiplier: float = 1.5
    user_relevance_multiplier: float = 1.5
    relational_multiplier: float = 2.0
    min_self_observations_for_l3: int = 3


@dataclass
class CondensationConfig:
    """Triggers for the L1->L2->L3 cascade."""
    character_threshold: int = 5000
    daily_hours: int = 24
    min_interactions_for_daily: int = 1
    min_l2_for_l3: int = 3


@dataclass
class InjectionConfig:
    """Context budget for the injection stack."""
    max_active_nodes: int = 50
    min_node_weight: float = 0.05
    max_l2_observations: int = 20
    max_short_term_messages: int = 50
    max_l1_uncondensed: int = 10


@dataclass
class SleepConfig:
    """Nightly consolidation parameters."""
    cron_schedule: str = "0 3 * * *"
    redundancy_pruning: bool = True
    merge_detection: bool = True


@dataclass
class WildConversationConfig:
    """Settings for conversations with non-owner users (bot in the wild).

    Wild conversations use accelerated decay — the bot learns about ITSELF
    from these interactions but doesn't build deep relational memory of
    strangers. Self-observations are still extracted and persist in the
    shared self-awareness layer.
    """
    decay_multiplier: float = 3.0       # 3x faster decay than owner conversations
    max_nodes: int = 25                 # smaller graph budget
    condensation_threshold: int = 8000  # higher bar before condensing (fewer turns)
    disable_l3_portrait: bool = False   # still build portraits (valuable for self-reflection)
    prune_after_days: int = 30          # prune entire wild conversation DB after N days inactive


@dataclass
class CoOccurrenceConfig:
    """Co-occurrence edge creation parameters."""
    initial_weight: float = 0.05


@dataclass
class ModelConfig:
    """Model routing — Opus for identity, Haiku for speed."""
    filter: str = "claude-haiku-4-5-20251001"
    salience: str = "claude-haiku-4-5-20251001"
    condenser_l2: str = "claude-sonnet-4-6"
    condenser_l3: str = "claude-opus-4-6"
    self_reflection: str = "claude-opus-4-6"


@dataclass
class ConversationalMemoryConfig:
    """All tunable parameters for the conversational memory system."""

    weights: WeightConfig = field(default_factory=WeightConfig)

    tiers: dict = field(default_factory=lambda: {
        "ephemeral": TierConfig(min_weight=0.00, max_weight=0.50, decay=0.10),
        "pattern": TierConfig(min_weight=0.51, max_weight=2.00, decay=0.05),
        "significant": TierConfig(min_weight=2.01, max_weight=8.00, decay=0.02),
        "permanent": TierConfig(min_weight=8.01, max_weight=float("inf"), decay=0.01),
    })

    ripple: RippleConfig = field(default_factory=RippleConfig)
    identity: IdentityConfig = field(default_factory=IdentityConfig)
    condensation: CondensationConfig = field(default_factory=CondensationConfig)
    injection: InjectionConfig = field(default_factory=InjectionConfig)
    sleep: SleepConfig = field(default_factory=SleepConfig)
    co_occurrence: CoOccurrenceConfig = field(default_factory=CoOccurrenceConfig)
    models: ModelConfig = field(default_factory=ModelConfig)
    wild: WildConversationConfig = field(default_factory=WildConversationConfig)

    # Database
    db_encryption: bool = True

    # Sleep consolidation interval (seconds) — how often to run in the main loop
    sleep_interval_seconds: int = 86400  # 24 hours

    def tier_for_weight(self, weight: float) -> str:
        if weight >= self.tiers["permanent"].min_weight:
            return "permanent"
        if weight >= self.tiers["significant"].min_weight:
            return "significant"
        if weight >= self.tiers["pattern"].min_weight:
            return "pattern"
        return "ephemeral"

    def decay_for_tier(self, tier: str) -> float:
        return self.tiers.get(tier, self.tiers["ephemeral"]).decay

    def weight_for_level(self, level: str) -> float:
        """Map string weight level to numeric value."""
        mapping = {
            "passing": self.weights.passing_mention,
            "moderate": self.weights.moderate_mention,
            "significant": self.weights.significant_mention,
            "emotional": self.weights.emotional_mention,
            "important": self.weights.explicit_importance,
        }
        return mapping.get(level, self.weights.passing_mention)

    def identity_multiplier(self, relevance: str) -> float:
        if relevance == "self":
            return self.identity.self_relevance_multiplier
        if relevance == "user":
            return self.identity.user_relevance_multiplier
        if relevance == "relational":
            return self.identity.relational_multiplier
        return 1.0
