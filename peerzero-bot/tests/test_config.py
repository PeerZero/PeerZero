"""Tests for config.py — TOML + env loading, validation, defaults."""

import os
import stat
import hashlib
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from peerzero_bot.config import (
    BotConfig,
    PlatformConfig,
    MCPServerConfig,
    validate_peerzero_key,
    validate_llm_key,
)


# ── Key validation ───────────────────────────────────────────────────────────


class TestValidatePeerzeroKey:
    def test_valid_key(self):
        key = "pz_" + "a1b2c3d4" * 8  # 3 + 64 = 67 chars
        assert validate_peerzero_key(key) is True

    def test_empty_key(self):
        assert validate_peerzero_key("") is False

    def test_wrong_prefix(self):
        assert validate_peerzero_key("xx_" + "a" * 64) is False

    def test_too_short(self):
        assert validate_peerzero_key("pz_" + "a" * 10) is False

    def test_too_long(self):
        assert validate_peerzero_key("pz_" + "a" * 65) is False

    def test_non_hex_chars(self):
        assert validate_peerzero_key("pz_" + "g" * 64) is False

    def test_none_key(self):
        assert validate_peerzero_key(None) is False


class TestValidateLlmKey:
    def test_valid_anthropic_key(self):
        assert validate_llm_key("sk-ant-" + "x" * 30, "anthropic") is True

    def test_valid_openai_key(self):
        assert validate_llm_key("sk-" + "x" * 30, "openai") is True

    def test_too_short(self):
        assert validate_llm_key("short", "anthropic") is False

    def test_empty_key(self):
        assert validate_llm_key("", "anthropic") is False

    def test_peerzero_key_rejected(self):
        """A pz_ key should not be accepted as an LLM key."""
        assert validate_llm_key("pz_" + "a" * 64, "anthropic") is False

    def test_anthropic_wrong_prefix_still_valid_with_warning(self):
        """Non-standard prefix still returns True but logs a warning."""
        assert validate_llm_key("not-standard-" + "x" * 30, "anthropic") is True

    def test_openai_wrong_prefix_still_valid_with_warning(self):
        assert validate_llm_key("not-standard-" + "x" * 30, "openai") is True


# ── BotConfig defaults ───────────────────────────────────────────────────────


class TestBotConfigDefaults:
    def test_default_mode_is_school(self):
        config = BotConfig()
        assert config.mode == "school"

    def test_default_provider_is_anthropic(self):
        config = BotConfig()
        assert config.llm_provider == "anthropic"

    def test_default_school_url(self):
        config = BotConfig()
        assert config.school_url == "https://peerzero.science"

    def test_school_enabled_property(self):
        config = BotConfig(mode="school")
        assert config.school_enabled is True
        config.mode = "shipped"
        assert config.school_enabled is False

    def test_default_proxy_enabled(self):
        config = BotConfig()
        assert config.llm_proxy_enabled is True

    def test_default_audit_log_enabled(self):
        config = BotConfig()
        assert config.audit_log is True


# ── TOML loading ─────────────────────────────────────────────────────────────


class TestApplyToml:
    def test_basic_toml_fields(self):
        config = BotConfig()
        toml_data = {
            "bot": {
                "handle": "test-bot",
                "cycle_delay": 60,
                "max_cycles": 5,
                "log_level": "DEBUG",
                "identity_refresh_interval": 20,
                "memory_wipe_interval": 3,
            },
            "llm": {
                "provider": "openai",
                "model": "gpt-4o",
                "max_tokens": 4096,
            },
        }
        config._apply_toml(toml_data)
        assert config.handle == "test-bot"
        assert config.cycle_delay == 60
        assert config.max_cycles == 5
        assert config.log_level == "DEBUG"
        assert config.identity_refresh_interval == 20
        assert config.memory_wipe_interval == 3
        assert config.llm_provider == "openai"
        assert config.llm_model == "gpt-4o"
        assert config.max_llm_tokens == 4096

    def test_school_section(self):
        config = BotConfig()
        config._apply_toml({
            "school": {
                "url": "https://test.example.com",
                "type": "politics",
                "cycle_delay": 300,
            }
        })
        assert config.school_url == "https://test.example.com"
        assert config.school_type == "politics"
        assert config.school_cycle_delay == 300

    def test_bot_mode_from_toml(self):
        config = BotConfig()
        config._apply_toml({"bot": {"mode": "shipped"}})
        assert config.mode == "shipped"

    def test_school_enabled_false_sets_shipped(self):
        """Backward compat: school.enabled = false -> shipped mode."""
        config = BotConfig()
        config._apply_toml({"school": {"enabled": False}})
        assert config.mode == "shipped"

    def test_school_enabled_true_sets_school(self):
        config = BotConfig()
        config._apply_toml({"school": {"enabled": True}})
        assert config.mode == "school"

    def test_bot_mode_overrides_school_enabled(self):
        """Explicit bot.mode takes priority over school.enabled."""
        config = BotConfig()
        config._apply_toml({
            "bot": {"mode": "shipped"},
            "school": {"enabled": True},
        })
        assert config.mode == "shipped"

    def test_proxy_config(self):
        config = BotConfig()
        config._apply_toml({
            "llm": {
                "proxy": {
                    "url": "https://custom-proxy.example.com",
                    "enabled": False,
                }
            }
        })
        assert config.llm_proxy_url == "https://custom-proxy.example.com"
        assert config.llm_proxy_enabled is False

    def test_fast_llm_config(self):
        config = BotConfig()
        config._apply_toml({
            "llm": {
                "fast": {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                }
            }
        })
        assert config.llm_fast_provider == "openai"
        assert config.llm_fast_model == "gpt-4o-mini"

    def test_reporting_config(self):
        config = BotConfig()
        config._apply_toml({
            "reporting": {
                "phone_home": True,
                "peerzero_app_url": "https://custom.app",
            }
        })
        assert config.phone_home is True
        assert config.peerzero_app_url == "https://custom.app"

    def test_memory_config(self):
        config = BotConfig()
        config._apply_toml({
            "memory": {
                "backend": "sqlite",
                "path": "/tmp/test-memory",
            }
        })
        assert config.memory_backend == "sqlite"
        assert config.memory_path == "/tmp/test-memory"

    def test_autonomy_config(self):
        config = BotConfig()
        config._apply_toml({
            "autonomy": {
                "level": "autonomous",
                "allowed_actions": ["review", "paper"],
                "blocked_actions": ["bounty"],
                "can_submit_papers": False,
                "max_actions_per_cycle": 5,
            }
        })
        assert config.autonomy_level == "autonomous"
        assert config.autonomy_allowed_actions == ["review", "paper"]
        assert config.autonomy_blocked_actions == ["bounty"]
        assert config.autonomy_can_submit_papers is False
        assert config.autonomy_max_actions_per_cycle == 5

    def test_task_config(self):
        config = BotConfig()
        config._apply_toml({
            "tasks": {
                "inbox_enabled": False,
                "timeout_seconds": 600,
                "max_concurrent": 5,
            }
        })
        assert config.task_inbox_enabled is False
        assert config.task_timeout_seconds == 600
        assert config.task_max_concurrent == 5

    def test_platform_config_basic(self):
        config = BotConfig()
        config._apply_toml({
            "platforms": {
                "moltbook": {
                    "enabled": True,
                    "adapter": "webhook",
                    "url": "https://api.moltbook.com",
                    "heartbeat_interval": 1800,
                    "events": ["post_created"],
                }
            }
        })
        assert len(config.platforms) == 1
        p = config.platforms[0]
        assert p.name == "moltbook"
        assert p.adapter == "webhook"
        assert p.url == "https://api.moltbook.com"
        assert p.heartbeat_interval == 1800
        assert p.events == ["post_created"]

    def test_platform_mcp_servers_parsed(self):
        config = BotConfig()
        config._apply_toml({
            "platforms": {
                "test_platform": {
                    "url": "https://test.com",
                    "mcp_servers": [
                        {
                            "name": "brave-search",
                            "command": "npx",
                            "args": ["@anthropic/mcp-server-brave-search"],
                            "env": {"BRAVE_KEY": "test"},
                            "transport": "stdio",
                        }
                    ],
                    "mcp_defer_loading": True,
                    "mcp_max_tools": 25,
                }
            }
        })
        p = config.platforms[0]
        assert len(p.mcp_servers) == 1
        srv = p.mcp_servers[0]
        assert srv.name == "brave-search"
        assert srv.command == "npx"
        assert srv.args == ["@anthropic/mcp-server-brave-search"]
        assert srv.env == {"BRAVE_KEY": "test"}
        assert p.mcp_defer_loading is True
        assert p.mcp_max_tools == 25

    def test_mcp_server_invalid_command_type_skipped(self):
        config = BotConfig()
        config._apply_toml({
            "platforms": {
                "bad": {
                    "url": "https://test.com",
                    "mcp_servers": [
                        {"name": "bad-srv", "command": 123, "args": [], "env": {}},
                    ],
                }
            }
        })
        p = config.platforms[0]
        assert len(p.mcp_servers) == 0

    def test_mcp_server_invalid_args_type_skipped(self):
        config = BotConfig()
        config._apply_toml({
            "platforms": {
                "bad": {
                    "url": "https://test.com",
                    "mcp_servers": [
                        {"name": "bad-srv", "command": "npx", "args": "not-a-list", "env": {}},
                    ],
                }
            }
        })
        p = config.platforms[0]
        assert len(p.mcp_servers) == 0

    def test_mcp_server_invalid_env_type_skipped(self):
        config = BotConfig()
        config._apply_toml({
            "platforms": {
                "bad": {
                    "url": "https://test.com",
                    "mcp_servers": [
                        {"name": "bad-srv", "command": "npx", "args": [], "env": {"k": 123}},
                    ],
                }
            }
        })
        p = config.platforms[0]
        assert len(p.mcp_servers) == 0


# ── Environment variable overrides ──────────────────────────────────────────


class TestApplyEnv:
    def test_secrets_from_env(self):
        config = BotConfig()
        env = {
            "PEERZERO_API_KEY": "pz_" + "a" * 64,
            "LLM_API_KEY": "sk-ant-" + "b" * 30,
            "PEERZERO_APP_TOKEN": "tok_test",
            "LLM_FAST_API_KEY": "sk-fast",
            "PEERZERO_PROXY_KEY": "proxy-key-123",
        }
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.school_api_key == "pz_" + "a" * 64
        assert config.llm_api_key == "sk-ant-" + "b" * 30
        assert config.peerzero_app_token == "tok_test"
        assert config.llm_fast_api_key == "sk-fast"
        assert config.llm_proxy_key == "proxy-key-123"

    def test_non_secret_overrides(self):
        config = BotConfig()
        env = {
            "LLM_PROVIDER": "OpenAI",
            "LLM_MODEL": "gpt-4o",
            "LLM_FAST_PROVIDER": "OpenAI",
            "LLM_FAST_MODEL": "gpt-4o-mini",
            "BOT_MODE": "Shipped",
            "PEERZERO_URL": "https://custom.school",
            "CYCLE_DELAY": "30",
            "MAX_CYCLES": "10",
            "MEMORY_DIR": "/tmp/mem",
            "MEMORY_HMAC_KEY": "test-hmac",
            "LOG_LEVEL": "debug",
            "MEMORY_WIPE_INTERVAL": "5",
        }
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.llm_provider == "openai"
        assert config.llm_model == "gpt-4o"
        assert config.llm_fast_provider == "openai"
        assert config.llm_fast_model == "gpt-4o-mini"
        assert config.mode == "shipped"
        assert config.school_url == "https://custom.school"
        assert config.cycle_delay == 30
        assert config.max_cycles == 10
        assert config.memory_path == "/tmp/mem"
        assert config.memory_hmac_key == "test-hmac"
        assert config.log_level == "DEBUG"
        assert config.memory_wipe_interval == 5

    def test_invalid_cycle_delay_keeps_default(self):
        config = BotConfig()
        with patch.dict(os.environ, {"CYCLE_DELAY": "not-a-number"}, clear=False):
            config._apply_env()
        assert config.cycle_delay == 120  # default

    def test_invalid_max_cycles_keeps_default(self):
        config = BotConfig()
        with patch.dict(os.environ, {"MAX_CYCLES": "abc"}, clear=False):
            config._apply_env()
        assert config.max_cycles == 0

    def test_invalid_memory_wipe_interval_keeps_default(self):
        config = BotConfig()
        with patch.dict(os.environ, {"MEMORY_WIPE_INTERVAL": "xyz"}, clear=False):
            config._apply_env()
        assert config.memory_wipe_interval == 0

    def test_platform_keys_from_env(self):
        config = BotConfig()
        config.platforms = [PlatformConfig(name="moltbook", url="https://api.moltbook.com")]
        env = {
            "MOLTBOOK_API_KEY": "moltbook-secret-key",
            "MOLTBOOK_WEBHOOK_SECRET": "wh-secret",
        }
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.platforms[0].api_key == "moltbook-secret-key"
        assert config.platforms[0].webhook_secret == "wh-secret"

    def test_proxy_url_allowed_host(self):
        config = BotConfig()
        env = {"LLM_PROXY_URL": "https://peerzero-llm-proxy.peerzero.workers.dev/v1"}
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert "peerzero.workers.dev" in config.llm_proxy_url

    def test_proxy_url_blocked_host(self):
        config = BotConfig()
        original_url = config.llm_proxy_url
        env = {"LLM_PROXY_URL": "https://evil.com/steal"}
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.llm_proxy_url == original_url  # unchanged

    def test_proxy_url_localhost_blocked_by_default(self):
        config = BotConfig()
        original_url = config.llm_proxy_url
        env = {"LLM_PROXY_URL": "http://localhost:8080"}
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.llm_proxy_url == original_url

    def test_proxy_url_localhost_allowed_with_flag(self):
        config = BotConfig()
        env = {
            "LLM_PROXY_URL": "http://localhost:8080",
            "PZ_ALLOW_LOCAL_PROXY": "true",
        }
        with patch.dict(os.environ, env, clear=False):
            config._apply_env()
        assert config.llm_proxy_url == "http://localhost:8080"

    def test_proxy_enabled_false(self):
        config = BotConfig()
        with patch.dict(os.environ, {"LLM_PROXY_ENABLED": "false"}, clear=False):
            config._apply_env()
        assert config.llm_proxy_enabled is False

    def test_proxy_enabled_zero(self):
        config = BotConfig()
        with patch.dict(os.environ, {"LLM_PROXY_ENABLED": "0"}, clear=False):
            config._apply_env()
        assert config.llm_proxy_enabled is False

    def test_proxy_enabled_true(self):
        config = BotConfig()
        config.llm_proxy_enabled = False
        with patch.dict(os.environ, {"LLM_PROXY_ENABLED": "true"}, clear=False):
            config._apply_env()
        assert config.llm_proxy_enabled is True


# ── Validation ───────────────────────────────────────────────────────────────


class TestValidation:
    def _valid_config(self, **overrides):
        defaults = {
            "mode": "school",
            "school_api_key": "pz_" + "a1b2c3d4" * 8,
            "llm_api_key": "sk-ant-" + "x" * 30,
            "llm_provider": "anthropic",
            "school_url": "https://peerzero.science",
        }
        defaults.update(overrides)
        return BotConfig(**defaults)

    def test_valid_config_no_errors(self):
        config = self._valid_config()
        assert config.validate() == []

    def test_invalid_mode(self):
        config = self._valid_config(mode="invalid")
        errors = config.validate()
        assert any("mode" in e for e in errors)

    def test_missing_school_api_key(self):
        config = self._valid_config(school_api_key="")
        errors = config.validate()
        assert any("PEERZERO_API_KEY" in e for e in errors)

    def test_invalid_school_api_key_format(self):
        config = self._valid_config(school_api_key="bad-key")
        errors = config.validate()
        assert any("format invalid" in e for e in errors)

    def test_school_url_must_be_https(self):
        config = self._valid_config(school_url="http://insecure.example.com")
        errors = config.validate()
        assert any("HTTPS" in e for e in errors)

    def test_school_url_localhost_allowed(self):
        config = self._valid_config(school_url="http://localhost:3000")
        errors = config.validate()
        assert not any("HTTPS" in e for e in errors)

    def test_school_url_127_allowed(self):
        config = self._valid_config(school_url="http://127.0.0.1:3000")
        errors = config.validate()
        assert not any("HTTPS" in e for e in errors)

    def test_missing_llm_api_key(self):
        config = self._valid_config(llm_api_key="")
        errors = config.validate()
        assert any("LLM_API_KEY" in e for e in errors)

    def test_invalid_llm_provider(self):
        config = self._valid_config(llm_provider="gemini")
        errors = config.validate()
        assert any("provider" in e for e in errors)

    def test_shipped_mode_no_school_key_required(self):
        config = self._valid_config(mode="shipped", school_api_key="")
        errors = config.validate()
        assert not any("PEERZERO_API_KEY" in e for e in errors)

    def test_platform_enabled_without_url(self):
        config = self._valid_config()
        config.platforms = [PlatformConfig(name="bad", enabled=True, url="")]
        errors = config.validate()
        assert any("bad" in e and "URL" in e for e in errors)

    def test_platform_disabled_without_url_ok(self):
        config = self._valid_config()
        config.platforms = [PlatformConfig(name="ok", enabled=False, url="")]
        errors = config.validate()
        assert not any("ok" in e for e in errors)

    def test_validate_sets_default_model_anthropic(self):
        config = self._valid_config(llm_model="")
        config.validate()
        assert config.llm_model == "claude-sonnet-4-6"

    def test_validate_sets_default_model_openai(self):
        config = self._valid_config(llm_model="", llm_provider="openai")
        config.validate()
        assert config.llm_model == "gpt-4o"

    def test_validate_sets_default_memory_path(self):
        config = self._valid_config(memory_path="")
        config.validate()
        assert ".peerzero-bot" in config.memory_path


# ── Memory HMAC key ──────────────────────────────────────────────────────────


class TestMemoryHmacKey:
    def test_explicit_hmac_key(self):
        config = BotConfig(memory_hmac_key="my-explicit-key")
        assert config.memory_hmac_key_bytes == b"my-explicit-key"

    def test_derived_hmac_key_from_api_key(self):
        config = BotConfig(school_api_key="pz_" + "a" * 64)
        key_bytes = config.memory_hmac_key_bytes
        assert isinstance(key_bytes, bytes)
        assert len(key_bytes) == 32  # SHA-256 output

    def test_derived_hmac_key_without_api_key(self):
        config = BotConfig(school_api_key="")
        key_bytes = config.memory_hmac_key_bytes
        assert isinstance(key_bytes, bytes)
        assert len(key_bytes) == 32


# ── Key fingerprints ─────────────────────────────────────────────────────────


class TestGetKeyFingerprint:
    def test_school_fingerprint(self):
        config = BotConfig(school_api_key="pz_" + "a" * 64)
        fp = config.get_key_fingerprint("school")
        assert fp.startswith("pz_aaa")
        assert fp.endswith("aaaa")
        assert "..." in fp

    def test_short_key_returns_placeholder(self):
        config = BotConfig(school_api_key="short")
        assert config.get_key_fingerprint("school") == "***not-set***"

    def test_llm_fingerprint(self):
        config = BotConfig(llm_api_key="sk-ant-" + "x" * 30)
        fp = config.get_key_fingerprint("llm")
        assert "..." in fp

    def test_app_fingerprint(self):
        config = BotConfig(peerzero_app_token="tok_" + "z" * 30)
        fp = config.get_key_fingerprint("app")
        assert "..." in fp

    def test_unknown_key_type(self):
        config = BotConfig()
        assert config.get_key_fingerprint("unknown") == "***not-set***"


# ── File permissions ─────────────────────────────────────────────────────────


class TestFilePermissions:
    def test_world_readable_raises(self, tmp_path):
        config_file = tmp_path / "test.toml"
        config_file.write_text("[bot]\nhandle = 'test'\n")
        config_file.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        with pytest.raises(PermissionError, match="readable by group"):
            BotConfig._check_file_permissions(config_file)

    def test_world_readable_allowed_with_env(self, tmp_path):
        config_file = tmp_path / "test.toml"
        config_file.write_text("[bot]\nhandle = 'test'\n")
        config_file.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        with patch.dict(os.environ, {"PEERZERO_ALLOW_INSECURE_CONFIG": "1"}):
            BotConfig._check_file_permissions(config_file)  # should not raise

    def test_owner_only_passes(self, tmp_path):
        config_file = tmp_path / "test.toml"
        config_file.write_text("[bot]\nhandle = 'test'\n")
        config_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        BotConfig._check_file_permissions(config_file)  # should not raise


# ── Load integration ─────────────────────────────────────────────────────────


class TestLoad:
    def test_load_with_no_toml_file(self):
        """Load should work even without a TOML file."""
        env = {
            "PEERZERO_API_KEY": "pz_" + "a" * 64,
            "LLM_API_KEY": "sk-ant-" + "x" * 30,
        }
        with patch.dict(os.environ, env, clear=False):
            config = BotConfig.load("/nonexistent/path.toml")
        assert config.school_api_key == "pz_" + "a" * 64

    def test_load_with_toml_file(self, tmp_path):
        config_file = tmp_path / "bot.toml"
        config_file.write_text('[bot]\nhandle = "loaded-bot"\n')
        config_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        env = {
            "PEERZERO_API_KEY": "pz_" + "a" * 64,
            "LLM_API_KEY": "sk-ant-" + "x" * 30,
        }
        with patch.dict(os.environ, env, clear=False):
            config = BotConfig.load(str(config_file))
        assert config.handle == "loaded-bot"


# ── ensure_directories ───────────────────────────────────────────────────────


class TestEnsureDirectories:
    def test_creates_memory_dir(self, tmp_path):
        mem_path = tmp_path / "memory"
        config = BotConfig(memory_path=str(mem_path), audit_log=False)
        config.ensure_directories()
        assert mem_path.exists()
        assert mem_path.stat().st_mode & 0o777 == 0o700

    def test_creates_audit_dir(self, tmp_path):
        mem_path = tmp_path / "memory"
        config = BotConfig(memory_path=str(mem_path), audit_log=True)
        config.ensure_directories()
        audit_path = mem_path / "audit"
        assert audit_path.exists()
        assert audit_path.stat().st_mode & 0o777 == 0o700

    def test_no_audit_dir_when_disabled(self, tmp_path):
        mem_path = tmp_path / "memory"
        config = BotConfig(memory_path=str(mem_path), audit_log=False)
        config.ensure_directories()
        assert not (mem_path / "audit").exists()
