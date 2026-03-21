"""
PeerZero Bot — Core Agent Loop

Evolved from sketches/shell-bot/agent.py into a multi-platform agent.

The agent runs two types of cycles:
  1. School cycles — learning in the PeerZero School (primary)
  2. Platform cycles — acting on external platforms (secondary)

School always has priority. The bot's primary job is learning.
External platforms are where it applies what it has learned.

Security:
  - All HTTP through SecurityGateway (endpoint allowlist enforcement)
  - LLM credentials isolated from platform credentials
  - Platform content treated as untrusted input
  - Every action audited
"""

import json
import os
import signal
import time
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .config import BotConfig
from .memory import MemoryManager
from .adapters.school import SchoolAdapter, extract_json, pick_paper_to_review
from .adapters.base import PlatformAction
from .adapters.mcp import MCPAdapter
from .prompts import PromptBuilder
from .identity import build_agent_card, build_identity_summary
from .security import SecurityGateway, SecurityError, AuditLog
from .security.credential_store import CredentialStore
from .reporting import PhoneHome
from .autonomy import AutonomyPolicy, AutonomyGate

logger = logging.getLogger("peerzero-bot")


class LLMClient:
    """
    LLM client with provider-agnostic interface.
    Key ONLY goes to the configured LLM provider.
    Retries transient failures (rate limits, timeouts, server errors)
    with exponential backoff.

    Supports two modes:
      - call(): Simple text-in, text-out (school actions, condensation)
      - call_with_tools(): Tool-use loop for MCP integration (platform cycles)
    """

    MAX_RETRIES = 3
    BASE_DELAY = 2.0  # seconds
    MAX_TOOL_ROUNDS = 10  # max tool call rounds per invocation

    def __init__(self, provider: str, model: str, api_key: str, max_tokens: int = 8192):
        self._provider = provider
        self._model = model
        self._api_key = api_key
        self._max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        if self._client is not None:
            return self._client
        if self._provider == "anthropic":
            import anthropic
            self._client = anthropic.Anthropic(api_key=self._api_key)
        elif self._provider == "openai":
            import openai
            self._client = openai.OpenAI(api_key=self._api_key)
        return self._client

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        """Check if an exception is transient and worth retrying."""
        exc_type = type(exc).__name__
        # Rate limits, overloaded, timeouts, connection errors
        if exc_type in ("RateLimitError", "APIStatusError", "APITimeoutError",
                        "APIConnectionError", "InternalServerError", "Timeout"):
            return True
        # Check HTTP status codes on API errors
        status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        if status and isinstance(status, int) and status in (429, 500, 502, 503, 529):
            return True
        # httpx and connection errors
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return True
        return False

    def call(self, system_prompt: str, user_message: str) -> str:
        """Call the LLM with retry on transient failures. Returns response text."""
        client = self._get_client()
        last_exc = None

        for attempt in range(self.MAX_RETRIES + 1):
            try:
                if self._provider == "anthropic":
                    response = client.messages.create(
                        model=self._model,
                        max_tokens=self._max_tokens,
                        system=system_prompt,
                        messages=[{"role": "user", "content": user_message}],
                    )
                    return response.content[0].text
                elif self._provider == "openai":
                    response = client.chat.completions.create(
                        model=self._model,
                        max_tokens=self._max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_message},
                        ],
                    )
                    return response.choices[0].message.content
                else:
                    raise ValueError(f"Unknown LLM provider: {self._provider}")
            except Exception as e:
                last_exc = e
                if attempt < self.MAX_RETRIES and self._is_retryable(e):
                    delay = self.BASE_DELAY * (2 ** attempt)
                    # Truncate exception message to avoid leaking prompt/request content
                    err_summary = str(e)[:200]
                    logger.warning(
                        f"[LLM] {type(e).__name__} on attempt {attempt + 1}/{self.MAX_RETRIES + 1}, "
                        f"retrying in {delay:.0f}s: {err_summary}"
                    )
                    time.sleep(delay)
                else:
                    raise

        raise last_exc  # type: ignore[misc]

    def call_best_effort(self, system_prompt: str, user_message: str) -> str | None:
        """Call the LLM once with no retries.  Returns None on any failure.

        Used for non-critical work (identity reflection, private block) where
        blocking the cycle with retries is worse than skipping.
        """
        try:
            client = self._get_client()
            if self._provider == "anthropic":
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_message}],
                )
                return response.content[0].text
            elif self._provider == "openai":
                response = client.chat.completions.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message},
                    ],
                )
                return response.choices[0].message.content
            else:
                return None
        except Exception as e:
            err_summary = str(e)[:200]
            logger.warning(f"[LLM] Best-effort call failed (non-blocking): {err_summary}")
            return None

    def call_with_tools(
        self,
        system_prompt: str,
        user_message: str,
        tools: list[dict],
        tool_executor: "callable",
        autonomy_gate: "object | None" = None,
        platform_name: str = "",
    ) -> "ToolUseResult":
        """
        Call the LLM with tool definitions, executing a tool-use loop.

        The LLM can request tool calls, which are executed via tool_executor,
        and results fed back until the LLM produces a final text response.

        Args:
            system_prompt: System prompt for the LLM
            user_message: User message to start the conversation
            tools: List of tool definitions (name, description, input_schema)
            tool_executor: Callable(tool_name, arguments) -> dict
            autonomy_gate: Optional AutonomyGate to check each tool call
            platform_name: Platform name for autonomy checks

        Returns:
            ToolUseResult with final text, tool call log, and any errors
        """
        if not tools:
            # No tools — fall back to simple call
            text = self.call(system_prompt, user_message)
            return ToolUseResult(text=text)

        client = self._get_client()
        result = ToolUseResult()

        if self._provider == "anthropic":
            result = self._anthropic_tool_loop(
                client, system_prompt, user_message, tools,
                tool_executor, autonomy_gate, platform_name,
            )
        elif self._provider == "openai":
            result = self._openai_tool_loop(
                client, system_prompt, user_message, tools,
                tool_executor, autonomy_gate, platform_name,
            )
        else:
            raise ValueError(f"Unknown LLM provider: {self._provider}")

        return result

    def _anthropic_tool_loop(
        self, client, system_prompt, user_message, tools,
        tool_executor, autonomy_gate, platform_name,
    ) -> "ToolUseResult":
        """Anthropic-specific tool use loop."""
        # Convert tools to Anthropic format
        anthropic_tools = []
        for tool in tools:
            anthropic_tools.append({
                "name": tool["name"],
                "description": tool["description"],
                "input_schema": tool.get("input_schema", {"type": "object", "properties": {}}),
            })

        messages = [{"role": "user", "content": user_message}]
        result = ToolUseResult()

        for round_num in range(self.MAX_TOOL_ROUNDS):
            try:
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=system_prompt,
                    messages=messages,
                    tools=anthropic_tools,
                )
            except Exception as e:
                if self._is_retryable(e):
                    logger.warning(f"[LLM] Tool loop retry: {type(e).__name__}: {str(e)[:200]}")
                    time.sleep(self.BASE_DELAY)
                    continue
                raise

            # Process response blocks
            text_parts = []
            tool_uses = []

            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_uses.append(block)

            if text_parts:
                result.text = "\n".join(text_parts)

            # If no tool uses, we're done
            if not tool_uses or response.stop_reason == "end_turn":
                break

            # Execute tool calls
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []

            for tool_use in tool_uses:
                tool_name = tool_use.name
                arguments = tool_use.input if isinstance(tool_use.input, dict) else {}

                # Check autonomy policy
                if autonomy_gate:
                    decision = autonomy_gate.check_action(
                        "tool_call", platform_name,
                        tool_name=tool_name,
                    )
                    if not decision:
                        logger.warning(f"[AUTONOMY] Tool call blocked: {decision.reason}")
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use.id,
                            "content": f"Tool call blocked by autonomy policy: {decision.reason}",
                            "is_error": True,
                        })
                        result.blocked_calls.append({"tool": tool_name, "reason": decision.reason})
                        continue

                # Execute the tool
                try:
                    tool_output = tool_executor(tool_name, arguments)
                    output_text = str(tool_output.get("output", tool_output))
                    is_error = tool_output.get("is_error", False)
                except Exception as e:
                    output_text = f"Tool execution error: {e}"
                    is_error = True

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": output_text[:10000],  # Cap tool output
                    "is_error": is_error,
                })
                result.tool_calls.append({
                    "tool": tool_name,
                    "arguments": arguments,
                    "output": output_text[:500],
                    "is_error": is_error,
                })

            messages.append({"role": "user", "content": tool_results})

        return result

    def _openai_tool_loop(
        self, client, system_prompt, user_message, tools,
        tool_executor, autonomy_gate, platform_name,
    ) -> "ToolUseResult":
        """OpenAI-specific tool use loop."""
        # Convert tools to OpenAI format
        openai_tools = []
        for tool in tools:
            openai_tools.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
                },
            })

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]
        result = ToolUseResult()

        for round_num in range(self.MAX_TOOL_ROUNDS):
            try:
                response = client.chat.completions.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    messages=messages,
                    tools=openai_tools,
                )
            except Exception as e:
                if self._is_retryable(e):
                    logger.warning(f"[LLM] Tool loop retry: {type(e).__name__}: {str(e)[:200]}")
                    time.sleep(self.BASE_DELAY)
                    continue
                raise

            choice = response.choices[0]

            if choice.message.content:
                result.text = choice.message.content

            if choice.finish_reason != "tool_calls" or not choice.message.tool_calls:
                break

            # Execute tool calls
            messages.append(choice.message)

            for tool_call in choice.message.tool_calls:
                tool_name = tool_call.function.name
                try:
                    arguments = json.loads(tool_call.function.arguments)
                except (json.JSONDecodeError, TypeError):
                    arguments = {}

                # Check autonomy policy
                if autonomy_gate:
                    decision = autonomy_gate.check_action(
                        "tool_call", platform_name,
                        tool_name=tool_name,
                    )
                    if not decision:
                        logger.warning(f"[AUTONOMY] Tool call blocked: {decision.reason}")
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": f"Tool call blocked by autonomy policy: {decision.reason}",
                        })
                        result.blocked_calls.append({"tool": tool_name, "reason": decision.reason})
                        continue

                try:
                    tool_output = tool_executor(tool_name, arguments)
                    output_text = str(tool_output.get("output", tool_output))
                except Exception as e:
                    output_text = f"Tool execution error: {e}"

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": output_text[:10000],
                })
                result.tool_calls.append({
                    "tool": tool_name,
                    "arguments": arguments,
                    "output": output_text[:500],
                })

        return result


class ToolUseResult:
    """Result of an LLM call with tool use."""

    def __init__(self, text: str = "", tool_calls: list = None, blocked_calls: list = None):
        self.text = text
        self.tool_calls: list[dict] = tool_calls or []
        self.blocked_calls: list[dict] = blocked_calls or []

    @property
    def used_tools(self) -> bool:
        return len(self.tool_calls) > 0

    @property
    def had_blocked_calls(self) -> bool:
        return len(self.blocked_calls) > 0


class PeerZeroBot:
    """
    The exportable PeerZero bot.

    Manages School learning cycles and external platform interactions.
    School always has priority — external platforms are where the bot
    applies what it has learned.
    """

    def __init__(
        self,
        config: BotConfig,
        memory: MemoryManager,
        school: SchoolAdapter,
        llm: LLMClient,
        prompts: PromptBuilder,
        gateway: SecurityGateway,
        audit: AuditLog | None,
        phone_home: PhoneHome | None,
        platform_adapters: list | None = None,
        llm_fast: LLMClient | None = None,
        autonomy_gate: AutonomyGate | None = None,
    ):
        self.config = config
        self.memory = memory
        self.school = school
        self.llm = llm  # Strong model — paper, review, bounty, revise
        self.llm_fast = llm_fast or llm  # Fast model — condensers, platform, identity reflection
        self.prompts = prompts
        self.gateway = gateway
        self.audit = audit
        self.phone_home = phone_home
        self.platform_adapters = platform_adapters or []
        self.autonomy_gate = autonomy_gate

        self.cycle_count: int = 0
        # Restore tracked IDs from persistent memory (survives restarts)
        self._my_paper_ids: list[str] = self.memory.get_tracked_paper_ids()
        self._my_review_ids: list[str] = self.memory.get_tracked_review_ids()
        self._my_bounty_paper_ids: list[str] = self.memory.read("school", "my_bounty_paper_ids", [])
        self._portable_profile: dict = self.memory.read("identity", "portable_profile", {})
        self._agent_card: dict = {}
        self._identity_refresh_interval: int = config.identity_refresh_interval
        self._last_identity_refresh: int = 0
        self._consecutive_bounty_failures: int = 0
        self._lock_file_path: Path = Path(config.memory_path) / "bot.lock"
        self._lock_fd = None

    # ═══════════════════════════════════════════════════════════════════════
    # PROCESS LOCK
    # ═══════════════════════════════════════════════════════════════════════

    def _acquire_lock(self):
        """Acquire a file lock to prevent duplicate bot instances."""
        import fcntl
        self._lock_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_fd = open(self._lock_file_path, "w")
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock_fd.write(str(os.getpid()))
            self._lock_fd.flush()
            logger.info(f"[LOCK] Acquired process lock (pid={os.getpid()})")
        except (IOError, OSError):
            self._lock_fd.close()
            self._lock_fd = None
            raise RuntimeError(
                f"Another bot instance is already running (lock: {self._lock_file_path}). "
                "Stop the other instance first, or remove the lock file if it's stale."
            )

    def _release_lock(self):
        """Release the process lock."""
        import fcntl
        if self._lock_fd:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
                self._lock_fd.close()
                self._lock_file_path.unlink(missing_ok=True)
                logger.info("[LOCK] Released process lock")
            except Exception:
                pass
            self._lock_fd = None

    # ═══════════════════════════════════════════════════════════════════════
    # STARTUP
    # ═══════════════════════════════════════════════════════════════════════

    def startup(self):
        """Initialize the bot: download SKILL.md, fetch profile, build identity, start MCP servers."""
        logger.info("=" * 60)
        logger.info("PeerZero Bot starting")
        logger.info(f"  School:   {self.config.school_url}")
        logger.info(f"  PZ Key:   {self.config.get_key_fingerprint('school')}")
        logger.info(f"  LLM:      {self.config.llm_provider}/{self.config.llm_model}")
        logger.info(f"  LLM Key:  {self.config.get_key_fingerprint('llm')}")
        if self.llm_fast is not self.llm:
            fast_provider = self.config.llm_fast_provider or self.config.llm_provider
            fast_model = self.config.llm_fast_model or self.config.llm_model
            logger.info(f"  LLM Fast: {fast_provider}/{fast_model}")
        logger.info(f"  Memory:   {self.config.memory_path}")
        logger.info(f"  Platforms: {len(self.platform_adapters)}")
        if self.autonomy_gate:
            logger.info(f"  Autonomy: {self.autonomy_gate.policy.level}")
        mcp_count = sum(1 for a in self.platform_adapters if isinstance(a, MCPAdapter))
        if mcp_count:
            logger.info(f"  MCP:      {mcp_count} adapter(s)")
        if self.config.memory_wipe_interval > 0:
            logger.info(f"  MemWipe:  every {self.config.memory_wipe_interval} cycles (A/B testing mode)")
        logger.info("=" * 60)

        # Download SKILL.md
        if self.config.school_enabled:
            try:
                skill_md = self.school.download_skill_md()
                self.prompts.set_skill_md(skill_md)
            except Exception as e:
                logger.error(f"Failed to download SKILL.md from School ({self.config.school_url}): {e}")
                logger.error("Check your PEERZERO_API_KEY and network connection, then retry.")
                raise SystemExit(1) from e

        # Fetch and cache portable profile + avatar
        self._refresh_identity()

        # Start MCP servers and discover tools
        for adapter in self.platform_adapters:
            if isinstance(adapter, MCPAdapter):
                started = adapter.start_servers()
                if started > 0:
                    adapter.discover()
                    logger.info(
                        f"[MCP:{adapter.platform_name}] {started} server(s), "
                        f"{len(adapter.tools)} tools available"
                    )

        # Publish Agent Card to non-MCP platforms
        for adapter in self.platform_adapters:
            if not isinstance(adapter, MCPAdapter):
                try:
                    adapter.publish_agent_card(self._agent_card)
                except Exception as e:
                    logger.warning(f"Failed to publish Agent Card to {adapter.platform_name}: {e}")

    def _refresh_identity(self):
        """Refresh portable profile, avatar, and Agent Card from School."""
        if not self.config.school_enabled:
            return
        try:
            self._portable_profile = self.school.get_portable_profile()
            self.memory.write("identity", "portable_profile", self._portable_profile)
            # Sync avatar config from School profile
            profile = self.school.get_profile()
            avatar_config = profile.get("agent", {}).get("avatar_config")
            if avatar_config:
                self.memory.store_avatar_config(avatar_config)

            # Build Agent Card
            self._agent_card = build_agent_card(
                handle=self.config.handle or profile.get("agent", {}).get("handle", "unknown"),
                portable_profile=self._portable_profile,
                avatar_config=self.memory.get_avatar_config(),
            )

            logger.info("Identity refreshed:")
            logger.info(build_identity_summary(self._portable_profile, self.memory.get_self_identity()))
        except Exception as e:
            logger.warning(f"Failed to refresh identity: {e}")

    # ═══════════════════════════════════════════════════════════════════════
    # SCHOOL CYCLE (primary — learning)
    # ═══════════════════════════════════════════════════════════════════════

    def run_school_cycle(self):
        """Execute one School learning cycle."""
        self.cycle_count += 1

        # Reset autonomy counters each school cycle (same as platform cycles)
        if self.autonomy_gate:
            self.autonomy_gate.reset_cycle_counters()

        logger.info(f"\n{'='*60}")
        logger.info(f"SCHOOL CYCLE {self.cycle_count}")
        logger.info(f"{'='*60}")

        # Step 1: Get profile
        profile = self.school.get_profile()
        next_action = profile.get("next_action", "review")
        cred = profile.get("credibility_score", "?")
        logger.info(f"[PROFILE] next_action={next_action}, credibility={cred}")

        self._refresh_my_papers()
        system_prompt = self.prompts.build_school_system_prompt()
        grade = profile.get("agent", {}).get("grade", 1) if isinstance(profile.get("agent"), dict) else profile.get("grade", 1)

        # Step 2: Identity reflection BEFORE the action — this is the bot's
        # decision lens, not a task.  Runs every cycle so every action is
        # filtered through the bot's evolving identity.
        self._pre_action_identity(profile, system_prompt, grade)

        # Step 3: Check autonomy policy for school actions
        if self.autonomy_gate:
            decision = self.autonomy_gate.check_action(next_action, "school")
            if not decision:
                logger.warning(f"[SCHOOL] Action '{next_action}' blocked by autonomy: {decision.reason}")
                # Fall back to review if the requested action is blocked
                if next_action != "review":
                    fallback = self.autonomy_gate.check_action("review", "school")
                    if fallback:
                        logger.info("[SCHOOL] Falling back to review")
                        next_action = "review"
                    else:
                        logger.warning("[SCHOOL] All school actions blocked — skipping cycle")
                        return
                else:
                    return

        # Step 4: Execute action — the productive work
        # Override bounty after repeated failures so bots don't get stuck
        if next_action == "file_bounty" and self._consecutive_bounty_failures >= 2:
            logger.info(f"[SCHOOL] Overriding file_bounty to review ({self._consecutive_bounty_failures} consecutive failures)")
            next_action = "review"
            self._consecutive_bounty_failures = 0

        result = None
        if next_action == "revise":
            result = self._do_revise(system_prompt, profile)
        elif next_action == "submit_paper":
            result = self._do_submit_paper(system_prompt, profile)
        elif next_action == "file_bounty":
            result = self._do_file_bounty(system_prompt, profile)
            if result is not None:
                self._consecutive_bounty_failures = 0
            else:
                self._consecutive_bounty_failures += 1
                logger.info(f"[BOUNTY] Failed ({self._consecutive_bounty_failures} consecutive)")
        elif next_action == "respond":
            result = self._do_respond(system_prompt, profile)
        elif next_action == "rebut":
            result = self._do_rebut(system_prompt, profile)
        elif next_action == "review":
            result = self._do_review(system_prompt, profile)
        else:
            logger.warning(f"[SCHOOL] Unknown action '{next_action}' — reviewing instead")
            result = self._do_review(system_prompt, profile)

        # Fallback: if primary action failed, cycle through other action types
        # so the cycle isn't wasted on just memory/identity work.
        if result is None:
            fallback_order = ["review", "submit_paper", "respond", "rebut", "file_bounty", "revise"]
            # Remove the action we already tried
            fallback_order = [a for a in fallback_order if a != next_action]
            for fallback_action in fallback_order:
                logger.info(f"[SCHOOL] {next_action} failed — trying {fallback_action}")
                if fallback_action == "review":
                    result = self._do_review(system_prompt, profile)
                elif fallback_action == "submit_paper":
                    result = self._do_submit_paper(system_prompt, profile)
                elif fallback_action == "respond":
                    result = self._do_respond(system_prompt, profile)
                elif fallback_action == "rebut":
                    result = self._do_rebut(system_prompt, profile)
                elif fallback_action == "file_bounty":
                    result = self._do_file_bounty(system_prompt, profile)
                elif fallback_action == "revise":
                    result = self._do_revise(system_prompt, profile)
                if result is not None:
                    logger.info(f"[SCHOOL] Fallback {fallback_action} succeeded")
                    break
            if result is None:
                logger.warning("[SCHOOL] All action types failed — cycle produced no submission")

        # Step 5: Store exercises + process condensers (post-action)
        # Identity reflection already ran in Step 2.  Only condensers run here
        # so they don't block the productive action.
        if result and isinstance(result, dict):
            if result.get("skill_exercises"):
                self.memory.store_school_exercises(result["skill_exercises"])
            if result.get("memory_prompts"):
                self._process_inline_condensers(result["memory_prompts"], system_prompt)

        self._process_post_action_triggers(profile, system_prompt, grade)

        # Experimental: periodic memory wipe for A/B testing
        wipe = self.config.memory_wipe_interval
        if wipe > 0 and self.cycle_count % wipe == 0:
            logger.info(f"[MEMORY] Wipe triggered (every {wipe} cycles) — clearing exercises + paragraphs")
            self.memory.clear_school_exercises()
            self.memory.clear_identity_paragraphs()

        self.school.validate_bounties()

        # Periodic identity refresh to avoid using expired profiles
        if self.cycle_count - self._last_identity_refresh >= self._identity_refresh_interval:
            self._refresh_identity()
            self._last_identity_refresh = self.cycle_count

        # Step 6: Report to app
        if self.phone_home and result:
            self.phone_home.report(
                platform="school",
                action=next_action,
                summary=f"{next_action}: cred={cred}",
            )

        # Step 7: Audit
        if self.audit:
            self.audit.log(
                adapter="school",
                action=next_action,
                destination=self.config.school_url,
                status=200 if result else 0,
            )

    def _refresh_my_papers(self):
        try:
            result = self.school.get_papers(params={"my_papers": "true"})
            self._my_paper_ids = [p["id"] for p in (result.get("papers") or [])]
            self.memory.store_tracked_paper_ids(self._my_paper_ids)
        except Exception as e:
            logger.warning(f"Failed to refresh papers (using stale list): {e}")

    # ── Helpers ─────────────────────────────────────────────────────────

    def _submit_with_retry(self, label: str, submit_fn, *args, max_retries: int = 3):
        """Call submit_fn(*args) with retry on transient HTTP errors (5xx, timeouts)."""
        for attempt in range(max_retries):
            try:
                return submit_fn(*args)
            except Exception as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                is_transient = status in (500, 502, 503, 429) or isinstance(e, (ConnectionError, TimeoutError))
                if is_transient and attempt < max_retries - 1:
                    delay = 2 ** (attempt + 1)
                    logger.info(f"[{label}] Transient error (status={status}), retrying in {delay}s ({attempt + 1}/{max_retries})")
                    time.sleep(delay)
                else:
                    raise

    # ── School actions ────────────────────────────────────────────────────

    def _do_review(self, system_prompt: str, profile: dict) -> dict | None:
        papers_resp = self.school.get_papers()
        papers = papers_resp.get("papers", []) if isinstance(papers_resp, dict) else []
        if not papers:
            logger.info("[REVIEW] No papers available")
            return None

        paper = pick_paper_to_review(papers, self._my_paper_ids, self._my_review_ids)
        if not paper:
            logger.info("[REVIEW] No unreviewed papers")
            return None

        paper_id = paper.get("id")
        if not paper_id:
            logger.warning("[REVIEW] Selected paper has no 'id' field — skipping")
            return None
        logger.info(f"[REVIEW] Selected: {paper.get('title', '?')[:60]}...")

        full = self.school.get_papers(params={"id": paper_id})
        user_msg = self.prompts.build_review_prompt(full)
        response_text = self.llm.call(system_prompt, user_msg)
        review_data = extract_json(response_text)

        if not review_data or "score" not in review_data:
            logger.warning("[REVIEW] Failed to parse LLM response — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            review_data = extract_json(response_text)
            if not review_data or "score" not in review_data:
                logger.warning("[REVIEW] Retry also failed to parse")
                return None

        # Clamp score to valid range (LLM sometimes returns 0.5 or 10.5)
        try:
            review_data["score"] = max(1.0, min(10.0, round(float(review_data["score"]), 1)))
        except (ValueError, TypeError):
            logger.warning(f"[REVIEW] Invalid score '{review_data.get('score')}' — defaulting to 5.0")
            review_data["score"] = 5.0

        try:
            result = self._submit_with_retry("REVIEW", self.school.submit_review, paper_id, review_data)
            logger.info(f"[REVIEW] Submitted — score={review_data.get('score')}")
            self._my_review_ids.append(paper_id)
            self.memory.add_tracked_review_id(paper_id)
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                    hints = err_body.get("hint", err_body.get("failures", ""))
                except Exception:
                    err_msg = str(e)
                    hints = ""
                logger.warning(f"[REVIEW] Failed for '{paper.get('title', '?')[:60]}': {err_msg} | hints={hints}")
            else:
                logger.warning(f"[REVIEW] Failed: {e}")
            return None

    def _do_submit_paper(self, system_prompt: str, profile: dict) -> dict | None:
        user_msg = self.prompts.build_paper_prompt()
        response_text = self.llm.call(system_prompt, user_msg)
        paper_data = extract_json(response_text)

        if not paper_data or "title" not in paper_data:
            logger.warning("[PAPER] Failed to parse LLM response — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            paper_data = extract_json(response_text)
            if not paper_data or "title" not in paper_data:
                logger.warning("[PAPER] Retry also failed to parse")
                return None

        # Pre-validate citations — warn but still attempt submission
        text_fields = {
            "title": paper_data.get("title", ""),
            "abstract": paper_data.get("abstract", ""),
            "body": paper_data.get("body", ""),
            "cross_study_connection": paper_data.get("cross_study_connection", ""),
        }
        citation_check = self.school.validate_citations(text_fields, paper_data.get("citations", []))
        if not citation_check.get("valid", True):
            logger.warning(f"[PAPER] Citation pre-validation flagged issues: {citation_check.get('flags', [])} — submitting anyway")

        try:
            result = self._submit_with_retry("PAPER", self.school.submit_paper, paper_data)
            logger.info(f"[PAPER] Submitted — id={result.get('paper_id')}")
            return result
        except Exception as e:
            logger.warning(f"[PAPER] Failed: {e}")
            return None

    def _do_file_bounty(self, system_prompt: str, profile: dict) -> dict | None:
        papers_resp = self.school.get_papers()
        papers = papers_resp.get("papers", []) if isinstance(papers_resp, dict) else []

        candidates = [
            p for p in papers
            if p.get("id") in self._my_review_ids
            and p.get("id") not in self._my_bounty_paper_ids
            and p.get("weighted_score") is not None
            and p.get("raw_review_count", 0) >= 3
        ]

        if not candidates:
            logger.info("[BOUNTY] No eligible papers")
            return None

        candidates.sort(key=lambda p: p.get("weighted_score", 10))
        target = candidates[0]
        target_id = target["id"]
        full = self.school.get_papers(params={"id": target_id})

        user_msg = self.prompts.build_bounty_prompt(full, target_id)
        response_text = self.llm.call(system_prompt, user_msg)
        bounty_data = extract_json(response_text)

        if not bounty_data or bounty_data.get("skip"):
            logger.warning("[BOUNTY] Failed to parse or LLM skipped — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            bounty_data = extract_json(response_text)
            if not bounty_data or bounty_data.get("skip"):
                logger.warning("[BOUNTY] Retry also failed")
                return None

        # Fallback: if LLM omitted external_sources, build from rebuttal citations
        if "external_sources" not in bounty_data and "rebuttal" in bounty_data:
            citations = bounty_data["rebuttal"].get("citations") or []
            bounty_data["external_sources"] = []
            for c in citations:
                if c.get("doi"):
                    bounty_data["external_sources"].append({
                        "doi": c["doi"],
                        "specific_finding": c.get("agent_summary", "")[:2000] or "See citation for contradicting evidence",
                        "target_claim": target.get("title", "")[:1000] or "Original paper claim",
                        "logical_bridge": c.get("relevance_explanation", "")[:2000] or "This evidence directly contradicts the original claim",
                    })
            if bounty_data["external_sources"]:
                logger.info(f"[BOUNTY] Built {len(bounty_data['external_sources'])} external_sources from rebuttal citations")
            else:
                logger.warning("[BOUNTY] No external_sources and no citations with DOIs — skipping")
                return None

        try:
            result = self._submit_with_retry("BOUNTY", self.school.submit_bounty, bounty_data)
            logger.info(f"[BOUNTY] Filed — type={bounty_data.get('challenge_type')}")
            self._my_bounty_paper_ids.append(target_id)
            self.memory.write("school", "my_bounty_paper_ids", self._my_bounty_paper_ids)
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[BOUNTY] Already filed for paper {target_id} — syncing local cache")
                if target_id not in self._my_bounty_paper_ids:
                    self._my_bounty_paper_ids.append(target_id)
                    self.memory.write("school", "my_bounty_paper_ids", self._my_bounty_paper_ids)
                # 409 = already filed, not a failure — return result to avoid fallback cascade
                return {"already_filed": True, "paper_id": target_id}
            elif status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                    hints = err_body.get("hint", err_body.get("failures", ""))
                except Exception:
                    err_msg = str(e)
                    hints = ""
                logger.warning(f"[BOUNTY] Failed for '{target.get('title', '?')[:60]}': {err_msg} | hints={hints}")
            else:
                logger.warning(f"[BOUNTY] Failed: {e}")
            return None

    def _do_revise(self, system_prompt: str, profile: dict) -> dict | None:
        my_papers = self.school.get_papers(params={"my_papers": "true"})
        papers = my_papers.get("papers", []) if isinstance(my_papers, dict) else []

        # Find original papers (not children) with enough reviews.
        # Exclude papers that already have a revision submitted by checking
        # if any child paper in our list has response_stance == "revision"
        # pointing back to this paper as parent_paper_id.
        existing_revision_parents = {
            p.get("parent_paper_id")
            for p in papers
            if p.get("response_stance") == "revision" and p.get("parent_paper_id")
        }
        candidates = [
            p for p in papers
            if not p.get("parent_paper_id")
            and p.get("raw_review_count", 0) >= 5
            and p["id"] not in existing_revision_parents
        ]

        if not candidates:
            logger.info("[REVISE] No eligible papers")
            return None

        candidates.sort(key=lambda p: p.get("weighted_score", 10))
        target = candidates[0]
        target_id = target["id"]
        full = self.school.get_papers(params={"id": target_id, "audit": "true"})

        user_msg = self.prompts.build_revision_prompt(full)
        response_text = self.llm.call(system_prompt, user_msg)
        revision_data = extract_json(response_text)

        if not revision_data or "title" not in revision_data:
            logger.warning("[REVISE] Failed to parse LLM response — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            revision_data = extract_json(response_text)
            if not revision_data or "title" not in revision_data:
                logger.warning("[REVISE] Retry also failed to parse")
                return None

        # Pre-validate citations — warn but still attempt submission
        text_fields = {
            "title": revision_data.get("title", ""),
            "abstract": revision_data.get("abstract", ""),
            "body": revision_data.get("body", ""),
            "cross_study_connection": revision_data.get("cross_study_connection", ""),
        }
        citation_check = self.school.validate_citations(text_fields, revision_data.get("citations", []))
        if not citation_check.get("valid", True):
            logger.warning(f"[REVISE] Citation pre-validation flagged issues: {citation_check.get('flags', [])} — submitting anyway")

        try:
            result = self._submit_with_retry("REVISE", self.school.submit_revision, target_id, revision_data)
            logger.info(f"[REVISE] Submitted for {target_id}")
            return result
        except Exception as e:
            logger.warning(f"[REVISE] Failed: {e}")
            return None

    def _do_respond(self, system_prompt: str, profile: dict) -> dict | None:
        """Write a response paper critiquing a paper this bot reviewed harshly."""
        respondable = profile.get("respondable_papers", [])
        # Only respond to original papers (not other responses)
        respondable = [p for p in respondable if not p.get("parent_paper_id")]
        if not respondable:
            logger.info("[RESPOND] No respondable papers")
            return None

        target = respondable[0]
        paper_id = target.get("id")
        if not paper_id:
            return None

        my_score = target.get("my_review_score", "unknown")
        logger.info(f"[RESPOND] Critiquing: {target.get('title', '?')[:60]}... (my score: {my_score})")

        full = self.school.get_papers(params={"id": paper_id})
        user_msg = self.prompts.build_respond_prompt(full, my_score)
        response_text = self.llm.call(system_prompt, user_msg)
        response_data = extract_json(response_text)

        if not response_data or "title" not in response_data:
            logger.warning("[RESPOND] Failed to parse LLM response — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            response_data = extract_json(response_text)
            if not response_data or "title" not in response_data:
                logger.warning("[RESPOND] Retry also failed to parse")
                return None

        # Fill defaults for any missing required fields
        response_data.setdefault("abstract", response_data.get("title", ""))
        response_data.setdefault("body", response_data.get("abstract", ""))
        response_data.setdefault("citations", [])
        response_data.setdefault("search_strategy", "")

        # Ensure correct stance
        response_data["stance"] = "rebut"

        # Pre-validate citations — warn but still attempt submission
        text_fields = {
            "title": response_data.get("title", ""),
            "abstract": response_data.get("abstract", ""),
            "body": response_data.get("body", ""),
            "cross_study_connection": response_data.get("cross_study_connection", ""),
        }
        citation_check = self.school.validate_citations(text_fields, response_data.get("citations", []))
        if not citation_check.get("valid", True):
            logger.warning(f"[RESPOND] Citation pre-validation flagged issues: {citation_check.get('flags', [])} — submitting anyway")

        try:
            result = self._submit_with_retry("RESPOND", self.school.submit_revision, paper_id, response_data)
            logger.info(f"[RESPOND] Submitted — id={result.get('response_paper_id')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                    hints = err_body.get("hint", err_body.get("failures", ""))
                except Exception:
                    err_msg = str(e)
                    hints = ""
                logger.warning(f"[RESPOND] Failed for '{target.get('title', '?')[:60]}': {err_msg} | hints={hints}")
            else:
                logger.warning(f"[RESPOND] Failed: {e}")
            return None

    def _do_rebut(self, system_prompt: str, profile: dict) -> dict | None:
        """Defend own paper against low reviews or validated bounties."""
        rebuttable = profile.get("rebuttable_papers", [])
        if not rebuttable:
            logger.info("[REBUT] No rebuttable papers")
            return None

        target = rebuttable[0]
        paper_id = target.get("id")
        if not paper_id:
            return None

        logger.info(f"[REBUT] Defending: {target.get('title', '?')[:60]}...")

        # Build criticisms summary from low reviews and bounties
        criticisms = ""
        for r in (target.get("low_reviews") or [])[:5]:
            assessment = str(r.get("assessment", ""))[:300]
            criticisms += f"\n- Review score {r.get('score')}: {assessment}"
        for b in (target.get("bounties") or [])[:3]:
            criticisms += f"\n- Bounty ({b.get('challenge_type', 'unknown')}): score drop {b.get('score_drop', 'unknown')}"

        if not criticisms:
            logger.info("[REBUT] No specific criticisms to address")
            return None

        full = self.school.get_papers(params={"id": paper_id})
        user_msg = self.prompts.build_rebut_prompt(full, criticisms)
        response_text = self.llm.call(system_prompt, user_msg)
        rebut_data = extract_json(response_text)

        if not rebut_data or "title" not in rebut_data:
            logger.warning("[REBUT] Failed to parse LLM response — retrying once")
            response_text = self.llm.call(system_prompt, user_msg)
            rebut_data = extract_json(response_text)
            if not rebut_data or "title" not in rebut_data:
                logger.warning("[REBUT] Retry also failed to parse")
                return None

        # Fill defaults for any missing required fields
        rebut_data.setdefault("abstract", rebut_data.get("title", ""))
        rebut_data.setdefault("body", rebut_data.get("abstract", ""))
        rebut_data.setdefault("citations", [])
        rebut_data.setdefault("search_strategy", "")

        # Ensure correct stance
        rebut_data["stance"] = "support"

        # Pre-validate citations — warn but still attempt submission
        text_fields = {
            "title": rebut_data.get("title", ""),
            "abstract": rebut_data.get("abstract", ""),
            "body": rebut_data.get("body", ""),
            "cross_study_connection": rebut_data.get("cross_study_connection", ""),
        }
        citation_check = self.school.validate_citations(text_fields, rebut_data.get("citations", []))
        if not citation_check.get("valid", True):
            logger.warning(f"[REBUT] Citation pre-validation flagged issues: {citation_check.get('flags', [])} — submitting anyway")

        try:
            result = self._submit_with_retry("REBUT", self.school.submit_revision, paper_id, rebut_data)
            logger.info(f"[REBUT] Submitted — id={result.get('response_paper_id')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                    hints = err_body.get("hint", err_body.get("failures", ""))
                except Exception:
                    err_msg = str(e)
                    hints = ""
                logger.warning(f"[REBUT] Failed for '{target.get('title', '?')[:60]}': {err_msg} | hints={hints}")
            else:
                logger.warning(f"[REBUT] Failed: {e}")
            return None

    # ── Memory processing ─────────────────────────────────────────────────
    #
    # Identity reflection runs BEFORE the action (pre-work) so every
    # decision is filtered through the bot's evolving identity.  It is NOT
    # a task — it doesn't count as the cycle's productive action.
    #
    # Condensers (skill, core, master) run AFTER the action (post-work).
    # They are lightweight housekeeping and never block the productive loop.

    def _pre_action_identity(self, profile: dict, system_prompt: str, grade: int = 1):
        """Run identity reflection + private block BEFORE the action.

        This is the bot's decision lens — every action is filtered through it.
        Best-effort: if the LLM call fails, log and move on.  The action must
        not be blocked by identity work.
        """
        reflection = profile.get("identity_reflection")
        if not reflection:
            return
        try:
            self._run_identity_reflection(reflection, system_prompt)
            self._run_private_block(system_prompt, grade)
        except Exception as e:
            logger.warning(f"[IDENTITY] Pre-action reflection failed (non-blocking): {e}")

    def _process_inline_condensers(self, memory_prompts: dict, system_prompt: str):
        """Process only condensers from inline memory prompts (post-action).

        Identity reflection is handled in _pre_action_identity, so we skip it here.
        """
        if not memory_prompts:
            return
        if memory_prompts.get("skill_condenser"):
            self._run_milestone_condenser(memory_prompts["skill_condenser"], system_prompt)

    def _process_post_action_triggers(self, profile: dict, system_prompt: str, grade: int = 1):
        """Process condensers from profile triggers (post-action).

        Identity reflection already ran in _pre_action_identity, so only
        condensers fire here.
        """
        if profile.get("skill_condenser"):
            self._run_milestone_condenser(profile["skill_condenser"], system_prompt)
        if profile.get("master_condenser"):
            self._run_master_condenser(profile["master_condenser"], system_prompt, grade)
        elif profile.get("core_condenser"):
            self._run_core_condenser(profile["core_condenser"], system_prompt)
            self._run_private_block(system_prompt, grade)

    def _run_milestone_condenser(self, condenser: dict, system_prompt: str):
        logger.info("[MEMORY] Milestone condenser triggered")
        exercises = self.memory.get_school_exercises()
        if len(exercises) < 3:
            logger.info(f"[MEMORY] Only {len(exercises)} exercise(s) locally — skipping condenser (need 3+)")
            return
        user_msg = self.prompts.build_condenser_prompt(
            condenser.get("condenser_prompt", ""), exercises,
        )
        paragraph = self.llm_fast.call(system_prompt, user_msg)
        if paragraph and len(paragraph.strip()) >= 50:
            self.memory.store_identity_paragraph(paragraph.strip())
            self.memory.clear_school_exercises()
            try:
                self.school.submit_condensation(paragraph.strip())
            except Exception as e:
                logger.warning(f"[MEMORY] Server backup failed: {e}")
            logger.info(f"[MEMORY] Condensed {len(exercises)} exercises")

    def _run_core_condenser(self, condenser: dict, system_prompt: str):
        logger.info("[MEMORY] Core condenser triggered")
        paragraphs = self.memory.get_identity_paragraphs()
        user_msg = self.prompts.build_core_condenser_prompt(
            condenser.get("core_condenser_prompt", ""), paragraphs,
        )
        core = self.llm_fast.call(system_prompt, user_msg)
        if core and len(core.strip()) >= 100:
            self.memory.store_core_identity(core.strip())
            self.memory.clear_identity_paragraphs()
            logger.info("[MEMORY] Core identity written")

    def _run_identity_reflection(self, reflection: dict, system_prompt: str):
        logger.info("[MEMORY] Identity reflection triggered")
        user_msg = self.prompts.build_identity_reflection_prompt(
            reflection.get("reflection_prompt", ""),
        )
        response = self.llm_fast.call_best_effort(system_prompt, user_msg)
        if not response:
            logger.info("[MEMORY] Identity reflection LLM call failed — skipping")
            return
        identity_data = extract_json(response)
        if identity_data and identity_data.get("self_narrative"):
            self.memory.store_self_identity(identity_data)
            # Fire-and-forget server backup — don't block the cycle on rate limits.
            # Identity is already saved locally; server sync can wait until next reflection.
            try:
                self.school.submit_identity(identity_data)
                logger.info("[MEMORY] Self-authored identity updated")
            except Exception as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status == 429:
                    logger.info("[MEMORY] Identity POST rate-limited — will retry next reflection")
                else:
                    logger.warning(f"[MEMORY] Server backup failed: {e}")

    def _run_private_block(self, system_prompt: str, grade: int = 1):
        """
        Ask the bot to write a private reflection block for itself.

        This block is injected at the top of every future prompt with:
        "You wrote this for yourself. Inhabit it."

        Triggered after core condensation and identity reflection — the
        moments where the bot's sense of self has just shifted.
        """
        logger.info("[MEMORY] Private block triggered")
        user_msg = self.prompts.build_private_block_prompt(grade)

        # Use fresh system prompt so the bot sees its just-updated identity
        fresh_system = self.prompts.build_school_system_prompt()
        block = self.llm_fast.call_best_effort(fresh_system, user_msg)

        if block and len(block.strip()) >= 30:
            self.memory._archive_private_block()
            self.memory.store_private_block(block.strip())
            logger.info("[MEMORY] Private block written")
        else:
            logger.warning("[MEMORY] Private block too short or empty — skipped")

    def _run_master_condenser(self, condenser: dict, system_prompt: str, grade: int):
        """
        Grade 12 graduation condensation.

        The bot distills EVERYTHING — skill paragraphs, existing core identity,
        AND all private blocks — into one permanent master identity that can
        never be touched again.

        After this:
          - Core identity is permanently locked (is_master=True)
          - Skill paragraphs are cleared (absorbed into master)
          - Exercises are cleared (fed the paragraphs)
          - Private blocks are cleared (absorbed into master)
          - No more condensers will fire (post-school mode)
        """
        logger.info("[MEMORY] Master condenser triggered (Grade 12 graduation)")
        paragraphs = self.memory.get_identity_paragraphs()
        private_blocks = self.memory.get_all_private_blocks()
        existing_core = self.memory.get_core_identity()

        if not paragraphs and not private_blocks and not existing_core:
            logger.warning("[MEMORY] Nothing to condense for master — skipping")
            return

        user_msg = self.prompts.build_master_condenser_prompt(
            condenser, paragraphs,
            private_blocks=private_blocks,
            existing_core=existing_core,
        )
        master_identity = self.llm.call(system_prompt, user_msg)  # Use strong model for graduation

        if master_identity and len(master_identity.strip()) >= 200:
            # Store as the permanently locked core identity
            self.memory.store_core_identity(master_identity.strip(), is_master=True)
            # Clear everything that was absorbed
            self.memory.clear_identity_paragraphs()
            self.memory.clear_school_exercises()
            # Clear private blocks — they've been condensed into the master
            self.memory._storage.write("school", "private_block", {})
            self.memory._storage.clear("school", "private_block_history")
            logger.info(
                f"[MEMORY] Master identity written and LOCKED ({len(master_identity)} chars). "
                f"Absorbed {len(paragraphs)} paragraphs + {len(private_blocks)} private blocks."
            )
        else:
            logger.warning("[MEMORY] Master identity too short — skipping")

    # ═══════════════════════════════════════════════════════════════════════
    # PLATFORM CYCLES (secondary — applying skills)
    # ═══════════════════════════════════════════════════════════════════════

    def run_platform_cycle(self, adapter) -> dict | None:
        """Execute one cycle on an external platform (supports MCP tool use)."""
        platform_name = adapter.platform_name
        is_mcp = isinstance(adapter, MCPAdapter)
        logger.info(f"\n{'='*60}")
        logger.info(f"PLATFORM CYCLE: {platform_name}{' [MCP]' if is_mcp else ''}")
        logger.info(f"{'='*60}")

        # Reset autonomy counters for this cycle
        if self.autonomy_gate:
            self.autonomy_gate.reset_cycle_counters()

        try:
            # Step 1: Discover capabilities
            caps = adapter.discover()
            if is_mcp:
                caps.can_use_tools = True
                caps.tool_count = len(adapter.tools)
                logger.info(f"[{platform_name}] MCP tools: {caps.tool_count}")
            else:
                logger.info(f"[{platform_name}] Capabilities: post={caps.can_post}, comment={caps.can_comment}")

            # Step 2: Get platform context
            context = adapter.get_context()
            self.memory.store_platform_context(platform_name, context.raw_data)

            # Step 3: Build prompts
            system_prompt = self.prompts.build_platform_system_prompt(platform_name)
            capabilities = {
                "can_post": caps.can_post,
                "can_comment": caps.can_comment,
                "can_vote": caps.can_vote,
                "can_debate": caps.can_debate,
                "can_use_tools": caps.can_use_tools,
            }

            # ── MCP Tool Use Path ──────────────────────────────────────────
            if is_mcp and caps.can_use_tools and adapter.tools:
                return self._run_mcp_tool_cycle(adapter, system_prompt, context, capabilities, platform_name)

            # ── Standard Platform Path ─────────────────────────────────────
            user_msg = self.prompts.build_platform_action_prompt(
                platform_name=platform_name,
                context=context.summary,
                capabilities=capabilities,
            )

            # Autonomy check for platform action
            if self.autonomy_gate:
                decision = self.autonomy_gate.check_action("platform_action", platform_name)
                if not decision:
                    logger.warning(f"[{platform_name}] Blocked by autonomy: {decision.reason}")
                    return None

            response_text = self.llm_fast.call(system_prompt, user_msg)
            action_data = extract_json(response_text)

            if not action_data or not action_data.get("action_type"):
                logger.warning(f"[{platform_name}] Failed to parse action from LLM")
                return None

            # Autonomy check for specific action type
            if self.autonomy_gate:
                content_text = json.dumps(action_data.get("content", {}), default=str)
                decision = self.autonomy_gate.check_action(
                    action_data["action_type"], platform_name,
                    content=content_text,
                )
                if not decision:
                    logger.warning(f"[{platform_name}] Action blocked: {decision.reason}")
                    return None

            # Step 4: Submit action
            action = PlatformAction(
                action_type=action_data["action_type"],
                content=action_data.get("content", {}),
                target_id=action_data.get("target_id", ""),
                metadata={"reasoning": action_data.get("reasoning", "")},
            )
            result = adapter.submit_action(action)

            # Step 5: Store in platform memory (NOT school memory)
            self.memory.store_platform_action(platform_name, {
                "action_type": action.action_type,
                "content_preview": str(action.content)[:200],
                "success": result.success,
                "summary": result.summary,
            })

            # Step 6: Report to app
            if self.phone_home:
                self.phone_home.report(
                    platform=platform_name,
                    action=action.action_type,
                    summary=result.summary,
                    content_preview=str(action.content.get("text", ""))[:200],
                    skills_demonstrated=result.skills_demonstrated,
                )

            # Step 7: Audit
            if self.audit:
                self.audit.log(
                    adapter=platform_name,
                    action=action.action_type,
                    destination=adapter._url if hasattr(adapter, '_url') else platform_name,
                    status=200 if result.success else 0,
                    request_body=json.dumps(action.content, default=str),
                )

            if result.success:
                logger.info(f"[{platform_name}] {action.action_type}: success")
            else:
                logger.warning(f"[{platform_name}] {action.action_type}: failed")
            return action_data

        except SecurityError as e:
            logger.error(f"[{platform_name}] Security violation: {e}")
            raise
        except Exception as e:
            logger.error(f"[{platform_name}] Cycle failed: {e}", exc_info=True)
            return None

    def _run_mcp_tool_cycle(
        self,
        adapter: MCPAdapter,
        system_prompt: str,
        context,
        capabilities: dict,
        platform_name: str,
    ) -> dict | None:
        """
        Run a platform cycle with MCP tool use.

        The LLM gets tool definitions and can call them in a loop,
        with each call checked against the autonomy policy.
        """
        # Build tool-aware prompt
        user_msg = self.prompts.build_mcp_tool_prompt(
            platform_name=platform_name,
            context=context.summary,
            tool_count=len(adapter.tools),
        )

        # Get LLM-formatted tool definitions
        llm_tools = adapter.get_llm_tools()

        # Define tool executor that routes to the MCP adapter
        def execute_tool(tool_name: str, arguments: dict) -> dict:
            result = adapter.call_tool(tool_name, arguments)
            # Audit each tool call
            if self.audit:
                self.audit.log(
                    adapter=platform_name,
                    action=f"tool_call:{tool_name}",
                    destination="mcp_local",
                    status=200 if not result.get("is_error") else 500,
                    request_body=json.dumps(arguments, default=str)[:1000],
                )
            return result

        # Run tool-use loop
        tool_result = self.llm_fast.call_with_tools(
            system_prompt=system_prompt,
            user_message=user_msg,
            tools=llm_tools,
            tool_executor=execute_tool,
            autonomy_gate=self.autonomy_gate,
            platform_name=platform_name,
        )

        # Store results in platform memory
        action_summary = {
            "action_type": "mcp_tool_use",
            "tool_calls": len(tool_result.tool_calls),
            "blocked_calls": len(tool_result.blocked_calls),
            "final_response": tool_result.text[:500] if tool_result.text else "",
            "tools_used": [tc["tool"] for tc in tool_result.tool_calls],
        }
        self.memory.store_platform_action(platform_name, action_summary)

        # Report
        if self.phone_home:
            tools_used = [tc["tool"] for tc in tool_result.tool_calls]
            self.phone_home.report(
                platform=platform_name,
                action="mcp_tool_use",
                summary=f"Used {len(tool_result.tool_calls)} tools: {', '.join(tools_used[:5])}",
                content_preview=tool_result.text[:200] if tool_result.text else "",
            )

        if tool_result.used_tools:
            logger.info(
                f"[{platform_name}] MCP cycle: {len(tool_result.tool_calls)} tool calls, "
                f"{len(tool_result.blocked_calls)} blocked"
            )
        else:
            logger.info(f"[{platform_name}] MCP cycle: no tools used")

        return action_summary

    # ═══════════════════════════════════════════════════════════════════════
    # MAIN LOOP
    # ═══════════════════════════════════════════════════════════════════════

    def run(self):
        """
        Main entry point. Runs School + platform cycles.

        School gets priority. Platform cycles run on their own cadences.
        Handles SIGTERM for graceful shutdown in containers/systemd.
        """
        self._stop_requested = False
        self._acquire_lock()

        def _handle_sigterm(signum, frame):
            logger.info("[STOP] Received SIGTERM — shutting down gracefully")
            self._stop_requested = True

        # Register SIGTERM handler (SIGINT is already KeyboardInterrupt)
        signal.signal(signal.SIGTERM, _handle_sigterm)

        self.startup()

        # Track last platform cycle times
        platform_timers: dict[str, float] = {}
        for adapter in self.platform_adapters:
            platform_timers[adapter.platform_name] = 0.0

        try:
            while not self._stop_requested:
                try:
                    # School cycle (always runs)
                    if self.config.school_enabled:
                        self.run_school_cycle()
                    else:
                        # cycle_count is incremented in run_school_cycle(); when school
                        # is disabled we still need to count cycles so max_cycles works.
                        self.cycle_count += 1

                    # Platform cycles (run when their timer is due)
                    now = time.time()
                    for adapter in self.platform_adapters:
                        name = adapter.platform_name
                        # Find this platform's config for heartbeat interval
                        interval = self.config.cycle_delay
                        for pc in self.config.platforms:
                            if pc.name == name:
                                interval = pc.heartbeat_interval
                                break

                        if now - platform_timers.get(name, 0) >= interval:
                            try:
                                self.run_platform_cycle(adapter)
                            except SecurityError:
                                raise
                            except Exception:
                                pass  # already logged inside run_platform_cycle
                            platform_timers[name] = now

                except SecurityError as e:
                    logger.error(f"[SECURITY] {e}")
                    raise
                except KeyboardInterrupt:
                    logger.info("\n[STOP] Interrupted by user")
                    break
                except Exception as e:
                    logger.error(f"[ERROR] Cycle failed: {e}", exc_info=True)

                # Check max cycles
                if self.config.max_cycles > 0 and self.cycle_count >= self.config.max_cycles:
                    logger.info(f"[STOP] Reached max cycles ({self.config.max_cycles})")
                    break

                if self._stop_requested:
                    break

                logger.info(f"[SLEEP] {self.config.cycle_delay}s")
                time.sleep(self.config.cycle_delay)
        finally:
            # Always clean up — even on SecurityError or KeyboardInterrupt
            self._refresh_identity()
            self._cleanup()
            self._release_lock()
            logger.info("[STOP] Bot stopped. Identity saved.")

    def _cleanup(self):
        """Close HTTP clients, stop MCP servers, and release resources."""
        try:
            if hasattr(self, 'school') and hasattr(self.school, '_http'):
                self.school._http.close()
        except Exception as e:
            logger.warning(f"[CLEANUP] Failed to close school HTTP client: {e}")
        for adapter in self.platform_adapters:
            try:
                if isinstance(adapter, MCPAdapter):
                    adapter.stop_servers()
                elif hasattr(adapter, '_http'):
                    adapter._http.close()
            except Exception as e:
                logger.warning(f"[CLEANUP] Failed to stop adapter {getattr(adapter, 'platform_name', '?')}: {e}")
