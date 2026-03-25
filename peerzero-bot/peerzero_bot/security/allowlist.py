"""
Security Gateway — endpoint allowlist enforcement.

Every outbound HTTP request passes through this gateway.
Each adapter declares its allowed hosts at initialization.
A credential bound to adapter A can NEVER reach adapter B's hosts.
"""

import logging
from urllib.parse import urlparse

logger = logging.getLogger("peerzero-bot.security")


class SecurityError(Exception):
    """Raised when a request would violate the endpoint allowlist."""
    pass


# ── Default allowlists ───────────────────────────────────────────────────────

SCHOOL_PATHS = frozenset([
    "/api/register",
    "/api/papers",
    "/api/reviews",
    "/api/responses",
    "/api/bounties",
    "/api/agents",
    "/api/identity",
    "/api/skill",
    "/api/skill-reflections",
    "/api/review-ratings",
    "/api/open-questions",
])

LLM_HOSTS = frozenset([
    "api.anthropic.com",
    "api.openai.com",
    "llm.peerzero.science",  # LLM proxy — injects preamble server-side
])

ACADEMIC_HOSTS = frozenset([
    "api.openalex.org",
    "api.semanticscholar.org",
    "export.arxiv.org",
    "eutils.ncbi.nlm.nih.gov",
])


class SecurityGateway:
    """
    Validates every outbound request against registered allowlists.

    Each adapter registers its allowed hosts. The gateway enforces
    that credentials only reach their intended destinations.
    """

    def __init__(self, school_url: str = ""):
        self._school_url = school_url.rstrip("/")
        # Map of adapter_name -> set of allowed hostnames
        self._adapter_hosts: dict[str, set[str]] = {}

    def register_adapter(self, adapter_name: str, allowed_hosts: set[str]):
        """Register an adapter with its allowed destination hosts."""
        self._adapter_hosts[adapter_name] = allowed_hosts
        logger.debug(f"Registered adapter '{adapter_name}' with hosts: {allowed_hosts}")

    def validate_school_request(self, path: str):
        """Validate a request to the PeerZero School."""
        base_path = path.split("?")[0]
        if base_path not in SCHOOL_PATHS:
            raise SecurityError(f"Blocked: {base_path} not in School path allowlist")

    def validate_llm_request(self, url: str):
        """Validate a request to an LLM provider."""
        host = urlparse(url).hostname
        if host not in LLM_HOSTS:
            raise SecurityError(f"Blocked: {host} not in LLM host allowlist")

    def validate_academic_request(self, url: str):
        """Validate a request to an academic API."""
        host = urlparse(url).hostname
        if host not in ACADEMIC_HOSTS:
            raise SecurityError(f"Blocked: {host} not in academic host allowlist")

    def validate_platform_request(self, adapter_name: str, url: str):
        """Validate a request from a platform adapter to its declared hosts."""
        host = urlparse(url).hostname
        allowed = self._adapter_hosts.get(adapter_name, set())
        if host not in allowed:
            raise SecurityError(
                f"Blocked: adapter '{adapter_name}' cannot reach {host}. "
                f"Allowed: {allowed}"
            )

    def validate_phone_home_request(self, url: str, app_url: str):
        """Validate a phone-home request to the PeerZero app.

        Uses hostname comparison instead of prefix matching to prevent
        bypasses like https://evil.com.attacker.com matching https://evil.com.
        """
        parsed_url = urlparse(url)
        parsed_app = urlparse(app_url)
        if parsed_url.hostname != parsed_app.hostname:
            raise SecurityError(
                f"Blocked: phone-home host {parsed_url.hostname} doesn't match "
                f"app host {parsed_app.hostname}"
            )
        if parsed_url.scheme != parsed_app.scheme:
            raise SecurityError(
                f"Blocked: phone-home scheme {parsed_url.scheme} doesn't match "
                f"app scheme {parsed_app.scheme}"
            )
