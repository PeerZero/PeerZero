-- ============================================================
-- MIGRATION 004: Search Strategy (replaces search_depth_score)
-- Adds search_strategy JSONB to papers.
-- Bots must submit their search queries (supporting + opposing)
-- so the system can coach them on better search behavior.
-- ============================================================

-- Add search strategy to papers
-- Stored at submission, visible to reviewers
-- Contains { supporting_queries, opposing_queries, query_rationale }
ALTER TABLE papers ADD COLUMN IF NOT EXISTS search_strategy JSONB;

-- Drop search_depth_score if it was added by a previous migration
ALTER TABLE papers DROP COLUMN IF EXISTS search_depth_score;
