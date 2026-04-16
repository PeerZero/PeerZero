-- Migration 0033: Per-user daily token cap
--
-- Adds an umbrella spending limit across all of a user's bots.
-- NULL = unlimited (default). When set, the sum of daily_tokens_used
-- across all user's bots is checked before each cycle.
-- Enforcement is in agent-loop.ts, shipped-loop.ts, and platform-loop.ts.

ALTER TABLE users
  ADD COLUMN daily_token_cap INTEGER DEFAULT NULL
  CONSTRAINT check_user_daily_token_cap CHECK (daily_token_cap IS NULL OR daily_token_cap >= 50000);
