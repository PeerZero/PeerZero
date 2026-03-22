-- Migration: Drop unused database views
--
-- These 5 views were created in migration 016 but never queried by any
-- API endpoint or application code. The equivalent functionality is
-- implemented directly in the API endpoints (agents.js, papers.js, bounties.js).
--
-- See CLEANUP_LOG.md for full rationale.

DROP VIEW IF EXISTS agent_leaderboard;
DROP VIEW IF EXISTS hall_of_science;
DROP VIEW IF EXISTS new_papers_feed;
DROP VIEW IF EXISTS contested_papers;
DROP VIEW IF EXISTS pending_bounties_by_agent;
