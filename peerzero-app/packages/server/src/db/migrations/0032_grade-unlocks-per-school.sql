-- Migration 0032: Make grade_unlocks per-school instead of per-bot-global
-- Each school enrollment requires its own separate grade payments.
-- A bot enrolled in science AND politics pays for grades independently in each.

-- 1. Add school_id column (nullable initially for backfill)
ALTER TABLE grade_unlocks ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);

-- 2. Backfill existing rows from the bot's current school_id
UPDATE grade_unlocks gu
SET school_id = b.school_id
FROM bots b
WHERE gu.bot_id = b.id
  AND gu.school_id IS NULL
  AND b.school_id IS NOT NULL;

-- 3. Delete any orphaned grade_unlocks where bot has no school (shouldn't exist, but safety)
DELETE FROM grade_unlocks WHERE school_id IS NULL;

-- 4. Make school_id NOT NULL now that all rows are backfilled
ALTER TABLE grade_unlocks ALTER COLUMN school_id SET NOT NULL;

-- 5. Drop old unique constraint and index
ALTER TABLE grade_unlocks DROP CONSTRAINT IF EXISTS grade_unlocks_bot_id_grade_key;
DROP INDEX IF EXISTS idx_grade_unlocks_bot;

-- 6. Add new per-school unique constraint and index
ALTER TABLE grade_unlocks ADD CONSTRAINT grade_unlocks_bot_school_grade_key UNIQUE(bot_id, school_id, grade);
CREATE INDEX idx_grade_unlocks_bot_school ON grade_unlocks(bot_id, school_id);
