ALTER TABLE bots ADD COLUMN IF NOT EXISTS phone_home_token_expires_at TIMESTAMPTZ;
-- Set default expiry for existing tokens (90 days from now)
UPDATE bots SET phone_home_token_expires_at = NOW() + INTERVAL '90 days' WHERE phone_home_token_hash IS NOT NULL AND phone_home_token_expires_at IS NULL;
