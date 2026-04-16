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
import re
import time
from base64 import b64decode
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence
from urllib.parse import urlparse

import httpx
from cryptography.exceptions import InvalidSignature
import threading

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

# Fields added by the signing process — not part of the signed payload.
# WARNING: Changes to _SIGNATURE_FIELDS are a breaking change. Adding or removing
# fields changes the canonical payload that is signed/verified, which means all
# existing signed profiles will fail verification. Bump the major version if you
# change this set.
_SIGNATURE_FIELDS = frozenset({"signature", "verification_url", "signed_at", "expires_at"})

DEFAULT_SCHOOL_URL = "https://peerzero.science"

# Domain allowlist for SSRF protection
ALLOWED_SCHOOL_DOMAINS: set[str] = {
    "peerzero.science",
    "politics.peerzero.com",
    "comedy.peerzero.com",
    "philosophy.peerzero.com",
    "psychiatry.peerzero.com",
    "localhost",
}

# Max fetch size (10KB)
_MAX_FETCH_SIZE = 10240

# Key cache TTL (1 hour)
_KEY_TTL_S = 3600.0

# Rate limiter state
_rate_limiter = {
    "tokens": 10,
    "max_tokens": 10,
    "last_refill": 0.0,
    "interval_s": 60.0,
}

_cached_key: Optional[Ed25519PublicKey] = None
_cached_key_url: Optional[str] = None
_cached_key_time: float = 0.0
_state_lock = threading.Lock()  # Guards rate limiter + key cache for thread safety


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

def _consume_rate_token() -> None:
    """Consume a rate-limit token, raising if exhausted."""
    with _state_lock:
        now = time.monotonic()
        elapsed = now - _rate_limiter["last_refill"]
        if elapsed >= _rate_limiter["interval_s"]:
            _rate_limiter["tokens"] = _rate_limiter["max_tokens"]
            _rate_limiter["last_refill"] = now
        if _rate_limiter["tokens"] <= 0:
            raise VerificationError(
                "Rate limit exceeded: too many public key fetches. Try again later."
            )
        _rate_limiter["tokens"] -= 1


def get_public_key(
    school_url: str = DEFAULT_SCHOOL_URL,
    *,
    allowed_domains: Optional[Sequence[str]] = None,
) -> Ed25519PublicKey:
    """
    Fetch the School's Ed25519 public key from its .well-known endpoint.
    Result is cached in memory for 1 hour — call clear_key_cache() to reset.

    Args:
        school_url: Base URL of the School (default: https://peerzero.science).
        allowed_domains: Additional domains to allow beyond the built-in list.
    """
    global _cached_key, _cached_key_url, _cached_key_time

    parsed = urlparse(school_url)
    if parsed.scheme != "https" and parsed.hostname != "localhost":
        raise VerificationError(
            f"School URL must use HTTPS, got: {school_url}"
        )

    # Validate domain against allowlist (SSRF protection)
    hostname = parsed.hostname
    if not hostname:
        raise VerificationError(f"Invalid school URL: {school_url}")
    all_allowed = ALLOWED_SCHOOL_DOMAINS | set(allowed_domains or [])
    if hostname not in all_allowed:
        raise VerificationError(
            f'Domain "{hostname}" is not in the allowed school domains list. '
            f'Pass allowed_domains=["{hostname}"] if this is a legitimate PeerZero school.'
        )

    base = school_url.rstrip("/")
    url = f"{base}/.well-known/peerzero-public-key.pem"

    # Check cache (with TTL) — lock protects concurrent reads/writes
    with _state_lock:
        now = time.monotonic()
        if _cached_key is not None and _cached_key_url == url and (now - _cached_key_time) < _KEY_TTL_S:
            return _cached_key

    # Rate limit
    _consume_rate_token()

    try:
        with httpx.stream("GET", url, timeout=10.0, follow_redirects=False, verify=True) as resp:
            resp.raise_for_status()
            chunks: list[bytes] = []
            total_size = 0
            for chunk in resp.iter_bytes():
                total_size += len(chunk)
                if total_size > _MAX_FETCH_SIZE:
                    raise VerificationError(
                        f"Response from {url} exceeds maximum size of {_MAX_FETCH_SIZE} bytes"
                    )
                chunks.append(chunk)
            content = b"".join(chunks)
    except VerificationError:
        raise
    except Exception as e:
        raise VerificationError(f"Failed to fetch public key from {url}: {e}")

    key = load_pem_public_key(content)
    if not isinstance(key, Ed25519PublicKey):
        raise VerificationError(f"Expected Ed25519 key, got {type(key).__name__}")

    with _state_lock:
        _cached_key = key
        _cached_key_url = url
        _cached_key_time = time.monotonic()
    return key


def clear_key_cache() -> None:
    """Clear the cached public key (useful after key rotation)."""
    global _cached_key, _cached_key_url, _cached_key_time
    _cached_key = None
    _cached_key_url = None
    _cached_key_time = 0.0


# ── Profile Verification ────────────────────────────────────────────────────

_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+=*$")


def verify(
    profile: dict[str, Any],
    public_key: Optional[Ed25519PublicKey | str | bytes] = None,
    *,
    allowed_domains: Optional[Sequence[str]] = None,
) -> dict[str, Any]:
    """
    Verify a signed portable profile's Ed25519 signature.

    Threat model: a successful verify() proves the profile was signed by the
    School whose public key you trust — it does NOT prove the presenter
    holds a private key, that the bot is still in good standing, or that
    the profile is fresh. Profiles are verifiable credentials (like a
    diploma), not authentication tokens. If your platform needs proof-of-
    possession, revocation checks, or freshness, layer those on top of
    verify(). See the README "Threat Model" section for details.

    Args:
        profile: The full portable profile (with signature fields).
        public_key: PEM string/bytes, Ed25519PublicKey, or None to auto-fetch.
        allowed_domains: Additional domains to allow beyond the built-in list
            (passed through to get_public_key when auto-fetching).

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
    if not isinstance(signature_b64, str) or not _BASE64_RE.match(signature_b64):
        raise VerificationError("Profile signature is not valid base64")

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
        key = get_public_key(school_url, allowed_domains=allowed_domains)
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

    # SECURITY: Enforce a size limit before serializing for verification.
    # A malicious profile with huge field values could cause DoS via memory/CPU.
    _MAX_PROFILE_SIZE = 10 * 1024 * 1024  # 10 MB
    profile_estimate = len(json.dumps(profile))
    if profile_estimate > _MAX_PROFILE_SIZE:
        raise VerificationError(
            f"Profile too large ({profile_estimate} bytes, max {_MAX_PROFILE_SIZE}) — "
            f"refusing to verify"
        )

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
        # 60-second clock skew tolerance
        return expiry < datetime.now(timezone.utc) - timedelta(seconds=60)
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
