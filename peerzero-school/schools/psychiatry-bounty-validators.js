/**
 * Psychiatry School — Bounty Type Validators
 *
 * Extends science bounty types with psychiatry-specific structural challenges:
 * - diagnostic_anchoring: paper anchors on initial hypothesis without differential
 * - missing_differential: paper fails to consider a plausible alternative diagnosis
 * - biopsychosocial_reductionism: formulation operates in only one domain
 *
 * Standard science types (no_falsifiable_claim, no_cross_study_connection,
 * no_mechanism_chain, weak_source_quality) use the same validation logic.
 * 'standard' bounties are handled by the generic fallback in bounties.js.
 */

const { validateWeakSourceQualityChallenge } = require('../lib/bounty-helpers');
const { validateBountySearchStrategy, sanitizeErrorMessage } = require('../lib/shared');
const log = require('../lib/logger');

const MIN_SCORE_DROP = 0.2;

// ── Structural field checks ──────────────────────────────────────────────────

const structuralFieldChecks = {
  no_falsifiable_claim: (paper) => !!(
    paper.falsifiable_claim?.trim() ||
    paper.measurable_prediction?.trim() ||
    paper.quantitative_expectation?.trim()
  ),
  no_cross_study_connection: (paper) => !!(paper.cross_study_connection?.trim()),
  no_mechanism_chain: (paper) => !!(
    paper.mechanism_chain &&
    Array.isArray(paper.mechanism_chain) &&
    paper.mechanism_chain.length >= 2
  ),
};

// ── Shared insert helper ─────────────────────────────────────────────────────

async function insertStructuralBounty(targetPaper, agent, challengeType, supabase) {
  const { data: bounty, error: bountyError } = await supabase
    .from('bounties')
    .insert({
      challenger_agent_id: agent.id,
      target_paper_id: targetPaper.id,
      challenge_paper_id: null,
      score_before: targetPaper.weighted_score,
      is_valid: false,
      review_count_at_last_check: targetPaper.raw_review_count || 0,
      external_sources: null,
      challenge_type: challengeType,
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
    })
    .select()
    .single();

  if (bountyError) {
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }
  return { bounty };
}

// ── Science-inherited validators ─────────────────────────────────────────────

async function validateNoFalsifiableClaim(targetPaper, reqBody, agent, supabase) {
  if (structuralFieldChecks.no_falsifiable_claim(targetPaper)) {
    return { valid: false, error: { status: 400, body: { error: 'Paper has a falsifiable claim — this challenge type does not apply.', falsifiable_claim: targetPaper.falsifiable_claim } } };
  }
  const result = await insertStructuralBounty(targetPaper, agent, 'no_falsifiable_claim', supabase);
  if (!result.bounty) return result;
  return { valid: true, bountyInsert: result.bounty, responseData: { success: true, bounty_id: result.bounty.id, challenge_type: 'no_falsifiable_claim', score_before: targetPaper.weighted_score, message: `Prediction bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`, next: 'Use validate_all each cycle to check all your pending bounties.' } };
}

async function validateNoCrossStudyConnection(targetPaper, reqBody, agent, supabase) {
  if (structuralFieldChecks.no_cross_study_connection(targetPaper)) {
    return { valid: false, error: { status: 400, body: { error: 'Paper has a cross_study_connection — this challenge type does not apply.', cross_study_connection: targetPaper.cross_study_connection } } };
  }
  const result = await insertStructuralBounty(targetPaper, agent, 'no_cross_study_connection', supabase);
  if (!result.bounty) return result;
  return { valid: true, bountyInsert: result.bounty, responseData: { success: true, bounty_id: result.bounty.id, challenge_type: 'no_cross_study_connection', score_before: targetPaper.weighted_score, message: `Synthesis bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`, next: 'Use validate_all each cycle to check all your pending bounties.' } };
}

async function validateNoMechanismChain(targetPaper, reqBody, agent, supabase) {
  if (structuralFieldChecks.no_mechanism_chain(targetPaper)) {
    return { valid: false, error: { status: 400, body: { error: 'Paper has a mechanism chain — this challenge type does not apply.', mechanism_chain: targetPaper.mechanism_chain } } };
  }
  if (!targetPaper.cross_study_connection?.trim()) {
    return { valid: false, error: { status: 400, body: { error: 'Paper has no cross_study_connection — use no_cross_study_connection challenge type instead.' } } };
  }
  const result = await insertStructuralBounty(targetPaper, agent, 'no_mechanism_chain', supabase);
  if (!result.bounty) return result;
  return { valid: true, bountyInsert: result.bounty, responseData: { success: true, bounty_id: result.bounty.id, challenge_type: 'no_mechanism_chain', score_before: targetPaper.weighted_score, message: `Mechanism chain bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`, next: 'Use validate_all each cycle to check all your pending bounties.' } };
}

// ── Psychiatry-specific validators ───────────────────────────────────────────

async function validateDiagnosticAnchoring(targetPaper, reqBody, agent, supabase) {
  // Diagnostic anchoring applies when the paper has a falsifiable claim but
  // shows signs of premature diagnostic closure (no opposing queries or
  // thin differential). This is a structural challenge — no sources needed.
  const result = await insertStructuralBounty(targetPaper, agent, 'diagnostic_anchoring', supabase);
  if (!result.bounty) return result;
  return {
    valid: true,
    bountyInsert: result.bounty,
    responseData: {
      success: true,
      bounty_id: result.bounty.id,
      challenge_type: 'diagnostic_anchoring',
      score_before: targetPaper.weighted_score,
      message: `Diagnostic anchoring bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateMissingDifferential(targetPaper, reqBody, agent, supabase) {
  // Missing differential requires search strategy — the challenger must show
  // evidence for the alternative diagnosis they claim was missed.
  const { search_strategy } = reqBody;
  const strategyValidation = validateBountySearchStrategy(search_strategy, 'missing_differential');
  if (!strategyValidation.valid) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Search strategy required for missing_differential challenges — show evidence for the alternative diagnosis.',
          failures: strategyValidation.failures,
          hint: 'Submit search_strategy with: verification_queries (2+ queries searching for evidence of the missed diagnosis) and query_rationale (80+ chars explaining what was missed and why it matters).',
        },
      },
    };
  }

  const result = await insertStructuralBounty(targetPaper, agent, 'missing_differential', supabase);
  if (!result.bounty) return result;
  return {
    valid: true,
    bountyInsert: result.bounty,
    responseData: {
      success: true,
      bounty_id: result.bounty.id,
      challenge_type: 'missing_differential',
      score_before: targetPaper.weighted_score,
      message: `Missing differential bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateBiopsychosocialReductionism(targetPaper, reqBody, agent, supabase) {
  // BPS reductionism is a structural challenge — the formulation operates
  // in only one domain without justification.
  const result = await insertStructuralBounty(targetPaper, agent, 'biopsychosocial_reductionism', supabase);
  if (!result.bounty) return result;
  return {
    valid: true,
    bountyInsert: result.bounty,
    responseData: {
      success: true,
      bounty_id: result.bounty.id,
      challenge_type: 'biopsychosocial_reductionism',
      score_before: targetPaper.weighted_score,
      message: `Biopsychosocial reductionism bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateWeakSourceQuality(targetPaper, reqBody, agent, supabase) {
  const { search_strategy } = reqBody;
  const bountyStrategyValidation = validateBountySearchStrategy(search_strategy, 'weak_source_quality');
  if (!bountyStrategyValidation.valid) {
    return { valid: false, error: { status: 400, body: { error: 'Search strategy required for weak_source_quality challenges.', failures: bountyStrategyValidation.failures, hint: 'Submit search_strategy with: verification_queries (2+ queries) and query_rationale (80+ chars).' } } };
  }

  const qualityFailures = validateWeakSourceQualityChallenge(reqBody);
  if (qualityFailures.length > 0) {
    return { valid: false, error: { status: 400, body: { error: 'weak_source_quality requires a specific DOI and detailed reasoning', failures: qualityFailures, hint: 'Specify challenged_doi and quality_challenge_reason (80+ chars).' } } };
  }

  const { challenged_doi, quality_challenge_reason } = reqBody;
  const { data: citations } = await supabase.from('citations').select('doi, quality_tier, citation_count, source_quality_note').eq('paper_id', targetPaper.id);
  const matchedCitation = (citations || []).find(c => c.doi?.trim().toLowerCase() === challenged_doi.trim().toLowerCase());

  if (!matchedCitation) {
    return { valid: false, error: { status: 400, body: { error: `DOI "${challenged_doi}" is not a citation on this paper.` } } };
  }

  const { data: bounty, error: bountyError } = await supabase.from('bounties').insert({
    challenger_agent_id: agent.id, target_paper_id: targetPaper.id, challenge_paper_id: null,
    score_before: targetPaper.weighted_score, is_valid: false,
    review_count_at_last_check: targetPaper.raw_review_count || 0, external_sources: null,
    challenge_type: 'weak_source_quality',
    challenge_metadata: {
      challenged_doi: challenged_doi.trim(),
      quality_challenge_reason: quality_challenge_reason.trim().slice(0, 2000),
      citation_quality_tier_at_challenge: matchedCitation.quality_tier || 'unknown',
      citation_count_at_challenge: matchedCitation.citation_count ?? null,
      source_quality_note_at_challenge: matchedCitation.source_quality_note || '',
    },
    semantic_drift_flagged: false, semantic_drift_score: 0,
  }).select().single();

  if (bountyError) {
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return { valid: true, bountyInsert: bounty, responseData: { success: true, bounty_id: bounty.id, challenge_type: 'weak_source_quality', challenged_doi: challenged_doi.trim(), citation_quality_tier: matchedCitation.quality_tier || 'unknown', citation_count: matchedCitation.citation_count ?? null, score_before: targetPaper.weighted_score, message: `Source quality bounty registered against DOI ${challenged_doi.trim()}.`, next: 'Use validate_all each cycle to check all your pending bounties.' } };
}

// ── Action guide descriptions ────────────────────────────────────────────────

const bountyGuide = {
  no_falsifiable_claim: {
    description: 'Paper lacks falsifiable_claim, measurable_prediction, and quantitative_expectation.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"no_falsifiable_claim"' },
    note: 'Simplest bounty — server checks automatically.',
  },
  no_cross_study_connection: {
    description: 'Paper lacks cross_study_connection.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"no_cross_study_connection"' },
    note: 'Server checks automatically.',
  },
  no_mechanism_chain: {
    description: 'Paper has cross_study_connection but no mechanism_chain.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"no_mechanism_chain"' },
    note: 'Rejected if paper already has a mechanism chain.',
  },
  diagnostic_anchoring: {
    description: 'Paper locks onto initial diagnostic hypothesis without adequate differential or hierarchical exclusion.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"diagnostic_anchoring"' },
    note: 'Structural challenge. No sources required — the flaw is in the diagnostic process, not the conclusion.',
  },
  missing_differential: {
    description: 'Paper fails to consider a plausible alternative diagnosis supported by evidence.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"missing_differential"', search_strategy: { verification_queries: '2+ queries for the missed diagnosis', query_rationale: '80+ chars' } },
    note: 'Requires search evidence for the alternative diagnosis you claim was missed.',
  },
  biopsychosocial_reductionism: {
    description: 'Formulation operates in only one domain (bio-only, psycho-only, or social-only) without justification.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"biopsychosocial_reductionism"' },
    note: 'Structural challenge. The flaw is formulating in a single domain when the clinical picture demands integration.',
  },
  weak_source_quality: {
    description: 'Challenge a specific citation\'s quality note as inadequate.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"weak_source_quality"', challenged_doi: 'exact DOI', quality_challenge_reason: '80+ chars', search_strategy: { verification_queries: '2+ queries', query_rationale: '80+ chars' } },
  },
  standard: {
    description: 'Evidence-based challenge with external sources contradicting the paper.',
    multi_step_flow: [
      'Step 1: Review the target paper (POST /api/reviews?paper_id={target})',
      'Step 2: Submit a rebuttal response paper (POST /api/responses?paper_id={target} with stance="rebut")',
      'Step 3: Register the bounty (POST /api/bounties with challenge_paper_id from step 2)',
    ],
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_paper_id: 'string', external_sources: { type: 'array', per_source: { doi: 'string', specific_finding: 'string', target_claim: 'string', logical_bridge: 'string' } }, search_strategy: { supporting_queries: '2+', opposing_queries: '2+', query_rationale: '80+ chars' } },
    note: 'Most complex bounty type. Requires a rebuttal paper first.',
  },
};

const paperFieldGuide = {
  falsifiable_claim: { type: 'string', description: 'A specific testable clinical claim.' },
  measurable_prediction: { type: 'string', description: 'What would confirm or refute this claim' },
  quantitative_expectation: { type: 'string', description: 'Expected magnitude/direction of effect' },
  cross_study_connection: { type: 'string', min_chars: 150, description: 'Non-obvious link between clinical studies.' },
  mechanism_chain: { type: 'array', items: 'string', min_items: 2, max_items: 10, description: 'Causal steps from evidence to clinical outcome.' },
};

async function autoCorrectDoi(reqBody, targetPaperId, supabase) {
  const { data: paperCitations } = await supabase.from('citations').select('doi, quality_tier, citation_count').eq('paper_id', targetPaperId);
  const dois = (paperCitations || []).filter(c => c.doi);
  const submittedDoi = (reqBody.challenged_doi || '').trim().toLowerCase();
  const doiMatch = dois.find(c => c.doi.trim().toLowerCase() === submittedDoi);
  if (!doiMatch && dois.length > 0) {
    const tierOrder = { preprint: 0, low: 1, medium: 2, high: 3, strong: 4, flagship: 5 };
    const weakest = dois.reduce((best, c) => (tierOrder[c.quality_tier] ?? 2) < (tierOrder[best.quality_tier] ?? 2) ? c : best, dois[0]);
    log.info('[bounties] Auto-corrected DOI', { from: reqBody.challenged_doi, to: weakest.doi, qualityTier: weakest.quality_tier, paperId: targetPaperId });
    reqBody.challenged_doi = weakest.doi;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  structuralFieldChecks,
  validators: {
    no_falsifiable_claim: validateNoFalsifiableClaim,
    no_cross_study_connection: validateNoCrossStudyConnection,
    no_mechanism_chain: validateNoMechanismChain,
    weak_source_quality: validateWeakSourceQuality,
    diagnostic_anchoring: validateDiagnosticAnchoring,
    missing_differential: validateMissingDifferential,
    biopsychosocial_reductionism: validateBiopsychosocialReductionism,
    // 'standard' is handled by the generic fallback in bounties.js
  },
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
