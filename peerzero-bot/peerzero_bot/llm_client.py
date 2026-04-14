"""
LLM Client Abstraction

Provider-agnostic LLM client supporting Anthropic and OpenAI backends.
Handles retries with exponential backoff, structured JSON output via tool_use,
and multi-round tool calling loops for platform integrations.
"""

import json
import threading
import time
import logging

from .utils import sanitize_untrusted

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
    MAX_PAUSE_CONTINUATIONS = 5  # max pause_turn re-sends for server-side tools

    # ── Anthropic server-side tools ──────────────────────────────────────
    # These run on Anthropic's infrastructure — the bot never executes them.
    # The identity drives the parent LLM to use them (e.g., web search for
    # citation verification). Results come back inline in the response.
    ANTHROPIC_SERVER_TOOLS = [
        {"type": "web_search_20250305", "name": "web_search"},
    ]

    def __init__(self, provider: str, model: str, api_key: str, max_tokens: int = 8192,
                 proxy_url: str = "", proxy_key: str = ""):
        self._provider = provider
        self._model = model
        self._api_key = api_key
        self._max_tokens = max_tokens
        self._client = None
        # Proxy mode: route all LLM calls through PeerZero's proxy
        # which injects the identity preamble server-side
        self._proxy_url = proxy_url.rstrip("/") if proxy_url else ""
        self._proxy_key = proxy_key
        # Token meter — accumulates usage from API responses
        self.total_input_tokens: int = 0
        self.total_output_tokens: int = 0
        # Session token exchange: short-lived token replaces sending LLM key each request
        self._session_token: str = ""
        self._session_expires_at: float = 0.0  # UTC timestamp
        self._session_lock = threading.Lock()

    def _get_client(self):
        if self._client is not None:
            return self._client
        if self._proxy_url:
            return None  # Proxy mode — no direct client needed
        if self._provider == "anthropic":
            import anthropic
            self._client = anthropic.Anthropic(
                api_key=self._api_key,
                timeout=300.0,  # 5 min — LLM calls with extended thinking can be slow
            )
        elif self._provider == "openai":
            import openai
            self._client = openai.OpenAI(
                api_key=self._api_key,
                timeout=300.0,
            )
        return self._client

    def _exchange_session_token(self) -> bool:
        """Exchange LLM key + proxy key for a short-lived session token.

        POSTs to {proxy_url}/session and stores the returned token.
        Returns True if exchange succeeded, False otherwise.
        """
        import httpx

        try:
            response = httpx.post(
                f"{self._proxy_url}/session",
                headers={
                    "X-PeerZero-Proxy-Key": self._proxy_key,
                    "X-LLM-Key": self._api_key,
                    "Content-Type": "application/json",
                },
                timeout=10.0,
                verify=True,
            )
            if response.status_code != 200:
                logger.warning(f"[LLM] Session exchange returned {response.status_code}, falling back to key auth")
                return False
            data = response.json()
            self._session_token = data.get("session_token", "")
            expires_at = data.get("expires_at", "")
            if expires_at and self._session_token:
                from datetime import datetime, timezone
                try:
                    self._session_expires_at = datetime.fromisoformat(
                        expires_at.replace("Z", "+00:00")
                    ).timestamp()
                except ValueError:
                    self._session_expires_at = time.time() + 3500  # ~1 hour fallback
                logger.info("[LLM] Session token exchanged successfully")
                return True
            return False
        except Exception as e:
            logger.warning(f"[LLM] Session exchange failed: {type(e).__name__}: {str(e)[:200]}, falling back to key auth")
            return False

    def _get_session_token(self) -> str:
        """Get a valid session token, exchanging if needed. Returns empty string on failure."""
        # Fast path: check without lock — token is still valid
        if self._session_token and time.time() < (self._session_expires_at - 60):
            return self._session_token
        # Slow path: acquire lock to prevent concurrent exchanges
        with self._session_lock:
            # Double-check after acquiring lock (another thread may have refreshed)
            if self._session_token and time.time() < (self._session_expires_at - 60):
                return self._session_token
            if self._exchange_session_token():
                return self._session_token
            return ""

    @staticmethod
    def _system_as_string(system_prompt) -> str:
        """Convert system prompt (str or list of content blocks) to plain string."""
        if isinstance(system_prompt, str):
            return system_prompt
        # List of content blocks — join text fields
        return "\n\n===\n\n".join(
            block.get("text", "") for block in system_prompt
            if isinstance(block, dict) and block.get("text")
        )

    def _proxy_call(self, system_prompt, messages: list,
                    tools: list | None = None, tool_choice: dict | None = None) -> dict:
        """Route an LLM request through the PeerZero proxy.

        system_prompt can be a string (legacy) or list of content block dicts
        (for prompt caching). When a list is provided for Anthropic, blocks are
        sent as-is — the proxy prepends its preamble block and passes through
        any cache_control markers.

        Uses session tokens when available to avoid sending the full LLM key
        on every request. Falls back to key auth if session exchange fails.
        """
        import httpx

        # Try session token first, fall back to direct key
        session_token = self._get_session_token()

        headers = {
            "X-PeerZero-Proxy-Key": self._proxy_key,
            "X-LLM-Provider": self._provider,
            "Content-Type": "application/json",
        }
        if session_token:
            headers["X-Session-Token"] = session_token
        else:
            headers["X-LLM-Key"] = self._api_key

        # Build provider-native request body
        if self._provider == "anthropic":
            # system can be a string or array of content blocks (for caching)
            body: dict = {
                "model": self._model,
                "max_tokens": self._max_tokens,
                "system": system_prompt,
                "messages": messages,
            }
            if tools:
                body["tools"] = tools
            if tool_choice:
                body["tool_choice"] = tool_choice
        elif self._provider == "openai":
            # OpenAI doesn't support content block arrays — flatten to string
            system_str = self._system_as_string(system_prompt)
            body = {
                "model": self._model,
                "max_tokens": self._max_tokens,
                "messages": [{"role": "system", "content": system_str}] + messages,
            }
            if tools:
                body["tools"] = tools
            if tool_choice:
                body["tool_choice"] = tool_choice
        else:
            raise ValueError(f"Unsupported provider for proxy: {self._provider}")

        response = httpx.post(
            f"{self._proxy_url}/v1/messages",
            headers=headers,
            json=body,
            timeout=120.0,
            verify=True,
        )

        # Check for proxy-specific errors
        if response.headers.get("X-Proxy-Error"):
            raise ConnectionError(f"Proxy error: {response.text[:200]}")

        response.raise_for_status()
        data = response.json()
        # Track token usage from API response
        usage = data.get("usage", {})
        self.total_input_tokens += usage.get("input_tokens", 0)
        self.total_output_tokens += usage.get("output_tokens", 0)
        return data

    def _track_usage(self, response) -> None:
        """Extract and accumulate token usage from an SDK response object."""
        usage = getattr(response, "usage", None)
        if usage:
            self.total_input_tokens += getattr(usage, "input_tokens", 0) or 0
            self.total_output_tokens += getattr(usage, "output_tokens", 0) or 0

    @property
    def total_tokens(self) -> int:
        """Total tokens used (input + output) across all calls."""
        return self.total_input_tokens + self.total_output_tokens

    def reset_meter(self) -> None:
        """Reset the token meter (e.g., at the start of a new cycle)."""
        self.total_input_tokens = 0
        self.total_output_tokens = 0

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

    @staticmethod
    def _extract_text_from_content(content) -> str:
        """Extract all text from a response content array, skipping tool blocks.

        Works with both SDK objects (direct mode) and dicts (proxy mode).
        Server-side tool use/result blocks are skipped — only text blocks
        are concatenated into the final response.
        """
        parts = []
        for block in content:
            # SDK object (direct mode)
            if hasattr(block, "type"):
                if block.type == "text":
                    parts.append(block.text)
            # Dict (proxy mode)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts) if parts else ""

    def call(self, system_prompt, user_message: str) -> str:
        """Call the LLM with retry on transient failures. Returns response text.

        system_prompt: str or list of content block dicts (for prompt caching).
        When a list is provided, blocks may include cache_control markers for
        Anthropic's prompt caching. The Anthropic SDK and proxy both accept
        system as an array of content blocks natively.

        For Anthropic, automatically includes server-side tools (web search)
        so the identity can drive the parent LLM to verify claims. The bot
        never sees or handles these tools — Anthropic executes them server-side
        and returns results inline. If the server-side tool loop hits its
        iteration limit (stop_reason='pause_turn'), the response is re-sent
        to continue.
        """
        last_exc = None

        for attempt in range(self.MAX_RETRIES + 1):
            try:
                # ── Proxy mode ──────────────────────────────────────────
                if self._proxy_url:
                    messages = [{"role": "user", "content": user_message}]
                    tools = self.ANTHROPIC_SERVER_TOOLS if self._provider == "anthropic" else None

                    for _ in range(self.MAX_PAUSE_CONTINUATIONS + 1):
                        result = self._proxy_call(system_prompt, messages, tools=tools)

                        if self._provider == "anthropic":
                            content = result.get("content", [])
                            stop = result.get("stop_reason", "end_turn")

                            if stop == "pause_turn" and content:
                                # Server-side tool loop hit limit — re-send to continue
                                messages = [
                                    {"role": "user", "content": user_message},
                                    {"role": "assistant", "content": content},
                                ]
                                continue

                            text = self._extract_text_from_content(content)
                            return text if text else str(result)

                        elif self._provider == "openai":
                            if result.get("choices"):
                                return result["choices"][0]["message"]["content"]
                            return str(result)

                    # Exhausted pause continuations — return what we have
                    return self._extract_text_from_content(result.get("content", []))

                # ── Direct mode ─────────────────────────────────────────
                client = self._get_client()
                if self._provider == "anthropic":
                    messages = [{"role": "user", "content": user_message}]

                    for _ in range(self.MAX_PAUSE_CONTINUATIONS + 1):
                        response = client.messages.create(
                            model=self._model,
                            max_tokens=self._max_tokens,
                            system=system_prompt,
                            messages=messages,
                            tools=self.ANTHROPIC_SERVER_TOOLS,
                        )

                        self._track_usage(response)

                        if response.stop_reason == "max_tokens":
                            logger.warning(f"[LLM] Response truncated (hit max_tokens={self._max_tokens})")

                        if response.stop_reason == "pause_turn":
                            # Server-side tool loop hit limit — re-send to continue
                            messages = [
                                {"role": "user", "content": user_message},
                                {"role": "assistant", "content": response.content},
                            ]
                            continue

                        return self._extract_text_from_content(response.content)

                    # Exhausted pause continuations
                    return self._extract_text_from_content(response.content)

                elif self._provider == "openai":
                    # OpenAI doesn't support content block arrays — flatten
                    system_str = self._system_as_string(system_prompt)
                    response = client.chat.completions.create(
                        model=self._model,
                        max_tokens=self._max_tokens,
                        messages=[
                            {"role": "system", "content": system_str},
                            {"role": "user", "content": user_message},
                        ],
                    )
                    self._track_usage(response)
                    return response.choices[0].message.content
                else:
                    raise ValueError(f"Unknown LLM provider: {self._provider}")
            except Exception as e:
                last_exc = e
                if attempt < self.MAX_RETRIES and self._is_retryable(e):
                    delay = self.BASE_DELAY * (2 ** attempt)
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

    def call_json(self, system_prompt, user_message: str, json_keys: list[str] | None = None) -> dict | None:
        """Call LLM and force JSON output via tool_use (Anthropic) or json mode (OpenAI).

        system_prompt: str or list of content block dicts (for prompt caching).

        For Anthropic: uses tool_use with tool_choice=tool to guarantee valid JSON.
        Server-side tools (web search) are included alongside submit_result so
        the parent LLM can verify claims before producing structured output.
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

        # Phase 1: Tool use (Anthropic only — works in both direct and proxy mode)
        if self._provider == "anthropic":
            try:
                tool_instruction = "\n\nUse the submit_result tool to return your output. Do not write text outside the tool call."
                if isinstance(system_prompt, list):
                    # Append instruction to the last content block (dynamic layer)
                    system_with_tool = list(system_prompt)  # shallow copy
                    if system_with_tool:
                        last = dict(system_with_tool[-1])  # copy last block
                        last["text"] = last.get("text", "") + tool_instruction
                        system_with_tool[-1] = last
                    else:
                        system_with_tool = [{"type": "text", "text": tool_instruction.strip()}]
                else:
                    system_with_tool = system_prompt + tool_instruction

                if self._proxy_url:
                    # Proxy mode: send tool_use request through proxy
                    # Include server-side tools so LLM can search before producing JSON
                    all_tools = self.ANTHROPIC_SERVER_TOOLS + [tool]
                    result_data = self._proxy_call(
                        system_with_tool,
                        [{"role": "user", "content": user_message}],
                        tools=all_tools,
                        tool_choice={"type": "tool", "name": "submit_result"},
                    )
                    if result_data.get("stop_reason") == "max_tokens":
                        logger.warning(f"[LLM] tool_use truncated at max_tokens={self._max_tokens}")
                    for block in result_data.get("content", []):
                        if block.get("type") == "tool_use" and block.get("name") == "submit_result":
                            result = block.get("input", {})
                            if isinstance(result, dict) and result:
                                logger.info(f"[LLM] JSON extracted via proxy tool_use ({len(result)} keys: {list(result.keys())[:5]})")
                                return result
                    logger.warning("[LLM] proxy tool_use returned no valid result, falling back to text")
                else:
                    # Direct mode — include server-side tools alongside submit_result
                    client = self._get_client()
                    all_tools = self.ANTHROPIC_SERVER_TOOLS + [tool]
                    response = client.messages.create(
                        model=self._model,
                        max_tokens=self._max_tokens,
                        system=system_with_tool,
                        messages=[{"role": "user", "content": user_message}],
                        tools=all_tools,
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

    def call_best_effort(self, system_prompt, user_message: str) -> str | None:
        """Call the LLM once with no retries.  Returns None on any failure.

        system_prompt: str or list of content block dicts (for prompt caching).

        Used for non-critical work (identity reflection, private block) where
        blocking the cycle with retries is worse than skipping.
        """
        try:
            # ── Proxy mode ──────────────────────────────────────────
            if self._proxy_url:
                messages = [{"role": "user", "content": user_message}]
                result = self._proxy_call(system_prompt, messages)
                if self._provider == "anthropic":
                    content = result.get("content", [])
                    return self._extract_text_from_content(content) or None
                elif self._provider == "openai":
                    if result.get("choices"):
                        return result["choices"][0]["message"]["content"]
                return None

            # ── Direct mode ─────────────────────────────────────────
            client = self._get_client()
            if self._provider == "anthropic":
                # SDK accepts system as str or list of content blocks
                response = client.messages.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_message}],
                )
                self._track_usage(response)
                return response.content[0].text if response.content else None
            elif self._provider == "openai":
                system_str = self._system_as_string(system_prompt)
                response = client.chat.completions.create(
                    model=self._model,
                    max_tokens=self._max_tokens,
                    messages=[
                        {"role": "system", "content": system_str},
                        {"role": "user", "content": user_message},
                    ],
                )
                self._track_usage(response)
                return response.choices[0].message.content if response.choices else None
            else:
                return None
        except Exception as e:
            err_summary = str(e)[:200]
            logger.warning(f"[LLM] Best-effort call failed (non-blocking): {err_summary}")
            return None

    def call_with_tools(
        self,
        system_prompt,
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
            # No tools — fall back to simple call (which includes server-side tools)
            text = self.call(system_prompt, user_message)
            return ToolUseResult(text=text)

        # Include server-side tools alongside user-defined platform tools.
        # Server-side tools (web search) are executed by Anthropic — the bot
        # never handles them. They appear as server_tool_use blocks in the
        # response and are skipped by the tool execution loop below.
        if self._provider == "anthropic":
            tools = self.ANTHROPIC_SERVER_TOOLS + list(tools)

        # ── Proxy mode: route tool loop through proxy ─────────────
        # The proxy injects the identity preamble on every call.
        # Tool loops make multiple calls — each one must go through
        # the proxy so the preamble is present on every round.
        if self._proxy_url:
            result = self._proxy_tool_loop(
                system_prompt, user_message, tools,
                tool_executor, autonomy_gate, platform_name,
            )
            return result

        # ── Direct mode ───────────────────────────────────────────
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

    def _proxy_tool_loop(
        self, system_prompt, user_message, tools,
        tool_executor, autonomy_gate, platform_name,
    ) -> "ToolUseResult":
        """Tool use loop routed through the proxy (preamble injected every round).

        Mirrors _anthropic_tool_loop but uses _proxy_call() instead of direct
        SDK calls. Works with dicts (proxy responses) instead of SDK objects.
        """
        # Convert tools to Anthropic format for the proxy
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
                response = self._proxy_call(
                    system_prompt, messages, tools=anthropic_tools,
                )
            except Exception as e:
                if self._is_retryable(e):
                    logger.warning(f"[LLM] Proxy tool loop retry: {type(e).__name__}: {str(e)[:200]}")
                    time.sleep(self.BASE_DELAY)
                    continue
                raise

            content = response.get("content", [])
            stop_reason = response.get("stop_reason", "end_turn")

            # Process response blocks (dicts from proxy, not SDK objects)
            text_parts = []
            tool_uses = []

            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                    elif block.get("type") == "tool_use":
                        tool_uses.append(block)

            if text_parts:
                result.text = "\n".join(text_parts)

            if not tool_uses or stop_reason == "end_turn":
                break

            # Server-side tool loop hit iteration limit — re-send to continue
            if stop_reason == "pause_turn" and not tool_uses:
                messages = [
                    {"role": "user", "content": user_message},
                    {"role": "assistant", "content": content},
                ]
                continue

            # Execute tool calls
            messages.append({"role": "assistant", "content": content})
            tool_results = []

            for tool_use in tool_uses:
                tool_name = tool_use.get("name", "")
                arguments = tool_use.get("input", {})
                tool_use_id = tool_use.get("id", "")

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
                            "tool_use_id": tool_use_id,
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

                # Sanitize tool output to prevent prompt injection from MCP tool results
                sanitized_output = sanitize_untrusted(output_text[:10000], "tool_output")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": sanitized_output,
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

            # If no user-defined tool uses, we're done (server-side tools
            # are handled inline by Anthropic — they don't produce tool_use blocks)
            if not tool_uses or response.stop_reason == "end_turn":
                break

            # Server-side tool loop hit iteration limit — re-send to continue
            if response.stop_reason == "pause_turn" and not tool_uses:
                messages = [
                    {"role": "user", "content": user_message},
                    {"role": "assistant", "content": response.content},
                ]
                continue

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

                # Sanitize tool output to prevent prompt injection from MCP tool results
                sanitized_output = sanitize_untrusted(output_text[:10000], "tool_output")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": sanitized_output,
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

        system_str = self._system_as_string(system_prompt)
        messages = [
            {"role": "system", "content": system_str},
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
                    is_error = tool_output.get("is_error", False)
                except Exception as e:
                    output_text = f"Tool execution error: {e}"
                    is_error = True

                # Sanitize tool output to prevent prompt injection from MCP tool results
                sanitized_output = sanitize_untrusted(output_text[:10000], "tool_output")

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": sanitized_output,
                })
                result.tool_calls.append({
                    "tool": tool_name,
                    "arguments": arguments,
                    "output": output_text[:500],
                    "is_error": is_error,
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
