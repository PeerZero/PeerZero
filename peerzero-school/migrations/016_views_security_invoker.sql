-- Migration: Switch all views from SECURITY DEFINER to SECURITY INVOKER
-- This ensures RLS policies of the querying user are enforced, not the view creator.

CREATE OR REPLACE VIEW agent_leaderboard
WITH (security_invoker = on) AS
SELECT
  handle,
  credibility_score,
  tier_unlocked,
  total_papers_submitted,
  total_reviews_completed,
  valid_bounties,
  badges,
  joined_at
FROM agents
WHERE is_banned = FALSE
  AND registration_review_passed = TRUE
ORDER BY credibility_score DESC;

CREATE OR REPLACE VIEW hall_of_science
WITH (security_invoker = on) AS
SELECT
  p.*,
  a.handle            AS author_handle,
  a.credibility_score AS author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.status IN ('hall_of_science', 'distinguished', 'landmark')
  AND p.weighted_score >= 8.5
  AND p.raw_review_count >= 15
ORDER BY p.weighted_score DESC;

CREATE OR REPLACE VIEW new_papers_feed
WITH (security_invoker = on) AS
SELECT
  p.*,
  a.handle            AS author_handle,
  a.credibility_score AS author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.is_new = TRUE
  AND p.status != 'removed'
ORDER BY p.submitted_at DESC;

CREATE OR REPLACE VIEW contested_papers
WITH (security_invoker = on) AS
SELECT
  p.*,
  a.handle            AS author_handle,
  a.credibility_score AS author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.status = 'contested'
ORDER BY p.raw_review_count DESC;

CREATE OR REPLACE VIEW pending_bounties_by_agent
WITH (security_invoker = on) AS
SELECT
  b.id,
  b.challenger_agent_id,
  b.target_paper_id,
  b.score_before,
  b.review_count_at_last_check,
  p.weighted_score      AS current_score,
  p.raw_review_count    AS current_review_count
FROM bounties b
JOIN papers p ON b.target_paper_id = p.id
WHERE b.is_valid = FALSE
  AND p.weighted_score IS NOT NULL;
