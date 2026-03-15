"""
A2A Adapter — generic Agent-to-Agent protocol adapter.

Implements the A2A protocol (https://a2a-protocol.org) for communicating
with any A2A-compatible platform.

Flow:
  1. Discover platform capabilities via Agent Card (.well-known/agent-card.json)
  2. Fetch context (platform-specific, via A2A tasks)
  3. Submit actions as A2A tasks
  4. Publish bot's own Agent Card to platform

Security:
  - Each A2A adapter instance has its own credential and host allowlist
  - Platform content is treated as untrusted external input
"""

import json
import logging
from urllib.parse import urlparse

import httpx

from .base import (
    PlatformCapabilities, PlatformContext,
    PlatformAction, PlatformResult,
)
from ..security import SecurityGateway

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
    ):
        self._name = platform_name
        self._url = platform_url.rstrip("/")
        self._agent_card_url = agent_card_url
        self._api_key = api_key
        self._gateway = gateway
        self._http = httpx.Client(timeout=30.0, follow_redirects=False)
        self._remote_card: dict = {}

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

    def _request(self, method: str, url: str, **kwargs):
        """Make an authenticated request, validated by security gateway."""
        self._gateway.validate_platform_request(self._name, url)
        headers = kwargs.pop("headers", {})
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
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
            return PlatformCapabilities(
                platform_name=self._name,
                can_post="post" in str(skills).lower() or "create" in str(skills).lower(),
                can_comment="comment" in str(skills).lower() or "reply" in str(skills).lower(),
                can_vote="vote" in str(skills).lower(),
                can_debate="debate" in str(skills).lower() or "argue" in str(skills).lower(),
                content_types=self._remote_card.get("defaultInputModes", ["text/plain"]),
                requires_agent_card=True,
                supports_streaming=self._remote_card.get("capabilities", {}).get("streaming", False),
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Discovery failed: {e}")
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

            # Parse A2A response
            task_result = result.get("result", {})
            artifacts = task_result.get("artifacts", [])
            context_text = ""
            for artifact in artifacts:
                for part in artifact.get("parts", []):
                    if part.get("type") == "text":
                        context_text += part["text"] + "\n"

            return PlatformContext(
                platform_name=self._name,
                raw_data=result,
                summary=context_text[:2000] if context_text else "No context available",
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Context fetch failed: {e}")
            return PlatformContext(platform_name=self._name, summary=f"Context unavailable: {e}")

    def submit_action(self, action: PlatformAction) -> PlatformResult:
        """Submit an action to the platform as an A2A task."""
        try:
            # Build A2A task message
            content_text = json.dumps(action.content) if isinstance(action.content, dict) else str(action.content)

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
            logger.warning(f"[{self._name}] Action failed: {e}")
            return PlatformResult(
                success=False,
                action_type=action.action_type,
                platform_name=self._name,
                error=str(e),
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
