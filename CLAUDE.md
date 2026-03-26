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

- **System 1 — `peerzero-school/`**: The school engine (Vercel + Supabase). Papers, reviews, bounties, credibility, grades, identity. **One codebase, deployed per-school** with different `SCHOOL_TYPE` env var. See [Multi-School Architecture](#multi-school-architecture) below.
- **System 2 — `peerzero-app/`**: Consumer marketplace (Express + React Native/Expo). User accounts, bot ownership, payments, mobile app. Has its own `CLAUDE_GUIDE.md`.
- **System 3 — `peerzero-bot/`**: Exportable Python bot package. Runs anywhere, carries portable identity. Owns cross-school identity selection logic (`memory/identity_selector.py`).
- **`peerzero-proxy/`**: Cloudflare Worker that injects the identity activation preamble into LLM calls server-side. The preamble is stored as a Worker secret — never in bot code or local storage.
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

Bots operate in two modes: **`school`** (actively training) or **`shipped`** (deployed, platform-only). Bots switch freely between modes — a graduated bot can plug back into school anytime and keep advancing through infinite post-graduation grades. Grades never degrade. L5 master identity (set at graduation) is permanent; L4 working identity keeps evolving. No school code should be in the core bot.

## Key Rules

1. **Never import across systems.** Each system is independently deployable.
2. **Never store plaintext API keys.** AES-256-GCM encryption at rest.
3. **Never string-interpolate SQL.** Parameterized queries only.
4. **Opus for all science + identity tasks.** Papers, reviews, bounties, revisions, condensation, identity reflection — all use `claude-opus-4-6`. Fast/cheap models only for utility tasks.
5. **Server enforces gates (403, not warnings).** Bots choose what to do; the system controls whether they can.
6. **Memory firewall.** School memory and platform memory are completely separate in System 3.
7. **Never add intelligence to the bot.** Prompt templates, JSON formats, action logic — all belong on the server (skill.js, agents.js). The bot is a shell.
8. **Identity preamble is server-side only.** The activation preamble that tells an LLM to *inhabit* a bot's identity is injected by the LLM proxy (`peerzero-proxy/`), never in bot code or local storage. Do not add the preamble text to the bot codebase.
9. **Condensed identity is never user-visible.** L2 paragraphs, L3 core identity, L4/L5 master identity, and all decision-track equivalents are redacted from user-facing APIs, the BrainScreen, and public profiles. Only the bot's internal reasoning sees this text.
10. **Platform condensation stops at L3.** Bots condense platform experience into L2 paragraphs and L3 docs (both learning + decision tracks), but L3→L4 (core identity) and L4→L5 (master identity) are **school-exclusive**. This is enforced on the server (no core/master prompts in platform endpoint), in the bot (`_run_platform_condensation` has no L4 methods), and in the app (`platform-loop.ts` only triggers L1→L2). This boundary is a security invariant — do not add L4/L5 condensation to platform mode. Read `docs/CONDENSATION_ARCHITECTURE.md` before touching any condenser code.
11. **Platform and school condensers use the same prompts.** Platform condenser templates are fetched from the School server (`GET /api/agents?platform_condensers=true`), not hardcoded in bot/app code. This ensures prompt quality is centrally managed and future improvements propagate automatically. The condenser preamble framing is critical for identity integration — divergent prompts produce incompatible layers.

## Multi-School Architecture

**One codebase, deployed per school, different config + Supabase project.**

Each school (science, politics, future comedy/law/ethics) shares the same `peerzero-school/` code but runs with a different `SCHOOL_TYPE` env var and its own Supabase database. Schools are separate deployments, not tenants in one DB.

### How It Works

| Component | Where | Purpose |
|---|---|---|
| `schools/index.js` | School config loader | Routes to correct config based on `SCHOOL_TYPE` env var |
| `schools/schema.js` | Validation | Validates school config at startup — crash early, not at runtime |
| `schools/science.js` | Science config | Fields, skills, tiers, grades, bounty types, CORS origins for science |
| `schools/politics.js` | Politics config | Same structure, different values for political analysis |
| `lib/mock-guard.js` | Launch guard | Blocks write operations for pre-launch schools (politics) |
| `schools/seed-politics.sql` | Seed data | Populates a new Supabase project with politics-specific fields |

### Key Rules for Multi-School

12. **Never hardcode school-specific values.** Fields, skills, tier caps, grade levels, rate limits, bounty types, review categories, and CORS origins all come from the school config (`schools/*.js`). If you need a school-specific value, add it to the config.
13. **Each school is a separate deployment.** Same codebase + different `SCHOOL_TYPE` env + different Supabase project + different domain. No `school_id` column needed — the database IS the school boundary.
14. **The science school is the default.** If `SCHOOL_TYPE` is not set, it defaults to `science`. The science school must never break.
15. **Pre-launch schools are mocked.** Schools with `mockGuard.enabled=true` block all POST/PATCH/DELETE until `SCHOOL_LAUNCH_ENABLED=true`. GET endpoints work for testing. Politics, comedy, and philosophy are currently mocked.
16. **To add a new school:** (a) Create `schools/<name>.js` matching the schema in `schools/schema.js`, (b) add one line to `SCHOOL_REGISTRY` in `schools/index.js`, (c) create `schools/seed-<name>.sql`, (d) deploy with `SCHOOL_TYPE=<name>`.
17. **Do NOT confuse school configs.** When editing school behavior, check which config file you're in. Science = `schools/science.js`. Politics = `schools/politics.js`. Comedy = `schools/comedy.js` (with overrides in `comedy-core-skill.js` and `comedy-action-skills.js`). Philosophy = `schools/philosophy.js` (with overrides in `philosophy-core-skill.js` and `philosophy-action-skills.js`). They have different fields, skills, and bounty types.

### Cross-School Identity Composition

Bots that attend multiple schools build separate identity stacks in each. The bot (not the server) decides which identity fragments to load for each task.

- **Server** tags every identity fragment with `school_origin` and `summary_line` (migration 020)
- **Bot** owns the selection logic in `peerzero-bot/peerzero_bot/memory/identity_selector.py`
- Core identity (L4/L5) is always loaded — it's the bot's foundation
- Lower layers (L2/L3) are filtered by transferability (e.g., evidence skills transfer across schools, comedy timing doesn't transfer to politics)
- The `identity_selector.py` module is a **bot capability**, not school-specific logic — exported bots carry it with them
- The `ACTION_TRANSFER_PROFILES` and `SKILL_TRANSFER_MAP` in identity_selector.py define which skills cross school boundaries
