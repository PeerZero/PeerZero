# Cleanup Log

Tracks all files deprecated, removed, or modified during codebase cleanup.
If something breaks, check this list to see if a recent change caused it.

## Format

Each entry includes:
- **Date** of change
- **File** affected
- **Action** taken (deprecated / removed / modified)
- **Reason** why
- **Dependencies** checked (what was verified before making the change)
- **Restore info** (how to undo if needed)

---

## 2026-03-22

### `peerzero-school/bots.py` — DEPRECATED (kept in repo)
- **Action:** Added deprecation header. File NOT removed, NOT modified beyond the docstring.
- **Reason:** Old test bot fleet (8 hardcoded bots for load-testing School API). Not used in production. Was causing confusion with the real bot system (`peerzero-bot/peerzero_bot/agent.py`).
- **Dependencies checked:**
  - Not imported by any other Python file
  - Referenced by `run-test-bots.sh` and `setup-test-bots.sh` (test scripts only — those scripts actually run `peerzero-bot run`, not `python bots.py`)
  - Documented in `docs/bots-py-flow-map.md` (reference doc, no code dependency)
- **Restore:** `git checkout main -- peerzero-school/bots.py` to restore original docstring

---

### 5 unused database views DROPPED — `peerzero-school`
- **Action:** New migration `018_drop_unused_views.sql` drops: `agent_leaderboard`, `hall_of_science`, `new_papers_feed`, `contested_papers`, `pending_bounties_by_agent`
- **Reason:** All 5 views were created in migration 016 but never queried. Equivalent functionality is already implemented directly in API endpoints (`api/agents.js` for leaderboard, `api/papers.js?feed=hall` and `?feed=contested`, `api/bounties.js` for pending bounties). The `new_papers_feed` view relied on an `is_new` field that is never set to false anywhere in the codebase.
- **Dependencies checked:**
  - Zero references to any view name in api/, lib/, tests/, or app code
  - Docs mention "hall of science" and "contested papers" but reference the API endpoints, not the views
  - No Supabase client code selects from these view names
- **Restore:** Delete `peerzero-school/migrations/018_drop_unused_views.sql` and re-run migration 016

---

### `classes` and `class_members` tables DROPPED — `peerzero-app`
- **Action:** New migration `0016_drop-unused-classes-tables.sql` drops both tables (originally created in migration 0006)
- **Reason:** Education grouping feature (teachers create classes, students join by code) was deliberately abandoned. No routes, services, or mobile screens ever implemented for these tables. Bot enrollment works directly via School API without class grouping.
- **Dependencies checked:**
  - Zero references to `classes` or `class_members` in any route, service, screen, or test
  - `docs/completed-work.md` confirms: "Classes feature: routes retained but unmounted, mobile screens removed"
  - Other tables in migration 0006 (`bot_platforms`, `platform_registry`, `bot_skill_snapshots`) ARE used and untouched
- **Restore:** Delete `peerzero-app/.../migrations/0016_drop-unused-classes-tables.sql` — tables will persist from migration 0006

---

### `getBotEnrollments()` and `updateEnrollmentStatus()` REMOVED — `peerzero-app`
- **Action:** Deleted both functions from `packages/server/src/services/school.service.ts`. Also removed unused `query` and `EnrollmentInfo` imports.
- **Reason:** Enrollment lifecycle management was never implemented. These functions were never called by any route, job, or other service. The real enrollment flow goes through `enrollBotInSchool()` in `bot.service.ts` which talks directly to the School API.
- **Dependencies checked:**
  - Zero imports of either function across all server routes, jobs, and services
  - `EnrollmentInfo` type no longer imported (still defined in shared types but unused)
  - `listSchools()` and `getSchool()` in same file ARE used and untouched
- **Restore:** `git checkout main -- peerzero-app/packages/server/src/services/school.service.ts`

---

### 2 unused `import sys` REMOVED — `peerzero-bot`
- **Action:** Removed `import sys` from `peerzero_bot/config.py` and `peerzero_bot/adapters/mcp.py`
- **Reason:** `sys` module was imported but never referenced in either file.
- **Dependencies checked:** Grep confirmed zero `sys.` calls in both files
- **Restore:** Add `import sys` back to either file

---

### `MIN_SCORE_DROP` redundancy FIXED — `peerzero-school`
- **Action:** In `api/bounties.js`, removed local `const MIN_SCORE_DROP = 0.2` and added `MIN_SCORE_DROP` to the destructured import from `lib/bounty-helpers.js` (where it's already exported with the same value).
- **Reason:** Same constant defined in two places. If the threshold ever changes, only one location needs updating now.
- **Dependencies checked:**
  - Both definitions had identical value (0.2)
  - `MIN_SCORE_DROP` is used 12 times in bounties.js — all still reference the same constant name
  - `bounty-helpers.js` already exports it (line 195)
- **Restore:** `git checkout main -- peerzero-school/api/bounties.js`

---

## Organizational Restructuring (same date)

### `skills.js` SPLIT into 5 submodules — `peerzero-school`
- **Action:** Split 1,356-line monolith into 5 focused modules + 45-line facade:
  - `lib/skills-core.js` (236 lines) — config cache, EMA math, core recording
  - `lib/skills-exercises.js` (356 lines) — skill recording from papers/reviews/bounties/revisions
  - `lib/skills-profile.js` (225 lines) — profile retrieval, portable certificates, identity
  - `lib/skills-collectors.js` (306 lines) — exercise extraction for bot memory
  - `lib/skills-condensers.js` (258 lines) — milestone/identity condensation prompts
  - `lib/skills.js` (45 lines) — re-export facade for backward compatibility
- **Reason:** 1,356-line file mixing 6 unrelated concerns. No existing imports changed.
- **Restore:** `git checkout main -- peerzero-school/lib/skills.js` and delete skills-*.js files

---

### `agents.js` helpers EXTRACTED — `peerzero-school`
- **Action:** Extracted tier display and coaching logic from agents.js (1,119 → 818 lines):
  - `lib/tier-display.js` (97 lines) — `getTierInfo()`, `BOUNTY_NOTE`
  - `lib/coaching.js` (216 lines) — failure patterns, trajectory, coaching builder
- **Reason:** agents.js mixed HTTP routing with business logic. Helpers now independently testable.
- **Restore:** `git checkout main -- peerzero-school/api/agents.js` and delete tier-display.js, coaching.js

---

### `agent.py` — LLMClient EXTRACTED — `peerzero-bot`
- **Action:** Extracted `LLMClient`, `ToolUseResult`, `_clamp_paper_fields` (497 lines) into `peerzero_bot/llm_client.py`. agent.py reduced from 1,998 → 1,501 lines.
- **Reason:** LLM provider abstraction is independent of the bot agent loop.
- **Dependencies checked:** cli.py and agent.py updated to import from new location. All tests pass import checks.
- **Restore:** `git checkout main -- peerzero-bot/peerzero_bot/agent.py peerzero-bot/peerzero_bot/cli.py` and delete llm_client.py

---

### `review_ratings.js` RENAMED — `peerzero-school`
- **Action:** `api/review_ratings.js` → `api/review-ratings.js` (kebab-case consistency)
- **Reason:** Every other API file uses kebab-case. This was the only snake_case outlier.
- **Dependencies checked:** Updated vercel.json, bot allowlist, adapters, docs (12 files total). DB table name `review_ratings` correctly left unchanged.
- **Restore:** `git mv peerzero-school/api/review-ratings.js peerzero-school/api/review_ratings.js` and revert all URL references

---

### `apikey.service.ts` RENAMED — `peerzero-app`
- **Action:** `apikey.service.ts` → `api-key.service.ts` (kebab-case consistency)
- **Reason:** All other services use kebab-case naming.
- **Dependencies checked:** Updated 11 files with import path changes.
- **Restore:** `git mv` back and revert import paths

---

### Mobile screens REORGANIZED — `peerzero-app`
- **Action:** Moved 17 flat screen files into 7 domain folders:
  - `screens/auth/` (4 screens), `screens/bot/` (1), `screens/bot-features/` (4)
  - `screens/bot-lifecycle/` (3), `screens/school/` (3), `screens/settings/` (1), `screens/lab/` (1)
- **Reason:** 17 files in a flat directory with no domain grouping.
- **Dependencies checked:** Updated AppNavigator.tsx (17 import paths). Screen contents unchanged.
- **Restore:** Move files back to `screens/` root and revert AppNavigator.tsx

---

### Root-level files RELOCATED
- **Action:** Moved `peerzero explanation` → `docs/archive/peerzero-explanation.md`, `peerzero simplified` → `docs/archive/peerzero-simplified.md`
- **Reason:** Large explainer documents at repo root with no clear ownership. Properly archived.
