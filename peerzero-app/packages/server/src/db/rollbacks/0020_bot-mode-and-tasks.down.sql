-- Rollback 0020: Remove bot mode and tasks table
-- WARNING: All task data will be permanently deleted.

DROP TABLE IF EXISTS bot_tasks;
DROP INDEX IF EXISTS idx_bots_mode;
ALTER TABLE bots DROP COLUMN IF EXISTS mode;

DELETE FROM schema_migrations WHERE name = '0020_bot-mode-and-tasks.sql';
