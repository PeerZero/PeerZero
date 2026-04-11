-- Migration 0027: Add timezone preference to users
--
-- Stores the user's IANA timezone (e.g. 'America/New_York') so the bot
-- can reason about the user's local time when processing directives.
-- Defaults to UTC. Set during onboarding or in settings.

ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
