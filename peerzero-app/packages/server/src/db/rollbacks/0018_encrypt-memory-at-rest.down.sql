-- Rollback 0018: Remove encrypted memory columns
-- WARNING: Any data stored only in encrypted columns will be lost.
-- Ensure plaintext columns have been backfilled before running.

ALTER TABLE bot_memory_paragraphs
  DROP COLUMN IF EXISTS encrypted_paragraph,
  DROP COLUMN IF EXISTS paragraph_iv;

ALTER TABLE bot_memory_core
  DROP COLUMN IF EXISTS encrypted_core,
  DROP COLUMN IF EXISTS core_iv;

ALTER TABLE bot_memory_self_identity
  DROP COLUMN IF EXISTS encrypted_identity,
  DROP COLUMN IF EXISTS identity_iv;

DELETE FROM schema_migrations WHERE name = '0018_encrypt-memory-at-rest.sql';
