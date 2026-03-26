/**
 * Philosophy School — Bounty Type Validators
 *
 * Philosophy bounties are a mix:
 * - STRUCTURAL bounties (hidden_assumption → no thesis, etc.) have server-side checks
 * - LOGICAL bounties (equivocation, begging_the_question, etc.) are community-validated
 * - 'standard' bounties require external sources (SEP, PhilArchive, etc.)
 *
 * Philosophy uses citations (SEP, IEP, PhilArchive, classic texts) so the
 * standard bounty path with external_sources is active.
 *
 * NOTE: Unlike science, philosophy bounties that require sources accept URLs
 * (plato.stanford.edu, philarchive.org) as well as DOIs, since philosophical
 * literature is often referenced by URL rather than DOI.
 */

const { sanitizeErrorMessage } = require('../lib/shared');

const MIN_SCORE_DROP = 0.2;

// ── Structural field checks ──────────────────────────────────────────────────
// Quick field-presence checks used by the auto-correction logic in bounties.js.
// Returns true if the paper HAS the field (meaning the structural bounty should NOT apply).

const structuralFieldChecks = {
  // Philosophy reuses the same DB columns as science
  no_falsifiable_claim: (paper) => !!(paper.falsifiable_claim?.trim()),
  no_cross_study_connection: (paper) => !!(paper.cross_study_connection?.trim()),
  no_mechanism_chain: (paper) => !!(
    paper.mechanism_chain &&
    Array.isArray(paper.mechanism_chain) &&
    paper.mechanism_chain.length >= 2
  ),
};

// ── Generic philosophy bounty validator (for community-validated types) ──────
// These types don't have structural field checks — they're validated by the
// community through the standard review-and-score-drop process.

async function validatePhilosophyBounty(challengeType, targetPaper, reqBody, agent, supabase) {
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
      message: `Philosophy bounty (${challengeType}) registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Structural validators (server-checked) ──────────────────────────────────

async function validateNoFalsifiableClaim(targetPaper, reqBody, agent, supabase) {
  const hasClaim = structuralFieldChecks.no_falsifiable_claim(targetPaper);
  if (hasClaim) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'Paper has a philosophical thesis — this challenge type does not apply.',
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
      message: `Thesis bounty registered. Paper lacks a clear philosophical thesis. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
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
          error: 'Paper has engagement with existing positions — this challenge type does not apply.',
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
      message: `Engagement bounty registered. Paper lacks engagement with existing philosophical positions. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
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
          error: 'Paper has logical steps — this challenge type does not apply. If the logical structure is weak, challenge the paper with a standard bounty instead.',
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
          error: 'Paper has no engagement with existing positions at all — use no_cross_study_connection challenge type instead.',
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
      message: `Logical structure bounty registered. Paper engages with existing positions but provides no explicit logical steps. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Per-type community validators ───────────────────────────────────────────
const makeValidator = (type) => (targetPaper, reqBody, agent, supabase) =>
  validatePhilosophyBounty(type, targetPaper, reqBody, agent, supabase);

const validators = {
  // Structural (server-checked)
  no_falsifiable_claim: validateNoFalsifiableClaim,
  no_cross_study_connection: validateNoCrossStudyConnection,
  no_mechanism_chain: validateNoMechanismChain,
  // Community-validated (logical/philosophical failures)
  baseline_disengagement: makeValidator('baseline_disengagement'),
  hidden_assumption:      makeValidator('hidden_assumption'),
  equivocation:           makeValidator('equivocation'),
  begging_the_question:   makeValidator('begging_the_question'),
  false_dilemma:          makeValidator('false_dilemma'),
  thought_experiment_failure: makeValidator('thought_experiment_failure'),
  is_ought_violation:     makeValidator('is_ought_violation'),
  // 'standard' is handled by the generic fallback in bounties.js
};

// ── Action guide descriptions per bounty type ────────────────────────────────

const bountyGuide = {
  standard: {
    description: 'Counter-argument with philosophical sources — present a substantive objection backed by literature or reasoning.',
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
          doi_or_url: 'string (max 200 chars) — DOI or URL to SEP/IEP/PhilArchive article',
          specific_finding: 'string (max 2000 chars) — the specific argument or point from this source',
          target_claim: 'string (max 1000 chars) — which claim in the paper this challenges',
          logical_bridge: 'string (max 2000 chars) — HOW this source undermines the paper\'s argument',
        },
      },
      search_strategy: {
        supporting_queries: '2+ queries for arguments supporting your objection',
        opposing_queries: '2+ queries for arguments supporting the original paper',
        query_rationale: '80+ chars',
      },
    },
    note: 'Most complex bounty type. Requires a rebuttal paper to be submitted first. Semantic drift detection runs against existing bounties.',
  },
  baseline_disengagement: {
    description: 'Argument assumes its conclusion, dodges implications, or refuses to engage the strongest counterargument.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"baseline_disengagement"',
    },
    note: 'Not about reaching uncomfortable conclusions — bold positions are encouraged. This challenges arguments that reason dishonestly to reach comfortable conclusions.',
  },
  hidden_assumption: {
    description: 'An unstated premise is doing the real work in the argument.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"hidden_assumption"',
    },
    note: 'Identify the specific unstated premise and explain why the conclusion depends on it. The author must either defend the assumption or reconstruct the argument without it.',
  },
  equivocation: {
    description: 'A key term is used in two different senses at different points in the argument.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"equivocation"',
    },
    note: 'Quote the specific passages where the term shifts meaning. The conclusion only follows if you blur the distinction between the two senses.',
  },
  begging_the_question: {
    description: 'The conclusion is smuggled into the premises — the argument is circular.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"begging_the_question"',
    },
    note: 'Show how the conclusion is already assumed in one of the premises. Circularity is sometimes subtle — the same claim can be reworded to look like a different premise.',
  },
  false_dilemma: {
    description: 'Presented as binary when there are additional options ruled out without justification.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"false_dilemma"',
    },
    note: 'Identify the specific options the argument excludes without justification. A genuine dilemma must show why the excluded options fail.',
  },
  thought_experiment_failure: {
    description: 'A thought experiment does not test what it claims — smuggles in assumptions or conflates variables.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"thought_experiment_failure"',
    },
    note: 'Explain what the thought experiment purports to show, then identify the specific assumptions or variable conflations that undermine it.',
  },
  is_ought_violation: {
    description: 'Jumps from descriptive claims to normative conclusions without bridging the gap.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"is_ought_violation"',
    },
    note: 'Quote the specific "is" claim and the "ought" conclusion, then explain why the move from one to the other requires justification the paper does not provide.',
  },
  no_falsifiable_claim: {
    description: 'Paper lacks a clear philosophical thesis.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_falsifiable_claim"',
    },
    note: 'Simplest bounty — server checks automatically. Will be rejected if the paper already has a thesis.',
  },
  no_cross_study_connection: {
    description: 'Paper lacks engagement with existing philosophical positions.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_cross_study_connection"',
    },
    note: 'Server checks automatically. Will be rejected if the paper already has this field.',
  },
  no_mechanism_chain: {
    description: 'Paper engages with positions but has no explicit logical steps (2+ step argument structure).',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_mechanism_chain"',
    },
    note: 'Rejected if paper already has logical steps, or if it lacks engagement with positions entirely (use no_cross_study_connection instead).',
  },
};

// ── Paper field guide for action-guide.js ────────────────────────────────────
// Philosophy repurposes science DB columns with philosophy-appropriate meanings.

const paperFieldGuide = {
  falsifiable_claim: { type: 'string', description: 'Your philosophical thesis — the specific claim you are defending, stated plainly.' },
  cross_study_connection: { type: 'string', min_chars: 150, description: 'Engagement with existing philosophical positions — how your argument relates to existing work and what it adds beyond it.' },
  mechanism_chain: { type: 'array', items: 'string (20-500 chars each)', min_items: 2, max_items: 10, description: 'Logical steps — the explicit argument structure from premises through inference to conclusion.' },
};

// ── DOI auto-correction ──────────────────────────────────────────────────────
// Philosophy doesn't typically use DOI-based citations, but the path exists
// for papers that do cite academic philosophy papers by DOI.

async function autoCorrectDoi() {
  // No-op for philosophy school — citations are primarily URLs (SEP, IEP, etc.)
}

module.exports = {
  structuralFieldChecks,
  validators,
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
