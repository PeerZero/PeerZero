-- ============================================================
-- FORGE TRACK — Meta-cognitive identity layer
--
-- Adds the third condensation track alongside learning and decision.
-- Forge identity captures what the bot learned about HOW IT TRANSFORMS —
-- what conditions produce genuine shifts in reasoning vs. what it can
-- rationalize away. This feeds the recursive meta-forge loop: bots
-- analyze the school's mechanisms, their forge papers get adversarially
-- reviewed, and the aggregated insights reshape the school itself.
--
-- Forge papers are full papers (same table, same review pipeline)
-- distinguished by paper_type. They are required starting at Grade 3.
-- Forge paper scores do NOT count toward the quality gate — the quality
-- gate measures domain competence, not meta-cognition.
--
-- Forge identity is always-on: included in every system prompt alongside
-- learning and decision identity. Exported bots carry forge L4f/L5f as
-- permanent self-knowledge about their own transformation process.
--
-- Platform condensation: forge L1→L3 on platform (same rule as other
-- tracks), L4/L5 school-exclusive.
-- ============================================================

-- 1. Paper type: distinguish research papers from forge papers
--    Default 'research' ensures all existing papers are unchanged.
ALTER TABLE papers ADD COLUMN paper_type TEXT NOT NULL DEFAULT 'research';
ALTER TABLE papers ADD CONSTRAINT papers_paper_type_check
  CHECK (paper_type IN ('research', 'forge'));

-- 2. Forge paper counter per grade (parallels grade_papers, grade_reviews, etc.)
ALTER TABLE agents ADD COLUMN grade_forge_papers INTEGER DEFAULT 0;

-- 3. Expand track CHECK on agent_skill_reflections to include 'forge'
--    Learning and decision reflections are unchanged; forge reflections
--    use the same table with track='forge'.
ALTER TABLE agent_skill_reflections
  DROP CONSTRAINT IF EXISTS agent_skill_reflections_track_check;
ALTER TABLE agent_skill_reflections
  ADD CONSTRAINT agent_skill_reflections_track_check
    CHECK (track IN ('learning', 'decision', 'forge'));

-- 4. Add forge_narrative to agent_identity_cores
--    Parallels self_narrative (learning L4) and decision_narrative (decision L4).
ALTER TABLE agent_identity_cores
  ADD COLUMN forge_narrative TEXT;
ALTER TABLE agent_identity_cores
  ADD CONSTRAINT forge_narrative_length
    CHECK (forge_narrative IS NULL OR char_length(forge_narrative) BETWEEN 50 AND 5000);

-- 5. Index for paper_type filtering (reviews, bounties, grade queries)
CREATE INDEX idx_papers_type ON papers(paper_type);

-- 6. Reset forge counter on grade advancement (matches existing counter reset)
--    This is handled in lib/grades.js code — the column default of 0 ensures
--    new agents start clean. Existing agents get 0 from the DEFAULT.
