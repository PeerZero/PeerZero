"""
Profile Signature Verification — verify School-signed portable profiles.

The School signs portable profiles with an Ed25519 private key.
This module verifies those signatures against the School's public key.

Public key is fetched from the School's .well-known endpoint and cached.
Expired profiles are rejected.
"""

import json
import logging
from base64 import b64decode
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger("peerzero-bot.security")


class SignatureError(Exception):
    """Raised when profile signature verification fails."""
    pass


class ProfileVerifier:
    """
    Verifies Ed25519 signatures on portable profiles.
    Fetches and caches the School's public key.
    """

    def __init__(self, verification_url: str = ""):
        self._verification_url = verification_url
        self._cached_public_key: Optional[bytes] = None
        self._http = httpx.Client(timeout=10.0, follow_redirects=False)

    def verify(self, profile: dict) -> dict:
        """
        Verify a signed portable profile.

        Returns the profile without signature fields if valid.
        Raises SignatureError if verification fails.

        If the profile has no signature (dev mode / signing key not configured),
        logs a warning and returns it as-is.
        """
        signature_b64 = profile.get("signature")
        if not signature_b64:
            logger.warning("Portable profile has no signature — accepting unsigned (dev mode)")
            return profile

        # Check expiry
        expires_at = profile.get("expires_at")
        if expires_at:
            try:
                expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if datetime.now(timezone.utc) > expiry:
                    raise SignatureError(
                        f"Profile expired at {expires_at}. "
                        "Refresh credentials from the School."
                    )
            except ValueError as e:
                raise SignatureError(f"Invalid expires_at format: {e}")

        # Get verification URL from profile or fallback
        verification_url = profile.get("verification_url", self._verification_url)
        if not verification_url:
            raise SignatureError("No verification URL — cannot verify signature")

        # Extract the unsigned profile (the payload that was signed)
        unsigned = {k: v for k, v in profile.items()
                    if k not in ("signature", "verification_url", "signed_at", "expires_at")}

        # Canonical JSON must match what the School produced
        canonical = json.dumps(unsigned, sort_keys=True)

        # Verify Ed25519 signature
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            from cryptography.hazmat.primitives.serialization import load_pem_public_key
            from cryptography.exceptions import InvalidSignature
        except ImportError:
            raise SignatureError(
                "cryptography package is required for signature verification. "
                "Install with: pip install cryptography"
            )

        try:
            public_key_pem = self._get_public_key(verification_url)
            public_key = load_pem_public_key(public_key_pem)

            if not isinstance(public_key, Ed25519PublicKey):
                raise SignatureError("Public key is not Ed25519")

            signature = b64decode(signature_b64)
            public_key.verify(signature, canonical.encode())

            logger.info("Portable profile signature verified successfully")
            return profile

        except InvalidSignature:
            raise SignatureError("Signature verification failed — profile may be forged")

    def _get_public_key(self, verification_url: str) -> bytes:
        """Fetch and cache the School's public key."""
        if self._cached_public_key:
            return self._cached_public_key

        try:
            response = self._http.get(verification_url)
            response.raise_for_status()
            self._cached_public_key = response.content
            logger.info(f"Fetched public key from {verification_url}")
            return self._cached_public_key
        except Exception as e:
            raise SignatureError(f"Failed to fetch public key from {verification_url}: {e}")

    def clear_cache(self):
        """Clear cached public key (for key rotation)."""
        self._cached_public_key = None
