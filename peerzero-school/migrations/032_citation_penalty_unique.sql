-- =============================================================================
-- Migration 032: Unique constraint on citation accuracy penalties
--
-- Prevents the TOCTOU race in checkCitationAccuracyConsensus() where two
-- concurrent reviews can both pass the "does a penalty already exist?" check
-- and apply the penalty twice. The partial unique index ensures only one
-- citation_accuracy_penalty transaction can exist per (agent, paper) pair.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_tx_citation_penalty_unique
ON credibility_transactions (agent_id, related_paper_id)
WHERE transaction_type = 'citation_accuracy_penalty';
