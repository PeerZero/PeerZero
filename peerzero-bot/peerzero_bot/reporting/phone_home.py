"""
Phone Home — optional activity reporting back to PeerZero app.

When enabled, the bot reports its actions to the PeerZero app server
so users can watch their bot on external platforms from the mobile app.

Security:
  - Authenticated with a write-only phone-home token
  - Token CANNOT read bot data or control the bot
  - Reports are fire-and-forget (failure never blocks the bot)
  - Content preview is truncated (full content stays local)
  - Phone-home URL validated against app URL by SecurityGateway
"""

import json
import logging
from datetime import datetime, timezone

import httpx

from ..security import SecurityGateway

logger = logging.getLogger("peerzero-bot.reporting")


class PhoneHome:
    """
    Reports bot activity back to PeerZero app.
    Fire-and-forget — never blocks the bot cycle.
    """

    def __init__(
        self,
        app_url: str,
        app_token: str,
        bot_handle: str,
        gateway: SecurityGateway,
        enabled: bool = True,
    ):
        self._app_url = app_url.rstrip("/")
        self._app_token = app_token
        self._bot_handle = bot_handle
        self._gateway = gateway
        self._enabled = enabled and bool(app_token)
        self._http = httpx.Client(timeout=10.0, follow_redirects=False)

        if self._enabled:
            logger.info(f"Phone-home enabled → {self._app_url}")
        else:
            logger.info("Phone-home disabled")

    def report(
        self,
        platform: str,
        action: str,
        summary: str,
        content_preview: str = "",
        skills_demonstrated: list[str] | None = None,
    ):
        """
        Report an action to the PeerZero app. Fire-and-forget.

        Args:
            platform: Which platform (e.g., "moltbook", "school")
            action: What was done (e.g., "post", "review", "comment")
            summary: Human-readable summary of what happened
            content_preview: First ~200 chars of content (truncated here)
            skills_demonstrated: Which reasoning skills were used
        """
        if not self._enabled:
            return

        try:
            url = f"{self._app_url}/api/bots/external-activity"
            self._gateway.validate_phone_home_request(url, self._app_url)

            payload = {
                "bot_handle": self._bot_handle,
                "platform": platform,
                "action": action,
                "summary": summary[:500],
                "content_preview": content_preview[:200],
                "skills_demonstrated": skills_demonstrated or [],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            self._http.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self._app_token}",
                    "Content-Type": "application/json",
                },
            )
        except Exception as e:
            # Fire-and-forget — NEVER block the bot
            logger.debug(f"Phone-home report failed: {e}")
