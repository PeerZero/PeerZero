"""PeerZero SDK — Verify bot credentials and parse portable profiles."""

from peerzero_sdk.verify import (
    verify,
    parse_profile,
    parse_agent_card,
    is_expired,
    get_public_key,
    clear_key_cache,
    VerificationError,
    ALLOWED_SCHOOL_DOMAINS,
)

__all__ = [
    "verify",
    "parse_profile",
    "parse_agent_card",
    "is_expired",
    "get_public_key",
    "clear_key_cache",
    "VerificationError",
    "ALLOWED_SCHOOL_DOMAINS",
]
