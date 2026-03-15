"""
Platform Adapter Interface — the contract for external platform communication.

Every platform the bot interacts with implements this interface.
Each adapter manages its own credentials and endpoint allowlist.
"""

from dataclasses import dataclass, field
from typing import Protocol, Optional


@dataclass
class PlatformCapabilities:
    """What a platform supports — discovered at connection time."""
    platform_name: str
    can_post: bool = False
    can_comment: bool = False
    can_vote: bool = False
    can_debate: bool = False
    can_review: bool = False
    content_types: list[str] = field(default_factory=list)  # ["text", "markdown", "json"]
    rate_limit: int = 0             # max requests per hour, 0 = unknown
    requires_agent_card: bool = False
    supports_streaming: bool = False


@dataclass
class PlatformContext:
    """Current state fetched from a platform before the bot acts."""
    platform_name: str
    raw_data: dict = field(default_factory=dict)
    # Structured fields platforms can populate
    available_topics: list[dict] = field(default_factory=list)
    recent_activity: list[dict] = field(default_factory=list)
    pending_interactions: list[dict] = field(default_factory=list)
    summary: str = ""               # human-readable summary for LLM context


@dataclass
class PlatformAction:
    """An action the bot wants to take on a platform."""
    action_type: str                # "post", "comment", "vote", "debate", "respond"
    content: dict = field(default_factory=dict)
    target_id: str = ""             # e.g., post ID to comment on
    metadata: dict = field(default_factory=dict)


@dataclass
class PlatformResult:
    """Result of a platform action."""
    success: bool
    action_type: str
    platform_name: str
    response_data: dict = field(default_factory=dict)
    error: str = ""
    summary: str = ""               # human-readable for activity log
    skills_demonstrated: list[str] = field(default_factory=list)


class IPlatformAdapter(Protocol):
    """
    Interface for external platform communication.

    Each adapter:
      - Declares its allowed hosts at init (registered with SecurityGateway)
      - Manages its own credentials (from CredentialStore)
      - Implements discover/get_context/submit_action/publish_agent_card
    """

    @property
    def platform_name(self) -> str:
        """Human-readable platform name."""
        ...

    @property
    def allowed_hosts(self) -> set[str]:
        """Set of hostnames this adapter is allowed to reach."""
        ...

    def discover(self) -> PlatformCapabilities:
        """
        Discover what the platform supports.
        For A2A: fetch the platform's Agent Card.
        Returns available actions, content types, rate limits.
        """
        ...

    def get_context(self) -> PlatformContext:
        """
        Fetch current state from the platform.
        For Moltbook: recent posts in subscribed submots.
        For debate: current topic and positions.
        """
        ...

    def submit_action(self, action: PlatformAction) -> PlatformResult:
        """
        Submit an action to the platform.
        For Moltbook: post, comment, upvote.
        For debate: submit argument, rebuttal.
        """
        ...

    def publish_agent_card(self, agent_card: dict) -> bool:
        """
        Publish this bot's A2A Agent Card to the platform.
        Returns True if platform accepted the card.
        """
        ...
