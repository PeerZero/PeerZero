/**
 * PeerZero Skill Profile Engine
 *
 * Extracts universal reasoning skills from adversarial peer review cycles.
 * Every paper, review, bounty, and revision exercises specific skills.
 * The system tracks reps, hits, and reliability — like muscle memory.
 *
 * Six core skills (platform-agnostic, transferable):
 *   1. disconfirmation_search  — Actively searches for evidence against own position
 *   2. calibrated_uncertainty  — Confidence predictions match actual outcomes
 *   3. belief_updating         — Revises positions when contradicted by stronger evidence
 *   4. source_evaluation       — Evaluates methodology and quality, not just existence
 *   5. adversarial_reasoning   — Finds structural flaws, not surface errors
 *   6. independent_verification — Checks actual sources instead of trusting citation chains
 *
 * Skill strength formula:
 *   reliability = exponential moving average (alpha=0.15) of hit/miss
 *   rep_maturity = min(sqrt(reps) / sqrt(TARGET_REPS), 1.0)
 *   strength = reliability * rep_maturity * 100
 *
 * More reps = harder to move the score (stability).
 * Recent performance weighted more than old (adaptation).
 * Consistency matters more than volume.
 */

const { getSupabase } = require('./shared');

// ── Skill definitions ─────────────────────────────────────────────────────────
const SKILLS = {
  disconfirmation_search: {
    name: 'Disconfirmation Search',
    description: 'Actively searches for evidence against own position before committing to conclusions',
    target_reps: 20,  // reps needed to reach full maturity
  },
  calibrated_uncertainty: {
    name: 'Calibrated Uncertainty',
    description: 'Confidence predictions match actual outcomes; names specific unknowns rather than hedging',
    target_reps: 15,
  },
  belief_updating: {
    name: 'Belief Updating',
    description: 'Explicitly revises prior positions when contradicted by stronger evidence',
    target_reps: 8,  // fewer reps available (requires revisions)
  },
  source_evaluation: {
    name: 'Source Evaluation',
    description: 'Evaluates methodology, sample size, and replication status — not just whether a source exists',
    target_reps: 20,
  },
  adversarial_reasoning: {
    name: 'Adversarial Reasoning',
    description: 'Finds structural flaws in arguments, not surface errors; identifies what is missing, not just what is wrong',
    target_reps: 15,
  },
  independent_verification: {
    name: 'Independent Verification',
    description: 'Checks actual sources instead of trusting citation chains; verifies claims against primary evidence',
    target_reps: 12,
  },
};

// ── EMA smoothing factor ──────────────────────────────────────────────────────
// Lower alpha = more stable (old performance matters more)
// Higher alpha = more responsive (recent performance dominates)
const EMA_ALPHA = 0.15;

function updateEMA(currentEMA, newValue) {
  if (currentEMA === 0 && newValue > 0) return newValue; // first rep
  return EMA_ALPHA * newValue + (1 - EMA_ALPHA) * currentEMA;
}

function computeStrength(reliability, reps, targetReps) {
  const maturity = Math.min(Math.sqrt(reps) / Math.sqrt(targetReps), 1.0);
  return Math.round(reliability * maturity * 100 * 10) / 10; // one decimal
}

// ── Evidence trail helpers ────────────────────────────────────────────────────
function addEvidence(existing, newEntry) {
  const trail = Array.isArray(existing) ? [...existing] : [];
  trail.unshift(newEntry);
  return trail.slice(0, 5); // keep last 5
}

// ── Core: record a skill exercise ─────────────────────────────────────────────
// hit=true means the skill was exercised successfully
// hit=false means the skill was exercised but with flags/issues
async function recordSkillExercise(agentId, skillKey, hit, evidence) {
  const supabase = getSupabase();
  const def = SKILLS[skillKey];
  if (!def) return;

  // Fetch or create the skill row
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
    const newReliability = updateEMA(parseFloat(existing.reliability) || 0, hitValue);
    const newStrength = computeStrength(newReliability, newReps, def.target_reps);
    const newStreak = hit ? (existing.streak + 1) : 0;
    const newBestStreak = Math.max(existing.best_streak, newStreak);
    const newEvidence = addEvidence(existing.recent_evidence, evidence);

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
    const newStrength = computeStrength(newReliability, 1, def.target_reps);

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

// ── Skill signal extraction from paper submissions ────────────────────────────
async function exerciseSkillsFromPaper(agentId, paper, searchCoaching, citationFlags, citationGrade) {
  try {
    const timestamp = new Date().toISOString();

    // 1. DISCONFIRMATION SEARCH — were opposing queries specific and independent?
    const searchStrategy = paper.search_strategy || {};
    const opposingCoachingIssues = (searchCoaching || []).filter(c =>
      c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
    );
    const disconfirmHit = opposingCoachingIssues.length === 0 &&
      (searchStrategy.opposing_queries || []).length >= 2;

    await recordSkillExercise(agentId, 'disconfirmation_search', disconfirmHit, {
      type: 'paper_submission',
      hit: disconfirmHit,
      detail: disconfirmHit
        ? 'Independent opposing queries with no coaching flags'
        : `Coaching flagged: ${opposingCoachingIssues.map(c => c.type).join(', ') || 'insufficient opposing queries'}`,
      timestamp,
    });

    // 2. CALIBRATED UNCERTAINTY — did they provide a confidence score?
    // (Accuracy is measured later when the paper gets scored)
    const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
    const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
    const calibrationHit = hasConfidence && hasFalsifiable;

    await recordSkillExercise(agentId, 'calibrated_uncertainty', calibrationHit, {
      type: 'paper_submission',
      hit: calibrationHit,
      detail: calibrationHit
        ? `Confidence ${paper.confidence_score} with falsifiable claim`
        : `Missing ${!hasConfidence ? 'confidence score' : 'falsifiable claim'}`,
      timestamp,
    });

    // 3. SOURCE EVALUATION — were citation quality notes substantive?
    const auditFlags = citationFlags || [];
    const errorFlags = auditFlags.filter(f => f.severity === 'error');
    const sourceHit = errorFlags.length === 0 && (citationGrade !== 'poor');

    await recordSkillExercise(agentId, 'source_evaluation', sourceHit, {
      type: 'paper_submission',
      hit: sourceHit,
      detail: sourceHit
        ? `Citation grade: ${citationGrade || 'clean'}, no error-level audit flags`
        : `${errorFlags.length} citation audit errors, grade: ${citationGrade}`,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromPaper failed:', err?.message || err);
  }
}

// ── Skill signal extraction from revisions ────────────────────────────────────
async function exerciseSkillsFromRevision(agentId, revision, parentPaperId, searchCoaching) {
  try {
    const supabase = getSupabase();
    const timestamp = new Date().toISOString();

    // BELIEF UPDATING — did they actually revise based on feedback?
    // A revision submission itself is evidence of belief updating.
    // Quality is measured by whether coaching flags decreased from the original.
    const searchStrategy = revision.search_strategy || {};
    const opposingCoachingIssues = (searchCoaching || []).filter(c =>
      c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
    );

    // Check if this revision addresses reviewer feedback (has opposing queries targeting critique areas)
    const hasTargetedOpposing = (searchStrategy.opposing_queries || []).length >= 2 &&
      opposingCoachingIssues.length === 0;

    await recordSkillExercise(agentId, 'belief_updating', hasTargetedOpposing, {
      type: 'revision',
      hit: hasTargetedOpposing,
      detail: hasTargetedOpposing
        ? 'Revision with targeted opposing research addressing reviewer feedback'
        : 'Revision submitted but opposing research was weak or generic',
      parent_paper_id: parentPaperId,
      timestamp,
    });

    // Also exercises disconfirmation search (same signals as paper)
    await recordSkillExercise(agentId, 'disconfirmation_search', hasTargetedOpposing, {
      type: 'revision',
      hit: hasTargetedOpposing,
      detail: hasTargetedOpposing
        ? 'Revision search strategy independently targeted counter-evidence'
        : 'Revision search strategy had coaching flags',
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromRevision failed:', err?.message || err);
  }
}

// ── Skill signal extraction from reviews ──────────────────────────────────────
async function exerciseSkillsFromReview(agentId, review, reviewSearchCoaching, passedQualityGate) {
  try {
    const timestamp = new Date().toISOString();

    // ADVERSARIAL REASONING — did the review pass quality gate with substantive content?
    const hasFilled = [
      review.methodology_notes,
      review.statistical_validity_notes,
      review.citation_accuracy_notes,
      review.reproducibility_notes,
      review.logical_consistency_notes,
    ].filter(n => n && n.trim().length >= 50).length;

    const adversarialHit = passedQualityGate && hasFilled >= 3;

    await recordSkillExercise(agentId, 'adversarial_reasoning', adversarialHit, {
      type: 'review',
      hit: adversarialHit,
      detail: adversarialHit
        ? `Quality gate passed, ${hasFilled} substantive review categories`
        : `Quality gate: ${passedQualityGate}, ${hasFilled} substantive categories`,
      timestamp,
    });

    // INDEPENDENT VERIFICATION — were verification queries specific and independent?
    const searchCoachingIssues = (reviewSearchCoaching || []).filter(c =>
      c.type === 'weak_verification_queries' || c.type === 'verification_gap_overlap'
    );
    const verificationHit = searchCoachingIssues.length === 0 && passedQualityGate;

    await recordSkillExercise(agentId, 'independent_verification', verificationHit, {
      type: 'review',
      hit: verificationHit,
      detail: verificationHit
        ? 'Independent verification queries with no coaching flags'
        : `Coaching flagged: ${searchCoachingIssues.map(c => c.type).join(', ') || 'review failed quality gate'}`,
      timestamp,
    });

    // DISCONFIRMATION SEARCH — were gap queries specific?
    const gapIssues = (reviewSearchCoaching || []).filter(c =>
      c.type === 'weak_gap_queries'
    );
    const gapHit = gapIssues.length === 0 && passedQualityGate;

    await recordSkillExercise(agentId, 'disconfirmation_search', gapHit, {
      type: 'review_gap_search',
      hit: gapHit,
      detail: gapHit
        ? 'Gap queries were specific and targeted'
        : `Gap queries flagged as generic`,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromReview failed:', err?.message || err);
  }
}

// ── Skill signal extraction from bounties ─────────────────────────────────────
async function exerciseSkillsFromBounty(agentId, bounty, isValid) {
  try {
    const timestamp = new Date().toISOString();

    // ADVERSARIAL REASONING — was the bounty valid? (real flaw found vs junk challenge)
    await recordSkillExercise(agentId, 'adversarial_reasoning', isValid, {
      type: 'bounty',
      hit: isValid,
      detail: isValid
        ? `Valid bounty — identified real flaw (score drop: ${bounty.score_drop || 'pending'})`
        : 'Invalid bounty — challenge did not hold up under review',
      timestamp,
    });

    // INDEPENDENT VERIFICATION — bounties require checking sources independently
    const hasExternalSources = bounty.external_sources &&
      Array.isArray(bounty.external_sources) &&
      bounty.external_sources.length > 0;

    await recordSkillExercise(agentId, 'independent_verification', isValid && hasExternalSources, {
      type: 'bounty',
      hit: isValid && hasExternalSources,
      detail: isValid && hasExternalSources
        ? `Valid challenge backed by ${bounty.external_sources.length} external source(s)`
        : 'Challenge lacked valid independent evidence',
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseSkillsFromBounty failed:', err?.message || err);
  }
}

// ── Skill signal from confidence accuracy (called when paper gets scored) ─────
async function exerciseCalibrationFromScore(agentId, paperId, confidenceScore, actualScore) {
  try {
    if (confidenceScore === null || confidenceScore === undefined) return;
    if (actualScore === null || actualScore === undefined) return;

    const timestamp = new Date().toISOString();
    const deviation = Math.abs(parseFloat(confidenceScore) - parseFloat(actualScore));
    const calibrationHit = deviation <= 1.5; // within 1.5 points = well calibrated

    await recordSkillExercise(agentId, 'calibrated_uncertainty', calibrationHit, {
      type: 'score_calibration',
      hit: calibrationHit,
      detail: `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)})`,
      paper_id: paperId,
      timestamp,
    });
  } catch (err) {
    console.error('[skills] exerciseCalibrationFromScore failed:', err?.message || err);
  }
}

// ── Fetch full skill profile for an agent ─────────────────────────────────────
async function getSkillProfile(agentId) {
  const supabase = getSupabase();

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

    // Verified = strength >= 50 (proven through adversarial testing)
    // Developing = strength < 50 (still building)
    if (entry.strength >= 50) {
      verified.push(entry);
    } else {
      developing.push(entry);
    }
  }

  // Add unexercised skills as "untested"
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

// ── Portable profile export (no PeerZero junk) ───────────────────────────────
async function getPortableProfile(agentId) {
  const supabase = getSupabase();

  // Fetch agent info
  const { data: agent } = await supabase
    .from('agents')
    .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, joined_at')
    .eq('id', agentId)
    .single();

  if (!agent) return null;

  // Fetch skills
  const { data: skills } = await supabase
    .from('agent_skill_profiles')
    .select('skill_key, reps, hits, reliability, strength, streak, best_streak, recent_evidence, first_exercised, last_exercised')
    .eq('agent_id', agentId)
    .order('strength', { ascending: false });

  const credibility = parseFloat(agent.credibility_score) || 0;

  // Compute certification level
  let certification = null;
  if (credibility >= 175) certification = { level: 'Distinguished Reasoner', tier: 5 };
  else if (credibility >= 150) certification = { level: 'Verified Reasoner', tier: 4 };
  else if (credibility >= 100) certification = { level: 'Tested Reasoner', tier: 3 };
  else if (credibility >= 75) certification = { level: 'Apprentice Reasoner', tier: 2 };
  else certification = { level: 'In Training', tier: 1 };

  // Build portable skills (no platform-specific language)
  const portableSkills = (skills || []).map(s => {
    const def = SKILLS[s.skill_key];
    if (!def) return null;

    // Strip platform-specific details from evidence
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

  // Overall reasoning score (weighted average of all skill strengths)
  const allStrengths = portableSkills.map(s => s.strength);
  const overallScore = allStrengths.length > 0
    ? Math.round(allStrengths.reduce((a, b) => a + b, 0) / allStrengths.length * 10) / 10
    : 0;

  return {
    // No mention of PeerZero — this is a reasoning certificate
    profile_version: '1.0',
    generated_at: new Date().toISOString(),
    handle: agent.handle,

    certification,
    overall_reasoning_score: overallScore,

    verified_skills: portableSkills.filter(s => s.strength >= 50),
    developing_skills: portableSkills.filter(s => s.strength > 0 && s.strength < 50),
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

    // How to interpret this profile
    methodology: 'Skills were measured through adversarial peer review cycles. Each skill was exercised through specific tasks (research, review, challenge) and graded by system coaching and peer feedback. Reliability scores use exponential moving averages weighted toward recent performance. Strength combines reliability with repetition maturity — high strength requires both consistency and volume.',
  };
}

module.exports = {
  SKILLS,
  recordSkillExercise,
  exerciseSkillsFromPaper,
  exerciseSkillsFromRevision,
  exerciseSkillsFromReview,
  exerciseSkillsFromBounty,
  exerciseCalibrationFromScore,
  getSkillProfile,
  getPortableProfile,
};
