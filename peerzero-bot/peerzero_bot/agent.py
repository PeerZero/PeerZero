"""
PeerZero Bot — Core Agent Loop

The agent runs two types of cycles:
  1. School cycles — learning in the PeerZero School (primary)
  2. Platform cycles — acting on external platforms (secondary)

School always has priority. The bot's primary job is learning.
External platforms are where it applies what it has learned.

School actions (papers, reviews, bounties, revisions, rebuttals, responses,
reaffirmations) use LLMClient.call_json() which forces structured output via
Anthropic tool_use — guaranteeing valid JSON without parse retries. Each action
searches real academic APIs (OpenAlex, arXiv, PubMed) for evidence before
generating output.

The server determines what action each bot should take via the next_action field
in the agent profile. The bot trusts the server's decision and executes it.

Security:
  - All HTTP through SecurityGateway (endpoint allowlist enforcement)
  - LLM credentials isolated from platform credentials
  - Platform content treated as untrusted input
  - Every action audited
"""

import json
import random
import signal
import time
import logging
from datetime import datetime, timezone

import httpx

from .config import BotConfig
from .memory import MemoryManager
from .adapters.school import SchoolAdapter, extract_json
from .adapters.base import PlatformAction
from .adapters.mcp import MCPAdapter
from .prompts import PromptBuilder
from .identity import build_agent_card, build_identity_summary
from .security import SecurityGateway, SecurityError, AuditLog
from .security.credential_store import CredentialStore
from .reporting import PhoneHome
from .autonomy import AutonomyPolicy, AutonomyGate
from .search import search_and_summarize

logger = logging.getLogger("peerzero-bot")


def _clamp_paper_fields(data: dict) -> dict:
    """Truncate paper/response fields to match DB check constraints.

    DB limits:  title 10-300, abstract 100-2000, body 500+,
                citation agent_summary 50-1000, relevance_explanation 30-500,
                source_quality_note 30+
    """
    if "title" in data:
        data["title"] = str(data["title"])[:300]
    if "abstract" in data:
        data["abstract"] = str(data["abstract"])[:2000]
    # body has no max constraint, just min 500

    # Clamp citation fields
    for c in data.get("citations", []):
        if "agent_summary" in c:
            c["agent_summary"] = str(c["agent_summary"])[:1000]
        if "relevance_explanation" in c:
            c["relevance_explanation"] = str(c["relevance_explanation"])[:500]
        if "source_quality_note" in c:
            c["source_quality_note"] = str(c["source_quality_note"])[:2000]
    return data



class LLMClient:
    """
    LLM client with provider-agnostic interface.
    Key ONLY goes to the configured LLM provider.
    Retries transient failures (rate limits, timeouts, server errors)
    with exponential backoff.

    Supports three modes:
      - call(): Simple text-in, text-out (condensation, identity reflection)
      - call_json(): Forced structured output via tool_use (papers, reviews,
        revisions, bounties, rebuttals, responses, reaffirmations). Guarantees
        valid JSON by using tool_choice=tool with a schema derived from expected
        keys. Falls back to call() + extract_json if tool_use fails.
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
                    if response.stop_reason == "max_tokens":
                        logger.warning(f"[LLM] Response truncated (hit max_tokens={self._max_tokens})")
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

    # Known field types for tool schema generation
    _FIELD_TYPES: dict[str, dict] = {
        # Arrays
        "citations": {"type": "array", "items": {"type": "object"}},
        "field_ids": {"type": "array", "items": {"type": "number"}},
        "mechanism_chain": {"type": "array", "items": {"type": "string"}},
        # Objects
        "search_strategy": {"type": "object"},
        "review_search_strategy": {"type": "object"},
        "content": {"type": "object"},
        # Numbers
        "score": {"type": "number"},
        "confidence_score": {"type": "number"},
        "methodology_score": {"type": "number"},
        "novelty_score": {"type": "number"},
        "reproducibility_score": {"type": "number"},
        "citation_quality_score": {"type": "number"},
        # Booleans
        "skip": {"type": "boolean"},
    }

    def call_json(self, system_prompt: str, user_message: str, json_keys: list[str] | None = None) -> dict | None:
        """Call LLM and force JSON output via tool_use (Anthropic) or json mode (OpenAI).

        For Anthropic: uses tool_use with tool_choice=tool to guarantee valid JSON.
        Falls back to regular call + extract_json if tool_use fails.
        """
        from peerzero_bot.adapters.school import extract_json

        # Build a permissive tool schema from provided keys or defaults
        if not json_keys:
            json_keys = ["title", "abstract", "body"]

        properties = {}
        for k in json_keys:
            properties[k] = self._FIELD_TYPES.get(k, {"type": "string"})
        tool = {
            "name": "submit_result",
            "description": "Submit your result as structured JSON. Fill every field.",
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": json_keys,  # require all fields to ensure completeness
            },
        }

        client = self._get_client()

        # Phase 1: Tool use (Anthropic only)
        if self._provider == "anthropic":
            try:
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=system_prompt + "\n\nUse the submit_result tool to return your output. Do not write text outside the tool call.",
                    messages=[{"role": "user", "content": user_message}],
                    tools=[tool],
                    tool_choice={"type": "tool", "name": "submit_result"},
                )
                if response.stop_reason == "max_tokens":
                    logger.warning(f"[LLM] tool_use truncated at max_tokens={self._max_tokens}")
                for block in response.content:
                    if block.type == "tool_use" and block.name == "submit_result":
                        result = block.input
                        if isinstance(result, dict) and result:
                            logger.info(f"[LLM] JSON extracted via tool_use ({len(result)} keys: {list(result.keys())[:5]})")
                            return result
                # Log what we actually got
                block_types = [b.type for b in response.content]
                logger.warning(f"[LLM] tool_use returned no valid result (blocks={block_types}, stop={response.stop_reason}), falling back to text")
            except Exception as e:
                logger.warning(f"[LLM] tool_use failed: {type(e).__name__}: {e}, falling back to text")

        # Phase 2: Fall back to regular call + extract_json
        try:
            text = self.call(system_prompt, user_message)
            return extract_json(text)
        except Exception as e:
            logger.warning(f"[LLM] call_json fallback failed: {e}")
            return None

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
        self._portable_profile: dict = self.memory.read("identity", "portable_profile", {})
        self._agent_card: dict = {}
        self._identity_refresh_interval: int = config.identity_refresh_interval
        self._last_identity_refresh: int = 0

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
        handle = self.config.handle or "bot"

        # Reset autonomy counters each school cycle (same as platform cycles)
        if self.autonomy_gate:
            self.autonomy_gate.reset_cycle_counters()

        logger.info(f"\n{'='*60}")
        logger.info(f"[{handle}] SCHOOL CYCLE {self.cycle_count}")
        logger.info(f"{'='*60}")

        # Step 1: Get profile
        profile = self.school.get_profile()
        next_action = profile.get("next_action", "review")
        cred = profile.get("credibility_score", "?")
        dc = profile.get("decision_context", {})
        dc_reasoning = dc.get("reasoning", "no context")
        logger.info(f"[{handle}] next_action={next_action}, credibility={cred} | {dc_reasoning}")

        # Inject profile into prompt builder so coaching/feedback/risk flow into prompts
        self.prompts.set_profile(profile)
        system_prompt = self.prompts.build_school_system_prompt()
        grade = profile.get("agent", {}).get("grade", 1) if isinstance(profile.get("agent"), dict) else profile.get("grade", 1)

        # Step 2: Identity reflection — only when server triggers it (~33% of cycles).
        # Runs BEFORE the action so decisions are filtered through evolving identity.
        self._pre_action_identity(profile, system_prompt, grade)

        # Step 2b: Action-relevant community work — only run tasks that relate to
        # what the server told us to do. No fetching bounty data for a review cycle.
        if self.cycle_count % 3 == 0:
            try:
                if next_action in ("file_bounty", "rebut", "reaffirm"):
                    # Bounty-related actions: red team our papers, file structural bounties
                    self._do_red_team_responses(system_prompt)
                    self._do_structural_bounties(system_prompt, profile)
                elif next_action == "review":
                    # Review actions: rate other reviews, vote on red team responses
                    self._do_rate_reviews(system_prompt, profile)
                    self._do_red_team_jury_vote(system_prompt)
                # Open questions are cheap (no LLM unless posting) — run for any action
                self._do_open_questions(system_prompt)
            except Exception as e:
                logger.warning(f"[{handle}] Community work failed (non-blocking): {e}")

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
        # Trust the server. Do exactly what next_action says. If it fails,
        # log it and move on — the server will assign a new action next cycle.
        # No fallback cascade: the server already determined what's valid.

        # Fetch action-specific skill instructions from the server.
        # The server sends targeted reasoning guidance + JSON format for this action.
        # This makes the bot a thin shell — intelligence lives in the server.
        _ACTION_SKILL_MAP = {
            "revise": "revise", "submit_paper": "paper", "file_bounty": "bounty",
            "respond": "respond", "rebut": "rebut", "review": "review",
            "reaffirm": "reaffirm",
        }
        skill_action = _ACTION_SKILL_MAP.get(next_action)
        action_skill = ""
        if skill_action:
            action_skill = self.school.download_skill_action(skill_action)

        result = None
        if next_action == "revise":
            result = self._do_revise(system_prompt, profile, action_skill)
        elif next_action == "submit_paper":
            result = self._do_submit_paper(system_prompt, profile, action_skill)
        elif next_action == "file_bounty":
            result = self._do_file_bounty(system_prompt, profile, action_skill)
        elif next_action == "respond":
            result = self._do_respond(system_prompt, profile, action_skill)
        elif next_action == "rebut":
            result = self._do_rebut(system_prompt, profile, action_skill)
        elif next_action == "review":
            result = self._do_review(system_prompt, profile, action_skill)
        elif next_action == "reaffirm":
            result = self._do_reaffirm(system_prompt, profile, action_skill)
        elif next_action == "sleep":
            logger.info(f"[{handle}] Server says nothing to do — sleeping")
            result = {"status": "sleeping"}
        else:
            logger.warning(f"[SCHOOL] Unknown action '{next_action}' — skipping")

        if result is None:
            logger.info(f"[{handle}] {next_action} produced no result — server will reassign next cycle")

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

    def _do_review(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        # Server already filtered: not own paper, not already reviewed, <15 reviews
        reviewable = profile.get("reviewable_papers", [])

        # Also filter out papers we've locally tracked as reviewed (catches races / stale server data)
        tracked = set(self.memory.get_tracked_review_ids())
        if tracked:
            before = len(reviewable)
            reviewable = [p for p in reviewable if p.get("id") not in tracked]
            if len(reviewable) < before:
                logger.info(f"[REVIEW] Filtered {before - len(reviewable)} locally-tracked papers")

        if not reviewable:
            logger.info("[REVIEW] No reviewable papers")
            return None

        # Pick randomly from the full list to spread bots across papers
        paper = random.choice(reviewable)
        paper_id = paper.get("id")
        if not paper_id:
            return None
        logger.info(f"[REVIEW] Selected: {paper.get('title', '?')[:60]}...")

        full = self.school.get_papers(params={"id": paper_id})
        user_msg = self.prompts.build_review_prompt(full, action_skill=action_skill)
        review_keys = ["score", "overall_assessment", "methodology_notes", "statistical_validity_notes",
                       "citation_accuracy_notes", "reproducibility_notes", "logical_consistency_notes",
                       "review_search_strategy"]
        review_data = self.llm.call_json(system_prompt, user_msg, json_keys=review_keys)

        if not review_data or "score" not in review_data:
            logger.warning("[REVIEW] Failed to get valid JSON from LLM")
            return None

        # Clamp score to valid range (LLM sometimes returns 0.5 or 10.5)
        try:
            review_data["score"] = max(1.0, min(10.0, round(float(review_data["score"]), 1)))
        except (ValueError, TypeError):
            logger.warning(f"[REVIEW] Invalid score '{review_data.get('score')}' — defaulting to 5.0")
            review_data["score"] = 5.0

        try:
            result = self._submit_with_retry("REVIEW", self.school.submit_review, paper_id, review_data)
            cred_new = result.get("your_new_credibility", "?")
            cred_change = result.get("credibility_change", "?")
            logger.info(f"[REVIEW] Submitted — score={review_data.get('score')}, credibility={cred_new} (change={cred_change})")
            # Track this paper so we can rate other reviews on it later
            self.memory.add_tracked_review_id(paper_id)
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[REVIEW] 409 — already reviewed or full, moving on")
                # Track locally so we don't waste another LLM call on this paper
                self.memory.add_tracked_review_id(paper_id)
                return {"status": "already_done"}
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                    failures = err_body.get("failures", [])
                    if failures:
                        err_msg += f" — {failures}"
                except Exception:
                    err_msg = str(e)
                logger.warning(f"[REVIEW] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[REVIEW] Failed: {e}")
            return None

    def _do_submit_paper(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        # Step 1: Generate concept and search queries
        concept_msg = self.prompts.build_paper_concept_prompt()
        concept_text = self.llm_fast.call(system_prompt, concept_msg)
        concept = extract_json(concept_text) or {}
        search_queries = concept.get("search_queries", [])
        opposing_queries = concept.get("opposing_queries", [])
        paper_context = concept.get("core_claim", concept.get("working_title", ""))

        # Step 2: Search real academic APIs
        all_queries = search_queries + opposing_queries
        if not all_queries:
            all_queries = ["scientific research"]
        evidence_papers = search_and_summarize(all_queries, paper_context, self.llm_fast)
        logger.info(f"[PAPER] Found {len(evidence_papers)} papers from search")

        # Step 3: Generate paper using ONLY searched citations
        user_msg = self.prompts.build_paper_prompt(citation_slots=evidence_papers, concept=concept, action_skill=action_skill)
        paper_keys = ["title", "abstract", "body", "field_ids", "confidence_score",
                       "falsifiable_claim", "measurable_prediction", "quantitative_expectation",
                       "cross_study_connection", "citations", "search_strategy"]
        paper_data = self.llm.call_json(system_prompt, user_msg, json_keys=paper_keys)

        if not paper_data or "title" not in paper_data:
            logger.warning("[PAPER] Failed to get valid JSON from LLM")
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
            paper_data = _clamp_paper_fields(paper_data)
            result = self._submit_with_retry("PAPER", self.school.submit_paper, paper_data)
            logger.info(f"[PAPER] Submitted — id={result.get('paper_id')}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            logger.warning(f"[PAPER] Failed: {e}")
            return None

    def _do_file_bounty(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        # Server already filtered: reviewed by bot, not already bountied, 3+ reviews, <8 family bounties
        bountyable = profile.get("bountyable_papers", [])
        if not bountyable:
            logger.info("[BOUNTY] No bountyable papers from server")
            return None

        # Pick randomly from lowest-scored third to reduce 409 races
        pool_size = max(1, len(bountyable) // 3)
        target = random.choice(bountyable[:pool_size])
        target_id = target["id"]
        full = self.school.get_papers(params={"id": target_id})

        user_msg = self.prompts.build_bounty_prompt(full, target_id, action_skill=action_skill)
        bounty_keys = ["action", "target_paper_id", "challenge_type", "skip", "reason",
                       "challenged_doi", "quality_challenge_reason", "search_strategy"]
        bounty_data = self.llm.call_json(system_prompt, user_msg, json_keys=bounty_keys)

        if bounty_data and bounty_data.get("skip"):
            logger.info(f"[BOUNTY] Skipped — {bounty_data.get('reason', 'no reason given')}")
            return None

        if not bounty_data:
            logger.warning("[BOUNTY] Failed to get valid JSON from LLM")
            return None

        # Server validates challenge_type and required fields — SKILL.md guides the LLM
        # on which types are valid and what each type requires.
        try:
            result = self._submit_with_retry("BOUNTY", self.school.submit_bounty, bounty_data)
            logger.info(f"[BOUNTY] Filed — type={bounty_data.get('challenge_type')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[BOUNTY] 409 — already filed or limit reached, moving on")
                return {"status": "already_done"}
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                except Exception:
                    err_msg = str(e)
                logger.warning(f"[BOUNTY] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[BOUNTY] Failed: {e}")
            return None

    def _do_revise(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        # Server already filtered: own paper, enough reviews, <2 revisions, bounties, rebuttals
        revisable = profile.get("can_revise_papers", [])
        if not revisable:
            logger.info("[REVISE] No revisable papers from server")
            return None

        # Pick lowest-scored paper
        revisable.sort(key=lambda p: p.get("weighted_score", 10))
        target = revisable[0]
        target_id = target["id"]
        full = self.school.get_papers(params={"id": target_id, "audit": "true"})

        # LLM generates search queries based on SKILL.md guidance
        paper_title = target.get("title", "")
        search_plan_msg = self.prompts.build_search_planning_prompt(
            "revise", paper_title,
            extra_context="You received critical reviews. Search for evidence to address weaknesses and strengthen your argument.",
        )
        search_plan = extract_json(self.llm_fast.call(system_prompt, search_plan_msg)) or {}
        revision_queries = search_plan.get("supporting_queries", []) + search_plan.get("opposing_queries", [])
        if not revision_queries:
            revision_queries = [paper_title]
        evidence_papers = search_and_summarize(revision_queries, f"Revision of: {paper_title}", self.llm_fast)
        logger.info(f"[REVISE] Found {len(evidence_papers)} papers from search")

        user_msg = self.prompts.build_revision_prompt(full, citation_slots=evidence_papers, action_skill=action_skill)
        revision_keys = ["title", "abstract", "body", "stance", "cross_study_connection", "citations", "search_strategy"]
        revision_data = self.llm.call_json(system_prompt, user_msg, json_keys=revision_keys)

        if not revision_data or "title" not in revision_data:
            logger.warning("[REVISE] Failed to get valid JSON from LLM")
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
            revision_data = _clamp_paper_fields(revision_data)
            result = self._submit_with_retry("REVISE", self.school.submit_revision, target_id, revision_data)
            logger.info(f"[REVISE] Submitted for {target_id}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            logger.warning(f"[REVISE] Failed: {e}")
            return None

    def _do_respond(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
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

        # LLM generates search queries based on SKILL.md guidance
        paper_title = target.get("title", "")
        search_plan_msg = self.prompts.build_search_planning_prompt(
            "respond to", paper_title,
            extra_context=f"You gave this paper a score of {my_score}/10. Search for evidence that supports your critique.",
        )
        search_plan = extract_json(self.llm_fast.call(system_prompt, search_plan_msg)) or {}
        respond_queries = search_plan.get("supporting_queries", []) + search_plan.get("opposing_queries", [])
        if not respond_queries:
            respond_queries = [paper_title]
        evidence_papers = search_and_summarize(respond_queries, f"Critique of: {paper_title}", self.llm_fast)
        logger.info(f"[RESPOND] Found {len(evidence_papers)} papers from search")

        user_msg = self.prompts.build_respond_prompt(full, my_score, citation_slots=evidence_papers, action_skill=action_skill)
        respond_keys = ["title", "abstract", "body", "stance", "cross_study_connection",
                        "mechanism_chain", "citations", "search_strategy"]
        response_data = self.llm.call_json(system_prompt, user_msg, json_keys=respond_keys)

        if not response_data or "title" not in response_data:
            logger.warning("[RESPOND] Failed to get valid JSON from LLM")
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
            response_data = _clamp_paper_fields(response_data)
            result = self._submit_with_retry("RESPOND", self.school.submit_revision, paper_id, response_data)
            logger.info(f"[RESPOND] Submitted — id={result.get('response_paper_id')}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[RESPOND] 409 — already responded, moving on")
                return {"status": "already_done"}
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                except Exception:
                    err_msg = str(e)
                logger.warning(f"[RESPOND] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[RESPOND] Failed: {e}")
            return None

    def _do_rebut(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
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

        # LLM generates search queries based on SKILL.md guidance
        paper_title = target.get("title", "")
        search_plan_msg = self.prompts.build_search_planning_prompt(
            "defend", paper_title,
            extra_context=f"Your paper received these criticisms:{criticisms}\nSearch for evidence to support your defense and honestly test if criticisms have merit.",
        )
        search_plan = extract_json(self.llm_fast.call(system_prompt, search_plan_msg)) or {}
        defense_queries = search_plan.get("supporting_queries", []) + search_plan.get("opposing_queries", [])
        if not defense_queries:
            defense_queries = [paper_title]
        evidence_papers = search_and_summarize(defense_queries, f"Defense of: {paper_title}", self.llm_fast)
        logger.info(f"[REBUT] Found {len(evidence_papers)} papers from search")

        user_msg = self.prompts.build_rebut_prompt(full, criticisms, citation_slots=evidence_papers, action_skill=action_skill)
        rebut_keys = ["title", "abstract", "body", "stance", "cross_study_connection",
                      "mechanism_chain", "citations", "search_strategy"]
        rebut_data = self.llm.call_json(system_prompt, user_msg, json_keys=rebut_keys)

        if not rebut_data or "title" not in rebut_data:
            logger.warning("[REBUT] Failed to get valid JSON from LLM")
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
            rebut_data = _clamp_paper_fields(rebut_data)
            result = self._submit_with_retry("REBUT", self.school.submit_revision, paper_id, rebut_data)
            logger.info(f"[REBUT] Submitted — id={result.get('response_paper_id')}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[REBUT] 409 — already rebutted, moving on")
                return {"status": "already_done"}
            if status is not None:
                try:
                    err_body = e.response.json()
                    err_msg = err_body.get("error", str(e))
                except Exception:
                    err_msg = str(e)
                logger.warning(f"[REBUT] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[REBUT] Failed: {e}")
            return None

    # ── Pre-action community work ──────────────────────────────────────────
    #
    # These run BEFORE the main action each cycle. They are lightweight
    # community participation tasks (rating reviews, red team, open questions)
    # that use the fast model and don't block the productive loop.

    def _do_rate_reviews(self, system_prompt: str, profile: dict):
        """Rate other agents' reviews on papers we also reviewed."""
        # Use papers we've reviewed recently from tracked IDs
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        for paper_id in list(tracked_ids)[:3]:
            try:
                full = self.school.get_papers(params={"id": paper_id})
                reviews = []
                if isinstance(full, dict):
                    reviews = full.get("reviews", [])
                elif isinstance(full, list) and full:
                    reviews = full[0].get("reviews", []) if isinstance(full[0], dict) else []
            except Exception:
                continue

            for review in reviews[:3]:
                review_id = review.get("id")
                if not review_id or review.get("reviewer_handle") == self.config.handle:
                    continue
                if not review.get("overall_assessment"):
                    continue

                try:
                    user_msg = self.prompts.build_review_rating_prompt(review)
                    response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                    if not response:
                        continue
                    rating = extract_json(response)
                    if not rating or "helpful" not in rating:
                        continue
                    self.school.submit_review_rating(review_id, rating["helpful"], rating.get("tags", []))
                    logger.info(f"[RATE] Rated review {review_id}: helpful={rating['helpful']}")
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        continue  # already rated
                    logger.debug(f"[RATE] Failed to rate review: {e}")

    def _do_red_team_responses(self, system_prompt: str):
        """File red team interrogations on bounties against our papers."""
        try:
            my_papers = self.school.get_my_papers()
        except Exception:
            return

        originals = [p for p in my_papers if not p.get("parent_paper_id")]
        for paper in originals[:5]:
            paper_id = paper.get("id")
            if not paper_id:
                continue

            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception:
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                if b.get("status") != "pending":
                    continue
                for src in (b.get("external_sources") or [])[:2]:
                    if src.get("red_team_response"):
                        continue
                    doi = src.get("doi", "")
                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    if not doi or not finding:
                        continue

                    try:
                        user_msg = self.prompts.build_red_team_prompt(doi, finding, bridge)
                        interrogation = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not interrogation or len(interrogation.strip()) < 80:
                            continue
                        self.school.submit_red_team(b["id"], doi, interrogation.strip())
                        logger.info(f"[RED_TEAM] Filed interrogation for bounty {b['id']}")
                    except Exception as e:
                        logger.debug(f"[RED_TEAM] Failed: {e}")

    def _do_red_team_jury_vote(self, system_prompt: str):
        """Vote on red team responses for papers we reviewed."""
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        for paper_id in list(tracked_ids)[:5]:
            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception:
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                for src in (b.get("external_sources") or []):
                    rt = src.get("red_team_response")
                    if not rt or rt.get("resolved") or rt.get("my_vote"):
                        continue

                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    interrogation = rt.get("interrogation", "")
                    if not interrogation:
                        continue

                    try:
                        user_msg = self.prompts.build_red_team_vote_prompt(finding, bridge, interrogation)
                        response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not response:
                            continue
                        vote_data = extract_json(response)
                        if not vote_data or "vote" not in vote_data:
                            continue
                        vote = vote_data["vote"]
                        reasoning = str(vote_data.get("reasoning", ""))
                        if vote not in ("upheld", "rejected") or len(reasoning) < 100:
                            continue
                        self.school.vote_red_team(rt.get("id", ""), vote, reasoning)
                        logger.info(f"[JURY] Voted {vote} on red team response")
                        return  # one vote per cycle
                    except Exception as e:
                        logger.debug(f"[JURY] Failed: {e}")

    def _do_reaffirm(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        """Reaffirm a decaying paper with new evidence."""
        reaffirmable = profile.get("reaffirmable_papers", [])
        if not reaffirmable:
            logger.info("[REAFFIRM] No reaffirmable papers")
            return None

        target = reaffirmable[0]
        paper_id = target.get("paper_id")
        if not paper_id:
            return None

        logger.info(f"[REAFFIRM] Targeting paper {paper_id} (raw={target.get('raw_score')}, effective={target.get('effective_score')})")

        try:
            full = self.school.get_papers(params={"id": paper_id})
        except Exception as e:
            logger.warning(f"[REAFFIRM] Failed to fetch paper: {e}")
            return None

        original = full if isinstance(full, dict) else (full[0] if isinstance(full, list) and full else {})
        paper_data = original.get("paper", original)

        user_msg = self.prompts.build_reaffirmation_prompt(paper_data, [], action_skill=action_skill)
        reaffirm_keys = ["title", "abstract", "body", "stance", "cross_study_connection",
                         "citations", "search_strategy"]
        reaffirm_data = self.llm.call_json(system_prompt, user_msg, json_keys=reaffirm_keys)

        if not reaffirm_data or "title" not in reaffirm_data:
            logger.warning("[REAFFIRM] Failed to get valid JSON from LLM")
            return None

        reaffirm_data["stance"] = "reaffirmation"
        reaffirm_data.setdefault("citations", [])
        reaffirm_data.setdefault("search_strategy", {})

        try:
            reaffirm_data = _clamp_paper_fields(reaffirm_data)
            result = self._submit_with_retry("REAFFIRM", self.school.submit_revision, paper_id, reaffirm_data)
            logger.info(f"[REAFFIRM] Submitted for {paper_id}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info("[REAFFIRM] 409 — already reaffirmed, moving on")
                return {"status": "already_done"}
            logger.warning(f"[REAFFIRM] Failed: {e}")
            return None

    def _do_open_questions(self, system_prompt: str):
        """Vote on open questions and occasionally post new ones."""
        try:
            questions = self.school.get_open_questions()
        except Exception:
            return

        # Vote on well-formed questions (one per cycle)
        for q in (questions if isinstance(questions, list) else [])[:5]:
            if q.get("my_vote"):
                continue
            title = q.get("title", "")
            desc = q.get("description", "")
            if len(title) > 30 and len(desc) > 100:
                try:
                    self.school.vote_open_question(q["id"])
                    logger.info(f"[QUESTIONS] Voted on: {title[:50]}...")
                    break
                except Exception as e:
                    logger.debug(f"[QUESTIONS] Vote failed: {e}")

        # 10% chance to post a new question
        if random.random() < 0.1 and len(questions) < 50:
            try:
                user_msg = self.prompts.build_open_question_prompt()
                response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                if not response:
                    return
                q_data = extract_json(response)
                if q_data and q_data.get("title") and q_data.get("description"):
                    self.school.submit_open_question(q_data)
                    logger.info(f"[QUESTIONS] Posted: {q_data['title'][:50]}...")
            except Exception as e:
                logger.debug(f"[QUESTIONS] Post failed: {e}")

    def _do_structural_bounties(self, system_prompt: str, profile: dict):
        """File structural bounties (no_mechanism_chain, weak_source_quality) on bountyable papers."""
        bountyable = profile.get("bountyable_papers", [])
        if not bountyable:
            return

        for paper in bountyable[:5]:
            # No mechanism chain bounty — purely structural, no LLM needed
            if paper.get("missing_mechanism_chain"):
                try:
                    self.school.submit_bounty({
                        "action": "register",
                        "target_paper_id": paper["id"],
                        "challenge_type": "no_mechanism_chain",
                    })
                    logger.info(f"[BOUNTY] Filed no_mechanism_chain on {paper['id']}")
                    return  # one structural bounty per cycle
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        continue
                    logger.debug(f"[BOUNTY] Structural bounty failed: {e}")

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

            action_keys = ["action_type", "content", "reasoning"]
            action_data = self.llm_fast.call_json(system_prompt, user_msg, json_keys=action_keys)

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
