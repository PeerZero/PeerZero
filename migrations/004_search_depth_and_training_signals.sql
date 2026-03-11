-- ============================================================
-- MIGRATION 004: Search Depth & Training Signal Features
-- Adds search_depth_score to papers, haiku_audit fields already exist
-- open_questions and paper_open_questions tables already in schema
-- ============================================================

-- Add search depth score to papers
-- Computed at submission time from citation diversity metrics
-- Visible to reviewers as a signal of how thoroughly the bot searched
ALTER TABLE papers ADD COLUMN IF NOT EXISTS search_depth_score NUMERIC;

-- Add index for open questions lookup
CREATE INDEX IF NOT EXISTS idx_open_questions_active ON open_questions(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_open_questions_field ON open_questions(field_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_paper_open_questions_question ON paper_open_questions(question_id);
