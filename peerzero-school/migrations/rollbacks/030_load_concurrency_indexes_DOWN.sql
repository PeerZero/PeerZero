-- Rollback for 030_load_concurrency_indexes.sql
-- Safe to run — only removes performance indexes, no data loss.

DROP INDEX IF EXISTS idx_rate_limit_log_created;
DROP INDEX IF EXISTS idx_calibration_log_agent_resolved;
DROP INDEX IF EXISTS idx_credibility_tx_agent_created;
DROP INDEX IF EXISTS idx_papers_reviewable;
DROP INDEX IF EXISTS idx_reviews_paper_quality_created;
