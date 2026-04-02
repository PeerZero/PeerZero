"""
A2A Adapter — generic Agent-to-Agent protocol adapter.

Implements the A2A protocol (https://google.github.io/A2A/) for communicating
with any A2A-compatible agent or platform.

Supports:
  1. Discovery via Agent Cards (.well-known/agent.json)
  2. Context fetch via A2A task queries
  3. Action submission as A2A tasks
  4. Agent Card publishing for discoverability
  5. Structured task delegation (tasks/send with lifecycle)
  6. Push notification callbacks (tasks/pushNotification)
  7. Multi-turn conversation threading

Task lifecycle state machine:
  submitted → working → input-required → completed/failed/canceled

Security:
  - Each A2A adapter instance has its own credential and host allowlist
  - Callback URLs are validated against the security gateway
  - Platform content is treated as untrusted external input
"""

import json
import logging
import uuid
from urllib.parse import urlparse

import httpx

from .base import (
    PlatformCapabilities, PlatformContext,
    PlatformAction, PlatformResult,
    TaskMessage, TaskResponse,
)
from ..security import SecurityGateway, CredentialStore
from ..utils import safe_error_msg

logger = logging.getLogger("peerzero-bot.a2a")


class A2AAdapter:
    """
    Generic A2A protocol adapter.
    Works with any platform that implements the A2A specification.
    """

    def __init__(
        self,
        platform_name: str,
        platform_url: str,
        agent_card_url: str,
        api_key: str,
        gateway: SecurityGateway,
        credential_store: CredentialStore | None = None,
    ):
        self._name = platform_name
        self._url = platform_url.rstrip("/")
        self._agent_card_url = agent_card_url
        self._gateway = gateway
        self._credential_store = credential_store
        if credential_store:
            credential_store.register(platform_name, api_key, platform_name)
        self._api_key_fallback = api_key if not credential_store else ""
        self._http = httpx.Client(timeout=30.0, follow_redirects=False, verify=True)
        self._remote_card: dict = {}
        # Conversation cache for multi-turn exchanges (conversation_id → turns)
        self._conversations: dict[str, list[dict]] = {}
        # Pending incoming tasks (populated by notification callbacks)
        self._task_inbox: list[TaskMessage] = []

        # Register allowed hosts with security gateway
        host = urlparse(platform_url).hostname
        card_host = urlparse(agent_card_url).hostname if agent_card_url else host
        hosts = {h for h in [host, card_host] if h}
        gateway.register_adapter(platform_name, hosts)

    @property
    def platform_name(self) -> str:
        return self._name

    @property
    def allowed_hosts(self) -> set[str]:
        host = urlparse(self._url).hostname
        return {host} if host else set()

    def _get_api_key(self) -> str:
        if self._credential_store:
            return self._credential_store.get(self._name, self._name)
        return self._api_key_fallback

    def _request(self, method: str, url: str, **kwargs):
        """Make an authenticated request, validated by security gateway."""
        self._gateway.validate_platform_request(self._name, url)
        headers = kwargs.pop("headers", {})
        api_key = self._get_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers["Content-Type"] = "application/json"
        response = self._http.request(method, url, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()

    def discover(self) -> PlatformCapabilities:
        """Fetch the platform's A2A Agent Card to discover capabilities."""
        try:
            card_url = self._agent_card_url or f"{self._url}/.well-known/agent-card.json"
            self._gateway.validate_platform_request(self._name, card_url)

            # Agent Cards are public — no auth needed for discovery
            response = self._http.get(card_url, timeout=10.0)
            response.raise_for_status()
            self._remote_card = response.json()

            skills = self._remote_card.get("skills", [])
            # Extract skill IDs/names from the A2A skills array (list of dicts or strings)
            skill_ids: set[str] = set()
            for skill in skills:
                if isinstance(skill, dict):
                    skill_ids.add(skill.get("id", "").lower())
                    skill_ids.add(skill.get("name", "").lower())
                    for tag in skill.get("tags", []):
                        skill_ids.add(str(tag).lower())
                elif isinstance(skill, str):
                    skill_ids.add(skill.lower())

            def _has_skill(*keywords: str) -> bool:
                return any(kw in sid for sid in skill_ids for kw in keywords)

            caps = self._remote_card.get("capabilities", {})
            return PlatformCapabilities(
                platform_name=self._name,
                can_post=_has_skill("post", "create", "publish", "write"),
                can_comment=_has_skill("comment", "reply", "respond"),
                can_vote=_has_skill("vote", "upvote", "downvote"),
                can_debate=_has_skill("debate", "argue", "discuss"),
                can_task=caps.get("pushNotifications", False) or _has_skill("task", "delegate", "request"),
                can_conversation=caps.get("stateTransitionHistory", False) or _has_skill("conversation", "thread", "multi-turn"),
                content_types=self._remote_card.get("defaultInputModes", ["text/plain"]),
                requires_agent_card=True,
                supports_streaming=caps.get("streaming", False),
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Discovery failed: {safe_error_msg(e)}")
            return PlatformCapabilities(platform_name=self._name)

    def get_context(self) -> PlatformContext:
        """Fetch current platform state via A2A task query."""
        try:
            # A2A context fetch: send a "browse" task
            task_data = {
                "jsonrpc": "2.0",
                "method": "tasks/send",
                "params": {
                    "id": f"ctx-{self._name}",
                    "message": {
                        "role": "user",
                        "parts": [{"type": "text", "text": "What is currently happening? Show me recent activity."}],
                    },
                },
            }
            result = self._request("POST", self._url, json=task_data)

            # SECURITY: Validate incoming platform data before creating PlatformContext.
            # Enforce size limits and type checks to prevent memory exhaustion or
            # type confusion from malicious/broken platform responses.
            if not isinstance(result, dict):
                logger.warning(f"[{self._name}] A2A response is not a dict, got {type(result).__name__}")
                result = {}
            raw_str = json.dumps(result, default=str)
            _MAX_CONTEXT_SIZE = 512 * 1024  # 512 KB
            if len(raw_str) > _MAX_CONTEXT_SIZE:
                logger.warning(
                    f"[{self._name}] A2A response too large ({len(raw_str)} bytes), "
                    f"truncating context"
                )

            # Parse A2A response
            task_result = result.get("result", {})
            if not isinstance(task_result, dict):
                task_result = {}
            artifacts = task_result.get("artifacts", [])
            if not isinstance(artifacts, list):
                artifacts = []
            context_text = ""
            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    continue
                for part in artifact.get("parts", []):
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text" and isinstance(part.get("text"), str):
                        context_text += part["text"] + "\n"
                        # Cap context text accumulation
                        if len(context_text) > 50000:
                            break
                if len(context_text) > 50000:
                    break

            return PlatformContext(
                platform_name=self._name,
                raw_data=result,
                summary=context_text[:2000] if context_text else "No context available",
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Context fetch failed: {e}")
            return PlatformContext(platform_name=self._name, summary=f"Context unavailable: {type(e).__name__}")

    def submit_action(self, action: PlatformAction) -> PlatformResult:
        """Submit an action to the platform as an A2A task."""
        try:
            # Build A2A task message
            content_text = json.dumps(action.content, default=str) if isinstance(action.content, (dict, list)) else str(action.content)

            task_data = {
                "jsonrpc": "2.0",
                "method": "tasks/send",
                "params": {
                    "id": f"action-{action.action_type}-{action.target_id or 'new'}",
                    "message": {
                        "role": "user",
                        "parts": [{"type": "text", "text": content_text}],
                    },
                    "metadata": {
                        "action_type": action.action_type,
                        "target_id": action.target_id,
                        **action.metadata,
                    },
                },
            }

            result = self._request("POST", self._url, json=task_data)

            task_result = result.get("result", {})
            status = task_result.get("status", {}).get("state", "unknown")

            return PlatformResult(
                success=status in ("completed", "working"),
                action_type=action.action_type,
                platform_name=self._name,
                response_data=result,
                summary=f"{action.action_type} on {self._name}: {status}",
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Action failed: {safe_error_msg(e)}")
            return PlatformResult(
                success=False,
                action_type=action.action_type,
                platform_name=self._name,
                error=safe_error_msg(e),
            )

    def publish_agent_card(self, agent_card: dict) -> bool:
        """Publish bot's Agent Card to the platform for discovery."""
        try:
            register_url = f"{self._url}/agents/register"
            self._request("POST", register_url, json=agent_card)
            logger.info(f"[{self._name}] Agent Card published")
            return True
        except Exception as e:
            logger.warning(f"[{self._name}] Failed to publish Agent Card: {e}")
            return False

    # ── A2A Task Lifecycle ──────────────────────────────────────────────────

    def send_task(self, target_url: str, task: TaskMessage) -> TaskResponse:
        """
        Send a structured task to another A2A agent.

        Uses the A2A tasks/send JSON-RPC method. If the target supports
        push notifications and a callback_url is provided, the response
        may be async (status="working") with the final result delivered
        to the callback URL.
        """
        try:
            # Validate the target URL through security gateway
            self._gateway.validate_platform_request(self._name, target_url)

            # Build A2A JSON-RPC request
            task_id = task.request_id or str(uuid.uuid4())
            a2a_request = {
                "jsonrpc": "2.0",
                "method": "tasks/send",
                "id": task_id,
                "params": {
                    "id": task_id,
                    "message": {
                        "role": "user",
                        "parts": [
                            {"type": "text", "text": json.dumps({
                                "action_requested": task.action_requested,
                                "payload": task.payload,
                            }, default=str)},
                        ],
                    },
                    "metadata": {
                        "request_id": task.request_id,
                        "sender": task.sender,
                        "callback_url": task.callback_url,
                        "deadline": task.deadline,
                        "conversation_id": task.conversation_id,
                        "turn_number": task.turn_number,
                        **task.metadata,
                    },
                },
            }

            # Register push notification if callback_url is provided
            if task.callback_url:
                a2a_request["params"]["pushNotification"] = {
                    "url": task.callback_url,
                }

            result = self._request("POST", target_url, json=a2a_request)

            # Parse A2A response
            task_result = result.get("result", {})
            status_obj = task_result.get("status", {})
            state = status_obj.get("state", "unknown")

            # Extract artifacts
            artifacts = []
            for artifact in task_result.get("artifacts", []):
                if isinstance(artifact, dict):
                    artifacts.append(artifact)

            # Extract text from artifacts for result
            result_text = ""
            for artifact in artifacts:
                for part in artifact.get("parts", []):
                    if isinstance(part, dict) and part.get("type") == "text":
                        result_text += part.get("text", "")

            # Track conversation
            if task.conversation_id:
                if task.conversation_id not in self._conversations:
                    self._conversations[task.conversation_id] = []
                self._conversations[task.conversation_id].append({
                    "turn": task.turn_number,
                    "role": "sender",
                    "task_id": task_id,
                    "action": task.action_requested,
                })

            # Map A2A state to TaskResponse
            response_status = {
                "completed": "completed",
                "failed": "failed",
                "canceled": "rejected",
                "working": "working",
                "input-required": "input-required",
                "submitted": "working",
            }.get(state, "failed")

            next_action = "done"
            if state == "input-required":
                next_action = "await_reply"
            elif state == "working":
                next_action = "await_reply"

            return TaskResponse(
                request_id=task_id,
                responder=self._remote_card.get("name", self._name),
                status=response_status,
                result={"text": result_text, "raw": task_result} if result_text else task_result,
                conversation_id=task.conversation_id,
                turn_number=task.turn_number,
                next_action=next_action,
                artifacts=artifacts,
            )

        except Exception as e:
            logger.warning(f"[{self._name}] send_task failed: {safe_error_msg(e)}")
            return TaskResponse(
                request_id=task.request_id,
                responder=self._name,
                status="failed",
                error=safe_error_msg(e),
            )

    def handle_task(self, task: TaskMessage) -> TaskResponse:
        """
        Handle an incoming task from another agent.

        This is called when the bot receives a task via its own endpoint.
        The actual LLM processing is done by the bot's main loop — this
        method just validates and queues the task.
        """
        # Validate the task
        if not task.request_id or not task.action_requested:
            return TaskResponse(
                request_id=task.request_id or "unknown",
                responder=self._name,
                status="rejected",
                error="Missing request_id or action_requested",
            )

        # Track conversation
        if task.conversation_id:
            if task.conversation_id not in self._conversations:
                self._conversations[task.conversation_id] = []
            self._conversations[task.conversation_id].append({
                "turn": task.turn_number,
                "role": "receiver",
                "task_id": task.request_id,
                "action": task.action_requested,
            })

        # Add to inbox for processing by the bot's main loop
        self._task_inbox.append(task)

        # Return "working" — the actual result comes via callback
        return TaskResponse(
            request_id=task.request_id,
            responder=self._name,
            status="working",
            conversation_id=task.conversation_id,
            turn_number=task.turn_number,
            next_action="await_reply",
        )

    def post_task_response(self, callback_url: str, response: TaskResponse) -> bool:
        """Post a task result back to the requester's callback URL."""
        try:
            self._gateway.validate_platform_request(self._name, callback_url)

            # Build A2A push notification
            notification = {
                "jsonrpc": "2.0",
                "method": "tasks/pushNotification/update",
                "params": {
                    "id": response.request_id,
                    "status": {
                        "state": response.status,
                        "message": {
                            "role": "agent",
                            "parts": [{"type": "text", "text": json.dumps(response.result, default=str)}],
                        },
                    },
                    "metadata": {
                        "responder": response.responder,
                        "conversation_id": response.conversation_id,
                        "turn_number": response.turn_number,
                        "next_action": response.next_action,
                    },
                },
            }

            if response.artifacts:
                notification["params"]["artifacts"] = response.artifacts

            self._request("POST", callback_url, json=notification)
            logger.info(f"[{self._name}] Task response posted to {callback_url}")
            return True
        except Exception as e:
            logger.warning(f"[{self._name}] Failed to post task response: {safe_error_msg(e)}")
            return False

    def get_pending_tasks(self) -> list[TaskMessage]:
        """Return and clear the pending task inbox."""
        tasks = list(self._task_inbox)
        self._task_inbox.clear()
        return tasks

    def get_conversation_history(self, conversation_id: str) -> list[dict]:
        """Get the turn history for a conversation thread."""
        return self._conversations.get(conversation_id, [])

    def cleanup_conversations(self, max_conversations: int = 100) -> None:
        """Prune old conversations to prevent memory growth."""
        if len(self._conversations) > max_conversations:
            # Keep most recent conversations
            sorted_ids = sorted(
                self._conversations.keys(),
                key=lambda cid: max(
                    (t.get("turn", 0) for t in self._conversations[cid]),
                    default=0,
                ),
                reverse=True,
            )
            keep = set(sorted_ids[:max_conversations])
            self._conversations = {
                k: v for k, v in self._conversations.items() if k in keep
            }
