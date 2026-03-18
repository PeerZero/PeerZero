-- 0011: Add extended_thinking toggle to bots
-- Allows users to opt-in to Claude extended thinking per bot.
-- Default OFF to avoid unexpected cost increases.

ALTER TABLE bots ADD COLUMN extended_thinking BOOLEAN DEFAULT FALSE;
