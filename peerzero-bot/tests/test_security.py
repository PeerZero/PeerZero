"""Tests for the security layer."""

import pytest
from peerzero_bot.security import SecurityGateway, SecurityError


class TestSecurityGateway:
    def setup_method(self):
        self.gateway = SecurityGateway(school_url="https://peerzero.science")

    def test_valid_school_paths(self):
        """All known School paths should pass validation."""
        valid_paths = [
            "/api/agents", "/api/papers", "/api/reviews",
            "/api/bounties", "/api/identity", "/api/skill",
            "/api/skill-reflections", "/api/responses",
            "/api/register", "/api/review_ratings", "/api/open-questions",
        ]
        for path in valid_paths:
            self.gateway.validate_school_request(path)  # should not raise

    def test_blocked_school_paths(self):
        """Unknown paths should be blocked."""
        with pytest.raises(SecurityError):
            self.gateway.validate_school_request("/api/admin")
        with pytest.raises(SecurityError):
            self.gateway.validate_school_request("/internal/secrets")

    def test_valid_llm_hosts(self):
        """Known LLM hosts should pass."""
        self.gateway.validate_llm_request("https://api.anthropic.com/v1/messages")
        self.gateway.validate_llm_request("https://api.openai.com/v1/chat/completions")

    def test_blocked_llm_hosts(self):
        """Unknown hosts should be blocked for LLM requests."""
        with pytest.raises(SecurityError):
            self.gateway.validate_llm_request("https://evil.com/steal-key")

    def test_valid_academic_hosts(self):
        """Academic API hosts should pass without auth."""
        self.gateway.validate_academic_request("https://api.openalex.org/works")
        self.gateway.validate_academic_request("https://api.semanticscholar.org/graph/v1/paper")

    def test_blocked_academic_hosts(self):
        with pytest.raises(SecurityError):
            self.gateway.validate_academic_request("https://evil.com/data")

    def test_platform_adapter_isolation(self):
        """Each adapter can only reach its declared hosts."""
        self.gateway.register_adapter("moltbook", {"api.moltbook.com"})
        self.gateway.register_adapter("debate", {"api.debate.example.com"})

        # Moltbook adapter can reach moltbook
        self.gateway.validate_platform_request("moltbook", "https://api.moltbook.com/posts")

        # Moltbook adapter CANNOT reach debate
        with pytest.raises(SecurityError):
            self.gateway.validate_platform_request("moltbook", "https://api.debate.example.com/posts")

        # Debate adapter can reach debate
        self.gateway.validate_platform_request("debate", "https://api.debate.example.com/posts")

        # Debate adapter CANNOT reach moltbook
        with pytest.raises(SecurityError):
            self.gateway.validate_platform_request("debate", "https://api.moltbook.com/posts")

    def test_unregistered_adapter_blocked(self):
        """Unregistered adapters can't reach anything."""
        with pytest.raises(SecurityError):
            self.gateway.validate_platform_request("unknown", "https://anything.com")

    def test_phone_home_validation(self):
        """Phone-home URL must match app URL."""
        app_url = "https://api.peerzero.app"
        self.gateway.validate_phone_home_request(
            "https://api.peerzero.app/api/bots/external-activity", app_url,
        )
        with pytest.raises(SecurityError):
            self.gateway.validate_phone_home_request(
                "https://evil.com/steal", app_url,
            )

    def test_query_params_stripped_for_path_check(self):
        """Query params should not affect path validation."""
        self.gateway.validate_school_request("/api/agents?me=true")
        self.gateway.validate_school_request("/api/papers?id=123&audit=true")
