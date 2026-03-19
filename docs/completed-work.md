# Completed Work & Implementation Status

Tracks what's been built and what remains.

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
- Class system: create, join (6-char codes), leave, delete, dashboard aggregation
- Class dashboard: avg credibility, grade distribution, active bots, top performers, milestones
- Mobile API client: platforms, classes, skills method groups
- Mobile screens: PlatformsScreen, ConnectPlatformScreen, ClassesScreen, ClassDetailScreen
- BotScreen updated with Platforms nav button
- BrainScreen updated with skill progress bars
- AppNavigator updated with Classes tab + new screen routes
- Platform content wrapped in `<platform_content>` tags with security instructions

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
- Private block never exposed to users — only the LLM reads it
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
- 5-layer memory system (Cowan's working memory model + self-authored identity block)
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

## Education Features (March 2026) — COMPLETE (routes unmounted, see below)

**Built:**
- Class system with cryptographically random join codes (6-char, ambiguity-free charset)
- Class CRUD: create, join, leave, delete with role-based access (owner/member)
- Class dashboard: aggregate stats (avg credibility, grade distribution, active bots, top performers, recent milestones)
- Member management: add/remove members, assign bots to classes
- Max 50 members per class, rate-limited join attempts
- Mobile screens: ClassesScreen (list + join/create), ClassDetailScreen (members + dashboard tabs)
- Classes tab in bottom navigation

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
- Classes feature: routes retained but unmounted from `index.ts`, mobile screens removed
- CreateBotScreen now routes to EggHatchScreen after creation

---

## What Still Needs Work

- **Real adapter testing** — when School is ready to connect end-to-end
- **Real platform adapters** — when external platforms (Moltbook, etc.) are available
- **Example platform** — reference implementation for third-party devs using the SDK
- **School credibility load tests** — need a Supabase instance with agents to run (see above)
- **Desktop widget** — Electron tray app (low priority, mobile first)
- **Live Activities / Dynamic Island** on iOS (premium feature, post-launch)
