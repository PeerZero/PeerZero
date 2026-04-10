-- ============================================================
-- Migration 028: Meta-Forge Aggregation Loop
--
-- Tracks cross-bot forge paper aggregation, config evolution
-- proposals, and generation history. Enables the recursive
-- meta-forge loop: bot forge papers → aggregation → config
-- evolution → next generation trains in evolved school.
--
-- The system runs on a rolling window (not fixed cohorts)
-- since bots graduate continuously.
-- ============================================================

-- 1. Structured forge data extracted at submission time.
--    design_proposals, mechanism_rankings, assumption_autopsies
--    currently exist only in the paper body text. Store as JSONB
--    so the aggregation pipeline can query across bots.
ALTER TABLE papers ADD COLUMN IF NOT EXISTS forge_data JSONB;
-- forge_data schema:
-- {
--   design_proposals: [{ mechanism, change, predicted_effect }],
--   mechanism_rankings: [{ mechanism, rank, evidence }],
--   assumption_autopsies: [{ assumption, broken_by, grade }],
--   calibration_claims: [string]
-- }

COMMENT ON COLUMN papers.forge_data IS
  'Structured forge paper fields extracted at submission for cross-bot aggregation';

-- 2. Aggregation runs: each run scans a rolling window of
--    validated forge papers and produces config change proposals.
CREATE TABLE forge_aggregation_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start      TIMESTAMPTZ NOT NULL,
  window_end        TIMESTAMPTZ NOT NULL,
  papers_scanned    INTEGER NOT NULL DEFAULT 0,
  papers_qualified  INTEGER NOT NULL DEFAULT 0,
  summary           JSONB NOT NULL DEFAULT '{}',
  generation_number INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'complete', 'applied', 'rejected')),
  triggered_by      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_forge_agg_runs_status ON forge_aggregation_runs(status);
CREATE INDEX idx_forge_agg_runs_gen ON forge_aggregation_runs(generation_number DESC);

-- 3. Individual config change proposals extracted from aggregation.
--    Condenser preamble proposals require human review; safe config
--    (coaching, bounty weights, skill signals) can auto-apply.
CREATE TABLE forge_config_proposals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregation_run_id    UUID NOT NULL REFERENCES forge_aggregation_runs(id),
  config_category       TEXT NOT NULL
    CHECK (config_category IN (
      'coaching_pattern', 'bounty_weight', 'skill_signal',
      'review_emphasis', 'grade_requirement', 'condenser_preamble',
      'mechanism_weight', 'other'
    )),
  proposal_key          TEXT NOT NULL,
  proposal_value        JSONB NOT NULL,
  current_value         JSONB,
  supporting_paper_ids  UUID[] NOT NULL DEFAULT '{}',
  supporting_bot_count  INTEGER NOT NULL DEFAULT 0,
  avg_brier_score       NUMERIC,
  consensus_strength    NUMERIC,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'auto_applied')),
  requires_human_review BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by           TEXT,
  review_notes          TEXT,
  applied_at            TIMESTAMPTZ,
  rollback_value        JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_forge_proposals_run ON forge_config_proposals(aggregation_run_id);
CREATE INDEX idx_forge_proposals_status ON forge_config_proposals(status);

-- 4. Config evolution history: audit trail of every applied change.
CREATE TABLE forge_config_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id       UUID REFERENCES forge_config_proposals(id),
  config_key        TEXT NOT NULL,
  old_value         JSONB,
  new_value         JSONB NOT NULL,
  generation_number INTEGER NOT NULL,
  change_reason     TEXT NOT NULL,
  applied_by        TEXT NOT NULL,
  rolled_back       BOOLEAN DEFAULT FALSE,
  rolled_back_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_forge_config_history_gen ON forge_config_history(generation_number DESC);
CREATE INDEX idx_forge_config_history_key ON forge_config_history(config_key);
