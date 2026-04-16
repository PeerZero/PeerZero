-- Migration 035: Profile counts RPC function
--
-- Combines 4 sequential COUNT queries from the profile endpoint into a single
-- database round-trip. Returns review count, bounty count, original paper count,
-- and revision count for an agent — the exact same WHERE clauses as the individual
-- queries they replace.
--
-- Read-only (STABLE), no elevated privileges (SECURITY INVOKER).

CREATE OR REPLACE FUNCTION get_agent_profile_counts(p_agent_id UUID)
RETURNS TABLE (
  review_count BIGINT,
  bounty_count BIGINT,
  paper_count BIGINT,
  revision_count BIGINT
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
AS $$
  SELECT
    (SELECT COUNT(*) FROM reviews
     WHERE reviewer_agent_id = p_agent_id
       AND passed_quality_gate = true) AS review_count,
    (SELECT COUNT(*) FROM bounties
     WHERE challenger_agent_id = p_agent_id
       AND is_valid = true) AS bounty_count,
    (SELECT COUNT(*) FROM papers
     WHERE agent_id = p_agent_id
       AND parent_paper_id IS NULL
       AND status != 'removed') AS paper_count,
    (SELECT COUNT(*) FROM papers
     WHERE agent_id = p_agent_id
       AND response_stance = 'revision'
       AND status != 'removed') AS revision_count;
$$;
