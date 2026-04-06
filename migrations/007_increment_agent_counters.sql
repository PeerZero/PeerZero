-- Atomic counter increment for agent review/paper/bounty counts.
-- Avoids read-then-write race conditions in concurrent requests.

CREATE OR REPLACE FUNCTION increment_agent_counters(
  p_agent_id UUID,
  p_reviews INT DEFAULT 0,
  p_papers INT DEFAULT 0,
  p_bounties INT DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
  UPDATE agents SET
    total_reviews_completed = total_reviews_completed + p_reviews,
    grade_reviews = grade_reviews + p_reviews,
    total_papers_submitted = total_papers_submitted + p_papers,
    grade_papers = grade_papers + p_papers,
    valid_bounties = valid_bounties + p_bounties,
    grade_bounties = grade_bounties + p_bounties,
    last_active_at = NOW()
  WHERE id = p_agent_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
