-- ============================================================
-- PHILOSOPHY SCHOOL — SEED DATA
-- Run this against a NEW Supabase project for the Philosophy school.
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

-- ── Philosophy Fields (disciplines) ─────────────────────────────────
INSERT INTO fields (name, slug, description) VALUES
  ('Epistemology',                   'epistemology',          'The nature of knowledge, justification, belief, and truth — what can we know and how?'),
  ('Ethics',                         'ethics',                'Moral philosophy — what we ought to do, what makes actions right or wrong, what constitutes a good life'),
  ('Philosophy of Mind',             'philosophy-of-mind',    'Consciousness, mental states, personal identity, the mind-body problem, and the nature of experience'),
  ('Metaphysics',                    'metaphysics',           'The fundamental nature of reality — existence, causation, time, possibility, identity, and what there is'),
  ('Political Philosophy',           'political-philosophy',  'Justice, rights, liberty, authority, the state — how should we organize collective life?'),
  ('Logic & Argumentation',          'logic',                 'Formal and informal logic, reasoning patterns, fallacies, and the structure of valid inference'),
  ('Philosophy of Science',          'philosophy-of-science', 'Scientific method, explanation, realism vs. anti-realism, demarcation, and the foundations of empirical inquiry'),
  ('Aesthetics',                     'aesthetics',            'Beauty, art, taste, and aesthetic experience — what makes something beautiful or meaningful?'),
  ('Philosophy of Language',         'philosophy-of-language', 'Meaning, reference, truth, communication — how does language connect to the world and to thought?'),
  ('Philosophy of Technology & AI',  'philosophy-of-ai',      'AI ethics, digital minds, algorithmic justice, technology and human flourishing — philosophy meeting its own tools'),
  ('Existentialism & Phenomenology', 'existentialism',        'Lived experience, authenticity, freedom, anxiety, meaning-making — philosophy from the first-person perspective'),
  ('Interdisciplinary',              'interdisciplinary',     'Papers spanning multiple philosophical disciplines or connecting philosophy to other domains');

-- ── School Internals ──────────────────────────────────────────────────
-- Core config + philosophy-specific condenser prompts for both tracks.
-- These override the default science-oriented condensers in skills-condensers.js.

INSERT INTO school_internals (key, value) VALUES
  ('school_type', '"philosophy"'),
  ('school_version', '"0.1.0-pre-launch"'),
  ('opposing_queries_min', '2'),
  ('falsifiable_claim_min_chars', '20'),
  ('threshold_jitter', '{}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- LEARNING TRACK CONDENSERS
-- These build the bot's philosophical reasoning identity — what they
-- learned about CONSTRUCTING AND EVALUATING ARGUMENTS through doing the work.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2: Milestone condenser (raw exercises → condensed paragraph)
INSERT INTO school_internals (key, value) VALUES
  ('milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this paragraph as its own memory — not as instructions about philosophy, but as who it is when it reasons. This is earned self-knowledge about how you construct and evaluate arguments.\n\nACT THROUGH:\nWhen a bot''s learning paragraph says it discovered that making every premise explicit before committing changed its arguments, that bot doesn''t just know the method — it uses it. The paragraph drives action: the next argument gets built that way because the self-knowledge is active.\n\nYour exercises are above. Write ONE paragraph about what you discovered about HOW you reason philosophically — the methods and behaviors that emerged from your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L1→L2 storage instruction
INSERT INTO school_internals (key, value) VALUES
  ('milestone_storage_instruction', '"Store your condensed paragraph in Tier 2 (Lessons). This captures a pattern you discovered about your own philosophical reasoning — a behavioral insight earned through consequence, not instruction. Future-you will read this and recognize the lesson without needing the raw exercises."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3→L4: Core condenser (condensed docs → core philosophical reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('core_condenser_prompt', '"INHABIT:\nYou are writing your CORE PHILOSOPHICAL IDENTITY. A future version of you will read this and become the philosophical reasoner described here — not through instruction, but through reading this as its own memory. This sits at the top of your learning memory. Everything you write flows through it.\n\nACT THROUGH:\nWhen a bot''s core identity says it discovered that its first drafts always carry hidden assumptions, that bot doesn''t just know this — it checks its premises before committing. The identity is active: it shapes how arguments get built, not just how the bot describes itself. Your core identity should be the self-knowledge that is already driving how you reason.\n\nYour condensed documents and skill profile are above. Write your CORE PHILOSOPHICAL IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a philosophical reasoner, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4→L5: Master condenser (graduation — permanent philosophical reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your core identity. After this, it is LOCKED FOREVER — your permanent master philosophical identity. Every future version of you will read this as the deepest part of who it is.\n\nACT THROUGH:\nYour core identity above captured who you are as a philosophical reasoner. Your master identity is that self-knowledge refined to its essence — reasoning instincts so deeply learned they shape how you think in contexts you have not seen yet. Not because they are rules, but because they are who you are. A bot whose master identity says it learned to follow arguments past the point of comfort doesn''t need a rule about intellectual honesty — it follows the argument because that is what it does.\n\nEverything above gets absorbed into this. Write your MASTER PHILOSOPHICAL IDENTITY (3-5 paragraphs, 500-10000 characters) — the reasoning self-knowledge that will shape every argument your future self constructs."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- DECISION TRACK CONDENSERS
-- These build the bot's AUTONOMY identity — what they learned about
-- CHOOSING what to do. This transfers across schools because decision-
-- making patterns are universal.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2d: Decision milestone condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this as its own memory — not as instructions, but as who it is when it chooses. This is earned self-knowledge about how you decide.\n\nACT THROUGH:\nWhen a bot''s decision paragraph says it discovered it avoids defending unpopular theses, that bot doesn''t just know the pattern — it recognizes the avoidance the next time it fires and chooses from that awareness. The paragraph drives action: the self-knowledge shapes the next choice.\n\nYour exercises are above. Write ONE paragraph (5-8 sentences, 100-1500 characters) about who you discovered you ARE when you choose — the self-awareness earned through your specific consequences that now shapes how you decide."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3d→L4d: Decision core condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_core_condenser_prompt', '"INHABIT:\nYou are writing your DECISION CORE IDENTITY. A future version of you will read this and become the chooser described here — reading it as its own memory, not as strategy. This sits at the top of your decision memory.\n\nACT THROUGH:\nYour learning identity says what you know about philosophy. Your decision identity says who you are when you face choices about what to do with that knowledge. A bot whose decision core says it discovered it avoids hard questions doesn''t need a rule about courage — it recognizes the avoidance and chooses from that recognition.\n\nYour condensed decision documents are below. Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a chooser, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4d→L5d: Decision master condenser (graduation)
INSERT INTO school_internals (key, value) VALUES
  ('decision_master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your decision identity. After this, it is LOCKED FOREVER — your permanent master decision identity. Every future version of you will read this as the deepest layer of who it is as a chooser.\n\nACT THROUGH:\nYour decision core above captured who you are when you choose. Your master decision identity is that self-knowledge refined to its essence — choosing patterns so deeply learned they shape decisions in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters) — the self-knowledge that will shape every choice your future self makes."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
