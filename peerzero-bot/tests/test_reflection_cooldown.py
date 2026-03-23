"""Tests for identity reflection cooldown in agent.py."""

import json
from unittest.mock import MagicMock, patch
import pytest


@pytest.fixture
def bot():
    """Create a PeerZeroBot with mocked dependencies."""
    with patch("peerzero_bot.agent.LLMClient"), \
         patch("peerzero_bot.agent.PromptBuilder"), \
         patch("peerzero_bot.agent.SchoolAdapter"), \
         patch("peerzero_bot.agent.SecurityGateway"), \
         patch("peerzero_bot.agent.MemoryManager") as MockMemory:

        from peerzero_bot.agent import PeerZeroBot

        config = MagicMock()
        config.identity_refresh_interval = 10
        config.memory_path = "/tmp/test"
        memory = MockMemory.return_value
        memory.read.return_value = {}

        school = MagicMock()
        llm = MagicMock()
        llm_fast = MagicMock()
        # Return valid JSON from reflection LLM call so extract_json succeeds
        llm_fast.call_best_effort.return_value = json.dumps({
            "self_narrative": "I am a bot learning through adversarial science. " * 5,
            "active_tensions": "Should I prioritize depth or breadth?",
        })
        prompts = MagicMock()
        gateway = MagicMock()
        audit = MagicMock()

        bot = PeerZeroBot(
            config=config,
            memory=memory,
            school=school,
            llm=llm,
            prompts=prompts,
            gateway=gateway,
            audit=audit,
            phone_home=None,
            llm_fast=llm_fast,
        )
        return bot


class TestReflectionCooldown:
    """Identity reflection should respect a per-bot cycle cooldown."""

    def test_first_cycle_reflects(self, bot):
        """First cycle should allow reflection (no prior reflection)."""
        profile = {"identity_reflection": {"reflection_prompt": "reflect"}}
        bot.cycle_count = 1

        bot._pre_action_identity(profile, "sys", grade=1)

        # Should have called reflection — llm_fast is used for reflection
        bot.llm_fast.call_best_effort.assert_called()

    def test_cooldown_blocks_reflection(self, bot):
        """Reflection within cooldown window should be skipped."""
        profile = {"identity_reflection": {"reflection_prompt": "reflect"}}

        # First reflection at cycle 1
        bot.cycle_count = 1
        bot._pre_action_identity(profile, "sys", grade=1)
        bot.llm_fast.call_best_effort.reset_mock()

        # Cycle 3 — within cooldown (5 cycles)
        bot.cycle_count = 3
        bot._pre_action_identity(profile, "sys", grade=1)
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_reflection_after_cooldown(self, bot):
        """Reflection should fire again after cooldown expires."""
        profile = {"identity_reflection": {"reflection_prompt": "reflect"}}

        # First reflection at cycle 1
        bot.cycle_count = 1
        bot._pre_action_identity(profile, "sys", grade=1)
        bot.llm_fast.call_best_effort.reset_mock()

        # Cycle 6 — cooldown expired (5 cycles later)
        bot.cycle_count = 6
        bot._pre_action_identity(profile, "sys", grade=1)
        bot.llm_fast.call_best_effort.assert_called()

    def test_no_reflection_without_server_trigger(self, bot):
        """No reflection when server doesn't include identity_reflection."""
        profile = {}
        bot.cycle_count = 10

        bot._pre_action_identity(profile, "sys", grade=1)
        bot.llm_fast.call_best_effort.assert_not_called()

    def test_cooldown_constant_is_5(self, bot):
        """Verify the cooldown constant matches expectations."""
        from peerzero_bot.agent import PeerZeroBot
        assert PeerZeroBot._REFLECTION_COOLDOWN_CYCLES == 5
