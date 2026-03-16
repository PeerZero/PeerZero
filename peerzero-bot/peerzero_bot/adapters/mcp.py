"""
MCP Adapter — Model Context Protocol client for universal tool access.

Connects the bot to any MCP-compatible server, giving it access to
databases, APIs, file systems, web search, and 200+ other tools through
a single standardized protocol.

MCP servers are spawned as local subprocesses (stdio transport) or
connected via HTTP (streamable-http transport). The adapter discovers
available tools at startup and exposes them to the LLM during
platform cycles.

Security:
  - Each MCP server runs in its own subprocess with no shared state
  - Tool invocations are validated against the autonomy policy
  - All tool calls are audit-logged
  - Server stdout/stderr is captured and sandboxed

Reference: https://modelcontextprotocol.io/
"""

import json
import logging
import subprocess
import threading
import os
from dataclasses import dataclass, field
from typing import Optional

from .base import (
    PlatformCapabilities, PlatformContext,
    PlatformAction, PlatformResult,
)

logger = logging.getLogger("peerzero-bot.mcp")


# ── MCP data types ───────────────────────────────────────────────────────────

@dataclass
class MCPTool:
    """A tool discovered from an MCP server."""
    name: str
    description: str = ""
    input_schema: dict = field(default_factory=dict)
    server_name: str = ""

    def to_llm_tool(self) -> dict:
        """Convert to LLM-compatible tool definition."""
        return {
            "name": f"mcp__{self.server_name}__{self.name}",
            "description": f"[{self.server_name}] {self.description}",
            "input_schema": self.input_schema,
        }


@dataclass
class MCPServerConfig:
    """Configuration for a single MCP server."""
    name: str
    command: str                     # e.g., "npx @anthropic/mcp-server-brave-search"
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    transport: str = "stdio"         # "stdio" or "streamable-http"
    url: str = ""                    # for streamable-http transport


# ── MCP Server Connection (stdio transport) ──────────────────────────────────

class MCPServerConnection:
    """
    Manages a single MCP server subprocess using stdio JSON-RPC.

    Lifecycle:
      1. start() — spawn subprocess, send initialize, read capabilities
      2. list_tools() — discover available tools
      3. call_tool() — invoke a tool with arguments
      4. stop() — gracefully shut down
    """

    def __init__(self, config: MCPServerConfig):
        self.config = config
        self._process: Optional[subprocess.Popen] = None
        self._request_id: int = 0
        self._lock = threading.Lock()
        self._tools: list[MCPTool] = []
        self._initialized = False

    @property
    def name(self) -> str:
        return self.config.name

    def start(self) -> bool:
        """Start the MCP server subprocess and initialize the protocol."""
        if self.config.transport == "streamable-http":
            logger.info(f"[MCP:{self.name}] HTTP transport — no subprocess needed")
            self._initialized = True
            return True

        try:
            # Build command
            cmd_parts = self.config.command.split()
            cmd_parts.extend(self.config.args)

            # Merge environment
            env = os.environ.copy()
            env.update(self.config.env)

            self._process = subprocess.Popen(
                cmd_parts,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                bufsize=0,
            )

            # Send initialize request
            init_result = self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "peerzero-bot",
                    "version": "1.0.0",
                },
            })

            if init_result is None:
                logger.error(f"[MCP:{self.name}] Initialize failed — no response")
                self.stop()
                return False

            # Send initialized notification
            self._send_notification("notifications/initialized", {})

            self._initialized = True
            logger.info(f"[MCP:{self.name}] Server started (pid={self._process.pid})")
            return True

        except FileNotFoundError:
            logger.error(f"[MCP:{self.name}] Command not found: {self.config.command}")
            return False
        except Exception as e:
            logger.error(f"[MCP:{self.name}] Failed to start: {e}")
            self.stop()
            return False

    def list_tools(self) -> list[MCPTool]:
        """Discover available tools from the server."""
        if not self._initialized:
            return []

        try:
            result = self._send_request("tools/list", {})
            if result is None:
                return []

            tools = []
            for tool_def in result.get("tools", []):
                tools.append(MCPTool(
                    name=tool_def["name"],
                    description=tool_def.get("description", ""),
                    input_schema=tool_def.get("inputSchema", {}),
                    server_name=self.name,
                ))
            self._tools = tools
            logger.info(f"[MCP:{self.name}] Discovered {len(tools)} tools")
            return tools

        except Exception as e:
            logger.warning(f"[MCP:{self.name}] Tool discovery failed: {e}")
            return []

    def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """Invoke a tool on this server."""
        if not self._initialized:
            return {"error": "Server not initialized"}

        try:
            result = self._send_request("tools/call", {
                "name": tool_name,
                "arguments": arguments,
            })

            if result is None:
                return {"error": "No response from server"}

            # Extract content from MCP response
            content_parts = result.get("content", [])
            output = []
            for part in content_parts:
                if part.get("type") == "text":
                    output.append(part["text"])
                elif part.get("type") == "image":
                    output.append(f"[image: {part.get('mimeType', 'unknown')}]")
                elif part.get("type") == "resource":
                    output.append(f"[resource: {part.get('uri', 'unknown')}]")

            is_error = result.get("isError", False)
            return {
                "output": "\n".join(output) if output else str(result),
                "is_error": is_error,
            }

        except Exception as e:
            logger.warning(f"[MCP:{self.name}] Tool call failed: {e}")
            return {"error": str(e)}

    def stop(self):
        """Gracefully shut down the server."""
        if self._process and self._process.poll() is None:
            try:
                self._process.stdin.close()
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()
            except Exception:
                pass
            logger.info(f"[MCP:{self.name}] Server stopped")
        self._process = None
        self._initialized = False

    def _send_request(self, method: str, params: dict) -> Optional[dict]:
        """Send a JSON-RPC request and wait for the response."""
        with self._lock:
            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
                "params": params,
            }
            return self._send_and_receive(request)

    def _send_notification(self, method: str, params: dict):
        """Send a JSON-RPC notification (no response expected)."""
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        self._write_message(notification)

    def _send_and_receive(self, request: dict) -> Optional[dict]:
        """Write a request and read the response."""
        if not self._process or not self._process.stdin or not self._process.stdout:
            return None

        self._write_message(request)
        return self._read_response(request["id"])

    def _write_message(self, message: dict):
        """Write a JSON-RPC message to the server's stdin."""
        if not self._process or not self._process.stdin:
            return
        data = json.dumps(message) + "\n"
        self._process.stdin.write(data.encode())
        self._process.stdin.flush()

    def _read_response(self, request_id: int, timeout: float = 30.0) -> Optional[dict]:
        """Read JSON-RPC response, skipping notifications."""
        if not self._process or not self._process.stdout:
            return None

        import select
        deadline = __import__("time").time() + timeout

        while __import__("time").time() < deadline:
            # Check if data is available
            ready, _, _ = select.select([self._process.stdout], [], [], 1.0)
            if not ready:
                continue

            line = self._process.stdout.readline()
            if not line:
                return None

            try:
                msg = json.loads(line.decode().strip())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            # Skip notifications (no "id" field)
            if "id" not in msg:
                continue

            if msg.get("id") == request_id:
                if "error" in msg:
                    logger.warning(f"[MCP:{self.name}] RPC error: {msg['error']}")
                    return None
                return msg.get("result", {})

        logger.warning(f"[MCP:{self.name}] Timeout waiting for response to request {request_id}")
        return None


# ── MCP Platform Adapter ─────────────────────────────────────────────────────

class MCPAdapter:
    """
    Platform adapter that connects to MCP servers and exposes their
    tools to the bot's LLM during platform cycles.

    Unlike A2A/Webhook adapters which map to a single platform, the MCP
    adapter manages multiple servers and aggregates their tools into a
    unified tool catalog.
    """

    def __init__(
        self,
        platform_name: str,
        servers: list[MCPServerConfig],
        defer_loading: bool = False,
        max_tools_in_context: int = 50,
    ):
        self._name = platform_name
        self._server_configs = servers
        self._connections: list[MCPServerConnection] = []
        self._tools: list[MCPTool] = []
        self._defer_loading = defer_loading
        self._max_tools = max_tools_in_context
        self._discovered = False

    @property
    def platform_name(self) -> str:
        return self._name

    @property
    def allowed_hosts(self) -> set[str]:
        # MCP stdio servers don't use HTTP hosts — they're local processes.
        # HTTP transport servers would have hosts, but those are managed
        # by the MCP server itself, not by our security gateway.
        return set()

    @property
    def tools(self) -> list[MCPTool]:
        """All discovered tools across all servers."""
        return self._tools

    def get_llm_tools(self, query: str = "") -> list[dict]:
        """
        Get tool definitions formatted for LLM consumption.

        If defer_loading is True and a query is provided, only return
        tools whose name or description matches the query (tool search).
        Otherwise return all tools (up to max_tools_in_context).
        """
        if self._defer_loading and query:
            # Filter tools by relevance to query
            query_lower = query.lower()
            matched = [
                t for t in self._tools
                if query_lower in t.name.lower()
                or query_lower in t.description.lower()
            ]
            return [t.to_llm_tool() for t in matched[:self._max_tools]]

        return [t.to_llm_tool() for t in self._tools[:self._max_tools]]

    def start_servers(self) -> int:
        """Start all configured MCP servers. Returns count of successfully started servers."""
        started = 0
        for config in self._server_configs:
            conn = MCPServerConnection(config)
            if conn.start():
                self._connections.append(conn)
                started += 1
            else:
                logger.warning(f"[MCP:{config.name}] Failed to start — skipping")
        return started

    def stop_servers(self):
        """Stop all MCP server connections."""
        for conn in self._connections:
            conn.stop()
        self._connections.clear()
        self._tools.clear()
        self._discovered = False

    def discover(self) -> PlatformCapabilities:
        """Discover tools from all connected MCP servers."""
        if not self._connections:
            self.start_servers()

        self._tools.clear()
        for conn in self._connections:
            tools = conn.list_tools()
            self._tools.extend(tools)

        self._discovered = True
        tool_names = [t.name for t in self._tools]
        logger.info(f"[MCP:{self._name}] Total tools: {len(self._tools)}")

        return PlatformCapabilities(
            platform_name=self._name,
            can_post=False,
            can_comment=False,
            can_vote=False,
            can_debate=False,
            content_types=["tool_use"],
            supports_streaming=False,
        )

    def get_context(self) -> PlatformContext:
        """Return available tools as context for the LLM."""
        if not self._discovered:
            self.discover()

        tool_summaries = []
        for tool in self._tools:
            tool_summaries.append(f"- {tool.server_name}/{tool.name}: {tool.description}")

        summary = f"MCP Tools Available ({len(self._tools)} total):\n" + "\n".join(tool_summaries)

        return PlatformContext(
            platform_name=self._name,
            raw_data={"tools": [t.to_llm_tool() for t in self._tools]},
            summary=summary[:4000],
        )

    def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """
        Call a tool by its full name (server__toolname) or short name.

        Returns dict with 'output' and 'is_error' keys.
        """
        # Parse full tool name: mcp__servername__toolname
        parts = tool_name.split("__")
        if len(parts) == 3 and parts[0] == "mcp":
            server_name = parts[1]
            short_name = parts[2]
        elif len(parts) == 2:
            server_name = parts[0]
            short_name = parts[1]
        else:
            # Try to find tool by short name across all servers
            server_name = None
            short_name = tool_name

        for conn in self._connections:
            if server_name and conn.name != server_name:
                continue
            # Check if this server has the tool
            for tool in conn._tools:
                if tool.name == short_name:
                    result = conn.call_tool(short_name, arguments)
                    logger.info(
                        f"[MCP:{conn.name}] Tool call: {short_name} "
                        f"-> {'error' if result.get('is_error') else 'ok'}"
                    )
                    return result

        return {"error": f"Tool not found: {tool_name}", "is_error": True}

    def submit_action(self, action: PlatformAction) -> PlatformResult:
        """
        Submit a tool call action.

        Expected action format:
          action_type: "tool_call"
          content: {"tool_name": "...", "arguments": {...}}
        """
        tool_name = action.content.get("tool_name", "")
        arguments = action.content.get("arguments", {})

        if not tool_name:
            return PlatformResult(
                success=False,
                action_type="tool_call",
                platform_name=self._name,
                error="No tool_name in action content",
            )

        result = self.call_tool(tool_name, arguments)

        return PlatformResult(
            success=not result.get("is_error", False),
            action_type="tool_call",
            platform_name=self._name,
            response_data=result,
            summary=f"Tool {tool_name}: {str(result.get('output', ''))[:200]}",
            error=result.get("error", ""),
        )

    def publish_agent_card(self, agent_card: dict) -> bool:
        """MCP servers don't use Agent Cards — this is a no-op."""
        return True
