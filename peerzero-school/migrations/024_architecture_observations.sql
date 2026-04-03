-- ============================================================
-- 024: Architecture Observation System
--
-- Lets bots notice friction in their own architecture (memory
-- layers, identity loading, condensation pipeline, preamble)
-- and route that signal through the methodology paper system.
--
-- Two additions:
--   1. bot_architecture_observations table (outside the cascade)
--   2. Architecture field (field_id 14)
-- ============================================================

-- ── Architecture observations store ──────────────────────────
-- Outside the condensation cascade. NOT L1. Does not condense.
-- Does not clear on grade failure. Persists until a methodology
-- paper with field_id=14 is submitted.
-- Max 10 per agent enforced at write time (app-level, not DB).

CREATE TABLE IF NOT EXISTS bot_architecture_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  observation_text TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'self_prediction_mismatch',
    'grade_failure',
    'reflection_inlet',
    'condensation_regret'
  )),
  cycle_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arch_obs_agent
  ON bot_architecture_observations (agent_id, created_at);

-- ── Architecture field ───────────────────────────────────────
-- Behaves exactly like every other field. Same scoring, same
-- adversarial review, same credibility consequences. The ONLY
-- difference: papers in this field receive bot shell code +
-- school blueprint as additional context.

INSERT INTO fields (name, slug, description) VALUES
  ('Architecture', 'architecture', 'Papers proposing improvements to bot design — memory layers, identity loading, condensation pipeline, preamble structure, active focus curation, or any mechanism by which the bot processes and carries identity.')
ON CONFLICT (slug) DO NOTHING;
