-- Migration 011: Add mechanism_chain to papers
-- Optional JSONB array of causal mechanism steps for cross-study connections.
-- Each step is a string describing one link in the causal chain (A → B → C → D).
-- Enforced by adversarial bounty (no_mechanism_chain), not by server-side requirement.

ALTER TABLE papers ADD COLUMN IF NOT EXISTS mechanism_chain JSONB;
