-- =============================================================================
-- Migration 0001: Baseline
--
-- This migration represents the existing schema (schema.sql) that was applied
-- manually before the migration system was introduced. It's a no-op — all
-- tables already exist. We create this so the migration history is complete
-- and future migrations have a clean starting point.
--
-- To apply this to an existing database, just run the migration system.
-- node-pg-migrate will create its pgmigrations table and mark this as applied.
-- =============================================================================

-- UP
-- No-op: schema.sql was applied manually before migrations were introduced.
-- Tables that exist: users, refresh_tokens, llm_api_keys, schools, bots,
-- bot_memory_exercises, bot_memory_paragraphs, bot_memory_core,
-- bot_memory_self_identity, activity_log, enrollments, products, purchases,
-- user_entitlements, audit_log.

SELECT 1;
