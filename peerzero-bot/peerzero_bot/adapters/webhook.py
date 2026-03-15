"""
Webhook Adapter — generic REST API adapter for simple platforms.

For platforms that don't support A2A but expose a simple REST API.
Configurable actions mapped to HTTP endpoints.

Security:
  - Own credential and host allowlist
  - All requests validated by SecurityGateway
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

logger = logging.getLogger("peerzero-bot.webhook")


class WebhookAdapter:
    """
    Generic webhook/REST adapter for platforms without A2A support.
    Maps action types to REST endpoints.
    """

    def __init__(
        self,
        platform_name: str,
        platform_url: str,
        api_key: str,
        gateway: SecurityGateway,
        events: list[str] | None = None,
    ):
        self._name = platform_name
        self._url = platform_url.rstrip("/")
        self._api_key = api_key
        self._gateway = gateway
        self._http = httpx.Client(timeout=30.0, follow_redirects=False)
        self._events = events or []

        # Register allowed hosts
        host = urlparse(platform_url).hostname
        if host:
            gateway.register_adapter(platform_name, {host})

    @property
    def platform_name(self) -> str:
        return self._name

    @property
    def allowed_hosts(self) -> set[str]:
        host = urlparse(self._url).hostname
        return {host} if host else set()

    def _request(self, method: str, path: str, **kwargs):
        url = f"{self._url}{path}"
        self._gateway.validate_platform_request(self._name, url)
        headers = kwargs.pop("headers", {})
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        headers["Content-Type"] = "application/json"
        response = self._http.request(method, url, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}

    def discover(self) -> PlatformCapabilities:
        """Discover capabilities by probing standard endpoints."""
        caps = PlatformCapabilities(platform_name=self._name)
        for event in self._events:
            if event == "post":
                caps.can_post = True
            elif event == "comment":
                caps.can_comment = True
            elif event == "vote":
                caps.can_vote = True
            elif event == "debate":
                caps.can_debate = True
        caps.content_types = ["application/json"]
        return caps

    def get_context(self) -> PlatformContext:
        """Fetch context from the platform's feed/status endpoint."""
        try:
            data = self._request("GET", "/feed")
            return PlatformContext(
                platform_name=self._name,
                raw_data=data,
                summary=json.dumps(data, default=str)[:2000],
            )
        except Exception as e:
            logger.warning(f"[{self._name}] Context fetch failed: {e}")
            return PlatformContext(platform_name=self._name, summary=f"Context unavailable: {e}")

    def submit_action(self, action: PlatformAction) -> PlatformResult:
        """Submit an action via REST endpoint."""
        try:
            # Map action types to REST endpoints
            endpoint_map = {
                "post": "/posts",
                "comment": f"/posts/{action.target_id}/comments" if action.target_id else "/comments",
                "vote": f"/posts/{action.target_id}/vote" if action.target_id else "/vote",
                "respond": f"/posts/{action.target_id}/respond" if action.target_id else "/respond",
            }
            endpoint = endpoint_map.get(action.action_type, f"/{action.action_type}")
            result = self._request("POST", endpoint, json=action.content)

            return PlatformResult(
                success=True,
                action_type=action.action_type,
                platform_name=self._name,
                response_data=result,
                summary=f"{action.action_type} submitted to {self._name}",
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
        """Publish Agent Card via registration endpoint."""
        try:
            self._request("POST", "/agents/register", json=agent_card)
            return True
        except Exception as e:
            logger.warning(f"[{self._name}] Agent Card publish failed: {e}")
            return False
