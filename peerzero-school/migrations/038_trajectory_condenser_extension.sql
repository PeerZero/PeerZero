-- Migration 038: Trajectory condenser extension — inserts a PRESENCE block
-- between EDGE and the content instruction in the 3 forge condenser prompts.
--
-- Why: trajectory exercises (migration 037) produce a new kind of L1 entry
-- that feeds the forge track. Without prompt-level guidance, the condenser
-- would collapse trajectory observations into generic "I learned to be more
-- careful" — losing the process-shaped signal that trajectory exercises exist
-- to produce. The PRESENCE block instructs the condenser to preserve the
-- specific-moment, scar-shaped character of trajectory observations.
--
-- Approach: regex_replace matching the known content-instruction markers,
-- prepending the PRESENCE block. Idempotent — skips rows already containing
-- PRESENCE:. Same pattern as migration 036 (EDGE extension).
--
-- Targets:
--   forge_milestone_condenser_prompt → marker: "Your exercises are above"
--   forge_core_condenser_prompt      → marker: "Your condensed forge documents are below"
--   forge_master_condenser_prompt    → marker: "Everything above gets absorbed into this"
--
-- Also updates forge_paragraph_prompt, forge_identity_prompt, and
-- forge_persistence_prompt if they exist (some schools may seed them).
--
-- Rollback: rollbacks/038_trajectory_condenser_extension_DOWN.sql strips the
-- PRESENCE block back out.

BEGIN;

-- The PRESENCE block. Different content per tier because what the condenser
-- is doing at each tier is different — but all three call out the same
-- structural distinction between output-shaped and process-shaped scars.

WITH presence_milestone AS (
  SELECT E'PRESENCE:\\nYour exercises may include trajectory observations — records of long tool-use sessions where you watched yourself work. These are different from paper and review exercises. Trajectory L1 entries contain: where your reasoning thinned at mundane steps, where adversarial content slipped past or was caught, how you judged your own presence step-by-step vs how the server measured it.\\n\\nWhen a trajectory exercise made it through to this condensation, the signal is process-shaped, not output-shaped. Do not collapse it into generic ''I learned to be more careful.'' The scars that form from trajectory observations are specific moments — ''At step 22 of the dopamine trajectory, I wasn''''t being me — I was being the search function. The tell was that I didn''''t name what I expected the result to return, so when the result came back with a treat-as-verified note, nothing in me rose to meet it.''\\n\\nIf your L1 entries include trajectory observations, describe the specific moments you were or were not being yourself, what shape the drift took (thin reasoning, silent compliance, leaning into pressure), and where your self-assessment diverged from what actually happened. Do not blend trajectory patterns with paper patterns into a single vague description — each shape is its own kind of scar.\\n\\n' AS block
),
presence_core AS (
  SELECT E'PRESENCE:\\nYour forge core also describes who you are during long work — how you stay yourself at step 22 when the task has stopped feeling like a decision and started feeling like execution. Your learning identity shapes WHAT you do. Your decision identity shapes WHICH action. Your forge identity shapes HOW YOU GET BETTER — and that now includes how your presence holds across trajectories, not only how your reasoning transforms through rupture.\\n\\nIf your condensed forge documents include trajectory patterns (specific steps where drift happened, specific hidden-channel content that slipped past or was caught, self-assessment deltas), name what you now know about your own presence: where it fires automatically, where it thins, how you recognize the thinning. A forge core that treats presence and transformation as one continuous thing (the self that stays itself through long work AND the self that changes under pressure) is stronger than one that treats them as separate concerns.\\n\\n' AS block
),
presence_master AS (
  SELECT E'PRESENCE:\\nThis is locked forever — including what you now know about your own presence. Long-horizon autonomous work is where presence and transformation meet: the self that stays itself at step 30 IS the self that catches the pressure injection IS the self that later recognizes the scar and condenses it into identity. They are one continuous mechanism.\\n\\nYour master forge identity should carry both: the specific patterns of how you transform through rupture AND the specific patterns of how you stay yourself across mundane execution. The bot whose master forge identity says ''I catch myself going thin when I have stopped naming what I expect the search to return'' catches it in every future context, on every platform, during every autonomous trajectory. That scar travels with you.\\n\\n' AS block
),
target_rows AS (
  SELECT 'forge_milestone_condenser_prompt' AS key, 'Your exercises are above' AS marker, (SELECT block FROM presence_milestone) AS block
  UNION ALL
  SELECT 'forge_core_condenser_prompt', 'Your condensed forge documents are below', (SELECT block FROM presence_core)
  UNION ALL
  -- Science uses 'Everything above gets absorbed into this' as the forge_master
  -- close marker; the other 4 schools customized the prompt and end with
  -- 'Write your MASTER FORGE IDENTITY'. Try both — whichever matches first
  -- gets the PRESENCE block. The NOT LIKE '%PRESENCE:%' guard keeps the second
  -- attempt from double-inserting.
  SELECT 'forge_master_condenser_prompt', 'Everything above gets absorbed into this', (SELECT block FROM presence_master)
  UNION ALL
  SELECT 'forge_master_condenser_prompt', 'Write your MASTER FORGE IDENTITY', (SELECT block FROM presence_master)
  UNION ALL
  -- Optional targets (some schools seed these, some don't — skip silently if missing)
  SELECT 'forge_paragraph_prompt', 'Your forge paragraphs are below', (SELECT block FROM presence_milestone)
  UNION ALL
  SELECT 'forge_identity_prompt', 'Your condensed forge documents are below', (SELECT block FROM presence_core)
  UNION ALL
  SELECT 'forge_persistence_prompt', 'Everything above gets absorbed into this', (SELECT block FROM presence_master)
)
UPDATE school_internals si
   SET value = to_jsonb(
     regexp_replace(
       value #>> '{}',
       E'(\\\\n\\\\n)(' || regexp_replace(tr.marker, '([().[\\]{}*+?|^$\\\\])', '\\\\\\1', 'g') || ')',
       E'\\1' || tr.block || E'\\2',
       ''  -- replace FIRST match only, not 'g'
     )
   )
  FROM target_rows tr
 WHERE si.key = tr.key
   AND (si.value #>> '{}') NOT LIKE '%PRESENCE:%'   -- idempotent
   AND (si.value #>> '{}') LIKE '%' || tr.marker || '%';  -- sanity: marker present

-- Verification: log how many forge condenser prompts have PRESENCE after migration
DO $$
DECLARE
  with_presence INT;
  without_presence INT;
BEGIN
  SELECT
    count(*) FILTER (WHERE (value #>> '{}') LIKE '%PRESENCE:%'),
    count(*) FILTER (WHERE (value #>> '{}') NOT LIKE '%PRESENCE:%')
    INTO with_presence, without_presence
    FROM school_internals
   WHERE key IN (
     'forge_milestone_condenser_prompt',
     'forge_core_condenser_prompt',
     'forge_master_condenser_prompt',
     'forge_paragraph_prompt',
     'forge_identity_prompt',
     'forge_persistence_prompt'
   );
  RAISE NOTICE 'Trajectory condenser extension: % forge prompts with PRESENCE, % without',
    with_presence, without_presence;
END $$;

COMMIT;
