-- =============================================================================
-- Concurrent index rebuild script for App (PostgreSQL) production database
--
-- Run this MANUALLY via psql during a maintenance window.
-- DO NOT run inside a migration (CONCURRENTLY cannot be inside a transaction).
--
-- These replace the non-concurrent indexes created by App migrations.
-- =============================================================================

-- activity_log indexes
DROP INDEX IF EXISTS idx_activity_not_deleted;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_not_deleted
  ON activity_log(bot_id, created_at DESC)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_activity_category;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_category
  ON activity_log(bot_id, category, created_at DESC)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_activity_bot_not_deleted;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_bot_not_deleted
  ON activity_log(bot_id, deleted_at) WHERE deleted_at IS NULL;

-- bots indexes
DROP INDEX IF EXISTS idx_bots_public_slug;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bots_public_slug
  ON bots(public_slug) WHERE is_public = TRUE;

DROP INDEX IF EXISTS idx_bots_mode;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bots_mode
  ON bots(mode) WHERE status = 'running';

-- users indexes
DROP INDEX IF EXISTS idx_users_email_verification_token;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_verification_token
  ON users(email_verification_token_hash)
  WHERE email_verification_token_hash IS NOT NULL;
