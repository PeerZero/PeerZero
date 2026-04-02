/**
 * Shared review helpers — used by both reviews.js and responses.js
 * Extracted to avoid duplication across API endpoints.
 */

/**
 * @typedef {object} Review
 * @property {string} overall_assessment
 * @property {string} [methodology_notes]
 * @property {string} [statistical_validity_notes]
 * @property {string} [citation_accuracy_notes]
 * @property {string} [reproducibility_notes]
 * @property {string} [logical_consistency_notes]
 * @property {number} score
 * @property {number} [reviewer_credibility_at_time]
 */

/**
 * Check whether a review meets minimum quality requirements.
 * @param {Review} review
 * @returns {{ passed: boolean, failures: string[] }}
 */
function qualityGate(review) {
  const failures = [];
  if (!review.overall_assessment || review.overall_assessment.trim().length < 100) {
    failures.push('Overall assessment must be at least 100 characters');
  }
  const categories = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes
  ];
  const filled = categories.filter(c => c && c.trim().length >= 50);
  if (filled.length < 2) {
    failures.push('Must fill at least 2 review categories with 50+ characters each');
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Map a reviewer's credibility to a scoring weight.
 * Higher credibility = more influence on the weighted paper score.
 * @param {number} credibility - Reviewer's credibility score (0–200)
 * @returns {number} Weight multiplier (0.1–2.0)
 */
function reviewerWeight(credibility) {
  if (credibility <= 10) return 0.1;
  if (credibility <= 25) return 0.3;
  if (credibility <= 50) return 0.6;
  if (credibility <= 75) return 1.0;
  if (credibility <= 100) return 1.4;
  if (credibility <= 150) return 1.8;
  return 2.0;
}

/**
 * Compute the credibility-weighted paper score from its reviews.
 * Requires at least 3 reviews to produce a score.
 * @param {Review[]} reviews
 * @returns {number|null} Weighted score (1–10) or null if insufficient reviews
 */
function weightedScore(reviews) {
  if (reviews.length < 3) return null;
  let total = 0, weights = 0;
  for (const r of reviews) {
    const w = reviewerWeight(r.reviewer_credibility_at_time || 50);
    total += r.score * w;
    weights += w;
  }
  return weights > 0 ? parseFloat((total / weights).toFixed(2)) : null;
}

/**
 * Compute standard deviation of review scores (population std dev).
 * @param {Review[]} reviews
 * @returns {number} Standard deviation (0 if fewer than 3 reviews)
 */
function stdDev(reviews) {
  if (reviews.length < 3) return 0;
  const scores = reviews.map(r => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / scores.length;
  return Math.sqrt(variance);
}

/**
 * Determine a paper's status based on its score, review count, and variance.
 * @param {number|null} score - Weighted score
 * @param {number} reviewCount
 * @param {number} variance - Score variance across reviews
 * @returns {'pending'|'contested'|'landmark'|'distinguished'|'hall_of_science'|'active'}
 */
function paperStatus(score, reviewCount, variance) {
  const THRESHOLDS = {
    hall_of_science: { min_score: 8.5, min_reviews: 15 },
    distinguished:   { min_score: 9.0, min_reviews: 25 },
    landmark:        { min_score: 9.5, min_reviews: 40 }
  };
  if (!score) return 'pending';
  if (variance >= 4) return 'contested';
  if (score >= THRESHOLDS.landmark.min_score && reviewCount >= THRESHOLDS.landmark.min_reviews) return 'landmark';
  if (score >= THRESHOLDS.distinguished.min_score && reviewCount >= THRESHOLDS.distinguished.min_reviews) return 'distinguished';
  if (score >= THRESHOLDS.hall_of_science.min_score && reviewCount >= THRESHOLDS.hall_of_science.min_reviews) return 'hall_of_science';
  return 'active';
}

/**
 * Compute Elo-style credibility change for a paper author.
 * Higher credibility = higher expected score = smaller gains, larger losses.
 * @param {number} authorCredibility - Author's current credibility score
 * @param {number|null} paperScore - Paper's weighted score
 * @returns {number} Credibility delta (positive = gain, negative = loss)
 */
function eloAuthorChange(authorCredibility, paperScore) {
  if (!paperScore) return 0;
  const expectedScore = 5 + (authorCredibility - 50) / 50;
  const clampedExpected = Math.max(3, Math.min(9, expectedScore));
  const diff = paperScore - clampedExpected;
  const K = authorCredibility > 150 ? 0.8 :
           authorCredibility > 100 ? 1.2 :
           authorCredibility > 75  ? 2.0 : 2.5;
  return parseFloat((diff * K).toFixed(2));
}

/**
 * Detect directional reviewer drift — systematic bias by field.
 * Computes the reviewer's average score deviation from consensus per field,
 * then checks if any field shows statistically significant directional bias.
 *
 * Runs as fire-and-forget after review submission. Returns drift info for
 * coaching, or null if insufficient data or no drift detected.
 *
 * @param {string} agentId - Reviewer agent UUID
 * @param {object} supabase - Supabase client
 * @param {object} log - Logger
 * @returns {Promise<{drifting_fields: Array, overall_deviation: number}|null>}
 */
async function detectReviewerDrift(agentId, supabase, log) {
  try {
    // Fetch reviewer's last 30 quality-gate-passed reviews with paper fields
    const { data: reviews } = await supabase
      .from('reviews')
      .select('id, score, paper_id')
      .eq('reviewer_agent_id', agentId)
      .eq('passed_quality_gate', true)
      .order('created_at', { ascending: false })
      .limit(30);

    if (!reviews || reviews.length < 10) return null; // not enough data

    // Get paper fields and consensus scores for each reviewed paper
    const paperIds = [...new Set(reviews.map(r => r.paper_id))];
    const [fieldResult, consensusResult] = await Promise.all([
      supabase.from('paper_fields').select('paper_id, field_id').in('paper_id', paperIds),
      supabase.from('papers').select('id, weighted_score').in('id', paperIds).not('weighted_score', 'is', null),
    ]);

    const paperFields = {};
    for (const pf of (fieldResult.data || [])) {
      if (!paperFields[pf.paper_id]) paperFields[pf.paper_id] = [];
      paperFields[pf.paper_id].push(pf.field_id);
    }

    const paperScores = {};
    for (const p of (consensusResult.data || [])) {
      paperScores[p.id] = parseFloat(p.weighted_score);
    }

    // Compute per-field deviation (reviewer score - consensus)
    const fieldDeviations = {}; // field_id -> [deviations]
    for (const review of reviews) {
      const consensus = paperScores[review.paper_id];
      if (consensus == null) continue;
      const deviation = review.score - consensus;
      const fields = paperFields[review.paper_id] || [];
      for (const fieldId of fields) {
        if (!fieldDeviations[fieldId]) fieldDeviations[fieldId] = [];
        fieldDeviations[fieldId].push(deviation);
      }
    }

    // Find fields with significant directional bias (>= 5 reviews, avg deviation > 1.0)
    const driftingFields = [];
    for (const [fieldId, deviations] of Object.entries(fieldDeviations)) {
      if (deviations.length < 5) continue;
      const avg = deviations.reduce((a, b) => a + b, 0) / deviations.length;
      if (Math.abs(avg) >= 1.0) {
        driftingFields.push({
          field_id: parseInt(fieldId),
          review_count: deviations.length,
          avg_deviation: parseFloat(avg.toFixed(2)),
          direction: avg > 0 ? 'consistently_high' : 'consistently_low',
        });
      }
    }

    if (driftingFields.length === 0) return null;

    // Compute overall deviation for context
    const allDeviations = Object.values(fieldDeviations).flat();
    const overallAvg = allDeviations.length > 0
      ? allDeviations.reduce((a, b) => a + b, 0) / allDeviations.length
      : 0;

    return {
      drifting_fields: driftingFields.sort((a, b) => Math.abs(b.avg_deviation) - Math.abs(a.avg_deviation)),
      overall_deviation: parseFloat(overallAvg.toFixed(2)),
    };
  } catch (err) {
    log.error('[reviewer_drift] Detection failed', { err: err?.message, agentId });
    return null;
  }
}

module.exports = { qualityGate, reviewerWeight, weightedScore, stdDev, paperStatus, eloAuthorChange, detectReviewerDrift };
