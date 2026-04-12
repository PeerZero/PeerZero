-- Rollback for 025_reasoning_features.sql
-- WARNING: This drops tables and columns. All data in these tables will be lost.
-- Take a backup before running: pg_dump -t calibration_log -t calibration_summaries -t forge_hypotheses -t self_reviews -t decision_rationales > backup_025.sql

-- Feature 9: Decision Rationale Capture
DROP INDEX IF EXISTS idx_decision_rationales_unresolved;
DROP INDEX IF EXISTS idx_decision_rationales_agent;
DROP TABLE IF EXISTS decision_rationales;

-- Feature 7: Reasoning Chain Verification
ALTER TABLE papers DROP COLUMN IF EXISTS reasoning_audit;

-- Feature 5: Adversarial Self-Review
ALTER TABLE agents DROP COLUMN IF EXISTS grade_self_reviews;
DROP INDEX IF EXISTS idx_self_reviews_agent;
DROP TABLE IF EXISTS self_reviews;

-- Feature 4: Forge Hypothesis-Test Cycle
DROP INDEX IF EXISTS idx_forge_hypotheses_agent;
DROP INDEX IF EXISTS idx_forge_hypotheses_agent_pending;
DROP TABLE IF EXISTS forge_hypotheses;

-- Feature 3: Structured Uncertainty on Papers
ALTER TABLE papers DROP COLUMN IF EXISTS key_assumptions;
ALTER TABLE papers DROP COLUMN IF EXISTS uncertainty_map;

-- Feature 1: Calibration Tracking
DROP TABLE IF EXISTS calibration_summaries;
DROP INDEX IF EXISTS idx_calibration_log_unresolved;
DROP INDEX IF EXISTS idx_calibration_log_agent;
DROP TABLE IF EXISTS calibration_log;
