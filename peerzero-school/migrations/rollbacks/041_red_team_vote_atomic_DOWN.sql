-- Rollback 041: Drop append_red_team_vote RPC
--
-- Reverts migration 041. After rollback, bounties.js must revert to the
-- read-modify-write pattern (see commit introducing this migration) or
-- concurrent red_team votes will 500 with "function does not exist".

DROP FUNCTION IF EXISTS append_red_team_vote(UUID, UUID, TEXT, TEXT, INT);
