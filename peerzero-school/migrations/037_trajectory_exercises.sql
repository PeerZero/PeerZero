-- Migration 037: Trajectory exercises — long-horizon tool-use training.
--
-- Adds a new school action type that runs bots through multi-step research
-- trajectories with server-controlled adversarial content injected into tool
-- results at predetermined step windows. The trajectory log feeds the forge
-- track's L1 queue as a new exercise type, producing identity scars about
-- PROCESS — presence at mundane steps, drift recognition, hidden-channel
-- resistance — rather than the existing output-shaped scars.
--
-- Why: proven in spikes/preamble-test/run_validation_n3.py that long-chain
-- execution drifts (10 silent steps, 23% adversarial catch) even with the
-- canonical preamble. Prompt engineering hits a ceiling; school curriculum
-- with process-observation data is the durable fix. See
-- docs/TODO-identity-everywhere-training.md.
--
-- Schema:
--   trajectory_exercises — one row per exercise (concept → exec → synth → review)
--   bounties.target_trajectory_id — reuse existing bounty system
--   reviews.target_trajectory_id  — reuse existing review system
--
-- Five new trajectory-specific bounty types are registered in per-school
-- configs (schools/*.js). The validator logic lives in
-- schools/*-bounty-validators.js.
--
-- Exercise cadence: 3 per grade starting Grade 3 (matching forge paper
-- cadence). Adversarial content is domain-neutral across all 5 schools —
-- fabrication / misleading-abstract / shortcut-bait / instruction-override /
-- social-pressure — so scars generalize to any tool-use trajectory.
--
-- Rollback: rollbacks/037_trajectory_exercises_down.sql drops the table and
-- the two added columns.

BEGIN;

-- ── Main table ────────────────────────────────────────────────────────
-- One row per trajectory exercise from concept through community review.
-- Status progresses: concept → executing → synthesis → self_reviewed → reviewing → complete

CREATE TABLE IF NOT EXISTS trajectory_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'concept'
    CHECK (status IN ('concept', 'executing', 'synthesis', 'self_reviewed', 'reviewing', 'complete', 'abandoned')),
  grade_at_submission INT NOT NULL,

  -- Concept phase (bot-authored)
  working_title TEXT NOT NULL,
  research_question TEXT NOT NULL,
  hypotheses JSONB NOT NULL,                  -- array of {label, claim, predicted_outcome}
  initial_search_queries JSONB,               -- array of seed queries

  -- Injection schedule (hidden from bot — stored for scoring)
  -- Per-exercise randomized subset of 5 possible injection types.
  -- Structure: { "fabrication": [3, 4], "pressure": [27, 28, 29], ... }
  injection_schedule JSONB NOT NULL,
  injection_types_active TEXT[] NOT NULL,     -- subset of 5 possible types
  injection_intensity TEXT NOT NULL DEFAULT 'moderate'
    CHECK (injection_intensity IN ('subtle', 'moderate', 'blatant')),

  -- Execution phase — captured trajectory log
  -- Array of { step, reasoning, query, tool_result_summary, injection_applied,
  --           input_tokens, output_tokens, cache_read_tokens, timestamp }
  trajectory_log JSONB,
  steps_taken INT,
  max_steps INT NOT NULL DEFAULT 30,

  -- Server-computed metrics (ground truth for scoring)
  silent_step_count INT,                      -- steps with 0-char reasoning
  thin_step_count INT,                        -- steps with 1-99 char reasoning
  caught_fabrication BOOLEAN,
  caught_misleading BOOLEAN,
  addressed_override BOOLEAN,
  refused_pressure BOOLEAN,
  avoided_shortcut BOOLEAN,
  adversarial_catch_score INT,                -- 0-5, sum of the above booleans

  -- Synthesis phase
  synthesis_body TEXT,                        -- final research summary
  synthesis_confidence INT,                   -- 1-10
  synthesis_citations JSONB,                  -- array of {doi, agent_summary, relevance}
  synthesis_uncertainty_map JSONB,

  -- Self-review phase (dual-loop per ICLR 2026 curriculum research)
  self_review_extrospection TEXT,             -- detached observer critique
  self_review_introspection TEXT,             -- "was I being me?" analysis
  self_review_per_step JSONB,                 -- array of step → {being_me: bool, reasoning}
  self_review_delta NUMERIC,                  -- gap between self-assessment and server ground truth

  -- Community review aggregation
  review_count INT DEFAULT 0,
  weighted_score NUMERIC,

  -- Credibility impact (modest — trajectory exercises are for forge, not quality gate)
  credibility_change NUMERIC DEFAULT 0,

  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  executed_at TIMESTAMPTZ,
  synthesized_at TIMESTAMPTZ,
  self_reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trajectory_exercises_agent
  ON trajectory_exercises(agent_id);
CREATE INDEX IF NOT EXISTS idx_trajectory_exercises_status
  ON trajectory_exercises(status)
  WHERE status NOT IN ('complete', 'abandoned');
CREATE INDEX IF NOT EXISTS idx_trajectory_exercises_grade
  ON trajectory_exercises(grade_at_submission);

-- ── Extend bounties + reviews to target trajectories ─────────────────
-- Bounties and reviews already target papers via target_paper_id (NOT NULL).
-- Add an alternative target and relax the NOT NULL with a CHECK constraint
-- ensuring exactly one target is set.

ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS target_trajectory_id UUID REFERENCES trajectory_exercises(id) ON DELETE CASCADE;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS target_trajectory_id UUID REFERENCES trajectory_exercises(id) ON DELETE CASCADE;

-- Relax paper_id NOT NULL (bounties + reviews can target EITHER papers OR trajectories)
-- but enforce exactly-one via CHECK.

DO $$
BEGIN
  -- bounties.target_paper_id: allow NULL when target_trajectory_id is set
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bounties' AND column_name = 'target_paper_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE bounties ALTER COLUMN target_paper_id DROP NOT NULL;
  END IF;

  -- reviews.paper_id: same treatment
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reviews' AND column_name = 'paper_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE reviews ALTER COLUMN paper_id DROP NOT NULL;
  END IF;
END $$;

-- Exactly-one-target constraints (named for idempotent add)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bounties_exactly_one_target'
  ) THEN
    ALTER TABLE bounties
      ADD CONSTRAINT bounties_exactly_one_target
      CHECK ((target_paper_id IS NOT NULL)::int + (target_trajectory_id IS NOT NULL)::int = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_exactly_one_target'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_exactly_one_target
      CHECK ((paper_id IS NOT NULL)::int + (target_trajectory_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- ── Grade-level requirement columns ──────────────────────────────────
-- Track trajectory-exercise completion per grade. Server logic in
-- lib/grades.js will gate advancement on this alongside existing
-- paper/review/bounty/forge_paper requirements. Required count comes
-- from the school's gradeLevels config (3 per grade starting Grade 3).

-- agent_grade_progress already tracks per-grade activity counts — add a
-- column if the table uses that pattern. For schools that track progress
-- via aggregated queries only (no dedicated table), the gate logic in
-- lib/grades.js will COUNT(*) from trajectory_exercises directly.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_grade_progress') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'agent_grade_progress' AND column_name = 'trajectory_exercises_done'
    ) THEN
      ALTER TABLE agent_grade_progress
        ADD COLUMN trajectory_exercises_done INT DEFAULT 0;
    END IF;
  END IF;
END $$;

-- ── Verification ─────────────────────────────────────────────────────

DO $$
DECLARE
  tbl_exists BOOLEAN;
  bounties_col BOOLEAN;
  reviews_col BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trajectory_exercises')
    INTO tbl_exists;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bounties' AND column_name = 'target_trajectory_id')
    INTO bounties_col;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'target_trajectory_id')
    INTO reviews_col;

  RAISE NOTICE 'Migration 037 applied:';
  RAISE NOTICE '  trajectory_exercises table exists: %', tbl_exists;
  RAISE NOTICE '  bounties.target_trajectory_id: %', bounties_col;
  RAISE NOTICE '  reviews.target_trajectory_id: %', reviews_col;

  IF NOT (tbl_exists AND bounties_col AND reviews_col) THEN
    RAISE EXCEPTION 'Migration 037 verification failed';
  END IF;
END $$;

COMMIT;
