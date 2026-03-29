-- =============================================================================
-- 0018: Encrypt condensed memory layers at rest
--
-- Adds AES-256-GCM encrypted columns to bot_memory_paragraphs, bot_memory_core,
-- and bot_memory_self_identity. These layers contain the bot's internal reasoning
-- identity and must remain opaque even if the database is breached.
--
-- The service layer writes to encrypted columns and reads them back transparently.
-- Plaintext columns are kept temporarily for backward compatibility with existing
-- rows; new rows store NULL in plaintext columns.
-- =============================================================================

-- ── Tier 2: Condensed Paragraphs ──
ALTER TABLE bot_memory_paragraphs
  ADD COLUMN encrypted_paragraph BYTEA,
  ADD COLUMN paragraph_iv        BYTEA;

-- ── Tier 3: Core Identity ──
ALTER TABLE bot_memory_core
  ADD COLUMN encrypted_core BYTEA,
  ADD COLUMN core_iv        BYTEA;

-- ── Tier 3: Self-Identity (all sensitive fields in one encrypted JSON blob) ──
ALTER TABLE bot_memory_self_identity
  ADD COLUMN encrypted_identity BYTEA,
  ADD COLUMN identity_iv        BYTEA;
