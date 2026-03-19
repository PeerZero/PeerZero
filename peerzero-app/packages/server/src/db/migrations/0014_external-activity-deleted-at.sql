-- Add soft-delete column to external_activity_log
-- This column was defined in schema.sql but never created via migration
ALTER TABLE external_activity_log ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
