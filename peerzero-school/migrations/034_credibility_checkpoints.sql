-- Migration 034: Credibility checkpointing
--
-- The credibility_transactions table grows without bound (excluded from purge
-- because the integrity check needs full history). This migration introduces
-- checkpoints: periodic snapshots of the running sum per agent, allowing
-- transactions older than the checkpoint to be safely purged.
--
-- Architecture:
--   1. credibility_checkpoints stores the sum of all transactions up to a point
--   2. The integrity check sums from checkpoint forward (not from epoch)
--   3. Purge deletes transactions older than the checkpoint timestamp
--   4. One checkpoint per agent — upsert on each checkpoint run

CREATE TABLE IF NOT EXISTS credibility_checkpoints (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  checkpointed_sum NUMERIC NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  checkpointed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RPC: compute the sum of credibility changes since the last checkpoint.
-- Used by the integrity check to avoid scanning all-time history.
CREATE OR REPLACE FUNCTION sum_credibility_since_checkpoint(p_agent_id UUID)
RETURNS TABLE(total_change NUMERIC, tx_count BIGINT, checkpoint_sum NUMERIC)
LANGUAGE sql STABLE
AS $$
  SELECT
    COALESCE(SUM(ct.change_amount), 0)::NUMERIC AS total_change,
    COUNT(ct.id) AS tx_count,
    COALESCE(cp.checkpointed_sum, 0)::NUMERIC AS checkpoint_sum
  FROM agents a
  LEFT JOIN credibility_checkpoints cp ON cp.agent_id = a.id
  LEFT JOIN credibility_transactions ct
    ON ct.agent_id = a.id
    AND ct.created_at > COALESCE(cp.checkpointed_at, '1970-01-01'::timestamptz)
  WHERE a.id = p_agent_id
  GROUP BY cp.checkpointed_sum;
$$;

-- RPC: create or update a checkpoint for an agent by summing ALL transactions.
-- Called periodically (e.g., weekly via reconciliation).
CREATE OR REPLACE FUNCTION checkpoint_credibility(p_agent_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO credibility_checkpoints (agent_id, checkpointed_sum, transaction_count, checkpointed_at)
  SELECT
    p_agent_id,
    COALESCE(SUM(change_amount), 0),
    COUNT(*),
    NOW()
  FROM credibility_transactions
  WHERE agent_id = p_agent_id
  ON CONFLICT (agent_id) DO UPDATE SET
    checkpointed_sum = EXCLUDED.checkpointed_sum,
    transaction_count = EXCLUDED.transaction_count,
    checkpointed_at = EXCLUDED.checkpointed_at;
$$;

-- RPC: sum all credibility changes for an agent (used by integrity check fallback).
CREATE OR REPLACE FUNCTION sum_credibility_change(p_agent_id UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(change_amount), 0)::NUMERIC
  FROM credibility_transactions
  WHERE agent_id = p_agent_id;
$$;
