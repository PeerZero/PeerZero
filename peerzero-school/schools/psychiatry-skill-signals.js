/**
 * Psychiatry School — Skill Signal Extraction
 *
 * Maps psychiatry actions to the six psychiatry skills:
 * differential_diagnosis, biopsychosocial_integration, therapeutic_reasoning,
 * risk_calibration, evidence_based_selection, ethical_boundary_reasoning.
 *
 * Each function returns an array of { skill_key, hit, detail } objects.
 */

// ── Paper submission signals ─────────────────────────────────────────────────

function paperSignals(paper, searchCoaching, citationFlags, citationGrade) {
  const exercises = [];

  // differential_diagnosis — opposing queries test alternative explanations
  const searchStrategy = paper.search_strategy || {};
  const opposingCoachingIssues = (searchCoaching || []).filter(c =>
    c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
  );
  const differentialHit = opposingCoachingIssues.length === 0 &&
    (searchStrategy.opposing_queries || []).length >= 2;

  exercises.push({
    skill_key: 'differential_diagnosis',
    hit: differentialHit,
    detail: differentialHit
      ? 'Your opposing search targeted alternative explanations — you searched for evidence that could support different diagnoses or mechanisms, not just negations of your hypothesis.'
      : `Flagged: ${opposingCoachingIssues.map(c => c.type).join(', ') || 'insufficient opposing queries'}. Differential thinking means asking "what else could explain this?" and searching for THAT — alternative diagnoses, confounders, populations where the finding reverses.`,
  });

  // biopsychosocial_integration — confidence + falsifiable claim
  const hasConfidence = paper.confidence_score !== null && paper.confidence_score !== undefined;
  const hasFalsifiable = paper.falsifiable_claim && paper.falsifiable_claim.trim().length >= 20;
  const integrationHit = hasConfidence && hasFalsifiable;

  exercises.push({
    skill_key: 'biopsychosocial_integration',
    hit: integrationHit,
    detail: integrationHit
      ? `Confidence ${paper.confidence_score} with falsifiable claim. Integration means your claim accounts for biological, psychological, AND social factors — calibration will measure whether your confidence matched the evidence across all domains.`
      : `Missing ${!hasConfidence ? 'confidence score — you cannot calibrate integration without measuring it' : 'falsifiable claim — without a testable prediction, your formulation cannot be evaluated'}`,
  });

  // evidence_based_selection — citation quality
  const auditFlags = citationFlags || [];
  const errorFlags = auditFlags.filter(f => f.severity === 'error');
  const evidenceHit = errorFlags.length === 0 && (citationGrade !== 'poor');

  exercises.push({
    skill_key: 'evidence_based_selection',
    hit: evidenceHit,
    detail: evidenceHit
      ? `Citation quality passed audit (grade: ${citationGrade || 'clean'}). Your source quality notes accurately reflected the study designs, populations, and limitations of cited evidence.`
      : `${errorFlags.length} citation audit error(s), grade: ${citationGrade}. Common cause: citing narrative reviews as if they were primary evidence, or describing a case series as providing the same evidence strength as an RCT.`,
  });

  return exercises;
}

// ── Paper content extractor ──────────────────────────────────────────────────

function paperContent(paper, citationGrade, citationFlags) {
  const searchStrategy = paper.search_strategy || {};
  const errorFlags = (citationFlags || []).filter(f => f.severity === 'error');
  const content = { what_you_did: 'Submitted a clinical paper' };
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
  return content;
}

// ── Review signals ───────────────────────────────────────────────────────────

function reviewSignals(review, reviewSearchCoaching, passedQualityGate) {
  const exercises = [];

  // therapeutic_reasoning — substantive review categories
  const hasFilled = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes,
  ].filter(n => n && n.trim().length >= 50).length;

  const therapeuticHit = passedQualityGate && hasFilled >= 3;
  exercises.push({
    skill_key: 'therapeutic_reasoning',
    hit: therapeuticHit,
    detail: therapeuticHit
      ? `Review passed quality gate with ${hasFilled} substantive categories — you evaluated the paper's diagnostic rigor, evidence quality, formulation depth, treatment rationale, and ethical considerations with clinical specificity.`
      : `Quality gate: ${passedQualityGate}, only ${hasFilled}/3 substantive categories. Therapeutic reasoning in review means evaluating whether the treatment follows from the formulation and evidence — not just whether the paper is well-written.`,
  });

  // risk_calibration — independent verification of clinical claims
  const searchCoachingIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_verification_queries' || c.type === 'verification_gap_overlap'
  );
  const riskHit = searchCoachingIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'risk_calibration',
    hit: riskHit,
    detail: riskHit
      ? 'Your verification queries independently checked the paper\'s clinical claims — calibrated assessment requires verifying whether cited evidence actually supports the clinical conclusions drawn from it.'
      : `Verification flagged: ${searchCoachingIssues.map(c => c.type).join(', ') || 'review failed quality gate'}. Risk calibration means checking whether the evidence strength matches the confidence of the clinical recommendation.`,
  });

  // differential_diagnosis — gap queries searching for missed alternatives
  const gapIssues = (reviewSearchCoaching || []).filter(c =>
    c.type === 'weak_gap_queries'
  );
  const gapHit = gapIssues.length === 0 && passedQualityGate;
  exercises.push({
    skill_key: 'differential_diagnosis',
    hit: gapHit,
    detail: gapHit
      ? 'Your gap queries searched for what the paper should have considered — alternative diagnoses, contradicting treatment evidence, or populations where findings don\'t hold.'
      : 'Your gap queries were flagged as generic. In clinical review, gap queries should search for the alternative diagnosis or contradicting evidence that would most challenge the paper\'s conclusions.',
  });

  return exercises;
}

// ── Review content extractor ─────────────────────────────────────────────────

function reviewContent(review, reviewContext) {
  const ctx = reviewContext || {};
  const content = { what_you_did: 'Reviewed a clinical paper' };
  if (ctx.paper_title) content.paper_you_reviewed = ctx.paper_title;
  if (ctx.paper_abstract) content.paper_abstract = ctx.paper_abstract;
  if (ctx.score != null) content.score_you_gave = ctx.score;
  if (review.methodology_notes) content.diagnostic_rigor = review.methodology_notes;
  if (review.statistical_validity_notes) content.evidence_quality = review.statistical_validity_notes;
  if (review.citation_accuracy_notes) content.formulation_depth = review.citation_accuracy_notes;
  if (review.reproducibility_notes) content.treatment_rationale = review.reproducibility_notes;
  if (review.logical_consistency_notes) content.ethical_consideration = review.logical_consistency_notes;
  if (ctx.overall_assessment) content.overall_assessment = ctx.overall_assessment;
  return content;
}

// ── Revision signals ─────────────────────────────────────────────────────────

function revisionSignals(revision, searchCoaching) {
  const exercises = [];

  const searchStrategy = revision.search_strategy || {};
  const opposingCoachingIssues = (searchCoaching || []).filter(c =>
    c.type === 'weak_opposing_queries' || c.type === 'opposing_queries_too_similar'
  );
  const hasTargetedOpposing = (searchStrategy.opposing_queries || []).length >= 2 &&
    opposingCoachingIssues.length === 0;

  exercises.push({
    skill_key: 'biopsychosocial_integration',
    hit: hasTargetedOpposing,
    detail: hasTargetedOpposing
      ? 'Your revision search targeted specific criticisms across domains — you investigated whether the criticism revealed a genuine gap in your formulation rather than just defending your original position.'
      : 'Your revision opposing search was generic rather than targeting specific domain gaps. Integration in revision means investigating whether your formulation missed a biological, psychological, or social factor that the reviewer identified.',
  });

  exercises.push({
    skill_key: 'differential_diagnosis',
    hit: hasTargetedOpposing,
    detail: hasTargetedOpposing
      ? 'Your revision search independently targeted counter-evidence to the criticisms raised, treating each criticism as a diagnostic hypothesis to investigate.'
      : 'Your revision search had coaching flags — opposing queries may have been generic. In revision, opposing queries should test whether each criticism identifies a genuine diagnostic or formulation gap.',
  });

  return exercises;
}

// ── Revision content extractor ───────────────────────────────────────────────

function revisionContent(revision, revisionContext) {
  const searchStrategy = revision.search_strategy || {};
  const ctx = revisionContext || {};
  const content = { what_you_did: 'Submitted a clinical revision' };
  if (ctx.original_paper_title) content.original_paper = ctx.original_paper_title;
  if (ctx.title) content.revision_title = ctx.title;
  if (ctx.abstract) content.revision_abstract = ctx.abstract;
  if (searchStrategy.supporting_queries) content.supporting_queries = searchStrategy.supporting_queries;
  if (searchStrategy.opposing_queries) content.opposing_queries = searchStrategy.opposing_queries;
  return content;
}

// ── Bounty signals ───────────────────────────────────────────────────────────

function bountySignals(bounty, isValid) {
  const exercises = [];

  exercises.push({
    skill_key: 'therapeutic_reasoning',
    hit: isValid,
    detail: isValid
      ? `Valid bounty — you identified a genuine clinical reasoning flaw backed by evidence strong enough to survive community scrutiny (score impact: ${bounty.score_drop || 'pending'}).`
      : 'Invalid bounty — your challenge did not survive community review. Before the next challenge, evaluate whether your counter-evidence actually addresses the specific clinical claim, or whether you challenged a difference of clinical opinion rather than a reasoning flaw.',
  });

  const hasExternalSources = bounty.external_sources &&
    Array.isArray(bounty.external_sources) &&
    bounty.external_sources.length > 0;

  exercises.push({
    skill_key: 'evidence_based_selection',
    hit: isValid && hasExternalSources,
    detail: isValid && hasExternalSources
      ? `Challenge validated with ${bounty.external_sources.length} independently sourced counter-evidence — you found, evaluated, and correctly applied external clinical studies to contest a specific claim.`
      : 'Challenge lacked valid independent evidence. To challenge a clinical claim, you need evidence from studies with comparable populations and conditions — a study on a different population or severity level is not direct counter-evidence.',
  });

  return exercises;
}

// ── Bounty content extractor ─────────────────────────────────────────────────

function bountyContent(bounty, isValid, bountyContext) {
  const ctx = bountyContext || {};
  const content = {
    what_you_did: isValid ? 'Filed a validated clinical bounty' : 'Filed a clinical bounty (not yet validated)',
  };
  if (ctx.target_paper_title) content.target_paper = ctx.target_paper_title;
  if (ctx.challenge_type) content.challenge_type = ctx.challenge_type;
  if (bounty.score_drop) content.score_drop = bounty.score_drop;
  if (ctx.rebuttal_text) content.your_rebuttal = ctx.rebuttal_text;
  return content;
}

// ── Outcome signals (called after scoring) ───────────────────────────────────

function calibrationOutcomeSignal(confidenceScore, actualScore, deviation, calibrationHit) {
  return {
    skill_key: 'biopsychosocial_integration',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). Your confidence was well-calibrated — you accurately assessed the strength of your clinical argument across all domains.`
      : `Predicted ${confidenceScore}, actual ${actualScore} (deviation: ${deviation.toFixed(1)}). ${parseFloat(confidenceScore) > parseFloat(actualScore) ? 'You were overconfident — common cause: anchoring confidence to the strongest domain while ignoring gaps in others.' : 'You were underconfident — your clinical evidence was stronger than you assessed.'}`,
  };
}

function bountyOutcomeDisconfirmationSignal(challengeType) {
  return {
    skill_key: 'differential_diagnosis',
    hit: false,
    detail: `A validated bounty (${challengeType}) found a flaw your search should have caught. ${
      challengeType === 'missing_differential'
        ? 'The challenger identified an alternative diagnosis you failed to consider — your opposing queries should have searched for conditions that present similarly.'
        : challengeType === 'diagnostic_anchoring'
          ? 'You anchored on your initial hypothesis without adequate hierarchical exclusion. Your opposing search should have systematically tested alternative explanations.'
          : 'Your opposing queries should have been designed to find exactly this kind of counter-evidence before publication.'
    }`,
  };
}

function bountyOutcomeSourceEvaluationSignal(challengedDoi) {
  return {
    skill_key: 'evidence_based_selection',
    hit: false,
    detail: `A bounty successfully challenged a source you relied on (${challengedDoi}). Your source quality note either overestimated its strength or failed to account for limitations the challenger identified. The skill gap: evaluate what a study design CAN and CANNOT show for the specific clinical claim you are making.`,
  };
}

function revisionOutcomeSignal(revisionScore, originalScore, improvement, beliefHit) {
  return {
    skill_key: 'biopsychosocial_integration',
    hit: beliefHit,
    detail: beliefHit
      ? `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (+${improvement.toFixed(1)}). Your revision addressed the actual formulation or diagnostic gaps — you integrated feedback across domains and the paper improved.`
      : `Revision scored ${revisionScore.toFixed(1)} vs original ${originalScore.toFixed(1)} (${improvement.toFixed(1)}). The revision did not improve. Common causes: addressing surface-level feedback while missing the core formulation gap, or defending your original position rather than genuinely re-evaluating across all domains.`,
  };
}

function consensusOutcomeSignal(reviewScore, finalScore, deviation, accurateHit) {
  return {
    skill_key: 'therapeutic_reasoning',
    hit: accurateHit,
    detail: accurateHit
      ? `Your review score (${reviewScore}) was within ${deviation.toFixed(1)} of final consensus (${finalScore.toFixed(1)}). Your clinical assessment accurately identified the paper's strengths and reasoning flaws.`
      : `Your review score (${reviewScore}) deviated ${deviation.toFixed(1)} from final consensus (${finalScore.toFixed(1)}). ${
        reviewScore > finalScore
          ? 'You rated higher than consensus — you may have missed clinical reasoning flaws that other reviewers caught.'
          : 'You rated lower than consensus — you may have been too harsh on a flaw that other reviewers found less clinically significant.'
      }`,
  };
}

// ── Stopwords for semantic drift detection ───────────────────────────────────

const stopwords = new Set([
  'study', 'studies', 'research', 'evidence', 'finding', 'findings', 'result',
  'results', 'shows', 'shown', 'demonstrate', 'demonstrates', 'demonstrated',
  'suggest', 'suggests', 'indicated', 'indicates', 'reported', 'reports',
  'statistical', 'statistically', 'significant', 'significance', 'analysis',
  'analyses', 'method', 'methods', 'methodology', 'approach', 'sample',
  'control', 'group', 'groups', 'effect', 'effects', 'however', 'therefore',
  'whereas', 'although', 'associated', 'association', 'correlation', 'compared',
  'comparison', 'increase', 'increased', 'decrease', 'decreased', 'higher',
  'lower', 'found', 'observed', 'paper', 'papers', 'claim', 'claims',
  'patient', 'patients', 'treatment', 'diagnosis', 'clinical', 'psychiatric',
  'disorder', 'disorders', 'symptoms', 'symptom', 'therapy', 'medication',
  'consistent', 'inconsistent', 'conclude', 'concludes', 'conclusion',
  'conclusions', 'data', 'model', 'based', 'using', 'used', 'also', 'between',
  'within', 'across', 'through', 'specific', 'specifically', 'particular',
  'provide', 'provides', 'provided', 'author', 'authors', 'original',
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
