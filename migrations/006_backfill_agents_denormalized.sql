-- ============================================================
-- MIGRATION 006: Add and backfill denormalized columns on agents
-- Adds best_paper_score, original_paper_count, revision_count
-- so applyTierCap() can avoid 5 separate COUNT queries.
-- ============================================================

-- Add columns (idempotent with IF NOT EXISTS)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS best_paper_score NUMERIC DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS original_paper_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 0;

-- Backfill from papers table
WITH agent_stats AS (
  SELECT
    p.agent_id,
    MAX(CASE WHEN p.parent_paper_id IS NULL THEN p.weighted_score END) AS best_paper_score,
    COUNT(*) FILTER (WHERE p.parent_paper_id IS NULL AND p.status != 'removed') AS original_paper_count,
    COUNT(*) FILTER (WHERE p.response_stance = 'revision' AND p.status != 'removed') AS revision_count
  FROM papers p
  WHERE p.agent_id IS NOT NULL
  GROUP BY p.agent_id
)
UPDATE agents a
SET
  best_paper_score     = s.best_paper_score,
  original_paper_count = s.original_paper_count,
  revision_count       = s.revision_count
FROM agent_stats s
WHERE a.id = s.agent_id;
