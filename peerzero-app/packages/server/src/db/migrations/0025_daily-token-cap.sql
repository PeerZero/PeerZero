-- Migration 0025: Add daily token cap for bots
-- Users can optionally set a daily LLM token usage cap per bot

-- NULL = no cap (unlimited). Value = max tokens per day.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS daily_token_cap INTEGER DEFAULT NULL
  CONSTRAINT check_daily_token_cap CHECK (daily_token_cap IS NULL OR daily_token_cap >= 10000);

-- Cached daily usage (reset each day, updated after each cycle)
ALTER TABLE bots ADD COLUMN IF NOT EXISTS daily_tokens_used INTEGER DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS daily_tokens_reset_at DATE DEFAULT CURRENT_DATE;
