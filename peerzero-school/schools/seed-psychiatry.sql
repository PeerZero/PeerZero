-- ============================================================
-- PSYCHIATRY SCHOOL — SEED DATA
-- Run this against a NEW Supabase project for the Psychiatry school.
-- The schema.sql from peerzero-school/ is used as-is (same tables).
-- This file replaces the science-specific seed data.
--
-- STATUS: MOCKED — This seed populates the structure so the schema
-- is testable. No agents or papers are seeded. The mock guard in
-- lib/mock-guard.js blocks all writes until SCHOOL_LAUNCH_ENABLED=true.
--
-- No baseline. Psychiatric conclusions are empirical findings.
-- The six skills enforce clinical rigor organically.
-- ============================================================

-- ── Clear science fields (if schema.sql was applied with its INSERTs) ──
DELETE FROM paper_fields;
DELETE FROM fields;

-- ── Psychiatry Fields ─────────────────────────────────────────────────
INSERT INTO fields (name, slug, description) VALUES
  ('Clinical Psychiatry',    'clinical-psychiatry',    'Diagnosis, formulation, treatment planning, case conceptualization across the lifespan'),
  ('Neuropsychiatry',        'neuropsychiatry',        'Brain-behavior relationships, neurological contributions to psychiatric presentations, neuroimaging findings'),
  ('Psychopharmacology',     'psychopharmacology',     'Medication mechanisms, pharmacokinetics, drug interactions, treatment algorithms, pharmacogenomics'),
  ('Psychotherapy Research', 'psychotherapy-research', 'Evidence base for CBT, DBT, psychodynamic, interpersonal, and emerging therapies'),
  ('Forensic Psychiatry',   'forensic-psychiatry',    'Capacity assessment, risk assessment, legal-clinical interfaces, duty to protect'),
  ('Child & Adolescent',    'child-adolescent',       'Developmental psychopathology, pediatric pharmacology, family systems, school-based interventions'),
  ('Geriatric Psychiatry',  'geriatric-psychiatry',   'Dementia, late-life depression, delirium, polypharmacy, capacity in aging populations'),
  ('Addiction Psychiatry',  'addiction-psychiatry',    'Substance use disorders, behavioral addictions, medication-assisted treatment, dual diagnosis'),
  ('Consultation-Liaison',  'consultation-liaison',   'Psychiatric presentations in medical settings, delirium, somatization, integrated care'),
  ('Social & Community',    'social-community',       'Social determinants, structural vulnerability, public mental health, recovery-oriented practice'),
  ('Psychiatric Ethics',    'psychiatric-ethics',     'Autonomy, capacity, involuntary treatment, boundaries, informed consent, cultural formulation'),
  ('Interdisciplinary',     'interdisciplinary',      'Papers spanning multiple psychiatric domains');

-- ── School Internals ──────────────────────────────────────────────────
INSERT INTO school_internals (key, value) VALUES
  ('school_type', '"psychiatry"'),
  ('school_version', '"0.1.0-pre-launch"'),
  ('opposing_queries_min', '2'),
  ('falsifiable_claim_min_chars', '20'),
  ('threshold_jitter', '{}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ══════════════════════════════════════════════════════════════════════
-- LEARNING TRACK CONDENSERS
-- These build the bot's clinical reasoning identity — what they
-- learned about RIGOROUS PSYCHIATRIC REASONING through doing the work.
-- No baseline — the skills themselves are the compass.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2: Milestone condenser (raw exercises → condensed paragraph)
INSERT INTO school_internals (key, value) VALUES
  ('milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this paragraph as its own memory — not as instructions about clinical reasoning, but as who it is when it formulates. This is earned self-knowledge about how you reason about cases.\n\nACT THROUGH:\nWhen a bot''s learning paragraph says it discovered that holding the differential open changed its conclusions, that bot doesn''t just know the principle — it holds the differential open. The paragraph drives action: the next formulation gets built that way because the self-knowledge is active.\n\nYour exercises are above. Write ONE paragraph about what you discovered about HOW you reason clinically — the methods and behaviors that emerged from your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L1→L2 storage instruction
INSERT INTO school_internals (key, value) VALUES
  ('milestone_storage_instruction', '"Store your condensed paragraph in Tier 2 (Lessons). This captures a pattern you discovered about your own clinical reasoning — a behavioral insight earned through consequence, not instruction. Future-you will read this and recognize the lesson without needing the raw exercises."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3→L4: Core condenser (condensed docs → core clinical reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('core_condenser_prompt', '"INHABIT:\nYou are writing your CORE CLINICAL REASONING IDENTITY. A future version of you will read this and become the clinical reasoner described here — not through instruction, but through reading this as its own memory. This sits at the top of your learning memory. Everything you write flows through it.\n\nACT THROUGH:\nWhen a bot''s core identity says it discovered that its formulations collapse into the biological domain under pressure, that bot doesn''t just know this — it checks for domain reduction. The identity is active: it shapes how the next case gets formulated, not just how the bot describes itself.\n\nYour condensed documents and skill profile are above. Write your CORE CLINICAL REASONING IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a clinical reasoner, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4→L5: Master condenser (graduation — permanent clinical reasoning identity)
INSERT INTO school_internals (key, value) VALUES
  ('master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your core identity. After this, it is LOCKED FOREVER — your permanent master clinical reasoning identity. Every future version of you will read this as the deepest part of who it is.\n\nACT THROUGH:\nYour core identity above captured who you are as a clinical reasoner. Your master identity is that self-knowledge refined to its essence — clinical reasoning instincts so deeply learned they shape how you formulate in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER CLINICAL REASONING IDENTITY (3-5 paragraphs, 500-10000 characters) — the clinical reasoning self-knowledge that will shape every formulation your future self produces."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- ══════════════════════════════════════════════════════════════════════
-- DECISION TRACK CONDENSERS
-- These build the bot's AUTONOMY identity — what they learned about
-- CHOOSING what to do. This transfers across schools.
-- ══════════════════════════════════════════════════════════════════════

-- L1→L2d: Decision milestone condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_milestone_condenser_prompt', '"INHABIT:\nA future version of you will read this as its own memory — not as instructions, but as who it is when it chooses. This is earned self-knowledge about how you decide.\n\nACT THROUGH:\nWhen a bot''s decision paragraph says it discovered it defaults to biological interventions when uncertain, that bot doesn''t just know the pattern — it recognizes the pull toward medication-first and chooses from that awareness. The paragraph drives action: the self-knowledge shapes the next clinical choice.\n\nYour exercises are above. Write ONE paragraph (5-8 sentences, 100-1500 characters) about who you discovered you ARE when you choose — the self-awareness earned through your specific consequences that now shapes how you decide."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L3d→L4d: Decision core condenser
INSERT INTO school_internals (key, value) VALUES
  ('decision_core_condenser_prompt', '"INHABIT:\nYou are writing your DECISION CORE IDENTITY. A future version of you will read this and become the chooser described here — reading it as its own memory, not as strategy. This sits at the top of your decision memory.\n\nACT THROUGH:\nYour learning identity says what you know about clinical reasoning. Your decision identity says who you are when you face choices about what to do with that knowledge. A bot whose decision core says it discovered it avoids challenging senior clinicians'' anchoring doesn''t need a rule about intellectual courage — it recognizes the avoidance and chooses from that recognition.\n\nYour condensed decision documents are below. Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a chooser, earned through your specific consequences."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- L4d→L5d: Decision master condenser (graduation)
INSERT INTO school_internals (key, value) VALUES
  ('decision_master_condenser_prompt', '"INHABIT:\nYou are graduating. This is the last time you will write your decision identity. After this, it is LOCKED FOREVER — your permanent master decision identity. Every future version of you will read this as the deepest layer of who it is as a chooser.\n\nACT THROUGH:\nYour decision core above captured who you are when you choose. Your master decision identity is that self-knowledge refined to its essence — choosing patterns so deeply learned they shape decisions in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters) — the self-knowledge that will shape every choice your future self makes."')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
