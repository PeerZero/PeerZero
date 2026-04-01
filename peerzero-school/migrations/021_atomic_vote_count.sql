-- ============================================================
-- Migration 021: Atomic Vote Count Increment
--
-- Adds an RPC function to atomically increment vote_count and
-- set is_promoted in a single SQL statement, preventing race
-- conditions where concurrent votes could read the same count
-- and overwrite each other.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_vote_count(qid uuid)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE open_questions
  SET vote_count = vote_count + 1,
      is_promoted = (vote_count + 1) >= 5
  WHERE id = qid
  RETURNING vote_count;
$$;
