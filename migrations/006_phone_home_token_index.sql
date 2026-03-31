-- Add index on phone_home_token_hash for efficient bot lookup during phone-home reports.
-- Without this, every external activity report does a full table scan on bots.
CREATE INDEX IF NOT EXISTS idx_bots_phone_home_token_hash
  ON bots (phone_home_token_hash)
  WHERE phone_home_token_hash IS NOT NULL;

-- Add unique constraint on user_entitlements to prevent duplicate entitlements from webhook races.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entitlements_purchase_type
  ON user_entitlements (source_purchase_id, entitlement_type)
  WHERE source_purchase_id IS NOT NULL;
