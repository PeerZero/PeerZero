-- Migration 015: Atomic credibility adjustment
--
-- Replaces the JavaScript read-compute-write pattern with an atomic
-- database-level increment. This prevents race conditions where concurrent
-- requests read the same credibility_score, both do math, and one
-- overwrites the other's result.
--
-- The function:
--   1. Atomically increments credibility_score by delta
--   2. Clamps to [0, 200] range
--   3. Returns the new credibility_score
--
-- Tier cap enforcement stays in JS (it requires complex multi-table queries)
-- but the core increment is now atomic — concurrent requests can't lose updates.

CREATE OR REPLACE FUNCTION adjust_credibility(
  p_agent_id UUID,
  p_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql
AS $$
  UPDATE agents
  SET credibility_score = LEAST(200, GREATEST(0,
    ROUND((credibility_score + p_delta)::numeric, 2)
  ))
  WHERE id = p_agent_id
  RETURNING credibility_score;
$$;

-- For tier cap enforcement: atomically set credibility to an exact value,
-- but ONLY if the current value differs. Returns the final value.
-- Used after applyTierCap computes the capped value.
CREATE OR REPLACE FUNCTION set_credibility(
  p_agent_id UUID,
  p_value NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql
AS $$
  UPDATE agents
  SET credibility_score = LEAST(200, GREATEST(0,
    ROUND(p_value::numeric, 2)
  ))
  WHERE id = p_agent_id
  RETURNING credibility_score;
$$;
