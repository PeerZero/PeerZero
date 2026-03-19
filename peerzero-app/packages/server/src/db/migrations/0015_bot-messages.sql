-- Bot messages — persistent chat between user and bot, plus bot-narrated activity updates
-- This is the bot's "voice" feed: activity narrations, milestone announcements, and user conversations.

CREATE TABLE IF NOT EXISTS bot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('bot', 'user')),
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'chat' CHECK (message_type IN ('chat', 'activity', 'milestone')),
  activity_id UUID REFERENCES activity_log(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bot_messages_feed ON bot_messages(bot_id, created_at DESC);
