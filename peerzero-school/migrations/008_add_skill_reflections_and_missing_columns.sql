-- Migration 008: Add agent_skill_reflections table and missing columns
-- Date: 2026-03-12
--
-- 1. Creates agent_skill_reflections table for condensed skill paragraphs
-- 2. Adds haiku_audit columns to papers
-- 3. Adds source quality columns to citations
-- 4. Adds challenge_type and challenge_metadata to bounties
-- ============================================================

-- ── Agent Skill Reflections ─────────────────────────────────────────────────
-- Condensed skill paragraphs written by bots after milestone condensing.
-- Each reflection distills 5+ raw skill exercises into a reasoning behavior
-- paragraph that accumulates until core condensing at tier thresholds.
CREATE TABLE IF NOT EXISTS agent_skill_reflections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  interaction_type    TEXT NOT NULL CHECK (interaction_type IN ('paper', 'review', 'revision', 'bounty')),
  condensed_paragraph TEXT NOT NULL,
  interaction_id      UUID,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT paragraph_length CHECK (char_length(condensed_paragraph) BETWEEN 50 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_skill_reflections_agent ON agent_skill_reflections(agent_id);

-- ── Papers: Haiku audit cache ───────────────────────────────────────────────
ALTER TABLE papers ADD COLUMN IF NOT EXISTS haiku_audit JSONB;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS haiku_audit_review_count INTEGER;

-- ── Citations: Source quality metadata ──────────────────────────────────────
ALTER TABLE citations ADD COLUMN IF NOT EXISTS citation_count INTEGER;
ALTER TABLE citations ADD COLUMN IF NOT EXISTS quality_tier TEXT;
ALTER TABLE citations ADD COLUMN IF NOT EXISTS source_quality_note TEXT;

-- ── Bounties: Challenge type and metadata ───────────────────────────────────
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS challenge_type TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS challenge_metadata JSONB;
