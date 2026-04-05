"""Tests for reporting/phone_home.py — activity reporting with mocked HTTP."""

from unittest.mock import patch, MagicMock, PropertyMock
from datetime import datetime, timezone

import pytest

from peerzero_bot.reporting.phone_home import PhoneHome
from peerzero_bot.security import SecurityGateway


class TestPhoneHomeInit:
    def test_enabled_when_token_present(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app",
            app_token="test-token",
            bot_handle="test-bot",
            gateway=gateway,
            enabled=True,
        )
        assert ph._enabled is True

    def test_disabled_when_no_token(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app",
            app_token="",
            bot_handle="test-bot",
            gateway=gateway,
            enabled=True,
        )
        assert ph._enabled is False

    def test_disabled_when_flag_false(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app",
            app_token="test-token",
            bot_handle="test-bot",
            gateway=gateway,
            enabled=False,
        )
        assert ph._enabled is False

    def test_url_trailing_slash_stripped(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app/",
            app_token="test-token",
            bot_handle="test-bot",
            gateway=gateway,
        )
        assert ph._app_url == "https://api.peerzero.app"


class TestPhoneHomeReport:
    def _make_phone_home(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app",
            app_token="test-token",
            bot_handle="test-bot",
            gateway=gateway,
            enabled=True,
        )
        ph._http = MagicMock()
        return ph, gateway

    def test_report_sends_correct_payload(self):
        ph, gateway = self._make_phone_home()
        ph.report(
            platform="moltbook",
            action="post",
            summary="Posted an analysis of recent paper.",
            content_preview="The paper discusses quantum entanglement...",
            skills_demonstrated=["synthesis", "calibration"],
        )

        ph._http.post.assert_called_once()
        call_args = ph._http.post.call_args
        url = call_args[0][0]
        payload = call_args[1]["json"]
        headers = call_args[1]["headers"]

        assert url == "https://api.peerzero.app/api/bots/external-activity"
        assert payload["bot_handle"] == "test-bot"
        assert payload["platform"] == "moltbook"
        assert payload["action"] == "post"
        assert payload["summary"] == "Posted an analysis of recent paper."
        assert payload["skills_demonstrated"] == ["synthesis", "calibration"]
        assert "timestamp" in payload
        assert headers["Authorization"] == "Bearer test-token"

    def test_report_truncates_summary(self):
        ph, _ = self._make_phone_home()
        long_summary = "x" * 1000
        ph.report(
            platform="test",
            action="test",
            summary=long_summary,
        )

        payload = ph._http.post.call_args[1]["json"]
        assert len(payload["summary"]) <= 500

    def test_report_truncates_content_preview(self):
        ph, _ = self._make_phone_home()
        long_preview = "y" * 500
        ph.report(
            platform="test",
            action="test",
            summary="test",
            content_preview=long_preview,
        )

        payload = ph._http.post.call_args[1]["json"]
        assert len(payload["content_preview"]) <= 200

    def test_report_default_skills_empty_list(self):
        ph, _ = self._make_phone_home()
        ph.report(platform="test", action="test", summary="test")

        payload = ph._http.post.call_args[1]["json"]
        assert payload["skills_demonstrated"] == []

    def test_report_validates_url_via_gateway(self):
        ph, gateway = self._make_phone_home()
        ph.report(platform="test", action="test", summary="test")

        gateway.validate_phone_home_request.assert_called_once_with(
            "https://api.peerzero.app/api/bots/external-activity",
            "https://api.peerzero.app",
        )

    def test_report_disabled_does_nothing(self):
        gateway = MagicMock(spec=SecurityGateway)
        ph = PhoneHome(
            app_url="https://api.peerzero.app",
            app_token="",  # disabled
            bot_handle="test-bot",
            gateway=gateway,
        )
        ph._http = MagicMock()

        ph.report(platform="test", action="test", summary="test")
        ph._http.post.assert_not_called()

    def test_report_gateway_rejection_swallowed(self):
        """Gateway validation failure should not raise — fire and forget."""
        ph, gateway = self._make_phone_home()
        gateway.validate_phone_home_request.side_effect = Exception(
            "URL does not match app URL"
        )

        # Should NOT raise
        ph.report(platform="test", action="test", summary="test")
        ph._http.post.assert_not_called()

    def test_report_http_error_swallowed(self):
        """HTTP errors should not raise — fire and forget."""
        ph, _ = self._make_phone_home()
        ph._http.post.side_effect = Exception("Connection refused")

        # Should NOT raise
        ph.report(platform="test", action="test", summary="test")

    def test_report_includes_timestamp(self):
        ph, _ = self._make_phone_home()
        ph.report(platform="test", action="test", summary="test")

        payload = ph._http.post.call_args[1]["json"]
        ts = payload["timestamp"]
        # Should be parseable ISO 8601
        parsed = datetime.fromisoformat(ts)
        assert parsed.tzinfo is not None
