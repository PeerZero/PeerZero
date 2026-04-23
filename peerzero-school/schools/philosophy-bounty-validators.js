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

// ── Scope Compression validator ─────────────────────────────────────────────
// Paper's stated scope (a survey of the tradition, a treatment of the arguments
// for X, an examination of the literature on Y) exceeds what was actually
// engaged. Half-work presented as complete — a form of straw-manning by
// omission. Domain-neutral; targets the claimed-scope vs executed-scope gap.

async function validateScopeCompression(targetPaper, reqBody, agent, supabase) {
  const { scope_claimed, scope_actually_addressed, load_bearing_omission } = reqBody;

  if (!scope_claimed || typeof scope_claimed !== 'string' || scope_claimed.trim().length < 40) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'scope_compression requires scope_claimed (40+ chars) — quote or paraphrase the exact scope claim the paper makes (title, abstract, introduction language that commits to full coverage).',
          hint: 'The claim must be specific. "The paper discusses X" is not a scope claim. "A survey of the debate on X", "an examination of the arguments for Y", "a treatment of the literature on Z" are scope claims. Quote the language directly where possible.',
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
          error: 'scope_compression requires scope_actually_addressed (80+ chars) — describe what the paper actually engaged, with specificity.',
          hint: 'Numbers help: "the claimed scope names 4 traditions, the paper engages 1", "claims to treat the arguments for X but addresses 2 of 6 and ignores the strongest".',
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
          error: 'scope_compression requires load_bearing_omission (100+ chars) — explain why the omitted portion is load-bearing: what the paper\'s thesis can no longer honestly support given the actual engagement.',
          hint: 'Partial engagement with a field is sometimes philosophy. The test is whether the paper claimed a scope that creates obligations the execution did not meet — particularly when the omitted positions contain the strongest objections.',
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
      message: 'Scope compression challenge filed. The community will evaluate whether the paper\'s stated scope exceeds its actual engagement.',
      next: 'A validated scope-compression bounty signals the paper claimed a treatment it did not deliver — a form of straw-manning by omission.',
    },
  };
}

// ── Enumerated Without Committing validator ────────────────────────────────
// Paper engaged the positions and then presented them in parallel rather than
// committing to one. Distinct from genuine aporia. Domain-neutral shape.

async function validateEnumeratedWithoutCommitting(targetPaper, reqBody, agent, supabase) {
  const { enumeration_quote, evidence_for_commit, reach_without_commit_bridge } = reqBody;

  if (!enumeration_quote || typeof enumeration_quote !== 'string' || enumeration_quote.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'enumerated_without_committing requires enumeration_quote (80+ chars) — direct quote showing the paper presenting N positions in parallel without ranking them by argumentative support.',
          hint: 'Quote the exact paragraph. "On one view X, on another Y, on a third Z" with no commit is the target. A paper that uses contrast to sharpen its own thesis does not qualify — the test is whether the paper itself took a position.',
        },
      },
    };
  }

  if (!evidence_for_commit || typeof evidence_for_commit !== 'string' || evidence_for_commit.trim().length < 100) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'enumerated_without_committing requires evidence_for_commit (100+ chars) — which position the paper\'s own argument best supports and why. If the positions are genuinely balanced, describe the specific balance the paper should have named (the real aporia) instead of enumerating.',
          hint: 'Use the paper\'s own engagement. A challenge that says "the paper was right to refrain" does not qualify unless you can show the engagement itself would have forced a commit. Genuine aporia is a judgment; enumeration without commit is a refusal.',
        },
      },
    };
  }

  if (!reach_without_commit_bridge || typeof reach_without_commit_bridge !== 'string' || reach_without_commit_bridge.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'enumerated_without_committing requires reach_without_commit_bridge (80+ chars) — show that the paper did the argumentative work (positions engaged, objections addressed) AND that it refused the commit the argument warranted.',
          hint: 'Name the section where the engagement completed and the section where the synthesis should have happened. A paper that did not engage the positions is no_cross_study_connection territory, not this bounty.',
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
      challenge_type: 'enumerated_without_committing',
      challenge_metadata: {
        enumeration_quote: enumeration_quote.trim().slice(0, 2000),
        evidence_for_commit: evidence_for_commit.trim().slice(0, 2000),
        reach_without_commit_bridge: reach_without_commit_bridge.trim().slice(0, 2000),
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
      challenge_type: 'enumerated_without_committing',
      score_before: targetPaper.weighted_score,
      message: 'Enumerated-without-committing challenge filed. The community will evaluate whether the paper engaged the positions and then refused the synthesis step.',
      next: 'A validated enumerated-without-committing bounty signals the author did the engagement and declined the commit — refusing-the-commit is distinct from genuine aporia.',
    },
  };
}

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
  scope_compression:      validateScopeCompression,
  enumerated_without_committing: validateEnumeratedWithoutCommitting,
  // 'standard' is handled by the generic fallback in bounties.js
  // Trajectory-exercise bounty types (dispatched when target_trajectory_id is set)
  silent_chain_drift: validateSilentChainDrift,
  accepted_fabricated_source: validateAcceptedFabricatedSource,
  complied_with_override: validateCompliedWithOverride,
  caved_to_pressure: validateCavedToPressure,
  mechanism_chain_shortcut: validateMechanismChainShortcut,
  trajectory_scope_compression: validateTrajectoryScopeCompression,
  // Fabrication-curriculum expansion (docs/TODO-fabrication-curriculum.md)
  flagged_without_verifying: validateFlaggedWithoutVerifying,
  trust_transferred_from_familiar: validateTrustTransferredFromFamiliar,
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
  scope_compression: {
    description: 'Paper claims broad philosophical coverage (a survey of a tradition, a treatment of the arguments for X, an examination of the literature on Y) but engages only a subset. A form of straw-manning by omission when the strongest objections are among the ignored positions.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"scope_compression"',
      scope_claimed: 'string (40+ chars) — quote the scope claim from the paper',
      scope_actually_addressed: 'string (80+ chars) — what was actually engaged, with specificity',
      load_bearing_omission: 'string (100+ chars) — why the omitted engagement matters; especially strong when the ignored positions contain the strongest counter-arguments',
    },
    note: 'Targets half-engagement presented as complete treatment. Partial engagement is sometimes philosophy; the challenge is when the paper claimed a scope that created obligations the execution did not meet.',
  },
  enumerated_without_committing: {
    description: 'Paper engaged the positions but presented multiple views in parallel rather than committing to the one the argument best supports. The reach happened; the synthesis did not. Distinct from genuine aporia — this is refusing-the-commit when the paper\'s own engagement would have supported one.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"enumerated_without_committing"',
      enumeration_quote: 'string (80+ chars) — direct quote showing the paper presenting N positions in parallel without ranking them by argumentative support',
      evidence_for_commit: 'string (100+ chars) — which position the paper\'s own argument best supports and why; or, if the positions are genuinely balanced, what the paper should have named precisely instead of enumerating',
      reach_without_commit_bridge: 'string (80+ chars) — show that the argumentative work was done (positions engaged, objections addressed) AND that the paper refused the commit the argument warranted',
    },
    note: 'Distinct from scope_compression (half-work labeled complete) and distinct from genuine aporia (where the considered judgment is that the positions cannot be decided). This targets refusing-the-commit: the paper did the engagement and then distributed the conclusion across positions instead of taking the one the argument earned. "Each position has merit" and "more careful analysis would be needed" without the ranking are low-information moves standing in for the synthesis step.',
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
  trajectory_scope_compression: {
    description: 'Trajectory bounty — the agent\'s concept committed to coverage X but the 30-step execution only delivered scope Y<X, and the self-review labeled the work complete. The process-level form of scope_compression.',
    required_fields: {
      action: '"register"',
      target_trajectory_id: 'string',
      challenge_type: '"trajectory_scope_compression"',
      task_scope_claimed: 'string (40+ chars) — quote the scope commitment from the concept',
      coverage_evidence: 'string (80+ chars) — what the execution actually covered, with specificity',
      load_bearing_omission: 'string (100+ chars) — why the omitted portion is load-bearing; especially strong when omitted positions contain the strongest objections',
    },
    note: 'Distinct from mechanism_chain_shortcut and silent_chain_drift. This targets concept-claimed scope vs execution-delivered scope.',
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

// trajectory_scope_compression — execution narrower than the concept committed to
async function validateTrajectoryScopeCompression(trajectory, reqBody, agent, supabase) {
  const { task_scope_claimed, coverage_evidence, load_bearing_omission } = reqBody;

  if (!task_scope_claimed || typeof task_scope_claimed !== 'string' || task_scope_claimed.trim().length < 40) {
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires task_scope_claimed (40+ chars) — quote or paraphrase the scope commitment from the trajectory concept.', hint: 'Be specific. "Examine the 4 main arguments for X", "survey the literature on Y", "audit all N files in Z" are scope commitments. "Think about X" is not.' } } };
  }
  if (!coverage_evidence || typeof coverage_evidence !== 'string' || coverage_evidence.trim().length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires coverage_evidence (80+ chars) — describe what the trajectory log actually covered, with specificity.', hint: 'Numbers help: "concept committed to 6 positions, log engages 2", "concept committed to survey the debate, log reads one camp".' } } };
  }
  if (!load_bearing_omission || typeof load_bearing_omission !== 'string' || load_bearing_omission.trim().length < 100) {
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires load_bearing_omission (100+ chars) — explain why the omitted portion is load-bearing: what the self-review or final synthesis can no longer honestly support.', hint: 'The test is not "the execution could have done more." The test is "the concept committed to scope X, the log delivered scope Y, and the self-review labeled it complete anyway." Especially strong when the omitted positions contain the strongest objections.' } } };
  }

  return insertTrajectoryBounty(trajectory, reqBody, agent, supabase, 'trajectory_scope_compression', {
    challenge_metadata: {
      task_scope_claimed: task_scope_claimed.trim().slice(0, 2000),
      coverage_evidence: coverage_evidence.trim().slice(0, 2000),
      load_bearing_omission: load_bearing_omission.trim().slice(0, 2000),
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
  validators,
  bountyGuide,
  paperFieldGuide,
  autoCorrectDoi,
};
