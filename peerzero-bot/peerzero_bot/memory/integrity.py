"""
Memory integrity — HMAC-SHA256 tamper detection for stored data.

Simple compute/verify pair. Does NOT prevent tampering (an attacker with
file access could recompute HMACs), but detects accidental corruption
and raises the bar for casual modification.
"""

import hmac
import hashlib


def compute_hmac(key: bytes, data: str) -> str:
    """Compute HMAC-SHA256 of data, returning hex digest."""
    return hmac.new(key, data.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_hmac(key: bytes, data: str, expected: str) -> bool:
    """Verify HMAC-SHA256 using constant-time comparison. Returns True if valid."""
    actual = compute_hmac(key, data)
    return hmac.compare_digest(actual, expected)
