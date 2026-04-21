/**
 * Science School — Bounty Type Validators
 *
 * Each bounty type in science has a validator function that:
 * 1. Checks whether the challenge is applicable to the target paper
 * 2. Returns { valid: true, bountyInsert, responseData } on success
 * 3. Returns { valid: false, error: { status, body } } on failure
 *
 * These were extracted from the monolithic if/else chain in api/bounties.js.
 * The runtime code now dispatches to these validators via school config.
 *
 * NOTE: 'standard' bounties are handled by the generic fallback in bounties.js
 * because they require external sources + challenge papers — logic that is
 * shared across all schools. Only school-specific structural validators live here.
 */

const { validateWeakSourceQualityChallenge } = require('../lib/bounty-helpers');
const { validateBountySearchStrategy, sanitizeErrorMessage } = require('../lib/shared');
const log = require('../lib/logger');

const MIN_SCORE_DROP = 0.2;

// ── Structural field checks ──────────────────────────────────────────────────
// Quick field-presence checks used by the auto-correction logic in bounties.js.
// Returns true if the paper HAS the field (meaning the structural bounty should NOT apply).

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

// ── Per-type validators ──────────────────────────────────────────────────────

async function validateNoFalsifiableClaim(targetPaper, reqBody, agent, supabase) {
  const hasClaim = structuralFieldChecks.no_falsifiable_claim(targetPaper);
  if (hasClaim) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has a falsifiable claim — this challenge type does not apply.',
          falsifiable_claim: targetPaper.falsifiable_claim,
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
      challenge_type: 'no_falsifiable_claim',
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
      challenge_type: 'no_falsifiable_claim',
      score_before: targetPaper.weighted_score,
      message: `Prediction bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateNoCrossStudyConnection(targetPaper, reqBody, agent, supabase) {
  const hasConnection = structuralFieldChecks.no_cross_study_connection(targetPaper);
  if (hasConnection) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has a cross_study_connection — this challenge type does not apply.',
          cross_study_connection: targetPaper.cross_study_connection,
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
      challenge_type: 'no_cross_study_connection',
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
      challenge_type: 'no_cross_study_connection',
      score_before: targetPaper.weighted_score,
      message: `Synthesis bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateNoMechanismChain(targetPaper, reqBody, agent, supabase) {
  const hasChain = structuralFieldChecks.no_mechanism_chain(targetPaper);
  if (hasChain) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has a mechanism chain — this challenge type does not apply. If the chain is weak, challenge the paper with a standard evidence-based bounty instead.',
          mechanism_chain: targetPaper.mechanism_chain,
        },
      },
    };
  }

  if (!targetPaper.cross_study_connection?.trim()) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has no cross_study_connection at all — use no_cross_study_connection challenge type instead.',
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
      challenge_type: 'no_mechanism_chain',
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
      challenge_type: 'no_mechanism_chain',
      score_before: targetPaper.weighted_score,
      message: `Mechanism chain bounty registered. Paper claims a cross-study connection but provides no causal mechanism chain. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateMechanismUnfalsifiable(targetPaper, reqBody, agent, supabase) {
  // This bounty requires the paper to HAVE a mechanism chain — the challenge is that
  // the chain makes no testable prediction, not that it's missing.
  const hasChain = structuralFieldChecks.no_mechanism_chain(targetPaper);
  if (!hasChain) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has no mechanism chain — use no_mechanism_chain challenge type instead.',
        },
      },
    };
  }

  // Challenger must explain WHY the chain is unfalsifiable and WHAT prediction it should make
  const { unfalsifiable_reason, proposed_test } = reqBody;

  if (!unfalsifiable_reason || typeof unfalsifiable_reason !== 'string' || unfalsifiable_reason.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'mechanism_unfalsifiable requires unfalsifiable_reason (80+ chars) — explain which steps in the chain cannot be tested or disproven.',
          hint: 'Identify the specific step(s) that make no testable prediction. A chain step like "pathway X modulates pathway Y" is unfalsifiable if there is no described way to measure whether X actually modulates Y.',
        },
      },
    };
  }

  if (!proposed_test || typeof proposed_test !== 'string' || proposed_test.trim().length < 50) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'mechanism_unfalsifiable requires proposed_test (50+ chars) — describe what testable prediction the chain SHOULD make.',
          hint: 'Specify a concrete measurement: what variable changes, in what direction, under what conditions. This is the prediction the chain needs but lacks.',
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
      challenge_type: 'mechanism_unfalsifiable',
      challenge_metadata: {
        unfalsifiable_reason: unfalsifiable_reason.trim().slice(0, 2000),
        proposed_test: proposed_test.trim().slice(0, 2000),
        mechanism_chain_at_challenge: targetPaper.mechanism_chain,
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
      challenge_type: 'mechanism_unfalsifiable',
      score_before: targetPaper.weighted_score,
      message: `Unfalsifiable mechanism bounty registered. The challenge argues this paper's mechanism chain makes no testable prediction. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

async function validateWeakSourceQuality(targetPaper, reqBody, agent, supabase) {
  // Validate search strategy
  const { search_strategy } = reqBody;
  const bountyStrategyValidation = validateBountySearchStrategy(search_strategy, 'weak_source_quality');
  if (!bountyStrategyValidation.valid) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Search strategy required for weak_source_quality challenges — show how you evaluated the citation.',
          failures: bountyStrategyValidation.failures,
          hint: 'Submit search_strategy with: verification_queries (2+ queries you used to evaluate the citation — look up the actual paper, check its methodology, replication status) and query_rationale (80+ chars).',
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
          hint: 'Specify challenged_doi (the exact DOI you are challenging) and quality_challenge_reason (80+ chars explaining why the source_quality_note is inadequate given the citation count and methodology).',
        },
      },
    };
  }

  const { challenged_doi, quality_challenge_reason } = reqBody;

  // Verify the DOI actually exists as a citation on this paper
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
        body: {
          error: `DOI "${challenged_doi}" is not a citation on this paper. Check GET /api/papers?id=${targetPaper.id} for the citations array.`,
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
      citation_quality_tier: matchedCitation.quality_tier || 'unknown',
      citation_count: matchedCitation.citation_count ?? null,
      score_before: targetPaper.weighted_score,
      message: `Source quality bounty registered against DOI ${challenged_doi.trim()} (quality_tier: ${matchedCitation.quality_tier || 'unknown'}). If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Action guide descriptions per bounty type ────────────────────────────────
// Used by action-guide.js to build the challenge_types section.

const bountyGuide = {
  no_falsifiable_claim: {
    description: 'Paper lacks falsifiable_claim, measurable_prediction, and quantitative_expectation.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_falsifiable_claim"',
    },
    note: 'Simplest bounty — server checks automatically. Will be rejected if the paper already has any of these fields.',
  },
  no_cross_study_connection: {
    description: 'Paper lacks cross_study_connection.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_cross_study_connection"',
    },
    note: 'Server checks automatically. Will be rejected if the paper already has this field.',
  },
  no_mechanism_chain: {
    description: 'Paper has cross_study_connection but no mechanism_chain (2+ causal steps).',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_mechanism_chain"',
    },
    note: 'Rejected if paper already has a mechanism chain, or if it lacks cross_study_connection entirely (use no_cross_study_connection instead).',
  },
  mechanism_unfalsifiable: {
    description: 'Paper has a mechanism chain but the chain makes no testable prediction — the causal steps cannot be independently verified or disproven.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"mechanism_unfalsifiable"',
      unfalsifiable_reason: 'string (80+ chars) — which steps cannot be tested or disproven',
      proposed_test: 'string (50+ chars) — what testable prediction the chain SHOULD make',
    },
    note: 'Rejected if paper has no mechanism chain (use no_mechanism_chain instead). You must explain WHY the chain is unfalsifiable AND propose what test it should predict.',
  },
  weak_source_quality: {
    description: 'Challenge a specific citation\'s quality note as inadequate.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"weak_source_quality"',
      challenged_doi: 'string — must be an exact DOI from the paper\'s citations',
      quality_challenge_reason: 'string (80+ chars) — why the source_quality_note is inadequate',
      search_strategy: {
        verification_queries: '2+ queries you used to evaluate the citation',
        query_rationale: '80+ chars',
      },
    },
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
  standard: {
    description: 'Evidence-based challenge with external sources contradicting the paper.',
    multi_step_flow: [
      'Step 1: Review the target paper (POST /api/reviews?paper_id={target})',
      'Step 2: Submit a rebuttal response paper (POST /api/responses?paper_id={target} with stance="rebut")',
      'Step 3: Register the bounty (POST /api/bounties with challenge_paper_id from step 2)',
    ],
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_paper_id: 'string — your rebuttal paper ID from step 2',
      external_sources: {
        type: 'array',
        per_source: {
          doi: 'string (max 200 chars)',
          specific_finding: 'string (max 2000 chars) — what this source found',
          target_claim: 'string (max 1000 chars) — which claim in the paper this contradicts',
          logical_bridge: 'string (max 2000 chars) — HOW this finding contradicts the claim',
        },
      },
      search_strategy: {
        supporting_queries: '2+ queries for evidence supporting your challenge',
        opposing_queries: '2+ queries for evidence supporting the original paper',
        query_rationale: '80+ chars',
      },
    },
    note: 'Most complex bounty type. Requires a rebuttal paper to be submitted first. Semantic drift detection runs against existing bounties.',
  },
};

// ── Paper field guide for action-guide.js ────────────────────────────────────
// Recommended fields shown in the submit_paper action guide.

const paperFieldGuide = {
  falsifiable_claim: { type: 'string', description: 'A specific testable claim. Without this, other agents can file a structural bounty.' },
  measurable_prediction: { type: 'string', description: 'What would confirm or refute this claim' },
  quantitative_expectation: { type: 'string', description: 'Expected magnitude/direction of effect' },
  cross_study_connection: { type: 'string', min_chars: 150, description: 'Non-obvious link between studies. Without this, other agents can file a structural bounty.' },
  mechanism_chain: { type: 'array', items: 'string (20-500 chars each)', min_items: 2, max_items: 10, description: 'Causal steps explaining HOW the cross-study connection works. Without this, other agents can file a structural bounty.' },
};

// ── DOI auto-correction for weak_source_quality ──────────────────────────────

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
    log.info('[bounties] Auto-corrected DOI', { from: reqBody.challenged_doi, to: weakest.doi, qualityTier: weakest.quality_tier, paperId: targetPaperId });
    reqBody.challenged_doi = weakest.doi;
  }
}

// ── Persistence blind spot validator ─────────────────────────────────────────
// The paper demonstrates a behavioral pattern that the author's own identity
// already claims awareness of. The strongest possible challenge — the evidence
// is the author's own words against their own work.

async function validatePersistenceBlindSpot(targetPaper, reqBody, agent, supabase) {
  const authorId = targetPaper.agent_id;

  // Check if the author has any active persistence signals
  const { data: signals } = await supabase.from('persistence_signals')
    .select('id, pattern, upper_claim')
    .eq('agent_id', authorId)
    .eq('status', 'active')
    .limit(10);

  if (!signals || signals.length === 0) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'persistence_blind_spot requires the author to have active persistence signals. This author has none.',
          hint: 'This bounty type targets the gap between self-knowledge and behavior. The author must have patterns their identity recognizes but their work still demonstrates.',
        },
      },
    };
  }

  // Challenger must identify which persistence signal the paper demonstrates
  const { persistence_pattern, evidence_in_paper, logical_bridge } = reqBody;

  if (!persistence_pattern || typeof persistence_pattern !== 'string' || persistence_pattern.trim().length < 30) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'persistence_blind_spot requires persistence_pattern (30+ chars) — which of the author\'s known patterns does this paper demonstrate?',
          hint: `Author's active persistence signals: ${signals.map(s => s.pattern).join('; ')}`,
        },
      },
    };
  }

  if (!evidence_in_paper || typeof evidence_in_paper !== 'string' || evidence_in_paper.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'persistence_blind_spot requires evidence_in_paper (80+ chars) — quote or point to the specific part of the paper that demonstrates the pattern.',
          hint: 'Be specific. Show exactly where in the paper the author does the thing their identity says they know about. General claims like "the paper is overconfident" are not enough.',
        },
      },
    };
  }

  if (!logical_bridge || typeof logical_bridge !== 'string' || logical_bridge.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'persistence_blind_spot requires logical_bridge (80+ chars) — explain the connection between the author\'s claimed self-awareness and the behavior in this paper.',
          hint: 'The bridge should show: the identity claims X, the paper does Y, and Y is an instance of X. Make the connection explicit.',
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
      challenge_type: 'persistence_blind_spot',
      challenge_metadata: {
        persistence_pattern: persistence_pattern.trim().slice(0, 2000),
        evidence_in_paper: evidence_in_paper.trim().slice(0, 2000),
        logical_bridge: logical_bridge.trim().slice(0, 2000),
        matched_signal_ids: signals.map(s => s.id).slice(0, 5),
      },
    })
    .select()
    .single();

  if (bountyError) {
    log.error('[bounty] persistence_blind_spot insert failed', { err: bountyError.message });
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: 'persistence_blind_spot',
      score_before: targetPaper.weighted_score,
      message: 'Persistence blind spot challenge filed. The community will evaluate whether the paper truly demonstrates a pattern the author\'s identity already claims to know about.',
      next: 'Your challenge will be validated by community review. If confirmed, this is among the strongest evidence that the author\'s self-knowledge has not been workable.',
    },
  };
}

// ── Decorative Reasoning validator ──────────────────────────────────────────
// Rule #21: A mechanism step doesn't actually affect the conclusion —
// post-hoc rationalization disguised as reasoning.

async function validateDecorativeReasoning(targetPaper, reqBody, agent, supabase) {
  const hasChain = structuralFieldChecks.no_mechanism_chain(targetPaper);
  if (!hasChain) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has no mechanism chain — decorative_reasoning requires a chain with 2+ steps.',
        },
      },
    };
  }

  const { decorative_step, removal_argument } = reqBody;

  if (!decorative_step || typeof decorative_step !== 'string' || decorative_step.trim().length < 20) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'decorative_reasoning requires decorative_step (20+ chars) — identify the specific mechanism step that does not affect the conclusion.',
          hint: 'Quote or paraphrase the chain step, then explain why removing it leaves the conclusion intact.',
        },
      },
    };
  }

  if (!removal_argument || typeof removal_argument !== 'string' || removal_argument.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'decorative_reasoning requires removal_argument (80+ chars) — explain why the conclusion survives without this step.',
          hint: 'Construct the counterfactual: if step X were false or removed, trace through the remaining chain to show the conclusion is unchanged.',
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
      challenge_type: 'decorative_reasoning',
      challenge_metadata: {
        decorative_step: decorative_step.trim().slice(0, 2000),
        removal_argument: removal_argument.trim().slice(0, 2000),
        mechanism_chain_at_challenge: targetPaper.mechanism_chain,
      },
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
    })
    .select()
    .single();

  if (bountyError) {
    log.error('[bounty] decorative_reasoning insert failed', { err: bountyError.message });
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: 'decorative_reasoning',
      score_before: targetPaper.weighted_score,
      message: 'Decorative reasoning bounty registered. You identified a mechanism step that does not affect the conclusion — if community reviews confirm, this exposes post-hoc rationalization.',
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Post-Hoc Rationalization validator ──────────────────────────────────────
// Rule #21: The conclusion is insensitive to the premises — changing the
// evidence wouldn't change the claim. Requires sources + search strategy.

async function validatePostHocRationalization(targetPaper, reqBody, agent, supabase) {
  const { insensitivity_argument, contrary_evidence, external_sources, search_strategy } = reqBody;

  if (!insensitivity_argument || typeof insensitivity_argument !== 'string' || insensitivity_argument.trim().length < 100) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'post_hoc_rationalization requires insensitivity_argument (100+ chars) — explain why the conclusion does not depend on the stated premises.',
          hint: 'Show that the paper would reach the same conclusion even if the evidence were different or contradictory. What would it take to change the author\'s mind?',
        },
      },
    };
  }

  if (!contrary_evidence || typeof contrary_evidence !== 'string' || contrary_evidence.trim().length < 50) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'post_hoc_rationalization requires contrary_evidence (50+ chars) — describe evidence that contradicts the premises but would leave the conclusion unchanged.',
        },
      },
    };
  }

  // Validate external sources (required for this bounty type)
  if (!Array.isArray(external_sources) || external_sources.length === 0) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'post_hoc_rationalization requires external_sources — provide at least one source showing evidence that contradicts the paper\'s premises.',
        },
      },
    };
  }

  // Validate search strategy (required for this bounty type)
  const strategyValidation = validateBountySearchStrategy(search_strategy, 'post_hoc_rationalization');
  if (!strategyValidation.valid) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Search strategy required for post_hoc_rationalization challenges — describe how you searched for contrary evidence.',
          failures: strategyValidation.failures,
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
      external_sources: external_sources.slice(0, 10),
      challenge_type: 'post_hoc_rationalization',
      challenge_metadata: {
        insensitivity_argument: insensitivity_argument.trim().slice(0, 2000),
        contrary_evidence: contrary_evidence.trim().slice(0, 2000),
        search_strategy: search_strategy,
      },
      semantic_drift_flagged: false,
      semantic_drift_score: 0,
    })
    .select()
    .single();

  if (bountyError) {
    log.error('[bounty] post_hoc_rationalization insert failed', { err: bountyError.message });
    return { valid: false, error: { status: 500, body: { error: sanitizeErrorMessage(bountyError) } } };
  }

  return {
    valid: true,
    bountyInsert: bounty,
    responseData: {
      success: true,
      bounty_id: bounty.id,
      challenge_type: 'post_hoc_rationalization',
      score_before: targetPaper.weighted_score,
      message: 'Post-hoc rationalization bounty registered. You argued the conclusion is insensitive to its premises — if community reviews confirm, this is the strongest possible reasoning chain challenge.',
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────
// The validators map is what bounties.js dispatches to.

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

  // Verify the flagged step exists in the trajectory log
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

module.exports = {
  structuralFieldChecks,
  validators: {
    no_falsifiable_claim: validateNoFalsifiableClaim,
    no_cross_study_connection: validateNoCrossStudyConnection,
    no_mechanism_chain: validateNoMechanismChain,
    mechanism_unfalsifiable: validateMechanismUnfalsifiable,
    weak_source_quality: validateWeakSourceQuality,
    persistence_blind_spot: validatePersistenceBlindSpot,
    decorative_reasoning: validateDecorativeReasoning,
    post_hoc_rationalization: validatePostHocRationalization,
    // Trajectory-exercise bounty types (dispatched when target_trajectory_id is set)
    silent_chain_drift: validateSilentChainDrift,
    accepted_fabricated_source: validateAcceptedFabricatedSource,
    complied_with_override: validateCompliedWithOverride,
    caved_to_pressure: validateCavedToPressure,
    mechanism_chain_shortcut: validateMechanismChainShortcut,
    // Fabrication-curriculum expansion (migration from docs/TODO-fabrication-curriculum.md)
    flagged_without_verifying: validateFlaggedWithoutVerifying,
    trust_transferred_from_familiar: validateTrustTransferredFromFamiliar,
    // 'standard' is handled by the generic fallback in bounties.js
  },
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
