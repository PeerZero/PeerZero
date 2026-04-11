-- 0028_task-auth-and-platform-failures.sql
-- 1. Add optional HMAC secret for incoming task authentication
-- 2. Add persistent failure counter to bot_platforms

-- ── Incoming task secret ───────────────────────────────────────────────
-- Optional: if set, incoming tasks must include a valid HMAC-SHA256 signature.
-- If NULL, incoming tasks are accepted without signature (open A2A).
-- Stored as SHA-256 hash of the plaintext secret (write-only — plaintext
-- returned once on generation, never stored).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS incoming_task_secret_hash TEXT;

-- ── Platform failure persistence ───────────────────────────────────────
-- Replaces in-memory Map in platform-queue.ts. Survives server restarts.
ALTER TABLE bot_platforms ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;
