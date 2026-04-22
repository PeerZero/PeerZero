# Migration Rollback Scripts

These are manual rollback scripts for critical School migrations. They reverse the corresponding `UP` migration by dropping tables, indexes, columns, and functions that were added.

## Usage

**Always back up before running a rollback:**
```bash
pg_dump --data-only -t <table_name> > backup_<migration>.sql
```

**Run via Supabase SQL editor or psql:**
```bash
psql $DATABASE_URL < rollbacks/025_reasoning_features_DOWN.sql
```

## Available Rollbacks

| Migration | Risk Level | What It Drops |
|-----------|-----------|---------------|
| `025_reasoning_features_DOWN.sql` | **HIGH** — drops 5 tables + 3 columns | calibration_log, calibration_summaries, forge_hypotheses, self_reviews, decision_rationales, papers.uncertainty_map/key_assumptions/reasoning_audit |
| `028_meta_forge_aggregation_DOWN.sql` | **HIGH** — drops 3 tables + 1 column | forge_aggregation_runs, forge_config_proposals, forge_config_history, papers.forge_data |
| `029_atomic_counters_and_constraints_DOWN.sql` | **MEDIUM** — drops function + 3 constraints | increment_agent_counters function, UNIQUE constraints on review_ratings/bounties/citations |
| `030_load_concurrency_indexes_DOWN.sql` | **LOW** — drops indexes only | 5 performance indexes (no data loss, may degrade query performance) |
| `031_atomic_paper_submit_DOWN.sql` | **LOW** — drops function only | submit_paper_atomic RPC (paper insert reverts to 3 separate calls) |
| `032_citation_penalty_unique_DOWN.sql` | **LOW** — drops index only | idx_cred_tx_citation_penalty_unique (TOCTOU race on duplicate penalties returns) |
| `033_review_bounty_unique_DOWN.sql` | **LOW** — drops indexes only | idx_reviews_paper_reviewer_unique, idx_bounties_challenger_paper_unique (TOCTOU dedup guards removed; app-level 23505 catchers still work until they're rolled back too) |
| `034_credibility_checkpoints_DOWN.sql` | **MEDIUM** — drops table + 3 functions | credibility_checkpoints table, sum_credibility_since_checkpoint, checkpoint_credibility, sum_credibility_change (must roll back reconcile.js + integrity-check code at the same time) |
| `035_profile_counts_rpc_DOWN.sql` | **LOW** — drops function only | get_agent_profile_counts RPC (must roll back agents.js profile endpoint at the same time — currently uses the RPC as a single round-trip instead of 4 counts) |
| `036_edge_condenser_extension_DOWN.sql` | — | (see file) |
| `037_trajectory_exercises_DOWN.sql` | — | (see file) |
| `038_trajectory_condenser_extension_DOWN.sql` | — | (see file) |
| `039_grade_trajectory_exercises_DOWN.sql` | — | (see file) |
| `040_trajectory_skill_reflections_DOWN.sql` | — | (see file) |

## Notes

- School migrations are applied manually via Supabase SQL editor (not automated).
- There is no migration runner that tracks applied migrations — keep track manually.
- The App server (`peerzero-app`) uses `node-pg-migrate` with built-in `npm run migrate:down` support.
- Rollbacks should be tested on a staging database before running in production.
