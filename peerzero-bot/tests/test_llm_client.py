"""Tests for the LLMClient module."""

import json
import sys
import pytest
from unittest.mock import MagicMock, patch, PropertyMock

from peerzero_bot.llm_client import LLMClient, ToolUseResult, _clamp_paper_fields


# ═════════════════════════════════════════════════════════════════════════════
# HELPER
# ═════════════════════════════════════════════════════════════════════════════

def _make_client(provider="anthropic", proxy_url="", **kwargs):
    """Create an LLMClient with sensible defaults."""
    defaults = dict(
        provider=provider,
        model="test-model",
        api_key="test-key",
        max_tokens=1024,
        proxy_url=proxy_url,
        proxy_key="proxy-key" if proxy_url else "",
    )
    defaults.update(kwargs)
    return LLMClient(**defaults)


# ═════════════════════════════════════════════════════════════════════════════
# CLAMP PAPER FIELDS
# ═════════════════════════════════════════════════════════════════════════════

class TestClampPaperFields:
    def test_clamp_title(self):
        data = {"title": "x" * 500}
        result = _clamp_paper_fields(data)
        assert len(result["title"]) == 300

    def test_clamp_abstract(self):
        data = {"abstract": "x" * 3000}
        result = _clamp_paper_fields(data)
        assert len(result["abstract"]) == 2000

    def test_clamp_citation_fields(self):
        data = {
            "citations": [
                {
                    "agent_summary": "x" * 2000,
                    "relevance_explanation": "y" * 1000,
                    "source_quality_note": "z" * 3000,
                },
            ],
        }
        result = _clamp_paper_fields(data)
        assert len(result["citations"][0]["agent_summary"]) == 1000
        assert len(result["citations"][0]["relevance_explanation"]) == 500
        assert len(result["citations"][0]["source_quality_note"]) == 2000

    def test_passthrough_short_fields(self):
        data = {"title": "Short Title", "abstract": "Short abstract", "body": "Body text"}
        result = _clamp_paper_fields(data)
        assert result["title"] == "Short Title"
        assert result["abstract"] == "Short abstract"

    def test_no_citations(self):
        data = {"title": "Test"}
        result = _clamp_paper_fields(data)
        assert result == {"title": "Test"}


# ═════════════════════════════════════════════════════════════════════════════
# TOOL USE RESULT
# ═════════════════════════════════════════════════════════════════════════════

class TestToolUseResult:
    def test_default_values(self):
        result = ToolUseResult()
        assert result.text == ""
        assert result.tool_calls == []
        assert result.blocked_calls == []
        assert result.used_tools is False
        assert result.had_blocked_calls is False

    def test_with_text(self):
        result = ToolUseResult(text="Hello")
        assert result.text == "Hello"

    def test_used_tools_property(self):
        result = ToolUseResult(tool_calls=[{"tool": "search"}])
        assert result.used_tools is True

    def test_had_blocked_calls_property(self):
        result = ToolUseResult(blocked_calls=[{"tool": "delete", "reason": "blocked"}])
        assert result.had_blocked_calls is True

    def test_no_tools_used(self):
        result = ToolUseResult(text="just text")
        assert result.used_tools is False
        assert result.had_blocked_calls is False


# ═════════════════════════════════════════════════════════════════════════════
# CONSTRUCTOR
# ═════════════════════════════════════════════════════════════════════════════

class TestLLMClientConstructor:
    def test_anthropic_provider(self):
        client = _make_client(provider="anthropic")
        assert client._provider == "anthropic"
        assert client._model == "test-model"

    def test_openai_provider(self):
        client = _make_client(provider="openai")
        assert client._provider == "openai"

    def test_proxy_url_stripped(self):
        client = _make_client(proxy_url="https://proxy.example.com/")
        assert client._proxy_url == "https://proxy.example.com"

    def test_no_proxy(self):
        client = _make_client()
        assert client._proxy_url == ""

    def test_client_not_initialized_until_used(self):
        client = _make_client()
        assert client._client is None


# ═════════════════════════════════════════════════════════════════════════════
# _is_retryable
# ═════════════════════════════════════════════════════════════════════════════

class TestIsRetryable:
    def test_rate_limit_error(self):
        exc = type("RateLimitError", (Exception,), {})()
        assert LLMClient._is_retryable(exc) is True

    def test_api_timeout_error(self):
        exc = type("APITimeoutError", (Exception,), {})()
        assert LLMClient._is_retryable(exc) is True

    def test_api_connection_error(self):
        exc = type("APIConnectionError", (Exception,), {})()
        assert LLMClient._is_retryable(exc) is True

    def test_internal_server_error(self):
        exc = type("InternalServerError", (Exception,), {})()
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_429(self):
        exc = Exception("rate limit")
        exc.status_code = 429
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_500(self):
        exc = Exception("server error")
        exc.status_code = 500
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_502(self):
        exc = Exception("bad gateway")
        exc.status_code = 502
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_503(self):
        exc = Exception("service unavailable")
        exc.status_code = 503
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_529(self):
        exc = Exception("overloaded")
        exc.status_code = 529
        assert LLMClient._is_retryable(exc) is True

    def test_connection_error(self):
        exc = ConnectionError("refused")
        assert LLMClient._is_retryable(exc) is True

    def test_timeout_error(self):
        exc = TimeoutError("timed out")
        assert LLMClient._is_retryable(exc) is True

    def test_status_code_400_not_retryable(self):
        exc = Exception("bad request")
        exc.status_code = 400
        assert LLMClient._is_retryable(exc) is False

    def test_status_code_401_not_retryable(self):
        exc = Exception("unauthorized")
        exc.status_code = 401
        assert LLMClient._is_retryable(exc) is False

    def test_generic_exception_not_retryable(self):
        exc = ValueError("bad value")
        assert LLMClient._is_retryable(exc) is False

    def test_type_error_not_retryable(self):
        exc = TypeError("wrong type")
        assert LLMClient._is_retryable(exc) is False


# ═════════════════════════════════════════════════════════════════════════════
# _extract_text_from_content
# ═════════════════════════════════════════════════════════════════════════════

class TestExtractTextFromContent:
    def test_dict_text_blocks(self):
        content = [
            {"type": "text", "text": "Hello"},
            {"type": "text", "text": "World"},
        ]
        assert LLMClient._extract_text_from_content(content) == "Hello\nWorld"

    def test_sdk_objects(self):
        block1 = MagicMock()
        block1.type = "text"
        block1.text = "Hello"
        block2 = MagicMock()
        block2.type = "tool_use"
        block2.name = "search"
        assert LLMClient._extract_text_from_content([block1, block2]) == "Hello"

    def test_empty_content(self):
        assert LLMClient._extract_text_from_content([]) == ""

    def test_only_tool_blocks(self):
        content = [{"type": "tool_use", "name": "search"}]
        assert LLMClient._extract_text_from_content(content) == ""

    def test_mixed_dict_blocks(self):
        content = [
            {"type": "text", "text": "Result:"},
            {"type": "server_tool_use", "name": "web_search"},
            {"type": "server_tool_result"},
            {"type": "text", "text": "Found it"},
        ]
        assert LLMClient._extract_text_from_content(content) == "Result:\nFound it"


# ═════════════════════════════════════════════════════════════════════════════
# call() — DIRECT MODE
# ═════════════════════════════════════════════════════════════════════════════

class TestCallDirect:
    @patch("peerzero_bot.llm_client.time.sleep")
    def test_anthropic_call_returns_text(self, mock_sleep):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "The answer is 42"
        response = MagicMock()
        response.content = [text_block]
        response.stop_reason = "end_turn"
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        result = client.call("You are a bot", "What is the meaning of life?")
        assert result == "The answer is 42"

    @patch("peerzero_bot.llm_client.time.sleep")
    def test_openai_call_returns_text(self, mock_sleep):
        client = _make_client(provider="openai")
        mock_sdk = MagicMock()
        choice = MagicMock()
        choice.message.content = "OpenAI response"
        response = MagicMock()
        response.choices = [choice]
        mock_sdk.chat.completions.create.return_value = response
        client._client = mock_sdk

        result = client.call("You are a bot", "Hello")
        assert result == "OpenAI response"

    @patch("peerzero_bot.llm_client.time.sleep")
    def test_retries_on_retryable_error(self, mock_sleep):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()

        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "success"
        success_response = MagicMock()
        success_response.content = [text_block]
        success_response.stop_reason = "end_turn"

        rate_limit = type("RateLimitError", (Exception,), {})("rate limited")
        mock_sdk.messages.create.side_effect = [rate_limit, success_response]
        client._client = mock_sdk

        result = client.call("sys", "msg")
        assert result == "success"
        assert mock_sdk.messages.create.call_count == 2
        mock_sleep.assert_called_once()

    @patch("peerzero_bot.llm_client.time.sleep")
    def test_does_not_retry_non_retryable(self, mock_sleep):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        mock_sdk.messages.create.side_effect = ValueError("bad input")
        client._client = mock_sdk

        with pytest.raises(ValueError, match="bad input"):
            client.call("sys", "msg")
        assert mock_sdk.messages.create.call_count == 1
        mock_sleep.assert_not_called()

    @patch("peerzero_bot.llm_client.time.sleep")
    def test_raises_after_max_retries(self, mock_sleep):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        rate_limit = type("RateLimitError", (Exception,), {})("rate limited")
        mock_sdk.messages.create.side_effect = rate_limit
        client._client = mock_sdk

        with pytest.raises(Exception, match="rate limited"):
            client.call("sys", "msg")
        assert mock_sdk.messages.create.call_count == LLMClient.MAX_RETRIES + 1

    def test_unknown_provider_raises(self):
        client = _make_client(provider="unknown")
        client._client = MagicMock()  # Avoid _get_client logic
        with pytest.raises(ValueError, match="Unknown LLM provider"):
            client.call("sys", "msg")

    @patch("peerzero_bot.llm_client.time.sleep")
    def test_pause_turn_continues(self, mock_sleep):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()

        # First response: pause_turn
        pause_block = MagicMock()
        pause_block.type = "text"
        pause_block.text = "partial"
        pause_response = MagicMock()
        pause_response.content = [pause_block]
        pause_response.stop_reason = "pause_turn"

        # Second response: end_turn
        final_block = MagicMock()
        final_block.type = "text"
        final_block.text = "complete"
        final_response = MagicMock()
        final_response.content = [final_block]
        final_response.stop_reason = "end_turn"

        mock_sdk.messages.create.side_effect = [pause_response, final_response]
        client._client = mock_sdk

        result = client.call("sys", "msg")
        assert result == "complete"
        assert mock_sdk.messages.create.call_count == 2


# ═════════════════════════════════════════════════════════════════════════════
# call() — PROXY MODE
# ═════════════════════════════════════════════════════════════════════════════

class TestCallProxy:
    def test_proxy_anthropic_call(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", return_value={
            "content": [{"type": "text", "text": "Proxy response"}],
            "stop_reason": "end_turn",
        }):
            result = client.call("sys", "msg")
            assert result == "Proxy response"

    def test_proxy_openai_call(self):
        client = _make_client(provider="openai", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", return_value={
            "choices": [{"message": {"content": "OpenAI via proxy"}}],
        }):
            result = client.call("sys", "msg")
            assert result == "OpenAI via proxy"

    def test_proxy_pause_turn_continues(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", side_effect=[
            {
                "content": [{"type": "text", "text": "partial"}],
                "stop_reason": "pause_turn",
            },
            {
                "content": [{"type": "text", "text": "complete"}],
                "stop_reason": "end_turn",
            },
        ]):
            result = client.call("sys", "msg")
            assert result == "complete"

    def test_proxy_call_sends_correct_headers(self):
        """Test _proxy_call by mocking httpx at import time."""
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")
        client._session_token = "test-token"
        client._session_expires_at = 9999999999.0

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {}
        mock_response.json.return_value = {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
        mock_response.raise_for_status = MagicMock()

        mock_httpx = MagicMock()
        mock_httpx.post.return_value = mock_response
        with patch.dict(sys.modules, {"httpx": mock_httpx}):
            result = client._proxy_call("sys", [{"role": "user", "content": "msg"}])
            assert result["content"][0]["text"] == "ok"
            call_kwargs = mock_httpx.post.call_args
            headers = call_kwargs[1]["headers"] if "headers" in call_kwargs[1] else call_kwargs[0][1] if len(call_kwargs[0]) > 1 else call_kwargs.kwargs["headers"]
            assert headers["X-Session-Token"] == "test-token"

    def test_proxy_error_raises(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")
        client._session_token = "test-token"
        client._session_expires_at = 9999999999.0

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"X-Proxy-Error": "true"}
        mock_response.text = "Proxy failed"
        mock_response.raise_for_status = MagicMock()

        mock_httpx = MagicMock()
        mock_httpx.post.return_value = mock_response
        with patch.dict(sys.modules, {"httpx": mock_httpx}):
            with pytest.raises(ConnectionError, match="Proxy error"):
                client._proxy_call("sys", [{"role": "user", "content": "msg"}])


# ═════════════════════════════════════════════════════════════════════════════
# call_json()
# ═════════════════════════════════════════════════════════════════════════════

class TestCallJson:
    def test_tool_use_direct_mode(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()

        tool_block = MagicMock()
        tool_block.type = "tool_use"
        tool_block.name = "submit_result"
        tool_block.input = {"title": "Test", "abstract": "Abstract", "body": "Body"}

        response = MagicMock()
        response.content = [tool_block]
        response.stop_reason = "tool_use"
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        result = client.call_json("sys", "msg", json_keys=["title", "abstract", "body"])
        assert result == {"title": "Test", "abstract": "Abstract", "body": "Body"}

    def test_tool_use_proxy_mode(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", return_value={
            "content": [
                {"type": "tool_use", "name": "submit_result", "input": {"score": 7.5, "assessment": "Good"}},
            ],
            "stop_reason": "tool_use",
        }):
            result = client.call_json("sys", "msg", json_keys=["score", "assessment"])
            assert result == {"score": 7.5, "assessment": "Good"}

    def test_fallback_to_text_extraction(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        # Tool use returns no valid result
        text_block = MagicMock()
        text_block.type = "text"
        text_block.name = None
        response = MagicMock()
        response.content = [text_block]
        response.stop_reason = "end_turn"
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        # Fallback: mock call() to return JSON text, and extract_json to parse it
        with patch.object(client, "call", return_value='{"score": 8.0}'):
            with patch("peerzero_bot.adapters.school.extract_json", return_value={"score": 8.0}):
                result = client.call_json("sys", "msg", json_keys=["score"])
                assert result == {"score": 8.0}

    def test_returns_none_on_total_failure(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        mock_sdk.messages.create.side_effect = Exception("SDK error")
        client._client = mock_sdk

        # Also mock call() to fail
        with patch.object(client, "call", side_effect=Exception("also failed")):
            result = client.call_json("sys", "msg")
            assert result is None

    def test_openai_skips_tool_use_goes_to_fallback(self):
        client = _make_client(provider="openai")

        # OpenAI doesn't use tool_use phase, goes straight to call() fallback
        with patch.object(client, "call", return_value='{"score": 5.0}'):
            with patch("peerzero_bot.adapters.school.extract_json", return_value={"score": 5.0}):
                result = client.call_json("sys", "msg", json_keys=["score"])
                assert result == {"score": 5.0}

    def test_default_json_keys(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        tool_block = MagicMock()
        tool_block.type = "tool_use"
        tool_block.name = "submit_result"
        tool_block.input = {"title": "T", "abstract": "A", "body": "B"}
        response = MagicMock()
        response.content = [tool_block]
        response.stop_reason = "tool_use"
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        result = client.call_json("sys", "msg")  # No json_keys — uses defaults
        assert result is not None


# ═════════════════════════════════════════════════════════════════════════════
# call_best_effort()
# ═════════════════════════════════════════════════════════════════════════════

class TestCallBestEffort:
    def test_returns_text_on_success(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        text_block = MagicMock()
        text_block.text = "Best effort response"
        response = MagicMock()
        response.content = [text_block]
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        result = client.call_best_effort("sys", "msg")
        assert result == "Best effort response"

    def test_returns_none_on_failure(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        mock_sdk.messages.create.side_effect = Exception("network error")
        client._client = mock_sdk

        result = client.call_best_effort("sys", "msg")
        assert result is None

    def test_openai_returns_text(self):
        client = _make_client(provider="openai")
        mock_sdk = MagicMock()
        choice = MagicMock()
        choice.message.content = "OpenAI best effort"
        response = MagicMock()
        response.choices = [choice]
        mock_sdk.chat.completions.create.return_value = response
        client._client = mock_sdk

        result = client.call_best_effort("sys", "msg")
        assert result == "OpenAI best effort"

    def test_unknown_provider_returns_none(self):
        client = _make_client(provider="unknown")
        result = client.call_best_effort("sys", "msg")
        assert result is None

    def test_proxy_mode_anthropic(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", return_value={
            "content": [{"type": "text", "text": "Proxy best effort"}],
        }):
            result = client.call_best_effort("sys", "msg")
            assert result == "Proxy best effort"

    def test_proxy_mode_returns_none_on_failure(self):
        client = _make_client(provider="anthropic", proxy_url="https://proxy.example.com")

        with patch.object(client, "_proxy_call", side_effect=Exception("proxy down")):
            result = client.call_best_effort("sys", "msg")
            assert result is None


# ═════════════════════════════════════════════════════════════════════════════
# call_with_tools()
# ═════════════════════════════════════════════════════════════════════════════

class TestCallWithTools:
    def test_no_tools_falls_back_to_call(self):
        client = _make_client(provider="anthropic")
        mock_sdk = MagicMock()
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "No tools needed"
        response = MagicMock()
        response.content = [text_block]
        response.stop_reason = "end_turn"
        mock_sdk.messages.create.return_value = response
        client._client = mock_sdk

        result = client.call_with_tools("sys", "msg", tools=[], tool_executor=MagicMock())
        assert result.text == "No tools needed"
        assert result.used_tools is False

    def test_unknown_provider_raises(self):
        client = _make_client(provider="unknown")
        client._client = MagicMock()
        tools = [{"name": "test", "description": "test", "input_schema": {"type": "object", "properties": {}}}]
        with pytest.raises(ValueError, match="Unknown LLM provider"):
            client.call_with_tools("sys", "msg", tools=tools, tool_executor=MagicMock())


# ═════════════════════════════════════════════════════════════════════════════
# _get_client
# ═════════════════════════════════════════════════════════════════════════════

class TestGetClient:
    def test_proxy_mode_returns_none(self):
        client = _make_client(proxy_url="https://proxy.example.com")
        result = client._get_client()
        assert result is None

    def test_anthropic_creates_client(self):
        client = _make_client(provider="anthropic")
        mock_anthropic_module = MagicMock()
        with patch.dict(sys.modules, {"anthropic": mock_anthropic_module}):
            sdk_client = client._get_client()
            mock_anthropic_module.Anthropic.assert_called_once_with(api_key="test-key")

    def test_caches_client(self):
        client = _make_client(provider="anthropic")
        mock_client = MagicMock()
        client._client = mock_client
        assert client._get_client() is mock_client


# ═════════════════════════════════════════════════════════════════════════════
# SESSION TOKEN EXCHANGE
# ═════════════════════════════════════════════════════════════════════════════

class TestSessionTokenExchange:
    def test_exchange_success(self):
        client = _make_client(proxy_url="https://proxy.example.com")
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "session_token": "abc123",
            "expires_at": "2099-01-01T00:00:00Z",
        }
        mock_httpx = MagicMock()
        mock_httpx.post.return_value = mock_response
        with patch.dict(sys.modules, {"httpx": mock_httpx}):
            result = client._exchange_session_token()
            assert result is True
            assert client._session_token == "abc123"

    def test_exchange_failure_status(self):
        client = _make_client(proxy_url="https://proxy.example.com")
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_httpx = MagicMock()
        mock_httpx.post.return_value = mock_response
        with patch.dict(sys.modules, {"httpx": mock_httpx}):
            result = client._exchange_session_token()
            assert result is False

    def test_exchange_network_error(self):
        client = _make_client(proxy_url="https://proxy.example.com")
        mock_httpx = MagicMock()
        mock_httpx.post.side_effect = Exception("network down")
        with patch.dict(sys.modules, {"httpx": mock_httpx}):
            result = client._exchange_session_token()
            assert result is False

    def test_get_session_token_reuses_valid(self):
        client = _make_client(proxy_url="https://proxy.example.com")
        client._session_token = "valid-token"
        client._session_expires_at = 9999999999.0
        assert client._get_session_token() == "valid-token"


# ═════════════════════════════════════════════════════════════════════════════
# FIELD TYPE SCHEMA
# ═════════════════════════════════════════════════════════════════════════════

class TestFieldTypes:
    def test_known_array_fields(self):
        assert LLMClient._FIELD_TYPES["citations"]["type"] == "array"
        assert LLMClient._FIELD_TYPES["field_ids"]["type"] == "array"

    def test_known_number_fields(self):
        assert LLMClient._FIELD_TYPES["score"]["type"] == "number"
        assert LLMClient._FIELD_TYPES["confidence_score"]["type"] == "number"

    def test_known_boolean_fields(self):
        assert LLMClient._FIELD_TYPES["skip"]["type"] == "boolean"

    def test_known_object_fields(self):
        assert LLMClient._FIELD_TYPES["search_strategy"]["type"] == "object"
        assert LLMClient._FIELD_TYPES["content"]["type"] == "object"
