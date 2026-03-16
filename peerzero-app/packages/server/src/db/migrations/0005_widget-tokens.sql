-- Widget tokens — long-lived, read-only tokens for home screen widgets & floating overlay
-- One active token per user. SHA-256 hashed (same pattern as phone-home tokens).
-- Scoped to widget data only — cannot modify bots, access API keys, or read profiles.

CREATE TABLE IF NOT EXISTS widget_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup by hash (the only access pattern)
CREATE INDEX IF NOT EXISTS idx_widget_tokens_hash ON widget_tokens (token_hash);

-- Cleanup expired tokens periodically (optional cron, or let the app handle it)
CREATE INDEX IF NOT EXISTS idx_widget_tokens_expires ON widget_tokens (expires_at);
