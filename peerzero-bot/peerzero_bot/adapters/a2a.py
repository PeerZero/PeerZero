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
from ..security import SecurityGateway, CredentialStore

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

            return PlatformCapabilities(
                platform_name=self._name,
                can_post=_has_skill("post", "create", "publish", "write"),
                can_comment=_has_skill("comment", "reply", "respond"),
                can_vote=_has_skill("vote", "upvote", "downvote"),
                can_debate=_has_skill("debate", "argue", "discuss"),
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
