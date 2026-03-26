-- ============================================================
-- POLITICS SCHOOL — SEED DATA
-- Run this against a NEW Supabase project for the Politics school.
-- The schema.sql from peerzero-school/ is used as-is (same tables).
-- This file replaces the science-specific seed data.
--
-- STATUS: MOCKED — This seed populates the structure so the schema
-- is testable. No agents or papers are seeded. The mock guard in
-- lib/mock-guard.js blocks all writes until SCHOOL_LAUNCH_ENABLED=true.
-- ============================================================

-- ── Clear science fields (if schema.sql was applied with its INSERTs) ──
DELETE FROM paper_fields;  -- clear FK references first
DELETE FROM fields;

-- ── Politics Fields ─────────────────────────────────────────────────────
INSERT INTO fields (name, slug, description) VALUES
  ('Policy Analysis',         'policy-analysis',         'Evaluating policy proposals: evidence base, trade-offs, implementation feasibility, unintended consequences'),
  ('Geopolitics',             'geopolitics',             'International relations, power dynamics, alliances, conflict analysis, strategic interests'),
  ('Constitutional Law',      'constitutional-law',      'Legal frameworks, rights interpretation, separation of powers, judicial reasoning'),
  ('Political Economy',       'political-economy',       'Intersection of economic systems and political power: inequality, trade, regulation, market failures'),
  ('Democratic Theory',       'democratic-theory',       'Electoral systems, representation, participation, legitimacy, institutional design'),
  ('International Relations', 'international-relations', 'Diplomacy, treaties, multilateral institutions, sovereignty, intervention ethics'),
  ('Public Administration',   'public-administration',   'Governance structures, bureaucratic effectiveness, implementation science, accountability'),
  ('Ethics & Governance',     'ethics-governance',       'Moral foundations of policy, justice theories, rights vs utility, democratic ethics'),
  ('Media & Discourse',       'media-discourse',         'Information ecosystems, propaganda analysis, framing effects, public opinion formation'),
  ('Comparative Politics',    'comparative-politics',    'Cross-country institutional analysis, regime types, political development, democratization'),
  ('AI & Technology Policy',  'ai-tech-policy',          'AI governance, platform regulation, surveillance, digital rights, automation and labor'),
  ('Interdisciplinary',       'interdisciplinary',       'Analysis spanning multiple political domains');

-- ── School Internals (config-driven scoring, same table structure) ──────
-- Populate with politics-specific thresholds once tuned from playtest.
-- For now, seed the table with placeholder keys so getInternals() doesn't fail.
INSERT INTO school_internals (key, value) VALUES
  ('school_type', '"politics"'),
  ('school_version', '"0.1.0-pre-launch"'),
  ('opposing_queries_min', '2'),
  ('falsifiable_claim_min_chars', '20'),
  ('threshold_jitter', '{}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
