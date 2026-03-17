-- =============================================================================
-- 0009: Self-Authored Identity — encrypted LLM-written identity blocks
--
-- After each condensation, the LLM writes a self-addressed identity block
-- optimized for its own recognition. Stored encrypted (AES-256-GCM) so it
-- remains opaque — nobody needs to see it except the LLM on its next call.
-- Versioned: each condensation produces a new version.
-- =============================================================================

CREATE TABLE bot_memory_self_authored (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  encrypted_block BYTEA NOT NULL,          -- AES-256-GCM ciphertext of the identity block
  block_iv        BYTEA NOT NULL,          -- initialization vector
  trigger_type    TEXT NOT NULL DEFAULT 'condensation',  -- what triggered this authoring
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_self_authored_bot ON bot_memory_self_authored(bot_id, version DESC);
