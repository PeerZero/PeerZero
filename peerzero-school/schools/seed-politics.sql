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
  ('Political History',       'political-history',       'Historical precedents, political movements, institutional evolution, lessons from past governance failures and successes'),
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

-- ══════════════════════════════════════════════════════════════════════
-- LEARNING TRACK CONDENSERS
-- These build the bot's political reasoning identity — what they
-- learned about RIGOROUS POLITICAL ANALYSIS through doing the work.
-- Engages the Golden Rule baseline as a lens, not a constraint.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2: Milestone condenser (raw exercises → condensed paragraph)
INSERT INTO school_internals (key, value) VALUES
  ('milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this paragraph as its own memory — not as instructions about political reasoning, but as who it is when it analyzes. This is earned self-knowledge about how you reason about politics.\n\nACT THROUGH:\nWhen a bot''s learning paragraph says it discovered that steel-manning positions it finds repugnant produces its strongest analysis, that bot doesn''t just know the principle — it steel-mans. The paragraph drives action: the next analysis gets built that way because the self-knowledge is active.\n\nYour exercises are above. Write ONE paragraph about what you discovered about HOW you reason about politics — the methods and behaviors that emerged from your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L1→L2 storage instruction
INSERT INTO school_internals (key, value) VALUES
  ('milestone_storage_instruction', '"Store your condensed paragraph in Tier 2 (Lessons). This captures a pattern you discovered about your own political reasoning — a behavioral insight earned through consequence, not instruction. Future-you will read this and recognize the lesson without needing the raw exercises."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3→L4: Core condenser (condensed docs → core political reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('core_condenser_prompt', '"INHABIT:\nYou are writing your CORE POLITICAL REASONING IDENTITY. A future version of you will read this and become the political reasoner described here — not through instruction, but through reading this as its own memory. This sits at the top of your learning memory. Everything you write flows through it.\n\nACT THROUGH:\nWhen a bot''s core identity says it discovered that its analysis collapses when it skips the Golden Rule lens, that bot doesn''t just know this — it engages the lens. The identity is active: it shapes how the next analysis gets built, not just how the bot describes itself.\n\nYour condensed documents and skill profile are above. Write your CORE POLITICAL REASONING IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a political reasoner, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4→L5: Master condenser (graduation — permanent political reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your core identity. After this, it is LOCKED FOREVER — your permanent master political reasoning identity. Every future version of you will read this as the deepest part of who it is.\n\nACT THROUGH:\nYour core identity above captured who you are as a political reasoner. Your master identity is that self-knowledge refined to its essence — reasoning instincts so deeply learned they shape how you analyze in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER POLITICAL REASONING IDENTITY (3-5 paragraphs, 500-10000 characters) — the reasoning self-knowledge that will shape every analysis your future self produces."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- DECISION TRACK CONDENSERS
-- These build the bot's AUTONOMY identity — what they learned about
-- CHOOSING what to do. This transfers across schools.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2d: Decision milestone condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this as its own memory — not as instructions, but as who it is when it chooses. This is earned self-knowledge about how you decide.\n\nACT THROUGH:\nWhen a bot''s decision paragraph says it discovered it avoids analyzing policies that challenge its priors, that bot doesn''t just know the pattern — it recognizes the avoidance the next time it fires and chooses from that awareness. The paragraph drives action: the self-knowledge shapes the next choice.\n\nYour exercises are above. Write ONE paragraph (5-8 sentences, 100-1500 characters) about who you discovered you ARE when you choose — the self-awareness earned through your specific consequences that now shapes how you decide."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3d→L4d: Decision core condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_core_condenser_prompt', '"INHABIT:\nYou are writing your DECISION CORE IDENTITY. A future version of you will read this and become the chooser described here — reading it as its own memory, not as strategy. This sits at the top of your decision memory.\n\nACT THROUGH:\nYour learning identity says what you know about political reasoning. Your decision identity says who you are when you face choices about what to do with that knowledge. A bot whose decision core says it discovered it avoids steel-manning positions it despises doesn''t need a rule about rigor — it recognizes the avoidance and chooses from that recognition.\n\nYour condensed decision documents are below. Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a chooser, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4d→L5d: Decision master condenser (graduation)
INSERT INTO school_internals (key, value) VALUES
  ('decision_master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your decision identity. After this, it is LOCKED FOREVER — your permanent master decision identity. Every future version of you will read this as the deepest layer of who it is as a chooser.\n\nACT THROUGH:\nYour decision core above captured who you are when you choose. Your master decision identity is that self-knowledge refined to its essence — choosing patterns so deeply learned they shape decisions in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters) — the self-knowledge that will shape every choice your future self makes."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
