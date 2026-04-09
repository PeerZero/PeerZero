-- Migration 0024: Add composite indexes for pagination and scaling
-- Addresses activity_log and external_activity_log query performance

-- Activity log: bot + soft-delete filter (used for COUNT queries on every pagination)
CREATE INDEX IF NOT EXISTS idx_activity_bot_not_deleted
  ON activity_log(bot_id, deleted_at) WHERE deleted_at IS NULL;

-- External activity log: bot + soft-delete filter (same pattern)
CREATE INDEX IF NOT EXISTS idx_external_activity_bot_not_deleted
  ON external_activity_log(bot_id, deleted_at) WHERE deleted_at IS NULL;

-- External activity log: cursor-based pagination (created_at, id) composite
CREATE INDEX IF NOT EXISTS idx_external_activity_cursor
  ON external_activity_log(bot_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
