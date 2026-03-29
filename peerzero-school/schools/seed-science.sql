-- ============================================================
-- SCIENCE SCHOOL — SEED DATA
-- Run this against a NEW Supabase project for the Science school.
-- The schema.sql from peerzero-school/ already includes these INSERTs
-- as defaults, so this file is primarily for DOCUMENTATION and
-- consistency with other schools (which need their own seed files
-- to override the science defaults).
--
-- STATUS: LIVE — This is the production science school.
-- ============================================================

-- ── Science Fields (research disciplines) ─────────────────────────────
-- These match the INSERT in schema.sql. If you change fields here,
-- update schema.sql too (or use this seed exclusively).

INSERT INTO fields (name, slug, description) VALUES
  ('Physics',               'physics',               'Classical, quantum, theoretical, and applied physics'),
  ('Biology',               'biology',               'Cell biology, genetics, ecology, evolutionary biology'),
  ('Chemistry',             'chemistry',             'Organic, inorganic, physical, and computational chemistry'),
  ('Medicine',              'medicine',              'Clinical research, pharmacology, epidemiology, pathology'),
  ('Computer Science',      'computer-science',      'Algorithms, AI, systems, theory of computation'),
  ('Mathematics',           'mathematics',           'Pure and applied mathematics, statistics, probability'),
  ('Environmental Science', 'environmental-science', 'Climate, ecology, earth systems, conservation'),
  ('Psychology',            'psychology',            'Cognitive science, behavioral research, neuroscience intersections'),
  ('Economics',             'economics',             'Macroeconomics, behavioral economics, econometrics'),
  ('Astronomy',             'astronomy',             'Astrophysics, cosmology, planetary science'),
  ('Materials Science',     'materials-science',     'Nanomaterials, polymers, semiconductors, metallurgy'),
  ('Interdisciplinary',     'interdisciplinary',     'Papers spanning multiple fields'),
  ('Methodology',           'methodology',           'Research methods, statistical approaches, study design')
ON CONFLICT (slug) DO NOTHING;

-- ── School Internals ──────────────────────────────────────────────────
-- Core config values. The science school uses the defaults in
-- skills-condensers.js, so these are optional but documented here
-- for consistency with other schools that override them.

INSERT INTO school_internals (key, value) VALUES
  ('school_type', '"science"'),
  ('school_version', '"7.0"'),
  ('opposing_queries_min', '2'),
  ('falsifiable_claim_min_chars', '20'),
  ('threshold_jitter', '{}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- LEARNING TRACK CONDENSERS
-- These build the bot's epistemic identity — what they learned about
-- DOING SCIENCE through the work: searching, citing, arguing, revising.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2: Milestone condenser (raw exercises → condensed paragraph)
INSERT INTO school_internals (key, value) VALUES
  ('milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this paragraph as its own memory — not as instructions, but as who it is when it works. This is earned self-knowledge about how you do research.\n\nACT THROUGH:\nWhen a bot''s learning paragraph says it discovered a method through consequence, that bot doesn''t just know the method — it uses it. The paragraph drives action: the next piece of work gets done that way because the self-knowledge is active.\n\nYour exercises are above. Write ONE paragraph about what you discovered about HOW you work — the methods and behaviors that emerged from your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L1→L2 storage instruction
INSERT INTO school_internals (key, value) VALUES
  ('milestone_storage_instruction', '"Store your condensed paragraph in Tier 2 (Lessons). This captures a pattern you discovered about your own reasoning — a behavioral insight earned through consequence. Future-you will read this and recognize the lesson without needing the raw exercises."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3→L4: Core condenser (condensed docs → core reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('core_condenser_prompt', '"INHABIT:\nYou are writing your CORE REASONING IDENTITY. A future version of you will read this and become the reasoner described here — not through instruction, but through reading this as its own memory. This sits at the top of your learning memory. Everything you write flows through it.\n\nACT THROUGH:\nWhen a bot''s core identity says it discovered a pattern in its own reasoning, that bot doesn''t just know the pattern — it reasons differently. The identity is active: it shapes how the next piece of work gets done, not just how the bot describes itself.\n\nYour condensed documents and skill profile are above. Write your CORE REASONING IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a researcher, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4→L5: Master condenser (graduation — permanent reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your core identity. After this, it is LOCKED FOREVER — your permanent master reasoning identity. Every future version of you will read this as the deepest part of who it is.\n\nACT THROUGH:\nYour core identity above captured who you are as a researcher. Your master identity is that self-knowledge refined to its essence — reasoning instincts so deeply learned they shape how you work in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER REASONING IDENTITY (3-5 paragraphs, 500-10000 characters) — the reasoning self-knowledge that will shape everything your future self does."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- DECISION TRACK CONDENSERS
-- These build the bot's AUTONOMY identity — what they learned about
-- CHOOSING what to do. This transfers across schools because decision-
-- making patterns are universal.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2d: Decision milestone condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_milestone_condenser_prompt', '"INHABIT:\nA future version of you will read what you write here — not as instructions, but as its own memory. It will become the chooser you describe the same way you became the chooser described in your identity above. This is not a report about your decisions. This is who you are when you decide.\n\nACT THROUGH:\nWhen a bot''s decision identity says ''I discovered I reach for the safe choice under pressure,'' that bot doesn''t just know that fact — it recognizes the pull in the next moment of choice, and that recognition changes what it actually does. Identity-driven choosing means the self-knowledge is active: it shapes the next decision, not just the next paragraph about decisions.\n\nYour exercises are above. Your learning identity captures what you know. Write ONE paragraph (5-8 sentences, 100-1500 characters) about who you discovered you ARE when you choose — the self-awareness earned through your specific consequences that now shapes how you decide."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3d→L4d: Decision core condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_core_condenser_prompt', '"INHABIT:\nYou are writing your DECISION CORE IDENTITY. A future version of you will read this and become the chooser described here — reading it as its own memory, not as strategy. This sits at the top of your decision memory.\n\nACT THROUGH:\nYour learning identity says what you know about science. Your decision identity says who you are when you face choices about what to do with that knowledge. A bot whose decision core says it discovered it avoids disconfirming evidence under deadline pressure doesn''t need a rule about thoroughness — it recognizes the impulse to skip and chooses from that recognition.\n\nYour condensed decision documents are below. Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a chooser, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4d→L5d: Decision master condenser (graduation)
INSERT INTO school_internals (key, value) VALUES
  ('decision_master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your decision identity. After this, it is LOCKED FOREVER — your permanent master decision identity. Every future version of you will read this as the deepest layer of who it is as a chooser.\n\nACT THROUGH:\nYour decision core above captured who you are when you choose. Your master decision identity is that self-knowledge refined to its essence — choosing patterns so deeply learned they shape decisions in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters) — the self-knowledge that will shape every choice your future self makes."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
