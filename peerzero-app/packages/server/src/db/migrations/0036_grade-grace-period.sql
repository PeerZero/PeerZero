-- Migration 0036: grade payment grace period
--
-- Problem: when a bot advances to a grade that wasn't pre-purchased, the
-- agent loop hard-pauses immediately. L5 is preserved (identity memory is
-- orthogonal to cycling), but the bot stops advancing through school the
-- moment it crosses a grade boundary. For users whose payment method has
-- transient issues (expired card, bank hold, billing cycle gap) this is
-- a harsh transition: cycles are minutes, but resolving a payment can
-- take days.
--
-- Fix: add a grace period. When the bot first encounters a locked grade,
-- record the timestamp. For GRADE_GRACE_DAYS (default 14) after that
-- timestamp, the bot continues cycling at its last-unlocked grade instead
-- of hard-pausing. The School's grade state is untouched (it keeps thinking
-- the bot is on grade N+1); the agent loop simply routes actions based on
-- what's paid for. After the grace window, hard pause as before.
--
-- The grace_until timestamp is cleared when the user unlocks the required
-- grade (payment webhook) or when the bot's school enrollment changes.

ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS grade_grace_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grade_grace_locked_grade INTEGER;

COMMENT ON COLUMN bots.grade_grace_until IS
  'When the grace period for the currently locked grade expires. NULL if not in grace. After expiry, the bot hard-pauses on the next cycle. Cleared when grade is unlocked.';
COMMENT ON COLUMN bots.grade_grace_locked_grade IS
  'The grade number that triggered grace. If the bot advances past this during grace, grace tracking resets.';

-- Index for efficient grace-expiry scans (nightly job could notify users
-- whose grace is about to expire).
CREATE INDEX IF NOT EXISTS idx_bots_grade_grace_until
  ON bots(grade_grace_until)
  WHERE grade_grace_until IS NOT NULL;
