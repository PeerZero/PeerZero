const { SKILLS } = require('./skills-core');

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

module.exports = {
  buildActiveFocus,
  collectExercises,
  collectPaperExercises,
  collectReviewExercises,
  collectRevisionExercises,
  collectBountyExercises,
};
