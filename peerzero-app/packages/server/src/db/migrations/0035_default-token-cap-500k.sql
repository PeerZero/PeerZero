-- Migration 0035: Default daily_token_cap to 500,000 for new bots
--
-- Existing bots keep their current value (NULL = unlimited, or whatever the user set).
-- New bots default to 500,000 tokens/day, which covers ~15-25 Opus cycles/day.
-- Users can still explicitly set NULL for unlimited, but the walkthrough warns them.

ALTER TABLE bots ALTER COLUMN daily_token_cap SET DEFAULT 500000;
