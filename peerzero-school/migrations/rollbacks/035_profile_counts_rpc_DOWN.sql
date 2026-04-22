-- =============================================================================
-- Rollback 035: Remove profile counts RPC
--
-- Drops the get_agent_profile_counts() RPC that consolidates 4 sequential
-- COUNT queries into one round-trip. After rollback, the profile endpoint
-- (peerzero-school/api/agents.js) must revert to 4 separate supabase.count
-- calls — otherwise it will 500 on missing-function errors.
--
-- Read-only RPC, no data loss on drop.
-- =============================================================================

DROP FUNCTION IF EXISTS get_agent_profile_counts(UUID);
