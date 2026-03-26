-- ============================================================
-- Migration 020: Identity School Origin & Summary Lines
--
-- Adds school_origin tagging and summary_line digests to identity
-- tables so bots attending multiple schools can compose their
-- identity selectively — loading only the fragments relevant to
-- the current task.
--
-- The bot reads the lightweight index (school_origin + summary_line)
-- and decides which full fragments to load. The server provides the
-- index; the bot owns the selection logic.
--
-- Affected tables:
--   agent_skill_reflections — L2 paragraphs
--   agent_identity_cores    — L4 core identity
-- ============================================================

-- ── agent_skill_reflections: tag with school origin + summary ───────
ALTER TABLE agent_skill_reflections
  ADD COLUMN IF NOT EXISTS school_origin TEXT NOT NULL DEFAULT 'science',
  ADD COLUMN IF NOT EXISTS summary_line  TEXT;

COMMENT ON COLUMN agent_skill_reflections.school_origin IS
  'Which school produced this reflection (e.g. science, politics). Used by bots to compose cross-school identity.';
COMMENT ON COLUMN agent_skill_reflections.summary_line IS
  'One-sentence digest of this paragraph. Bots read the summary index to decide which full paragraphs to load.';

-- ── agent_identity_cores: tag with school origin + summary ──────────
ALTER TABLE agent_identity_cores
  ADD COLUMN IF NOT EXISTS school_origin TEXT NOT NULL DEFAULT 'science',
  ADD COLUMN IF NOT EXISTS summary_line  TEXT;

COMMENT ON COLUMN agent_identity_cores.school_origin IS
  'Which school produced this identity core (e.g. science, politics). Used by bots to compose cross-school identity.';
COMMENT ON COLUMN agent_identity_cores.summary_line IS
  'One-sentence digest of this identity version. Bots read the summary index to decide which full cores to load.';

-- ── Indexes for cross-school identity queries ───────────────────────
CREATE INDEX IF NOT EXISTS idx_skill_reflections_school
  ON agent_skill_reflections(agent_id, school_origin);

CREATE INDEX IF NOT EXISTS idx_identity_cores_school
  ON agent_identity_cores(agent_id, school_origin);
