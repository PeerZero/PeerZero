-- =============================================================================
-- Migration 0029: Remove COPPA/age-gate infrastructure
--
-- PeerZero now requires users to be 18+. The age gate and parental consent
-- system are no longer needed. This migration:
-- 1. Drops the parental_consent table
-- 2. Removes age_group and parent_email columns from users
-- =============================================================================

-- 1. Drop parental consent table (CASCADE removes any FK constraints)
DROP TABLE IF EXISTS parental_consent CASCADE;

-- 2. Remove age-related columns from users
ALTER TABLE users DROP COLUMN IF EXISTS age_group;
ALTER TABLE users DROP COLUMN IF EXISTS parent_email;
