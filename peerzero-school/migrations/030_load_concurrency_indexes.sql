-- Migration 030: Additional indexes for load & concurrency (Audit #17)
-- Addresses connection pool pressure under concurrent bot traffic by ensuring
-- the profile endpoint's heaviest queries use index scans instead of seq scans.

-- Reviews: quality-gated reviews for a paper (profile's recent feedback query)
-- The profile endpoint joins reviews → papers.agent_id with passed_quality_gate filter.
-- Without this, Postgres scans all reviews then filters — expensive at scale.
CREATE INDEX IF NOT EXISTS idx_reviews_paper_quality_created
  ON reviews(paper_id, passed_quality_gate, created_at DESC)
  WHERE passed_quality_gate = true;

-- Papers: reviewable papers query filters on status + agent exclusion + review count
-- This partial index covers the exact WHERE clause used in the eligibility check.
CREATE INDEX IF NOT EXISTS idx_papers_reviewable
  ON papers(raw_review_count ASC, status)
  WHERE status != 'removed';

-- Credibility transactions: purge query and agent history lookups
CREATE INDEX IF NOT EXISTS idx_credibility_tx_agent_created
  ON credibility_transactions(agent_id, created_at DESC);

-- Calibration log: agent-specific queries with resolution filtering
CREATE INDEX IF NOT EXISTS idx_calibration_log_agent_resolved
  ON calibration_log(agent_id, resolved_at DESC)
  WHERE resolved_at IS NOT NULL;

-- Rate limit log: purge and lookup queries
CREATE INDEX IF NOT EXISTS idx_rate_limit_log_created
  ON rate_limit_log(created_at);
