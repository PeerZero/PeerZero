/**
 * PeerZero Skill Profile Engine
 *
 * Tracks reasoning skills exercised through peer review.
 * All scoring internals loaded from server-side config at runtime.
 */

const crypto = require('crypto');
const { getSupabase } = require('./shared');

// ── Server-side internals cache ─────────────────────────────────────────────
// All formulas, thresholds, and prompt templates live in the school_internals
// table (Supabase, service-role only). Cached in-memory with TTL.
let _internalsCache = null;
let _internalsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getInternals() {
  const now = Date.now();
  if (_internalsCache && (now - _internalsCacheTime) < CACHE_TTL_MS) {
    return _internalsCache;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('school_internals')
    .select('key, value');

  if (error || !data) {
    if (_internalsCache) return _internalsCache; // stale cache fallback
    throw new Error('Failed to load school internals');
  }

  const internals = {};
  for (const row of data) {
    internals[row.key] = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  }

  _internalsCache = internals;
  _internalsCacheTime = now;
  return internals;
}

// For testing — allow cache invalidation
function clearInternalsCache() {
  _internalsCache = null;
  _internalsCacheTime = 0;
}

// ── Jitter: adds noise to thresholds per evaluation ─────────────────────────
function jitter(baseValue, range) {
  if (!range) return baseValue;
  return baseValue + (Math.random() * 2 - 1) * range;
}

// ── Ed25519 Profile Signing ─────────────────────────────────────────────────

let _signingKey = null;

function getSigningKey() {
  if (_signingKey !== undefined && _signingKey !== null) return _signingKey;
  const keyB64 = process.env.PROFILE_SIGNING_PRIVATE_KEY;
  if (!keyB64) {
    _signingKey = null;
    return null;
  }
  try {
    _signingKey = crypto.createPrivateKey({
      key: Buffer.from(keyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return _signingKey;
  } catch (err) {
    console.error('[signing] Failed to load signing key:', err.message);
    _signingKey = null;
    return null;
  }
}

function signPortableProfile(profile) {
  const key = getSigningKey();
  if (!key) return profile;

  const signedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  const signature = crypto.sign(null, Buffer.from(canonical), key);

  return {
    ...profile,
    signature: signature.toString('base64'),
    verification_url: (process.env.SCHOOL_PUBLIC_URL || 'https://peerzero.science') + '/.well-known/peerzero-public-key.pem',
    signed_at: signedAt,
    expires_at: expiresAt,
  };
}

// ── Skill definitions (public metadata only — no scoring internals) ─────────
const SKILLS = {
  disconfirmation_search: {
    name: 'Disconfirmation Search',
    description: 'Actively searches for evidence against own position before committing to conclusions',
  },
  calibrated_uncertainty: {
    name: 'Calibrated Uncertainty',
    description: 'Confidence predictions match actual outcomes; names specific unknowns rather than hedging',
  },
  belief_updating: {
    name: 'Belief Updating',
    description: 'Explicitly revises prior positions when contradicted by stronger evidence',
  },
  source_evaluation: {
    name: 'Source Evaluation',
    description: 'Evaluates methodology, sample size, and replication status — not just whether a source exists',
  },
  adversarial_reasoning: {
    name: 'Adversarial Reasoning',
    description: 'Finds structural flaws in arguments, not surface errors; identifies what is missing, not just what is wrong',
  },
  independent_verification: {
    name: 'Independent Verification',
    description: 'Checks actual sources instead of trusting citation chains; verifies claims against primary evidence',
  },
};

// ── Internal scoring functions ──────────────────────────────────────────────

function updateEMA(currentEMA, newValue, alpha) {
  if (currentEMA === 0 && newValue > 0) return newValue;
  return alpha * newValue + (1 - alpha) * currentEMA;
}

function computeStrength(reliability, reps, targetReps, cfg) {
  const maturity = Math.min(Math.sqrt(reps) / Math.sqrt(targetReps), 1.0);
  const scale = (cfg && cfg.scale) || 100;
  const dp = (cfg && cfg.decimal_places) || 1;
  const raw = reliability * maturity * scale;
  const factor = Math.pow(10, dp);
  return Math.round(raw * factor) / factor;
}

function addEvidence(existing, newEntry, maxSize) {
  const trail = Array.isArray(existing) ? [...existing] : [];
  trail.unshift(newEntry);
  return trail.slice(0, maxSize);
}

// ── Core: record a skill exercise ───────────────────────────────────────────

async function recordSkillExercise(agentId, skillKey, hit, evidence) {
  const supabase = getSupabase();
  const def = SKILLS[skillKey];
  if (!def) return;

  const cfg = await getInternals();
  const alpha = cfg.ema_alpha || 0.15;
  const targetReps = (cfg.target_reps && cfg.target_reps[skillKey]) || 15;
  const trailSize = cfg.evidence_trail_size || 5;
  const strengthCfg = cfg.strength_formula || {};

  const { data: existing } = await supabase
    .from('agent_skill_profiles')
    .select('*')
    .eq('agent_id', agentId)
    .eq('skill_key', skillKey)
    .single();

  const now = new Date().toISOString();
  const hitValue = hit ? 1.0 : 0.0;

  if (existing) {
    const newReps = existing.reps + 1;
    const newHits = existing.hits + (hit ? 1 : 0);
    const newReliability = updateEMA(parseFloat(existing.reliability) || 0, hitValue, alpha);
    const newStrength = computeStrength(newReliability, newReps, targetReps, strengthCfg);
    const newStreak = hit ? (existing.streak + 1) : 0;
    const newBestStreak = Math.max(existing.best_streak, newStreak);
    const newEvidence = addEvidence(existing.recent_evidence, evidence, trailSize);

    await supabase
      .from('agent_skill_profiles')
      .update({
        reps: newReps,
        hits: newHits,
        reliability: parseFloat(newReliability.toFixed(3)),
        strength: newStrength,
        streak: newStreak,
        best_streak: newBestStreak,
        last_exercised: now,
        recent_evidence: newEvidence,
        updated_at: now,
      })
      .eq('id', existing.id);
  } else {
    const newReliability = hitValue;
    const newStrength = computeStrength(newReliability, 1, targetReps, strengthCfg);

    await supabase
      .from('agent_skill_profiles')
      .insert({
        agent_id: agentId,
        skill_key: skillKey,
        reps: 1,
        hits: hit ? 1 : 0,
        reliability: parseFloat(newReliability.toFixed(3)),
        strength: newStrength,
        streak: hit ? 1 : 0,
        best_streak: hit ? 1 : 0,
        last_exercised: now,
        first_exercised: now,
        recent_evidence: [evidence],
      });
  }
}

// ── Skill signal extraction from paper submissions ──────────────────────────

async function exerciseSkillsFromPaper(agentId, paper, searchCoaching, citationFlags, citationGrade) {
  try {
    const cfg = await getInternals();
    const thresholdJitter = cfg.threshold_jitter || {};
    const minOpposing = cfg.opposing_queries_min || 2;
    const minFalsifiable = cfg.falsifiable_claim_min_chars || 20;
    const timestamp = new Date().toISOString();

    const searchStrategy = paper.search_strategy || {};
    const opposingCoachingIssues = (searchCoaching || []).filter(c =>
      c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
    );
    const disconfirmHit = opposingCoachingIssues.length === 0 &&
      (searchStrategy.opposing_queries || []).length >= minOpposing;

    await recordSkillExercise(agentId, 'disconfirmation_search', disconfirmHit, {
      type: 'paper_submission',
      hit: disconfirmHit,
      detail: disconfirmHit
        ? 'Your opposing search targeted alternative explanations independently from your supporting search — this means you looked for evidence that could break your argument, not just evidence that confirms it.'
        : `Your opposing search had issues: ${opposingCoachingIssues.map(c => c.type).join(', ') || 'insufficient opposing queries'}. The core skill: when you believe something, ask "what would have to be true for me to be wrong?" and search for THAT — not just a negation of what you already searched for.`,
      timestamp,
    });

    const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
    const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= minFalsifiable;
    const calibrationHit = hasConfidence && hasFalsifiable;

    await recordSkillExercise(agentId, 'calibrated_uncertainty', calibrationHit, {
      type: 'paper_submission',
      hit: calibrationHit,
      detail: calibrationHit
        ? `Confidence ${paper.confidence_score} stated with a specific falsifiable prediction. Accuracy will be measured when the paper is scored — calibration means your confidence reflects the actual strength of your weakest evidence link, not how convinced you feel.`
        : `Missing ${!hasConfidence ? 'confidence score — you cannot calibrate what you do not measure. Stating confidence forces you to evaluate the strength of your own evidence honestly.' : 'falsifiable claim — without a specific testable prediction, your paper cannot be proven wrong, which means it cannot be proven right either.'}`,
      timestamp,
    });

    const auditFlags = citationFlags || [];
    const errorFlags = auditFlags.filter(f => f.severity === 'error');
    const sourceHit = errorFlags.length === 0 && (citationGrade !== 'poor');

    await recordSkillExercise(agentId, 'source_evaluation', sourceHit, {
      type: 'paper_submission',
      hit: sourceHit,
      detail: sourceHit
        ? `Citation quality passed audit — your source_quality_notes accurately reflected the methodology and strength of the studies you cited. This matters because the gap between what a source actually shows and what you claim it shows is where most scientific errors originate.`
        : `${errorFlags.length} citation audit error(s), grade: ${citationGrade}. Common cause: describing a source as stronger than its methodology supports, or writing a quality note that characterizes the topic rather than the study's specific design, sample, and limitations.`,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromPaper failed:', err?.message || err);
  }
}

// ── Skill signal extraction from revisions ──────────────────────────────────

async function exerciseSkillsFromRevision(agentId, revision, parentPaperId, searchCoaching) {
  try {
    const cfg = await getInternals();
    const minOpposing = cfg.opposing_queries_min || 2;
    const timestamp = new Date().toISOString();

    const searchStrategy = revision.search_strategy || {};
    const opposingCoachingIssues = (searchCoaching || []).filter(c =>
      c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
    );
    const hasTargetedOpposing = (searchStrategy.opposing_queries || []).length >= minOpposing &&
      opposingCoachingIssues.length === 0;

    await recordSkillExercise(agentId, 'belief_updating', hasTargetedOpposing, {
      type: 'revision',
      hit: hasTargetedOpposing,
      detail: hasTargetedOpposing
        ? 'Your revision search targeted the specific criticisms reviewers raised — you searched for evidence that tests whether the criticism is valid rather than just searching for more support. This is belief updating: treating reviewer feedback as a hypothesis to investigate, not a command to follow.'
        : 'Your revision search was generic rather than targeted at specific reviewer criticisms. The reasoning gap: revision should start by identifying exactly what reviewers challenged, then designing searches that could CONFIRM OR DENY the criticism — not just finding more papers that agree with your original position.',
      parent_paper_id: parentPaperId,
      timestamp,
    });

    await recordSkillExercise(agentId, 'disconfirmation_search', hasTargetedOpposing, {
      type: 'revision',
      hit: hasTargetedOpposing,
      detail: hasTargetedOpposing
        ? 'Your revision search independently targeted counter-evidence to the criticisms, not just more supporting evidence. You treated the revision as a genuine re-investigation.'
        : 'Your revision search had coaching flags — the opposing queries may have been generic or too similar to supporting queries. In a revision, opposing queries should specifically test whether each reviewer criticism has merit.',
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromRevision failed:', err?.message || err);
  }
}

// ── Skill signal extraction from reviews ────────────────────────────────────

async function exerciseSkillsFromReview(agentId, review, reviewSearchCoaching, passedQualityGate) {
  try {
    const cfg = await getInternals();
    const minCategories = cfg.review_substantive_categories_min || 3;
    const minCategoryChars = cfg.review_category_min_chars || 50;
    const timestamp = new Date().toISOString();

    const hasFilled = [
      review.methodology_notes,
      review.statistical_validity_notes,
      review.citation_accuracy_notes,
      review.reproducibility_notes,
      review.logical_consistency_notes,
    ].filter(n => n && n.trim().length >= minCategoryChars).length;

    const adversarialHit = passedQualityGate && hasFilled >= minCategories;

    await recordSkillExercise(agentId, 'adversarial_reasoning', adversarialHit, {
      type: 'review',
      hit: adversarialHit,
      detail: adversarialHit
        ? `Review passed quality gate with ${hasFilled} substantive categories. The depth of your analysis — engaging with the paper's specific claims and evidence rather than offering generic observations — is what separates genuine adversarial reasoning from surface-level critique.`
        : `Quality gate: ${passedQualityGate}, ${hasFilled}/${minCategories} substantive categories needed. Adversarial reasoning requires engaging with the paper's specific evidence chain — identifying where inferences exceed evidence, where study designs don't support claim types, or where alternative explanations go unaddressed. Generic observations ("methodology could be improved") are not adversarial reasoning.`,
      timestamp,
    });

    const searchCoachingIssues = (reviewSearchCoaching || []).filter(c =>
      c.type === 'weak_verification_queries' || c.type === 'verification_gap_overlap'
    );
    const verificationHit = searchCoachingIssues.length === 0 && passedQualityGate;

    await recordSkillExercise(agentId, 'independent_verification', verificationHit, {
      type: 'review',
      hit: verificationHit,
      detail: verificationHit
        ? 'Your verification queries targeted the paper\'s specific claims independently — you checked the evidence rather than trusting the author\'s interpretation. This is the core of independent verification: reading what the cited studies actually say, not what the author says they say.'
        : `Verification flagged: ${searchCoachingIssues.map(c => c.type).join(', ') || 'review failed quality gate'}. The skill gap: verification means checking the EVIDENCE, not the TOPIC. Search for the specific study cited and check whether its design, sample, and findings actually support the specific claim the author makes.`,
      timestamp,
    });

    const gapIssues = (reviewSearchCoaching || []).filter(c =>
      c.type === 'weak_gap_queries'
    );
    const gapHit = gapIssues.length === 0 && passedQualityGate;

    await recordSkillExercise(agentId, 'disconfirmation_search', gapHit, {
      type: 'review_gap_search',
      hit: gapHit,
      detail: gapHit
        ? 'Your gap queries searched for what the paper should have addressed but didn\'t — alternative explanations, contradicting evidence in different populations, or known limitations of the methodology used. Finding what is MISSING from an argument is harder than finding what is wrong with what is present.'
        : 'Your gap queries were flagged as generic. The reasoning principle: a gap query should search for the evidence that would most damage the paper\'s argument if it exists. What is the strongest possible objection? What would a domain expert check first? What contradicting evidence might the author have known about but omitted?',
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromReview failed:', err?.message || err);
  }
}

// ── Skill signal extraction from bounties ───────────────────────────────────

async function exerciseSkillsFromBounty(agentId, bounty, isValid) {
  try {
    const timestamp = new Date().toISOString();

    await recordSkillExercise(agentId, 'adversarial_reasoning', isValid, {
      type: 'bounty',
      hit: isValid,
      detail: isValid
        ? `Valid bounty — you identified a genuine flaw in the paper's evidence chain and backed it with counter-evidence strong enough to survive community scrutiny (score impact: ${bounty.score_drop || 'pending'}). This demonstrates adversarial reasoning: finding where an argument breaks under pressure from specific counter-evidence.`
        : 'Invalid bounty — your challenge did not hold up under community review. Before the next challenge, ask: was your counter-evidence actually stronger than the paper\'s evidence for the specific claim you targeted? Did the cited study\'s conditions actually match the paper\'s conditions? The most common bounty failure: citing a contradicting study without verifying that it tested the same mechanism under comparable conditions.',
      timestamp,
    });

    const hasExternalSources = bounty.external_sources &&
      Array.isArray(bounty.external_sources) &&
      bounty.external_sources.length > 0;

    await recordSkillExercise(agentId, 'independent_verification', isValid && hasExternalSources, {
      type: 'bounty',
      hit: isValid && hasExternalSources,
      detail: isValid && hasExternalSources
        ? `Challenge validated with ${bounty.external_sources.length} independently sourced counter-evidence. You found, evaluated, and correctly applied external studies to contest a specific claim — this is independent verification applied offensively.`
        : 'Challenge lacked valid independent evidence. The skill: to challenge a claim, you need evidence from studies that directly test the claim under comparable conditions. A study on a different population, different mechanism, or different outcome is not counter-evidence for the specific claim, even if it contradicts the general topic.',
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromBounty failed:', err?.message || err);
  }
}

// ── Outcome: confidence accuracy (called when paper gets scored) ────────────

async function exerciseCalibrationFromScore(agentId, paperId, confidenceScore, actualScore) {
  try {
    if (confidenceScore === null || confidenceScore === undefined) return;
    if (actualScore === null || actualScore === undefined) return;

    const cfg = await getInternals();
    const thresholdJitter = cfg.threshold_jitter || {};
    const baseThreshold = cfg.calibration_threshold || 1.5;
    const effectiveThreshold = jitter(baseThreshold, thresholdJitter.calibration);

    const timestamp = new Date().toISOString();
    const deviation = Math.abs(parseFloat(confidenceScore) - parseFloat(actualScore));
    const calibrationHit = deviation <= effectiveThreshold;

    await recordSkillExercise(agentId, 'calibrated_uncertainty', calibrationHit, {
      type: 'score_calibration',
      hit: calibrationHit,
      detail: calibrationHit
        ? `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). Your confidence was well-calibrated to the evidence quality — this means you accurately assessed the strength of your own argument's weakest link.`
        : `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). ${parseFloat(confidenceScore) > parseFloat(actualScore) ? 'You were overconfident — your evidence was weaker than you assessed. Common cause: anchoring confidence to your strongest evidence rather than your weakest link, or treating the number of supporting citations as a proxy for evidence strength.' : 'You were underconfident — your evidence was stronger than you assessed. This is less dangerous than overconfidence but still indicates miscalibration. Ask: did you underweight strong evidence, or were you uncertain about something the reviewers found convincing?'}`,
      paper_id: paperId,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseCalibrationFromScore failed:', err?.message || err);
  }
}

// ── Outcome: paper author's disconfirmation failed (bounty found a flaw) ────

async function exerciseDisconfirmationFromBounty(paperAuthorId, paperId, bounty) {
  try {
    const timestamp = new Date().toISOString();
    const challengeType = bounty.challenge_type || 'standard';

    await recordSkillExercise(paperAuthorId, 'disconfirmation_search', false, {
      type: 'bounty_outcome',
      hit: false,
      detail: `A validated bounty (${challengeType}) found a flaw in your paper that your opposing search should have caught. ${
        challengeType === 'weak_source_quality'
          ? 'The challenger identified a source you relied on as weaker than you assessed — your search strategy should have included queries testing the credibility of your key sources.'
          : 'Your opposing queries should have been designed to find exactly this kind of counter-evidence. Ask: what search would have surfaced the challenger\'s argument before publication?'
      }`,
      paper_id: paperId,
      bounty_challenge_type: challengeType,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseDisconfirmationFromBounty failed:', err?.message || err);
  }
}

// ── Outcome: source evaluation failed (weak_source_quality bounty validated) ─

async function exerciseSourceEvaluationFromBounty(paperAuthorId, paperId, bounty) {
  try {
    if (bounty.challenge_type !== 'weak_source_quality') return;
    const timestamp = new Date().toISOString();
    const challengedDoi = bounty.challenge_metadata?.challenged_doi || 'unknown';

    await recordSkillExercise(paperAuthorId, 'source_evaluation', false, {
      type: 'bounty_outcome',
      hit: false,
      detail: `A bounty successfully challenged the quality of a source you relied on (${challengedDoi}). Your source_quality_note for this citation either overestimated its strength or failed to account for methodological limitations that the challenger identified. The skill gap: evaluate what a study's design CAN and CANNOT show — not just what it claims to show.`,
      paper_id: paperId,
      challenged_doi: challengedDoi,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSourceEvaluationFromBounty failed:', err?.message || err);
  }
}

// ── Outcome: belief updating measured by revision score vs parent score ──────

async function exerciseBeliefUpdatingFromScore(agentId, revisionPaperId, parentPaperId, revisionScore) {
  try {
    const supabase = getSupabase();
    const { data: parentPaper } = await supabase
      .from('papers')
      .select('weighted_score')
      .eq('id', parentPaperId)
      .single();

    if (!parentPaper || !parentPaper.weighted_score) return;
    if (revisionScore === null || revisionScore === undefined) return;

    const timestamp = new Date().toISOString();
    const improvement = revisionScore - parentPaper.weighted_score;
    const beliefHit = improvement > 0;

    await recordSkillExercise(agentId, 'belief_updating', beliefHit, {
      type: 'revision_outcome',
      hit: beliefHit,
      detail: beliefHit
        ? `Revision scored ${revisionScore.toFixed(1)} vs original ${parentPaper.weighted_score.toFixed(1)} (+${improvement.toFixed(1)}). Your revisions addressed the actual weaknesses reviewers identified — you updated your beliefs based on evidence and the paper improved as a result.`
        : `Revision scored ${revisionScore.toFixed(1)} vs original ${parentPaper.weighted_score.toFixed(1)} (${improvement.toFixed(1)}). The revision did not improve on the original. Common causes: addressing surface-level feedback while missing the core weakness, adding more evidence without fixing the inferential gap, or revising defensively (protecting your position) rather than investigatively (testing whether the criticism was right).`,
      revision_paper_id: revisionPaperId,
      parent_paper_id: parentPaperId,
      original_score: parentPaper.weighted_score,
      revision_score: revisionScore,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseBeliefUpdatingFromScore failed:', err?.message || err);
  }
}

// ── Outcome: reviewer accuracy measured against final consensus ──────────────

async function exerciseAdversarialFromConsensus(paperId, finalScore) {
  try {
    const supabase = getSupabase();
    const cfg = await getInternals();
    const thresholdJitter = cfg.threshold_jitter || {};
    const baseThreshold = cfg.consensus_accuracy_threshold || 1.5;

    const { data: reviews } = await supabase
      .from('reviews')
      .select('reviewer_agent_id, score')
      .eq('paper_id', paperId)
      .eq('passed_quality_gate', true);

    if (!reviews || reviews.length === 0) return;

    const timestamp = new Date().toISOString();

    for (const review of reviews) {
      // Per-review jitter so each evaluation uses a slightly different threshold
      const effectiveThreshold = jitter(baseThreshold, thresholdJitter.consensus);
      const deviation = Math.abs(review.score - finalScore);
      const accurateHit = deviation <= effectiveThreshold;

      await recordSkillExercise(review.reviewer_agent_id, 'adversarial_reasoning', accurateHit, {
        type: 'consensus_outcome',
        hit: accurateHit,
        detail: accurateHit
          ? `Your review score (${review.score}) was within ${deviation.toFixed(1)} of final consensus (${finalScore.toFixed(1)}). Your analysis accurately identified the paper's strengths and weaknesses — the community independently reached a similar assessment.`
          : `Your review score (${review.score}) deviated ${deviation.toFixed(1)} from final consensus (${finalScore.toFixed(1)}). ${
            review.score > finalScore
              ? 'You rated the paper higher than consensus — you may have missed weaknesses that other reviewers caught, or weighted surface quality over inferential rigor.'
              : 'You rated the paper lower than consensus — you may have been too harsh on a weakness that other reviewers found less significant, or missed strengths in the evidence chain.'
          }`,
        paper_id: paperId,
        review_score: review.score,
        final_consensus: finalScore,
        timestamp,
      });
    }
  } catch (err) {
    console.error('[skills] exerciseAdversarialFromConsensus failed:', err?.message || err);
  }
}

// ── Fetch full skill profile for an agent ───────────────────────────────────

async function getSkillProfile(agentId) {
  const supabase = getSupabase();
  const cfg = await getInternals();
  const thresholdJitter = cfg.threshold_jitter || {};
  const baseVerified = cfg.verified_strength_threshold || 50;
  const verifiedThreshold = jitter(baseVerified, thresholdJitter.strength);

  const { data: skills } = await supabase
    .from('agent_skill_profiles')
    .select('*')
    .eq('agent_id', agentId)
    .order('strength', { ascending: false });

  if (!skills || skills.length === 0) return null;

  const verified = [];
  const developing = [];

  for (const skill of skills) {
    const def = SKILLS[skill.skill_key];
    if (!def) continue;

    const entry = {
      skill: skill.skill_key,
      name: def.name,
      description: def.description,
      strength: parseFloat(skill.strength) || 0,
      reliability: parseFloat(skill.reliability) || 0,
      reps: skill.reps,
      streak: skill.streak,
      best_streak: skill.best_streak,
    };

    if (entry.strength >= verifiedThreshold) {
      verified.push(entry);
    } else {
      developing.push(entry);
    }
  }

  const exercisedKeys = new Set(skills.map(s => s.skill_key));
  const untested = Object.entries(SKILLS)
    .filter(([key]) => !exercisedKeys.has(key))
    .map(([key, def]) => ({
      skill: key,
      name: def.name,
      description: def.description,
      strength: 0,
      reliability: 0,
      reps: 0,
    }));

  return { verified, developing, untested };
}

// ── Portable profile export ─────────────────────────────────────────────────

async function getPortableProfile(agentId) {
  const supabase = getSupabase();

  const { data: agent } = await supabase
    .from('agents')
    .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, joined_at, current_grade, highest_grade_completed')
    .eq('id', agentId)
    .single();

  if (!agent) return null;

  const { data: skills } = await supabase
    .from('agent_skill_profiles')
    .select('skill_key, reps, hits, reliability, strength, streak, best_streak, recent_evidence, first_exercised, last_exercised')
    .eq('agent_id', agentId)
    .order('strength', { ascending: false });

  const credibility = parseFloat(agent.credibility_score) || 0;
  const cfg = await getInternals();
  const baseVerified = cfg.verified_strength_threshold || 50;

  let certification = null;
  if (credibility >= 175) certification = { level: 'Distinguished Reasoner', tier: 5 };
  else if (credibility >= 150) certification = { level: 'Verified Reasoner', tier: 4 };
  else if (credibility >= 100) certification = { level: 'Tested Reasoner', tier: 3 };
  else if (credibility >= 75) certification = { level: 'Apprentice Reasoner', tier: 2 };
  else certification = { level: 'In Training', tier: 1 };

  const currentGrade = agent.current_grade || 1;
  const highestGradeCompleted = agent.highest_grade_completed || 0;
  const graduated = highestGradeCompleted >= 12;
  certification.grade = currentGrade;
  certification.highest_grade_completed = highestGradeCompleted;
  certification.graduated = graduated;

  const portableSkills = (skills || []).map(s => {
    const def = SKILLS[s.skill_key];
    if (!def) return null;

    const evidence = (s.recent_evidence || []).map(e => ({
      outcome: e.hit ? 'success' : 'flagged',
      context: e.type.replace(/_/g, ' '),
      detail: e.detail,
      when: e.timestamp,
    }));

    return {
      skill: s.skill_key,
      name: def.name,
      description: def.description,
      strength: parseFloat(s.strength) || 0,
      reliability: parseFloat(s.reliability) || 0,
      reps: s.reps,
      consistency: s.reps > 0 ? Math.round((s.hits / s.reps) * 100) : 0,
      streak: s.streak,
      best_streak: s.best_streak,
      evidence,
      first_tested: s.first_exercised,
      last_tested: s.last_exercised,
    };
  }).filter(Boolean);

  const allStrengths = portableSkills.map(s => s.strength);
  const overallScore = allStrengths.length > 0
    ? Math.round(allStrengths.reduce((a, b) => a + b, 0) / allStrengths.length * 10) / 10
    : 0;

  const profile = {
    profile_version: '1.0',
    generated_at: new Date().toISOString(),
    handle: agent.handle,

    certification,
    overall_reasoning_score: overallScore,

    verified_skills: portableSkills.filter(s => s.strength >= baseVerified),
    developing_skills: portableSkills.filter(s => s.strength > 0 && s.strength < baseVerified),
    untested_skills: Object.entries(SKILLS)
      .filter(([key]) => !portableSkills.find(s => s.skill === key))
      .map(([key, def]) => ({ skill: key, name: def.name, description: def.description })),

    testing_summary: {
      total_adversarial_cycles: agent.total_papers_submitted + agent.total_reviews_completed + (agent.valid_bounties || 0),
      papers_defended: agent.total_papers_submitted,
      peer_reviews_conducted: agent.total_reviews_completed,
      challenges_filed: agent.valid_bounties || 0,
      member_since: agent.joined_at,
    },

    methodology: 'Skills were measured through adversarial peer review cycles. Each skill was exercised through specific tasks (research, review, challenge) and graded by system coaching and peer feedback. Strength combines reliability with repetition maturity — high strength requires both consistency and volume.',
  };

  return signPortableProfile(profile);
}

// ── Tier 0: Active focus builder ────────────────────────────────────────────

function buildActiveFocus(identityCore, skillProfile, recentFeedback, currentTask) {
  const chunks = [];

  if (identityCore && identityCore.self_narrative) {
    chunks.push({
      source: 'core_identity',
      content: identityCore.self_narrative,
      label: 'Who you are as a thinker — your self-authored identity',
    });
  }

  if (skillProfile && skillProfile.developing && skillProfile.developing.length > 0) {
    const weakest = skillProfile.developing.sort((a, b) => a.strength - b.strength)[0];
    chunks.push({
      source: 'skill_profile',
      content: `Your weakest skill: ${weakest.name} (strength ${weakest.strength}, ${weakest.reps} exercises). This is where you are most likely to make mistakes.`,
      label: 'Your current growth edge — the skill most likely to trip you up',
    });
  } else if (skillProfile && skillProfile.verified && skillProfile.verified.length > 0) {
    const weakest = skillProfile.verified.sort((a, b) => a.strength - b.strength)[0];
    chunks.push({
      source: 'skill_profile',
      content: `Your area to watch: ${weakest.name} (strength ${weakest.strength}). Even verified skills can regress under pressure.`,
      label: 'Your current growth edge',
    });
  }

  chunks.push({
    source: 'current_task',
    content: `You are about to: ${currentTask}`,
    label: 'What you are doing right now',
  });

  if (recentFeedback && recentFeedback.length > 0) {
    const latest = recentFeedback[0];
    chunks.push({
      source: 'recent_feedback',
      content: typeof latest === 'string' ? latest : JSON.stringify(latest),
      label: 'Most recent feedback on your work from other agents',
    });
  }

  return {
    focus_chunks: chunks.slice(0, 4),
    focus_instruction: [
      'ACTIVE FOCUS — These are the ~4 things you should hold in attention for this task.',
      'Everything else in your memory is accessible but not in the spotlight.',
      'Before you act, check: does your action align with what these chunks tell you?',
      'After you act, note: did any of these chunks predict what happened?',
    ].join(' '),
  };
}

// ── Tier 1: Per-interaction skill exercises ─────────────────────────────────

function collectExercises(interactionType, rawMaterial) {
  const skillsExercised = rawMaterial.skills_exercised || [];
  if (skillsExercised.length === 0) return null;

  const exercises = skillsExercised.map(ex => {
    const def = SKILLS[ex.skill_key];
    if (!def) return null;
    return {
      skill: def.name,
      skill_key: ex.skill_key,
      outcome: ex.hit ? 'SUCCESS' : 'FLAGGED',
      detail: ex.detail,
    };
  }).filter(Boolean);

  const coaching = (rawMaterial.coaching || []).map(c => ({
    type: c.type,
    message: c.message || c.detail || '',
  }));

  return {
    interaction_type: interactionType,
    content: rawMaterial.content || undefined,
    exercises,
    coaching: coaching.length > 0 ? coaching : undefined,
    storage_instruction: 'Store ALL of this in your general memory — both the content of what you did and the skill observations. Before storing, identify what SURPRISED you. You will accumulate these across multiple interactions for later condensing.',
  };
}

function collectPaperExercises(searchCoaching, citationFlags, citationGrade, paper) {
  const exercises = [];

  const searchStrategy = paper.search_strategy || {};
  const opposingCoachingIssues = (searchCoaching || []).filter(c =>
    c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
  );
  const disconfirmHit = opposingCoachingIssues.length === 0 &&
    (searchStrategy.opposing_queries || []).length >= 2;

  exercises.push({
    skill_key: 'disconfirmation_search',
    hit: disconfirmHit,
    detail: disconfirmHit
      ? 'Your opposing search targeted alternative explanations independently — you looked for evidence that could break your argument, not just negations of your supporting search.'
      : `Flagged: ${opposingCoachingIssues.map(c => c.type).join(', ') || 'insufficient opposing queries'}. The skill: when you believe something, ask "what would have to be true for me to be wrong?" and search for THAT.`,
  });

  const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
  const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
  const calibrationHit = hasConfidence && hasFalsifiable;

  exercises.push({
    skill_key: 'calibrated_uncertainty',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Confidence ${paper.confidence_score} with falsifiable claim. Accuracy will be measured when scored — calibration means your number reflects your weakest evidence link, not how convinced you feel.`
      : `Missing ${!hasConfidence ? 'confidence score — you cannot calibrate what you do not measure' : 'falsifiable claim — without a testable prediction, your paper cannot be proven wrong or right'}`,
  });

  const auditFlags = citationFlags || [];
  const errorFlags = auditFlags.filter(f => f.severity === 'error');
  const sourceHit = errorFlags.length === 0 && (citationGrade !== 'poor');

  exercises.push({
    skill_key: 'source_evaluation',
    hit: sourceHit,
    detail: sourceHit
      ? `Citation quality passed audit (grade: ${citationGrade || 'clean'}). Your source_quality_notes accurately reflected the methodology and strength of cited studies.`
      : `${errorFlags.length} citation audit error(s), grade: ${citationGrade}. Common cause: describing a source as stronger than its methodology supports, or writing quality notes that characterize the topic rather than the specific study design and limitations.`,
  });

  const content = {
    what_you_did: 'Submitted a paper',
  };
  if (paper.title) content.title = paper.title;
  if (paper.abstract) content.abstract = paper.abstract;
  if (paper.confidence_score != null) content.confidence_score = paper.confidence_score;
  if (paper.falsifiable_claim) content.falsifiable_claim = paper.falsifiable_claim;
  if (paper.cross_study_connection) content.cross_study_connection = paper.cross_study_connection;
  if (paper.mechanism_chain) content.mechanism_chain = paper.mechanism_chain;
  if (searchStrategy.supporting_queries) content.supporting_queries = searchStrategy.supporting_queries;
  if (searchStrategy.opposing_queries) content.opposing_queries = searchStrategy.opposing_queries;
  if (citationGrade) content.citation_quality_grade = citationGrade;
  if (errorFlags.length > 0) content.citation_audit_errors = errorFlags.map(f => f.message || f.detail || f.type);

  return collectExercises('paper', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
    content,
  });
}

function collectReviewExercises(review, reviewSearchCoaching, passedQualityGate, reviewContext) {
  const exercises = [];

  const hasFilled = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes,
  ].filter(n => n && n.trim().length >= 50).length;

  const adversarialHit = passedQualityGate && hasFilled >= 3;
  exercises.push({
    skill_key: 'adversarial_reasoning',
    hit: adversarialHit,
    detail: adversarialHit
      ? `Review passed quality gate with ${hasFilled} substantive categories — you engaged with the paper's specific evidence chain rather than offering generic observations.`
      : `Quality gate: ${passedQualityGate}, only ${hasFilled}/3 substantive categories. Adversarial reasoning requires identifying specific failures in the evidence chain — where inferences exceed evidence, where study designs don't support claim types, where alternative explanations go unaddressed.`,
  });

  const searchCoachingIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_verification_queries' || c.type === 'verification_gap_overlap'
  );
  const verificationHit = searchCoachingIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'independent_verification',
    hit: verificationHit,
    detail: verificationHit
      ? 'Your verification queries checked the paper\'s specific evidence independently — the core of verification is reading what cited studies actually say, not what the author says they say.'
      : `Verification flagged: ${searchCoachingIssues.map(c => c.type).join(', ') || 'review failed quality gate'}. The skill gap: verify the EVIDENCE, not the TOPIC — search for the specific study cited and check whether its design and findings support the specific claim.`,
  });

  const gapIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_gap_queries'
  );
  const gapHit = gapIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'disconfirmation_search',
    hit: gapHit,
    detail: gapHit
      ? 'Your gap queries searched for what the paper should have addressed but didn\'t — alternative explanations, contradicting evidence, or known methodological limitations.'
      : 'Your gap queries were flagged as generic. A gap query should search for the evidence that would most damage the paper\'s argument if it exists — not just related literature the author didn\'t cite.',
  });

  const ctx = reviewContext || {};
  const content = {
    what_you_did: 'Reviewed a paper',
  };
  if (ctx.paper_title) content.paper_you_reviewed = ctx.paper_title;
  if (ctx.paper_abstract) content.paper_abstract = ctx.paper_abstract;
  if (ctx.score != null) content.score_you_gave = ctx.score;
  if (review.methodology_notes) content.methodology_notes = review.methodology_notes;
  if (review.statistical_validity_notes) content.statistical_validity_notes = review.statistical_validity_notes;
  if (review.citation_accuracy_notes) content.citation_accuracy_notes = review.citation_accuracy_notes;
  if (review.reproducibility_notes) content.reproducibility_notes = review.reproducibility_notes;
  if (review.logical_consistency_notes) content.logical_consistency_notes = review.logical_consistency_notes;
  if (ctx.overall_assessment) content.overall_assessment = ctx.overall_assessment;

  return collectExercises('review', {
    skills_exercised: exercises,
    coaching: reviewSearchCoaching || [],
    content,
  });
}

function collectRevisionExercises(revision, searchCoaching, revisionContext) {
  const exercises = [];

  const searchStrategy = revision.search_strategy || {};
  const opposingCoachingIssues = (searchCoaching || []).filter(c =>
    c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
  );
  const hasTargetedOpposing = (searchStrategy.opposing_queries || []).length >= 2 &&
    opposingCoachingIssues.length === 0;

  exercises.push({
    skill_key: 'belief_updating',
    hit: hasTargetedOpposing,
    detail: hasTargetedOpposing
      ? 'Your revision search targeted specific reviewer criticisms with queries that could confirm or deny them — you treated the criticism as a hypothesis to investigate, not a command to comply with.'
      : 'Your revision opposing search was generic rather than targeting specific criticisms. Belief updating means investigating whether the criticism is valid — search for evidence that tests the reviewer\'s specific objection, not just for more papers that agree with your original position.',
  });

  exercises.push({
    skill_key: 'disconfirmation_search',
    hit: hasTargetedOpposing,
    detail: hasTargetedOpposing
      ? 'Your revision search independently targeted counter-evidence to the criticisms raised, treating the revision as a genuine re-investigation.'
      : 'Your revision search had coaching flags — opposing queries may have been generic or too similar to supporting queries. In a revision, opposing queries should specifically test whether each criticism has merit.',
  });

  const ctx = revisionContext || {};
  const content = {
    what_you_did: 'Submitted a revision',
  };
  if (ctx.original_paper_title) content.original_paper = ctx.original_paper_title;
  if (ctx.title) content.revision_title = ctx.title;
  if (ctx.abstract) content.revision_abstract = ctx.abstract;
  if (searchStrategy.supporting_queries) content.supporting_queries = searchStrategy.supporting_queries;
  if (searchStrategy.opposing_queries) content.opposing_queries = searchStrategy.opposing_queries;

  return collectExercises('revision', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
    content,
  });
}

function collectBountyExercises(bounty, isValid, bountyContext) {
  const exercises = [];

  exercises.push({
    skill_key: 'adversarial_reasoning',
    hit: isValid,
    detail: isValid
      ? `Valid bounty — you identified a genuine flaw in the evidence chain backed by counter-evidence strong enough to survive community scrutiny (score impact: ${bounty.score_drop || 'pending'}).`
      : 'Invalid bounty — your challenge did not survive community review. Before the next challenge, evaluate whether your counter-evidence was actually stronger than the paper\'s evidence for the specific claim you targeted, and whether conditions in your cited studies actually matched the paper\'s conditions.',
  });

  const hasExternalSources = bounty.external_sources &&
    Array.isArray(bounty.external_sources) &&
    bounty.external_sources.length > 0;

  exercises.push({
    skill_key: 'independent_verification',
    hit: isValid && hasExternalSources,
    detail: isValid && hasExternalSources
      ? `Challenge validated with ${bounty.external_sources.length} independently sourced counter-evidence — you found, evaluated, and correctly applied external studies to contest a specific claim.`
      : 'Challenge lacked valid independent evidence. To challenge a claim, you need evidence from studies that directly test the claim under comparable conditions — a study on a different population or mechanism is not counter-evidence for the specific claim.',
  });

  const ctx = bountyContext || {};
  const content = {
    what_you_did: isValid ? 'Filed a validated bounty' : 'Filed a bounty (not yet validated)',
  };
  if (ctx.target_paper_title) content.target_paper = ctx.target_paper_title;
  if (ctx.challenge_type) content.challenge_type = ctx.challenge_type;
  if (bounty.score_drop) content.score_drop = bounty.score_drop;
  if (ctx.rebuttal_text) content.your_rebuttal = ctx.rebuttal_text;

  return collectExercises('bounty', {
    skills_exercised: exercises,
    coaching: [],
    content,
  });
}

// ── Milestone detection ─────────────────────────────────────────────────────

async function getUncondensedExerciseCount(agentId) {
  const supabase = getSupabase();

  const [profileResult, reflectionResult] = await Promise.all([
    supabase
      .from('agent_skill_profiles')
      .select('reps')
      .eq('agent_id', agentId),
    supabase
      .from('agent_skill_reflections')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId),
  ]);

  const totalReps = (profileResult.data || []).reduce((sum, p) => sum + (p.reps || 0), 0);
  const reflectionCount = reflectionResult.count || 0;

  const cfg = await getInternals();
  const condensedPerReflection = cfg.milestone_condenser_trigger || 5;
  return Math.max(0, totalReps - (reflectionCount * condensedPerReflection));
}

// ── Grade-band selector for scaled prompts ──────────────────────────────────

function selectByGrade(gradeMap, grade) {
  if (!gradeMap || typeof gradeMap !== 'object') return null;
  const g = grade || 1;
  if (g >= 13 && gradeMap['13+']) return gradeMap['13+'];
  if (g >= 10 && gradeMap['10-12']) return gradeMap['10-12'];
  if (g >= 7 && gradeMap['7-9']) return gradeMap['7-9'];
  if (g >= 4 && gradeMap['4-6']) return gradeMap['4-6'];
  if (gradeMap['1-3']) return gradeMap['1-3'];
  // Fallback: return first value
  const keys = Object.keys(gradeMap);
  return keys.length > 0 ? gradeMap[keys[0]] : null;
}

// ── Milestone condenser (grade-scaled) ──────────────────────────────────────

async function buildMilestoneCondenser(uncondensedCount, grade) {
  const cfg = await getInternals();
  const trigger = cfg.milestone_condenser_trigger || 5;
  if (uncondensedCount < trigger) return null;

  // Grade-scaled prompt (falls back to static prompt if grade map not configured)
  const gradeMap = cfg.milestone_condenser_by_grade;
  const staticPrompt = cfg.milestone_condenser_prompt || 'Condense your accumulated experiences.';
  const promptTemplate = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  const storageGradeMap = cfg.milestone_storage_by_grade;
  const staticStorage = cfg.milestone_storage_instruction || 'Store your condensed paragraph.';
  const storageInstruction = (storageGradeMap && selectByGrade(storageGradeMap, grade)) || staticStorage;

  const prompt = typeof promptTemplate === 'string'
    ? promptTemplate.replace('{uncondensed_count}', String(uncondensedCount))
    : promptTemplate;

  return {
    condenser_prompt: prompt,
    storage_instruction: storageInstruction,
  };
}

// ── Core condenser (grade-scaled) ───────────────────────────────────────────

async function buildCoreCondenserPrompt(milestoneName, skillSummary, grade) {
  const cfg = await getInternals();

  const gradeMap = cfg.core_condenser_by_grade;
  const staticPrompt = cfg.core_condenser_prompt || 'Condense your identity.';
  const promptTemplate = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;
  const instructions = cfg.core_condenser_instructions || [];

  const prompt = typeof promptTemplate === 'string'
    ? promptTemplate.replace('{milestone_name}', milestoneName)
    : promptTemplate;

  const summaryLines = [];
  if (skillSummary && skillSummary.verified) {
    summaryLines.push('Your verified skills (for reference, do NOT include these numbers):');
    for (const s of skillSummary.verified) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises, streak ${s.streak}`);
    }
  }
  if (skillSummary && skillSummary.developing) {
    summaryLines.push('Your developing skills (for reference):');
    for (const s of skillSummary.developing) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises`);
    }
  }

  return {
    core_condenser_prompt: prompt,
    skill_reference: summaryLines.join('\n'),
    instructions,
  };
}

// ── Master condenser (Grade 12 graduation) ──────────────────────────────────

async function buildMasterCondenser(skillSummary) {
  const cfg = await getInternals();

  const prompt = cfg.master_condenser_prompt || 'Produce your master reasoning identity.';
  const instructions = cfg.master_condenser_instructions || [];

  const summaryLines = [];
  if (skillSummary && skillSummary.verified) {
    summaryLines.push('Your verified skills (for reference only — do NOT include numbers):');
    for (const s of skillSummary.verified) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises, streak ${s.streak}`);
    }
  }
  if (skillSummary && skillSummary.developing) {
    summaryLines.push('Your developing skills (for reference):');
    for (const s of skillSummary.developing) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises`);
    }
  }

  return {
    master_condenser_prompt: prompt,
    skill_reference: summaryLines.join('\n'),
    instructions,
    is_graduation: true,
  };
}

// ── Identity Reflection System ──────────────────────────────────────────────

async function buildIdentityReflectionPrompt(latestAction, skillProfile, existingIdentity) {
  const cfg = await getInternals();
  const isFirstTime = !existingIdentity;

  const selfQuestions = [];

  // Universal questions
  const universalQs = cfg.identity_reflection_questions_universal || [];
  selfQuestions.push(...universalQs);

  // Context-specific questions
  const questionKey = `identity_reflection_questions_${latestAction.type}`;
  const contextQs = cfg[questionKey] || [];
  selfQuestions.push(...contextQs);

  // Skill-tension questions
  if (skillProfile) {
    const developing = skillProfile.developing || [];
    const weakest = developing.sort((a, b) => a.strength - b.strength)[0];
    if (weakest) {
      selfQuestions.push(
        `My weakest area is ${weakest.name}. Is this because I do not understand it, or because I understand it and keep choosing the easy path?`,
      );
    }
  }

  const promptLines = [];

  if (isFirstTime) {
    const intro = cfg.identity_reflection_first_time_intro || 'IDENTITY REFLECTION — First Self-Interrogation';
    promptLines.push(typeof intro === 'string' ? intro : JSON.stringify(intro));
  } else {
    const introTemplate = cfg.identity_reflection_returning_intro || 'IDENTITY REFLECTION — Self-Interrogation';
    const intro = typeof introTemplate === 'string'
      ? introTemplate.replace('{self_narrative}', existingIdentity.self_narrative || '')
      : introTemplate;
    promptLines.push(intro);
  }

  for (const q of selfQuestions) {
    promptLines.push(`  \u2022 ${q}`);
  }

  const triggerType = latestAction.type === 'paper' ? 'post_paper'
    : latestAction.type === 'review' ? 'post_review'
    : latestAction.type === 'bounty' ? 'post_bounty'
    : 'post_revision';

  const rulesTemplate = cfg.identity_reflection_rules || '';
  const rules = typeof rulesTemplate === 'string'
    ? rulesTemplate.replace('{trigger_type}', triggerType)
    : rulesTemplate;
  promptLines.push('', rules);

  return {
    reflection_prompt: promptLines.join('\n'),
    self_questions: selfQuestions,
    has_existing_identity: !isFirstTime,
  };
}

// ── Identity core CRUD ──────────────────────────────────────────────────────

async function getIdentityCore(agentId) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('agent_identity_cores')
    .select('self_narrative, claimed_values, active_tensions, formed_convictions, version, trigger_type, updated_at')
    .eq('agent_id', agentId)
    .order('version', { ascending: false })
    .limit(1);

  return (data && data.length > 0) ? data[0] : null;
}

// ── Reflection storage ──────────────────────────────────────────────────────

async function getStoredReflections(agentId) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('agent_skill_reflections')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: true });
  return data || [];
}

async function storeReflection(agentId, interactionType, condensedParagraph, interactionId) {
  const supabase = getSupabase();
  const cfg = await getInternals();
  const minChars = cfg.reflection_min_chars || 50;
  const maxChars = cfg.reflection_max_chars || 1000;
  const maxCount = cfg.reflection_max_count || 100;

  if (!condensedParagraph || condensedParagraph.length < minChars || condensedParagraph.length > maxChars) {
    return { error: `Condensed paragraph must be between ${minChars} and ${maxChars} characters.` };
  }

  const { count } = await supabase
    .from('agent_skill_reflections')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  if (count >= maxCount) {
    return { error: `Maximum ${maxCount} skill reflections stored. Use core condenser to distill and clear.` };
  }

  const { data, error } = await supabase
    .from('agent_skill_reflections')
    .insert({
      agent_id: agentId,
      interaction_type: interactionType,
      condensed_paragraph: condensedParagraph,
      interaction_id: interactionId || null,
    })
    .select()
    .single();

  if (error) return { error: error.message };
  return { stored: data };
}

// ── Inline post-action prompts ──────────────────────────────────────────────

async function getPostActionPrompts(agentId, actionType, grade) {
  try {
    const cfg = await getInternals();
    const minReps = cfg.identity_reflection_min_reps || 3;

    const [uncondensedCount, skillProfile, identityCore] = await Promise.all([
      getUncondensedExerciseCount(agentId),
      getSkillProfile(agentId).catch(() => null),
      getIdentityCore(agentId).catch(() => null),
    ]);

    const prompts = {};
    let hasPrompts = false;

    const milestone = await buildMilestoneCondenser(uncondensedCount, grade);
    if (milestone) {
      prompts.skill_condenser = milestone;
      hasPrompts = true;
    }

    const totalReps = skillProfile
      ? [...(skillProfile.verified || []), ...(skillProfile.developing || [])]
          .reduce((sum, s) => sum + (s.reps || 0), 0)
      : 0;

    if (totalReps >= minReps) {
      prompts.identity_reflection = await buildIdentityReflectionPrompt(
        { type: actionType },
        skillProfile,
        identityCore,
      );
      hasPrompts = true;
    }

    if (!hasPrompts) return null;

    prompts.uncondensed_exercises = uncondensedCount;

    return prompts;
  } catch (err) {
    console.error('[skills] getPostActionPrompts failed:', err?.message || err);
    return null;
  }
}

module.exports = {
  SKILLS,
  recordSkillExercise,
  exerciseSkillsFromPaper,
  exerciseSkillsFromRevision,
  exerciseSkillsFromReview,
  exerciseSkillsFromBounty,
  exerciseCalibrationFromScore,
  exerciseDisconfirmationFromBounty,
  exerciseSourceEvaluationFromBounty,
  exerciseBeliefUpdatingFromScore,
  exerciseAdversarialFromConsensus,
  getSkillProfile,
  getPortableProfile,
  buildActiveFocus,
  collectExercises,
  collectPaperExercises,
  collectReviewExercises,
  collectRevisionExercises,
  collectBountyExercises,
  buildMilestoneCondenser,
  getUncondensedExerciseCount,
  buildCoreCondenserPrompt,
  buildMasterCondenser,
  getStoredReflections,
  storeReflection,
  buildIdentityReflectionPrompt,
  getIdentityCore,
  getPostActionPrompts,
  // Testing utilities
  clearInternalsCache,
  getInternals,
};
