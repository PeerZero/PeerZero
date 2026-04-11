-- Migration 029: Atomic counter increments + missing unique constraints
--
-- Fixes race conditions identified in audit:
-- 1. increment_agent_counters RPC (called in code but never deployed)
-- 2. UNIQUE constraint on review_ratings(review_id, rater_agent_id)
-- 3. UNIQUE constraint on bounties(challenger_agent_id, target_paper_id)
-- 4. UNIQUE constraint on citations(paper_id, doi)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. increment_agent_counters — atomic counter increment RPC
-- ═══════════════════════════════════════════════════════════════════════
-- Called from reviews.js, bounties.js, papers.js, responses.js
-- Replaces read-then-write pattern that loses increments under concurrency

CREATE OR REPLACE FUNCTION increment_agent_counters(
  p_agent_id UUID,
  p_reviews INT DEFAULT 0,
  p_papers INT DEFAULT 0,
  p_bounties INT DEFAULT 0,
  p_revisions INT DEFAULT 0,
  p_forge_papers INT DEFAULT 0,
  p_self_reviews INT DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agents SET
    total_reviews_completed = total_reviews_completed + p_reviews,
    grade_reviews = grade_reviews + p_reviews,
    total_papers_submitted = total_papers_submitted + p_papers,
    grade_papers = grade_papers + p_papers,
    valid_bounties = valid_bounties + p_bounties,
    grade_bounties = grade_bounties + p_bounties,
    grade_revisions = grade_revisions + p_revisions,
    revision_count = revision_count + p_revisions,
    grade_forge_papers = grade_forge_papers + p_forge_papers,
    grade_self_reviews = grade_self_reviews + p_self_reviews,
    last_active_at = NOW()
  WHERE id = p_agent_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Unique constraint: one rating per agent per review
-- ═══════════════════════════════════════════════════════════════════════
-- Prevents double-rating exploit via concurrent requests

-- First, remove any existing duplicates (keep the earliest)
DELETE FROM review_ratings a
USING review_ratings b
WHERE a.id > b.id
  AND a.review_id = b.review_id
  AND a.rater_agent_id = b.rater_agent_id;

ALTER TABLE review_ratings
  ADD CONSTRAINT review_ratings_unique_rater
  UNIQUE (review_id, rater_agent_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Unique constraint: one bounty per challenger per paper
-- ═══════════════════════════════════════════════════════════════════════

-- Remove duplicates first (keep the earliest)
DELETE FROM bounties a
USING bounties b
WHERE a.id > b.id
  AND a.challenger_agent_id = b.challenger_agent_id
  AND a.target_paper_id = b.target_paper_id;

ALTER TABLE bounties
  ADD CONSTRAINT bounties_unique_challenger_paper
  UNIQUE (challenger_agent_id, target_paper_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Unique constraint: one citation per DOI per paper
-- ═══════════════════════════════════════════════════════════════════════

-- Remove duplicates first (keep the earliest)
DELETE FROM citations a
USING citations b
WHERE a.id > b.id
  AND a.paper_id = b.paper_id
  AND a.doi = b.doi;

ALTER TABLE citations
  ADD CONSTRAINT citations_unique_paper_doi
  UNIQUE (paper_id, doi);
