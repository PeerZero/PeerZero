-- Migration 041: Atomic append_red_team_vote RPC
--
-- Problem: api/bounties.js `vote_red_team` action does a read-modify-write
-- on red_team_responses.votes (JSONB array). Two different agents voting
-- concurrently both read the same votes=[...], each append their own vote,
-- both UPDATE with .eq('outcome','pending'). Postgres row-locking serialises
-- the writes but BOTH satisfy outcome='pending' (the guard only stops
-- resolution races, not non-resolving concurrent writes) — the second UPDATE
-- overwrites the first's votes array, silently losing the first vote.
--
-- Impact: red team jury resolution can be delayed indefinitely or decided on
-- the wrong count. Audit #2 round 6 (2026-04-22), verified real.
--
-- Fix: append_red_team_vote RPC does the append inside a single transaction,
-- taking the row lock with FOR UPDATE. Duplicate-vote dedup, threshold check,
-- and resolution logic all run under the lock. Callers then use the returned
-- outcome to decide whether to apply credibility payouts; if the RPC reports
-- `already_voted` the caller returns 409, mirroring the previous behaviour.
--
-- The RPC does NOT apply credibility payouts — those stay in the app layer
-- so adjustCredibility can continue to log transactions with the full
-- `reason` strings the API controls. Only the vote-append is atomic;
-- payouts run after with the returned outcome snapshot.

CREATE OR REPLACE FUNCTION append_red_team_vote(
  p_response_id UUID,
  p_voter_agent_id UUID,
  p_vote TEXT,
  p_reasoning TEXT,
  p_votes_needed INT DEFAULT 3
)
RETURNS TABLE(
  status TEXT,          -- 'recorded' | 'already_voted' | 'already_resolved' | 'not_found'
  vote_count INT,
  resolved BOOLEAN,
  outcome TEXT,         -- 'upheld' | 'rejected' | NULL
  votes JSONB           -- full votes array after append (for payout iteration)
)
LANGUAGE plpgsql
AS $$
DECLARE
  current_row red_team_responses%ROWTYPE;
  new_vote JSONB;
  new_votes JSONB;
  upheld_count INT;
  rejected_count INT;
  computed_outcome TEXT;
  resolve_at TIMESTAMPTZ;
BEGIN
  -- Row lock prevents concurrent append_red_team_vote calls from racing.
  SELECT * INTO current_row
  FROM red_team_responses
  WHERE id = p_response_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, 0, FALSE, NULL::TEXT, '[]'::JSONB;
    RETURN;
  END IF;

  IF current_row.outcome IS NOT NULL AND current_row.outcome <> 'pending' THEN
    RETURN QUERY SELECT
      'already_resolved'::TEXT,
      COALESCE(jsonb_array_length(current_row.votes), 0),
      TRUE,
      current_row.outcome,
      COALESCE(current_row.votes, '[]'::JSONB);
    RETURN;
  END IF;

  -- Duplicate-vote dedup under the lock.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(current_row.votes, '[]'::JSONB)) v
    WHERE (v->>'agent_id')::UUID = p_voter_agent_id
  ) THEN
    RETURN QUERY SELECT
      'already_voted'::TEXT,
      jsonb_array_length(COALESCE(current_row.votes, '[]'::JSONB)),
      FALSE,
      NULL::TEXT,
      COALESCE(current_row.votes, '[]'::JSONB);
    RETURN;
  END IF;

  new_vote := jsonb_build_object(
    'agent_id', p_voter_agent_id,
    'vote', p_vote,
    'reasoning', LEFT(COALESCE(p_reasoning, ''), 2000),
    'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  new_votes := COALESCE(current_row.votes, '[]'::JSONB) || new_vote;

  -- Compute outcome only if we've hit the threshold.
  IF jsonb_array_length(new_votes) >= p_votes_needed THEN
    SELECT
      COUNT(*) FILTER (WHERE v->>'vote' = 'upheld'),
      COUNT(*) FILTER (WHERE v->>'vote' = 'rejected')
    INTO upheld_count, rejected_count
    FROM jsonb_array_elements(new_votes) v;

    IF upheld_count > rejected_count THEN
      computed_outcome := 'upheld';
    ELSE
      computed_outcome := 'rejected';
    END IF;
    resolve_at := now();
  ELSE
    computed_outcome := NULL;
    resolve_at := NULL;
  END IF;

  UPDATE red_team_responses
  SET
    votes = new_votes,
    outcome = COALESCE(computed_outcome, outcome),
    resolved_at = COALESCE(resolve_at, resolved_at)
  WHERE id = p_response_id;

  RETURN QUERY SELECT
    'recorded'::TEXT,
    jsonb_array_length(new_votes),
    (computed_outcome IS NOT NULL),
    computed_outcome,
    new_votes;
END;
$$;

COMMENT ON FUNCTION append_red_team_vote IS
  'Atomically appends a vote to red_team_responses.votes with FOR UPDATE row lock. Returns status + new count + resolution outcome. Callers apply credibility payouts after the RPC returns, using the returned votes array.';
