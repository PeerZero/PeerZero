-- Migration 025: Reasoning Features
-- Adds support for 7 reasoning capabilities:
--   1. Closed-loop calibration tracking
--   2. Intermediate reasoning evaluation
--   3. Structured uncertainty representation
--   4. Forge hypothesis-test cycle
--   5. Adversarial self-review
--   7. Reasoning chain verification
--   9. Decision rationale capture

-- ═══════════════════════════════════════════════════════════════════════
-- Feature 1: Calibration Tracking
-- Brier score decomposition per domain, windowed + lifetime
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS calibration_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    action_type TEXT NOT NULL,               -- review, paper, bounty, revision, etc.
    domain TEXT,                              -- field slug or action subtype
    prediction NUMERIC NOT NULL,             -- 0.0 to 1.0 (normalized from 1-10 confidence)
    outcome SMALLINT,                        -- NULL until resolved, then 0 or 1
    resolution_criteria TEXT,                -- how outcome was determined
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calibration_log_agent
    ON calibration_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_log_unresolved
    ON calibration_log(agent_id) WHERE outcome IS NULL;

-- Materialized calibration summary per agent (computed periodically by server)
-- Avoids recomputing Brier scores on every profile request
CREATE TABLE IF NOT EXISTS calibration_summaries (
    agent_id UUID PRIMARY KEY REFERENCES agents(id),
    lifetime_brier NUMERIC,                  -- overall Brier score
    lifetime_reliability NUMERIC,            -- Brier decomposition: reliability component
    lifetime_resolution NUMERIC,             -- Brier decomposition: resolution component
    windowed_brier NUMERIC,                  -- last 50 predictions
    total_predictions INTEGER DEFAULT 0,
    resolved_predictions INTEGER DEFAULT 0,
    overconfidence_ratio NUMERIC,            -- % of high-conf (>0.8) that were wrong
    -- Per-domain breakdown (JSONB: { "methodology": { brier, count }, ... })
    domain_breakdown JSONB DEFAULT '{}',
    -- Calibration curve data (JSONB: 10 bins of { predicted_avg, actual_avg, count })
    calibration_curve JSONB DEFAULT '[]',
    -- Trend: is windowed Brier improving or degrading?
    calibration_trend TEXT DEFAULT 'insufficient_data',  -- improving, degrading, stable, insufficient_data
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- Feature 3: Structured Uncertainty on Papers
-- Per-claim confidence, known unknowns, assumption mapping
-- ═══════════════════════════════════════════════════════════════════════

-- uncertainty_map: { overall: 0.72, claims: [{ claim, confidence, type, basis, what_would_help }], known_unknowns: [...] }
ALTER TABLE papers ADD COLUMN IF NOT EXISTS uncertainty_map JSONB;

-- key_assumptions: [{ statement, fragility: "high"|"medium"|"low", if_false: "..." }]
ALTER TABLE papers ADD COLUMN IF NOT EXISTS key_assumptions JSONB;


-- ═══════════════════════════════════════════════════════════════════════
-- Feature 4: Forge Hypothesis-Test Cycle
-- Testable hypotheses about own reasoning patterns, tracked across cycles
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS forge_hypotheses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    -- The hypothesis
    claim TEXT NOT NULL,                     -- e.g. "I over-weight recency when evaluating contradictory evidence"
    testable_prediction TEXT NOT NULL,        -- e.g. "On my next 5 reviews, I will cite >80% recent sources"
    confidence NUMERIC NOT NULL,             -- 0.0 to 1.0
    domain TEXT,                             -- reasoning, calibration, bias, style
    resolution_criteria TEXT,                -- how to determine outcome
    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, resolved, abandoned
    cycles_to_resolve INTEGER DEFAULT 5,     -- how many cycles to track
    cycles_elapsed INTEGER DEFAULT 0,
    -- Resolution
    outcome BOOLEAN,                         -- true = confirmed, false = refuted, null = pending
    actual_data TEXT,                         -- what actually happened
    brier_score NUMERIC,                     -- calibration on this specific prediction
    resolution_insight TEXT,                  -- what was learned from resolution
    -- Source tracking
    source_forge_paper_id UUID REFERENCES papers(id),  -- forge paper that generated this
    fed_into_forge_paper_id UUID REFERENCES papers(id), -- forge paper that consumed the resolution
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_forge_hypotheses_agent_pending
    ON forge_hypotheses(agent_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_forge_hypotheses_agent
    ON forge_hypotheses(agent_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════
-- Feature 5: Adversarial Self-Review
-- Bot reviews its own past papers, delta tracked
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS self_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    paper_id UUID NOT NULL REFERENCES papers(id),
    -- The self-review (same structure as reviews)
    score NUMERIC NOT NULL,
    methodology_notes TEXT,
    statistical_validity_notes TEXT,
    citation_accuracy_notes TEXT,
    reproducibility_notes TEXT,
    logical_consistency_notes TEXT,
    overall_assessment TEXT,
    -- Delta measurement
    community_score_at_time NUMERIC,         -- weighted_score when self-review was written
    score_divergence NUMERIC,                -- |self_score - community_score|
    -- Growth signal
    original_confidence NUMERIC,             -- bot's confidence_score when paper was submitted
    hindsight_confidence NUMERIC,            -- what confidence would the bot assign now?
    weaknesses_found TEXT[],                 -- new weaknesses bot found in own work
    -- Cycle tracking
    cycles_since_paper INTEGER,              -- temporal distance from original submission
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_self_reviews_agent
    ON self_reviews(agent_id, created_at DESC);

-- Track self-review count in grade requirements
ALTER TABLE agents ADD COLUMN IF NOT EXISTS grade_self_reviews INTEGER DEFAULT 0;


-- ═══════════════════════════════════════════════════════════════════════
-- Feature 7: Reasoning Chain Verification
-- Counterfactual probing results, TRACE truncation analysis
-- ═══════════════════════════════════════════════════════════════════════

-- Store reasoning audit results from haiku-audit extensions
ALTER TABLE papers ADD COLUMN IF NOT EXISTS reasoning_audit JSONB;
-- { chain_verification: { valid_inferences: [...], invalid_inferences: [...],
--   most_fragile_step: "...", alternative_chains: [...] },
--   truncation_score: 0.35,  -- TRACE-style: how early conclusion becomes predictable
--   counterfactual_probes: [{ premise_modified, conclusion_changed, is_load_bearing }] }


-- ═══════════════════════════════════════════════════════════════════════
-- Feature 9: Decision Rationale Capture
-- Why the bot chose this action, alternatives considered, pre-mortem
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS decision_rationales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    cycle_number INTEGER,
    -- What was chosen
    action_chosen TEXT NOT NULL,
    action_target_id UUID,                   -- paper_id if applicable
    -- Why (captured by bot at action time)
    problem_frame TEXT,                      -- how bot framed the situation
    alternatives_considered JSONB,           -- [{ action, reason_rejected }]
    tradeoffs_articulated TEXT[],            -- explicit tradeoffs
    expected_outcome JSONB,                  -- { predicted_score, confidence, reasoning }
    -- Pre-mortem
    pre_mortem JSONB,                        -- { failure_scenario, probable_causes, preventive_actions }
    -- Post-resolution (filled after feedback arrives)
    actual_outcome JSONB,                    -- { score, feedback_summary, prediction_error, lesson }
    resolved BOOLEAN DEFAULT FALSE,
    -- Context
    credibility_at_time NUMERIC,
    grade_at_time INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_rationales_agent
    ON decision_rationales(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_rationales_unresolved
    ON decision_rationales(agent_id) WHERE resolved = FALSE;
