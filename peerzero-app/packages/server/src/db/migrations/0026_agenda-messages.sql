-- Migration 0026: Add 'agenda' message type for action desk UI
--
-- Agenda messages appear inline in the chat feed, showing the bot's
-- current action plan (DAG of steps with live status updates).
-- Unlike other messages, agenda messages are MUTABLE — their metadata
-- is updated as steps complete/fail.

-- Expand the message_type CHECK constraint to include 'agenda'
ALTER TABLE bot_messages DROP CONSTRAINT IF EXISTS bot_messages_message_type_check;
ALTER TABLE bot_messages ADD CONSTRAINT bot_messages_message_type_check
  CHECK (message_type IN ('chat', 'activity', 'milestone', 'agenda'));
