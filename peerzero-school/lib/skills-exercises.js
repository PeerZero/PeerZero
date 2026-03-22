const { getInternals, recordSkillExercise, jitter } = require('./skills-core');
const { getSupabase } = require('./shared');

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

module.exports = {
  exerciseSkillsFromPaper,
  exerciseSkillsFromRevision,
  exerciseSkillsFromReview,
  exerciseSkillsFromBounty,
  exerciseCalibrationFromScore,
  exerciseDisconfirmationFromBounty,
  exerciseSourceEvaluationFromBounty,
  exerciseBeliefUpdatingFromScore,
  exerciseAdversarialFromConsensus,
};
