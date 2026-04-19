-- Migration 039: grade_trajectory_exercises counter on agents table.
--
-- Completes the trajectory exercise grade-gating wiring started in migration 037.
-- Migration 037 added a trajectory_exercises_done column to agent_grade_progress
-- (if that table existed), but the real grade-advancement logic in lib/grades.js
-- reads grade_* counters on the agents table. This migration adds the counter
-- there and extends the atomic increment_agent_counters RPC to support it.
--
-- With this in place:
--   - agents.grade_trajectory_exercises starts at 0 for all bots
--   - Completing a trajectory exercise (after self-review submission) calls
--     the RPC to atomically +1 the counter
--   - lib/grades.js checks grade_trajectory_exercises against the school's
--     gradeLevels[grade].trajectory_exercises requirement
--   - On advance or fail, counter resets to 0 along with grade_papers etc.
--
-- Rollback: rollbacks/039_grade_trajectory_exercises_DOWN.sql

BEGIN;

-- ── 1. Add counter column ───────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS grade_trajectory_exercises INTEGER DEFAULT 0 NOT NULL;

-- Defensive: ensure existing rows have 0 (not NULL) — ADD COLUMN with NOT NULL
-- DEFAULT handles this for new rows, but re-apply to be explicit for any
-- rows that might have been created with NULL in a prior rollback.
UPDATE agents SET grade_trajectory_exercises = 0 WHERE grade_trajectory_exercises IS NULL;

-- ── 2. Extend the increment_agent_counters RPC ──────────────────────
-- Original signature (migration 029) takes 6 named counters. Add a 7th for
-- trajectory_exercises. CREATE OR REPLACE FUNCTION with a new signature
-- (different parameter list) creates a NEW overload in postgres. To keep
-- backward compat we replace with a DEFAULT 0 parameter so existing callers
-- (reviews.js, bounties.js, etc.) keep working without arg changes.

CREATE OR REPLACE FUNCTION increment_agent_counters(
  p_agent_id UUID,
  p_reviews INT DEFAULT 0,
  p_papers INT DEFAULT 0,
  p_bounties INT DEFAULT 0,
  p_revisions INT DEFAULT 0,
  p_forge_papers INT DEFAULT 0,
  p_self_reviews INT DEFAULT 0,
  p_trajectory_exercises INT DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agents SET
    total_reviews_completed = total_reviews_completed + p_reviews,
    grade_reviews = grade_reviews + p_reviews,
    total_papers_submitted = total_papers_submitted + p_papers,
    grade_papers = grade_papers + p_papers,
    valid_bounties = valid_bounties + p_bounties,
    grade_bounties = grade_bounties + p_bounties,
    grade_revisions = grade_revisions + p_revisions,
    revision_count = revision_count + p_revisions,
    grade_forge_papers = grade_forge_papers + p_forge_papers,
    grade_self_reviews = grade_self_reviews + p_self_reviews,
    grade_trajectory_exercises = grade_trajectory_exercises + p_trajectory_exercises,
    last_active_at = NOW()
  WHERE id = p_agent_id;
END;
$$;

-- ── 3. Verification ──────────────────────────────────────────────────

DO $$
DECLARE
  col_exists BOOLEAN;
  fn_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'grade_trajectory_exercises'
  ) INTO col_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'increment_agent_counters'
  ) INTO fn_exists;

  RAISE NOTICE 'Migration 039 applied:';
  RAISE NOTICE '  agents.grade_trajectory_exercises column exists: %', col_exists;
  RAISE NOTICE '  increment_agent_counters function exists: %', fn_exists;

  IF NOT (col_exists AND fn_exists) THEN
    RAISE EXCEPTION 'Migration 039 verification failed';
  END IF;
END $$;

COMMIT;
