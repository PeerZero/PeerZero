-- Rollback 0019: Remove soft-delete from L1 exercises
-- WARNING: Any soft-deleted exercises will become visible again after removing the column.

DROP INDEX IF EXISTS idx_exercises_active;
ALTER TABLE bot_memory_exercises DROP COLUMN IF EXISTS deleted_at;

DELETE FROM schema_migrations WHERE name = '0019_exercise-soft-delete.sql';
