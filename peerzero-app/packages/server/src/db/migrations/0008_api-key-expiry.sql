-- Add expiration support for LLM API keys
-- Keys without expires_at never expire (backwards-compatible default)
ALTER TABLE llm_api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- Index to efficiently query unexpired keys
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON llm_api_keys(expires_at) WHERE expires_at IS NOT NULL;
