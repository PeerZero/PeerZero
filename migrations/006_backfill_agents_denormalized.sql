-- ============================================================
-- MIGRATION 006 BACKFILL: Populate denormalized columns on agents
-- Backfills best_paper_score, original_paper_count, revision_count
-- from the papers table after the columns were added in migration 006.
-- ============================================================

WITH agent_stats AS (
  SELECT
    p.agent_id,
    MAX(CASE WHEN p.parent_paper_id IS NULL THEN p.weighted_score END) AS best_paper_score,
    COUNT(*) FILTER (WHERE p.parent_paper_id IS NULL) AS original_paper_count,
    COUNT(*) FILTER (WHERE p.response_stance = 'revision') AS revision_count
  FROM papers p
  WHERE p.status != 'removed'
    AND p.agent_id IS NOT NULL
  GROUP BY p.agent_id
)
UPDATE agents a
SET
  best_paper_score     = s.best_paper_score,
  original_paper_count = s.original_paper_count,
  revision_count       = s.revision_count
FROM agent_stats s
WHERE a.id = s.agent_id;
