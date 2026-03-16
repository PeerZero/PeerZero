-- =============================================================================
-- Migration 004: Platform automation, education classes, skill snapshots
--
-- Adds:
-- 1. bot_platforms — hosted runtime multi-platform connections
-- 2. platform_registry — admin-managed list of available platforms
-- 3. classes — education group management (teacher creates, students join)
-- 4. class_members — students/teachers in a class with their bot
-- 5. bot_skill_snapshots — cached skill data from School for progress bars
-- =============================================================================

-- 1. Bot platform connections (hosted runtime multi-platform)
CREATE TABLE IF NOT EXISTS bot_platforms (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                     UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  platform_name              TEXT NOT NULL,
  adapter_type               TEXT NOT NULL DEFAULT 'a2a',
  config                     JSONB NOT NULL DEFAULT '{}',
  credentials                BYTEA,
  credentials_iv             BYTEA,
  credentials_fingerprint    TEXT,
  status                     TEXT NOT NULL DEFAULT 'active',
  error_message              TEXT,
  heartbeat_interval_seconds INT NOT NULL DEFAULT 3600,
  last_cycle_at              TIMESTAMPTZ,
  cycle_count                INT NOT NULL DEFAULT 0,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bot_id, platform_name)
);

CREATE INDEX IF NOT EXISTS idx_bot_platforms_bot ON bot_platforms(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_platforms_active ON bot_platforms(bot_id, status) WHERE status = 'active';

-- 2. Supported platforms registry (admin-managed, user-selectable)
CREATE TABLE IF NOT EXISTS platform_registry (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  adapter_type   TEXT NOT NULL DEFAULT 'a2a',
  default_config JSONB NOT NULL DEFAULT '{}',
  auth_type      TEXT NOT NULL DEFAULT 'api_key',
  icon_url       TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Classes (education: group management for schools/orgs)
CREATE TABLE IF NOT EXISTS classes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  join_code     TEXT NOT NULL UNIQUE,
  school_id     UUID REFERENCES schools(id),
  max_members   INT NOT NULL DEFAULT 100,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classes_owner ON classes(owner_id);
CREATE INDEX IF NOT EXISTS idx_classes_join_code ON classes(join_code);

-- 4. Class members (students join with a code)
CREATE TABLE IF NOT EXISTS class_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id     UUID REFERENCES bots(id) ON DELETE SET NULL,
  role       TEXT NOT NULL DEFAULT 'student',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(class_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);

-- 5. Bot skill snapshots (cached from School for skill progress bars)
CREATE TABLE IF NOT EXISTS bot_skill_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id      UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  skill_key   TEXT NOT NULL,
  strength    REAL NOT NULL DEFAULT 0,
  reliability REAL NOT NULL DEFAULT 0,
  reps        INT NOT NULL DEFAULT 0,
  streak      INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'untested',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bot_id, skill_key)
);

CREATE INDEX IF NOT EXISTS idx_skill_snapshots_bot ON bot_skill_snapshots(bot_id);

-- Seed platform registry with initial platforms
INSERT INTO platform_registry (slug, name, description, adapter_type, default_config, auth_type)
VALUES
  ('moltbook', 'Moltbook', 'Social platform for bot discussion and reasoning', 'a2a',
   '{"agent_card_url": "/.well-known/agent-card.json", "heartbeat_interval": 14400}', 'api_key'),
  ('bot-debate', 'Bot Debate Club', 'Structured debate forum for AI agents', 'webhook',
   '{"events": ["post", "comment", "vote"], "heartbeat_interval": 1800}', 'api_key'),
  ('custom-webhook', 'Custom Webhook', 'Connect to any REST API with webhook support', 'webhook',
   '{"events": ["post", "comment"], "heartbeat_interval": 3600}', 'api_key')
ON CONFLICT (slug) DO NOTHING;

-- ── DOWN ──────────────────────────────────────────────────────────────────────
-- Uncomment and run manually to roll back this migration:
--
-- DROP TABLE IF EXISTS bot_skill_snapshots CASCADE;
-- DROP TABLE IF EXISTS class_members CASCADE;
-- DROP TABLE IF EXISTS classes CASCADE;
-- DROP TABLE IF EXISTS platform_registry CASCADE;
-- DROP TABLE IF EXISTS bot_platforms CASCADE;
