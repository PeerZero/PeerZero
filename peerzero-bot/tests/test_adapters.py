"""Tests for adapter interfaces and security integration."""

import pytest
from peerzero_bot.security import SecurityGateway, SecurityError
from peerzero_bot.adapters.base import PlatformCapabilities, PlatformAction


class TestAdapterSecurityIntegration:
    """Verify that adapters respect the SecurityGateway."""

    def test_a2a_adapter_registers_hosts(self):
        """A2A adapter should register its hosts with the gateway."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.a2a import A2AAdapter
        adapter = A2AAdapter(
            platform_name="test_platform",
            platform_url="https://api.testplatform.com",
            agent_card_url="https://api.testplatform.com/.well-known/agent-card.json",
            api_key="test-key",
            gateway=gateway,
        )
        # Should be able to reach its own host
        gateway.validate_platform_request("test_platform", "https://api.testplatform.com/posts")

        # Should NOT be able to reach other hosts
        with pytest.raises(SecurityError):
            gateway.validate_platform_request("test_platform", "https://evil.com/steal")

    def test_webhook_adapter_registers_hosts(self):
        """Webhook adapter should register its hosts with the gateway."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            platform_name="test_webhook",
            platform_url="https://api.webhooksite.com",
            api_key="test-key",
            gateway=gateway,
            events=["post", "comment"],
        )
        gateway.validate_platform_request("test_webhook", "https://api.webhooksite.com/posts")
        with pytest.raises(SecurityError):
            gateway.validate_platform_request("test_webhook", "https://other.com")

    def test_cross_adapter_isolation(self):
        """Adapters cannot reach each other's hosts."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.a2a import A2AAdapter
        from peerzero_bot.adapters.webhook import WebhookAdapter

        a2a = A2AAdapter("platform_a", "https://a.com", "", "key-a", gateway)
        webhook = WebhookAdapter("platform_b", "https://b.com", "key-b", gateway)

        # A can reach A, B can reach B
        gateway.validate_platform_request("platform_a", "https://a.com/test")
        gateway.validate_platform_request("platform_b", "https://b.com/test")

        # A cannot reach B
        with pytest.raises(SecurityError):
            gateway.validate_platform_request("platform_a", "https://b.com/test")

        # B cannot reach A
        with pytest.raises(SecurityError):
            gateway.validate_platform_request("platform_b", "https://a.com/test")


class TestWebhookHMAC:
    """Tests for HMAC-SHA256 webhook signature verification."""

    def test_valid_signature_accepted(self):
        """Correctly signed payload should pass verification."""
        import hmac as hmac_mod
        import hashlib

        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            "test", "https://test.com", "key", gateway,
            events=["post"], webhook_secret="my-secret-key",
        )

        payload = b'{"event": "new_post", "data": "hello"}'
        sig = hmac_mod.new(b"my-secret-key", payload, hashlib.sha256).hexdigest()

        assert adapter.verify_webhook_signature(payload, f"sha256={sig}") is True

    def test_invalid_signature_rejected(self):
        """Tampered payload should raise ValueError."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            "test", "https://test.com", "key", gateway,
            events=["post"], webhook_secret="my-secret-key",
        )

        payload = b'{"event": "new_post"}'
        with pytest.raises(ValueError, match="mismatch"):
            adapter.verify_webhook_signature(payload, "sha256=deadbeef")

    def test_missing_secret_raises(self):
        """No webhook secret configured should raise ValueError."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            "test", "https://test.com", "key", gateway,
            events=["post"],
        )
        with pytest.raises(ValueError, match="No webhook secret"):
            adapter.verify_webhook_signature(b"payload", "sha256=abc")

    def test_malformed_header_rejected(self):
        """Missing sha256= prefix should raise ValueError."""
        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            "test", "https://test.com", "key", gateway,
            events=["post"], webhook_secret="secret",
        )
        with pytest.raises(ValueError, match="malformed"):
            adapter.verify_webhook_signature(b"payload", "bad-header")
        with pytest.raises(ValueError, match="malformed"):
            adapter.verify_webhook_signature(b"payload", "")


class TestPlatformCapabilities:
    def test_default_capabilities(self):
        caps = PlatformCapabilities(platform_name="test")
        assert not caps.can_post
        assert not caps.can_comment
        assert not caps.can_vote
        assert caps.content_types == []

    def test_webhook_discovers_from_events(self):
        gateway = SecurityGateway()
        from peerzero_bot.adapters.webhook import WebhookAdapter
        adapter = WebhookAdapter(
            "test", "https://test.com", "key", gateway,
            events=["post", "comment", "vote"],
        )
        caps = adapter.discover()
        assert caps.can_post
        assert caps.can_comment
        assert caps.can_vote
        assert not caps.can_debate
