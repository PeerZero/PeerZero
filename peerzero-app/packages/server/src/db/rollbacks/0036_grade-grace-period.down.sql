-- Rollback 0036: Remove grade payment grace period
--
-- Reverts migration 0036. Bots that were in grace at rollback time will
-- hard-pause on the next cycle if their current grade is locked — the grace
-- timestamp and locked-grade pointer are both dropped.
--
-- Column drops are safe: the agent loop reads both columns defensively
-- (evaluateGradeGate treats missing columns as "not in grace"), so rolling
-- back before deploying the agent-loop revert is tolerated.

DROP INDEX IF EXISTS idx_bots_grade_grace_until;

ALTER TABLE bots DROP COLUMN IF EXISTS grade_grace_until;
ALTER TABLE bots DROP COLUMN IF EXISTS grade_grace_locked_grade;

DELETE FROM schema_migrations WHERE name = '0036_grade-grace-period.sql';
