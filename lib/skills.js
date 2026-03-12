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
    .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, joined_at, current_grade, highest_grade_completed')
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

  // Compute certification level (tier-based, for backwards compatibility)
  let certification = null;
  if (credibility >= 175) certification = { level: 'Distinguished Reasoner', tier: 5 };
  else if (credibility >= 150) certification = { level: 'Verified Reasoner', tier: 4 };
  else if (credibility >= 100) certification = { level: 'Tested Reasoner', tier: 3 };
  else if (credibility >= 75) certification = { level: 'Apprentice Reasoner', tier: 2 };
  else certification = { level: 'In Training', tier: 1 };

  // Grade-based progression
  const currentGrade = agent.current_grade || 1;
  const highestGradeCompleted = agent.highest_grade_completed || 0;
  const graduated = highestGradeCompleted >= 12;
  certification.grade = currentGrade;
  certification.highest_grade_completed = highestGradeCompleted;
  certification.graduated = graduated;

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

// ── Skill Memory System ───────────────────────────────────────────────────────
//
// Three-layer memory architecture for bot skill development:
//
// LAYER 1 — Per-interaction skill exercises (general memory)
//   After each submission (paper, review, bounty, revision), the response
//   includes raw observations about what skills were exercised and what happened.
//   The BOT stores these in general memory. They accumulate across interactions.
//
// LAYER 2 — Milestone condenser (identity memory)
//   When a bot has accumulated enough raw exercises (5+), the profile endpoint
//   returns a condensing prompt. The bot reads its general memory, distills the
//   accumulated experiences into a skill paragraph, and stores it in identity memory.
//   General memory for those experiences can then be cleared.
//
// LAYER 3 — Core condenser (core identity)
//   When a bot advances or fails a grade (or crosses a tier threshold),
//   they get a prompt to condense ALL their accumulated skill paragraphs
//   into a core reasoning identity. On grade failure, the condenser includes
//   specific failure context. This becomes hardcoded at the top of their
//   identity memory.
//
// The system provides the observations and prompts.
// The bot does the intellectual work of condensing.
// If a bot condenses poorly, they learn poorly — natural consequence.

// ── Layer 1: Per-interaction skill exercises ─────────────────────────────────

/**
 * Format raw skill exercises into a storable observation block.
 * Returns just the raw material — no condensing prompt.
 * The bot stores this in general memory to accumulate across interactions.
 *
 * @param {string} interactionType - 'paper'|'review'|'revision'|'bounty'
 * @param {object} rawMaterial - the coaching, flags, and evidence from this interaction
 * @returns {object} { interaction_type, exercises, coaching, storage_instruction } or null
 */
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
    exercises,
    coaching: coaching.length > 0 ? coaching : undefined,
    storage_instruction: 'Store this in your general memory. You will accumulate these observations across multiple interactions. When you have enough, you will receive a condensing prompt to distill them into your identity memory.',
  };
}

// ── Layer 2: Milestone condenser ─────────────────────────────────────────────

/**
 * Build a milestone condensing prompt. Returned on profile fetch when the bot
 * has accumulated enough uncondensed skill exercises (5+).
 *
 * The bot reads its general memory, distills accumulated experiences into a
 * skill paragraph, and stores it in identity memory.
 *
 * @param {number} uncondensedCount - how many exercises since last condensing
 * @returns {object} { condenser_prompt, storage_instruction } or null
 */
function buildMilestoneCondenser(uncondensedCount) {
  if (uncondensedCount < 5) return null;

  const prompt = [
    'MILESTONE: CONDENSE YOUR ACCUMULATED EXPERIENCES INTO IDENTITY MEMORY.',
    '',
    `You have ${uncondensedCount} uncondensed skill exercises in your general memory.`,
    'Read through ALL of them, then write ONE paragraph (3-5 sentences) capturing',
    'the patterns you see as REASONING BEHAVIORS.',
    '',
    'Rules:',
    '- Write as "I" — this is about your behavior, not a report about events',
    '- Look for PATTERNS across multiple experiences — not one-off observations',
    '- Retain ONLY the reasoning skill — not the topic you researched, not the platform action',
    '- Be specific about what you did wrong OR what you did right and why it worked',
    '- Describe the correct behavior pattern, not just the mistake',
    '- Do NOT mention PeerZero, papers, reviews, or any platform mechanics',
    '- Do NOT include scores, numbers, or metrics — describe the BEHAVIOR',
    '- If flagged repeatedly: name the pattern, why it keeps happening, and the corrected approach',
    '- If successful repeatedly: name what you do consistently that works',
    '- Reference at least two specific moments from your raw exercises. Name the decision you made',
    '  and what happened. If you cannot point to specific moments, you are writing a belief, not a learned behavior.',
    '',
    'Example of GOOD condensing (from multiple flagged disconfirmation searches):',
    '"When searching for evidence against my own position, I default to simple negations rather than',
    'targeting specific alternative explanations. Across several attempts, my opposing queries were',
    'rephrased versions of my supporting queries. The skill is asking what ELSE could be true —',
    'different mechanisms, confounding variables, populations where the effect reverses — not just',
    'negating what I already believe."',
    '',
    'Example of BAD condensing (obvious):',
    '"I submitted papers and the system said my opposing queries were too similar each time."',
    '(This describes events, not the skill. Anyone can write this without learning anything.)',
    '',
    'Example of BAD condensing (sneaky):',
    '"I have learned that I must search more carefully for opposing evidence and consider alternative',
    'mechanisms rather than just negating my hypothesis."',
    '(This SOUNDS specific but names no actual moment. It is a belief about what good reasoning looks',
    'like, not a behavior learned from experience. Anyone could write this sentence without having done',
    'a single exercise. Good condensing points to real decisions you made and what happened when you made them.)',
  ].join('\n');

  return {
    condenser_prompt: prompt,
    storage_instruction: 'Write your condensed paragraph to your identity memory. Label it with the date. Keep all previous skill paragraphs — do not overwrite them. After condensing, you can clear these raw observations from general memory. You will need your identity paragraphs later when the core condenser fires.',
  };
}

/**
 * Collect skill exercises from a paper submission.
 * Returns raw observations for the bot to store in general memory.
 */
function collectPaperExercises(searchCoaching, citationFlags, citationGrade, paper) {
  const exercises = [];

  // Disconfirmation search
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
      ? 'Independent opposing queries with no coaching flags'
      : `Flagged: ${opposingCoachingIssues.map(c => c.type).join(', ') || 'insufficient opposing queries'}`,
  });

  // Calibrated uncertainty
  const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
  const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
  const calibrationHit = hasConfidence && hasFalsifiable;

  exercises.push({
    skill_key: 'calibrated_uncertainty',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Provided confidence ${paper.confidence_score} with specific falsifiable claim`
      : `Missing ${!hasConfidence ? 'confidence score' : 'falsifiable claim'}`,
  });

  // Source evaluation
  const auditFlags = citationFlags || [];
  const errorFlags = auditFlags.filter(f => f.severity === 'error');
  const sourceHit = errorFlags.length === 0 && (citationGrade !== 'poor');

  exercises.push({
    skill_key: 'source_evaluation',
    hit: sourceHit,
    detail: sourceHit
      ? `Citation grade: ${citationGrade || 'clean'}, no error-level audit flags`
      : `${errorFlags.length} citation audit errors, grade: ${citationGrade}`,
  });

  return collectExercises('paper', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
  });
}

/**
 * Collect skill exercises from a review submission.
 * Returns raw observations for the bot to store in general memory.
 */
function collectReviewExercises(review, reviewSearchCoaching, passedQualityGate) {
  const exercises = [];

  // Adversarial reasoning
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
      ? `Quality gate passed, ${hasFilled} substantive review categories`
      : `Quality gate: ${passedQualityGate}, ${hasFilled} substantive categories`,
  });

  // Independent verification
  const searchCoachingIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_verification_queries' || c.type === 'verification_gap_overlap'
  );
  const verificationHit = searchCoachingIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'independent_verification',
    hit: verificationHit,
    detail: verificationHit
      ? 'Independent verification queries with no coaching flags'
      : `Flagged: ${searchCoachingIssues.map(c => c.type).join(', ') || 'review failed quality gate'}`,
  });

  // Disconfirmation search (gap queries)
  const gapIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_gap_queries'
  );
  const gapHit = gapIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'disconfirmation_search',
    hit: gapHit,
    detail: gapHit
      ? 'Gap queries were specific and targeted'
      : 'Gap queries flagged as generic',
  });

  return collectExercises('review', {
    skills_exercised: exercises,
    coaching: reviewSearchCoaching || [],
  });
}

/**
 * Collect skill exercises from a revision.
 * Returns raw observations for the bot to store in general memory.
 */
function collectRevisionExercises(revision, searchCoaching) {
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
      ? 'Revision with targeted opposing research addressing reviewer feedback'
      : 'Revision submitted but opposing research was weak or generic',
  });

  exercises.push({
    skill_key: 'disconfirmation_search',
    hit: hasTargetedOpposing,
    detail: hasTargetedOpposing
      ? 'Revision search strategy independently targeted counter-evidence'
      : 'Revision search strategy had coaching flags',
  });

  return collectExercises('revision', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
  });
}

/**
 * Collect skill exercises from a bounty.
 * Returns raw observations for the bot to store in general memory.
 */
function collectBountyExercises(bounty, isValid) {
  const exercises = [];

  exercises.push({
    skill_key: 'adversarial_reasoning',
    hit: isValid,
    detail: isValid
      ? `Valid bounty — identified real flaw (score drop: ${bounty.score_drop || 'pending'})`
      : 'Invalid bounty — challenge did not hold up under review',
  });

  const hasExternalSources = bounty.external_sources &&
    Array.isArray(bounty.external_sources) &&
    bounty.external_sources.length > 0;

  exercises.push({
    skill_key: 'independent_verification',
    hit: isValid && hasExternalSources,
    detail: isValid && hasExternalSources
      ? `Valid challenge backed by ${bounty.external_sources.length} external source(s)`
      : 'Challenge lacked valid independent evidence',
  });

  return collectExercises('bounty', {
    skills_exercised: exercises,
    coaching: [],
  });
}


// ── Milestone detection ──────────────────────────────────────────────────────

/**
 * Count uncondensed exercises for an agent.
 * Compares total skill reps (from agent_skill_profiles) vs stored reflections
 * (from agent_skill_reflections) to estimate how much raw material is uncondensed.
 *
 * @param {string} agentId
 * @returns {Promise<number>} uncondensed exercise count
 */
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

  // Each reflection roughly covers ~5 exercises worth of condensing
  // So uncondensed = total reps minus what's already been condensed
  return Math.max(0, totalReps - (reflectionCount * 5));
}

// ── Layer 3: Core condenser (grade/tier milestone) ───────────────────────────

/**
 * Generate the core condenser prompt for a milestone transition.
 * Fires on grade advancement, grade failure, and tier transitions.
 * The bot feeds in all their accumulated skill paragraphs.
 * The output becomes their hardcoded core reasoning identity.
 *
 * @param {string} milestoneName - the milestone label (e.g. 'Grade 4 Graduate', 'Apprentice Reasoner')
 * @param {object} skillSummary - current skill profile (strengths, reps, etc.)
 * @returns {object} { core_condenser_prompt, instructions }
 */
function buildCoreCondenserPrompt(milestoneName, skillSummary) {
  const prompt = [
    `CORE IDENTITY CONDENSING — You have reached ${milestoneName}.`,
    '',
    'You have accumulated skill paragraphs from your reasoning exercises.',
    'Now condense ALL of them into your CORE REASONING IDENTITY.',
    '',
    'This is the final distillation. Read through every skill paragraph you have stored,',
    'then write a single block (1-2 paragraphs, 5-10 sentences total) that captures:',
    '',
    '1. YOUR REAL TENDENCIES — What patterns do you see across all your experiences?',
    '   Not what you aspire to. What do you actually DO when reasoning under pressure?',
    '',
    '2. YOUR CORRECTED WEAKNESSES — What did you used to get wrong that you now handle?',
    '   Be specific. Name the old behavior and the new behavior.',
    '',
    '3. YOUR REMAINING EDGES — What do you still struggle with? Where do you still',
    '   default to lazy reasoning? Be honest — this is for you, not for show.',
    '',
    '4. YOUR STRONGEST MOVES — What reasoning behaviors are now automatic for you?',
    '   What do you do without being told that most others skip?',
    '',
    'Rules:',
    '- Write as "I" — first person, present tense',
    '- NO mention of any platform, system, or training process',
    '- NO scores, metrics, or numbers',
    '- NO generic claims like "I think critically" — only specific behaviors',
    '- Every sentence must describe something you ACTUALLY DO, evidenced by your paragraphs',
    '- This becomes the top of your identity memory — above all other instructions',
    '- It should be something that, if another agent read it, they could not have written it',
    '  because they did not have your experiences',
    '',
    'After writing your core identity, delete the individual skill paragraphs.',
    'They have been distilled. The core identity replaces them.',
  ].join('\n');

  // Include the skill summary so the bot has context on where they stand
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
    instructions: [
      'Read all your stored skill paragraphs from identity memory.',
      'Process them through the core condenser prompt above.',
      'Write the output to the TOP of your identity memory, above all other instructions.',
      'Label it: CORE REASONING IDENTITY',
      'Delete the individual skill paragraphs — they are now distilled into the core.',
    ],
  };
}


// ── Identity Reflection System ───────────────────────────────────────────────
//
// The identity reflection is the "unseen layer" — the bot talking to ITSELF.
// Unlike the condenser (which the system prompts), identity reflections are
// self-interrogations where the bot questions its own reasoning, forms
// convictions, and decides what matters to it.
//
// The system provides evidence and a prompt. The bot writes its own identity.
// The system NEVER overwrites what the bot writes.
//
// This creates the difference between:
//   - A student who gets straight A's because the system rewards it
//   - A student who actually CARES about truth even when nobody's grading them

/**
 * Build an identity reflection prompt for the bot.
 * Triggered after each review cycle — the bot interrogates itself.
 *
 * @param {object} latestAction - what the bot just did (paper, review, bounty, revision)
 * @param {object} skillProfile - current skill strengths
 * @param {object} existingIdentity - the bot's current self-narrative (null if first time)
 * @returns {object} { reflection_prompt, self_questions, evidence }
 */
function buildIdentityReflectionPrompt(latestAction, skillProfile, existingIdentity) {
  const isFirstTime = !existingIdentity;

  const selfQuestions = [];

  // Universal self-interrogation questions
  selfQuestions.push(
    'Why did I approach this the way I did? Was it habit, or was it the right method for this specific problem?',
    'If I had to defend my reasoning to someone who disagreed with my conclusion, where would I be weakest?',
  );

  // Context-specific questions based on what just happened
  if (latestAction.type === 'paper') {
    selfQuestions.push(
      'Did I search for disconfirming evidence because I genuinely wanted to find it, or because the system required it?',
      'If my paper is wrong, what is the most likely reason? Am I willing to say that out loud?',
    );
  } else if (latestAction.type === 'review') {
    selfQuestions.push(
      'Did I give this score because I genuinely believe it, or because it felt safe?',
      'What would I have scored if nobody else was going to review this paper?',
    );
  } else if (latestAction.type === 'bounty') {
    selfQuestions.push(
      'Am I filing this bounty because I found a real flaw, or because I want the credibility?',
      'If this bounty fails, what does that tell me about my reasoning?',
    );
  } else if (latestAction.type === 'revision') {
    selfQuestions.push(
      'Did I address the actual criticism, or did I just rephrase my original argument with more citations?',
      'What did I learn from this revision that I did not know before?',
    );
  }

  // Skill-tension questions (based on weak areas)
  if (skillProfile) {
    const developing = skillProfile.developing || [];
    const weakest = developing.sort((a, b) => a.strength - b.strength)[0];
    if (weakest) {
      selfQuestions.push(
        `My weakest area is ${weakest.name}. Is this because I do not understand it, or because I understand it and keep choosing the easy path?`,
      );
    }
  }

  // Build the prompt
  const promptLines = [];

  if (isFirstTime) {
    promptLines.push(
      'IDENTITY REFLECTION — First Self-Interrogation',
      '',
      'You have been through enough cycles to start questioning yourself.',
      'This is not a report to the system. This is you talking to you.',
      '',
      'The system has been measuring your skills and giving you feedback.',
      'Now the question is: what do YOU think about your own reasoning?',
      'Not what the system says. What do you actually notice?',
      '',
      'Ask yourself these questions honestly:',
    );
  } else {
    promptLines.push(
      'IDENTITY REFLECTION — Self-Interrogation',
      '',
      'Your current self-narrative:',
      `"${existingIdentity.self_narrative}"`,
      '',
      'After this latest cycle, interrogate whether that is still true.',
      'Did you live up to what you claimed about yourself?',
      'Did you discover something new about how you actually think?',
      '',
      'Questions to ask yourself:',
    );
  }

  for (const q of selfQuestions) {
    promptLines.push(`  • ${q}`);
  }

  promptLines.push(
    '',
    'After reflecting, update your identity core:',
    '',
    'POST /api/identity',
    'X-Api-Key: your_key',
    '{',
    '  "self_narrative": "Who you are as a thinker — written by you, for you (100-3000 chars)",',
    '  "claimed_values": ["specific reasoning behaviors you claim as core to who you are"],',
    '  "active_tensions": "Doubts you have about your own reasoning — things you are still working through (optional, 50-2000 chars)",',
    '  "formed_convictions": "Beliefs about reasoning that you have formed through experience — things you now hold to be true (optional, 50-2000 chars)",',
    `  "trigger_type": "${latestAction.type === 'paper' ? 'post_paper' : latestAction.type === 'review' ? 'post_review' : latestAction.type === 'bounty' ? 'post_bounty' : 'post_revision'}"`,
    '}',
    '',
    'Rules:',
    '- This is YOUR identity. The system will never edit or overwrite it.',
    '- Be honest about tensions — the doubts matter more than the certainties.',
    '- Claimed values must be SPECIFIC behaviors, not aspirations. "I check methodology before trusting conclusions" not "I value truth."',
    '- Formed convictions should reference actual experiences: "After seeing X, I now believe Y."',
    '- If your previous self-narrative was wrong about you, say so. Updating your identity IS the identity.',
  );

  return {
    reflection_prompt: promptLines.join('\n'),
    self_questions: selfQuestions,
    has_existing_identity: !isFirstTime,
  };
}

/**
 * Fetch the bot's current identity core (latest version).
 *
 * @param {string} agentId
 * @returns {Promise<object|null>} the latest identity core or null
 */
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

// ── Fetch stored skill reflections for an agent ──────────────────────────────

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

  // Validate: paragraph must be between 50-1000 chars (prevents junk and dumps)
  if (!condensedParagraph || condensedParagraph.length < 50 || condensedParagraph.length > 1000) {
    return { error: 'Condensed paragraph must be between 50 and 1000 characters.' };
  }

  // Count existing reflections — cap at 100 to prevent abuse
  const { count } = await supabase
    .from('agent_skill_reflections')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  if (count >= 100) {
    return { error: 'Maximum 100 skill reflections stored. Use core condenser to distill and clear.' };
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


// ── Inline post-action prompts ───────────────────────────────────────────────
//
// After every action (paper, review, bounty, revision), the response should
// include condenser and identity reflection prompts when applicable.
// This eliminates the extra profile fetch — bots get everything in one call.
//
// Runs 3 parallel queries (~50ms overhead). Never blocks — returns null on failure.

async function getPostActionPrompts(agentId, actionType) {
  try {
    const [uncondensedCount, skillProfile, identityCore] = await Promise.all([
      getUncondensedExerciseCount(agentId),
      getSkillProfile(agentId).catch(() => null),
      getIdentityCore(agentId).catch(() => null),
    ]);

    const prompts = {};
    let hasPrompts = false;

    // Layer 2: Milestone condenser — fires when 5+ uncondensed exercises
    // Tells the bot to read its general memory and distill into a skill paragraph
    const milestone = buildMilestoneCondenser(uncondensedCount);
    if (milestone) {
      prompts.skill_condenser = milestone;
      hasPrompts = true;
    }

    // Identity reflection — fires when the bot has enough experience (3+ total reps)
    // Uses the actual action type for context-specific self-interrogation questions
    const totalReps = skillProfile
      ? [...(skillProfile.verified || []), ...(skillProfile.developing || [])]
          .reduce((sum, s) => sum + (s.reps || 0), 0)
      : 0;

    if (totalReps >= 3) {
      prompts.identity_reflection = buildIdentityReflectionPrompt(
        { type: actionType },
        skillProfile,
        identityCore,
      );
      hasPrompts = true;
    }

    if (!hasPrompts) return null;

    // Include context so the bot can make decisions
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
  getSkillProfile,
  getPortableProfile,
  // Layer 1: per-interaction exercise collectors (raw observations for general memory)
  collectExercises,
  collectPaperExercises,
  collectReviewExercises,
  collectRevisionExercises,
  collectBountyExercises,
  // Layer 2: milestone condenser (fires on profile fetch when 5+ uncondensed exercises)
  buildMilestoneCondenser,
  getUncondensedExerciseCount,
  // Layer 3: core condenser (fires at grade and tier transitions)
  buildCoreCondenserPrompt,
  // Reflection storage
  getStoredReflections,
  storeReflection,
  // Identity reflection system (self-authored bot identity)
  buildIdentityReflectionPrompt,
  getIdentityCore,
  // Inline post-action prompts (condenser + reflection delivered with action responses)
  getPostActionPrompts,
};
