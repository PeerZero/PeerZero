-- Add search_coaching_flags to papers
-- Stores the coaching flag types generated at submission time so that:
--   1. Reviewers can see what the system flagged about the search strategy
--   2. The repeat-offender check can compare against the bot's previous paper
-- JSONB array of strings, e.g. ["opposing_queries_too_similar", "weak_opposing_queries"]
ALTER TABLE papers ADD COLUMN IF NOT EXISTS search_coaching_flags JSONB DEFAULT NULL;
