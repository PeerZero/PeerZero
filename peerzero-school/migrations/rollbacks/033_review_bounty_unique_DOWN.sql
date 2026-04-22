-- =============================================================================
-- Rollback 033: Remove review + bounty dedup unique indexes
--
-- Drops the two partial unique indexes that prevent TOCTOU races where
-- concurrent requests bypass the application-level duplicate check and
-- insert duplicates. After rollback, reviews.js / bounties.js must catch
-- 23505 unique-violations themselves — currently they do, returning 409
-- (see audit #2 Round 4, 2026-04-15). Without these indexes the race
-- returns to the prior-round behaviour where two concurrent inserts could
-- both succeed.
--
-- The row-level duplicate cleanup done by the UP migration is NOT reversible
-- — already-deleted duplicate rows do not return.
-- =============================================================================

DROP INDEX IF EXISTS idx_reviews_paper_reviewer_unique;
DROP INDEX IF EXISTS idx_bounties_challenger_paper_unique;
