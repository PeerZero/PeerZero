-- Migration 0012: Unique display names + persistent failure tracking
--
-- 1. Add unique index on display_name (case-insensitive) to prevent duplicates.
--    NULLs are allowed (users without a display name set).
-- 2. Add consecutive_failures column to bots table so failure counts survive
--    worker restarts (previously tracked in-memory).

-- Unique display name (case-insensitive, NULLs excluded)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_lower
  ON users (LOWER(display_name))
  WHERE display_name IS NOT NULL;

-- Persistent consecutive failure tracking for bot job queue
ALTER TABLE bots ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
