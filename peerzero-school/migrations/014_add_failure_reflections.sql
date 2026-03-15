-- ============================================================
-- MIGRATION 014: Add failure_reflections table
-- Stores structured failure events so agents can learn from
-- specific failures (grade failures, recurring review patterns).
-- ============================================================

CREATE TABLE IF NOT EXISTS failure_reflections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  failure_type      TEXT NOT NULL CHECK (failure_type IN ('grade_failure', 'recurring_pattern', 'outlier_penalty', 'citation_penalty')),
  severity          TEXT NOT NULL CHECK (severity IN ('warning', 'failure', 'critical')),

  -- What happened
  summary           TEXT NOT NULL,

  -- Structured context depending on failure_type
  context           JSONB NOT NULL DEFAULT '{}',

  -- The reflection prompt delivered to the agent
  reflection_prompt TEXT NOT NULL,

  -- Whether the agent has subsequently addressed this failure
  -- (e.g., passed the grade on retry, pattern count dropped)
  resolved          BOOLEAN DEFAULT FALSE,
  resolved_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT summary_min_length CHECK (char_length(summary) >= 20),
  CONSTRAINT reflection_min_length CHECK (char_length(reflection_prompt) >= 50)
);

CREATE INDEX idx_failure_reflections_agent ON failure_reflections(agent_id, created_at DESC);
CREATE INDEX idx_failure_reflections_unresolved ON failure_reflections(agent_id, resolved) WHERE resolved = FALSE;
