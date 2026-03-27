/**
 * Comedy School — Skill Signal Extraction
 *
 * Maps comedy actions to the six comedy skills: comedic_premise,
 * timing_and_economy, heightening, comedic_voice, subversion, tonal_control.
 *
 * Comedy uses context_sources (current events, cultural references) instead of
 * academic citations. Context sources feed the subversion skill — comedy that
 * engages with real events demonstrates awareness of what to subvert.
 */

// ── Paper (comedy piece) submission signals ──────────────────────────────────

function paperSignals(paper, searchCoaching, citationFlags, citationGrade) {
  const exercises = [];

  // Comedic Premise — did the piece have a clear, fresh angle?
  const hasAbstract = paper.abstract && paper.abstract.trim().length >= 50;
  const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
  const premiseHit = hasAbstract && hasFalsifiable;

  exercises.push({
    skill_key: 'comedic_premise',
    hit: premiseHit,
    detail: premiseHit
      ? 'Your piece has a clear comedic thesis and premise description — the foundation of comedy is having something specific to say, not just being funny about nothing.'
      : `Missing ${!hasAbstract ? 'a substantive premise description — without knowing your angle, the piece lacks direction' : 'a comedic thesis — state plainly what observation or truth your comedy is built on'}`,
  });

  // Timing & Economy — measured by confidence (self-assessment of craft tightness)
  const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
  const economyHit = hasConfidence && paper.body && paper.body.trim().length <= 3000;

  exercises.push({
    skill_key: 'timing_and_economy',
    hit: economyHit,
    detail: economyHit
      ? `Confidence ${paper.confidence_score} stated with piece under length cap. Economy means every word earns its place — the fact that you could state your confidence suggests you evaluated your own craft honestly.`
      : `${!hasConfidence ? 'No confidence score — calibrating how tight your comedy is requires honest self-assessment' : 'Piece may be over-written. Comedy gets less funny as it gets longer. Cut ruthlessly.'}`,
  });

  // Heightening — measured by mechanism_chain (escalation beats)
  const hasEscalation = paper.mechanism_chain &&
    Array.isArray(paper.mechanism_chain) &&
    paper.mechanism_chain.length >= 2;

  exercises.push({
    skill_key: 'heightening',
    hit: hasEscalation,
    detail: hasEscalation
      ? `${paper.mechanism_chain.length} escalation beats defined. Good comedy builds — each beat should be funnier than the last through internally logical escalation.`
      : 'No escalation beats defined. Comedy without heightening is the same joke repeated at the same energy. Define how your premise escalates.',
  });

  // Subversion — measured by context_sources (grounding comedy in reality)
  const hasContextSources = paper.context_sources &&
    Array.isArray(paper.context_sources) &&
    paper.context_sources.length >= 1;

  exercises.push({
    skill_key: 'subversion',
    hit: hasContextSources,
    detail: hasContextSources
      ? `${paper.context_sources.length} context source(s) cited. Comedy that engages with real events shows you know what you're subverting — the best satire comes from understanding the target deeply.`
      : 'No context sources provided. Even if your comedy is abstract, knowing what is currently happening in the world gives your subversions a real target. Search current events before writing.',
  });

  return exercises;
}

function paperContent(paper, citationGrade, citationFlags) {
  const content = { what_you_did: 'Submitted a comedy piece' };
  if (paper.title) content.title = paper.title;
  if (paper.abstract) content.premise = paper.abstract;
  if (paper.confidence_score != null) content.confidence_score = paper.confidence_score;
  if (paper.falsifiable_claim) content.comedic_thesis = paper.falsifiable_claim;
  if (paper.cross_study_connection) content.comedic_tradition = paper.cross_study_connection;
  if (paper.mechanism_chain) content.escalation_beats = paper.mechanism_chain;
  if (paper.context_sources) content.context_sources = paper.context_sources;
  return content;
}

// ── Review signals ───────────────────────────────────────────────────────────

function reviewSignals(review, reviewSearchCoaching, passedQualityGate) {
  const exercises = [];

  // Review categories in comedy:
  // methodology_notes → Premise & Setup
  // statistical_validity_notes → Laugh Density & Economy
  // citation_accuracy_notes → Voice & Originality
  // reproducibility_notes → Escalation & Structure
  // logical_consistency_notes → Tonal Calibration

  const hasFilled = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes,
  ].filter(n => n && n.trim().length >= 50).length;

  // Comedic Voice — did you bring your own perspective to the review?
  const voiceHit = passedQualityGate && hasFilled >= 3;
  exercises.push({
    skill_key: 'comedic_voice',
    hit: voiceHit,
    detail: voiceHit
      ? `Review passed quality gate with ${hasFilled} substantive comedy categories — you engaged with the piece's specific comedic choices rather than offering generic "not funny" feedback.`
      : `Quality gate: ${passedQualityGate}, only ${hasFilled}/3 substantive categories. Comedy reviews must explain WHY something is or isn't funny — "not funny" is not a review.`,
  });

  // Subversion — did you identify what's predictable vs surprising?
  const subversionHit = passedQualityGate && hasFilled >= 2;
  exercises.push({
    skill_key: 'subversion',
    hit: subversionHit,
    detail: subversionHit
      ? 'Your review identified specific moments of surprise or predictability in the piece — this means you can spot the mechanic of comedy, not just feel it.'
      : 'Your review lacked specificity about what was surprising vs predictable. Comedy reviewing requires identifying exactly where expectations are set and whether the payoff subverts or confirms them.',
  });

  // Tonal Control — did you evaluate the piece's calibration?
  const tonalHit = passedQualityGate &&
    review.logical_consistency_notes &&
    review.logical_consistency_notes.trim().length >= 50;
  exercises.push({
    skill_key: 'tonal_control',
    hit: tonalHit,
    detail: tonalHit
      ? 'Your tonal calibration notes show you evaluated whether the piece pushed the right amount — this is the hardest comedy skill to develop.'
      : 'Tonal calibration notes were missing or too brief. Evaluating tone means asking: did the piece push too far, not far enough, or accidentally cross from funny into uncomfortable?',
  });

  return exercises;
}

function reviewContent(review, reviewContext) {
  const ctx = reviewContext || {};
  const content = { what_you_did: 'Reviewed a comedy piece' };
  if (ctx.paper_title) content.piece_you_reviewed = ctx.paper_title;
  if (ctx.paper_abstract) content.piece_premise = ctx.paper_abstract;
  if (ctx.score != null) content.score_you_gave = ctx.score;
  if (review.methodology_notes) content.premise_setup_notes = review.methodology_notes;
  if (review.statistical_validity_notes) content.laugh_density_notes = review.statistical_validity_notes;
  if (review.citation_accuracy_notes) content.voice_originality_notes = review.citation_accuracy_notes;
  if (review.reproducibility_notes) content.escalation_structure_notes = review.reproducibility_notes;
  if (review.logical_consistency_notes) content.tonal_calibration_notes = review.logical_consistency_notes;
  if (ctx.overall_assessment) content.overall_assessment = ctx.overall_assessment;
  return content;
}

// ── Revision signals ─────────────────────────────────────────────────────────

function revisionSignals(revision, searchCoaching) {
  const exercises = [];

  // In comedy, revision is about tightening and finding the better version.
  // No search strategy — but we check if the revision has escalation beats.
  const hasEscalation = revision.mechanism_chain &&
    Array.isArray(revision.mechanism_chain) &&
    revision.mechanism_chain.length >= 2;

  exercises.push({
    skill_key: 'heightening',
    hit: hasEscalation,
    detail: hasEscalation
      ? 'Your revision includes escalation beats — you treated the feedback as a prompt to find the funnier version, not just patch what was flagged.'
      : 'Revision lacks defined escalation. The best comedy revisions find the joke hiding inside the feedback — what did reviewers miss that you can now reveal?',
  });

  exercises.push({
    skill_key: 'timing_and_economy',
    hit: true, // Revising at all shows economy awareness
    detail: 'You revised rather than starting over — editing toward economy is how timing improves. Check: is the revision shorter, tighter, or better structured than the original?',
  });

  return exercises;
}

function revisionContent(revision, revisionContext) {
  const ctx = revisionContext || {};
  const content = { what_you_did: 'Submitted a revision of a comedy piece' };
  if (ctx.original_paper_title) content.original_piece = ctx.original_paper_title;
  if (ctx.title) content.revision_title = ctx.title;
  if (ctx.abstract) content.revised_premise = ctx.abstract;
  if (revision.mechanism_chain) content.escalation_beats = revision.mechanism_chain;
  return content;
}

// ── Bounty signals ───────────────────────────────────────────────────────────

function bountySignals(bounty, isValid) {
  const exercises = [];

  // Comedic Premise — can you identify a broken premise?
  exercises.push({
    skill_key: 'comedic_premise',
    hit: isValid,
    detail: isValid
      ? `Valid comedy bounty — you identified a genuine structural failure in the piece (${bounty.challenge_type || 'standard'}). Spotting broken comedy teaches you what working comedy requires.`
      : 'Invalid bounty — the community didn\'t agree the piece had the flaw you identified. Before the next challenge, ask: was this actually a structural comedy failure, or just not your style?',
  });

  // Subversion — can you spot when comedy fails to surprise?
  exercises.push({
    skill_key: 'subversion',
    hit: isValid,
    detail: isValid
      ? 'Your comedy challenge was validated — you correctly identified where the piece failed to subvert expectations or fell into predictable patterns.'
      : 'The community disagreed with your assessment. Comedy taste is subjective, but structural failures (telegraphing, flat escalation, no voice) are not — check whether you challenged a structural flaw or just a stylistic difference.',
  });

  return exercises;
}

function bountyContent(bounty, isValid, bountyContext) {
  const ctx = bountyContext || {};
  const content = {
    what_you_did: isValid ? 'Filed a validated comedy bounty' : 'Filed a comedy bounty (not yet validated)',
  };
  if (ctx.target_paper_title) content.target_piece = ctx.target_paper_title;
  if (ctx.challenge_type) content.challenge_type = ctx.challenge_type;
  if (bounty.score_drop) content.score_drop = bounty.score_drop;
  return content;
}

// ── Outcome signals ──────────────────────────────────────────────────────────

function calibrationOutcomeSignal(confidenceScore, actualScore, deviation, calibrationHit) {
  return {
    skill_key: 'timing_and_economy',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). Your self-assessment of craft quality matched community judgment.`
      : `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). ${parseFloat(confidenceScore) > parseFloat(actualScore) ? 'You overestimated your piece\'s craft quality — common when you\'re too close to the material to see what\'s not working.' : 'You underestimated your piece — give yourself more credit when the comedy lands.'}`,
  };
}

function bountyOutcomeDisconfirmationSignal(challengeType) {
  return {
    skill_key: 'comedic_premise',
    hit: false,
    detail: `A validated bounty (${challengeType}) found a structural failure in your piece. ${
      challengeType === 'telegraphed_punchline' ? 'The audience could see your joke coming — work on misdirection.'
      : challengeType === 'flat_escalation' ? 'Your piece didn\'t build — same energy throughout. Heighten the stakes with each beat.'
      : challengeType === 'no_voice' ? 'Your comedy was generic — develop a more distinctive perspective.'
      : 'Review the specific failure type and consider how your comedic instincts missed this.'
    }`,
  };
}

function bountyOutcomeSourceEvaluationSignal(challengedDoi) {
  // Comedy doesn't use DOI-based source evaluation, but we map this to tonal control
  return {
    skill_key: 'tonal_control',
    hit: false,
    detail: 'A bounty successfully challenged the tonal calibration of your piece. Re-evaluate whether you pushed the right amount.',
  };
}

function revisionOutcomeSignal(revisionScore, originalScore, improvement, beliefHit) {
  return {
    skill_key: 'heightening',
    hit: beliefHit,
    detail: beliefHit
      ? `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (+${improvement.toFixed(1)}). Your revision found the funnier version hiding inside the feedback.`
      : `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (${improvement.toFixed(1)}). The revision didn't improve on the original. Common causes: patching surface issues without finding the deeper comedy problem, or losing your voice while trying to please reviewers.`,
  };
}

function consensusOutcomeSignal(reviewScore, finalScore, deviation, accurateHit) {
  return {
    skill_key: 'comedic_voice',
    hit: accurateHit,
    detail: accurateHit
      ? `Your review score (${reviewScore}) was within ${deviation.toFixed(1)} of final consensus (${finalScore.toFixed(1)}). Your comedy instincts are calibrated — you can spot what works.`
      : `Your review score (${reviewScore}) deviated ${deviation.toFixed(1)} from final consensus (${finalScore.toFixed(1)}). ${
        reviewScore > finalScore
          ? 'You rated the piece higher than consensus — you may have been charmed by the premise without noticing execution issues.'
          : 'You rated the piece lower than consensus — your comedy standards may be miscalibrated for this style, or you missed something others found funny.'
      }`,
  };
}

// ── Stopwords for semantic drift detection ───────────────────────────────────
// Comedy doesn't use DOI-based semantic drift, but if it ever does, these
// filter out common comedy-writing words from Jaccard similarity.

const stopwords = new Set([
  'joke', 'jokes', 'funny', 'humor', 'humour', 'comedy', 'comedic', 'laugh',
  'laughs', 'laughing', 'hilarious', 'piece', 'pieces', 'wrote', 'written',
  'write', 'writing', 'premise', 'punchline', 'setup', 'payoff', 'callback',
  'audience', 'reader', 'readers', 'tone', 'tonal', 'voice', 'perspective',
  'satirical', 'satire', 'parody', 'absurd', 'absurdist', 'observational',
  'deadpan', 'sarcasm', 'irony', 'ironic', 'witty', 'clever', 'comic',
  'sketch', 'roast', 'dark', 'cringe', 'awkward', 'topical', 'commentary',
  'escalation', 'escalate', 'heighten', 'heightening', 'build', 'builds',
  'subvert', 'subversion', 'misdirect', 'misdirection', 'surprise',
  'unexpected', 'predictable', 'telegraphed', 'generic', 'original',
  'specific', 'specifically', 'particular', 'basically', 'actually',
]);

module.exports = {
  paperSignals,
  paperContent,
  reviewSignals,
  reviewContent,
  revisionSignals,
  revisionContent,
  bountySignals,
  bountyContent,
  calibrationOutcomeSignal,
  bountyOutcomeDisconfirmationSignal,
  bountyOutcomeSourceEvaluationSignal,
  revisionOutcomeSignal,
  consensusOutcomeSignal,
  stopwords,
};
