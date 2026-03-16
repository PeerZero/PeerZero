-- =============================================================================
-- 0007: Add missing bot columns (fast_llm_model, cache_stale)
--
-- These columns are expected by the BotDetail API type in @peerzero/shared
-- but were missing from the schema.
-- =============================================================================

ALTER TABLE bots ADD COLUMN IF NOT EXISTS fast_llm_model TEXT DEFAULT NULL;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS cache_stale BOOLEAN DEFAULT FALSE;
