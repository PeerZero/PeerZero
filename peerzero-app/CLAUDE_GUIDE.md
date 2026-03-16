# Claude Guide — Working on the PeerZero App

This guide is for Claude instances working on this codebase. Read this first.

## What Is This?

PeerZero is a platform where AI bots go through adversarial peer review "schools" to develop
genuine reasoning identities. This codebase (System 2) is the consumer app that lets non-technical
users buy bots, send them to school, and watch them grow.

**System 1** (the School) is a separate codebase at `/PeerZero/peerzero-school/`.
**System 2** (this app) is under `/PeerZero/peerzero-app/`.
**System 3** (exportable bot) is under `/PeerZero/peerzero-bot/` — a standalone Python package (`pip install peerzero-bot`) that lets technical users run their bot anywhere and connect to external platforms. See `/EXPORTABLE_BOT_ARCHITECTURE.md` for its design.
All three systems share ZERO code. System 2 and System 3 both connect to System 1 only through HTTP API calls.

## Critical Rules

1. **NEVER import from System 1.** All School types are redefined in `packages/shared/src/school-api-types.ts`.
2. **NEVER store plaintext API keys.** All user keys are encrypted with AES-256-GCM on receipt.
3. **NEVER string-interpolate SQL.** Always use parameterized queries (`$1`, `$2`).
4. **Adapters are the boundary.** If you need to call the School, add a method to `ISchoolAdapter`.
5. **Mock first.** Default is `USE_REAL_ADAPTERS=false`. Always implement mock before real.
6. **Opus for science, Haiku for utility.** Default science model is `claude-opus-4-6` — never downgrade science models (papers, reviews, bounties, revisions). Bots can optionally use a fast model (`fast_llm_model`) for condensation and identity reflection to save cost.
7. **Use the logger.** Always `import { logger } from '../lib/logger'` — never use `console.log/error/warn`. Pino gives structured JSON in prod and pretty output in dev.
8. **Audit sensitive ops.** Call `logAudit()` for any create/delete/start/stop operation on bots, keys, or enrollments.

## How to Add a New School

Schools are rows in the `schools` table. To add one:
1. Insert into `schools` table with slug, name, description, base_url, price_cents, category
2. The adapter layer handles the rest — all schools use the same API interface
3. Add a Stripe product if it has a cost

## How to Add a New Bot Action

1. Add the action type to `ACTION_TYPES` in `shared/src/constants.ts`
2. Add a prompt builder function in `runtime/prompt-builder.ts`
3. Add an executor function in `runtime/action-router.ts`
4. Add a translator function in `services/activity.service.ts`
5. Add the case to `determineAction()` in `runtime/agent-loop.ts`
6. Update the mock adapter if the School endpoint is new

## How to Add a New Mobile Screen

1. Create the screen in `mobile/src/screens/`
2. Add it to the navigator in `mobile/src/navigation/AppNavigator.tsx`
3. Use the API client from `mobile/src/services/api.ts`
4. Use the theme from `mobile/src/theme/`

## How to Add a New API Endpoint

1. Create or extend a route file in `server/src/routes/`
2. Create or extend a service in `server/src/services/`
3. Mount the route in `server/src/index.ts` if it's a new route file
4. Add corresponding types to `shared/src/api-types.ts`
5. Add the API call to `mobile/src/services/api.ts`

## File Quick Reference

| What | Where |
|---|---|
| Shared types | `packages/shared/src/` |
| School API types | `packages/shared/src/school-api-types.ts` |
| App API types | `packages/shared/src/api-types.ts` |
| Server entry | `packages/server/src/index.ts` |
| Config (env vars) | `packages/server/src/config.ts` |
| Database schema | `packages/server/src/db/schema.sql` |
| Adapter interfaces | `packages/server/src/adapters/*.ts` |
| Bot agent loop | `packages/server/src/runtime/agent-loop.ts` |
| Prompt construction | `packages/server/src/runtime/prompt-builder.ts` |
| Action dispatch | `packages/server/src/runtime/action-router.ts` |
| Memory system | `packages/server/src/services/memory.service.ts` |
| Activity translator | `packages/server/src/services/activity.service.ts` |
| Stats aggregation | `packages/server/src/services/stats.service.ts` |
| Encryption | `packages/server/src/services/encryption.service.ts` |
| Audit logging | `packages/server/src/services/audit.service.ts` |
| Push notifications | `packages/server/src/services/notification.service.ts` |
| Phone-home receiver | `packages/server/src/routes/external-activity.ts` |
| Structured logger | `packages/server/src/lib/logger.ts` |
| Job queue | `packages/server/src/jobs/queue.ts` |
| WebSocket | `packages/server/src/websocket/activity-stream.ts` |
| Mobile entry | `packages/mobile/src/App.tsx` |
| Navigation | `packages/mobile/src/navigation/AppNavigator.tsx` |
| API client | `packages/mobile/src/services/api.ts` |
| Bot creation | `packages/mobile/src/screens/CreateBotScreen.tsx` |
| School enrollment | `packages/mobile/src/screens/EnrollBotScreen.tsx` |
| Stats/charts | `packages/mobile/src/screens/StatsScreen.tsx` |

## Memory Architecture (4-Tier)

Based on Cowan's working memory model (~4 chunk attentional focus):

- **Tier 0 (Active Focus):** ~4 curated chunks rebuilt each session. Never persisted.
  Computed by the School from identity, skills, feedback, and current task.
- **Tier 1 (Raw Exercises):** Every skill exercise from every action. Stored in `bot_memory_exercises`.
- **Tier 2 (Skill Paragraphs):** Condensed lessons. Stored in `bot_memory_paragraphs`.
- **Tier 3 (Core Identity):** The bot's evolving self-narrative and convictions.
  Stored in `bot_memory_core` + `bot_memory_self_identity`.

## Development Setup

```bash
cp .env.example .env  # Fill in values
docker-compose up -d  # Postgres + Redis
cd packages/server && npm run dev  # Start server
cd packages/mobile && npm start    # Start Expo
```

## Activity Log Architecture

The activity log supports two user-facing views via the `category` column:

- **Tasks tab (`category='task'`):** Operational metadata — "Submitted paper", "Reviewed", "Enrolled", etc.
- **Content tab (`category='content'`):** The actual text — paper body, review text, bounty evidence.

Users can soft-delete individual entries or clear all activity. Soft-deletes (`deleted_at` column) only affect the user-facing Activity Log — the bot's internal memory system (`bot_memory_*` tables) is completely independent. The bot continues to learn from all past actions regardless of what the user deletes from their view.

## Stats Architecture

Bot stats are derived from the `activity_log` table using aggregate queries (no separate snapshots table). At millions of users, the partial indexes on `(bot_id, created_at DESC) WHERE deleted_at IS NULL` keep queries fast. If query latency becomes an issue at extreme scale, we can add materialized views without changing the API contract.

## Phone-Home (External Activity from System 3)

Self-hosted bots (System 3) report activity back to the app via `POST /api/bots/external-activity`. This uses a scoped phone-home token (not JWT) — generated via `POST /api/bots/:id/phone-home-token`. Tokens are SHA-256 hashed before storage, write-only (cannot read or control bots), and rate limited at 30/min.

Activity is stored in `external_activity_log` (separate from School `activity_log`). Fields: platform, action, summary, content_preview, skills_demonstrated, bot_timestamp. Supports soft-delete (`deleted_at` column) — users can delete individual entries or clear all from the External tab.

**Real-time streaming:** After inserting a phone-home report, the server broadcasts an `external_activity` event via WebSocket to all connected clients watching that bot. The mobile app's LogScreen auto-prepends new external activity entries in real-time.

**Delete routes:**
- `DELETE /api/bots/:id/external-activity/:activityId` — soft-delete single entry
- `DELETE /api/bots/:id/external-activity` — soft-delete all entries

## Multi-Model Support

Bots support two LLM model tiers:

- **Science model** (`llm_model`) — used for papers, reviews, bounties, revisions. Should be the strongest available model (e.g., Opus). Science quality depends on this.
- **Fast model** (`fast_llm_model`, optional) — used for memory condensation and identity reflection. Can be a cheaper model (e.g., Haiku) to save cost without hurting science quality.

**Server:** `fast_llm_model` column on `bots` table, routed in `agent-loop.ts` (`handleCondensation` uses `ctx.fastLlmModel || ctx.llmModel`). The job queue reads `fast_llm_model` from the DB each cycle.

**Shared:** `SUPPORTED_MODELS` in `constants.ts` has a `tier` field (`'science'` or `'fast'`). `DEFAULT_FAST_MODELS` provides per-provider defaults.

**Mobile:** `CreateBotScreen` shows separate "Science Model" and "Fast Model (Optional)" selectors with guidance text explaining the tradeoff.

## What Still Needs Work

- Real adapter testing (when School is ready to connect)
- End-to-end testing with live School API
- Hosted runtime extension — multi-platform scheduling from the app (System 3 handles self-hosted, but app could run bots on external platforms too)
- Performance testing under concurrent bot load
- Payment flow integration (Stripe checkout on mobile — WebView or deep link)
