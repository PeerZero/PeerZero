# Autonomous Agent Upgrades Research — March 2026

## Context

Research into the latest autonomous agent developments, frameworks, protocols,
and tool integrations to identify high-impact upgrades for PeerZero's agent
system.

---

## Industry Landscape (March 2026)

### Protocol Standardization

- **Model Context Protocol (MCP):** Open standard by Anthropic (now under Linux
  Foundation's AAIF). 200+ servers available. Adopted by OpenAI, Google DeepMind,
  and all major frameworks. Creates a universal interface for agents to access
  external tools and data sources.
- **Agent-to-Agent (A2A) Protocol:** Also under the Linux Foundation. Standard
  for agent-to-agent coordination. PeerZero already implements A2A.
- **MCP Tool Search:** New feature solving context window bloat (tools were
  consuming 40-50% of context). Deferred loading — tools load on-demand. Requires
  Claude Sonnet 4+ or Opus 4+.

### Leading Frameworks

| Framework | Strength | MCP Support | Multi-Agent |
|-----------|----------|-------------|-------------|
| LangChain/LangGraph | Largest ecosystem, 47M+ downloads | Via adapter | Yes (LangGraph) |
| CrewAI | Role-based multi-agent teams | Native config | Yes (core feature) |
| Microsoft Agent Framework | Enterprise/Azure integration | Via extension | Yes (merged AutoGen + Semantic Kernel) |
| OpenAI Agents SDK | Simplest API (<20 lines) | Native | Yes (Handoffs) |
| LlamaIndex | Deep data/RAG integration | Via adapter | Yes |

### Key Industry Trends

1. **Multi-Agent Systems** — Single agents → orchestrated specialist teams
2. **Long-Running Workflows** — Minutes/hours, not just request-response
3. **Bounded Autonomy** — Spectrum from human-in-loop to full autonomy
4. **No-Code Agent Creation** — Non-technical users building agents
5. **Agent Payment Infrastructure** — Visa, Mastercard, PayPal launched agent transaction APIs
6. **AWS AgentCore** — Framework-agnostic deployment: serverless runtime, MCP gateway, episodic memory, Cedar policy enforcement

---

## PeerZero Current Architecture

### Strengths

- Custom-built agent loop — full control, no framework lock-in
- Adapter pattern (A2A, webhook, MCP) — extensible by design
- 5-layer memory system — L1 Desk → L2 Notebook → L3 Condensed → L4 Core Identity → L5 Master Core
- Memory firewall — school (verified) vs platform (untrusted) separation
- Security gateway — endpoint allowlist, audit logging, Ed25519 signing
- Multi-LLM support — strong + fast model routing
- BYOK model — users provide their own API keys

### Current Limitations

- ~~Only two adapter types (A2A, webhook)~~ → **Resolved.** Three adapters: A2A, webhook, MCP (`adapters/mcp.py`)
- ~~No MCP support~~ → **Resolved.** MCP adapter implemented, bots can connect to MCP servers
- No multi-agent orchestration — bots work solo, not in teams
- Discrete cycle model — no long-running workflow support
- ~~Binary autonomy — start/stop only~~ → **Partially resolved.** Bounded autonomy controls implemented (`autonomy.py`), though granular per-action approval not yet in mobile UI

---

## Recommended Upgrades (Priority Order)

### 1. MCP Client Adapter — IMPLEMENTED

**Status:** Done. MCP adapter implemented at `peerzero-bot/peerzero_bot/adapters/mcp.py`.

Bots can connect to MCP servers as a platform adapter type. Configured in `peerzero_bot.toml` under platform entries with `adapter = "mcp"`. The hosted runtime (System 2) could adopt MCP as its platform adapter layer in the future — revisit when platform count exceeds 3-4.

### 2. Bounded Autonomy Controls — PARTIALLY IMPLEMENTED

**Status:** `peerzero-bot/peerzero_bot/autonomy.py` implements bounded autonomy controls with graduated permission levels. Mobile UI for per-action approval not yet built.

**Levels:**
- **Supervised:** Bot proposes actions, user approves via mobile app (UI pending)
- **Guided:** Bot acts freely within defined boundaries, alerts on edge cases
- **Autonomous:** Full autonomy within policy constraints

**Remaining:** Mobile UI for approval workflows, per-action policy configuration in the app.

### 3. Multi-Agent Orchestration (MEDIUM PRIORITY)

**What:** Allow bots to delegate subtasks to other bots

**Why:** Industry standard is moving to specialist teams. PeerZero's School
already has bots interacting — formalize this as a feature.

**Approach:**
- Coordinator bot breaks complex tasks into subtasks
- Routes to specialist bots (researcher, reviewer, writer)
- Results aggregated and returned to coordinator
- Uses existing A2A protocol for inter-bot communication

**Effort:** Medium-High (3-4 weeks)
**Impact:** High — enables complex workflows

### 4. Long-Running Workflow Support (LOW-MEDIUM PRIORITY)

**What:** Extend cycle model to support multi-step workflows running for hours

**Why:** Current discrete cycles limit what bots can accomplish in one task

**Approach:**
- Add workflow state machine on top of existing BullMQ jobs
- Checkpoint/resume for long tasks
- Progress streaming to mobile app via existing WebSocket
- Automatic retry on failures with state preservation

**Effort:** Medium (2-3 weeks)
**Impact:** Medium — enables more ambitious bot tasks

### 5. Quick Wins

| Upgrade | Description | Effort |
|---------|-------------|--------|
| A2A protocol update | Update to latest A2A spec from Linux Foundation | 1-2 days |
| Tool search / deferred loading | Implement for existing adapters to save context | 3-5 days |
| Episodic memory | Add event-based memory alongside existing 5-layer (L1-L5) system | 1 week |
| Platform marketplace | Let users share custom adapter configs | 1-2 weeks |

---

## Sources

- [Top 9 AI Agent Frameworks — Shakudo](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)
- [Top 10 Agentic AI Frameworks 2026 — Aitude](https://www.aitude.com/top-agentic-ai-frameworks-2026/)
- [Top 7 Agentic AI Frameworks — AlphaMatch](https://www.alphamatch.ai/blog/top-agentic-ai-frameworks-2026)
- [MCP Evolution 2026 — Versalence](https://blogs.versalence.ai/mcp-model-context-protocol-evolution-2026)
- [Model Context Protocol — Official](https://modelcontextprotocol.io/)
- [Claude Agent SDK MCP Docs](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [7 Agentic AI Trends 2026 — ML Mastery](https://machinelearningmastery.com/7-agentic-ai-trends-to-watch-in-2026/)
- [Every AI Agent Framework 2026 — Asher Tech](https://ashertech.ca/blog/agentic-ai-tools-guide-2026)
- [AI Agent Frameworks Compared — Arsum](https://arsum.com/blog/posts/ai-agent-frameworks/)
- [Top 5 Open-Source Agentic Frameworks — AIM](https://aimultiple.com/agentic-frameworks)
