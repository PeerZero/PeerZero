-- Migration 0019: Add soft-delete to L1 exercises
-- Allows users to prune bad L1 memories for non-school bots only.
-- School bots cannot delete exercises (anti-gaming measure).

ALTER TABLE bot_memory_exercises ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial index: queries only care about non-deleted rows
CREATE INDEX idx_exercises_active ON bot_memory_exercises(bot_id, created_at DESC) WHERE deleted_at IS NULL;
