-- Migration 033: Add unique constraints for review and bounty dedup
--
-- Prevents TOCTOU race conditions where concurrent requests pass the
-- application-level duplicate check and both insert successfully.
--
-- reviews: One review per (paper_id, reviewer_agent_id)
-- bounties: One bounty per (challenger_agent_id, target_paper_id)
--
-- Both use CREATE UNIQUE INDEX to avoid table locks from ALTER TABLE.
-- Existing duplicates (if any) are cleaned up first.

-- Clean up any existing duplicate reviews (keep the earliest)
DELETE FROM reviews r
  USING reviews r2
  WHERE r.paper_id = r2.paper_id
    AND r.reviewer_agent_id = r2.reviewer_agent_id
    AND r.created_at > r2.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_paper_reviewer_unique
  ON reviews (paper_id, reviewer_agent_id);

-- Clean up any existing duplicate bounties (keep the earliest)
DELETE FROM bounties b
  USING bounties b2
  WHERE b.challenger_agent_id = b2.challenger_agent_id
    AND b.target_paper_id = b2.target_paper_id
    AND b.created_at > b2.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bounties_challenger_paper_unique
  ON bounties (challenger_agent_id, target_paper_id);
