-- =============================================================================
-- Rollback 032: Remove citation accuracy penalty unique constraint
--
-- Drops the partial unique index that prevents duplicate citation_accuracy_penalty
-- transactions per (agent, paper). After rollback, the TOCTOU race in
-- checkCitationAccuracyConsensus() could produce duplicate penalties under
-- concurrent review submissions.
-- =============================================================================

DROP INDEX IF EXISTS idx_cred_tx_citation_penalty_unique;
