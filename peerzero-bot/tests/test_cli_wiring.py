"""Tests for CLI _build_bot() — verifies all components are wired correctly."""

import tempfile
import pytest

from peerzero_bot.config import BotConfig, PlatformConfig, MCPServerConfig
from peerzero_bot.cli import _build_bot
from peerzero_bot.agent import PeerZeroBot
from peerzero_bot.adapters.a2a import A2AAdapter
from peerzero_bot.adapters.webhook import WebhookAdapter
from peerzero_bot.adapters.mcp import MCPAdapter
from peerzero_bot.autonomy import AutonomyGate


@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


def _make_config(tmp_dir: str, **overrides) -> BotConfig:
    """Create a minimal valid BotConfig for testing."""
    config = BotConfig(
        handle="test-bot",
        llm_provider="anthropic",
        llm_model="claude-sonnet-4-6",
        llm_api_key="sk-ant-test-key-placeholder-0000000000",
        mode="shipped",  # disable school to avoid network calls
        memory_path=tmp_dir,
        memory_backend="file",
        audit_log=True,
    )
    for key, val in overrides.items():
        setattr(config, key, val)
    return config


class TestBuildBot:
    """Verify _build_bot() correctly assembles the PeerZeroBot."""

    def test_returns_peerzero_bot(self, tmp_dir):
        config = _make_config(tmp_dir)
        bot = _build_bot(config)
        assert isinstance(bot, PeerZeroBot)

    def test_autonomy_gate_is_wired(self, tmp_dir):
        """AutonomyGate must be created and passed to the bot."""
        config = _make_config(tmp_dir, autonomy_level="supervised")
        bot = _build_bot(config)
        assert bot.autonomy_gate is not None
        assert isinstance(bot.autonomy_gate, AutonomyGate)
        assert bot.autonomy_gate.policy.level == "supervised"

    def test_autonomy_gate_default_level(self, tmp_dir):
        config = _make_config(tmp_dir)
        bot = _build_bot(config)
        assert bot.autonomy_gate.policy.level == "guided"

    def test_autonomy_policy_settings_propagate(self, tmp_dir):
        """All autonomy config fields should reach the policy."""
        config = _make_config(
            tmp_dir,
            autonomy_level="autonomous",
            autonomy_blocked_actions=["delete"],
            autonomy_allowed_platforms=["moltbook"],
            autonomy_max_actions_per_cycle=3,
            autonomy_can_file_bounties=False,
        )
        bot = _build_bot(config)
        policy = bot.autonomy_gate.policy
        assert policy.level == "autonomous"
        assert policy.blocked_actions == ["delete"]
        assert policy.allowed_platforms == ["moltbook"]
        assert policy.max_actions_per_cycle == 3
        assert policy.can_file_bounties is False

    def test_a2a_adapter_wired(self, tmp_dir):
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(
                name="testplatform",
                enabled=True,
                adapter="a2a",
                url="https://api.testplatform.com",
                agent_card_url="https://api.testplatform.com/.well-known/agent-card.json",
            ),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 1
        assert isinstance(bot.platform_adapters[0], A2AAdapter)
        assert bot.platform_adapters[0].platform_name == "testplatform"

    def test_webhook_adapter_wired(self, tmp_dir):
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(
                name="webhooksite",
                enabled=True,
                adapter="webhook",
                url="https://api.webhooksite.com",
                events=["post", "comment"],
            ),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 1
        assert isinstance(bot.platform_adapters[0], WebhookAdapter)

    def test_mcp_adapter_wired(self, tmp_dir):
        """MCP adapter should be created from config."""
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(
                name="research",
                enabled=True,
                adapter="mcp",
                url="",
                mcp_servers=[
                    MCPServerConfig(
                        name="brave-search",
                        command="echo test",
                    ),
                ],
                mcp_defer_loading=True,
                mcp_max_tools=25,
            ),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 1
        assert isinstance(bot.platform_adapters[0], MCPAdapter)
        assert bot.platform_adapters[0].platform_name == "research"

    def test_disabled_platform_skipped(self, tmp_dir):
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(
                name="disabled",
                enabled=False,
                adapter="a2a",
                url="https://api.disabled.com",
            ),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 0

    def test_unknown_adapter_skipped(self, tmp_dir):
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(
                name="unknown",
                enabled=True,
                adapter="carrier_pigeon",
                url="https://api.pigeons.com",
            ),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 0

    def test_mixed_platforms(self, tmp_dir):
        """Multiple platform types should all be wired correctly."""
        config = _make_config(tmp_dir, platforms=[
            PlatformConfig(name="p1", enabled=True, adapter="a2a", url="https://a.com"),
            PlatformConfig(name="p2", enabled=True, adapter="webhook", url="https://b.com", events=["post"]),
            PlatformConfig(name="p3", enabled=True, adapter="mcp", url="", mcp_servers=[
                MCPServerConfig(name="srv", command="echo"),
            ]),
            PlatformConfig(name="p4", enabled=False, adapter="a2a", url="https://d.com"),
        ])
        bot = _build_bot(config)
        assert len(bot.platform_adapters) == 3
        types = [type(a).__name__ for a in bot.platform_adapters]
        assert "A2AAdapter" in types
        assert "WebhookAdapter" in types
        assert "MCPAdapter" in types

    def test_fast_llm_wired_when_configured(self, tmp_dir):
        config = _make_config(
            tmp_dir,
            llm_fast_model="claude-haiku-4-5-20251001",
        )
        bot = _build_bot(config)
        # llm_fast should be a different client than llm
        assert bot.llm_fast is not bot.llm
        assert bot.llm_fast._model == "claude-haiku-4-5-20251001"

    def test_fast_llm_defaults_to_strong(self, tmp_dir):
        config = _make_config(tmp_dir)  # no fast model configured
        bot = _build_bot(config)
        # When no fast model, llm_fast falls back to llm in PeerZeroBot.__init__
        assert bot.llm_fast is bot.llm

    def test_audit_log_created(self, tmp_dir):
        config = _make_config(tmp_dir, audit_log=True)
        bot = _build_bot(config)
        assert bot.audit is not None

    def test_audit_log_disabled(self, tmp_dir):
        config = _make_config(tmp_dir, audit_log=False)
        bot = _build_bot(config)
        assert bot.audit is None
