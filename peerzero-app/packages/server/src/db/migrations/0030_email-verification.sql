-- =============================================================================
-- Migration 0030: Email verification
--
-- Adds email_verified flag and verification token to users table.
-- Existing users are marked as verified (grandfathered in).
-- New users start unverified and must confirm their email.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT;

-- Grandfather existing users — they registered before verification was required
UPDATE users SET email_verified = TRUE WHERE email_verified = FALSE;

-- Index for token lookup during verification
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users (email_verification_token_hash)
  WHERE email_verification_token_hash IS NOT NULL;
