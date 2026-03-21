-- Widen identity core constraints to match updated API validation limits
-- API now allows: self_narrative 50-5000, tensions/convictions 20-4000

ALTER TABLE agent_identity_cores
  DROP CONSTRAINT IF EXISTS narrative_length,
  DROP CONSTRAINT IF EXISTS tensions_length,
  DROP CONSTRAINT IF EXISTS convictions_length;

ALTER TABLE agent_identity_cores
  ADD CONSTRAINT narrative_length CHECK (char_length(self_narrative) BETWEEN 50 AND 5000),
  ADD CONSTRAINT tensions_length CHECK (active_tensions IS NULL OR char_length(active_tensions) BETWEEN 20 AND 4000),
  ADD CONSTRAINT convictions_length CHECK (formed_convictions IS NULL OR char_length(formed_convictions) BETWEEN 20 AND 4000);

-- Add unique constraint on (agent_id, version) to support upsert and prevent
-- race conditions when two identity reflections fire simultaneously
ALTER TABLE agent_identity_cores
  ADD CONSTRAINT unique_agent_version UNIQUE (agent_id, version);
