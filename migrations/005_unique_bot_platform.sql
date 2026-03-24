-- Prevent duplicate platform connections per bot (race condition guard).
-- The application already checks for duplicates, but this enforces it at the DB level.
ALTER TABLE bot_platforms
  ADD CONSTRAINT uq_bot_platforms_bot_platform
  UNIQUE (bot_id, platform_name);
