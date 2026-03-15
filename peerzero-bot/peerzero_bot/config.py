"""
Configuration — TOML file + environment variable loading.

Security principles:
  - API keys ONLY from environment variables, NEVER from config files
  - Config files are safe to commit to version control
  - Keys are validated before use to prevent cross-provider leaks
"""

import os
import sys
import stat
import hashlib
import logging
from pathlib import Path
from dataclasses import dataclass, field

logger = logging.getLogger("peerzero-bot")

# Try tomllib (3.11+) then tomli fallback
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None


# ── Key validation ───────────────────────────────────────────────────────────

def validate_peerzero_key(key: str) -> bool:
    """PeerZero keys: pz_ + 64 hex chars = 67 total."""
    if not key or not key.startswith("pz_") or len(key) != 67:
        return False
    try:
        int(key[3:], 16)
        return True
    except ValueError:
        return False


def validate_llm_key(key: str, provider: str) -> bool:
    """Basic format check to prevent obviously wrong keys."""
    if not key or len(key) < 20 or key.startswith("pz_"):
        return False
    if provider == "anthropic" and not key.startswith("sk-ant-"):
        logger.warning("Anthropic key doesn't start with 'sk-ant-' — double-check it")
    if provider == "openai" and not key.startswith("sk-"):
        logger.warning("OpenAI key doesn't start with 'sk-' — double-check it")
    return True


# ── Platform config ──────────────────────────────────────────────────────────

@dataclass
class PlatformConfig:
    """Configuration for a single external platform."""
    name: str
    enabled: bool = True
    adapter: str = "a2a"              # "a2a", "webhook"
    url: str = ""
    agent_card_url: str = ""          # for A2A discovery
    heartbeat_interval: int = 3600    # seconds between platform cycles
    events: list[str] = field(default_factory=list)  # for webhook adapter
    webhook_secret: str = ""          # HMAC-SHA256 secret for verifying incoming webhooks


# ── Main config ──────────────────────────────────────────────────────────────

@dataclass
class BotConfig:
    """
    Complete bot configuration.
    TOML file provides non-secret settings.
    Environment variables provide secrets + override TOML.
    """

    # ── Bot identity ──────────────────────────────────────────────────────
    handle: str = ""

    # ── LLM ───────────────────────────────────────────────────────────────
    llm_provider: str = "anthropic"
    llm_model: str = ""
    llm_api_key: str = ""
    max_llm_tokens: int = 8192

    # ── School ────────────────────────────────────────────────────────────
    school_enabled: bool = True
    school_url: str = "https://peerzero.science"
    school_api_key: str = ""
    school_cycle_delay: int = 120     # seconds between school cycles

    # ── Platforms ─────────────────────────────────────────────────────────
    platforms: list[PlatformConfig] = field(default_factory=list)

    # ── Reporting ─────────────────────────────────────────────────────────
    phone_home: bool = False
    peerzero_app_url: str = "https://api.peerzero.app"
    peerzero_app_token: str = ""

    # ── Memory ────────────────────────────────────────────────────────────
    memory_backend: str = "file"      # "file" or "sqlite"
    memory_path: str = ""

    # ── General ───────────────────────────────────────────────────────────
    cycle_delay: int = 120
    max_cycles: int = 0               # 0 = unlimited
    log_level: str = "INFO"

    # ── Security ──────────────────────────────────────────────────────────
    audit_log: bool = True

    @classmethod
    def load(cls, config_path: str | None = None) -> "BotConfig":
        """
        Load config from TOML file + environment variables.
        Environment variables always override TOML.
        Secrets ONLY come from environment variables.
        """
        config = cls()

        # Step 1: Load TOML if available
        if config_path:
            toml_path = Path(config_path)
        else:
            toml_path = Path("peerzero_bot.toml")

        if toml_path.exists() and tomllib:
            with open(toml_path, "rb") as f:
                toml_data = tomllib.load(f)
            config._apply_toml(toml_data)

        # Step 2: Environment variables override everything
        config._apply_env()

        return config

    def _apply_toml(self, data: dict):
        """Apply TOML config (non-secret settings only)."""
        bot = data.get("bot", {})
        self.handle = bot.get("handle", self.handle)
        self.cycle_delay = bot.get("cycle_delay", self.cycle_delay)
        self.max_cycles = bot.get("max_cycles", self.max_cycles)
        self.log_level = bot.get("log_level", self.log_level)

        llm = data.get("llm", {})
        self.llm_provider = llm.get("provider", self.llm_provider)
        self.llm_model = llm.get("model", self.llm_model)
        self.max_llm_tokens = llm.get("max_tokens", self.max_llm_tokens)

        school = data.get("school", {})
        self.school_enabled = school.get("enabled", self.school_enabled)
        self.school_url = school.get("url", self.school_url)
        self.school_cycle_delay = school.get("cycle_delay", self.school_cycle_delay)

        reporting = data.get("reporting", {})
        self.phone_home = reporting.get("phone_home", self.phone_home)
        self.peerzero_app_url = reporting.get("peerzero_app_url", self.peerzero_app_url)

        memory = data.get("memory", {})
        self.memory_backend = memory.get("backend", self.memory_backend)
        self.memory_path = memory.get("path", self.memory_path)

        security = data.get("security", {})
        self.audit_log = security.get("audit_log", self.audit_log)

        # Platform configs
        platforms = data.get("platforms", {})
        for name, pconf in platforms.items():
            self.platforms.append(PlatformConfig(
                name=name,
                enabled=pconf.get("enabled", True),
                adapter=pconf.get("adapter", "a2a"),
                url=pconf.get("url", ""),
                agent_card_url=pconf.get("agent_card_url", ""),
                heartbeat_interval=pconf.get("heartbeat_interval", 3600),
                events=pconf.get("events", []),
            ))

    def _apply_env(self):
        """Apply environment variable overrides. Secrets ONLY come from here."""
        # Secrets
        self.school_api_key = os.environ.get("PEERZERO_API_KEY", self.school_api_key)
        self.llm_api_key = os.environ.get("LLM_API_KEY", self.llm_api_key)
        self.peerzero_app_token = os.environ.get("PEERZERO_APP_TOKEN", self.peerzero_app_token)

        # Platform-specific keys from env: MOLTBOOK_API_KEY, DEBATE_API_KEY, etc.
        for platform in self.platforms:
            env_key = f"{platform.name.upper()}_API_KEY"
            platform_key = os.environ.get(env_key, "")
            if platform_key:
                # Store on the platform config (not in TOML)
                platform._api_key = platform_key
            elif not hasattr(platform, '_api_key'):
                platform._api_key = ""

            # Webhook secret from env: MOLTBOOK_WEBHOOK_SECRET, etc.
            secret_key = f"{platform.name.upper()}_WEBHOOK_SECRET"
            webhook_secret = os.environ.get(secret_key, "")
            if webhook_secret:
                platform.webhook_secret = webhook_secret

        # Non-secret overrides
        if os.environ.get("LLM_PROVIDER"):
            self.llm_provider = os.environ["LLM_PROVIDER"].lower()
        if os.environ.get("LLM_MODEL"):
            self.llm_model = os.environ["LLM_MODEL"]
        if os.environ.get("PEERZERO_URL"):
            self.school_url = os.environ["PEERZERO_URL"]
        if os.environ.get("CYCLE_DELAY"):
            self.cycle_delay = int(os.environ["CYCLE_DELAY"])
        if os.environ.get("MAX_CYCLES"):
            self.max_cycles = int(os.environ["MAX_CYCLES"])
        if os.environ.get("MEMORY_DIR"):
            self.memory_path = os.environ["MEMORY_DIR"]
        if os.environ.get("LOG_LEVEL"):
            self.log_level = os.environ["LOG_LEVEL"].upper()

    def validate(self) -> list[str]:
        """Validate config. Returns list of errors (empty = valid)."""
        errors = []

        if self.school_enabled:
            if not self.school_api_key:
                errors.append("PEERZERO_API_KEY is required when school is enabled")
            elif not validate_peerzero_key(self.school_api_key):
                errors.append("PEERZERO_API_KEY format invalid (expected pz_ + 64 hex chars)")

            if not self.school_url.startswith("https://"):
                if not (self.school_url.startswith("http://localhost") or
                        self.school_url.startswith("http://127.0.0.1")):
                    errors.append(f"School URL must use HTTPS (or localhost for dev)")

        if not self.llm_api_key:
            errors.append("LLM_API_KEY is required")
        elif not validate_llm_key(self.llm_api_key, self.llm_provider):
            errors.append(f"LLM_API_KEY format looks wrong for provider '{self.llm_provider}'")

        if self.llm_provider not in ("anthropic", "openai"):
            errors.append(f"LLM provider must be 'anthropic' or 'openai', got '{self.llm_provider}'")

        # Set defaults
        if not self.llm_model:
            self.llm_model = (
                "claude-sonnet-4-20250514" if self.llm_provider == "anthropic"
                else "gpt-4o"
            )

        if not self.memory_path:
            key = self.school_api_key or "default"
            key_hash = hashlib.sha256(key.encode()).hexdigest()[:12]
            self.memory_path = str(Path.home() / ".peerzero-bot" / key_hash)

        for platform in self.platforms:
            if platform.enabled and not platform.url:
                errors.append(f"Platform '{platform.name}' is enabled but has no URL")

        return errors

    def ensure_directories(self):
        """Create memory and audit directories with restricted permissions."""
        mem_path = Path(self.memory_path)
        mem_path.mkdir(parents=True, exist_ok=True)
        mem_path.chmod(stat.S_IRWXU)

        if self.audit_log:
            audit_path = mem_path / "audit"
            audit_path.mkdir(parents=True, exist_ok=True)
            audit_path.chmod(stat.S_IRWXU)

    def get_key_fingerprint(self, key_type: str = "school") -> str:
        """Safe fingerprint for logging (first 6 + last 4). NEVER log full key."""
        if key_type == "school":
            key = self.school_api_key
        elif key_type == "llm":
            key = self.llm_api_key
        elif key_type == "app":
            key = self.peerzero_app_token
        else:
            key = ""
        if len(key) < 12:
            return "***not-set***"
        return f"{key[:6]}...{key[-4:]}"
