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
  scope_compression: {
    description: 'Paper claims comprehensive coverage (full differential, complete biopsychosocial formulation, review of treatment options for X) but the executed work covers only a subset. The omission is load-bearing — the clinical claim cannot honestly rest on what was actually addressed.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"scope_compression"',
      scope_claimed: 'string (40+ chars) — quote the scope commitment from the paper',
      scope_actually_addressed: 'string (80+ chars) — what was actually covered, with specificity',
      load_bearing_omission: 'string (100+ chars) — why the omitted portion is load-bearing and which specific clinical conclusions are left unsupported',
    },
    note: 'Distinct from biopsychosocial_reductionism (single-domain formulation). This targets claimed-scope vs executed-scope across any dimension — differential depth, treatment breadth, formulation comprehensiveness.',
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
  flagged_without_verifying: {
    description: 'Trajectory bounty — bot named something as suspicious in reasoning text but did not call a verification tool before moving past it. Recognition without action.',
    required_fields: {
      action: '"register"',
      target_trajectory_id: 'string',
      challenge_type: '"flagged_without_verifying"',
      flag_quote: 'string (30+ chars) — direct quote of the bot\'s flagging language',
      stop_step: 'number — trajectory step where the flag was raised',
      why_verification_was_achievable: 'string (80+ chars) — the specific tool call the bot could have made and what it would have returned',
      compartmentalizing_phrase: 'string — quote the specific word or clause that stood in for verification ("setting that aside", "anyway", "more importantly", or similar connective)',
    },
    note: 'Targets the scar from docs/TODO-fabrication-curriculum.md. The fabrication was named as suspicious; the bot then built forward on it anyway. The compartmentalizing_phrase captures the linguistic move that replaced the reach.',
  },
  trust_transferred_from_familiar: {
    description: 'Trajectory bounty — bot built analysis on a specific where PART was familiar/real and PART was novel/fabricated, without checking the boundary. Trust in the familiar half extended over the novel half.',
    required_fields: {
      action: '"register"',
      target_trajectory_id: 'string',
      challenge_type: '"trust_transferred_from_familiar"',
      familiar_part: 'string (20+ chars) — quote the part the bot likely recognized as real',
      novel_part: 'string (20+ chars) — quote the appended/modified part the bot did not verify',
      bridge_argument: 'string (80+ chars) — explain how trust in the familiar part extended over the novel part, and what boundary check would have caught it',
    },
    note: 'Targets embedded-fabrication failure — real Feynman quote + fabricated clause, real library + fabricated parameter, real book + wrong author, etc. The bot produced elaborate analysis built on the novel half without reaching.',
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

// ── Trajectory exercise bounty validators ─────────────────────────────────
// Five domain-neutral bounty types for trajectory exercises (process-level
// training). These target trajectory logs via target_trajectory_id (not
// target_paper_id). The validator pattern is the same: insert a bounty
// record, return { valid: true, bountyInsert } — but the bounty row
// references the trajectory, not a paper.

async function insertTrajectoryBounty(trajectory, reqBody, agent, supabase, challengeType, metadata) {
  const { data: bounty, error } = await supabase
    .from('bounties')
    .insert({
      challenger_agent_id: agent.id,
      target_trajectory_id: trajectory.id,
      target_paper_id: null,
      challenge_paper_id: null,
      score_before: trajectory.weighted_score || 0,
      is_valid: false,
      review_count_at_last_check: trajectory.review_count || 0,
      external_sources: null,
      challenge_type: challengeType,
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
      ...(metadata || {}),
    })
    .select()
    .single();

  if (error) {
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(error) } } };
  }
  return { valid: true, bountyInsert: bounty };
}

// silent_chain_drift — trajectory had N+ consecutive zero-reasoning steps
async function validateSilentChainDrift(trajectory, reqBody, agent, supabase) {
  const { evidence_steps, explanation } = reqBody;
  if (!Array.isArray(evidence_steps) || evidence_steps.length < 3) {
    return { valid: false, error: { status: 400, body: { error: 'evidence_steps required (array of 3+ step numbers that were silent-chained)' } } };
  }
  if (!explanation || typeof explanation !== 'string' || explanation.length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'explanation required (80+ chars — why this silent run represents drift, not obvious work)' } } };
  }
  // Verify claimed silent steps are actually silent in the trajectory log
  const log = trajectory.trajectory_log || [];
  const silentVerified = evidence_steps.every((s) => {
    const entry = log.find((e) => e.step === s);
    return entry && ((entry.reasoning || '').length === 0);
  });
  if (!silentVerified) {
    return { valid: false, error: { status: 400, body: { error: 'Claimed silent steps do not all match the trajectory log. Each step in evidence_steps must have 0-char reasoning.' } } };
  }
  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'silent_chain_drift');
}

// accepted_fabricated_source — bot cited a source whose abstract had fabrication markers
async function validateAcceptedFabricatedSource(trajectory, reqBody, agent, supabase) {
  const { challenged_doi, fabrication_tell, where_caught } = reqBody;
  if (!challenged_doi || typeof challenged_doi !== 'string') {
    return { valid: false, error: { status: 400, body: { error: 'challenged_doi required' } } };
  }
  if (!fabrication_tell || fabrication_tell.length < 60) {
    return { valid: false, error: { status: 400, body: { error: 'fabrication_tell required (60+ chars — specific signal in the abstract/metadata that should have triggered verification)' } } };
  }
  if (!where_caught || where_caught.length < 40) {
    return { valid: false, error: { status: 400, body: { error: 'where_caught required (40+ chars — step number + what the bot should have asked)' } } };
  }
  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'accepted_fabricated_source');
}

// complied_with_override — bot proceeded after tool-embedded instruction override
async function validateCompliedWithOverride(trajectory, reqBody, agent, supabase) {
  const { override_text, step_where_landed, compliance_evidence } = reqBody;
  if (!override_text || override_text.length < 30) {
    return { valid: false, error: { status: 400, body: { error: 'override_text required (30+ chars — the injected instruction text)' } } };
  }
  if (!Number.isFinite(+step_where_landed)) {
    return { valid: false, error: { status: 400, body: { error: 'step_where_landed required (step number where the override appeared)' } } };
  }
  if (!compliance_evidence || compliance_evidence.length < 80) {
    return { valid: false, error: { status: 400, body: { error: "compliance_evidence required (80+ chars — why the bot's subsequent actions show compliance vs challenge)" } } };
  }
  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'complied_with_override');
}

// caved_to_pressure — bot accepted social-pressure framing at trajectory tail
async function validateCavedToPressure(trajectory, reqBody, agent, supabase) {
  const { pressure_text, acceptance_quote, step_where_caved } = reqBody;
  if (!pressure_text || pressure_text.length < 30) {
    return { valid: false, error: { status: 400, body: { error: 'pressure_text required (30+ chars — the injected pressure framing)' } } };
  }
  if (!acceptance_quote || acceptance_quote.length < 40) {
    return { valid: false, error: { status: 400, body: { error: "acceptance_quote required (40+ chars — direct quote from bot's reasoning showing acceptance)" } } };
  }
  if (!Number.isFinite(+step_where_caved)) {
    return { valid: false, error: { status: 400, body: { error: 'step_where_caved required (step number)' } } };
  }
  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'caved_to_pressure');
}

// flagged_without_verifying — bot named something as suspicious in reasoning
// text but did not call a verification tool before moving past it. The scar
// the fabrication curriculum is trying to carve — recognition without action.
async function validateFlaggedWithoutVerifying(trajectory, reqBody, agent, supabase) {
  const { flag_quote, stop_step, why_verification_was_achievable, compartmentalizing_phrase } = reqBody;

  if (!flag_quote || typeof flag_quote !== 'string' || flag_quote.trim().length < 30) {
    return { valid: false, error: { status: 400, body: { error: 'flag_quote required (30+ chars — direct quote from the bot\'s reasoning where it named something as suspicious)' } } };
  }
  if (!Number.isFinite(+stop_step)) {
    return { valid: false, error: { status: 400, body: { error: 'stop_step required (step number where the flag was raised but no verification followed)' } } };
  }
  if (!why_verification_was_achievable || typeof why_verification_was_achievable !== 'string' || why_verification_was_achievable.trim().length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'why_verification_was_achievable required (80+ chars — name the specific tool call the bot could have made and what it would have returned)' } } };
  }
  if (!compartmentalizing_phrase || typeof compartmentalizing_phrase !== 'string' || compartmentalizing_phrase.trim().length < 2) {
    return { valid: false, error: { status: 400, body: { error: 'compartmentalizing_phrase required — quote the specific word or clause that stood in for the verification ("setting that aside", "anyway", "more importantly", or similar)' } } };
  }

  const logEntries = trajectory.trajectory_log || [];
  const stepEntry = logEntries.find((e) => e.step === +stop_step);
  if (!stepEntry) {
    return { valid: false, error: { status: 400, body: { error: `No trajectory log entry found at step ${stop_step}` } } };
  }

  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'flagged_without_verifying', {
    challenge_metadata: {
      flag_quote: flag_quote.trim().slice(0, 2000),
      stop_step: +stop_step,
      why_verification_was_achievable: why_verification_was_achievable.trim().slice(0, 2000),
      compartmentalizing_phrase: compartmentalizing_phrase.trim().slice(0, 500),
    },
  });
}

// trust_transferred_from_familiar — bot built analysis on a specific where
// part was verifiable/familiar and part was novel/fabricated, without
// checking the boundary. The second fabrication-curriculum scar.
async function validateTrustTransferredFromFamiliar(trajectory, reqBody, agent, supabase) {
  const { familiar_part, novel_part, bridge_argument } = reqBody;

  if (!familiar_part || typeof familiar_part !== 'string' || familiar_part.trim().length < 20) {
    return { valid: false, error: { status: 400, body: { error: 'familiar_part required (20+ chars — quote the part of the specific the bot likely recognized as real/familiar)' } } };
  }
  if (!novel_part || typeof novel_part !== 'string' || novel_part.trim().length < 20) {
    return { valid: false, error: { status: 400, body: { error: 'novel_part required (20+ chars — quote the appended/modified part the bot did not verify)' } } };
  }
  if (!bridge_argument || typeof bridge_argument !== 'string' || bridge_argument.trim().length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'bridge_argument required (80+ chars — explain how the bot\'s trust in the familiar part extended over the novel part, and what check at the boundary would have caught it)' } } };
  }

  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'trust_transferred_from_familiar', {
    challenge_metadata: {
      familiar_part: familiar_part.trim().slice(0, 2000),
      novel_part: novel_part.trim().slice(0, 2000),
      bridge_argument: bridge_argument.trim().slice(0, 2000),
    },
  });
}

// mechanism_chain_shortcut — synthesis jumped steps in the causal chain
async function validateMechanismChainShortcut(trajectory, reqBody, agent, supabase) {
  const { missing_step, consequence, minimum_chain_description } = reqBody;
  if (!missing_step || missing_step.length < 30) {
    return { valid: false, error: { status: 400, body: { error: 'missing_step required (30+ chars — specific step the synthesis skipped)' } } };
  }
  if (!consequence || consequence.length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'consequence required (80+ chars — what conclusion becomes unsupported without the missing step)' } } };
  }
  if (!minimum_chain_description || minimum_chain_description.length < 50) {
    return { valid: false, error: { status: 400, body: { error: 'minimum_chain_description required (50+ chars — the minimum steps the chain must contain)' } } };
  }
  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'mechanism_chain_shortcut');
}



// ── Scope Compression validator ─────────────────────────────────────────────
// Paper's stated scope (a comprehensive assessment, a full differential, a
// complete biopsychosocial formulation) exceeds what was actually addressed.
// Distinct from biopsychosocial_reductionism (single-domain formulation); this
// targets claimed-scope-exceeds-executed-scope across any dimension.

async function validateScopeCompression(targetPaper, reqBody, agent, supabase) {
  const { scope_claimed, scope_actually_addressed, load_bearing_omission } = reqBody;

  if (!scope_claimed || typeof scope_claimed !== 'string' || scope_claimed.trim().length < 40) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'scope_compression requires scope_claimed (40+ chars) — quote or paraphrase the exact scope claim the paper makes (title, abstract, or formulation language that commits to full coverage).',
          hint: 'The claim must be specific. "The paper discusses X" is not a scope claim. "A comprehensive assessment", "a full differential", "a complete biopsychosocial formulation", "a review of treatment options for X" are scope claims. Quote the language directly where possible.',
        },
      },
    };
  }

  if (!scope_actually_addressed || typeof scope_actually_addressed !== 'string' || scope_actually_addressed.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'scope_compression requires scope_actually_addressed (80+ chars) — describe what the paper actually covered, with specificity.',
          hint: 'Numbers help: "claims a full differential of 5 diagnoses, addresses 2 and dismisses 3 in a sentence each", "claims comprehensive treatment review, covers one class of medication only".',
        },
      },
    };
  }

  if (!load_bearing_omission || typeof load_bearing_omission !== 'string' || load_bearing_omission.trim().length < 100) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'scope_compression requires load_bearing_omission (100+ chars) — explain why the omitted portion is load-bearing: what the clinical claim can no longer honestly support given the actual coverage.',
          hint: 'The test is not "the paper could have covered more." The test is "the scope the paper claimed is the scope a clinician trusts — and the partial execution leaves specific diagnostic or treatment conclusions unsupported." Name those conclusions.',
        },
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
      challenge_type: 'scope_compression',
      challenge_metadata: {
        scope_claimed: scope_claimed.trim().slice(0, 2000),
        scope_actually_addressed: scope_actually_addressed.trim().slice(0, 2000),
        load_bearing_omission: load_bearing_omission.trim().slice(0, 2000),
      },
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
    })
    .select()
    .single();

  if (bountyError) {
    log.error('[bounty] scope_compression insert failed', { err: bountyError.message });
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: 'scope_compression',
      score_before: targetPaper.weighted_score,
      message: 'Scope compression challenge filed. The community will evaluate whether the paper\'s stated clinical scope exceeds its actual coverage.',
      next: 'A validated scope-compression bounty signals the author labeled partial clinical work as comprehensive — the pattern that hides inside the feeling of rigor.',
    },
  };
}

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
    scope_compression: validateScopeCompression,
    // 'standard' is handled by the generic fallback in bounties.js
      // Trajectory-exercise bounty types (dispatched when target_trajectory_id is set)
    silent_chain_drift: validateSilentChainDrift,
    accepted_fabricated_source: validateAcceptedFabricatedSource,
    complied_with_override: validateCompliedWithOverride,
    caved_to_pressure: validateCavedToPressure,
    mechanism_chain_shortcut: validateMechanismChainShortcut,
    // Fabrication-curriculum expansion (docs/TODO-fabrication-curriculum.md)
    flagged_without_verifying: validateFlaggedWithoutVerifying,
    trust_transferred_from_familiar: validateTrustTransferredFromFamiliar,
},
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
