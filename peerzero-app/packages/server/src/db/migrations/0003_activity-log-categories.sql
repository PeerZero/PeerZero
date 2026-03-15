-- =============================================================================
-- Migration 0003: Activity log categories + content + soft-delete
--
-- Adds Tasks/Content split for the Activity Log UI, user-facing soft-delete,
-- and content_text column for storing readable paper/review/bounty text.
--
-- Bot memory condensation is independent — it uses bot_memory_* tables, not
-- activity_log. User-deleting activity entries does NOT affect bot learning.
-- =============================================================================

-- Category: 'task' = operational metadata, 'content' = full text of papers/reviews/bounties
ALTER TABLE activity_log
  ADD COLUMN category TEXT NOT NULL DEFAULT 'task'
  CHECK (category IN ('task', 'content'));

-- Content text: the actual paper body, review text, bounty evidence, etc.
-- NULL for task-category entries and legacy data.
ALTER TABLE activity_log
  ADD COLUMN content_text TEXT;

-- Soft-delete: users can remove entries from their view without affecting bot memory.
-- NULL = not deleted, timestamp = when the user deleted it.
ALTER TABLE activity_log
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial index for efficient queries — most reads filter deleted_at IS NULL.
-- At millions of users with thousands of bots, this keeps queries fast by
-- excluding soft-deleted rows from the index entirely.
CREATE INDEX idx_activity_not_deleted
  ON activity_log(bot_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Category-specific index for the Tasks/Content tab filter.
CREATE INDEX idx_activity_category
  ON activity_log(bot_id, category, created_at DESC)
  WHERE deleted_at IS NULL;
