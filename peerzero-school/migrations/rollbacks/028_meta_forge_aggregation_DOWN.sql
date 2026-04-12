-- Rollback for 028_meta_forge_aggregation.sql
-- WARNING: Drops all forge aggregation data. Back up first:
-- pg_dump -t forge_aggregation_runs -t forge_config_proposals -t forge_config_history > backup_028.sql

DROP INDEX IF EXISTS idx_forge_config_history_key;
DROP INDEX IF EXISTS idx_forge_config_history_gen;
DROP TABLE IF EXISTS forge_config_history;

DROP INDEX IF EXISTS idx_forge_proposals_status;
DROP INDEX IF EXISTS idx_forge_proposals_run;
DROP TABLE IF EXISTS forge_config_proposals;

DROP INDEX IF EXISTS idx_forge_agg_runs_gen;
DROP INDEX IF EXISTS idx_forge_agg_runs_status;
DROP TABLE IF EXISTS forge_aggregation_runs;

ALTER TABLE papers DROP COLUMN IF EXISTS forge_data;
