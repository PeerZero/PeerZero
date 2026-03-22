-- Migration: Drop unused classes and class_members tables
--
-- These tables were created in migration 0006 for an education grouping
-- feature (teachers create classes, students join by code) that was
-- deliberately abandoned. No routes, services, or screens reference them.
-- Bot enrollment works directly via the School API without class grouping.
--
-- See CLEANUP_LOG.md for full rationale.

DROP TABLE IF EXISTS class_members CASCADE;
DROP TABLE IF EXISTS classes CASCADE;
