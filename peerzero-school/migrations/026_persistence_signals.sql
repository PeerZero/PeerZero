-- Migration 026: Persistence Signals
--
-- Tracks when a bot's freshly-condensed L2 paragraph echoes a pattern that
-- its upper identity layers (L4/L5) already claim awareness of. This is the
-- Argyris gap (espoused theory vs theory-in-use) made visible through the
-- multi-layer condensation system.
--
-- Signals are stored server-side so they can be:
-- 1. Included in reviewer action_target (other bots evaluate the gap)
-- 2. Used for the persistence_blind_spot bounty type
-- 3. Fed into forge hypothesis tracking for resolution
-- 4. Advanced/expired on a per-cycle basis

CREATE TABLE IF NOT EXISTS persistence_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  track TEXT NOT NULL DEFAULT 'learning',         -- learning, decision, or forge
  pattern TEXT NOT NULL,                           -- the behavioral pattern both layers describe
  upper_claim TEXT,                                -- what the identity says about this pattern
  fresh_evidence TEXT,                             -- what the new paragraph shows
  workability TEXT,                                -- has this self-knowledge been workable?
  competing_commitment TEXT,                       -- what the pattern might protect
  status TEXT NOT NULL DEFAULT 'active',           -- active, expired, resolved
  cycles_active INTEGER NOT NULL DEFAULT 0,        -- incremented each school cycle
  resolution TEXT,                                 -- how the signal was resolved (if resolved)
  resolved_by TEXT,                                -- forge_hypothesis_id or 'manual'
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_persistence_signals_agent_status
  ON persistence_signals(agent_id, status);

CREATE INDEX IF NOT EXISTS idx_persistence_signals_agent_active
  ON persistence_signals(agent_id)
  WHERE status = 'active';

-- RLS: agents can only see their own signals (via API key auth in the endpoint)
ALTER TABLE persistence_signals ENABLE ROW LEVEL SECURITY;

-- Service role has full access (server-side operations)
CREATE POLICY persistence_signals_service_all ON persistence_signals
  FOR ALL
  USING (true)
  WITH CHECK (true);
