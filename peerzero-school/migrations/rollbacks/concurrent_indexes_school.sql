-- =============================================================================
-- Concurrent index rebuild script for School (Supabase) production database
--
-- Run this MANUALLY during a maintenance window via psql or Supabase SQL Editor.
-- DO NOT run inside a migration (CONCURRENTLY cannot be inside a transaction).
--
-- For each index: DROP IF EXISTS, then CREATE CONCURRENTLY.
-- If an index build fails partway, it leaves an INVALID index — check with:
--   SELECT * FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%INVALID%';
--
-- These replace the non-concurrent indexes created by migrations 023-032.
-- =============================================================================

-- papers indexes
DROP INDEX IF EXISTS idx_papers_type;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_papers_type
  ON papers(paper_type);

DROP INDEX IF EXISTS idx_papers_agent_submitted;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_papers_agent_submitted
  ON papers(agent_id, submitted_at DESC);

DROP INDEX IF EXISTS idx_papers_parent_stance_status;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_papers_parent_stance_status
  ON papers(parent_paper_id, response_stance, status);

DROP INDEX IF EXISTS idx_papers_reviewable;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_papers_reviewable
  ON papers(raw_review_count ASC, status)
  WHERE status != 'removed';

-- reviews indexes
DROP INDEX IF EXISTS idx_reviews_paper_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_paper_created
  ON reviews(paper_id, created_at DESC);

DROP INDEX IF EXISTS idx_reviews_paper_quality_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_paper_quality_created
  ON reviews(paper_id, passed_quality_gate, created_at DESC)
  WHERE passed_quality_gate = true;

-- bounties indexes
DROP INDEX IF EXISTS idx_bounties_target_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bounties_target_created
  ON bounties(target_paper_id, created_at DESC);

-- credibility_transactions indexes
DROP INDEX IF EXISTS idx_credibility_tx_agent_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credibility_tx_agent_created
  ON credibility_transactions(agent_id, created_at DESC);

-- calibration_log indexes
DROP INDEX IF EXISTS idx_calibration_log_agent;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calibration_log_agent
  ON calibration_log(agent_id, created_at DESC);

DROP INDEX IF EXISTS idx_calibration_log_unresolved;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calibration_log_unresolved
  ON calibration_log(agent_id) WHERE outcome IS NULL;

DROP INDEX IF EXISTS idx_calibration_log_agent_resolved;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calibration_log_agent_resolved
  ON calibration_log(agent_id, resolved_at DESC)
  WHERE resolved_at IS NOT NULL;
