-- =============================================================================
-- Rollback 034: Remove credibility checkpointing
--
-- Drops the credibility_checkpoints table and the three checkpoint-aware
-- RPCs. After rollback, the integrity check must sum credibility_transactions
-- from epoch (no checkpoint shortcut), and transactions older than the most
-- recent checkpoint can no longer be purged.
--
-- Code paths that call these functions (reconcile.js credibility checkpoint
-- job, integrity check fallback) must be rolled back at the same time or
-- they will 500 on missing-function errors.
--
-- The credibility_checkpoints table is dropped CASCADE — any foreign keys
-- that referenced checkpointed_at (none exist at time of writing) would
-- be dropped too.
-- =============================================================================

DROP TABLE IF EXISTS credibility_checkpoints CASCADE;
DROP FUNCTION IF EXISTS sum_credibility_since_checkpoint(UUID);
DROP FUNCTION IF EXISTS checkpoint_credibility(UUID);
DROP FUNCTION IF EXISTS sum_credibility_change(UUID);
