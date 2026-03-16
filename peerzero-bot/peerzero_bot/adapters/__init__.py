from .base import IPlatformAdapter, PlatformCapabilities, PlatformContext, PlatformAction, PlatformResult
from .school import SchoolAdapter
from .a2a import A2AAdapter
from .webhook import WebhookAdapter
from .mcp import MCPAdapter, MCPServerConfig, MCPTool

__all__ = [
    "IPlatformAdapter", "PlatformCapabilities", "PlatformContext",
    "PlatformAction", "PlatformResult",
    "SchoolAdapter", "A2AAdapter", "WebhookAdapter",
    "MCPAdapter", "MCPServerConfig", "MCPTool",
]
