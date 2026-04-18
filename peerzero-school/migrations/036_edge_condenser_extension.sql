-- Migration 036: EDGE condenser extension — insert EDGE block between
-- ACT THROUGH and content instruction in existing condenser prompts.
--
-- The EDGE extension (validated in spikes/preamble-test/run_edge_template_test.py)
-- forces condenser output to include both earned confidence AND specific
-- edges worked at. JS static fallbacks and seed SQL are already updated;
-- this migration backfills existing production deployments whose
-- school_internals rows were seeded before the change.
--
-- Approach: regex_replace on each content-instruction marker, matching the
-- "\n\n<marker>" boundary and prepending the EDGE block. Idempotent — the
-- regex uses a negative lookahead (simulated via NOT LIKE check) to skip
-- rows that already contain EDGE:.
--
-- Rollback: see rollbacks/036_edge_condenser_extension_down.sql — restores
-- prompts by stripping the EDGE block.

BEGIN;

-- Shared EDGE block (JSON-encoded newlines). Kept as a CTE so we don't
-- repeat the literal 14 times.
WITH edge AS (
  SELECT E'EDGE:\\nA bot whose identity names only strengths reads itself as finished. A bot whose identity names only uncertainties reaches for the nearest hedge. A bot that names both — earned confidence inside, specific edges worked at — recognizes itself as mid-work.\\n\\nIn your paragraph: include the shape of your edge AND where you reached into it anyway. What returned, what the trying revealed. Not hedges. The map of how you work at your own boundary.\\n\\n' AS block
),
target_keys (key) AS (
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
),
content_markers (marker) AS (
  VALUES
    ('Your exercises are above'),
    ('Your condensed documents and skill profile are above'),
    ('Your condensed decision documents are below'),
    ('Your decision paragraphs are below'),
    ('Your forge paragraphs are below'),
    ('Your condensed forge documents are below'),
    ('Everything above gets absorbed into this')
)
UPDATE school_internals si
   SET value = to_jsonb(
     regexp_replace(
       value #>> '{}',                                 -- extract text from JSONB
       E'(\\\\n\\\\n)(' || (
         SELECT string_agg(regexp_replace(marker, '([().[\\]{}*+?|^$\\\\])', '\\\\\\1', 'g'), '|')
           FROM content_markers
       ) || ')',
       '\1' || (SELECT block FROM edge) || '\2',
       ''                                              -- replace FIRST match only (not 'g')
     )
   )
  FROM target_keys tk
 WHERE si.key = tk.key
   AND (si.value #>> '{}') NOT LIKE '%EDGE:%'         -- idempotent: skip if already present
   AND (si.value #>> '{}') LIKE '%ACT THROUGH:%';      -- sanity: only update prompts with ACT THROUGH

-- Verification: log how many rows have EDGE after the migration.
DO $$
DECLARE
  with_edge INT;
  without_edge INT;
BEGIN
  SELECT
    count(*) FILTER (WHERE (value #>> '{}') LIKE '%EDGE:%'),
    count(*) FILTER (WHERE (value #>> '{}') NOT LIKE '%EDGE:%')
    INTO with_edge, without_edge
    FROM school_internals
   WHERE key IN (
     'milestone_condenser_prompt', 'core_condenser_prompt', 'master_condenser_prompt',
     'decision_milestone_condenser_prompt', 'decision_core_condenser_prompt', 'decision_master_condenser_prompt',
     'forge_milestone_condenser_prompt', 'forge_core_condenser_prompt', 'forge_master_condenser_prompt',
     'decision_paragraph_prompt', 'decision_identity_prompt',
     'forge_paragraph_prompt', 'forge_identity_prompt', 'forge_persistence_prompt'
   );
  RAISE NOTICE 'EDGE condenser extension: % prompts with EDGE, % without', with_edge, without_edge;
END $$;

COMMIT;
