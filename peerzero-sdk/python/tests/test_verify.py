"""Tests for peerzero_sdk verification and parsing."""

import json
from base64 import b64encode
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
)

from peerzero_sdk import (
    verify,
    parse_profile,
    parse_agent_card,
    is_expired,
    clear_key_cache,
    VerificationError,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clear_cache():
    clear_key_cache()
    yield
    clear_key_cache()


@pytest.fixture
def keypair():
    private = Ed25519PrivateKey.generate()
    public = private.public_key()
    return private, public


def make_profile(**overrides):
    profile = {
        "handle": "test-bot",
        "certification": {"level": "Verified Reasoner", "tier": 3, "grade": 5, "graduated": False},
        "overall_reasoning_score": 72.4,
        "verified_skills": [
            {"skill": "adversarial_reasoning", "name": "Adversarial Reasoning",
             "strength": 78, "reliability": 0.84, "reps": 45, "streak": 8},
        ],
        "developing_skills": [
            {"skill": "calibrated_uncertainty", "name": "Calibrated Uncertainty",
             "strength": 42, "reliability": 0.6, "reps": 12, "streak": 3},
        ],
        "untested_skills": [],
        "testing_summary": {"total_exercises": 120, "unique_skills_tested": 4},
        "methodology": "Skills measured through adversarial peer review.",
        "profile_version": "1.0",
    }
    profile.update(overrides)
    return profile


def sign_profile(profile, private_key):
    sorted_keys = sorted(profile.keys())
    canonical = json.dumps(profile, sort_keys=True)
    signature = private_key.sign(canonical.encode())
    now = datetime.now(timezone.utc)
    return {
        **profile,
        "signature": b64encode(signature).decode(),
        "verification_url": "https://peerzero.science/.well-known/peerzero-public-key.pem",
        "signed_at": now.isoformat(),
        "expires_at": (now + timedelta(days=30)).isoformat(),
    }


def make_agent_card(profile=None):
    p = profile or make_profile()
    return {
        "name": "test-bot",
        "description": "PeerZero-trained reasoning agent.",
        "url": "",
        "version": "1.0",
        "capabilities": {"streaming": False},
        "skills": [{"id": "adversarial_reasoning", "name": "Adversarial Reasoning",
                     "description": "Finds structural flaws"}],
        "extensions": {
            "peerzero": {
                "profile_version": "1.0",
                "certification": {"level": "Verified Reasoner", "tier": 3},
                "overall_reasoning_score": 72.4,
                "verified_skills": p.get("verified_skills", []),
                "developing_skills": p.get("developing_skills", []),
                "signature": p.get("signature"),
                "verification_url": p.get("verification_url"),
                "avatar": {"config": {}, "evolution_stage": 3, "evolution_name": "Companion"},
            },
        },
    }


# ── verify() ─────────────────────────────────────────────────────────────────

class TestVerify:
    def test_valid_signature(self, keypair):
        private, public = keypair
        signed = sign_profile(make_profile(), private)
        result = verify(signed, public)
        assert result["handle"] == "test-bot"

    def test_pem_string_key(self, keypair):
        private, public = keypair
        pem = public.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
        signed = sign_profile(make_profile(), private)
        verify(signed, pem)

    def test_pem_bytes_key(self, keypair):
        private, public = keypair
        pem = public.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        signed = sign_profile(make_profile(), private)
        verify(signed, pem)

    def test_rejects_tampered(self, keypair):
        private, public = keypair
        signed = sign_profile(make_profile(), private)
        signed["overall_reasoning_score"] = 99.9
        with pytest.raises(VerificationError, match="forged"):
            verify(signed, public)

    def test_rejects_wrong_key(self, keypair):
        private, _ = keypair
        other_private = Ed25519PrivateKey.generate()
        other_public = other_private.public_key()
        signed = sign_profile(make_profile(), private)
        with pytest.raises(VerificationError, match="forged"):
            verify(signed, other_public)

    def test_rejects_expired(self, keypair):
        private, public = keypair
        signed = sign_profile(make_profile(), private)
        signed["expires_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        with pytest.raises(VerificationError, match="expired"):
            verify(signed, public)

    def test_rejects_unsigned(self, keypair):
        _, public = keypair
        with pytest.raises(VerificationError, match="no signature"):
            verify(make_profile(), public)

    def test_rejects_none(self, keypair):
        _, public = keypair
        with pytest.raises(VerificationError):
            verify(None, public)

    def test_preserves_fields(self, keypair):
        private, public = keypair
        signed = sign_profile(make_profile(handle="my-bot"), private)
        result = verify(signed, public)
        assert result["handle"] == "my-bot"
        assert result["overall_reasoning_score"] == 72.4
        assert "signature" in result
        assert "signed_at" in result


# ── parse_profile() ──────────────────────────────────────────────────────────

class TestParseProfile:
    def test_full_profile(self):
        parsed = parse_profile(make_profile())
        assert parsed.handle == "test-bot"
        assert parsed.level == "Verified Reasoner"
        assert parsed.tier == 3
        assert parsed.grade == 5
        assert parsed.graduated is False
        assert parsed.overall_score == 72.4
        assert len(parsed.verified_skills) == 1
        assert parsed.verified_skills[0].skill == "adversarial_reasoning"
        assert parsed.verified_skills[0].strength == 78
        assert len(parsed.developing_skills) == 1
        assert parsed.is_signed is False
        assert parsed.is_expired is False

    def test_minimal_profile(self):
        parsed = parse_profile({})
        assert parsed.handle is None
        assert parsed.level == "In Training"
        assert parsed.tier == 0
        assert parsed.overall_score == 0
        assert len(parsed.verified_skills) == 0

    def test_signed_profile(self, keypair):
        private, _ = keypair
        signed = sign_profile(make_profile(), private)
        parsed = parse_profile(signed)
        assert parsed.is_signed is True
        assert parsed.signed_at is not None
        assert parsed.expires_at is not None

    def test_expired_profile(self, keypair):
        private, _ = keypair
        signed = sign_profile(make_profile(), private)
        signed["expires_at"] = "2020-01-01T00:00:00+00:00"
        parsed = parse_profile(signed)
        assert parsed.is_expired is True

    def test_rejects_none(self):
        with pytest.raises(VerificationError):
            parse_profile(None)


# ── parse_agent_card() ───────────────────────────────────────────────────────

class TestParseAgentCard:
    def test_peerzero_card(self):
        card = make_agent_card(make_profile())
        parsed = parse_agent_card(card)
        assert parsed.name == "test-bot"
        assert parsed.is_peerzero_bot is True
        assert parsed.peerzero is not None
        assert parsed.peerzero.overall_score == 72.4
        assert len(parsed.skills) == 1
        assert parsed.skills[0].id == "adversarial_reasoning"

    def test_non_peerzero_card(self):
        card = {"name": "generic-bot", "capabilities": {}, "skills": []}
        parsed = parse_agent_card(card)
        assert parsed.is_peerzero_bot is False
        assert parsed.peerzero is None
        assert parsed.is_signed is False

    def test_avatar_info(self):
        card = make_agent_card(make_profile())
        parsed = parse_agent_card(card)
        assert parsed.peerzero.avatar is not None
        assert parsed.peerzero.avatar["evolution_stage"] == 3
        assert parsed.peerzero.avatar["evolution_name"] == "Companion"

    def test_rejects_none(self):
        with pytest.raises(VerificationError):
            parse_agent_card(None)


# ── is_expired() ─────────────────────────────────────────────────────────────

class TestIsExpired:
    def test_future_date(self):
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        assert is_expired({"expires_at": future}) is False

    def test_past_date(self):
        assert is_expired({"expires_at": "2020-01-01T00:00:00+00:00"}) is True

    def test_no_expires_at(self):
        assert is_expired({}) is False

    def test_none_input(self):
        assert is_expired(None) is False

    def test_unparseable_date(self):
        assert is_expired({"expires_at": "not-a-date"}) is True
