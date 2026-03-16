-- =============================================================================
-- Migration 003: Enhanced bot watcher + multi-model support
--
-- 1. External activity soft-delete (deleted_at column + filtered index)
-- 2. Multi-model support (fast_llm_model column on bots)
-- =============================================================================

-- External activity soft-delete support
ALTER TABLE external_activity_log ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Replace the existing index with a filtered one that excludes deleted entries
DROP INDEX IF EXISTS idx_external_activity_bot;
CREATE INDEX idx_external_activity_not_deleted
  ON external_activity_log (bot_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Multi-model: optional fast model for utility tasks (condensation, platform actions)
-- When NULL, the bot uses its primary llm_model for everything.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS fast_llm_model TEXT DEFAULT NULL;
