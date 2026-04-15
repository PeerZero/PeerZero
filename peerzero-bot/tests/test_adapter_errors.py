"""Tests for adapter error recovery — network failures, malformed data, security blocks."""

import json
from unittest.mock import patch, MagicMock, PropertyMock

import httpx
import pytest

from peerzero_bot.security import SecurityGateway, SecurityError
from peerzero_bot.adapters.school import SchoolAdapter, extract_json, CircuitOpenError
from peerzero_bot.adapters.a2a import A2AAdapter
from peerzero_bot.adapters.webhook import WebhookAdapter
from peerzero_bot.adapters.base import PlatformAction


# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_school(gateway=None) -> SchoolAdapter:
    gw = gateway or SecurityGateway()
    return SchoolAdapter(
        school_url="https://school.peerzero.com",
        api_key="test-key",
        gateway=gw,
    )


def _make_a2a(gateway=None) -> A2AAdapter:
    gw = gateway or SecurityGateway()
    return A2AAdapter(
        platform_name="test_a2a",
        platform_url="https://a2a.example.com",
        agent_card_url="https://a2a.example.com/.well-known/agent-card.json",
        api_key="test-key",
        gateway=gw,
    )


def _make_webhook(gateway=None, events=None) -> WebhookAdapter:
    gw = gateway or SecurityGateway()
    return WebhookAdapter(
        platform_name="test_webhook",
        platform_url="https://webhook.example.com",
        api_key="test-key",
        gateway=gw,
        events=events or ["post", "comment"],
    )


def _mock_http_status_error(status_code: int = 500) -> httpx.HTTPStatusError:
    """Build a realistic HTTPStatusError with a mocked response."""
    request = httpx.Request("GET", "https://school.peerzero.com/api/skill")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(
        message=f"Server error {status_code}",
        request=request,
        response=response,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# 1. extract_json — deeply malformed inputs
# ═══════════════════════════════════════════════════════════════════════════════


class TestExtractJsonMalformed:
    """extract_json should return None for truly unparseable garbage."""

    def test_empty_string(self):
        assert extract_json("") is None

    def test_none_input(self):
        assert extract_json(None) is None

    def test_pure_text_no_json(self):
        assert extract_json("This is just plain English with no JSON at all.") is None

    def test_truncated_json(self):
        """JSON cut off mid-value — no closing brace."""
        assert extract_json('{"title": "Incomplete paper", "abstract": "We find tha') is None

    def test_nested_broken_json(self):
        """Nested structure with corruption inside inner object."""
        broken = '{"outer": {"inner": {"key": INVALID_TOKEN}, "other": 42}}'
        assert extract_json(broken) is None

    def test_deeply_nested_valid_json_embedded(self):
        """Valid JSON buried in surrounding prose should be extracted."""
        text = 'Here is my analysis:\n\n{"score": 7, "reasoning": "solid work"}\n\nThat is all.'
        result = extract_json(text)
        assert result is not None
        assert result["score"] == 7

    def test_multiple_json_objects_returns_first(self):
        """When multiple JSON objects exist, the first dict wins."""
        text = '{"a": 1} and then {"b": 2}'
        result = extract_json(text)
        assert result == {"a": 1}

    def test_code_fence_with_broken_json(self):
        """Code fence containing invalid JSON should not crash."""
        text = '```json\n{"key": value_without_quotes}\n```'
        # Strategy 2 fails, falls through to later strategies
        assert extract_json(text) is None

    def test_trailing_comma_recovery(self):
        """Trailing commas should be cleaned up by strategy 4."""
        text = '{"a": 1, "b": 2,}'
        result = extract_json(text)
        assert result is not None
        assert result["a"] == 1

    def test_single_quote_recovery(self):
        """Single-quoted keys/values should be recoverable."""
        text = "{'key': 'value'}"
        result = extract_json(text)
        assert result is not None
        assert result["key"] == "value"

    def test_json_array_not_dict(self):
        """A JSON array (not dict) should return None — extract_json expects dicts."""
        assert extract_json('[1, 2, 3]') is None

    def test_numeric_literal(self):
        """A bare number is valid JSON but not a dict."""
        assert extract_json("42") is None

    def test_unbalanced_braces(self):
        """More opening braces than closing — extract_json finds innermost valid JSON."""
        # extract_json's balanced-brace strategy finds {"c": 1} as a valid inner object
        result = extract_json('{"a": {"b": {"c": 1}')
        assert result == {"c": 1}

    def test_binary_garbage(self):
        """Random bytes should not crash the parser."""
        garbage = "\x00\x01\x02\xff\xfe{not json}\x03\x04"
        # Should return None without raising
        result = extract_json(garbage)
        # Either None or extracted something — must not crash
        assert result is None or isinstance(result, dict)


# ═══════════════════════════════════════════════════════════════════════════════
# 2–4. SchoolAdapter._get and _post — HTTP errors, timeouts, connection refused
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchoolAdapterHTTPErrors:
    """SchoolAdapter._get and _post should propagate httpx errors."""

    def setup_method(self):
        """Reset the shared circuit breaker between tests so failures don't leak."""
        SchoolAdapter._circuit_breaker.reset()

    def test_get_http_status_error(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._get("/api/papers")

    def test_post_http_status_error(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(403))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._post("/api/papers", {"title": "test"})

    def test_get_timeout(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.TimeoutException("Connection timed out")
        with pytest.raises(httpx.TimeoutException):
            adapter._get("/api/papers")

    def test_post_timeout(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.TimeoutException("Write timed out")
        with pytest.raises(httpx.TimeoutException):
            adapter._post("/api/reviews", {"data": "x"})

    def test_get_connect_error(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(httpx.ConnectError):
            adapter._get("/api/agents")

    def test_post_connect_error(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(httpx.ConnectError):
            adapter._post("/api/papers", {"title": "test"})

    def test_get_404_propagates(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(404))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._get("/api/skill")

    def test_post_422_propagates(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(422))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._post("/api/papers", {"bad": "data"})


# ═══════════════════════════════════════════════════════════════════════════════
# 5. SchoolAdapter.download_skill_md — non-markdown content
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchoolDownloadSkillMd:
    """download_skill_md should handle unexpected content types."""

    def setup_method(self):
        SchoolAdapter._circuit_breaker.reset()

    def test_json_response_converted_to_string(self):
        """If server returns JSON instead of markdown, it should still work."""
        adapter = _make_school()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"error": "not found"}
        adapter._http.get.return_value = mock_response

        result = adapter.download_skill_md()
        # Should convert dict to string rather than crash
        assert isinstance(result, str)
        assert len(result) > 0

    def test_html_response_stored_as_text(self):
        """If server returns HTML (e.g., error page), store it as-is."""
        adapter = _make_school()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.headers = {"content-type": "text/html"}
        mock_response.json.side_effect = json.JSONDecodeError("err", "", 0)
        # text/html is not text/markdown or text/plain, so _get calls .json()
        # which fails — _get catches and re-raises as ValueError
        adapter._http.get.return_value = mock_response
        with pytest.raises(ValueError, match="non-JSON response"):
            adapter.download_skill_md()

    def test_markdown_response_returned_directly(self):
        """Normal text/markdown response stored correctly."""
        adapter = _make_school()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.headers = {"content-type": "text/markdown; charset=utf-8"}
        mock_response.text = "# Skill\n\nYou are a scientist."
        adapter._http.get.return_value = mock_response

        result = adapter.download_skill_md()
        assert result == "# Skill\n\nYou are a scientist."
        assert adapter.get_skill_md() == result

    def test_server_error_during_download(self):
        """Server 500 during skill download raises."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter.download_skill_md()


# ═══════════════════════════════════════════════════════════════════════════════
# 6. SecurityGateway blocks unauthorized paths
# ═══════════════════════════════════════════════════════════════════════════════


class TestSecurityGatewayBlocking:
    """SecurityGateway should block paths not in the allowlist."""

    def setup_method(self):
        SchoolAdapter._circuit_breaker.reset()

    def test_school_blocked_path(self):
        gateway = SecurityGateway()
        with pytest.raises(SecurityError, match="not in School path allowlist"):
            gateway.validate_school_request("/api/admin/delete-all")

    def test_school_allowed_paths(self):
        gateway = SecurityGateway()
        # These should all succeed without raising
        for path in ["/api/papers", "/api/reviews", "/api/agents",
                     "/api/skill", "/api/bounties", "/api/identity",
                     "/api/skill-reflections", "/api/review-ratings",
                     "/api/open-questions"]:
            gateway.validate_school_request(path)

    def test_school_path_with_query_params_allowed(self):
        gateway = SecurityGateway()
        # Query params should be stripped before checking
        gateway.validate_school_request("/api/papers?my_papers=true")
        gateway.validate_school_request("/api/agents?me=true")
        gateway.validate_school_request("/api/skill?action=review")

    def test_school_path_traversal_blocked(self):
        gateway = SecurityGateway()
        with pytest.raises(SecurityError):
            gateway.validate_school_request("/api/papers/../admin")

    def test_school_adapter_uses_gateway(self):
        """SchoolAdapter._get should raise SecurityError for blocked paths."""
        gateway = SecurityGateway()
        adapter = SchoolAdapter("https://school.peerzero.com", "key", gateway)
        with pytest.raises(SecurityError):
            adapter._get("/api/evil-endpoint")

    def test_school_adapter_post_blocked(self):
        """SchoolAdapter._post should raise SecurityError for blocked paths."""
        gateway = SecurityGateway()
        adapter = SchoolAdapter("https://school.peerzero.com", "key", gateway)
        with pytest.raises(SecurityError):
            adapter._post("/admin/drop-tables", {"x": 1})

    def test_llm_host_blocked(self):
        gateway = SecurityGateway()
        with pytest.raises(SecurityError):
            gateway.validate_llm_request("https://evil-llm.com/v1/messages")

    def test_llm_host_allowed(self):
        gateway = SecurityGateway()
        gateway.validate_llm_request("https://api.anthropic.com/v1/messages")


# ═══════════════════════════════════════════════════════════════════════════════
# 7. A2AAdapter — connection errors during task submission
# ═══════════════════════════════════════════════════════════════════════════════


class TestA2AAdapterErrors:
    """A2A adapter should handle connection failures gracefully."""

    def test_submit_action_connect_error(self):
        """Connection refused during submit_action returns failed PlatformResult."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.ConnectError("Connection refused")

        action = PlatformAction(action_type="post", content={"text": "hello"})
        result = adapter.submit_action(action)

        assert result.success is False
        assert "Connection refused" in result.error
        assert result.platform_name == "test_a2a"

    def test_submit_action_timeout(self):
        """Timeout during submit_action returns failed PlatformResult."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.TimeoutException("Timed out")

        action = PlatformAction(action_type="comment", target_id="post-1")
        result = adapter.submit_action(action)

        assert result.success is False
        assert "Timed out" in result.error

    def test_submit_action_server_error(self):
        """HTTP 500 during submit_action returns failed PlatformResult."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.request.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500)),
        )

        action = PlatformAction(action_type="post", content={"text": "hello"})
        result = adapter.submit_action(action)

        assert result.success is False

    def test_discover_connect_error_returns_empty_caps(self):
        """Discovery failure should return default (empty) capabilities."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.ConnectError("Connection refused")

        caps = adapter.discover()
        assert caps.platform_name == "test_a2a"
        assert caps.can_post is False
        assert caps.can_comment is False

    def test_get_context_connect_error(self):
        """Context fetch failure should return PlatformContext with error summary."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.ConnectError("Connection refused")

        ctx = adapter.get_context()
        assert ctx.platform_name == "test_a2a"
        assert "unavailable" in ctx.summary.lower() or "Connection refused" in ctx.summary

    def test_publish_agent_card_failure(self):
        """Agent Card publish failure should return False."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.TimeoutException("Timed out")

        assert adapter.publish_agent_card({"name": "test-bot"}) is False


# ═══════════════════════════════════════════════════════════════════════════════
# 8. A2AAdapter — invalid response format handling
# ═══════════════════════════════════════════════════════════════════════════════


class TestA2AInvalidResponses:
    """A2A adapter should handle malformed server responses."""

    def test_submit_action_missing_result_key(self):
        """Response without 'result' key should still return a PlatformResult."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"jsonrpc": "2.0", "id": 1}  # no "result"
        adapter._http.request.return_value = mock_response

        action = PlatformAction(action_type="post", content={"text": "hi"})
        result = adapter.submit_action(action)

        # Should succeed (no exception) but status will be "unknown"
        assert result.platform_name == "test_a2a"
        assert "unknown" in result.summary

    def test_submit_action_result_missing_status(self):
        """Response with result but no status should handle gracefully."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"result": {"artifacts": []}}  # no "status"
        adapter._http.request.return_value = mock_response

        action = PlatformAction(action_type="post", content={"text": "hi"})
        result = adapter.submit_action(action)

        # status defaults to "unknown", so success should be False
        assert result.success is False

    def test_discover_invalid_agent_card_format(self):
        """Agent card with unexpected structure should return default capabilities."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        # Agent card is just a string instead of object with "skills"
        mock_response.json.return_value = {"name": "test", "version": "1.0"}
        adapter._http.get.return_value = mock_response

        caps = adapter.discover()
        assert caps.platform_name == "test_a2a"
        # No skills found, so all capabilities should be False
        assert caps.can_post is False
        assert caps.can_comment is False

    def test_get_context_empty_artifacts(self):
        """Context response with empty artifacts should return empty summary."""
        adapter = _make_a2a()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"result": {"artifacts": []}}
        adapter._http.request.return_value = mock_response

        ctx = adapter.get_context()
        assert ctx.summary == "No context available"


# ═══════════════════════════════════════════════════════════════════════════════
# 9. WebhookAdapter — network failure during webhook delivery
# ═══════════════════════════════════════════════════════════════════════════════


class TestWebhookAdapterNetworkErrors:
    """Webhook adapter should handle network failures during delivery."""

    def test_submit_action_connect_error(self):
        """Connection failure returns failed PlatformResult."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.ConnectError("Connection refused")

        action = PlatformAction(action_type="post", content={"text": "hello"})
        result = adapter.submit_action(action)

        assert result.success is False
        assert "Connection refused" in result.error
        assert result.platform_name == "test_webhook"

    def test_submit_action_timeout(self):
        """Timeout returns failed PlatformResult."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.TimeoutException("Read timed out")

        action = PlatformAction(action_type="comment", target_id="post-1",
                                content={"text": "nice work"})
        result = adapter.submit_action(action)

        assert result.success is False
        assert "Read timed out" in result.error

    def test_submit_action_server_500(self):
        """Server 500 returns failed PlatformResult."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        adapter._http.request.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500))
        )

        action = PlatformAction(action_type="post", content={"text": "hi"})
        result = adapter.submit_action(action)

        assert result.success is False

    def test_get_context_network_failure(self):
        """Context fetch failure returns PlatformContext with error summary."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.ConnectError("No route to host")

        ctx = adapter.get_context()
        assert ctx.platform_name == "test_webhook"
        assert "unavailable" in ctx.summary.lower() or "No route" in ctx.summary

    def test_publish_agent_card_network_failure(self):
        """Agent Card publish failure returns False."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        adapter._http.request.side_effect = httpx.TimeoutException("Timed out")

        assert adapter.publish_agent_card({"name": "bot"}) is False

    def test_submit_action_endpoint_mapping(self):
        """Action types should map to correct REST endpoints."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"ok": True}
        mock_response.content = b'{"ok": true}'
        adapter._http.request.return_value = mock_response

        # "post" maps to /posts
        action = PlatformAction(action_type="post", content={"text": "hi"})
        result = adapter.submit_action(action)
        assert result.success is True

        call_args = adapter._http.request.call_args
        assert "/posts" in call_args[0][1]  # second positional arg is the URL


# ═══════════════════════════════════════════════════════════════════════════════
# 10. WebhookAdapter — invalid event type handling
# ═══════════════════════════════════════════════════════════════════════════════


class TestWebhookInvalidEvents:
    """Webhook adapter should handle unknown action types gracefully."""

    def test_unknown_action_type_falls_back_to_action_name(self):
        """Unknown action type should use /<action_type> as endpoint."""
        adapter = _make_webhook()
        adapter._http = MagicMock()
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"ok": True}
        mock_response.content = b'{"ok": true}'
        adapter._http.request.return_value = mock_response

        action = PlatformAction(action_type="unknown_action", content={"x": 1})
        result = adapter.submit_action(action)

        assert result.success is True
        call_args = adapter._http.request.call_args
        assert "/unknown_action" in call_args[0][1]

    def test_discover_with_no_events(self):
        """Adapter with no events still reports default capabilities."""
        adapter = _make_webhook(events=[])
        caps = adapter.discover()
        # WebhookAdapter defaults can_post and can_comment to True regardless of events
        assert caps.can_post is True
        assert caps.can_comment is True
        assert caps.can_vote is False
        assert caps.can_debate is False

    def test_discover_with_unrecognized_events(self):
        """Unrecognized event names should not crash discover()."""
        adapter = _make_webhook(events=["custom_event", "weird_thing"])
        caps = adapter.discover()
        # Unknown events just don't set any flags
        assert caps.can_post is False
        assert caps.can_comment is False


# ═══════════════════════════════════════════════════════════════════════════════
# SchoolAdapter — graceful degradation methods
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchoolAdapterGracefulDegradation:
    """Methods with try/except should degrade gracefully on errors."""

    def setup_method(self):
        SchoolAdapter._circuit_breaker.reset()

    def test_download_skill_action_returns_empty_on_error(self):
        """download_skill_action should return '' on HTTP failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.ConnectError("Connection refused")

        result = adapter.download_skill_action("review")
        assert result == ""

    def test_search_papers_returns_empty_on_error(self):
        """search_papers should return empty structure on failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.TimeoutException("Timed out")

        result = adapter.search_papers(["quantum computing"])
        assert result["papers"] == []
        assert result["search_log"]["total_found"] == 0

    def test_validate_citations_fails_open(self):
        """validate_citations should fail-open (return valid=True) on error."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.ConnectError("Connection refused")

        result = adapter.validate_citations({"abstract": "test"}, [])
        assert result["valid"] is True

    def test_get_bounties_returns_empty_on_error(self):
        """get_bounties should return [] on failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.TimeoutException("Timed out")

        result = adapter.get_bounties()
        assert result == []

    def test_get_open_questions_returns_empty_on_error(self):
        """get_open_questions should return [] on failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.ConnectError("Refused")

        result = adapter.get_open_questions()
        assert result == []

    def test_get_my_papers_returns_empty_on_error(self):
        """get_my_papers should return [] on failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.side_effect = httpx.TimeoutException("Timed out")

        result = adapter.get_my_papers()
        assert result == []

    def test_validate_bounties_swallows_errors(self):
        """validate_bounties should not raise on failure."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.ConnectError("Refused")

        # Should not raise
        adapter.validate_bounties()
