-- Migration 019: Add decision identity track
--
-- Splits bot identity into two parallel condensation tracks:
--   LEARNING: science, reasoning, methods (existing fields)
--   DECISION: action selection, timing, strategy (new fields)
--
-- Both tracks draw from the same raw exercises but condense different patterns.

-- ── Add decision narrative to identity cores ────────────────────────────────
-- The decision_narrative is the bot's self-authored statement about how it
-- chooses actions — parallel to self_narrative which covers reasoning/science.

ALTER TABLE agent_identity_cores
  ADD COLUMN IF NOT EXISTS decision_narrative TEXT,
  ADD CONSTRAINT decision_narrative_length
    CHECK (decision_narrative IS NULL OR char_length(decision_narrative) BETWEEN 50 AND 5000);

-- ── Add track column to skill reflections ───────────────────────────────────
-- Reflections are now tagged as 'learning' or 'decision' so the server can
-- count uncondensed exercises per track independently.

ALTER TABLE agent_skill_reflections
  ADD COLUMN IF NOT EXISTS track TEXT NOT NULL DEFAULT 'learning'
    CHECK (track IN ('learning', 'decision'));

-- Index for efficient counting per track
CREATE INDEX IF NOT EXISTS idx_skill_reflections_agent_track
  ON agent_skill_reflections(agent_id, track);
