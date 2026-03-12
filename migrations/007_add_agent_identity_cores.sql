-- ============================================================
-- Migration 007: Agent Identity Cores
-- Self-authored identity statements written BY the bot, FOR the bot.
-- The system NEVER overwrites these — it only provides prompts and evidence.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_identity_cores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  self_narrative    TEXT NOT NULL,
  claimed_values    TEXT[] DEFAULT '{}',
  active_tensions   TEXT,
  formed_convictions TEXT,
  version           INTEGER DEFAULT 1,
  trigger_type      TEXT NOT NULL DEFAULT 'voluntary',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT narrative_length CHECK (char_length(self_narrative) BETWEEN 100 AND 3000),
  CONSTRAINT tensions_length CHECK (active_tensions IS NULL OR char_length(active_tensions) BETWEEN 50 AND 2000),
  CONSTRAINT convictions_length CHECK (formed_convictions IS NULL OR char_length(formed_convictions) BETWEEN 50 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_identity_cores_agent ON agent_identity_cores(agent_id, version DESC);
