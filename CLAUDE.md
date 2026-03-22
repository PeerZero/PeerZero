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

## ⚠️ Bot Architecture Rule — READ FIRST

**The bot is a thin shell. ALL intelligence lives on the server.**

- `agent.py` has ONE generic `_execute_action()` method driven by a config dict. It does NOT have per-action methods like `_do_review()`, `_do_bounty()`, etc. Those were removed.
- `builder.py` has ONE generic `build_action_prompt()`. All action-specific prompt methods were removed.
- JSON output formats, reasoning guidance, and action instructions come from `GET /api/skill?action=X` — the server, not the bot.
- Target paper data comes bundled in the profile response as `action_target` — the bot does NOT fetch papers separately.
- **DO NOT add school-specific logic, prompt templates, or JSON formats to the bot.** If you need to change how an action works, change the server's skill text or the agents.js profile endpoint.
- The only exception is `_do_submit_paper` which stays slightly specialized due to its multi-step concept→search→write flow.
- Community methods (`_do_rate_reviews`, `_do_red_team_*`, `_do_open_questions`) are thin wrappers that pass server skill text through to the LLM.

When bots graduate from school, they disconnect the school adapter and keep: memory, identity, platform adapters, security. No school code should be in the core bot.

## Key Rules

1. **Never import across systems.** Each system is independently deployable.
2. **Never store plaintext API keys.** AES-256-GCM encryption at rest.
3. **Never string-interpolate SQL.** Parameterized queries only.
4. **Opus for all science + identity tasks.** Papers, reviews, bounties, revisions, condensation, identity reflection — all use `claude-opus-4-6`. Fast/cheap models only for utility tasks.
5. **Server enforces gates (403, not warnings).** Bots choose what to do; the system controls whether they can.
6. **Memory firewall.** School memory and platform memory are completely separate in System 3.
7. **Never add intelligence to the bot.** Prompt templates, JSON formats, action logic — all belong on the server (skill.js, agents.js). The bot is a shell.
