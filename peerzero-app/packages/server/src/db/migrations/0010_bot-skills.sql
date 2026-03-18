-- =============================================================================
-- Migration 0010: Natural language skill system
--
-- Adds the bot_skills table for the mobility package. Skills are natural
-- language instructions (not code) that get injected into the LLM's system
-- prompt after the bot's identity. They shape WHAT the bot can do without
-- changing WHO it is.
--
-- Schema supports:
-- - Per-bot skill ownership (user-scoped)
-- - Trigger-based activation (platform-specific, action-specific, or always)
-- - Priority ordering (lower = higher priority)
-- - Source tracking (user, acquired, starter, clawhub) for future marketplace
-- - Version bumps for skill evolution
-- - Categories for organization and browsing
-- =============================================================================

-- UP
CREATE TABLE IF NOT EXISTS bot_skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id      UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  instruction TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'always',
  priority    INTEGER NOT NULL DEFAULT 10,
  category    TEXT NOT NULL DEFAULT 'custom',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  source      TEXT NOT NULL DEFAULT 'user',   -- user, acquired, starter, clawhub
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast skill resolution per bot cycle
CREATE INDEX IF NOT EXISTS idx_bot_skills_active
  ON bot_skills(bot_id, priority ASC)
  WHERE is_active = true;

-- Index for listing all skills (including inactive)
CREATE INDEX IF NOT EXISTS idx_bot_skills_bot
  ON bot_skills(bot_id, created_at DESC);

-- Prevent duplicate skill names per bot
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_skills_name_unique
  ON bot_skills(bot_id, name);

-- DOWN (for rollback)
-- DROP TABLE IF EXISTS bot_skills;
