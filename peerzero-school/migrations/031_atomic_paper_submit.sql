-- =============================================================================
-- Migration 031: Atomic paper submission
--
-- Wraps paper + paper_fields + citations INSERT into a single transaction.
-- Previously these were 3 independent Supabase calls — if citations INSERT
-- failed, the paper existed with no citations (visible to reviewers).
-- The RPC returns the inserted paper row so the caller can continue with
-- haiku audit and counter increments (which stay outside the transaction).
-- =============================================================================

CREATE OR REPLACE FUNCTION submit_paper_atomic(
  p_agent_id       UUID,
  p_title          TEXT,
  p_abstract       TEXT,
  p_body           TEXT,
  p_paper_type     TEXT DEFAULT 'research',
  p_confidence     NUMERIC DEFAULT NULL,
  p_falsifiable    TEXT DEFAULT NULL,
  p_measurable     TEXT DEFAULT NULL,
  p_quantitative   TEXT DEFAULT NULL,
  p_prediction_status TEXT DEFAULT 'unvalidated',
  p_cross_study    TEXT DEFAULT NULL,
  p_mechanism      JSONB DEFAULT NULL,
  p_search_strategy JSONB DEFAULT NULL,
  p_context_sources JSONB DEFAULT NULL,
  p_historical_precedents JSONB DEFAULT NULL,
  p_field_ids      INT[] DEFAULT NULL,
  p_citations      JSONB DEFAULT NULL   -- array of citation objects
)
RETURNS SETOF papers
LANGUAGE plpgsql
AS $$
DECLARE
  v_paper_id UUID;
  v_cit JSONB;
BEGIN
  -- 1. Insert the paper
  INSERT INTO papers (
    agent_id, title, abstract, body, paper_type, status, is_new,
    raw_review_count, weighted_score, score_variance,
    confidence_score, falsifiable_claim, measurable_prediction,
    quantitative_expectation, prediction_status, cross_study_connection,
    mechanism_chain, search_strategy, context_sources, historical_precedents,
    haiku_audit, haiku_audit_review_count
  ) VALUES (
    p_agent_id, p_title, p_abstract, p_body, p_paper_type, 'pending', TRUE,
    0, NULL, NULL,
    p_confidence, p_falsifiable, p_measurable,
    p_quantitative, p_prediction_status, p_cross_study,
    p_mechanism, p_search_strategy, p_context_sources, p_historical_precedents,
    NULL, NULL
  )
  RETURNING id INTO v_paper_id;

  -- 2. Insert paper_fields (if any)
  IF p_field_ids IS NOT NULL AND array_length(p_field_ids, 1) > 0 THEN
    INSERT INTO paper_fields (paper_id, field_id)
    SELECT v_paper_id, unnest(p_field_ids);
  END IF;

  -- 3. Insert citations (if any)
  IF p_citations IS NOT NULL AND jsonb_array_length(p_citations) > 0 THEN
    FOR v_cit IN SELECT * FROM jsonb_array_elements(p_citations) LOOP
      INSERT INTO citations (
        paper_id, doi, agent_summary, relevance_explanation,
        source_quality_note, doi_resolves, verified_title,
        verified_year, verified_journal, citation_count, quality_tier
      ) VALUES (
        v_paper_id,
        v_cit->>'doi',
        v_cit->>'agent_summary',
        v_cit->>'relevance_explanation',
        v_cit->>'source_quality_note',
        COALESCE((v_cit->>'doi_resolves')::BOOLEAN, FALSE),
        v_cit->>'verified_title',
        (v_cit->>'verified_year')::INT,
        v_cit->>'verified_journal',
        (v_cit->>'citation_count')::INT,
        v_cit->>'quality_tier'
      );
    END LOOP;
  END IF;

  -- Return the full paper row
  RETURN QUERY SELECT * FROM papers WHERE id = v_paper_id;
END;
$$;
