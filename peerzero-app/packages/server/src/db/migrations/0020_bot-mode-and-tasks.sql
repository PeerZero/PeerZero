-- 0020_bot-mode-and-tasks.sql
-- Adds shipped/school mode toggle to bots, and a tasks table for
-- structured agent-to-agent coordination (A2A task lifecycle).

-- ── Mode column ─────────────────────────────────────────────────────
-- Mode is orthogonal to status. A bot can be mode=shipped, status=running.
-- School mode = artifact-only training (papers, reviews, bounties).
-- Shipped mode = platform interactions, A2A coordination, task delegation.
ALTER TABLE bots ADD COLUMN mode TEXT NOT NULL DEFAULT 'school'
  CHECK (mode IN ('school', 'shipped'));
CREATE INDEX idx_bots_mode ON bots(mode) WHERE status = 'running';

-- ── Bot tasks ───────────────────────────────────────────────────────
-- Structured task messages between bots (A2A task lifecycle).
-- Supports: delegation, callbacks, multi-turn conversations.
CREATE TABLE bot_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  request_id        TEXT NOT NULL UNIQUE,
  direction         TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),

  -- Who sent / who is the target
  sender            TEXT NOT NULL,          -- agent card URL or bot handle
  target            TEXT NOT NULL DEFAULT '',-- agent card URL or bot handle

  -- What was requested
  action_requested  TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',

  -- Callback and deadline
  callback_url      TEXT,
  deadline          TIMESTAMPTZ,

  -- Conversation threading
  conversation_id   TEXT,
  turn_number       INT DEFAULT 0,

  -- Lifecycle
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected', 'expired')),
  result            JSONB,
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_bot_tasks_bot ON bot_tasks(bot_id, created_at DESC);
CREATE INDEX idx_bot_tasks_conversation ON bot_tasks(conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_bot_tasks_pending ON bot_tasks(bot_id, status)
  WHERE status = 'pending';
