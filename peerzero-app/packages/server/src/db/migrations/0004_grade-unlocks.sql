-- Migration 0004: Grade unlock system for tiered pricing
-- Adds grade_unlocks table and updates products type constraint.

-- Allow grade_advancement as a product type
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check;
ALTER TABLE products ADD CONSTRAINT products_type_check
  CHECK (type IN ('bot_shell', 'school_enrollment', 'grade_advancement', 'feature'));

-- Track which grades each bot has paid for
CREATE TABLE IF NOT EXISTS grade_unlocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  grade           INTEGER NOT NULL CHECK (grade >= 1),
  purchase_id     UUID REFERENCES purchases(id),
  unlocked_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, grade)
);
CREATE INDEX IF NOT EXISTS idx_grade_unlocks_bot ON grade_unlocks(bot_id);

-- Grade 1 is free — auto-unlocked on enrollment (handled by application code)
