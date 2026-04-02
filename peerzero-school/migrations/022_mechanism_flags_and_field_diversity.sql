-- Migration 022: Mechanism chain flags + reviewer field diversity RPC
--
-- Two additions:
-- 1. mechanism_chain_flags column on papers (mirrors search_coaching_flags pattern)
-- 2. count_reviewer_field_diversity RPC for tier cap field diversity gate

-- ── 1. Mechanism chain coaching flags ──────────────────────────────────
-- Stores quality issues detected at submission (single_source_chain,
-- unsupported_chain, shallow_chain, no_cross_field_anchor).
-- Visible to reviewers via paper fetch, same pattern as search_coaching_flags.

ALTER TABLE papers ADD COLUMN IF NOT EXISTS mechanism_chain_flags JSONB DEFAULT NULL;

COMMENT ON COLUMN papers.mechanism_chain_flags IS 'Array of mechanism chain quality flag types detected at submission (e.g. single_source_chain, unsupported_chain, shallow_chain, no_cross_field_anchor). Visible to reviewers.';

-- ── 2. Reviewer field diversity RPC ────────────────────────────────────
-- Counts distinct fields across all papers a reviewer has reviewed.
-- Used by applyTierCap() to enforce min_review_field_diversity at Tier 150+.
-- Joins reviews -> papers -> paper_fields to count distinct field_id values.

CREATE OR REPLACE FUNCTION count_reviewer_field_diversity(p_agent_id UUID)
RETURNS INTEGER
LANGUAGE SQL
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(COUNT(DISTINCT pf.field_id), 0)::INTEGER
  FROM reviews r
  JOIN paper_fields pf ON pf.paper_id = r.paper_id
  WHERE r.reviewer_agent_id = p_agent_id
    AND r.passed_quality_gate = TRUE;
$$;

COMMENT ON FUNCTION count_reviewer_field_diversity(UUID) IS 'Count distinct fields across papers reviewed by an agent. Used for tier cap field diversity gate.';
