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
    can_use_tools: bool = False     # MCP tool use
    can_task: bool = False          # A2A task delegation (send/receive structured tasks)
    can_conversation: bool = False  # multi-turn threaded exchanges
    content_types: list[str] = field(default_factory=list)  # ["text", "markdown", "json", "tool_use"]
    rate_limit: int = 0             # max requests per hour, 0 = unknown
    requires_agent_card: bool = False
    supports_streaming: bool = False
    tool_count: int = 0             # number of available MCP tools


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


# ── A2A Task Lifecycle ────────────────────────────────────────────────────────
# Structured task messages for agent-to-agent coordination.
# Follows the A2A protocol task state machine:
#   submitted → working → input-required → completed/failed/canceled

@dataclass
class TaskMessage:
    """Structured task request from one bot to another (A2A tasks/send)."""
    request_id: str                    # unique ID for correlation
    sender: str                        # sender agent card URL or bot handle
    action_requested: str              # what the sender wants done
    payload: dict = field(default_factory=dict)
    callback_url: str = ""             # where to POST the result when done
    deadline: str = ""                 # ISO 8601 deadline
    conversation_id: str = ""          # for multi-turn threading
    turn_number: int = 0               # which turn in the conversation
    metadata: dict = field(default_factory=dict)


@dataclass
class TaskResponse:
    """Structured result posted back to a task requester."""
    request_id: str                    # correlates to TaskMessage.request_id
    responder: str                     # responder bot handle or agent card URL
    status: str = "completed"          # "completed", "failed", "working", "input-required", "rejected"
    result: dict = field(default_factory=dict)
    conversation_id: str = ""          # for threading
    turn_number: int = 0
    next_action: str = "done"          # "done", "await_reply", "escalate"
    error: str = ""
    artifacts: list[dict] = field(default_factory=list)  # A2A artifacts with MIME types


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

    def send_task(self, target_url: str, task: TaskMessage) -> TaskResponse:
        """
        Send a structured task to another agent (A2A tasks/send).
        The target processes the task and returns a response.
        For async tasks, the response may have status="working" and
        the result arrives later via callback_url.
        """
        ...

    def handle_task(self, task: TaskMessage) -> TaskResponse:
        """
        Handle an incoming task from another agent.
        The adapter routes the task through the bot's LLM and returns
        a structured response.
        """
        ...

    def get_pending_tasks(self) -> list[TaskMessage]:
        """
        Fetch any pending incoming tasks from the platform.
        Returns tasks that need processing.
        """
        ...
