-- Migration 027: Add composite indexes for common query patterns
-- Addresses N+1 query performance and pagination bottlenecks at scale

-- Reviews: frequently queried by (paper_id + quality gate + ordering)
CREATE INDEX IF NOT EXISTS idx_reviews_paper_created
  ON reviews(paper_id, created_at DESC);

-- Papers: agent's papers ordered by submission date (profile endpoint)
CREATE INDEX IF NOT EXISTS idx_papers_agent_submitted
  ON papers(agent_id, submitted_at DESC);

-- Bounties: target paper bounties ordered by creation (bounty listing)
CREATE INDEX IF NOT EXISTS idx_bounties_target_created
  ON bounties(target_paper_id, created_at DESC);

-- Papers: response paper lookups by parent + stance + status
CREATE INDEX IF NOT EXISTS idx_papers_parent_stance_status
  ON papers(parent_paper_id, response_stance, status);

-- Skill profiles: agent skill lookups with ordering for condensation
CREATE INDEX IF NOT EXISTS idx_skill_profiles_agent_updated
  ON agent_skill_profiles(agent_id, updated_at DESC);
