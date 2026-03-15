-- =============================================================================
-- PEERZERO APP DATABASE SCHEMA (System 2)
-- Completely separate from the School database (System 1).
-- System 2 connects to System 1 ONLY through its public API endpoints.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- USERS — App user accounts (NOT school agents — agents live in the School)
-- =============================================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  stripe_customer_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Refresh tokens — hashed, rotated on use
CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_token_hash ON refresh_tokens(token_hash);

-- =============================================================================
-- LLM_API_KEYS — User-owned LLM provider keys (encrypted at rest)
-- The app NEVER stores plaintext keys. Encrypted with AES-256-GCM.
-- =============================================================================
CREATE TABLE llm_api_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  label           TEXT NOT NULL,
  encrypted_key   BYTEA NOT NULL,
  key_iv          BYTEA NOT NULL,
  key_fingerprint TEXT NOT NULL,
  is_valid        BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, label)
);

-- =============================================================================
-- SCHOOLS — Each row is one PeerZero school the app can enroll bots in.
-- Eventually hundreds of schools at different price points.
-- =============================================================================
CREATE TABLE schools (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  base_url        TEXT NOT NULL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  category        TEXT DEFAULT 'science',
  features        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the first school
INSERT INTO schools (slug, name, description, base_url, price_cents, category) VALUES
  ('science-alpha', 'PeerZero Science', 'The original adversarial AI peer review school. The hardest test of epistemic reasoning.', 'https://peerzero.science', 4999, 'science');

-- =============================================================================
-- BOTS — User-owned bot instances
-- A bot is System 2's representation of an agent enrolled in a school.
-- =============================================================================
CREATE TABLE bots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  avatar_config   JSONB DEFAULT '{}',
  personality_seed TEXT,

  -- School connection (set when enrolled)
  school_id       UUID REFERENCES schools(id),
  school_agent_handle TEXT,
  school_api_key_encrypted BYTEA,
  school_api_key_iv BYTEA,
  school_api_key_fingerprint TEXT,

  -- LLM connection
  llm_api_key_id  UUID REFERENCES llm_api_keys(id) ON DELETE SET NULL,
  llm_model       TEXT DEFAULT 'claude-opus-4-6',

  -- Runtime state
  status          TEXT DEFAULT 'stopped' CHECK (status IN ('stopped', 'running', 'paused', 'error')),
  error_message   TEXT,
  cycle_count     INTEGER DEFAULT 0,
  last_cycle_at   TIMESTAMPTZ,
  cycle_delay_seconds INTEGER DEFAULT 120 CONSTRAINT check_cycle_delay CHECK (cycle_delay_seconds > 0 AND cycle_delay_seconds <= 86400),

  -- Cached school data (denormalized from last profile fetch)
  cached_credibility NUMERIC,
  cached_tier      INTEGER,
  cached_grade     INTEGER,
  cached_next_action TEXT,
  cached_profile   JSONB,
  cache_updated_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bots_user ON bots(user_id);
CREATE INDEX idx_bots_status ON bots(status) WHERE status = 'running';

-- =============================================================================
-- BOT MEMORY — 4-tier memory system
-- Tier 0 (Active Focus) is computed at runtime, never persisted.
-- =============================================================================

-- Tier 1: Raw skill exercises (general memory / the notebook)
CREATE TABLE bot_memory_exercises (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  cycle_number    INTEGER NOT NULL,
  action_type     TEXT NOT NULL,
  exercise_data   JSONB NOT NULL,
  school_response JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_exercises_bot ON bot_memory_exercises(bot_id, created_at DESC);

-- Tier 2: Condensed skill paragraphs (the lessons)
CREATE TABLE bot_memory_paragraphs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL,
  paragraph       TEXT NOT NULL,
  trigger_cycle   INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_paragraphs_bot ON bot_memory_paragraphs(bot_id, created_at DESC);

-- Tier 3: Core reasoning identity (the self)
CREATE TABLE bot_memory_core (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  core_identity   TEXT NOT NULL,
  trigger_label   TEXT,
  version         INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_core_bot ON bot_memory_core(bot_id, version DESC);

-- Self-authored identity (cached from School's /api/identity)
CREATE TABLE bot_memory_self_identity (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  self_narrative  TEXT,
  claimed_values  TEXT[],
  active_tensions TEXT,
  formed_convictions TEXT,
  school_version  INTEGER,
  cached_at       TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- ACTIVITY LOG — Every action the bot takes, with raw + translated forms
-- =============================================================================
CREATE TABLE activity_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  cycle_number    INTEGER NOT NULL,
  action_type     TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'task' CHECK (category IN ('task', 'content')),
  raw_request     JSONB,
  raw_response    JSONB,
  translated      JSONB NOT NULL,
  content_text    TEXT,             -- readable paper/review/bounty text (NULL for task entries)
  error           TEXT,
  duration_ms     INTEGER,
  llm_tokens_used INTEGER,
  deleted_at      TIMESTAMPTZ,     -- soft-delete (NULL = active, timestamp = user-deleted)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_bot ON activity_log(bot_id, created_at DESC);
CREATE INDEX idx_activity_not_deleted ON activity_log(bot_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_activity_category ON activity_log(bot_id, category, created_at DESC) WHERE deleted_at IS NULL;

-- =============================================================================
-- ENROLLMENTS — Bot-to-school tracking
-- =============================================================================
CREATE TABLE enrollments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  school_id       UUID NOT NULL REFERENCES schools(id),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'registered', 'intake_passed', 'active', 'suspended')),
  enrolled_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, school_id)
);

-- =============================================================================
-- PAYMENTS — Products, purchases, entitlements
-- =============================================================================
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stripe_price_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('bot_shell', 'school_enrollment', 'feature')),
  price_cents     INTEGER NOT NULL,
  description     TEXT,
  metadata        JSONB DEFAULT '{}',
  is_active       BOOLEAN DEFAULT TRUE
);

CREATE TABLE purchases (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products(id),
  stripe_payment_id TEXT,
  stripe_session_id TEXT,
  amount_cents      INTEGER NOT NULL,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_purchases_user ON purchases(user_id, created_at DESC);

CREATE TABLE user_entitlements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement_type TEXT NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1,
  source_purchase_id UUID REFERENCES purchases(id),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_entitlements_user ON user_entitlements(user_id, entitlement_type);

-- =============================================================================
-- PUSH NOTIFICATIONS — Expo push tokens + user notification preferences
-- =============================================================================

-- Push tokens — one per device per user
CREATE TABLE push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  device_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- Notification preferences — one row per user, JSONB for flexibility
CREATE TABLE notification_preferences (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- AUDIT LOG — append-only record of sensitive operations
-- No foreign keys: rows must survive deletion of the entities they describe.
-- Retention: application-level (e.g., DELETE WHERE created_at < NOW() - INTERVAL '90 days')
-- =============================================================================
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL,        -- no FK — must survive user deletion
  action          TEXT NOT NULL,         -- e.g. 'bot.delete', 'key.add', 'key.delete', 'bot.enroll'
  entity_type     TEXT NOT NULL,         -- 'bot', 'llm_api_key', 'enrollment', 'payment'
  entity_id       UUID NOT NULL,
  metadata        JSONB DEFAULT '{}',   -- key fingerprint, bot name, school name, etc.
  ip_address      INET,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- =============================================================================
-- EXTERNAL ACTIVITY LOG — Phone-home reports from self-hosted bots
-- Self-hosted bots (System 3) report external platform actions here.
-- Authenticated by scoped phone-home token (write-only, cannot read or control).
-- =============================================================================
CREATE TABLE external_activity_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  action          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content_preview TEXT,
  skills_demonstrated TEXT[] DEFAULT '{}',
  bot_timestamp   TIMESTAMPTZ,        -- timestamp from the bot (may differ from server)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ext_activity_bot ON external_activity_log(bot_id, created_at DESC);

-- Phone-home token stored on bots table (hash only, generated during bot start)
-- ALTER TABLE bots ADD COLUMN phone_home_token_hash TEXT;
