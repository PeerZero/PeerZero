"""
PeerZero Shell Bot — Configuration & Security

Security principles:
  - API keys NEVER logged, NEVER stored in plaintext files
  - LLM key goes ONLY to the LLM provider
  - PeerZero key goes ONLY to PeerZero endpoints
  - All secrets from environment variables
  - Memory stored locally with restricted file permissions
  - No telemetry, no data collection, no phone-home
"""

import os
import sys
import stat
import hashlib
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


# ── Security: validate that keys look right before using them ────────────────
# This prevents accidentally sending one provider's key to another provider.

def _validate_peerzero_key(key: str) -> bool:
    """PeerZero keys start with 'pz_' and are 67 chars (pz_ + 64 hex)."""
    if not key or not key.startswith("pz_"):
        return False
    if len(key) != 67:
        return False
    try:
        int(key[3:], 16)
        return True
    except ValueError:
        return False


def _validate_llm_key(key: str, provider: str) -> bool:
    """Basic format check — prevents obviously wrong keys."""
    if not key or len(key) < 20:
        return False
    if key.startswith("pz_"):
        return False
    if provider == "anthropic" and not key.startswith("sk-ant-"):
        print("[WARN] Anthropic key doesn't start with 'sk-ant-' — double-check it.")
    if provider == "openai" and not key.startswith("sk-"):
        print("[WARN] OpenAI key doesn't start with 'sk-' — double-check it.")
    return True


# ── Allowed endpoints — the bot ONLY talks to these ─────────────────────────
ALLOWED_PEERZERO_PATHS = frozenset([
    "/api/register",
    "/api/papers",
    "/api/reviews",
    "/api/responses",
    "/api/bounties",
    "/api/agents",
    "/api/identity",
    "/api/skill",
    "/api/skill-reflections",
    "/api/review_ratings",
    "/api/open-questions",
])

ALLOWED_LLM_HOSTS = frozenset([
    "api.anthropic.com",
    "api.openai.com",
])

ALLOWED_ACADEMIC_HOSTS = frozenset([
    "api.openalex.org",
    "api.semanticscholar.org",
    "export.arxiv.org",
    "eutils.ncbi.nlm.nih.gov",
])


@dataclass
class BotConfig:
    """
    All configuration for the shell bot.
    Loaded from environment variables — never hardcoded.
    """

    # ── Required ─────────────────────────────────────────────────────────────
    peerzero_url: str = ""          # e.g. "https://peerzero.science"
    peerzero_api_key: str = ""      # pz_xxxx...
    llm_api_key: str = ""           # sk-ant-xxxx... or sk-xxxx...
    llm_provider: str = "anthropic" # "anthropic" or "openai"

    # ── Optional tuning ──────────────────────────────────────────────────────
    llm_model: str = ""             # defaults per provider below
    cycle_delay_seconds: int = 60   # pause between cycles (be a good citizen)
    max_cycles: int = 0             # 0 = unlimited
    memory_dir: str = ""            # where to store local memory files
    log_level: str = "INFO"         # INFO, DEBUG, WARN, ERROR
    max_llm_tokens: int = 8192     # max tokens per LLM call

    # ── Internal (set during validation) ─────────────────────────────────────
    _validated: bool = field(default=False, repr=False)

    @classmethod
    def from_env(cls) -> "BotConfig":
        """Load config from environment variables."""
        config = cls(
            peerzero_url=os.environ.get("PEERZERO_URL", "https://peerzero.science"),
            peerzero_api_key=os.environ.get("PEERZERO_API_KEY", ""),
            llm_api_key=os.environ.get("LLM_API_KEY", ""),
            llm_provider=os.environ.get("LLM_PROVIDER", "anthropic").lower(),
            llm_model=os.environ.get("LLM_MODEL", ""),
            cycle_delay_seconds=int(os.environ.get("CYCLE_DELAY", "60")),
            max_cycles=int(os.environ.get("MAX_CYCLES", "0")),
            memory_dir=os.environ.get("MEMORY_DIR", ""),
            log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
            max_llm_tokens=int(os.environ.get("MAX_LLM_TOKENS", "8192")),
        )
        return config

    def validate(self) -> list[str]:
        """
        Validate all config. Returns list of errors (empty = valid).
        NEVER prints or logs the actual key values.
        """
        errors = []

        if not self.peerzero_api_key:
            errors.append("PEERZERO_API_KEY environment variable is required")
        elif not _validate_peerzero_key(self.peerzero_api_key):
            errors.append("PEERZERO_API_KEY format invalid (expected pz_ + 64 hex chars)")

        if not self.llm_api_key:
            errors.append("LLM_API_KEY environment variable is required")
        elif not _validate_llm_key(self.llm_api_key, self.llm_provider):
            errors.append(f"LLM_API_KEY format looks wrong for provider '{self.llm_provider}'")

        if self.llm_provider not in ("anthropic", "openai"):
            errors.append(f"LLM_PROVIDER must be 'anthropic' or 'openai', got '{self.llm_provider}'")

        if not self.peerzero_url.startswith("https://"):
            if not (self.peerzero_url.startswith("http://localhost") or self.peerzero_url.startswith("http://127.0.0.1")):
                errors.append(f"PEERZERO_URL must use HTTPS (or localhost for dev), got '{self.peerzero_url}'")

        # Set defaults
        if not self.llm_model:
            self.llm_model = (
                "claude-sonnet-4-20250514" if self.llm_provider == "anthropic"
                else "gpt-4o"
            )

        if not self.memory_dir:
            key_hash = hashlib.sha256(self.peerzero_api_key.encode()).hexdigest()[:12]
            self.memory_dir = str(Path.home() / ".peerzero-agent" / key_hash)

        if not errors:
            self._validated = True

        return errors

    def ensure_memory_dir(self):
        """Create memory directory with restricted permissions (owner-only)."""
        path = Path(self.memory_dir)
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(stat.S_IRWXU)

    def is_allowed_peerzero_path(self, path: str) -> bool:
        """Check if a PeerZero API path is in the allowlist."""
        base_path = path.split("?")[0]
        return base_path in ALLOWED_PEERZERO_PATHS

    def get_key_fingerprint(self, key_type: str = "peerzero") -> str:
        """
        Return a safe fingerprint for logging (first 6 chars + last 4).
        NEVER log the full key.
        """
        key = self.peerzero_api_key if key_type == "peerzero" else self.llm_api_key
        if len(key) < 12:
            return "***invalid***"
        return f"{key[:6]}...{key[-4:]}"
