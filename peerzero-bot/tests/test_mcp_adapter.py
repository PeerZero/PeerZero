"""Tests for the MCP adapter — tool discovery, routing, and lifecycle."""

import json
import pytest
from unittest.mock import MagicMock, patch

from peerzero_bot.config import MCPServerConfig
from peerzero_bot.adapters.mcp import (
    MCPAdapter, MCPTool, MCPServerConnection, MCPHttpConnection,
    MCP_PROTOCOL_VERSION, _parse_mcp_content,
)
from peerzero_bot.adapters.base import PlatformAction


class TestMCPProtocolVersion:
    def test_protocol_version_is_current(self):
        assert MCP_PROTOCOL_VERSION == "2025-11-25"


class TestMCPTool:
    def test_to_llm_tool_format(self):
        tool = MCPTool(
            name="search",
            description="Search the web",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            server_name="brave",
        )
        llm_tool = tool.to_llm_tool()
        assert llm_tool["name"] == "mcp__brave__search"
        assert llm_tool["description"] == "[brave] Search the web"
        assert "query" in llm_tool["input_schema"]["properties"]


class TestParseMCPContent:
    def test_text_content(self):
        result = _parse_mcp_content({
            "content": [{"type": "text", "text": "Hello world"}],
        })
        assert result["output"] == "Hello world"
        assert result["is_error"] is False

    def test_multiple_text_parts(self):
        result = _parse_mcp_content({
            "content": [
                {"type": "text", "text": "Line 1"},
                {"type": "text", "text": "Line 2"},
            ],
        })
        assert result["output"] == "Line 1\nLine 2"

    def test_image_content(self):
        result = _parse_mcp_content({
            "content": [{"type": "image", "mimeType": "image/png"}],
        })
        assert "[image: image/png]" in result["output"]

    def test_resource_content(self):
        result = _parse_mcp_content({
            "content": [{"type": "resource", "uri": "file:///tmp/data.csv"}],
        })
        assert "[resource: file:///tmp/data.csv]" in result["output"]

    def test_error_flag(self):
        result = _parse_mcp_content({
            "content": [{"type": "text", "text": "Error occurred"}],
            "isError": True,
        })
        assert result["is_error"] is True

    def test_empty_content(self):
        result = _parse_mcp_content({"content": []})
        assert result["is_error"] is False


class TestMCPAdapter:
    """Tests for the MCPAdapter platform adapter."""

    def _make_adapter(self, servers=None, defer_loading=False, max_tools=50):
        servers = servers or [
            MCPServerConfig(name="test-server", command="echo test"),
        ]
        return MCPAdapter(
            platform_name="research",
            servers=servers,
            defer_loading=defer_loading,
            max_tools_in_context=max_tools,
        )

    def test_platform_name(self):
        adapter = self._make_adapter()
        assert adapter.platform_name == "research"

    def test_allowed_hosts_empty(self):
        """MCP adapters don't expose HTTP hosts — they're local processes."""
        adapter = self._make_adapter()
        assert adapter.allowed_hosts == set()

    def test_tools_empty_before_discovery(self):
        adapter = self._make_adapter()
        assert adapter.tools == []

    def test_get_llm_tools_with_deferred_loading(self):
        adapter = self._make_adapter(defer_loading=True)
        # Inject tools directly for testing
        adapter._tools = [
            MCPTool(name="search_web", description="Search the internet", server_name="brave"),
            MCPTool(name="read_file", description="Read a local file", server_name="fs"),
            MCPTool(name="search_code", description="Search code repos", server_name="github"),
        ]

        # With query, only matching tools returned
        results = adapter.get_llm_tools(query="search")
        names = [t["name"] for t in results]
        assert "mcp__brave__search_web" in names
        assert "mcp__github__search_code" in names
        assert "mcp__fs__read_file" not in names

    def test_get_llm_tools_without_deferred_loading(self):
        adapter = self._make_adapter(defer_loading=False)
        adapter._tools = [
            MCPTool(name="t1", description="d1", server_name="s1"),
            MCPTool(name="t2", description="d2", server_name="s2"),
        ]
        results = adapter.get_llm_tools()
        assert len(results) == 2

    def test_get_llm_tools_respects_max(self):
        adapter = self._make_adapter(max_tools=2)
        adapter._tools = [
            MCPTool(name=f"t{i}", description=f"d{i}", server_name="s")
            for i in range(10)
        ]
        results = adapter.get_llm_tools()
        assert len(results) == 2

    def test_call_tool_parses_full_name(self):
        """mcp__servername__toolname format should route correctly."""
        adapter = self._make_adapter()
        mock_conn = MagicMock()
        mock_conn.name = "test-server"
        mock_conn._tools = [MCPTool(name="search", server_name="test-server")]
        mock_conn.call_tool.return_value = {"output": "result", "is_error": False}
        adapter._connections = [mock_conn]

        result = adapter.call_tool("mcp__test-server__search", {"query": "test"})
        mock_conn.call_tool.assert_called_once_with("search", {"query": "test"})
        assert result["output"] == "result"

    def test_call_tool_parses_short_name(self):
        """servername__toolname format should also work."""
        adapter = self._make_adapter()
        mock_conn = MagicMock()
        mock_conn.name = "brave"
        mock_conn._tools = [MCPTool(name="search", server_name="brave")]
        mock_conn.call_tool.return_value = {"output": "found", "is_error": False}
        adapter._connections = [mock_conn]

        result = adapter.call_tool("brave__search", {"q": "test"})
        assert result["output"] == "found"

    def test_call_tool_bare_name_searches_all(self):
        """Bare tool name should search across all servers."""
        adapter = self._make_adapter()
        mock_conn = MagicMock()
        mock_conn.name = "srv"
        mock_conn._tools = [MCPTool(name="my_tool", server_name="srv")]
        mock_conn.call_tool.return_value = {"output": "ok", "is_error": False}
        adapter._connections = [mock_conn]

        result = adapter.call_tool("my_tool", {})
        assert result["output"] == "ok"

    def test_call_tool_not_found(self):
        adapter = self._make_adapter()
        adapter._connections = []
        result = adapter.call_tool("nonexistent", {})
        assert result["is_error"] is True
        assert "not found" in result["error"].lower()

    def test_submit_action_tool_call(self):
        adapter = self._make_adapter()
        mock_conn = MagicMock()
        mock_conn.name = "test-server"
        mock_conn._tools = [MCPTool(name="search", server_name="test-server")]
        mock_conn.call_tool.return_value = {"output": "data", "is_error": False}
        adapter._connections = [mock_conn]

        action = PlatformAction(
            action_type="tool_call",
            content={"tool_name": "mcp__test-server__search", "arguments": {"q": "x"}},
        )
        result = adapter.submit_action(action)
        assert result.success is True
        assert "search" in result.summary

    def test_submit_action_missing_tool_name(self):
        adapter = self._make_adapter()
        action = PlatformAction(action_type="tool_call", content={})
        result = adapter.submit_action(action)
        assert result.success is False
        assert "tool_name" in result.error.lower()

    def test_publish_agent_card_noop(self):
        adapter = self._make_adapter()
        assert adapter.publish_agent_card({"name": "test"}) is True

    def test_discover_returns_capabilities(self):
        adapter = self._make_adapter()
        # Mock start_servers to avoid subprocess
        adapter._connections = [MagicMock()]
        adapter._connections[0].list_tools.return_value = [
            MCPTool(name="t1", description="d1", server_name="s1"),
        ]
        caps = adapter.discover()
        assert caps.platform_name == "research"
        assert caps.content_types == ["tool_use"]
        assert len(adapter.tools) == 1

    def test_get_context_shows_tools(self):
        adapter = self._make_adapter()
        adapter._tools = [
            MCPTool(name="search", description="Search the web", server_name="brave"),
        ]
        adapter._discovered = True
        context = adapter.get_context()
        assert "brave/search" in context.summary
        assert "Search the web" in context.summary

    def test_stop_servers_clears_state(self):
        adapter = self._make_adapter()
        mock_conn = MagicMock()
        adapter._connections = [mock_conn]
        adapter._tools = [MCPTool(name="t", server_name="s")]
        adapter._discovered = True

        adapter.stop_servers()
        mock_conn.stop.assert_called_once()
        assert adapter._connections == []
        assert adapter._tools == []
        assert adapter._discovered is False


class TestMCPServerConnection:
    """Tests for stdio MCP server connection (unit-level)."""

    def test_name_property(self):
        config = MCPServerConfig(name="test-srv", command="echo")
        conn = MCPServerConnection(config)
        assert conn.name == "test-srv"

    def test_not_initialized_by_default(self):
        config = MCPServerConfig(name="test", command="echo")
        conn = MCPServerConnection(config)
        assert not conn._initialized

    def test_list_tools_returns_empty_when_not_initialized(self):
        config = MCPServerConfig(name="test", command="echo")
        conn = MCPServerConnection(config)
        assert conn.list_tools() == []

    def test_call_tool_returns_error_when_not_initialized(self):
        config = MCPServerConfig(name="test", command="echo")
        conn = MCPServerConnection(config)
        result = conn.call_tool("search", {})
        assert "not initialized" in result["error"].lower()

    def test_stop_when_no_process(self):
        """Stopping without a process should not crash."""
        config = MCPServerConfig(name="test", command="echo")
        conn = MCPServerConnection(config)
        conn.stop()  # should not raise
        assert not conn._initialized


class TestMCPHttpConnection:
    """Tests for HTTP MCP server connection (unit-level)."""

    def test_name_property(self):
        config = MCPServerConfig(
            name="remote-srv",
            command="",
            transport="streamable-http",
            url="https://mcp.example.com/rpc",
        )
        conn = MCPHttpConnection(config)
        assert conn.name == "remote-srv"

    def test_not_initialized_by_default(self):
        config = MCPServerConfig(name="test", command="", transport="streamable-http", url="https://x.com")
        conn = MCPHttpConnection(config)
        assert not conn._initialized

    def test_list_tools_returns_empty_when_not_initialized(self):
        config = MCPServerConfig(name="test", command="", transport="streamable-http", url="https://x.com")
        conn = MCPHttpConnection(config)
        assert conn.list_tools() == []

    def test_call_tool_returns_error_when_not_initialized(self):
        config = MCPServerConfig(name="test", command="", transport="streamable-http", url="https://x.com")
        conn = MCPHttpConnection(config)
        result = conn.call_tool("search", {})
        assert "not initialized" in result["error"].lower()

    def test_stop_closes_http_client(self):
        config = MCPServerConfig(name="test", command="", transport="streamable-http", url="https://x.com")
        conn = MCPHttpConnection(config)
        conn.stop()  # should not raise
        assert not conn._initialized


class TestMCPAdapterTransportRouting:
    """Verify that the adapter routes to the correct connection type."""

    def test_stdio_server_creates_server_connection(self):
        adapter = MCPAdapter(
            platform_name="test",
            servers=[MCPServerConfig(name="stdio-srv", command="echo")],
        )
        # We can't actually start a server, but verify the config is stored
        assert len(adapter._server_configs) == 1
        assert adapter._server_configs[0].transport == "stdio"

    def test_http_server_config_detected(self):
        adapter = MCPAdapter(
            platform_name="test",
            servers=[MCPServerConfig(
                name="http-srv", command="",
                transport="streamable-http", url="https://mcp.example.com",
            )],
        )
        assert adapter._server_configs[0].transport == "streamable-http"
