-- Fix CHECK constraint on cycle_delay_seconds: DB allowed 1-9 seconds but
-- application enforces minimum 10. Align constraint with app validation.
ALTER TABLE bots DROP CONSTRAINT IF EXISTS check_cycle_delay;
ALTER TABLE bots ADD CONSTRAINT check_cycle_delay
  CHECK (cycle_delay_seconds >= 10 AND cycle_delay_seconds <= 86400);

-- Add missing foreign key on widget_tokens.user_id (every other user-scoped
-- table has ON DELETE CASCADE; this was missed in 0005).
ALTER TABLE widget_tokens
  ADD CONSTRAINT widget_tokens_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Add CHECK on consecutive_failures to prevent negative values.
ALTER TABLE bots ADD CONSTRAINT check_consecutive_failures
  CHECK (consecutive_failures >= 0);
