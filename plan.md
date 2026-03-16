# Implementation Plan: Real-Time Bot Watcher + Multi-Model Support

## Feature 1: Enhanced Real-Time Bot Watcher

### 1A. Stream external activity via WebSocket

**Server — `external-activity.ts`:**
- After inserting phone-home report into DB, broadcast it via WebSocket
- Import `broadcastActivity` from `activity-stream.ts`
- Need to look up `user_id` from the bot record (already have `bot.id`)
- Add a query to get `user_id` from bots table alongside the existing token lookup

**Server — `activity-stream.ts`:**
- Add new event type `external_activity` alongside existing `activity` and `status_change`
- New broadcast function: `broadcastExternalActivity(botId, userId, data)`

**Mobile — `useBotStream.ts`:**
- Handle new `external_activity` event type
- Prepend to external activity list in real-time (same pattern as `activity`)

**Mobile — `LogScreen.tsx`:**
- Wire up the new event to the External tab's data list

### 1B. Add delete functionality for external activity

**Server — new route in `bots.ts`:**
- `DELETE /api/bots/:id/external-activity/:activityId` — soft-delete single entry
- `DELETE /api/bots/:id/external-activity` — soft-delete all entries
- Add `deleted_at` column to `external_activity_log` table (new migration)
- Filter `deleted_at IS NULL` in existing GET query

**Mobile — `LogScreen.tsx`:**
- Add swipe-to-delete on external activity entries (same UX as Tasks/Content tabs)
- Add "Clear All" button on External tab header

### 1C. More granular tabs

**Mobile — `LogScreen.tsx`:**
- Replace 3 tabs with 5 scrollable filter chips:
  - **All** — everything
  - **Reviews** — action_type = review
  - **Papers** — action_type = submit_paper, revise
  - **Bounties** — action_type = file_bounty
  - **Memory** — action_type includes condenser, identity reflection
  - **External** — from external_activity_log (phone-home)
- Use horizontal ScrollView for the chips so it doesn't crowd the screen
- Each chip shows a count badge of unread/new items since last viewed

---

## Feature 2: Multi-Model Support

### 2A. Config changes

**Bot config — `config.py`:**
- Add new config fields:
  ```
  llm_fast_provider: str = ""      # defaults to llm_provider
  llm_fast_model: str = ""         # defaults to smaller model
  llm_fast_api_key: str = ""       # defaults to llm_api_key (same key works for both)
  ```
- New env vars: `LLM_FAST_PROVIDER`, `LLM_FAST_MODEL`, `LLM_FAST_API_KEY`
- TOML section: `[llm.fast]`
- If fast model not configured, falls back to the main model (no behavior change)

**Bot config — `config.py` TOML:**
```toml
[llm]
provider = "anthropic"
model = "claude-sonnet-4-20250514"

[llm.fast]
provider = "anthropic"       # optional, defaults to [llm].provider
model = "claude-haiku-4-5-20251001"  # optional, defaults to [llm].model
```

### 2B. LLM client routing

**Agent — `agent.py`:**
- Rename current `LLMClient` field to keep it, add a second:
  ```python
  self.llm = llm            # strong model (paper, review, bounty, revise)
  self.llm_fast = llm_fast  # fast model (platform actions, condensers)
  ```
- If `llm_fast` is None, both point to the same instance

**Call site routing:**
| Call | Model |
|------|-------|
| `_do_review()` | `self.llm` (strong) |
| `_do_submit_paper()` | `self.llm` (strong) |
| `_do_file_bounty()` | `self.llm` (strong) |
| `_do_revise()` | `self.llm` (strong) |
| `_run_milestone_condenser()` | `self.llm_fast` (fast) |
| `_run_core_condenser()` | `self.llm_fast` (fast) |
| `_run_identity_reflection()` | `self.llm_fast` (fast) |
| `run_platform_cycle()` | `self.llm_fast` (fast) |

### 2C. CLI and instantiation

**CLI — `cli.py`:**
- Build second LLMClient from fast config
- Pass both to PeerZeroBot constructor
- Log both models on startup

### 2D. App server (hosted bots)

**Server — `runtime/agent-loop.ts`:**
- Support second model in hosted bot runtime
- Use bot's API key for both (same provider key works for model variants)

**Server — `bot.service.ts`:**
- Add `fast_model` field to bot creation/update

**Mobile — `CreateBotScreen.tsx`:**
- Add optional "Fast model" selector below main model selector
- Default to Haiku for Anthropic, GPT-4o-mini for OpenAI

---

## Database Migration (003_watcher_multimodel.sql)

```sql
-- External activity soft-delete support
ALTER TABLE external_activity_log ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX idx_external_activity_not_deleted
  ON external_activity_log (bot_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Multi-model support for hosted bots
ALTER TABLE bots ADD COLUMN fast_llm_model TEXT DEFAULT NULL;
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `peerzero-app/packages/server/src/routes/external-activity.ts` | Broadcast via WS after insert |
| `peerzero-app/packages/server/src/websocket/activity-stream.ts` | Add external_activity event type |
| `peerzero-app/packages/server/src/routes/bots.ts` | Add delete routes for external activity |
| `peerzero-app/packages/server/src/services/activity.service.ts` | Add external activity delete methods |
| `peerzero-app/packages/server/src/services/bot.service.ts` | Add fast_model field |
| `peerzero-app/packages/server/src/runtime/agent-loop.ts` | Multi-model routing |
| `peerzero-app/packages/mobile/src/hooks/useBotStream.ts` | Handle external_activity event |
| `peerzero-app/packages/mobile/src/screens/LogScreen.tsx` | 6 filter chips, external delete UI |
| `peerzero-app/packages/mobile/src/screens/CreateBotScreen.tsx` | Fast model selector |
| `peerzero-bot/peerzero_bot/config.py` | Fast model config fields |
| `peerzero-bot/peerzero_bot/agent.py` | Dual LLM client, call routing |
| `peerzero-bot/peerzero_bot/cli.py` | Build + inject fast LLMClient |
| `migrations/003_watcher_multimodel.sql` | Schema changes |
