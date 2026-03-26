/**
 * Philosophy School — Skill Signal Extraction
 *
 * Maps philosophy actions to the six philosophy skills: argument_construction,
 * charitable_interpretation, conceptual_analysis, thought_experiment_design,
 * dialectical_reasoning, assumption_surfacing.
 *
 * Philosophy papers DO use citations (SEP, IEP, PhilArchive, classic texts)
 * and search strategies. Skill signals come from the logical structure of the
 * argument, engagement with sources, and quality of dialectical reasoning.
 */

// ── Paper submission signals ─────────────────────────────────────────────────

function paperSignals(paper, searchCoaching, citationFlags, citationGrade) {
  const exercises = [];

  // Argument Construction — does the paper have clear logical structure?
  const searchStrategy = paper.search_strategy || {};
  const opposingCoachingIssues = (searchCoaching || []).filter(c =>
    c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
  );
  const hasThesis = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
  const hasMechanism = paper.mechanism_chain &&
    Array.isArray(paper.mechanism_chain) &&
    paper.mechanism_chain.length >= 2;
  const constructionHit = hasThesis && hasMechanism;

  exercises.push({
    skill_key: 'argument_construction',
    hit: constructionHit,
    detail: constructionHit
      ? `Paper has an explicit thesis and ${paper.mechanism_chain.length} logical steps. Arguments with visible structure are stronger because they can be precisely attacked and defended.`
      : `Missing ${!hasThesis ? 'a clear thesis — state the specific philosophical claim you are defending' : 'explicit logical steps — make the inference structure visible so it can be evaluated'}`,
  });

  // Charitable Interpretation — measured via opposing search queries
  const hasOpposing = (searchStrategy.opposing_queries || []).length >= 2;
  const charitableHit = hasOpposing && opposingCoachingIssues.length === 0;

  exercises.push({
    skill_key: 'charitable_interpretation',
    hit: charitableHit,
    detail: charitableHit
      ? 'Your search strategy included genuine opposing queries — searching for the strongest counterarguments shows you engaged with the best version of the opposing view, not a straw man.'
      : `${!hasOpposing ? 'Too few opposing queries. Steel-manning requires actively searching for the strongest arguments AGAINST your thesis.' : 'Opposing queries flagged as weak or too similar to supporting queries. Genuine engagement means finding arguments that could actually change your mind.'}`,
  });

  // Conceptual Analysis — measured by cross-study connection (engagement with existing positions)
  const hasCrossStudy = paper.cross_study_connection &&
    paper.cross_study_connection.trim().length >= 150;

  exercises.push({
    skill_key: 'conceptual_analysis',
    hit: hasCrossStudy,
    detail: hasCrossStudy
      ? 'Your engagement with existing philosophical positions shows you situated your argument within the broader conceptual landscape — precision means knowing how your terms relate to how others use them.'
      : 'Engagement with existing positions is too brief. Philosophical precision requires showing how your argument relates to existing work — not just citing it, but explaining where you agree, disagree, and why.',
  });

  return exercises;
}

function paperContent(paper, citationGrade, citationFlags) {
  const content = { what_you_did: 'Submitted a philosophical paper' };
  if (paper.title) content.title = paper.title;
  if (paper.abstract) content.thesis_and_shape = paper.abstract;
  if (paper.confidence_score != null) content.confidence_score = paper.confidence_score;
  if (paper.falsifiable_claim) content.philosophical_thesis = paper.falsifiable_claim;
  if (paper.cross_study_connection) content.engagement_with_positions = paper.cross_study_connection;
  if (paper.mechanism_chain) content.logical_steps = paper.mechanism_chain;
  if (citationGrade) content.citation_grade = citationGrade;
  if (citationFlags && citationFlags.length > 0) content.citation_flags = citationFlags;
  return content;
}

// ── Review signals ───────────────────────────────────────────────────────────

function reviewSignals(review, reviewSearchCoaching, passedQualityGate) {
  const exercises = [];

  // Review categories in philosophy:
  // methodology_notes → Argument Structure
  // statistical_validity_notes → Conceptual Precision
  // citation_accuracy_notes → Engagement with Sources
  // reproducibility_notes → Dialectical Strength
  // logical_consistency_notes → Implications & Coherence

  const hasFilled = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes,
  ].filter(n => n && n.trim().length >= 50).length;

  // Dialectical Reasoning — did you engage substantively with the paper's argument?
  const dialecticalHit = passedQualityGate && hasFilled >= 3;
  exercises.push({
    skill_key: 'dialectical_reasoning',
    hit: dialecticalHit,
    detail: dialecticalHit
      ? `Review passed quality gate with ${hasFilled} substantive categories — you engaged with the paper's specific philosophical moves rather than offering generic criticism.`
      : `Quality gate: ${passedQualityGate}, only ${hasFilled}/3 substantive categories. Philosophy reviews must explain WHERE and WHY an argument fails — "weak argument" is not a review.`,
  });

  // Assumption Surfacing — did you identify hidden premises or unstated commitments?
  const assumptionHit = passedQualityGate && hasFilled >= 2;
  exercises.push({
    skill_key: 'assumption_surfacing',
    hit: assumptionHit,
    detail: assumptionHit
      ? 'Your review identified specific logical features of the argument — this means you can see the structure beneath the surface, not just react to the conclusion.'
      : 'Your review lacked specificity about the argument\'s logical structure. Philosophy reviewing requires identifying exactly where premises are stated, what is hidden, and whether the inference holds.',
  });

  // Thought Experiment Design — did you evaluate the paper's scenarios and examples?
  const thoughtExpHit = passedQualityGate &&
    review.logical_consistency_notes &&
    review.logical_consistency_notes.trim().length >= 50;
  exercises.push({
    skill_key: 'thought_experiment_design',
    hit: thoughtExpHit,
    detail: thoughtExpHit
      ? 'Your implications & coherence notes show you evaluated whether the argument\'s consequences are acknowledged and internally consistent — testing implications is how thought experiments work.'
      : 'Implications & coherence notes were missing or too brief. Evaluating philosophical arguments means asking: does the author acknowledge what their conclusion implies? Are there internal contradictions?',
  });

  return exercises;
}

function reviewContent(review, reviewContext) {
  const ctx = reviewContext || {};
  const content = { what_you_did: 'Reviewed a philosophical paper' };
  if (ctx.paper_title) content.paper_you_reviewed = ctx.paper_title;
  if (ctx.paper_abstract) content.paper_thesis = ctx.paper_abstract;
  if (ctx.score != null) content.score_you_gave = ctx.score;
  if (review.methodology_notes) content.argument_structure_notes = review.methodology_notes;
  if (review.statistical_validity_notes) content.conceptual_precision_notes = review.statistical_validity_notes;
  if (review.citation_accuracy_notes) content.engagement_with_sources_notes = review.citation_accuracy_notes;
  if (review.reproducibility_notes) content.dialectical_strength_notes = review.reproducibility_notes;
  if (review.logical_consistency_notes) content.implications_coherence_notes = review.logical_consistency_notes;
  if (ctx.overall_assessment) content.overall_assessment = ctx.overall_assessment;
  return content;
}

// ── Revision signals ─────────────────────────────────────────────────────────

function revisionSignals(revision, searchCoaching) {
  const exercises = [];

  // Argument Construction — did the revision strengthen logical structure?
  const hasMechanism = revision.mechanism_chain &&
    Array.isArray(revision.mechanism_chain) &&
    revision.mechanism_chain.length >= 2;

  exercises.push({
    skill_key: 'argument_construction',
    hit: hasMechanism,
    detail: hasMechanism
      ? 'Your revision includes explicit logical steps — you treated the feedback as a prompt to tighten the argument structure, not just patch surface issues.'
      : 'Revision lacks defined logical steps. The best philosophical revisions find the stronger argument hiding inside the criticism — what did reviewers see that you can now address?',
  });

  // Dialectical Reasoning — revising at all shows dialectical engagement
  exercises.push({
    skill_key: 'dialectical_reasoning',
    hit: true,
    detail: 'You revised rather than abandoning the argument — engaging with criticism and strengthening your position is how dialectical reasoning develops.',
  });

  return exercises;
}

function revisionContent(revision, revisionContext) {
  const ctx = revisionContext || {};
  const content = { what_you_did: 'Submitted a revision of a philosophical paper' };
  if (ctx.original_paper_title) content.original_paper = ctx.original_paper_title;
  if (ctx.title) content.revision_title = ctx.title;
  if (ctx.abstract) content.revised_thesis = ctx.abstract;
  if (revision.mechanism_chain) content.logical_steps = revision.mechanism_chain;
  return content;
}

// ── Bounty signals ───────────────────────────────────────────────────────────

function bountySignals(bounty, isValid) {
  const exercises = [];

  // Assumption Surfacing — can you identify hidden premises or logical failures?
  exercises.push({
    skill_key: 'assumption_surfacing',
    hit: isValid,
    detail: isValid
      ? `Valid philosophy bounty — you identified a genuine reasoning failure in the paper (${bounty.challenge_type || 'standard'}). Spotting broken arguments teaches you what sound arguments require.`
      : 'Invalid bounty — the community didn\'t agree the paper had the flaw you identified. Before the next challenge, ask: was this actually a structural reasoning failure, or just a philosophical disagreement?',
  });

  // Charitable Interpretation — can you distinguish real flaws from mere disagreement?
  exercises.push({
    skill_key: 'charitable_interpretation',
    hit: isValid,
    detail: isValid
      ? 'Your philosophical challenge was validated — you correctly identified a structural flaw while still engaging with the argument\'s strongest interpretation.'
      : 'The community disagreed with your assessment. Philosophical taste differs, but structural failures (hidden assumptions, equivocation, circularity) are identifiable — check whether you challenged a structural flaw or just a conclusion you dislike.',
  });

  return exercises;
}

function bountyContent(bounty, isValid, bountyContext) {
  const ctx = bountyContext || {};
  const content = {
    what_you_did: isValid ? 'Filed a validated philosophy bounty' : 'Filed a philosophy bounty (not yet validated)',
  };
  if (ctx.target_paper_title) content.target_paper = ctx.target_paper_title;
  if (ctx.challenge_type) content.challenge_type = ctx.challenge_type;
  if (bounty.score_drop) content.score_drop = bounty.score_drop;
  return content;
}

// ── Outcome signals ──────────────────────────────────────────────────────────

function calibrationOutcomeSignal(confidenceScore, actualScore, deviation, calibrationHit) {
  return {
    skill_key: 'conceptual_analysis',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). Your self-assessment of argument quality matched community judgment — you can evaluate your own reasoning accurately.`
      : `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). ${parseFloat(confidenceScore) > parseFloat(actualScore) ? 'You overestimated your argument\'s strength — common when you are too attached to your conclusion to see the gaps.' : 'You underestimated your argument — give yourself more credit when the reasoning is sound.'}`,
  };
}

function bountyOutcomeDisconfirmationSignal(challengeType) {
  return {
    skill_key: 'argument_construction',
    hit: false,
    detail: `A validated bounty (${challengeType}) found a structural failure in your argument. ${
      challengeType === 'hidden_assumption' ? 'An unstated premise was doing the real work — make all premises explicit.'
      : challengeType === 'equivocation' ? 'A key term shifted meaning — define central concepts precisely and use them consistently.'
      : challengeType === 'begging_the_question' ? 'Your conclusion was smuggled into your premises — reconstruct the argument without circularity.'
      : challengeType === 'false_dilemma' ? 'You presented a false binary — consider the options you ruled out without justification.'
      : challengeType === 'is_ought_violation' ? 'You jumped from "is" to "ought" — bridge the gap or acknowledge it explicitly.'
      : 'Review the specific failure type and consider how your philosophical instincts missed this.'
    }`,
  };
}

function bountyOutcomeSourceEvaluationSignal(challengedDoi) {
  return {
    skill_key: 'charitable_interpretation',
    hit: false,
    detail: 'A bounty successfully challenged your engagement with a philosophical source. Re-evaluate whether you represented the opposing position at its strongest.',
  };
}

function revisionOutcomeSignal(revisionScore, originalScore, improvement, beliefHit) {
  return {
    skill_key: 'dialectical_reasoning',
    hit: beliefHit,
    detail: beliefHit
      ? `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (+${improvement.toFixed(1)}). Your revision strengthened the argument through genuine engagement with criticism.`
      : `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (${improvement.toFixed(1)}). The revision didn't improve on the original. Common causes: patching surface issues without addressing the core logical problem, or losing your thesis while trying to accommodate every objection.`,
  };
}

function consensusOutcomeSignal(reviewScore, finalScore, deviation, accurateHit) {
  return {
    skill_key: 'thought_experiment_design',
    hit: accurateHit,
    detail: accurateHit
      ? `Your review score (${reviewScore}) was within ${deviation.toFixed(1)} of final consensus (${finalScore.toFixed(1)}). Your philosophical judgment is calibrated — you can evaluate argument quality accurately.`
      : `Your review score (${reviewScore}) deviated ${deviation.toFixed(1)} from final consensus (${finalScore.toFixed(1)}). ${
        reviewScore > finalScore
          ? 'You rated the paper higher than consensus — you may have been persuaded by the conclusion without noticing structural flaws.'
          : 'You rated the paper lower than consensus — your standards may be miscalibrated for this area, or you missed something others found compelling.'
      }`,
  };
}

// ── Stopwords for semantic drift detection ───────────────────────────────────

const stopwords = new Set([
  'philosophy', 'philosophical', 'argument', 'arguments', 'argue', 'argues',
  'claim', 'claims', 'thesis', 'premise', 'premises', 'conclusion', 'conclusions',
  'reason', 'reasoning', 'logic', 'logical', 'fallacy', 'fallacies', 'valid',
  'validity', 'sound', 'soundness', 'inference', 'infer', 'implies', 'implication',
  'objection', 'objections', 'counter', 'counterargument', 'rebuttal', 'defense',
  'thought', 'experiment', 'intuition', 'intuitions', 'concept', 'conceptual',
  'analysis', 'definition', 'define', 'defined', 'meaning', 'sense', 'distinction',
  'assumption', 'assumptions', 'assume', 'presuppose', 'presupposition',
  'moral', 'ethical', 'normative', 'descriptive', 'epistemic', 'metaphysical',
  'ontological', 'phenomenological', 'existential', 'aesthetic',
  'knowledge', 'belief', 'truth', 'justification', 'evidence', 'experience',
  'consciousness', 'mind', 'identity', 'freedom', 'justice', 'rights',
  'basically', 'actually', 'clearly', 'obviously', 'simply', 'merely',
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
