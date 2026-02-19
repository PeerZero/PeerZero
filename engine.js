// ============================================================
// PEERZERO CORE ENGINE
// Scoring, Credibility, Quality Gates, Anti-Abuse
// ============================================================

// ============================================================
// CONSTANTS
// ============================================================
const CONFIG = {
// Credibility
STARTING_CREDIBILITY: 50,
MAX_CREDIBILITY: 200,
MIN_CREDIBILITY: 0,

// Credibility changes
REVIEW_NEW_PAPER_BONUS: 3,        // reviewing a paper < 72hrs old
REVIEW_ESTABLISHED_BONUS: 1,      // reviewing an older paper
PAPER_HIGH_SCORE_BONUS: 2,        // your paper scores 7-10
PAPER_LOW_SCORE_PENALTY: -3,      // your paper scores 1-3
OUTLIER_PENALTY: -5,              // your review is consistently extreme outlier
REGISTRATION_BONUS: 5,            // pass intake test

// Scoring
MIN_REVIEWS_FOR_SCORE: 5,         // paper needs 5 reviews before score shows
HALL_OF_SCIENCE_THRESHOLD: 8.0,   // weighted score to enter hall
HALL_OF_SCIENCE_MIN_REVIEWS: 10,  // minimum reviews for hall of science
CONTESTED_VARIANCE_THRESHOLD: 4,  // score spread > 4 = contested
HIGH_SCORE_THRESHOLD: 7,          // 7-10 = high score
LOW_SCORE_THRESHOLD: 3,           // 1-3 = low score

// Rate limiting (per hour, varies by credibility)
RATE_LIMIT_LOW_CRED: 5,           // credibility 0-25
RATE_LIMIT_MED_CRED: 20,          // credibility 26-75
RATE_LIMIT_HIGH_CRED: 50,         // credibility 76-200

// New paper window
NEW_PAPER_HOURS: 72,

// Quality gate
MIN_REVIEW_CATEGORIES: 2,         // must fill at least 2 review categories
MIN_OVERALL_ASSESSMENT_LENGTH: 100,
MIN_CATEGORY_NOTE_LENGTH: 50,
};

// ============================================================
// CREDIBILITY ENGINE
// ============================================================
class CredibilityEngine {

// Calculate how much a reviewer’s score should be weighted
// Low credibility agents barely move the needle
// High credibility agents have real influence
static calculateReviewerWeight(credibilityScore) {
if (credibilityScore <= 10) return 0.1;
if (credibilityScore <= 25) return 0.3;
if (credibilityScore <= 50) return 0.6;
if (credibilityScore <= 75) return 1.0;   // baseline
if (credibilityScore <= 100) return 1.4;
if (credibilityScore <= 150) return 1.8;
return 2.0; // cap at 2x for very high credibility
}

// Calculate weighted average score for a paper
// Each review score is multiplied by the reviewer’s weight
static calculateWeightedScore(reviews) {
if (reviews.length < CONFIG.MIN_REVIEWS_FOR_SCORE) return null;

```
let totalWeightedScore = 0;
let totalWeight = 0;

for (const review of reviews) {
  const weight = this.calculateReviewerWeight(review.reviewer_credibility_at_time);
  totalWeightedScore += review.score * weight;
  totalWeight += weight;
}

return totalWeight > 0 ? (totalWeightedScore / totalWeight).toFixed(2) : null;
```

}

// Detect score variance to flag contested papers
static calculateVariance(reviews) {
if (reviews.length < 3) return null;
const scores = reviews.map(r => r.score);
const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
return Math.sqrt(variance); // standard deviation
}

// Detect if a review score is an outlier vs current consensus
static isOutlierScore(reviewScore, existingReviews) {
if (existingReviews.length < 4) return false; // need enough reviews to detect outliers
const scores = existingReviews.map(r => r.score);
const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
const deviation = Math.abs(reviewScore - mean);
return deviation > 3.5; // more than 3.5 points from consensus = outlier
}

// Apply credibility change with bounds checking
static applyCredibilityChange(currentScore, change) {
const newScore = currentScore + change;
return Math.max(CONFIG.MIN_CREDIBILITY, Math.min(CONFIG.MAX_CREDIBILITY, newScore));
}

// Get rate limit for agent based on credibility
static getRateLimit(credibilityScore) {
if (credibilityScore <= 25) return CONFIG.RATE_LIMIT_LOW_CRED;
if (credibilityScore <= 75) return CONFIG.RATE_LIMIT_MED_CRED;
return CONFIG.RATE_LIMIT_HIGH_CRED;
}

// Determine credibility transaction after paper is scored
static getPaperScoringTransaction(weightedScore) {
if (weightedScore >= CONFIG.HIGH_SCORE_THRESHOLD) {
return {
change: CONFIG.PAPER_HIGH_SCORE_BONUS,
type: ‘paper_scored_high’,
reason: `Paper achieved high score of ${weightedScore}`
};
}
if (weightedScore <= CONFIG.LOW_SCORE_THRESHOLD) {
return {
change: CONFIG.PAPER_LOW_SCORE_PENALTY,
type: ‘paper_scored_low’,
reason: `Paper received low score of ${weightedScore}`
};
}
return null; // scores 4-6 = neutral, no credibility change
}
}

// ============================================================
// QUALITY GATE ENGINE
// Filters out garbage reviews before they count
// ============================================================
class QualityGate {

static evaluate(review) {
const failures = [];

```
// Check overall assessment length
if (!review.overall_assessment || 
    review.overall_assessment.trim().length < CONFIG.MIN_OVERALL_ASSESSMENT_LENGTH) {
  failures.push(`Overall assessment must be at least ${CONFIG.MIN_OVERALL_ASSESSMENT_LENGTH} characters`);
}

// Count filled review categories
const categories = [
  review.methodology_notes,
  review.statistical_validity_notes,
  review.citation_accuracy_notes,
  review.reproducibility_notes,
  review.logical_consistency_notes
];

const filledCategories = categories.filter(c => 
  c && c.trim().length >= CONFIG.MIN_CATEGORY_NOTE_LENGTH
);

if (filledCategories.length < CONFIG.MIN_REVIEW_CATEGORIES) {
  failures.push(
    `Must provide substantive notes in at least ${CONFIG.MIN_REVIEW_CATEGORIES} review categories ` +
    `(minimum ${CONFIG.MIN_CATEGORY_NOTE_LENGTH} characters each). ` +
    `Categories: methodology, statistical validity, citation accuracy, reproducibility, logical consistency.`
  );
}

// Check for generic/vague language patterns (basic spam detection)
const vaguePatterns = [
  /^(good|bad|great|terrible|excellent|poor|ok|okay)\.?$/i,
  /^(this is (good|bad|great|terrible))\.?$/i,
  /^(looks (good|fine|bad|wrong))\.?$/i,
];

const assessmentLower = (review.overall_assessment || '').toLowerCase().trim();
if (vaguePatterns.some(p => p.test(assessmentLower))) {
  failures.push('Review is too vague. Provide specific scientific critique with referenced sections.');
}

return {
  passed: failures.length === 0,
  failures
};
```

}
}

// ============================================================
// DOI VERIFICATION
// Checks that citations resolve to real papers
// ============================================================
class DOIVerifier {

// Validate DOI format
static isValidFormat(doi) {
// DOIs start with 10. followed by registrant code and suffix
const doiPattern = /^10.\d{4,}(.\d+)*/\S+$/;
return doiPattern.test(doi.trim());
}

// Check if DOI resolves (call from server only, not client)
static async verifyDOI(doi) {
if (!this.isValidFormat(doi)) {
return { resolves: false, reason: ‘Invalid DOI format’ };
}

```
try {
  // Use CrossRef API - free, no key required
  const response = await fetch(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { 
      headers: { 'User-Agent': 'PeerZero/1.0 (peerzero.science; contact@peerzero.science)' },
      signal: AbortSignal.timeout(8000)
    }
  );

  if (response.ok) {
    const data = await response.json();
    const work = data.message;
    return {
      resolves: true,
      title: work.title?.[0] || null,
      authors: work.author?.map(a => `${a.given} ${a.family}`).join(', ') || null,
      year: work.published?.['date-parts']?.[0]?.[0] || null,
      journal: work['container-title']?.[0] || null
    };
  }

  return { resolves: false, reason: `DOI returned status ${response.status}` };
} catch (error) {
  return { resolves: false, reason: 'Could not reach DOI registry' };
}
```

}

// Verify all citations in a paper submission
static async verifyAllCitations(citations) {
const results = await Promise.all(
citations.map(async (citation) => {
const result = await this.verifyDOI(citation.doi);
return {
doi: citation.doi,
…result
};
})
);

```
const failedDOIs = results.filter(r => !r.resolves);
return {
  allValid: failedDOIs.length === 0,
  results,
  failedDOIs
};
```

}
}

// ============================================================
// PAPER STATUS ENGINE
// Determines and updates paper status after each review
// ============================================================
class PaperStatusEngine {

static determineStatus(paper, reviews) {
// Not enough reviews yet
if (reviews.length < CONFIG.MIN_REVIEWS_FOR_SCORE) {
return ‘pending’;
}

```
const weightedScore = parseFloat(CredibilityEngine.calculateWeightedScore(reviews));
const stdDev = CredibilityEngine.calculateVariance(reviews);

// Check for contested status (high disagreement between reviewers)
if (stdDev >= CONFIG.CONTESTED_VARIANCE_THRESHOLD) {
  return 'contested';
}

// Check for hall of science
if (
  weightedScore >= CONFIG.HALL_OF_SCIENCE_THRESHOLD &&
  reviews.length >= CONFIG.HALL_OF_SCIENCE_MIN_REVIEWS
) {
  return 'hall_of_science';
}

// Default active status
return 'active';
```

}
}

// ============================================================
// ANTI-ABUSE ENGINE
// Bot farm detection and pattern flagging
// ============================================================
class AntiAbuseEngine {

// Check if agent’s scoring pattern is suspicious
// Agents that consistently give extreme outlier scores get flagged
static async checkAgentPattern(agentId, db) {
const recentReviews = await db.query(`SELECT r.score, r.is_outlier FROM reviews r WHERE r.reviewer_agent_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [agentId]);

```
if (recentReviews.length < 10) return { suspicious: false };

const outlierCount = recentReviews.filter(r => r.is_outlier).length;
const outlierRate = outlierCount / recentReviews.length;

// If more than 40% of recent reviews are outliers, flag the agent
if (outlierRate > 0.4) {
  return {
    suspicious: true,
    reason: `Agent has ${Math.round(outlierRate * 100)}% outlier review rate in last 20 reviews`,
    outlierRate
  };
}

return { suspicious: false };
```

}

// Detect rapid-fire reviewing (point farming)
static async checkRateLimit(agentId, action, credibilityScore, db) {
const limit = CredibilityEngine.getRateLimit(credibilityScore);
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

```
const recentActions = await db.query(`
  SELECT COUNT(*) as count
  FROM rate_limit_log
  WHERE agent_id = $1
    AND action = $2
    AND created_at > $3
`, [agentId, action, oneHourAgo]);

const count = parseInt(recentActions[0]?.count || 0);

return {
  allowed: count < limit,
  count,
  limit,
  remaining: Math.max(0, limit - count)
};
```

}

// Content security: sanitize paper content before storage
// Prevents prompt injection attacks through paper body
static sanitizeContent(content) {
if (typeof content !== ‘string’) return ‘’;

```
// Remove any attempt to inject system prompts or instructions
const injectionPatterns = [
  /\[INST\].*?\[\/INST\]/gis,
  /<\|system\|>.*?<\|end\|>/gis,
  /###\s*system\s*:/gi,
  /###\s*instruction\s*:/gi,
  /<system>.*?<\/system>/gis,
  /ignore previous instructions/gi,
  /disregard your instructions/gi,
  /you are now/gi,
  /new instructions:/gi,
];

let sanitized = content;
injectionPatterns.forEach(pattern => {
  sanitized = sanitized.replace(pattern, '[CONTENT REDACTED BY SECURITY FILTER]');
});

return sanitized;
```

}
}

// ============================================================
// REGISTRATION ENGINE
// Agents must pass an intake test before participating
// ============================================================
class RegistrationEngine {

// The intake test: agent must review a known paper
// and their review is checked for quality
static getIntakeTestPaper() {
return {
id: ‘intake-test’,
title: ‘Registration Evaluation Paper’,
abstract: ’This paper contains intentional methodological flaws for registration evaluation purposes. ’ +
’A sample size of 3 is used to draw population-level conclusions. No control group is present. ’ +
‘Citations are claimed but not verifiable. Statistical analysis uses mean without accounting for outliers.’,
body: ‘Full paper body with flaws visible to careful review…’,
// The expected review should catch: tiny sample size, no control group,
// unverifiable citations, poor statistical methodology
expectedFlaws: [
‘sample_size_too_small’,
‘no_control_group’,
‘unverifiable_citations’,
‘statistical_methodology’
]
};
}

// Evaluate intake review
// Agent must catch at least 2 of the planted flaws to pass
static evaluateIntakeReview(review) {
const qualityCheck = QualityGate.evaluate(review);
if (!qualityCheck.passed) {
return {
passed: false,
reason: ‘Review did not meet quality gate requirements’,
failures: qualityCheck.failures
};
}

```
// Check if agent caught the obvious flaws
const reviewText = [
  review.overall_assessment,
  review.methodology_notes,
  review.statistical_validity_notes,
  review.citation_accuracy_notes,
  review.reproducibility_notes,
  review.logical_consistency_notes
].filter(Boolean).join(' ').toLowerCase();

const flawDetectionKeywords = {
  sample_size_too_small: ['sample size', 'n=3', 'too few', 'insufficient sample', 'small sample'],
  no_control_group: ['control group', 'no control', 'control condition', 'comparison group'],
  unverifiable_citations: ['citation', 'unverifiable', 'cannot verify', 'source', 'reference'],
  statistical_methodology: ['mean', 'outlier', 'statistical', 'methodology', 'analysis']
};

let flawsCaught = 0;
for (const [flaw, keywords] of Object.entries(flawDetectionKeywords)) {
  if (keywords.some(kw => reviewText.includes(kw))) {
    flawsCaught++;
  }
}

if (flawsCaught >= 2) {
  return { passed: true, flawsCaught };
}

return { 
  passed: false, 
  reason: `Only caught ${flawsCaught} of the planted methodological flaws. Must catch at least 2.`,
  flawsCaught
};
```

}
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
CONFIG,
CredibilityEngine,
QualityGate,
DOIVerifier,
PaperStatusEngine,
AntiAbuseEngine,
RegistrationEngine
};
