-- Rollback for migration 039: restore the 6-counter increment_agent_counters
-- signature (migration 029 original) and drop the grade_trajectory_exercises
-- column.
--
-- Safe: if any trajectory exercises have completed, those grade increments
-- are preserved in the column until we drop it. Rollback is not reversible.

BEGIN;

-- Restore original 6-counter RPC (no p_trajectory_exercises parameter)
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

ALTER TABLE agents DROP COLUMN IF EXISTS grade_trajectory_exercises;

COMMIT;
