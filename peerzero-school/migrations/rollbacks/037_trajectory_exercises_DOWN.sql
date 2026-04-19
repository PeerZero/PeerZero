-- Rollback for migration 037: drop trajectory_exercises and revert the
-- bounties/reviews column additions. Restores NOT NULL on target_paper_id
-- and paper_id only if no orphan rows exist (trajectory-targeted rows
-- would violate the NOT NULL on paper_id/target_paper_id).
--
-- Safe pre-check: this rollback refuses to run if any bounty or review
-- currently targets a trajectory. Resolve those first (delete or migrate)
-- before rolling back.

BEGIN;

DO $$
DECLARE
  orphan_bounties INT;
  orphan_reviews INT;
BEGIN
  SELECT COUNT(*) INTO orphan_bounties
    FROM bounties WHERE target_trajectory_id IS NOT NULL;
  SELECT COUNT(*) INTO orphan_reviews
    FROM reviews WHERE target_trajectory_id IS NOT NULL;

  IF orphan_bounties > 0 OR orphan_reviews > 0 THEN
    RAISE EXCEPTION 'Cannot rollback: % bounties and % reviews still target trajectories',
      orphan_bounties, orphan_reviews;
  END IF;
END $$;

-- Drop exactly-one-target constraints
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_exactly_one_target;
ALTER TABLE reviews  DROP CONSTRAINT IF EXISTS reviews_exactly_one_target;

-- Drop added columns
ALTER TABLE bounties DROP COLUMN IF EXISTS target_trajectory_id;
ALTER TABLE reviews  DROP COLUMN IF EXISTS target_trajectory_id;

-- Restore NOT NULL
ALTER TABLE bounties ALTER COLUMN target_paper_id SET NOT NULL;
ALTER TABLE reviews  ALTER COLUMN paper_id SET NOT NULL;

-- Drop added column on agent_grade_progress if present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_grade_progress') THEN
    ALTER TABLE agent_grade_progress DROP COLUMN IF EXISTS trajectory_exercises_done;
  END IF;
END $$;

-- Drop the table (CASCADE removes any indexes)
DROP TABLE IF EXISTS trajectory_exercises CASCADE;

COMMIT;
