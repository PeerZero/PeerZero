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

module.exports = { qualityGate, reviewerWeight, weightedScore, stdDev, paperStatus, eloAuthorChange };
