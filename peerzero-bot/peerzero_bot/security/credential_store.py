"""
Credential Store — safe credential management.

Credentials are:
  - Loaded from environment variables ONLY
  - Bound to specific adapters (a credential cannot leak cross-adapter)
  - Never logged in full (fingerprints only)
  - Never stored in config files or memory files
"""

import logging

logger = logging.getLogger("peerzero-bot.security")


class CredentialStore:
    """
    Holds credentials bound to their intended adapter.
    Each credential has an owner (adapter name) and can only be
    retrieved by that owner.
    """

    def __init__(self):
        self._credentials: dict[str, str] = {}  # adapter_name -> credential
        self._owners: dict[str, str] = {}        # credential_id -> adapter_name

    def register(self, adapter_name: str, credential: str, credential_id: str = ""):
        """Register a credential bound to a specific adapter."""
        cred_id = credential_id or adapter_name
        self._credentials[cred_id] = credential
        self._owners[cred_id] = adapter_name
        logger.info(f"Registered credential '{cred_id}' for adapter '{adapter_name}'")

    def get(self, credential_id: str, requesting_adapter: str) -> str:
        """
        Get a credential. Only the owning adapter can retrieve it.
        Raises SecurityError if a different adapter tries to access it.
        """
        owner = self._owners.get(credential_id)
        if owner is None:
            raise KeyError(f"No credential registered with id '{credential_id}'")
        if owner != requesting_adapter:
            logger.warning(
                f"BLOCKED: Adapter '{requesting_adapter}' tried to access credential "
                f"'{credential_id}' (owned by '{owner}')"
            )
            raise PermissionError(
                f"Adapter '{requesting_adapter}' cannot access credential '{credential_id}' "
                f"(owned by '{owner}')"
            )
        return self._credentials[credential_id]

    def fingerprint(self, credential_id: str) -> str:
        """Safe fingerprint for logging. NEVER returns the full credential."""
        cred = self._credentials.get(credential_id, "")
        if len(cred) < 12:
            return "***not-set***"
        return f"{cred[:6]}...{cred[-4:]}"
