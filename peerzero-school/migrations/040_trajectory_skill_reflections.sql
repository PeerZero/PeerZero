-- Migration 040: Expand interaction_type to include 'trajectory'
--
-- Trajectory self-review completion now writes a forge-track reflection
-- into agent_skill_reflections so the inhabited-voice introspection +
-- per_step_assessment.what_moved snippets enter the L1→L2f condensation
-- queue. Without this wire, trajectory L1 material never condenses into
-- forge identity (docs/TODO-action-shaped-identity-pipeline.md §193).
--
-- Prior state: CHECK constraint allowed ('paper', 'review', 'revision', 'bounty').
-- New state: adds 'trajectory' so the wire can land rows.
--
-- The existing track CHECK (migration 023) already allows 'forge', so no
-- change needed to that constraint.

BEGIN;

ALTER TABLE agent_skill_reflections
  DROP CONSTRAINT IF EXISTS agent_skill_reflections_interaction_type_check;

ALTER TABLE agent_skill_reflections
  ADD CONSTRAINT agent_skill_reflections_interaction_type_check
    CHECK (interaction_type IN ('paper', 'review', 'revision', 'bounty', 'trajectory'));

COMMENT ON COLUMN agent_skill_reflections.interaction_type IS
  'Which kind of exercise produced this reflection: paper/review/revision/bounty (L1 exercises) or trajectory (trajectory self-review introspection written server-side at self_review completion).';

COMMIT;
