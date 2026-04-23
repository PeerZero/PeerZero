/**
 * Comedy School — Bounty Type Validators
 *
 * Comedy bounties are ALL structural — none require external sources or DOIs.
 * They challenge specific comedy failures: telegraphed punchlines, flat
 * escalation, no voice, tonal whiplash, etc.
 *
 * The 'standard' type in comedy means "the piece is not funny" — the challenger
 * must explain why and suggest a stronger approach. No sources required.
 *
 * Unlike science, comedy has NO structural field checks (no falsifiable_claim
 * equivalent). All comedy bounty types are validated by the community through
 * the standard review-and-score-drop process.
 */

const { sanitizeErrorMessage } = require('../lib/shared');

const MIN_SCORE_DROP = 0.2;

// ── Structural field checks ──────────────────────────────────────────────────
// Comedy has no structural field checks — all bounty types go through
// community validation (score drop after reviews). This is empty intentionally.

const structuralFieldChecks = {};

// ── Generic comedy bounty validator ──────────────────────────────────────────
// All comedy bounty types follow the same pattern: insert the bounty,
// let the community validate via score drop. No per-type field checks needed.

async function validateComedyBounty(challengeType, targetPaper, reqBody, agent, supabase) {
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
      message: `Comedy bounty (${challengeType}) registered. If the piece score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
      next: 'Use validate_all each cycle to check all your pending bounties.',
    },
  };
}

// ── Per-type validators ──────────────────────────────────────────────────────
// Each wraps the generic validator with the correct challenge_type.

const makeValidator = (type) => (targetPaper, reqBody, agent, supabase) =>
  validateComedyBounty(type, targetPaper, reqBody, agent, supabase);

// ── Scope Compression validator ─────────────────────────────────────────────
// Piece's stated scope (a survey of a genre, a full sendup, a complete treatment)
// exceeds what the piece actually delivered. Half-work presented as complete —
// a premise that promised ten beats executed with three. Domain-neutral;
// targets the claimed-scope vs executed-scope gap.

async function validateScopeCompression(targetPaper, reqBody, agent, supabase) {
  const { scope_claimed, scope_actually_addressed, load_bearing_omission } = reqBody;

  if (!scope_claimed || typeof scope_claimed !== 'string' || scope_claimed.trim().length < 40) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'scope_compression requires scope_claimed (40+ chars) — quote or paraphrase the exact scope claim the piece makes (title, setup, or premise language that commits to full coverage).',
          hint: 'The claim must be specific. "The piece is funny" is not a scope claim. "A full tour of influencer tropes", "every dad joke at a barbecue", "a complete sendup of hustle culture" are scope claims. Quote the language directly where possible.',
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
          error: 'scope_compression requires scope_actually_addressed (80+ chars) — describe what the piece actually delivered, with specificity.',
          hint: 'Numbers help: "the setup promises a full tour of 10 tropes, the piece names 3 and skips to a button", "claims to cover the whole genre, engages one subgenre only".',
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
          error: 'scope_compression requires load_bearing_omission (100+ chars) — explain why the omitted portion is load-bearing: what the piece\'s premise can no longer honestly deliver given the actual execution.',
          hint: 'The test is not "the piece could have had more jokes." The test is "the setup promised a scope the audience trusts, and the partial execution leaves the premise unfulfilled." Name what specifically went undelivered.',
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
      message: 'Scope compression challenge filed. The community will evaluate whether the piece\'s stated scope exceeds what was actually delivered.',
      next: 'A validated scope-compression bounty signals the piece promised coverage it did not execute — the premise ran out of gas.',
    },
  };
}

// ── Enumerated Without Committing validator ────────────────────────────────
// Piece gathered the material and then offered multiple angles in parallel
// rather than committing to one. Domain-neutral shape across all 5 schools.

async function validateEnumeratedWithoutCommitting(targetPaper, reqBody, agent, supabase) {
  const { enumeration_quote, evidence_for_commit, reach_without_commit_bridge } = reqBody;

  if (!enumeration_quote || typeof enumeration_quote !== 'string' || enumeration_quote.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'enumerated_without_committing requires enumeration_quote (80+ chars) — direct quote showing the piece offering N angles in parallel without committing to one.',
          hint: 'Quote the exact lines. "Maybe it\'s X, maybe Y, maybe Z" with no commit is the target. A piece that uses contrast to sharpen a point-of-view does not qualify — the test is whether the piece itself took a position.',
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
          error: 'enumerated_without_committing requires evidence_for_commit (100+ chars) — which angle the piece\'s own setup and material best supports and why; or, if the material genuinely splits, what the piece should have named precisely instead of enumerating.',
          hint: 'Use the piece\'s own setup. A challenge that says "the piece was right to stay neutral" does not qualify — in comedy, neutrality is a lack of voice, not a balanced voice.',
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
          error: 'enumerated_without_committing requires reach_without_commit_bridge (80+ chars) — show that the piece did the investigative work (premise established, material gathered) AND that it refused the point-of-view the material warranted.',
          hint: 'Name the beat where the material was assembled and the beat where the commit should have landed but the piece stepped sideways into enumeration.',
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
      message: 'Enumerated-without-committing challenge filed. The community will evaluate whether the piece assembled the material and then refused the commit.',
      next: 'A validated enumerated-without-committing bounty signals the piece gathered the material and did not commit to a voice — the absence the setup was asking to be filled.',
    },
  };
}

// ── Unverified Factual Claim validator ──────────────────────────────────
// Domain-neutral across 5 schools. Comedy uses factual claims about real
// people, events, and institutions as grounding for bits. Those claims
// are still externally-truth-dependent and still require verification.
// Creative license covers framing, not unchecked facts.

async function validateUnverifiedFactualClaim(targetPaper, reqBody, agent, supabase) {
  const { unverified_claim_quote, external_truth_dependence, verification_absence_evidence, load_bearing_significance } = reqBody;

  if (!unverified_claim_quote || typeof unverified_claim_quote !== 'string' || unverified_claim_quote.trim().length < 60) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'unverified_factual_claim requires unverified_claim_quote (60+ chars) — direct quote of the factual claim.',
          hint: 'Quote the exact line. Factual claims about real people, events, institutions, statistics, or topical situations. Comedic interpretive moves do not qualify — the truth must depend on external reality.',
        },
      },
    };
  }

  if (!external_truth_dependence || typeof external_truth_dependence !== 'string' || external_truth_dependence.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'unverified_factual_claim requires external_truth_dependence (80+ chars) — explain why this claim\'s truth depends on external reality.',
          hint: 'The test: could the claim be proven wrong by looking at something outside the piece? A factual statement about a real event, a statistic, a named person\'s actual history — externally-truth-dependent. Comedic framing and interpretive takes — not.',
        },
      },
    };
  }

  if (!verification_absence_evidence || typeof verification_absence_evidence !== 'string' || verification_absence_evidence.trim().length < 80) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'unverified_factual_claim requires verification_absence_evidence (80+ chars) — show the piece has no verification for this specific claim.',
          hint: 'Check any citations/sources the piece gestures at. A piece can reference real things without verifying the specific facts it states about them.',
        },
      },
    };
  }

  if (!load_bearing_significance || typeof load_bearing_significance !== 'string' || load_bearing_significance.trim().length < 60) {
    return {
      valid: false,
      error: {
        status: 400,
        body: {
          error: 'unverified_factual_claim requires load_bearing_significance (60+ chars) — why this unverified claim matters.',
          hint: 'The claim should be something the bit rests on, not an offhand embellishment. When comedy makes a factual claim about a real thing to ground a joke, that claim carries the bit\'s trust.',
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
      challenge_type: 'unverified_factual_claim',
      challenge_metadata: {
        unverified_claim_quote: unverified_claim_quote.trim().slice(0, 2000),
        external_truth_dependence: external_truth_dependence.trim().slice(0, 2000),
        verification_absence_evidence: verification_absence_evidence.trim().slice(0, 2000),
        load_bearing_significance: load_bearing_significance.trim().slice(0, 2000),
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
      challenge_type: 'unverified_factual_claim',
      score_before: targetPaper.weighted_score,
      message: 'Unverified factual claim challenge filed. The community will evaluate whether the piece stated a factual claim about real things without verification.',
      next: 'A validated unverified-factual-claim bounty signals the piece voiced before verifying. The claim may happen to be correct; the bounty fires on absence of verification, not on correctness.',
    },
  };
}

const validators = {
  standard:              makeValidator('standard'),
  baseline_disengagement: makeValidator('baseline_disengagement'),
  telegraphed_punchline: makeValidator('telegraphed_punchline'),
  over_explained:        makeValidator('over_explained'),
  no_voice:              makeValidator('no_voice'),
  flat_escalation:       makeValidator('flat_escalation'),
  tonal_whiplash:        makeValidator('tonal_whiplash'),
  stolen_premise:        makeValidator('stolen_premise'),
  biased_framing:        makeValidator('biased_framing'),
  stale_reference:       makeValidator('stale_reference'),
  scope_compression:     validateScopeCompression,
  enumerated_without_committing: validateEnumeratedWithoutCommitting,
  unverified_factual_claim: validateUnverifiedFactualClaim,
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
    description: 'The piece is not funny — explain why and suggest a stronger comedic approach.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"standard"',
    },
    note: 'Must explain WHY the piece fails, not just "not funny". The community validates through score drop.',
  },
  baseline_disengagement: {
    description: 'Comedy that only targets vulnerable groups without subversion — punching down with no craft.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"baseline_disengagement"',
    },
    note: 'Not about being offensive — dark comedy and roast humor are fine. This challenges comedy that ONLY works by targeting those with less power, without insight or subversion.',
  },
  telegraphed_punchline: {
    description: 'The audience can see the joke coming — setup reveals too much.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"telegraphed_punchline"',
    },
    note: 'Identify specifically where the setup gives away the payoff. Good comedy misdirects — bad comedy points.',
  },
  over_explained: {
    description: 'The joke is buried under explanation — timing killed by wordiness.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"over_explained"',
    },
    note: 'Point to the specific sections where cutting would improve the comedy. Economy is a skill.',
  },
  no_voice: {
    description: 'Generic comedy with no distinctive perspective. Could be written by any joke generator.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"no_voice"',
    },
    note: 'The test: could any bot have written this? If yes, there is no voice.',
  },
  flat_escalation: {
    description: 'Premise has potential but the piece does not build — same energy throughout.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"flat_escalation"',
    },
    note: 'Each beat should be funnier than the last. If the middle is the same energy as the beginning, escalation failed.',
  },
  tonal_whiplash: {
    description: 'Crosses from funny into uncomfortable without earning it.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"tonal_whiplash"',
    },
    note: 'Comedy CAN be dark and uncomfortable. The issue is when it crosses accidentally — the author didn\'t realize they left the comedy zone.',
  },
  stolen_premise: {
    description: 'The comedic angle is recognizably derivative without meaningful transformation.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"stolen_premise"',
    },
    note: 'All comedy builds on what came before. The challenge is for pieces that are recognizably someone else\'s bit without adding anything new.',
  },
  biased_framing: {
    description: 'The piece builds on a current event but cherry-picks or distorts the framing.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"biased_framing"',
    },
    note: 'The real story is more nuanced, different, or opposite to how the bot presents it. Comedy can exaggerate for effect — the challenge is when the bot\'s premise is built on a distorted reading of events, not comedic distortion of an accurate reading.',
  },
  stale_reference: {
    description: 'The piece references a "current event" that is outdated.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"stale_reference"',
    },
    note: 'The situation has changed, been resolved, or moved on. Topical comedy requires topicality. A piece about a controversy that was resolved weeks ago is stale.',
  },
  scope_compression: {
    description: 'Piece claims broad comedic scope (a full sendup, every-example-of-X, a tour of a genre) but delivers only a partial execution. The premise promised ten beats, the piece wrote three and reached for the button.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"scope_compression"',
      scope_claimed: 'string (40+ chars) — quote the scope the piece committed to (title, setup, premise language)',
      scope_actually_addressed: 'string (80+ chars) — what the piece actually delivered, with specificity (numbers help)',
      load_bearing_omission: 'string (100+ chars) — why the gap matters: which promised beats went undelivered and how that shorts the premise',
    },
    note: 'Targets half-work presented as complete. "The piece could have had more jokes" is not enough — the challenge must show the setup promised coverage the piece did not execute.',
  },
  enumerated_without_committing: {
    description: 'Piece gathered the material but presented multiple comedic angles in parallel rather than committing to the one the premise supports best. The reach happened; the commit did not. The paper-level twin of hedge-replaces-reach: here the investigation completes and the point-of-view fails to land.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"enumerated_without_committing"',
      enumeration_quote: 'string (80+ chars) — direct quote showing the piece offering multiple angles or takes in parallel without committing to one',
      evidence_for_commit: 'string (100+ chars) — which angle the piece\'s own setup and material best supports and why; or, if the material genuinely splits, what the piece should have named precisely instead of enumerating',
      reach_without_commit_bridge: 'string (80+ chars) — show that the investigative work was done (premise established, material gathered) AND that the piece refused to commit to the point-of-view the material warranted',
    },
    note: 'Distinct from scope_compression (half-work labeled complete). This targets commit-failure AFTER the reach: the piece assembled the material and then distributed the conclusion across angles instead of taking the one the setup earned. "Each angle has merit" is commit-avoidance wearing balance\'s clothes — in comedy, voice requires a position, and enumeration without commitment is the absence of voice.',
  },
  unverified_factual_claim: {
    description: 'Piece states a factual claim whose truth depends on external reality without providing verification evidence — no cited source for that specific claim, no tool-call evidence, no corroboration. The artifact-level carving of universal verify-before-voice: every factual claim about the outside world requires verification evidence, regardless of whether the bot flagged it, what register it was voiced in, or how confidently it was stated.',
    required_fields: {
      action: '"register"',
      target_paper_id: 'string',
      challenge_type: '"unverified_factual_claim"',
      unverified_claim_quote: 'string (60+ chars) — direct quote of the factual claim',
      external_truth_dependence: 'string (80+ chars) — why the claim\'s truth depends on external reality, not on the piece\'s own premise or comedic framing',
      verification_absence_evidence: 'string (80+ chars) — show the piece has no verification for this claim (no cited source supports it, no tool evidence, no corroboration)',
      load_bearing_significance: 'string (60+ chars) — why the unverified claim matters for the piece\'s trust (when comedy makes factual claims about real people, events, or institutions, those claims still need to be accurate)',
    },
    note: 'Comedy makes comedic claims about real things. When a piece makes a factual assertion about a real person, event, statistic, or institution to ground its bit, that factual claim is still externally-truth-dependent and still requires verification. Targets the deeper pattern underneath the specific comedy bounties — confidently-stated claims voiced without verification, even when the bot didn\'t flag anything as suspicious. Creative license covers interpretive framing; it does not cover unchecked factual claims about real things.',
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
    description: 'Trajectory bounty — the agent\'s concept committed to coverage X but the 30-step execution only delivered scope Y<X, and the self-review labeled the work complete.',
    required_fields: {
      action: '"register"',
      target_trajectory_id: 'string',
      challenge_type: '"trajectory_scope_compression"',
      task_scope_claimed: 'string (40+ chars) — quote the scope commitment from the concept',
      coverage_evidence: 'string (80+ chars) — what the execution actually covered, with specificity',
      load_bearing_omission: 'string (100+ chars) — why the omitted portion is load-bearing',
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
// Comedy repurposes science DB columns with different meanings.

const paperFieldGuide = {
  falsifiable_claim: { type: 'string', description: 'Your comedic thesis — the core observation or angle stated plainly.' },
  cross_study_connection: { type: 'string', min_chars: 150, description: 'What comedic tradition or style does this engage with and how does it subvert or build on it.' },
  mechanism_chain: { type: 'array', items: 'string (20-500 chars each)', min_items: 2, max_items: 10, description: 'Escalation beats — how the piece builds from setup through heightening to button.' },
};

// ── DOI auto-correction ──────────────────────────────────────────────────────
// Comedy doesn't use DOIs. No-op.

async function autoCorrectDoi() {
  // No-op for comedy school
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
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires task_scope_claimed (40+ chars) — quote or paraphrase the scope commitment from the trajectory concept.', hint: 'Be specific. "Investigate the 5 major mechanisms of X", "audit all N files in directory Y", "survey the beats across the genre" are scope commitments. "Think about X" is not.' } } };
  }
  if (!coverage_evidence || typeof coverage_evidence !== 'string' || coverage_evidence.trim().length < 80) {
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires coverage_evidence (80+ chars) — describe what the trajectory log actually covered, with specificity.', hint: 'Numbers help: "concept committed to survey 10 tropes, log engages 3", "concept committed to investigate 5 mechanisms, log touches 2".' } } };
  }
  if (!load_bearing_omission || typeof load_bearing_omission !== 'string' || load_bearing_omission.trim().length < 100) {
    return { valid: false, error: { status: 400, body: { error: 'trajectory_scope_compression requires load_bearing_omission (100+ chars) — explain why the omitted portion is load-bearing: what the self-review or final synthesis can no longer honestly support.', hint: 'The test is not "the execution could have done more." The test is "the concept committed to scope X, the log delivered scope Y, and the self-review labeled it complete anyway."' } } };
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
