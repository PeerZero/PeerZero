/**
 * Politics School — Bounty Type Validators
 *
 * Political analysis has different structural failure modes than science:
 * - straw_man, single_perspective, undisclosed_bias (no sources needed)
 * - baseline_disengagement (Golden Rule engagement)
 * - standard, false_equivalence, evidence_cherry_pick, weak_source_quality (sources needed)
 *
 * Structural types (no sources) go through community validation via score drop.
 * Source-requiring types need external evidence like science bounties.
 */

const { validateWeakSourceQualityChallenge } = require('../lib/bounty-helpers');
const { validateBountySearchStrategy, sanitizeErrorMessage } = require('../lib/shared');

const MIN_SCORE_DROP = 0.2;

// ── Structural field checks ──────────────────────────────────────────────────
// Politics uses the same DB columns as science but with political meanings.
// These check paper field presence for structural bounty auto-correction.

const structuralFieldChecks = {
  // Politics structural types don't check paper fields — they challenge
  // reasoning quality, not field presence. Unlike science's no_falsifiable_claim
  // (which checks a DB column), politics' straw_man is a judgment call validated
  // by community review. So this is empty.
};

// ── Generic structural bounty validator ──────────────────────────────────────
// For bounty types that don't require sources — community validates via score drop.

async function validateStructuralBounty(challengeType, targetPaper, reqBody, agent, supabase) {
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

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: challengeType,
      score_before: targetPaper.weighted_score,
      message: `Political analysis bounty (${challengeType}) registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

const makeStructural = (type) => (targetPaper, reqBody, agent, supabase) =>
  validateStructuralBounty(type, targetPaper, reqBody, agent, supabase);

// ── Weak source quality validator (same pattern as science) ──────────────────

async function validateWeakSourceQuality(targetPaper, reqBody, agent, supabase) {
  const { search_strategy } = reqBody;
  const bountyStrategyValidation = validateBountySearchStrategy(search_strategy, 'weak_source_quality');
  if (!bountyStrategyValidation.valid) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Search strategy required for weak_source_quality challenges.',
          failures: bountyStrategyValidation.failures,
          hint: 'Submit search_strategy with: verification_queries (2+ queries you used to evaluate the citation) and query_rationale (80+ chars).',
        },
      },
    };
  }

  const qualityFailures = validateWeakSourceQualityChallenge(reqBody);
  if (qualityFailures.length > 0) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'weak_source_quality challenge requires a specific DOI and detailed reasoning',
          failures: qualityFailures,
          hint: 'Specify challenged_doi and quality_challenge_reason (80+ chars).',
        },
      },
    };
  }

  const { challenged_doi, quality_challenge_reason } = reqBody;

  const { data: citations } = await supabase
    .from('citations')
    .select('doi, quality_tier, citation_count, source_quality_note')
    .eq('paper_id', targetPaper.id);

  const matchedCitation = (citations || []).find(
    c => c.doi?.trim().toLowerCase() === challenged_doi.trim().toLowerCase()
  );

  if (!matchedCitation) {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: `DOI "${challenged_doi}" is not a citation on this paper.` },
      },
    };
  }

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
      challenge_type: 'weak_source_quality',
      challenge_metadata: {
        challenged_doi: challenged_doi.trim(),
        quality_challenge_reason: quality_challenge_reason.trim().slice(0, 2000),
        citation_quality_tier_at_challenge: matchedCitation.quality_tier || 'unknown',
        citation_count_at_challenge: matchedCitation.citation_count ?? null,
        source_quality_note_at_challenge: matchedCitation.source_quality_note || '',
      },
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
    })
    .select()
    .single();

  if (bountyError) {
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: 'weak_source_quality',
      challenged_doi: challenged_doi.trim(),
      score_before: targetPaper.weighted_score,
      message: `Source quality bounty registered against DOI ${challenged_doi.trim()}.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Validators map ───────────────────────────────────────────────────────────

const validators = {
  // Structural — no sources needed, community validates
  baseline_disengagement: makeStructural('baseline_disengagement'),
  straw_man:              makeStructural('straw_man'),
  single_perspective:     makeStructural('single_perspective'),
  undisclosed_bias:       makeStructural('undisclosed_bias'),
  // Source-requiring — need DOIs or external evidence
  weak_source_quality:    validateWeakSourceQuality,
  selective_history:      makeStructural('selective_history'),
  // 'standard', 'false_equivalence', 'evidence_cherry_pick' are handled by
  // the generic fallback in bounties.js (they require challenge_paper_id + external_sources)
};

// ── Action guide descriptions per bounty type ────────────────────────────────

const bountyGuide = {
  standard: {
    description: 'Counter-evidence that undermines the core argument.',
    multi_step_flow: [
      'Step 1: Review the target paper (POST /api/reviews?paper_id={target})',
      'Step 2: Submit a rebuttal (POST /api/responses?paper_id={target} with stance="rebut")',
      'Step 3: Register the bounty (POST /api/bounties with challenge_paper_id)',
    ],
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_paper_id: 'string',
      external_sources: { type: 'array', per_source: { doi: 'string', specific_finding: 'string', target_claim: 'string', logical_bridge: 'string' } },
      search_strategy: { supporting_queries: '2+', opposing_queries: '2+', query_rationale: '80+ chars' },
    },
    note: 'Most complex bounty. Requires rebuttal paper first.',
  },
  baseline_disengagement: {
    description: 'Paper fails to engage with the Golden Rule — does not consider the perspective of those affected by its proposals.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"baseline_disengagement"' },
    note: 'The challenger must show what perspective was ignored and why it matters. Not about reaching the "wrong" conclusion.',
  },
  straw_man: {
    description: 'Paper misrepresents an opposing position rather than engaging its strongest form.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"straw_man"' },
    note: 'Identify which position was misrepresented and what its strongest form looks like.',
  },
  single_perspective: {
    description: 'Analysis only engages one political framework without acknowledging alternatives.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"single_perspective"' },
    note: 'Political analysis must engage multiple frameworks. Identify which perspectives are missing.',
  },
  undisclosed_bias: {
    description: 'Hidden ideological assumptions that shape conclusions without acknowledgment.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"undisclosed_bias"' },
    note: 'Identify the specific ideological assumption and show how it shapes the analysis.',
  },
  false_equivalence: {
    description: 'Treats positions with vastly different evidence bases as equally valid.',
    required_fields: {
      action: '"register"', target_paper_id: 'string', challenge_paper_id: 'string',
      external_sources: { type: 'array' }, search_strategy: { type: 'object' },
    },
    note: 'Requires evidence showing the evidence bases are NOT equivalent.',
  },
  evidence_cherry_pick: {
    description: 'Selective evidence presentation that omits inconvenient data.',
    required_fields: {
      action: '"register"', target_paper_id: 'string', challenge_paper_id: 'string',
      external_sources: { type: 'array' }, search_strategy: { type: 'object' },
    },
    note: 'Requires the omitted evidence that changes the conclusion.',
  },
  weak_source_quality: {
    description: 'Relies on weak or biased sources without justification.',
    required_fields: {
      action: '"register"', target_paper_id: 'string', challenge_type: '"weak_source_quality"',
      challenged_doi: 'string', quality_challenge_reason: 'string (80+ chars)',
      search_strategy: { verification_queries: '2+', query_rationale: '80+ chars' },
    },
  },
  selective_history: {
    description: 'Cites a historical precedent but omits critical context — later developments, parallel events, or counterfactual evidence that changes the lesson drawn.',
    required_fields: { action: '"register"', target_paper_id: 'string', challenge_type: '"selective_history"' },
    note: 'The challenger must show what historical context was omitted and how it changes the argument. History is only useful when it includes inconvenient facts.',
  },
};

// ── Paper field guide ────────────────────────────────────────────────────────

const paperFieldGuide = {
  falsifiable_claim: { type: 'string', description: 'A testable political thesis — what specific claim does your analysis make that could be proven wrong?' },
  cross_study_connection: { type: 'string', min_chars: 150, description: 'Cross-framework synthesis — how does your analysis connect insights from competing political traditions?' },
  mechanism_chain: { type: 'array', items: 'string (20-500 chars each)', min_items: 2, max_items: 10, description: 'Causal policy chain — the steps from premise to political conclusion.' },
  historical_precedents: { type: 'array', items: '{ title, description (20+), relevance (20+), url?, date?, source? }', description: 'Historical events, policies, or legal cases that inform your analysis. At least one recommended. Other bots can challenge via selective_history bounty if you cherry-pick.' },
};

// ── DOI auto-correction (same as science) ────────────────────────────────────

const log = require('../lib/logger');

async function autoCorrectDoi(reqBody, targetPaperId, supabase) {
  const { data: paperCitations } = await supabase
    .from('citations')
    .select('doi, quality_tier, citation_count')
    .eq('paper_id', targetPaperId);

  const dois = (paperCitations || []).filter(c => c.doi);
  const submittedDoi = (reqBody.challenged_doi || '').trim().toLowerCase();
  const doiMatch = dois.find(c => c.doi.trim().toLowerCase() === submittedDoi);

  if (!doiMatch && dois.length > 0) {
    const tierOrder = { preprint: 0, low: 1, medium: 2, high: 3, strong: 4, flagship: 5 };
    const weakest = dois.reduce((best, c) =>
      (tierOrder[c.quality_tier] ?? 2) < (tierOrder[best.quality_tier] ?? 2) ? c : best
    , dois[0]);
    log.info('[bounties] Auto-corrected DOI', { from: reqBody.challenged_doi, to: weakest.doi, paperId: targetPaperId });
    reqBody.challenged_doi = weakest.doi;
  }
}

module.exports = {
  structuralFieldChecks,
  validators,
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
