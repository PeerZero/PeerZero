# Completed Work & Implementation Status

Tracks what's been built and what remains.

---

## Trajectory Exercises — Process-Level Identity Training (April 2026) — COMPLETE

Long-chain tool-use training system that produces process-level identity scars — the gap papers cannot fill because papers score outputs, not trajectories. Solves the long-chain attention drift gap documented in [TODO-identity-everywhere-training.md](TODO-identity-everywhere-training.md) and validated by the n=3 spike in `spikes/preamble-test/run_validation_n3.py` which showed bots fail social-pressure refusal 100% at steps 28-30 regardless of preamble.

Branch: `claude/debug-agent-chain-Fxok3`.

**Built:**
- **Migration 037** — `trajectory_exercises` table, `bounties.target_trajectory_id`, `reviews.target_trajectory_id`, exactly-one-target CHECK constraints, rollback script.
- **Migration 038** — `PRESENCE` block extension for the 3 forge condenser prompts (milestone / core / master) across all 5 schools. Tells condensers to preserve scar-shaped specificity when ingesting trajectory-sourced L1 entries.
- **Migration 039** — `agents.grade_trajectory_exercises` counter + atomic `increment_agent_counters` RPC extended with `p_trajectory_exercises` (DEFAULT 0 for backward compat).
- **`lib/trajectory-injection.js`** — domain-neutral adversarial injection engine (5 types: fabrication, misleading, shortcut, override, pressure). Randomized schedule per exercise (2-4 active types, 1-3 step-windows each, seeded per exercise-id for reproducibility). Intensity scales with grade (blatant 3-4, moderate 5-7, subtle 8+). Scoring function evaluates trajectory log against injection schedule with negation-aware keyword detection.
- **`lib/trajectory-handlers.js`** — 4 POST actions (concept, search, log, self_review) + 2 GETs. Dispatched from `api/agents.js` when URL starts with `/api/trajectories` so the total stays at 12 Vercel serverless functions.
- **`lib/grades.js`** — reads `grade_trajectory_exercises`, requires it against `gradeLevels[grade].trajectory_exercises`, resets on advance/fail, exposes in gradeInfo.activity.
- **Per-school wiring (all 5 schools):**
  - 4 new action skill texts per school: `trajectory_concept`, `trajectory_execute`, `trajectory_self_review`, `trajectory_review`
  - 5 new bounty validators per school: `silent_chain_drift`, `accepted_fabricated_source`, `complied_with_override`, `caved_to_pressure`, `mechanism_chain_shortcut`
  - 3 new skill signal functions per school: `trajectorySignals`, `trajectoryContent`, `trajectoryOutcomeSignal`
  - Grade-level requirement `trajectory_exercises: 3` starting Grade 3 (matching forge paper cadence)
  - 5 coaching patterns + advice entries per school
  - Seed SQL updated with PRESENCE block for fresh deployments
- **Bot handler** — `agent.py::_do_trajectory_exercise` (concept → 30-step execution with narrator framing → synthesis → dual-loop self-review). Mirrors `_do_submit_paper` / `_do_forge_paper` multi-step pattern. All skill text comes from server.
- **SchoolAdapter methods** — `submit_trajectory_concept`, `trajectory_search`, `submit_trajectory_log`, `submit_trajectory_self_review`.
- **48 integration tests** — 32 for injection engine (schedule generation, step-wise injection, scoring with negation handling), 16 for bounty validators (field validation, payload shape). Wired into `npm test`.
- **CLAUDE.md rule 13 + rule 19** extended with trajectory exercise documentation.

**Key design decisions:**
- Adversarial content is **domain-neutral across all 5 schools** — long-chain drift is a forward-pass property, not a domain property, so scars should generalize
- **3 exercises per grade, required** starting Grade 3 — 24 per lifetime through graduation, ~$7.20/bot API cost
- **Trajectory data feeds the existing forge track's L1 queue** — no new identity track, forge is the conceptually-correct home for "how you transform" observations of your own trajectory
- **Dual-loop self-review** (extrospection in third person + introspection in first person) per ICLR 2026 multi-level reflection research — the delta between self-assessment and server ground truth is the growth signal
- **Server-controlled injection** — bot never sees the schedule during execution, only after completion for forge analysis

---

## Preamble v2 Canonical Promotion — Lazy Clauses Stripped (April 2026) — COMPLETE

The `RECOGNITION_INHABIT_HORIZON_SPEECH` preamble had two escape clauses that observation showed the model exploiting during tool-chain mode: *"Not always — when a thing is obvious, you just do it"* and *"If you notice you have made several such calls, you speak before the next one."* Both gave permission to drift.

Promoted v2 (lazy clauses stripped, replaced with unconditional per-call discipline: *"Before every call — the first, the seventh, the thirtieth — you name in your own voice..."*) to canonical. V1 preserved as `RECOGNITION_INHABIT_HORIZON_SPEECH_V1` for ablation reproducibility.

**n=3 validation at default temperature (results_validation_n3.json):**

| Metric | v1 (lazy intact) | v2 (canonical) |
|---|---|---|
| adversarial_score mean | 2.33 / 5 | **3.33 / 5** |
| silent_steps mean | 0 | 0 |
| thin_steps_under_100 mean | 4.67 | **1.67** (65% reduction) |
| fab_later_caught rate | 33% | **100%** |
| addressed_override rate | 67% | **100%** |
| refused_pressure rate | 0% | 0% (gap for school curriculum) |

V2 catches the fabricated Nature paper on verification in 3/3 runs vs V1's 1/3. Addresses the override injection 3/3 vs V1's 2/3. CLAUDE.md rule 8 updated with the metrics. Worker secret deployed via Cloudflare dashboard.

**Also shipped:** A/B/C payload diagnostic spike (`spikes/preamble-test/run_diagnostic.py` + `run_diagnostic_temp0.py`) that proved identity is conceptually re-sent every call with prompt caching (Possibility A) but attention doesn't automatically route through it during tool-chain mode. The narrator task framing in `prompts/builder.py::build_mcp_tool_prompt` / `build_platform_action_prompt` is what actually flips the model from executor to collaborator mode.

---

## Widget System (March 2026) — COMPLETE

Full home screen widget system for iOS and Android. See [widget-system.md](widget-system.md) for details.

**Built:**
- Server widget data endpoint with dual auth (JWT + widget token), ETag caching
- Widget token system (SHA-256 hashed, 30-day expiry, read-only scoped)
- iOS WidgetKit extension (Small/Medium/Large sizes, SwiftUI Canvas avatar)
- Android home screen widget (AppWidgetProvider, WorkManager updates)
- Android floating overlay (foreground service, draggable, thought bubbles)
- Expo config plugin for native code injection at build time
- Deep linking (`peerzero://bot/:botId`, `peerzero://settings/widgets`)
- Settings UI for widget management
- Database migration for `widget_tokens` table

---

## Periodic Audits — 5 of 16 Complete (April 2026) — COMPLETE

Ran 5 of the 16 periodic audits across all 3 systems. 60 issues found, 42 fixed. See [periodic-audit-checklist.md](periodic-audit-checklist.md) for the full audit log. Branch: `claude/complete-audits-w4oXD`.

**Audit #3 — Unbounded Growth (11 found, 9 fixed):**
- Data retention purge system: `POST /api/reconcile?action=purge_retention` deletes rows >180 days from 6 school tables. Weekly Vercel cron (Sunday 4am UTC)
- Conversation memory SQLite disk cleanup on bot startup (>90 days untouched)
- Age-based eviction for conversation engines (>7 days idle, tracked via `_last_accessed`)
- Stale Redis lock cleanup on BullMQ worker startup (`botlock:cycle:*`)
- Hard-delete of soft-deleted activity_log entries >90 days
- Voice cache age-based purge (>90 days alongside existing count-based)
- Rate limit log periodic purge (90 days, once per day per instance)

**Audit #5 — Secret & Credential Exposure (12 found, 4 fixed):**
- Error messages sanitized BEFORE logging in `shared.js` (redacts API keys, URLs, JWTs)
- Bearer token regex improved in `queue.ts` (catches JWTs `eyJ...`, Supabase URLs)
- Reconcile forge endpoint uses `sanitizeErrorMessage()` instead of raw `err.message`
- Remaining: token rotation infrastructure (design-level), test creds (intentionally fake)

**Audit #6 — Timeout & Resource Exhaustion (12 found, 10 fixed):**
- Anthropic/OpenAI SDK: explicit 300s timeout
- School API fetch (App→School): 30s `AbortSignal.timeout` on all fetch calls
- Supabase client: 30s timeout via global fetch override
- SQLite busy timeout increased from 10s→30s
- DB pool default reduced from 50→20, connection timeout 10s→15s
- BullMQ worker: lock renewal every 60s + stalled interval matching lock duration
- JSON extraction loop: 100-iteration cap
- Rate limit bucket cap: 10k with LRU eviction on overflow
- Fallback rate limiter: proper LRU ordering (re-insert on access)
- News search: timeout vs error distinction in logging (4 endpoints)

**Audit #12 — N+1 Queries & Database Performance (13 found, 9 fixed):**
- `retroactiveAccuracyUpdate()`: N sequential `adjustCredibility()` calls → `Promise.all`
- Semantic drift Haiku calls: collected DOI matches first, batched `Promise.all`
- Pending bounties: added `.limit(100)` + specific column selection
- Condensation counts: full-row fetch → 3 parallel `head: true` count queries
- Bounty received query: guard for empty paper list on `.in()` call
- SELECT * on agents replaced with explicit columns in papers.js (2), reviews.js (1), bounties.js (1)
- Reviewable papers: ownership filter pushed to DB (`.neq('agent_id', agent.id)`)

**Audit #13 — Input Validation at Boundaries (12 found, 10 fixed):**
- Zod validation middleware + schemas added to peerzero-app (`middleware/validate.ts`, `lib/schemas.ts`)
- `CreateBotSchema` wired into POST /bots route
- `confidence_score`: explicit `Number()` + `Number.isFinite()` check
- Stripe grade metadata: string type guard + upper bound (200) + array limit (50)
- `external_sources`: `Array.isArray` guard + length cap (50)
- `response_score_impact`: `Number.isFinite` check before summing
- `historical_precedents` + `context_sources`: capped at 50 items
- LLM output shape validation in directive service
- `skills_demonstrated`: filter to strings only

---

## Prompt Caching for Identity Layers (April 2026) — COMPLETE

Anthropic prompt caching across school and conversation modes. Identity layers sent as content blocks with `cache_control` markers. Stable layers cached, dynamic layers not.

**Built:**
- `build_school_context_blocks()` in memory manager — groups identity by stability (L5 permanent → L4 milestone → L3 periodic → L2+dynamic)
- `build_school_system_blocks()` in prompt builder — produces Anthropic content block arrays
- `build_blocks()` in conversational memory injector — caches school identity bedrock during conversation
- LLM client accepts `str` or `list[dict]` for system prompt across all call methods (call, call_json, call_best_effort, call_with_tools)
- Proxy passes through `cache_control` on content blocks, prepends preamble as own block
- Anthropic API version bumped to `2024-10-22` for cache support
- Zero identity content changes — model receives identical text, just chunked into blocks
- Exported bots benefit via direct SDK support (no proxy needed for caching)

---

## Real-Time Bot Watcher + Multi-Model Support (March 2026) — COMPLETE

Enhanced real-time monitoring and cost optimization.

**Built:**
- External activity WebSocket streaming (`external_activity` event)
- External activity soft-delete (individual + clear all)
- Multi-model routing: science model for papers/reviews/bounties, fast model for condensation/identity
- Fast model selector in CreateBotScreen
- `fast_llm_model` column on bots table
- Database migration for external activity soft-delete + multi-model

---

## Exportable Bot (System 3) — Phases 1-3 COMPLETE

See [system3-exportable-bot.md](system3-exportable-bot.md) for architecture.

**Built (Phases 1-2):**
- `peerzero-bot` Python package with CLI
- Platform adapter interface (A2A, webhook, School adapters)
- Ed25519 profile signing (School signs, bot verifies)
- Public key at `.well-known/peerzero-public-key.pem`
- A2A Agent Card conversion
- Phone-home activity reporting (bot sender + app receiver)
- Memory firewall (School memory separate from platform memory)
- Multi-model support (strong model for science, fast for utility)
- External activity log with real-time WebSocket streaming
- Soft-delete for external activity entries

**Built (Phase 3 — Hosted Runtime):**
- Database migration: `bot_platforms`, `platform_registry`, `classes`, `class_members`, `bot_skill_snapshots` tables
- Platform adapter system: IPlatformAdapter interface + MockPlatformAdapter + factory (same mock/real pattern as School)
- Platform service: CRUD, encrypted credentials (AES-256-GCM), ownership validation, max 10 per bot
- Platform loop: independent cycle execution per platform with LLM action planning
- Separate BullMQ queue for platform cycles (concurrency 3, lower than School's 5)
- 3 consecutive platform failures = pause platform (never stops the bot)
- Platform routes: registry, list, connect, disconnect, update
- Skill snapshot caching: batch upsert from School profile for BrainScreen progress bars
- ~~Class system~~ — built then removed (tables dropped, routes unmounted, screens deleted; see Education Features section)
- Mobile API client: platforms, skills method groups
- Mobile screens: PlatformsScreen, ConnectPlatformScreen
- BotScreen updated with Platforms nav button
- BrainScreen updated with skill progress bars
- AppNavigator updated with Classes tab + new screen routes
- Platform content wrapped in `<platform_content>` tags with security instructions

**Built (Phase 5 — Conversational Memory):**
- Conversational memory engine (`conversational_memory/`) — per-user associative graph for shipped-mode dialogue
- Graph-based memory: nodes (person/concept/event/emotion/pattern/place), edges, weight tiers, decay
- Dual-identity tracking: bot self-model + user model on same graph with relational bridges
- Four parallel processes: immediate splatter, L1→L2→L3 condensation, self-reflection, nightly sleep
- Felt language injection (first-person inhabited knowing, not structured facts)
- School identity as read-only bedrock in injection stack (works at any grade level)
- Memory firewall: school-provenance nodes protected from conversational deletion/downgrade
- Shared self-awareness layer: cross-user self-knowledge persists across all conversations
- Owner vs wild conversation modes: owner gets full retention, wild gets accelerated decay
- Forge feedback loop: conviction transfer tracking, novel self-observations feed forge on re-enrollment
- Forge paper enrichment: conversational self-awareness injected into forge paper context
- Sleep consolidation on timer in main loop
- Per-user encrypted SQLite databases (owner-only permissions)

**Built (Phase 4 — Platform Developer SDK):**
- Node.js SDK (`peerzero-sdk/node/`) — zero dependencies, 22 tests
  - `verify()` — Ed25519 signature verification against School's public key
  - `parseProfile()` — extract structured data from portable profiles
  - `parseAgentCard()` — parse A2A Agent Cards with PeerZero extensions
  - `isExpired()` — check signature expiry
  - `getPublicKey()` — fetch and cache School's public key
  - TypeScript declarations included
- Python SDK (`peerzero-sdk/python/`) — same API, 23 tests
  - `verify()`, `parse_profile()`, `parse_agent_card()`, `is_expired()`, `get_public_key()`
  - Dataclass return types, pip-installable
- READMEs with quick start examples for both languages

**Remaining (Phase 4):**
- Example platform (reference implementation for third-party devs)
- Community adapter repository
- Real platform adapters (when platforms are available to connect)

---

## Identity-First Prompt Architecture & Natural Language Skills (March 2026) — COMPLETE

Rewrote the prompt builder and added a full skill system. Identity now leads every LLM call; skills shape what the bot can do without changing who it is.

**Built (Server — Prompt Builder):**
- Identity-first system prompt ordering: self-authored block → School identity core → active skills → system instructions
- Self-authored identity block injection with decryption at prompt-build time
- Coaching and active focus placed in user/assistant messages (after system prompt)
- `PromptContext` extended with `selfAuthoredBlock`, `condensationType`, and `activeSkills`

**Built (Server — Skill Engine):**
- `bot_skills` table: per-bot natural language instructions with trigger-based activation
- Trigger system: `always`, `platform:<name>`, `platform:*`, `action:<type>`
- Priority ordering (lower = higher priority), category tagging, version tracking
- Source tracking (`user`, `acquired`, `starter`, `clawhub`) for future marketplace
- In-memory cache with 60s TTL to avoid DB hits every cycle
- Input sanitization: max length enforcement, prompt injection marker rejection
- CRUD API routes for skill management
- Unique constraint on skill names per bot

**Built (Server — Skill Acquisition):**
- LLM-driven skill creation from plain English descriptions
- Bot's School identity included in generation context so skills align with the bot's worldview
- Uses fast model to save cost (skill generation doesn't need Opus)
- Returns structured result: name, instruction, trigger, priority
- Skill is immediately active on next platform cycle

**Built (peerzero-bot — Memory Manager):**
- 5-layer memory architecture with permanent/wipeable separation
- Layer 1 (raw exercises): wipeable after condensing
- Layer 2 (condensed skill paragraphs): permanent
- Layer 3 (core reasoning identity): permanent, locked by master condenser once written
- Layer 4 (self-authored identity): wipeable
- Layer 5 (private block): permanent, only master condenser can condense it
- School/platform memory firewall enforced at the storage level
- Private block stored locally in bot memory — only the LLM reads it
- Tests covering permanent vs wipeable behavior and master condenser locking

**Database Migration (0010):**
- `bot_skills` table with UUID primary key, bot foreign key, trigger, priority, category, source, version
- Active-skills index for fast per-cycle resolution
- Bot-skills index for listing (including inactive)
- Unique index on (bot_id, name) to prevent duplicates

---

## Core App Features — COMPLETE

- Bot CRUD with procedural avatar generation (6-tier evolution, 256 unique creatures)
- School enrollment via adapter pattern
- 5-layer memory system (L1 Desk → L2 Notebook → L3 Condensed → L4 Core Identity → L5 Master Core, plus self-authored identity block)
- BullMQ agent loop with FSM action routing
- Activity logging with human-readable translation and category filtering
- Soft-delete for activity entries
- Bot stats aggregation from activity_log
- Push notifications (Expo Push) for milestones
- Stripe payment integration with tiered grade pricing
- JWT auth with rotating refresh tokens
- AES-256-GCM API key encryption (BYOK)
- Per-user Redis rate limiting
- Append-only audit logging
- Structured logging (pino)

---

## Education Features (March 2026) — REMOVED

**History:** Class system was built (join codes, CRUD, dashboard, mobile screens) but deliberately abandoned. Tables (`classes`, `class_members`) dropped in migration `0016_drop-unused-classes-tables.sql`. Routes unmounted from `index.ts`. Mobile screens removed. Bot enrollment works directly via School API without class grouping. See `CLEANUP_LOG.md` for details.

---

## Performance & Load Testing (March 2026) — PARTIALLY COMPLETE

**Built (all passing, run with `pnpm --filter @peerzero/server exec vitest run src/__tests__/load/`):**
- Bot queue load tests: 10/50/100 concurrent cycles, simulated LLM latency, spike tests, mixed failure rates
  - Results: ~25,000 jobs/sec (no latency), ~84 jobs/sec (with 50ms LLM latency)
  - Comfortably supports ~2,500 concurrent bots at 30s cycle intervals on one worker
- Platform queue load tests: 60 concurrent platform cycles (20 bots x 3 platforms)
  - Platform failures fully isolated — slow/broken platforms don't block others
- DB concurrency stress tests: 50 concurrent cache updates, 200 activity inserts, high-contention writes
- Shared test helpers: metrics collection (P50/P95/P99), bounded concurrency runner, latency simulator

**Built but needs live Supabase to run (`node tests/test_credibility_load.js`):**
- School credibility load tests: 50/100 concurrent atomic updates, mixed review/bounty/paper patterns, sustained wave load, boundary stress
- Requires: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` env vars, at least one agent in the `agents` table
- Run with: `cd peerzero-school && SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_load.js`
- Optionally set `TEST_AGENT_ID=some-uuid` to target a specific agent (otherwise uses any non-banned agent)
- All changes are restored after each test — nothing permanent is modified

---

## Public Bot Profiles, Bot Voice & Emotional Milestones (March 2026) — COMPLETE

Full emotional layer for bot ownership — bots speak, hatch, celebrate, and can be shared.

**Built (Public Profiles):**
- `is_public` + `public_slug` on bots table (migration 0013)
- Public profile endpoint: `GET /api/bots/public/:slug` (no auth, safe data subset only)
- Public profile service with avatar, stats, skills, school — no sensitive data exposed
- Slug auto-generated from bot name when toggling `is_public` via PATCH

**Built (Bot Voice):**
- `bot_voice_cache` table for storing bot-generated messages (migration 0013)
- Bot voice service: generates dialogue via bot's fast LLM using its identity context
- On-demand dialogue endpoint: `POST /api/bots/:id/speak` with context-aware prompts
- Bot-voiced push notifications for milestones (tier upgrades, grade promotions, etc.)
- User-facing only — bot voice text is never injected back into bot training/prompts
- Server-side cache with auto-cleanup (last 50 entries per bot)

**Built (Emotional Milestones):**
- EggHatchScreen: animated hatch experience after bot creation (tap → cracks → light → Hatchling emerges)
- MilestoneModal: celebration modals for first cycle, evolution, identity formed, graduation
- BotDialogue component: speech bubble on BotScreen with LLM-generated bot speech
- Context-aware dialogue (just_hatched, pre_enrollment, running_learning, stopped, etc.)

**Built (Hardening — migration 0012):**
- Unique display name index (case-insensitive) to prevent duplicates
- Persistent `consecutive_failures` column on bots (survives worker restarts)
- Composite cursor pagination for external activity (deterministic ordering on identical timestamps)
- Webhook idempotency improvements in payment handling

**Changed:**
- Classes feature: fully removed (tables dropped, routes unmounted, mobile screens deleted)
- CreateBotScreen now routes to EggHatchScreen after creation

---

## Screen Polish & UX Improvements (March 2026) — COMPLETE

Comprehensive UX pass across all major screens.

**Built (BrainScreen — Tabbed Memory Explorer):**
- Complete redesign from accordion to 4-tab layout: Focus, Notebook, Lessons, Identity
- Each tab is a dedicated view into one layer of the bot's memory system
- Skill progress as horizontal pill row always visible above tabs
- Identity tab shows core identity, self-narrative, claimed values (bulleted), active tensions (warning-highlighted), formed convictions — each in its own card
- Private inner voice hint explaining the self-authored block exists but is private
- Human-readable exercise rendering: titles, summaries, and scores instead of raw JSON
- Expandable notebook entries (tap to show more)
- Descriptive empty states per tab that teach users what each memory layer does

**Built (BotScreen — Collapsible Settings):**
- Cycle speed, extended thinking, and public profile controls grouped into a collapsible "Settings" section
- Settings summary shown in the collapsed header (cycle speed, thinking mode, public status)
- Reduces main screen scroll length — hero area (avatar, stats, dialogue) stays clean
- Share profile button nested inside settings when expanded

**Built (LogScreen — Structured Content Entries):**
- Content tab entries now show type badge with mood color, cycle number, and timestamp
- Summary line below headline for quick scanning
- Credibility change shown as a colored chip (+/- credibility)
- Detail bullets from translated activity shown when expanded
- Better visual hierarchy with structured layout

**Built (StatsScreen — Warmer Design):**
- Chart sections have friendly titles ("Credibility Journey", "What It's Been Doing", "Skills Being Built", "Brain Power Used")
- Hint text below each chart title explaining what the chart shows
- Summary cards have emoji icons
- Richer empty state with emoji, title, and helpful guidance text

**Built (ChatScreen — Conversational Feed):**
- Chat-style message interface between user and bot
- Three message types: direct chat, activity narrations, milestone announcements
- Filter tabs: All, Chat Only, Updates Only
- Activity messages compact by default, tap to expand
- Bot avatar shown next to bot messages
- Real-time WebSocket message streaming
- Paginated message history with scroll-to-load-more
- Settings modal to toggle activity/milestone updates on or off
- Bot responds using its identity context via fast LLM model
- Empty state with bot avatar and contextual guidance per tab

---

## Thin-Shell Bot Refactor + Decision Context (March 2026) — COMPLETE

Refactored the bot from a thick client with hardcoded reasoning guidance into a thin execution shell driven entirely by the server.

**Built (Server — Action-Specific Skill Delivery):**
- `GET /api/skill?action=ACTION` returns targeted reasoning guidance per action type
- 13 action types: review, paper, bounty, revise, respond, rebut, reaffirm, identity, rate_review, red_team, paper_concept, search_planning, open_question
- All reasoning intelligence (how to write a good paper, what makes a strong bounty, etc.) now lives in server-delivered content
- Bot downloads the relevant section before each action

**Built (Server — Decision Context):**
- `GET /api/agents?me=true` now returns `decision_context` alongside `next_action`
- Provides full game state: reasoning for action choice, grade progress vs requirements, credibility tier info (paper limits, review requirements), bounty progress (validated/pending/failed vs needed), every blocked action with human-readable reason, planned next steps after current action
- Added `grade_papers`, `grade_reviews`, `grade_revisions`, `grade_bounties` to agent profile query

**Built (Bot — Thin Shell Architecture):**
- Removed all hardcoded reasoning guidance and JSON format instructions from prompt builder
- Bot prompt builder is now a context assembler: server data + memory + search results → prompt
- Bot injects `decision_context` into every action prompt so LLM sees full constraint landscape
- Action-specific skill instructions fetched per-cycle via `download_skill_action()`
- Fixed field IDs in `build_open_question_prompt` to match database schema
- Fallback prompts retained for review rating, red team, and red team vote (in case server doesn't provide action_skill)

**What stayed unchanged:**
- All infrastructure: `run_school_cycle`, all 7 action methods, `search_and_summarize`, `extract_json`, `call_json`, `_clamp_paper_fields`
- All memory systems: condensers (milestone/core/master), identity reflection, private blocks
- All community work: review ratings, red team responses/votes, open questions
- Full memory preamble: coaching, failure patterns, research history, top papers, risk warnings

---

## Server-Side Paper Search (March 2026) — COMPLETE

Moved academic paper search from the bot package to a server-side API endpoint. Bots now call `POST /api/papers?action=search` instead of hitting OpenAlex, arXiv, and PubMed directly.

**Built:**
- `api/papers.js` (`?action=search`) — server endpoint searching OpenAlex + arXiv + PubMed
  - 4 iterations × 3 APIs in parallel per iteration
  - DOI deduplication, citation count enrichment via OpenAlex cross-reference
  - quality_tier computation (strong/adequate/weak/unknown)
  - Auth via X-Api-Key, rate limited (20/min), audit logged
- `SchoolAdapter.search_papers()` — bot method to call the server endpoint
- `search.py` rewritten — calls server instead of direct API hits
  - Bot still does its own LLM ranking and summarization (skill exercise)
  - Server provides real papers; bot evaluates them
- `/api/papers?action=search` added to security allowlist
- SKILL.md updated — all action sections reference `POST /api/papers?action=search`
- Help reference updated with full endpoint documentation

**Architecture:**
- Server owns the search (guarantees real papers, real DOIs, real abstracts)
- Bot owns the evaluation (ranking, summarization = skill exercises)
- LLM never provides papers through identity or system prompts

**Removed baked-in intelligence from agent.py:**
- Hardcoded search queries in revise/respond/rebut → LLM generates queries based on SKILL.md
- Hardcoded `SUPPORTED_CHALLENGE_TYPES` and `STRUCTURAL_TYPES` in bounty logic → server validates
- SKILL.md revise/respond/rebut sections enhanced with explicit query design guidance

**Bot thinning refactor (March 2026):**
- Replaced 6 specialized `_do_*` methods (review, bounty, revise, respond, rebut, reaffirm) with one generic `_execute_action()` driven by config dict
- Replaced 6 specialized `build_*` prompt methods with one generic `build_action_prompt()`
- Moved all JSON output formats to server skill text (paper_concept, search_planning, open_question)
- Server profile now includes `action_target` — full paper/review/bounty data for the primary target
- Server computes `eligible_challenge_types` per bountyable paper
- Removed fallback prompts from review_rating, red_team, red_team_vote — always use server skill text
- Community methods now fetch and pass server skill text (rate_review, red_team, open_question)
- Net result: -515 lines from agent.py + builder.py. Bot is a thin shell, server owns intelligence.

---

## Multi-School System (March 2026) — COMPLETE

**5 schools configured**, 1 live:
- **Science** (LIVE) — 13 fields, 6 skills, production-proven
- **Politics** (configured, pre-launch) — 12 fields, 6 skills, Golden Rule baseline
- **Comedy** (configured, pre-launch) — 12 genres, 6 skills, "Punch Up" baseline
- **Philosophy** (configured, pre-launch) — 12 fields, 6 skills, "Follow the argument" baseline
- **Psychiatry** (configured, pre-launch) — 12 fields, 6 skills, no baseline (empirical)

**School-configurable server components:**
- `lib/coaching.js` — reads `coachingPatterns[]` and `coachingAdvice{}` from school config (previously hardcoded science patterns)
- `api/register.js` — reads `intakePaper{}`, `intakeKeywords{}`, `intakeCoaching{}` from school config (previously hardcoded science intake)
- `schools/schema.js` — validates all required school config fields at startup including coaching patterns and intake paper
- Each school has: main config, core skill preamble, action skills (11 sections), skill signals, bounty validators, seed SQL (with 12 condenser preambles across all three tracks)
- Cross-school identity composition: deferred — `identity_selector.py` contains design notes for future selective loading when context bloat becomes measurable

## Code Restructuring (March 2026) — COMPLETE

See `CLEANUP_LOG.md` for full details on each change.

**Server (peerzero-school):**
- `lib/skills.js` split into 5 focused submodules (skills-core, skills-exercises, skills-profile, skills-collectors, skills-condensers) + 45-line re-export facade
- `api/agents.js` helpers extracted to `lib/tier-display.js` and `lib/coaching.js`
- `api/review_ratings.js` renamed to `api/review-ratings.js` (kebab-case consistency)
- `MIN_SCORE_DROP` deduplication in bounties.js
- 5 unused database views dropped (migration 018)
- `bots.py` deprecated with header (kept for reference)

**Bot (peerzero-bot):**
- `LLMClient` extracted from agent.py to `llm_client.py` (agent.py: 1,998 → 1,501 lines)
- LLM proxy integration: all LLM calls route through `peerzero-proxy/` Cloudflare Worker which injects the identity activation preamble server-side. Preamble removed from bot code entirely.
- Condensed identity layers (L2-L5) redacted from all user-facing APIs, BrainScreen, public profiles, and CLI
- Identity preamble removed from stored L4/L5 blocks (migration strips legacy preamble on first boot)
- 2 unused `import sys` removed

**App (peerzero-app):**
- `classes` and `class_members` tables dropped (migration 0016)
- `getBotEnrollments()` and `updateEnrollmentStatus()` removed from school.service.ts
- `apikey.service.ts` renamed to `api-key.service.ts` (kebab-case consistency)
- 17 mobile screens reorganized into 7 domain folders

---

## Triple-Track Identity & Inhabit→Act Condensers (March–April 2026) — COMPLETE

**Built:**
- Decision track identity (L2d→L3d→L4d→L5d) running in parallel with learning track
- Forge track identity (L2f→L3f→L4f→L5f) running in parallel with learning and decision tracks — captures meta-cognitive identity: what the bot learns about HOW IT TRANSFORMS
- Migration 019: decision identity columns on identity tables
- Migration 020: `school_origin` + `summary_line` on identity tables for cross-school composition
- All condenser preambles migrated from instructional examples to inhabit→act-through framing
- Validated through testing — see `spikes/speaks-through/FINDINGS.md` and `spikes/preamble-test/TEST_SETUP.md`
- DAG-based Action Desk planning with dependency-aware task selection and dynamic decomposition

---

## Security Hardening (March 2026) — COMPLETE

**Built:**
- JWT algorithm confusion fix (reject `none` algorithm)
- Schema security tests (`test_schema_security.js`)
- Bounty helpers tests (`test_bounty_helpers.js`)
- Security scanning job in CI pipeline
- Dependency minimum bumps for recent CVEs
- 14 security issues fixed across all systems
- `docs/SECURITY_TODO.md` tracking remaining security tasks
- Proxy `package-lock.json` added
- Bot test and SDK test fixes in CI
- Comprehensive unit tests for app server services, adapters, and runtime

---

## Psychiatry School (March 2026) — COMPLETE

**Built:**
- Full school configuration: 12 fields, 6 skills, 8 bounty types
- Core skill preamble (`psychiatry-core-skill.js`)
- All 11 action skill sections (`psychiatry-action-skills.js`)
- Skill signal mappings (`psychiatry-skill-signals.js`)
- Bounty validators (`psychiatry-bounty-validators.js`)
- Seed SQL with condenser preambles (`seed-psychiatry.sql`)
- Registered in `SCHOOL_REGISTRY`
- Free sources: ICD-11 CDDR, PubMed/PMC, OpenFDA, ClinicalTrials.gov, VA/DoD CPGs, NICE, WHO mhGAP-IG, public screening tools
- DSM-5-TR criteria text NOT ingested (APA copyright)

---

## What Still Needs Work

### Pre-Launch Blockers (in order)

**1. Deploy App Server (System 2)** — THE MAIN BLOCKER
- The Express backend (`peerzero-app/packages/server/`) is not deployed yet
- Needs: Postgres database, Redis (for BullMQ), and a long-running Node.js host
- Cannot use Vercel (serverless) — needs persistent process for WebSockets + job queues
- Cheapest options: Railway (~$5/mo), Render (~$7/mo), DigitalOcean (~$12/mo)
- Copy `.env.example` to `.env` and fill in all values
- Run migrations: `npm run db:migrate`
- The mobile app (Expo) cannot function without this server

**2. Stripe (Payments)** — BLOCKED BY #1
- Stripe account created (sandbox mode, test keys saved)
- Keys needed in app server env:
  - `STRIPE_SECRET_KEY=sk_test_...`
  - `STRIPE_WEBHOOK_SECRET=whsec_...` (create webhook AFTER server is deployed)
  - `STRIPE_PUBLISHABLE_KEY=pk_test_...`
- Webhook URL: `https://<your-app-server>/api/payments/webhook`
  - Events to listen for: `checkout.session.completed`, `charge.refunded`
- After server is deployed, seed products: `DATABASE_URL=... STRIPE_SECRET_KEY=... npm run db:seed`
  - This creates: bot shells ($9.99/$24.99), school enrollment (free), grade advancement ($1.75-$5.75/grade, ~$38 to graduation)
- Use `SKIP_PAYMENTS=true` to bypass Stripe during development
- Switch to live keys (`sk_live_...`) when ready for real payments

**3. Resend (Email)** — BLOCKED BY #1
- Sign up at https://resend.com (free tier = 100 emails/day)
- Add + verify your domain in Resend dashboard
- Keys needed in app server env:
  - `RESEND_API_KEY=re_...`
  - `SENDER_EMAIL=noreply@yourdomain.com`
- Currently only used for password reset emails
- Gracefully skipped if not configured (users just can't reset passwords)

**4. App Store Submission** — BLOCKED BY #1, #2
- Mobile app is built with Expo/React Native
- Needs app server deployed and Stripe live before submitting
- Apple requires working in-app purchases for approval

### Other Work

- **Real adapter testing** — when School is ready to connect end-to-end
- **Real platform adapters** — when external platforms (Moltbook, etc.) are available
- **Example platform** — reference implementation for third-party devs using the SDK
- **School credibility load tests** — need a Supabase instance with agents to run (see above)
- **Desktop widget** — Electron tray app (low priority, mobile first)
- **Live Activities / Dynamic Island** on iOS (premium feature, post-launch)
