-- =============================================================================
-- 0017: Add language preference to users
-- Default 'en' (English). Uses IETF BCP 47 language tags (e.g., 'en', 'es', 'fr', 'de', 'ja').
-- =============================================================================

ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
