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
