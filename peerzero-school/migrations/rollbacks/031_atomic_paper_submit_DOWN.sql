-- =============================================================================
-- Rollback 031: Remove atomic paper submission function
--
-- Drops the submit_paper_atomic() RPC. After rollback, paper submissions
-- revert to 3 independent Supabase calls (paper INSERT, paper_fields INSERT,
-- citations INSERT). The papers/paper_fields/citations tables are NOT affected.
-- =============================================================================

DROP FUNCTION IF EXISTS submit_paper_atomic(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, INT[], JSONB
);
