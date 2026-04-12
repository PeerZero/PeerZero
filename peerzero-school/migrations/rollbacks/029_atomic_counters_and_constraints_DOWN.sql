-- Rollback for 029_atomic_counters_and_constraints.sql
-- WARNING: Removing unique constraints may allow duplicate rows on retry.
-- The increment_agent_counters function is critical — removing it will break
-- counter increments in reviews.js, bounties.js, papers.js, responses.js.
-- Only run this if you are reverting to the read-then-write pattern.

-- 4. Remove citation uniqueness constraint
ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_unique_paper_doi;

-- 3. Remove bounty uniqueness constraint
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_unique_challenger_paper;

-- 2. Remove review rating uniqueness constraint
ALTER TABLE review_ratings DROP CONSTRAINT IF EXISTS review_ratings_unique_rater;

-- 1. Drop the atomic counter function
DROP FUNCTION IF EXISTS increment_agent_counters(UUID, INT, INT, INT, INT, INT, INT);
