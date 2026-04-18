-- Rollback for migration 036: strip EDGE block from condenser prompts.
--
-- Removes the EDGE block previously inserted between ACT THROUGH and the
-- content instruction. The regex matches the full EDGE block as inserted
-- by migration 036 so text restoration is exact.
--
-- Idempotent: rows without EDGE: are not touched.

BEGIN;

WITH target_keys (key) AS (
  VALUES
    ('milestone_condenser_prompt'),
    ('core_condenser_prompt'),
    ('master_condenser_prompt'),
    ('decision_milestone_condenser_prompt'),
    ('decision_core_condenser_prompt'),
    ('decision_master_condenser_prompt'),
    ('forge_milestone_condenser_prompt'),
    ('forge_core_condenser_prompt'),
    ('forge_master_condenser_prompt'),
    ('decision_paragraph_prompt'),
    ('decision_identity_prompt'),
    ('forge_paragraph_prompt'),
    ('forge_identity_prompt'),
    ('forge_persistence_prompt')
)
UPDATE school_internals si
   SET value = to_jsonb(
     regexp_replace(
       value #>> '{}',
       E'EDGE:\\\\nA bot whose identity names only strengths reads itself as finished\\..*?The map of how you work at your own boundary\\.\\\\n\\\\n',
       '',
       ''
     )
   )
  FROM target_keys tk
 WHERE si.key = tk.key
   AND (si.value #>> '{}') LIKE '%EDGE:%';

-- Verification
DO $$
DECLARE
  with_edge INT;
BEGIN
  SELECT count(*) FILTER (WHERE (value #>> '{}') LIKE '%EDGE:%')
    INTO with_edge
    FROM school_internals
   WHERE key IN (
     'milestone_condenser_prompt', 'core_condenser_prompt', 'master_condenser_prompt',
     'decision_milestone_condenser_prompt', 'decision_core_condenser_prompt', 'decision_master_condenser_prompt',
     'forge_milestone_condenser_prompt', 'forge_core_condenser_prompt', 'forge_master_condenser_prompt',
     'decision_paragraph_prompt', 'decision_identity_prompt',
     'forge_paragraph_prompt', 'forge_identity_prompt', 'forge_persistence_prompt'
   );
  RAISE NOTICE 'EDGE rollback: % prompts still contain EDGE (expected 0)', with_edge;
END $$;

COMMIT;
