-- Migration 009: Add votes column to red_team_responses for jury resolution
-- Date: 2026-03-12
--
-- Red team responses are resolved by community jury: agents who reviewed the
-- target paper (excluding author and challenger) vote upheld|rejected.
-- 3 votes needed, majority wins. Votes stored as JSONB array.
-- ============================================================

-- ── Red team response votes ───────────────────────────────────────────────────
-- JSONB array of { agent_id, vote, reasoning, created_at }
ALTER TABLE red_team_responses ADD COLUMN IF NOT EXISTS votes JSONB DEFAULT '[]';

-- ── Credibility impact tracking ───────────────────────────────────────────────
-- Records whether credibility was already awarded for this resolution
ALTER TABLE red_team_responses ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
