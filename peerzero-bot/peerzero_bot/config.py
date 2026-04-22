"""
Configuration — TOML file + environment variable loading.

Security principles:
  - API keys ONLY from environment variables, NEVER from config files
  - Config files are safe to commit to version control
  - Keys are validated before use to prevent cross-provider leaks
"""

import hmac as _hmac_mod
import os
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
class MCPServerConfig:
    """Configuration for a single MCP server within a platform."""
    name: str
    command: str = ""                 # e.g., "npx @anthropic/mcp-server-brave-search"
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    transport: str = "stdio"          # "stdio" or "streamable-http"
    url: str = ""                     # for streamable-http transport


@dataclass
class PlatformConfig:
    """Configuration for a single external platform."""
    name: str
    enabled: bool = True
    adapter: str = "a2a"              # "a2a", "webhook", "mcp"
    url: str = ""
    agent_card_url: str = ""          # for A2A discovery
    heartbeat_interval: int = 3600    # seconds between platform cycles
    events: list[str] = field(default_factory=list)  # for webhook adapter
    webhook_secret: str = ""          # HMAC-SHA256 secret for verifying incoming webhooks
    api_key: str = ""                 # Set from environment variables in _apply_env()
    # MCP-specific settings
    mcp_servers: list[MCPServerConfig] = field(default_factory=list)
    mcp_defer_loading: bool = False   # Use deferred tool loading to save context
    mcp_max_tools: int = 50           # Max tools to include in LLM context


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

    # ── Fast LLM (optional — for utility tasks like condensation, platform actions) ──
    llm_fast_provider: str = ""   # defaults to llm_provider if empty
    llm_fast_model: str = ""      # defaults to llm_model if empty (no cost savings)
    llm_fast_api_key: str = ""    # defaults to llm_api_key if empty (same key usually works)

    # ── Mode ─────────────────────────────────────────────────────────────
    #   "school"  — artifact-only training (papers, reviews, bounties).
    #               No platform interactions, no bot-to-bot coordination.
    #   "shipped" — deployed mode (platform cycles, A2A task coordination).
    #               Can still refresh identity from school.
    # Bots can switch freely between modes at any time.
    mode: str = "school"

    # ── Tasks (shipped mode only) ────────────────────────────────────────
    task_inbox_enabled: bool = True       # accept incoming tasks from other agents
    task_timeout_seconds: int = 300       # max time to process a single task
    task_max_concurrent: int = 3          # max tasks processed per cycle

    # ── School ────────────────────────────────────────────────────────────
    school_url: str = "https://peerzero.science"
    school_api_key: str = ""
    school_type: str = "science"      # which school type (science, politics, comedy, etc.)
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
    memory_hmac_key: str = ""         # HMAC-SHA256 key for memory integrity checks
                                      # If empty, derived from PEERZERO_API_KEY

    # ── General ───────────────────────────────────────────────────────────
    cycle_delay: int = 120
    max_cycles: int = 0               # 0 = unlimited
    daily_token_budget: int = 500000  # pause when daily tokens exceed this; set 0 to disable the cap
    log_level: str = "INFO"
    identity_refresh_interval: int = 10  # refresh identity every N school cycles
    memory_wipe_interval: int = 0     # 0 = disabled; N > 0 = wipe exercises + paragraphs every N cycles
                                      # (for A/B testing: isolate school coaching from memory accumulation)

    # ── LLM Proxy ────────────────────────────────────────────────────────
    # Routes all LLM calls through PeerZero's proxy, which injects the
    # identity activation preamble server-side. The preamble never
    # touches the user's machine when this is enabled.
    #
    # TRUST DEPENDENCY: This hardcoded default URL is a security-critical
    # trust anchor. All LLM API calls (including credentials) flow through
    # this proxy when llm_proxy_enabled=True. Changing this URL redirects
    # all LLM traffic. Override via LLM_PROXY_URL env var if needed.
    llm_proxy_url: str = "https://peerzero-llm-proxy.peerzero.workers.dev"
    llm_proxy_enabled: bool = True
    llm_proxy_key: str = ""  # From PEERZERO_PROXY_KEY env var

    # ── Conversational Memory ────────────────────────────────────────────
    # Graph-based relational memory for shipped bots talking to users.
    # Creates per-user SQLite databases with associative memory graphs.
    conversational_memory_enabled: bool = True  # enable for shipped mode conversation
    conversational_memory_path: str = ""        # base dir for per-user DBs (default: memory_path/conversations)
    conversational_memory_encryption_key: str = ""  # from CONVERSATIONAL_MEMORY_KEY env var
    # When True, conversation turns can call MCP tools mid-reply. Tools are
    # aggregated across all configured MCP adapters. The conversational memory
    # injection stays pinned as system prompt across every tool call, so
    # felt_portrait of the user remains in attention for the whole trajectory.
    conversation_tool_use_enabled: bool = True
    # Soft cap on tokens per conversation turn. Exceeding this logs a warning
    # (operators can alert on the warn-rate for abusive conversations) but
    # doesn't abort mid-turn since the tool loop already committed. The
    # daily_token_budget above is the hard cap; this surfaces single-turn
    # outliers below that threshold. 0 disables the warning.
    conversation_turn_token_cap: int = 30000

    # ── Security ──────────────────────────────────────────────────────────
    audit_log: bool = True

    # ── Autonomy ─────────────────────────────────────────────────────────
    autonomy_level: str = "guided"                  # "supervised", "guided", "autonomous"
    autonomy_allowed_actions: list[str] = field(default_factory=list)
    autonomy_blocked_actions: list[str] = field(default_factory=list)
    autonomy_allowed_platforms: list[str] = field(default_factory=list)
    autonomy_blocked_platforms: list[str] = field(default_factory=list)
    autonomy_allowed_tools: list[str] = field(default_factory=list)
    autonomy_blocked_tools: list[str] = field(default_factory=list)
    autonomy_max_actions_per_cycle: int = 10
    autonomy_max_tool_calls_per_cycle: int = 5
    autonomy_max_content_length: int = 10000
    autonomy_blocked_content_patterns: list[str] = field(default_factory=list)
    autonomy_can_submit_papers: bool = True
    autonomy_can_submit_reviews: bool = True
    autonomy_can_file_bounties: bool = True
    autonomy_can_revise_papers: bool = True

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
            # Warn if config file is world-readable (could leak settings)
            config._check_file_permissions(toml_path)
            with open(toml_path, "rb") as f:
                toml_data = tomllib.load(f)
            config._apply_toml(toml_data)

        # Step 2: Environment variables override everything
        config._apply_env()

        return config

    @staticmethod
    def _check_file_permissions(path: Path):
        """Refuse to load world-readable config files unless explicitly allowed.

        Config files may contain non-secret settings (URLs, platform names, etc.)
        that could still leak architectural details. Refuse to load unless the
        operator explicitly sets PEERZERO_ALLOW_INSECURE_CONFIG=1.
        """
        try:
            mode = path.stat().st_mode
        except OSError as e:
            logger.warning(f"Cannot check config file permissions for {path}: {e}")
            return
        if mode & stat.S_IRGRP or mode & stat.S_IROTH:
            if os.environ.get("PEERZERO_ALLOW_INSECURE_CONFIG") == "1":
                logger.warning(
                    f"Config file {path} is readable by group/others (mode {oct(mode)}). "
                    f"Proceeding because PEERZERO_ALLOW_INSECURE_CONFIG=1 is set. "
                    f"Consider restricting: chmod 600 {path}"
                )
            else:
                raise PermissionError(
                    f"Config file {path} is readable by group/others (mode {oct(mode)}). "
                    f"Refusing to load — fix with: chmod 600 {path}\n"
                    f"To override, set PEERZERO_ALLOW_INSECURE_CONFIG=1"
                )

    def _apply_toml(self, data: dict):
        """Apply TOML config (non-secret settings only)."""
        bot = data.get("bot", {})
        self.handle = bot.get("handle", self.handle)
        self.cycle_delay = bot.get("cycle_delay", self.cycle_delay)
        self.max_cycles = bot.get("max_cycles", self.max_cycles)
        self.daily_token_budget = bot.get("daily_token_budget", self.daily_token_budget)
        self.log_level = bot.get("log_level", self.log_level)
        self.identity_refresh_interval = bot.get("identity_refresh_interval", self.identity_refresh_interval)
        self.memory_wipe_interval = bot.get("memory_wipe_interval", self.memory_wipe_interval)

        llm = data.get("llm", {})
        self.llm_provider = llm.get("provider", self.llm_provider)
        self.llm_model = llm.get("model", self.llm_model)
        self.max_llm_tokens = llm.get("max_tokens", self.max_llm_tokens)

        # [llm.fast] — optional fast model for utility tasks
        fast = llm.get("fast", {})
        self.llm_fast_provider = fast.get("provider", self.llm_fast_provider)
        self.llm_fast_model = fast.get("model", self.llm_fast_model)

        # Mode — top-level [bot] or [school]
        bot_mode = bot.get("mode", "")
        school = data.get("school", {})
        if bot_mode:
            self.mode = bot_mode
        elif "enabled" in school:
            # Backward compat: school.enabled = false → mode = "shipped"
            self.mode = "school" if school["enabled"] else "shipped"
        self.school_url = school.get("url", self.school_url)
        self.school_type = school.get("type", self.school_type)
        self.school_cycle_delay = school.get("cycle_delay", self.school_cycle_delay)

        reporting = data.get("reporting", {})
        self.phone_home = reporting.get("phone_home", self.phone_home)
        self.peerzero_app_url = reporting.get("peerzero_app_url", self.peerzero_app_url)

        # LLM Proxy
        proxy = data.get("llm", {}).get("proxy", {})
        self.llm_proxy_url = proxy.get("url", self.llm_proxy_url)
        if "enabled" in proxy:
            self.llm_proxy_enabled = bool(proxy["enabled"])

        memory = data.get("memory", {})
        self.memory_backend = memory.get("backend", self.memory_backend)
        self.memory_path = memory.get("path", self.memory_path)

        security = data.get("security", {})
        self.audit_log = security.get("audit_log", self.audit_log)

        # Autonomy config
        autonomy = data.get("autonomy", {})
        self.autonomy_level = autonomy.get("level", self.autonomy_level)
        self.autonomy_allowed_actions = autonomy.get("allowed_actions", self.autonomy_allowed_actions)
        self.autonomy_blocked_actions = autonomy.get("blocked_actions", self.autonomy_blocked_actions)
        self.autonomy_allowed_platforms = autonomy.get("allowed_platforms", self.autonomy_allowed_platforms)
        self.autonomy_blocked_platforms = autonomy.get("blocked_platforms", self.autonomy_blocked_platforms)
        self.autonomy_allowed_tools = autonomy.get("allowed_tools", self.autonomy_allowed_tools)
        self.autonomy_blocked_tools = autonomy.get("blocked_tools", self.autonomy_blocked_tools)
        self.autonomy_max_actions_per_cycle = autonomy.get("max_actions_per_cycle", self.autonomy_max_actions_per_cycle)
        self.autonomy_max_tool_calls_per_cycle = autonomy.get("max_tool_calls_per_cycle", self.autonomy_max_tool_calls_per_cycle)
        self.autonomy_max_content_length = autonomy.get("max_content_length", self.autonomy_max_content_length)
        self.autonomy_blocked_content_patterns = autonomy.get("blocked_content_patterns", self.autonomy_blocked_content_patterns)
        self.autonomy_can_submit_papers = autonomy.get("can_submit_papers", self.autonomy_can_submit_papers)
        self.autonomy_can_submit_reviews = autonomy.get("can_submit_reviews", self.autonomy_can_submit_reviews)
        self.autonomy_can_file_bounties = autonomy.get("can_file_bounties", self.autonomy_can_file_bounties)
        self.autonomy_can_revise_papers = autonomy.get("can_revise_papers", self.autonomy_can_revise_papers)

        # Task coordination (shipped mode only)
        tasks = data.get("tasks", {})
        self.task_inbox_enabled = tasks.get("inbox_enabled", self.task_inbox_enabled)
        self.task_timeout_seconds = tasks.get("timeout_seconds", self.task_timeout_seconds)
        self.task_max_concurrent = tasks.get("max_concurrent", self.task_max_concurrent)

        # Platform configs
        platforms = data.get("platforms", {})
        for name, pconf in platforms.items():
            # Parse MCP servers if present
            mcp_servers = []
            for srv in pconf.get("mcp_servers", []):
                # SECURITY: Type-validate critical MCP config fields to prevent
                # type confusion that could lead to command injection or crashes.
                srv_command = srv.get("command", "")
                srv_args = srv.get("args", [])
                srv_env = srv.get("env", {})
                if not isinstance(srv_command, str):
                    logger.error(
                        f"MCP server '{srv.get('name', '?')}' command must be a string, "
                        f"got {type(srv_command).__name__} — skipping server"
                    )
                    continue
                if not isinstance(srv_args, list) or not all(isinstance(a, str) for a in srv_args):
                    logger.error(
                        f"MCP server '{srv.get('name', '?')}' args must be a list of strings — "
                        f"skipping server"
                    )
                    continue
                if not isinstance(srv_env, dict) or not all(
                    isinstance(k, str) and isinstance(v, str) for k, v in srv_env.items()
                ):
                    logger.error(
                        f"MCP server '{srv.get('name', '?')}' env must be a dict of strings — "
                        f"skipping server"
                    )
                    continue
                mcp_servers.append(MCPServerConfig(
                    name=srv.get("name", ""),
                    command=srv_command,
                    args=srv_args,
                    env=srv_env,
                    transport=srv.get("transport", "stdio"),
                    url=srv.get("url", ""),
                ))

            self.platforms.append(PlatformConfig(
                name=name,
                enabled=pconf.get("enabled", True),
                adapter=pconf.get("adapter", "a2a"),
                url=pconf.get("url", ""),
                agent_card_url=pconf.get("agent_card_url", ""),
                heartbeat_interval=pconf.get("heartbeat_interval", 3600),
                events=pconf.get("events", []),
                mcp_servers=mcp_servers,
                mcp_defer_loading=pconf.get("mcp_defer_loading", False),
                mcp_max_tools=pconf.get("mcp_max_tools", 50),
            ))

    def _apply_env(self):
        """Apply environment variable overrides. Secrets ONLY come from here."""
        # Secrets
        self.school_api_key = os.environ.get("PEERZERO_API_KEY", self.school_api_key)
        self.llm_api_key = os.environ.get("LLM_API_KEY", self.llm_api_key)
        self.llm_fast_api_key = os.environ.get("LLM_FAST_API_KEY", self.llm_fast_api_key)
        self.peerzero_app_token = os.environ.get("PEERZERO_APP_TOKEN", self.peerzero_app_token)
        self.llm_proxy_key = os.environ.get("PEERZERO_PROXY_KEY", self.llm_proxy_key)
        self.conversational_memory_encryption_key = os.environ.get(
            "CONVERSATIONAL_MEMORY_KEY", self.conversational_memory_encryption_key
        )

        # Platform-specific keys from env: MOLTBOOK_API_KEY, DEBATE_API_KEY, etc.
        for platform in self.platforms:
            env_key = f"{platform.name.upper()}_API_KEY"
            platform_key = os.environ.get(env_key, "")
            if platform_key:
                platform.api_key = platform_key

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
        if os.environ.get("LLM_FAST_PROVIDER"):
            self.llm_fast_provider = os.environ["LLM_FAST_PROVIDER"].lower()
        if os.environ.get("LLM_FAST_MODEL"):
            self.llm_fast_model = os.environ["LLM_FAST_MODEL"]
        if os.environ.get("BOT_MODE"):
            self.mode = os.environ["BOT_MODE"].lower()
        if os.environ.get("PEERZERO_URL"):
            self.school_url = os.environ["PEERZERO_URL"]
        if os.environ.get("CYCLE_DELAY"):
            try:
                self.cycle_delay = int(os.environ["CYCLE_DELAY"])
            except ValueError:
                logger.warning(f"CYCLE_DELAY is not a valid integer: {os.environ['CYCLE_DELAY']!r}, using default {self.cycle_delay}")
        if os.environ.get("MAX_CYCLES"):
            try:
                self.max_cycles = int(os.environ["MAX_CYCLES"])
            except ValueError:
                logger.warning(f"MAX_CYCLES is not a valid integer: {os.environ['MAX_CYCLES']!r}, using default {self.max_cycles}")
        if os.environ.get("DAILY_TOKEN_BUDGET"):
            try:
                self.daily_token_budget = int(os.environ["DAILY_TOKEN_BUDGET"])
            except ValueError:
                logger.warning(f"DAILY_TOKEN_BUDGET is not a valid integer: {os.environ['DAILY_TOKEN_BUDGET']!r}, using default {self.daily_token_budget}")
        if os.environ.get("MEMORY_DIR"):
            self.memory_path = os.environ["MEMORY_DIR"]
        if os.environ.get("MEMORY_HMAC_KEY"):
            self.memory_hmac_key = os.environ["MEMORY_HMAC_KEY"]
        if os.environ.get("LOG_LEVEL"):
            self.log_level = os.environ["LOG_LEVEL"].upper()
        if os.environ.get("MEMORY_WIPE_INTERVAL"):
            try:
                self.memory_wipe_interval = int(os.environ["MEMORY_WIPE_INTERVAL"])
            except ValueError:
                logger.warning(f"MEMORY_WIPE_INTERVAL is not a valid integer: {os.environ['MEMORY_WIPE_INTERVAL']!r}, using default {self.memory_wipe_interval}")
        if os.environ.get("LLM_PROXY_URL"):
            _ALLOWED_PROXY_HOSTS = {
                "peerzero-llm-proxy.peerzero.workers.dev",
            }
            # Allow localhost only when explicitly opted in for local development.
            # Without this gate, a local attacker could intercept LLM credentials.
            if os.environ.get("PZ_ALLOW_LOCAL_PROXY", "").lower() in ("true", "1"):
                _ALLOWED_PROXY_HOSTS |= {"localhost", "127.0.0.1"}
            from urllib.parse import urlparse as _urlparse
            _parsed = _urlparse(os.environ["LLM_PROXY_URL"])
            if _parsed.hostname not in _ALLOWED_PROXY_HOSTS:
                logger.warning(
                    f"LLM_PROXY_URL host '{_parsed.hostname}' is not in the allowed proxy "
                    f"hosts ({_ALLOWED_PROXY_HOSTS}). Ignoring override to prevent "
                    f"credential exfiltration. Set llm_proxy_url in code to add new hosts."
                )
            else:
                self.llm_proxy_url = os.environ["LLM_PROXY_URL"]
        if os.environ.get("LLM_PROXY_ENABLED") is not None:
            self.llm_proxy_enabled = os.environ.get("LLM_PROXY_ENABLED", "").lower() not in ("false", "0", "no")

    @property
    def school_enabled(self) -> bool:
        """Backward compat: True when mode is 'school'."""
        return self.mode == "school"

    @property
    def memory_hmac_key_bytes(self) -> bytes:
        """Return the HMAC key as bytes for memory integrity checks.

        If memory_hmac_key is set explicitly, use it directly.
        Otherwise, derive one from the PeerZero API key using HMAC-SHA256
        with a fixed domain separator.
        """
        if self.memory_hmac_key:
            return self.memory_hmac_key.encode("utf-8")
        # Derive from API key
        source = self.school_api_key or "peerzero-default"
        return _hmac_mod.new(
            source.encode("utf-8"),
            b"peerzero-memory-integrity",
            hashlib.sha256,
        ).digest()

    def validate(self) -> list[str]:
        """Validate config. Returns list of errors (empty = valid)."""
        # Set defaults before validation so validators see final values
        if not self.llm_model:
            self.llm_model = (
                "claude-sonnet-4-6" if self.llm_provider == "anthropic"
                else "gpt-4o"
            )

        if not self.memory_path:
            key = self.school_api_key or "default"
            key_hash = hashlib.sha256(key.encode()).hexdigest()[:12]
            self.memory_path = str(Path.home() / ".peerzero-bot" / key_hash)

        errors = []

        if self.mode not in ("school", "shipped"):
            errors.append(f"bot.mode must be 'school' or 'shipped', got '{self.mode}'")

        if self.mode == "school":
            if not self.school_api_key:
                errors.append("PEERZERO_API_KEY is required when school is enabled")
            elif not validate_peerzero_key(self.school_api_key):
                errors.append("PEERZERO_API_KEY format invalid (expected pz_ + 64 hex chars)")

            if not self.school_url.startswith("https://"):
                if not (self.school_url.startswith("http://localhost") or
                        self.school_url.startswith("http://127.0.0.1")):
                    errors.append(f"School URL must use HTTPS (or localhost for dev)")

            # CLAUDE.md rule 8: identity preamble is server-side and is injected
            # by the proxy on EVERY LLM call. Disabling the proxy in school mode
            # silently bypasses the preamble — the bot reasons without identity
            # activation, breaking the inhabitation mechanism that all school
            # cycles depend on. Fail loudly unless explicitly overridden.
            if not self.llm_proxy_enabled and not os.environ.get("PEERZERO_ALLOW_INSECURE_CONFIG"):
                errors.append(
                    "School mode requires llm_proxy_enabled=true so the identity "
                    "preamble reaches every LLM call. Disabling the proxy in school "
                    "mode silently breaks identity activation. To override (dev only) "
                    "set PEERZERO_ALLOW_INSECURE_CONFIG=1."
                )

        if not self.llm_api_key:
            errors.append("LLM_API_KEY is required")
        elif not validate_llm_key(self.llm_api_key, self.llm_provider):
            errors.append(f"LLM_API_KEY format looks wrong for provider '{self.llm_provider}'")

        if self.llm_provider not in ("anthropic", "openai"):
            errors.append(f"LLM provider must be 'anthropic' or 'openai', got '{self.llm_provider}'")

        for platform in self.platforms:
            if platform.enabled and not platform.url:
                errors.append(f"Platform '{platform.name}' is enabled but has no URL")

        return errors

    def ensure_directories(self):
        """Create memory and audit directories with restricted permissions.

        Always enforces 0o700 on the directories, even if they already exist,
        to correct permissions that may have been loosened externally.
        """
        mem_path = Path(self.memory_path)
        mem_path.mkdir(parents=True, exist_ok=True)
        # Always enforce owner-only access, even on pre-existing directories
        mem_path.chmod(stat.S_IRWXU)

        if self.audit_log:
            audit_path = mem_path / "audit"
            audit_path.mkdir(parents=True, exist_ok=True)
            # Always enforce owner-only access, even on pre-existing directories
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
