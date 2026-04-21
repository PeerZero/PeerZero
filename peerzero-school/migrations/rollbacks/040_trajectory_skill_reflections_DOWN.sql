-- Rollback for migration 040: restore the pre-trajectory interaction_type
-- CHECK constraint. Safe only if no reflection rows with
-- interaction_type='trajectory' exist — they will be blocked by the old
-- constraint. Check before running.

BEGIN;

ALTER TABLE agent_skill_reflections
  DROP CONSTRAINT IF EXISTS agent_skill_reflections_interaction_type_check;

ALTER TABLE agent_skill_reflections
  ADD CONSTRAINT agent_skill_reflections_interaction_type_check
    CHECK (interaction_type IN ('paper', 'review', 'revision', 'bounty'));

COMMIT;
