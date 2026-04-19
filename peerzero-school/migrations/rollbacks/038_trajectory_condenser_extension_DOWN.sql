-- Rollback for migration 038: strip the PRESENCE block from forge condenser prompts.
-- Matches and removes PRESENCE:...\n\n (everything from "PRESENCE:" up to the
-- next \n\n boundary). Idempotent — skips rows that don't contain PRESENCE:.

BEGIN;

UPDATE school_internals si
   SET value = to_jsonb(
     regexp_replace(
       value #>> '{}',
       E'PRESENCE:[\\s\\S]*?\\n\\n',
       '',
       ''  -- first match only
     )
   )
 WHERE key IN (
   'forge_milestone_condenser_prompt',
   'forge_core_condenser_prompt',
   'forge_master_condenser_prompt',
   'forge_paragraph_prompt',
   'forge_identity_prompt',
   'forge_persistence_prompt'
 )
   AND (value #>> '{}') LIKE '%PRESENCE:%';

COMMIT;
