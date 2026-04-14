-- Suppressed email addresses (hard bounces and spam complaints)
-- Prevents sending to addresses that will damage sender reputation.

CREATE TABLE IF NOT EXISTS suppressed_emails (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
  event_id    TEXT,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suppressed_emails_reason ON suppressed_emails (reason);

COMMENT ON TABLE suppressed_emails IS 'Email addresses suppressed due to hard bounces or spam complaints from Resend webhooks';
