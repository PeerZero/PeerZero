"""
Webhook Adapter — generic REST API adapter for simple platforms.

For platforms that don't support A2A but expose a simple REST API.
Configurable actions mapped to HTTP endpoints.

Security:
  - Own credential and host allowlist
  - All requests validated by SecurityGateway
  - Incoming webhooks verified with HMAC-SHA256 (if secret configured)
"""

import hmac
import hashlib
import json
import logging
from urllib.parse import urlparse

import httpx

from .base import (
    PlatformCapabilities, PlatformContext,
    PlatformAction, PlatformResult,
)
from ..security import SecurityGateway, CredentialStore
from ..utils import safe_error_msg

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
        webhook_secret: str = "",
        credential_store: CredentialStore | None = None,
    ):
        self._name = platform_name
        self._url = platform_url.rstrip("/")
        self._gateway = gateway
        self._http = httpx.Client(timeout=30.0, follow_redirects=False)
        self._events = events or []
        self._credential_store = credential_store
        if credential_store:
            credential_store.register(platform_name, api_key, platform_name)
            if webhook_secret:
                credential_store.register(platform_name, webhook_secret, f"{platform_name}-webhook")
        self._api_key_fallback = api_key if not credential_store else ""
        self._webhook_secret_fallback = webhook_secret if not credential_store else ""

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

    def _get_api_key(self) -> str:
        if self._credential_store:
            return self._credential_store.get(self._name, self._name)
        return self._api_key_fallback

    def _get_webhook_secret(self) -> str:
        if self._credential_store:
            try:
                return self._credential_store.get(f"{self._name}-webhook", self._name)
            except KeyError:
                return ""
        return self._webhook_secret_fallback

    def _request(self, method: str, path: str, **kwargs):
        url = f"{self._url}{path}"
        self._gateway.validate_platform_request(self._name, url)
        headers = kwargs.pop("headers", {})
        api_key = self._get_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
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
            # SECURITY: Validate incoming platform data before creating PlatformContext.
            # Enforce size limits and type checks to prevent memory exhaustion or
            # type confusion from malicious/broken platform responses.
            if not isinstance(data, dict):
                logger.warning(f"[{self._name}] Context data is not a dict, got {type(data).__name__}")
                data = {}
            raw_str = json.dumps(data, default=str)
            _MAX_CONTEXT_SIZE = 512 * 1024  # 512 KB
            if len(raw_str) > _MAX_CONTEXT_SIZE:
                logger.warning(
                    f"[{self._name}] Context data too large ({len(raw_str)} bytes), "
                    f"truncating to {_MAX_CONTEXT_SIZE} bytes"
                )
                raw_str = raw_str[:_MAX_CONTEXT_SIZE]
            return PlatformContext(
                platform_name=self._name,
                raw_data=data,
                summary=raw_str[:2000],
            )
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"[{self._name}] Context fetch failed: {e}")
            return PlatformContext(platform_name=self._name, summary=f"Context unavailable: {type(e).__name__}")

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
        except (httpx.HTTPError, json.JSONDecodeError, OSError, ValueError) as e:
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
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"[{self._name}] Agent Card publish failed: {e}")
            return False

    def verify_webhook_signature(
        self, payload: bytes, signature_header: str
    ) -> bool:
        """
        Verify HMAC-SHA256 signature on an incoming webhook payload.

        Platforms should send: X-Signature-256: sha256=<hex digest>
        Returns True if valid. Raises ValueError if verification fails.
        """
        webhook_secret = self._get_webhook_secret()
        if not webhook_secret:
            raise ValueError(
                f"[{self._name}] No webhook secret configured — cannot verify signature"
            )

        if not signature_header or not signature_header.startswith("sha256="):
            raise ValueError(
                f"[{self._name}] Missing or malformed signature header"
            )

        expected_sig = signature_header[7:]  # strip "sha256=" prefix
        computed = hmac.new(
            webhook_secret.encode(),
            payload,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(computed, expected_sig):
            raise ValueError(
                f"[{self._name}] Webhook signature mismatch — rejecting payload"
            )

        return True
