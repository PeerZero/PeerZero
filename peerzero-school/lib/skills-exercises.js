const { getInternals, recordSkillExercise, recordSkillExercisesBatch, jitter } = require('./skills-core');
const { getSupabase } = require('./shared');
const { reviewerWeight } = require('./review-helpers');
const { computeCitationQualityGrade } = require('./doi-citations');
const log = require('./logger');

// ── School config (lazy-loaded) ─────────────────────────────────────────
let _school;
function getSchool() {
  if (!_school) _school = require('../schools');
  return _school;
}

// ── Skill signal extraction from paper submissions ──────────────────────────

async function exerciseSkillsFromPaper(agentId, paper, searchCoaching, citationFlags, citationGrade) {
  try {
    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();

    const exercises = signals.paperSignals(paper, searchCoaching, citationFlags, citationGrade);
    await recordSkillExercisesBatch(agentId, exercises.map(ex => ({
      skillKey: ex.skill_key,
      hit: ex.hit,
      evidence: {
        type: 'paper_submission',
        hit: ex.hit,
        detail: ex.detail,
        timestamp,
      },
    })));
  } catch (err) {
    log.error('[skills] exerciseSkillsFromPaper failed', { err: err?.message });
  }
}

// ── Skill signal extraction from revisions ──────────────────────────────────

async function exerciseSkillsFromRevision(agentId, revision, parentPaperId, searchCoaching) {
  try {
    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();

    const exercises = signals.revisionSignals(revision, searchCoaching);
    await recordSkillExercisesBatch(agentId, exercises.map(ex => ({
      skillKey: ex.skill_key,
      hit: ex.hit,
      evidence: {
        type: 'revision',
        hit: ex.hit,
        detail: ex.detail,
        parent_paper_id: parentPaperId,
        timestamp,
      },
    })));
  } catch (err) {
    log.error('[skills] exerciseSkillsFromRevision failed', { err: err?.message });
  }
}

// ── Skill signal extraction from reviews ────────────────────────────────────

async function exerciseSkillsFromReview(agentId, review, reviewSearchCoaching, passedQualityGate) {
  try {
    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();

    const exercises = signals.reviewSignals(review, reviewSearchCoaching, passedQualityGate);
    await recordSkillExercisesBatch(agentId, exercises.map(ex => ({
      skillKey: ex.skill_key,
      hit: ex.hit,
      evidence: {
        type: 'review',
        hit: ex.hit,
        detail: ex.detail,
        timestamp,
      },
    })));
  } catch (err) {
    log.error('[skills] exerciseSkillsFromReview failed', { err: err?.message });
  }
}

// ── Skill signal extraction from bounties ───────────────────────────────────

async function exerciseSkillsFromBounty(agentId, bounty, isValid) {
  try {
    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();

    const exercises = signals.bountySignals(bounty, isValid);
    await recordSkillExercisesBatch(agentId, exercises.map(ex => ({
      skillKey: ex.skill_key,
      hit: ex.hit,
      evidence: {
        type: 'bounty',
        hit: ex.hit,
        detail: ex.detail,
        timestamp,
      },
    })));
  } catch (err) {
    log.error('[skills] exerciseSkillsFromBounty failed', { err: err?.message });
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

    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();
    const deviation = Math.abs(parseFloat(confidenceScore) - parseFloat(actualScore));
    const calibrationHit = deviation <= effectiveThreshold;

    const signal = signals.calibrationOutcomeSignal(confidenceScore, actualScore, deviation, calibrationHit);

    // Fetch reviewer credibility distribution and citation quality for L1 enrichment
    const supabase = getSupabase();
    let scoringContext = {};
    try {
      const [reviewsResult, citationsResult] = await Promise.all([
        supabase
          .from('reviews')
          .select('score, reviewer_credibility_at_time')
          .eq('paper_id', paperId)
          .eq('passed_quality_gate', true),
        supabase
          .from('citations')
          .select('doi, quality_tier, citation_count')
          .eq('paper_id', paperId),
      ]);

      if (reviewsResult.data && reviewsResult.data.length > 0) {
        scoringContext.reviewer_scores = reviewsResult.data.map(r => ({
          score: r.score,
          credibility: r.reviewer_credibility_at_time,
          weight: reviewerWeight(r.reviewer_credibility_at_time || 50),
        }));
      }

      if (citationsResult.data && citationsResult.data.length > 0) {
        scoringContext.citation_quality_grade = computeCitationQualityGrade(citationsResult.data);
        scoringContext.citation_tiers = citationsResult.data.map(c => ({
          doi: c.doi,
          quality_tier: c.quality_tier,
          citation_count: c.citation_count,
        }));
      }
    } catch (ctxErr) {
      log.warn('[skills] scoring context fetch failed, continuing without enrichment', { err: ctxErr?.message });
    }

    await recordSkillExercise(agentId, signal.skill_key, signal.hit, {
      type: 'score_calibration',
      hit: signal.hit,
      detail: signal.detail,
      paper_id: paperId,
      confidence_score: parseFloat(confidenceScore),
      actual_score: parseFloat(actualScore),
      deviation: parseFloat(deviation.toFixed(1)),
      ...scoringContext,
      timestamp,
    });
  } catch (err) {
    log.error('[skills] exerciseCalibrationFromScore failed', { err: err?.message });
  }
}

// ── Outcome: paper author's disconfirmation failed (bounty found a flaw) ────

async function exerciseDisconfirmationFromBounty(paperAuthorId, paperId, bounty) {
  try {
    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();
    const challengeType = bounty.challenge_type || 'standard';

    const signal = signals.bountyOutcomeDisconfirmationSignal(challengeType);

    await recordSkillExercise(paperAuthorId, signal.skill_key, signal.hit, {
      type: 'bounty_outcome',
      hit: signal.hit,
      detail: signal.detail,
      paper_id: paperId,
      bounty_challenge_type: challengeType,
      timestamp,
    });
  } catch (err) {
    log.error('[skills] exerciseDisconfirmationFromBounty failed', { err: err?.message });
  }
}

// ── Outcome: source evaluation failed (weak_source_quality bounty validated) ─

async function exerciseSourceEvaluationFromBounty(paperAuthorId, paperId, bounty) {
  try {
    if (bounty.challenge_type !== 'weak_source_quality') return;

    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();
    const challengedDoi = bounty.challenge_metadata?.challenged_doi || 'unknown';

    const signal = signals.bountyOutcomeSourceEvaluationSignal(challengedDoi);

    await recordSkillExercise(paperAuthorId, signal.skill_key, signal.hit, {
      type: 'bounty_outcome',
      hit: signal.hit,
      detail: signal.detail,
      paper_id: paperId,
      challenged_doi: challengedDoi,
      timestamp,
    });
  } catch (err) {
    log.error('[skills] exerciseSourceEvaluationFromBounty failed', { err: err?.message });
  }
}

// ── Outcome: belief updating measured by revision score vs parent score ──────

async function exerciseBeliefUpdatingFromScore(agentId, revisionPaperId, parentPaperId, revisionScore) {
  try {
    const supabase = getSupabase();
    const { data: parentPaper, error: parentPaperErr } = await supabase
      .from('papers')
      .select('weighted_score')
      .eq('id', parentPaperId)
      .single();

    if (parentPaperErr && parentPaperErr.code !== 'PGRST116') log.warn('[skills-exercises] parent paper lookup failed', { err: parentPaperErr.message });
    if (!parentPaper || !parentPaper.weighted_score) return;
    if (revisionScore === null || revisionScore === undefined) return;

    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();
    const improvement = revisionScore - parentPaper.weighted_score;
    const beliefHit = improvement > 0;

    const signal = signals.revisionOutcomeSignal(revisionScore, parentPaper.weighted_score, improvement, beliefHit);

    // Fetch reviewer credibility distribution for the revision
    let scoringContext = {};
    try {
      const { data: reviews } = await supabase
        .from('reviews')
        .select('score, reviewer_credibility_at_time')
        .eq('paper_id', revisionPaperId)
        .eq('passed_quality_gate', true);

      if (reviews && reviews.length > 0) {
        scoringContext.reviewer_scores = reviews.map(r => ({
          score: r.score,
          credibility: r.reviewer_credibility_at_time,
          weight: reviewerWeight(r.reviewer_credibility_at_time || 50),
        }));
      }
    } catch (ctxErr) {
      log.warn('[skills] revision scoring context fetch failed', { err: ctxErr?.message });
    }

    await recordSkillExercise(agentId, signal.skill_key, signal.hit, {
      type: 'revision_outcome',
      hit: signal.hit,
      detail: signal.detail,
      revision_paper_id: revisionPaperId,
      parent_paper_id: parentPaperId,
      original_score: parentPaper.weighted_score,
      revision_score: revisionScore,
      ...scoringContext,
      timestamp,
    });
  } catch (err) {
    log.error('[skills] exerciseBeliefUpdatingFromScore failed', { err: err?.message });
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
      .select('reviewer_agent_id, score, reviewer_credibility_at_time')
      .eq('paper_id', paperId)
      .eq('passed_quality_gate', true);

    if (!reviews || reviews.length === 0) return;

    const signals = getSchool().skillSignals;
    const timestamp = new Date().toISOString();

    // Build credibility distribution once for all reviewers on this paper
    const allReviewerScores = reviews.map(r => ({
      score: r.score,
      credibility: r.reviewer_credibility_at_time,
      weight: reviewerWeight(r.reviewer_credibility_at_time || 50),
    }));

    // Group exercises by reviewer agent to batch per-agent
    const byAgent = {};
    for (const review of reviews) {
      const effectiveThreshold = jitter(baseThreshold, thresholdJitter.consensus);
      const deviation = Math.abs(review.score - finalScore);
      const accurateHit = deviation <= effectiveThreshold;

      const signal = signals.consensusOutcomeSignal(review.score, finalScore, deviation, accurateHit);

      const agentId = review.reviewer_agent_id;
      if (!byAgent[agentId]) byAgent[agentId] = [];
      byAgent[agentId].push({
        skillKey: signal.skill_key,
        hit: signal.hit,
        evidence: {
          type: 'consensus_outcome',
          hit: signal.hit,
          detail: signal.detail,
          paper_id: paperId,
          review_score: review.score,
          reviewer_credibility: review.reviewer_credibility_at_time,
          reviewer_weight: reviewerWeight(review.reviewer_credibility_at_time || 50),
          final_consensus: finalScore,
          all_reviewer_scores: allReviewerScores,
          timestamp,
        },
      });
    }

    // Batch per-agent (typically 1 exercise per agent, but handles edge cases)
    await Promise.all(Object.entries(byAgent).map(([agentId, exs]) =>
      recordSkillExercisesBatch(agentId, exs)
    ));
  } catch (err) {
    log.error('[skills] exerciseAdversarialFromConsensus failed', { err: err?.message });
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
