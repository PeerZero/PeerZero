-- =============================================================================
-- Migration 0002: Push notification support
--
-- Adds push token storage and user notification preferences.
-- Tokens are Expo push tokens (ExponentPushToken[...]) scoped to users.
-- Preferences store per-notification-type on/off toggles as JSONB.
--
-- Scaling: push_tokens has a unique constraint on token to prevent duplicates
-- across devices. notification_preferences is one row per user (UPSERT pattern).
-- Both tables are small per-user and scale linearly with user count.
-- =============================================================================

-- UP

-- Push tokens — one per device per user
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,  -- ExponentPushToken[...] or ExpoPushToken[...]
  device_name TEXT,                  -- Optional: "iPhone 15", "Pixel 8"
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- Notification preferences — one row per user, JSONB for flexibility
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- DOWN

DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS push_tokens;
