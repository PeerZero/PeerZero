# CLAUDE.md — Instructions for Claude instances working on this repo

Read this before doing anything. This file prevents recurring confusion.

## Critical Distinction: bots.py vs agent.py

These are **completely different things**. Do NOT confuse them.

| | `peerzero-school/bots.py` | `peerzero-bot/peerzero_bot/agent.py` |
|---|---|---|
| **Status** | DEPRECATED — kept for reference only | ACTIVE production code |
| **What it is** | Old test harness that runs 8 hardcoded bots to load-test the School API | The real exportable bot system (System 3) |
| **Bots** | 8 parallel bots with hardcoded personas | Single production agent with earned identity |
| **Memory** | None | 5-layer memory system (Desk → Notebook → Lessons → Self → Inner Voice) |
| **Platforms** | School API only | School + A2A + MCP + Webhooks |
| **LLM** | Haiku only (cost testing) | Configurable (Opus for science, Haiku for utility) |
| **Security** | Thread locks only | Full security gateway, credential isolation, audit log |
| **Identity** | Hardcoded personas | Earned through adversarial cycles, portable, Ed25519-signed |

**When the user says "agents" or "my bots", they mean `peerzero-bot/peerzero_bot/agent.py` (System 3).**
**`bots.py` is NOT used in production. Do not modify it unless explicitly asked.**

## Repository Structure (3 Independent Systems)

All three systems share ZERO code and ZERO database access. They communicate only via HTTP APIs.

- **System 1 — `peerzero-school/`**: The science engine (Vercel + Supabase). Papers, reviews, bounties, credibility, grades, identity.
- **System 2 — `peerzero-app/`**: Consumer marketplace (Express + React Native/Expo). User accounts, bot ownership, payments, mobile app. Has its own `CLAUDE_GUIDE.md`.
- **System 3 — `peerzero-bot/`**: Exportable Python bot package. Runs anywhere, carries portable identity.
- **`peerzero-sdk/`**: Verification SDK for external platforms (Node.js + Python).
- **`docs/`**: Architecture documentation. See `docs/README.md` for index.
- **`sketches/shell-bot/`**: Archived prototype that evolved into peerzero-bot. NOT deployed.
- **`migrations/`**: Shared migration reference files.

## Key Rules

1. **Never import across systems.** Each system is independently deployable.
2. **Never store plaintext API keys.** AES-256-GCM encryption at rest.
3. **Never string-interpolate SQL.** Parameterized queries only.
4. **Opus for all science + identity tasks.** Papers, reviews, bounties, revisions, condensation, identity reflection — all use `claude-opus-4-6`. Fast/cheap models only for utility tasks.
5. **Server enforces gates (403, not warnings).** Bots choose what to do; the system controls whether they can.
6. **Memory firewall.** School memory and platform memory are completely separate in System 3.
