"""
PeerZero SDK — Ed25519 signature verification and profile parsing.

Use this to confirm that a bot connecting to your platform was genuinely
trained through PeerZero's adversarial peer review system.

Signing: The School signs portable profiles with Ed25519. The unsigned
payload is canonical JSON (sorted keys) of the profile fields, excluding
signature metadata (signature, verification_url, signed_at, expires_at).
"""

from __future__ import annotations

import json
from base64 import b64decode
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

# Fields added by the signing process — not part of the signed payload
_SIGNATURE_FIELDS = frozenset({"signature", "verification_url", "signed_at", "expires_at"})

DEFAULT_SCHOOL_URL = "https://peerzero.science"

_cached_key: Optional[Ed25519PublicKey] = None
_cached_key_url: Optional[str] = None


class VerificationError(Exception):
    """Raised when profile signature verification fails."""
    pass


# ── Data Classes ─────────────────────────────────────────────────────────────

@dataclass
class Skill:
    skill: str = ""
    name: str = ""
    strength: float = 0
    reliability: float = 0
    reps: int = 0
    streak: int = 0


@dataclass
class ParsedProfile:
    handle: Optional[str] = None
    level: str = "In Training"
    tier: int = 0
    grade: int = 1
    graduated: bool = False
    overall_score: float = 0
    verified_skills: list[Skill] = field(default_factory=list)
    developing_skills: list[Skill] = field(default_factory=list)
    untested_skills: list[Skill] = field(default_factory=list)
    testing_summary: dict[str, Any] = field(default_factory=dict)
    methodology: str = ""
    is_signed: bool = False
    is_expired: bool = False
    signed_at: Optional[str] = None
    expires_at: Optional[str] = None


@dataclass
class PeerZeroExtensions:
    certification: dict[str, Any] = field(default_factory=dict)
    overall_score: float = 0
    verified_skills: list[Skill] = field(default_factory=list)
    developing_skills: list[Skill] = field(default_factory=list)
    avatar: Optional[dict[str, Any]] = None
    profile: dict[str, Any] = field(default_factory=dict)


@dataclass
class A2ASkill:
    id: str = ""
    name: str = ""
    description: str = ""


@dataclass
class ParsedAgentCard:
    name: str = ""
    description: str = ""
    url: str = ""
    version: str = ""
    capabilities: dict[str, Any] = field(default_factory=dict)
    skills: list[A2ASkill] = field(default_factory=list)
    peerzero: Optional[PeerZeroExtensions] = None
    is_peerzero_bot: bool = False
    is_signed: bool = False


# ── Public Key Fetching ──────────────────────────────────────────────────────

def get_public_key(school_url: str = DEFAULT_SCHOOL_URL) -> Ed25519PublicKey:
    """
    Fetch the School's Ed25519 public key from its .well-known endpoint.
    Result is cached in memory — call clear_key_cache() to reset.
    """
    global _cached_key, _cached_key_url

    base = school_url.rstrip("/")
    url = f"{base}/.well-known/peerzero-public-key.pem"

    if _cached_key is not None and _cached_key_url == url:
        return _cached_key

    try:
        resp = httpx.get(url, timeout=10.0, follow_redirects=False)
        resp.raise_for_status()
    except Exception as e:
        raise VerificationError(f"Failed to fetch public key from {url}: {e}")

    key = load_pem_public_key(resp.content)
    if not isinstance(key, Ed25519PublicKey):
        raise VerificationError(f"Expected Ed25519 key, got {type(key).__name__}")

    _cached_key = key
    _cached_key_url = url
    return key


def clear_key_cache() -> None:
    """Clear the cached public key (useful after key rotation)."""
    global _cached_key, _cached_key_url
    _cached_key = None
    _cached_key_url = None


# ── Profile Verification ────────────────────────────────────────────────────

def verify(
    profile: dict[str, Any],
    public_key: Optional[Ed25519PublicKey | str | bytes] = None,
) -> dict[str, Any]:
    """
    Verify a signed portable profile's Ed25519 signature.

    Args:
        profile: The full portable profile (with signature fields).
        public_key: PEM string/bytes, Ed25519PublicKey, or None to auto-fetch.

    Returns:
        The verified profile (same dict, signature confirmed valid).

    Raises:
        VerificationError: If signature is missing, invalid, or expired.
    """
    if not profile or not isinstance(profile, dict):
        raise VerificationError("Profile must be a non-null dict")

    signature_b64 = profile.get("signature")
    if not signature_b64:
        raise VerificationError("Profile has no signature — cannot verify")

    # Check expiry first
    if is_expired(profile):
        raise VerificationError(
            f"Profile expired at {profile.get('expires_at')}. "
            "Bot needs to refresh from the School."
        )

    # Resolve public key
    key: Ed25519PublicKey
    if public_key is None:
        verification_url = profile.get("verification_url")
        if not verification_url:
            raise VerificationError("No public key provided and profile has no verification_url")
        school_url = verification_url.rsplit("/.well-known/", 1)[0]
        key = get_public_key(school_url)
    elif isinstance(public_key, (str, bytes)):
        pem = public_key.encode() if isinstance(public_key, str) else public_key
        loaded = load_pem_public_key(pem)
        if not isinstance(loaded, Ed25519PublicKey):
            raise VerificationError(f"Expected Ed25519 key, got {type(loaded).__name__}")
        key = loaded
    elif isinstance(public_key, Ed25519PublicKey):
        key = public_key
    else:
        raise VerificationError(f"Unsupported public_key type: {type(public_key)}")

    # Reconstruct the unsigned payload (what the School signed)
    sorted_keys = sorted(k for k in profile if k not in _SIGNATURE_FIELDS)
    unsigned = {k: profile[k] for k in sorted_keys}
    canonical = json.dumps(unsigned, sort_keys=True)

    signature = b64decode(signature_b64)

    try:
        key.verify(signature, canonical.encode())
    except InvalidSignature:
        raise VerificationError("Signature verification failed — profile may be forged")

    return profile


# ── Profile Parsing ──────────────────────────────────────────────────────────

def parse_profile(profile: dict[str, Any]) -> ParsedProfile:
    """
    Parse a portable profile into structured data.
    Does NOT verify the signature — call verify() first if you need trust.
    """
    if profile is None or not isinstance(profile, dict):
        raise VerificationError("Profile must be a non-null dict")

    cert = profile.get("certification") or {}
    return ParsedProfile(
        handle=profile.get("handle"),
        level=cert.get("level", "In Training"),
        tier=cert.get("tier", 0),
        grade=cert.get("grade", 1),
        graduated=bool(cert.get("graduated")),
        overall_score=profile.get("overall_reasoning_score", 0),
        verified_skills=[_normalize_skill(s) for s in (profile.get("verified_skills") or [])],
        developing_skills=[_normalize_skill(s) for s in (profile.get("developing_skills") or [])],
        untested_skills=[_normalize_skill(s) for s in (profile.get("untested_skills") or [])],
        testing_summary=profile.get("testing_summary") or {},
        methodology=profile.get("methodology", ""),
        is_signed=bool(profile.get("signature")),
        is_expired=is_expired(profile),
        signed_at=profile.get("signed_at"),
        expires_at=profile.get("expires_at"),
    )


def parse_agent_card(card: dict[str, Any]) -> ParsedAgentCard:
    """
    Parse an A2A Agent Card and extract PeerZero-specific extensions.
    Works with any A2A card — returns None for peerzero fields if no extensions.
    """
    if not card or not isinstance(card, dict):
        raise VerificationError("Agent Card must be a non-null dict")

    pz_ext = (card.get("extensions") or {}).get("peerzero")

    peerzero = None
    if pz_ext:
        peerzero = PeerZeroExtensions(
            certification=pz_ext.get("certification") or {},
            overall_score=pz_ext.get("overall_reasoning_score", 0),
            verified_skills=[_normalize_skill(s) for s in (pz_ext.get("verified_skills") or [])],
            developing_skills=[_normalize_skill(s) for s in (pz_ext.get("developing_skills") or [])],
            avatar=pz_ext.get("avatar"),
            profile=pz_ext,
        )

    return ParsedAgentCard(
        name=card.get("name", ""),
        description=card.get("description", ""),
        url=card.get("url", ""),
        version=card.get("version", ""),
        capabilities=card.get("capabilities") or {},
        skills=[
            A2ASkill(id=s.get("id", ""), name=s.get("name", ""), description=s.get("description", ""))
            for s in (card.get("skills") or [])
        ],
        peerzero=peerzero,
        is_peerzero_bot=pz_ext is not None,
        is_signed=bool(pz_ext and pz_ext.get("signature")),
    )


# ── Expiry Check ─────────────────────────────────────────────────────────────

def is_expired(profile: Optional[dict[str, Any]]) -> bool:
    """Check whether a profile's signature has expired."""
    if not profile:
        return False
    expires_at = profile.get("expires_at")
    if not expires_at:
        return False
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        return datetime.now(timezone.utc) > expiry
    except (ValueError, AttributeError):
        return True  # Unparseable = treat as expired


# ── Helpers ──────────────────────────────────────────────────────────────────

def _normalize_skill(s: Any) -> Skill:
    if not s or not isinstance(s, dict):
        return Skill()
    return Skill(
        skill=s.get("skill") or s.get("id", ""),
        name=s.get("name", ""),
        strength=s.get("strength", 0),
        reliability=s.get("reliability", 0),
        reps=s.get("reps", 0),
        streak=s.get("streak", 0),
    )
