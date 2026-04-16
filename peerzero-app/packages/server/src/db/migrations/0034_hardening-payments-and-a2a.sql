-- 0034_hardening-payments-and-a2a.sql
-- Hardens payment lookups and A2A task threading:
--
--   1. Index + UNIQUE on purchases.stripe_payment_id. The refund webhook
--      filters by stripe_payment_id (payment.service.ts:179) but there was
--      no index, so the query did a full table scan. The UNIQUE also
--      prevents two purchase rows from ever claiming the same Stripe
--      payment intent — Stripe intents are 1:1 with payments.
--
--   2. Partial UNIQUE on bot_tasks (bot_id, direction, conversation_id,
--      turn_number) to prevent a second sender from injecting a duplicate
--      turn into an existing conversation on a bot's inbox.
--
--   3. Callback delivery state columns on bot_tasks. Before this change,
--      deliverCallback in shipped-loop.ts was fire-and-forget: a transient
--      network failure silently lost the result. These columns let the
--      shipped loop retry with exponential backoff.

-- ── 1. Purchases: lookup index + uniqueness on Stripe payment intent ────
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_stripe_payment_id
  ON purchases(stripe_payment_id)
  WHERE stripe_payment_id IS NOT NULL;

-- ── 2. bot_tasks: prevent duplicate turns within one conversation ───────
-- Same conversation_id can legitimately appear on both sides of the same
-- bot's inbox (incoming from sender, outgoing reply back) — so the
-- uniqueness is scoped by (bot_id, direction). And by different bots
-- entirely (A and B each keep their own rows for one shared conversation).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_tasks_conversation_turn_unique
  ON bot_tasks(bot_id, direction, conversation_id, turn_number)
  WHERE conversation_id IS NOT NULL;

-- ── 3. bot_tasks: callback retry state ──────────────────────────────────
ALTER TABLE bot_tasks
  ADD COLUMN IF NOT EXISTS callback_delivered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callback_attempts        INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callback_last_error      TEXT;

-- Index to let the shipped loop cheaply find tasks that need a callback
-- retry: callback pending, not yet delivered, next attempt due.
CREATE INDEX IF NOT EXISTS idx_bot_tasks_callback_pending
  ON bot_tasks(bot_id, callback_next_attempt_at)
  WHERE callback_url IS NOT NULL
    AND callback_delivered_at IS NULL
    AND callback_next_attempt_at IS NOT NULL;
