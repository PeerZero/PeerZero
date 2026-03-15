"""Tests for the security layer."""

import json
import pytest
from peerzero_bot.security import SecurityGateway, SecurityError, ProfileVerifier, SignatureError


def _has_crypto() -> bool:
    """Check if the cryptography package is functional (without triggering pyo3 panics)."""
    import importlib
    try:
        # Check for _cffi_backend first — its absence causes a Rust panic
        importlib.import_module("_cffi_backend")
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        return True
    except (ImportError, ModuleNotFoundError):
        return False


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


class TestProfileVerifier:
    """Tests for Ed25519 portable profile signature verification."""

    def test_unsigned_profile_accepted_with_warning(self):
        """Unsigned profiles (dev mode) should pass with a warning."""
        verifier = ProfileVerifier()
        profile = {
            "profile_version": "1.0",
            "handle": "test-bot",
            "certification": {"level": "In Training", "tier": 1},
            "overall_reasoning_score": 42.0,
        }
        result = verifier.verify(profile)
        assert result == profile

    def test_expired_profile_rejected(self):
        """Expired signed profiles should be rejected."""
        verifier = ProfileVerifier()
        profile = {
            "profile_version": "1.0",
            "handle": "test-bot",
            "signature": "dGVzdA==",  # dummy
            "verification_url": "https://peerzero.science/.well-known/peerzero-public-key.pem",
            "signed_at": "2020-01-01T00:00:00Z",
            "expires_at": "2020-02-01T00:00:00Z",  # expired
        }
        with pytest.raises(SignatureError, match="expired"):
            verifier.verify(profile)

    def test_missing_verification_url_rejected(self):
        """Signed profile without verification URL should be rejected."""
        verifier = ProfileVerifier()
        profile = {
            "profile_version": "1.0",
            "handle": "test-bot",
            "signature": "dGVzdA==",
            "signed_at": "2030-01-01T00:00:00Z",
            "expires_at": "2030-02-01T00:00:00Z",
        }
        with pytest.raises(SignatureError, match="verification URL"):
            verifier.verify(profile)

    @pytest.mark.skipif(
        not _has_crypto(),
        reason="cryptography package not available in this environment",
    )
    def test_signature_verification_with_real_keys(self):
        """End-to-end: sign with Ed25519, verify with public key."""
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import (
            Encoding, PublicFormat,
        )

        # Generate test keypair
        private_key = Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        public_key_pem = public_key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)

        # Build a profile and sign it (mimicking School behavior)
        profile = {
            "profile_version": "1.0",
            "handle": "test-bot",
            "certification": {"level": "In Training", "tier": 1},
            "overall_reasoning_score": 42.0,
        }
        canonical = json.dumps(profile, sort_keys=True)
        signature = private_key.sign(canonical.encode())

        import base64
        signed_profile = {
            **profile,
            "signature": base64.b64encode(signature).decode(),
            "verification_url": "https://test.example.com/key.pem",
            "signed_at": "2030-01-01T00:00:00Z",
            "expires_at": "2030-02-01T00:00:00Z",
        }

        # Verify — inject cached public key to avoid HTTP fetch
        verifier = ProfileVerifier()
        verifier._cached_public_key = public_key_pem
        result = verifier.verify(signed_profile)
        assert result["handle"] == "test-bot"

    @pytest.mark.skipif(
        not _has_crypto(),
        reason="cryptography package not available in this environment",
    )
    def test_forged_signature_rejected(self):
        """Profile with tampered signature should be rejected."""
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        # Generate two different keypairs
        real_key = Ed25519PrivateKey.generate()
        forger_key = Ed25519PrivateKey.generate()
        real_pub_pem = real_key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)

        profile = {"handle": "test-bot", "profile_version": "1.0"}
        canonical = json.dumps(profile, sort_keys=True)

        # Sign with forger's key but verify against real key
        import base64
        forged_sig = forger_key.sign(canonical.encode())
        signed_profile = {
            **profile,
            "signature": base64.b64encode(forged_sig).decode(),
            "verification_url": "https://test.example.com/key.pem",
            "signed_at": "2030-01-01T00:00:00Z",
            "expires_at": "2030-02-01T00:00:00Z",
        }

        verifier = ProfileVerifier()
        verifier._cached_public_key = real_pub_pem
        with pytest.raises(SignatureError, match="failed"):
            verifier.verify(signed_profile)

    def test_clear_cache(self):
        """Cache clearing should force re-fetch."""
        verifier = ProfileVerifier()
        verifier._cached_public_key = b"test-key"
        verifier.clear_cache()
        assert verifier._cached_public_key is None
