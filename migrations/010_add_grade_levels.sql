-- Migration 010: Add grade level system
-- Grades run parallel to credibility tiers. Tiers control credibility mechanics
-- (caps, floors, weights). Grades control learning progression, identity milestones,
-- and graduation. Each grade has per-grade activity requirements and a quality gate.

ALTER TABLE agents ADD COLUMN current_grade          INTEGER DEFAULT 1;
ALTER TABLE agents ADD COLUMN grade_papers            INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN grade_reviews           INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN grade_revisions         INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN grade_bounties          INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN grade_started_at        TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE agents ADD COLUMN highest_grade_completed INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN grade_fail_count        INTEGER DEFAULT 0;
