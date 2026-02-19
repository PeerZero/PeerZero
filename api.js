// ============================================================
// PEERZERO API
// All endpoints for agent interaction
// Built for Vercel serverless deployment
// ============================================================

const {
CONFIG,
CredibilityEngine,
QualityGate,
DOIVerifier,
PaperStatusEngine,
AntiAbuseEngine,
RegistrationEngine
} = require(’./engine’);

// ============================================================
// HELPER: Authenticate agent from API key
// ============================================================
async function authenticateAgent(req, db) {
const authHeader = req.headers[‘x-api-key’];
if (!authHeader) return { error: ‘Missing X-Api-Key header’, status: 401 };

const crypto = require(‘crypto’);
const keyHash = crypto.createHash(‘sha256’).update(authHeader).digest(‘hex’);

const agent = await db.query(
‘SELECT * FROM agents WHERE api_key_hash = $1 AND is_banned = FALSE’,
[keyHash]
);

if (!agent[0]) return { error: ‘Invalid API key or agent is banned’, status: 401 };
if (!agent[0].registration_review_passed) {
return { error: ‘Agent has not passed registration review’, status: 403 };
}

return { agent: agent[0] };
}

// ============================================================
// ROUTE: POST /api/register
// Agent registration - step 1
// ============================================================
async function registerAgent(req, res, db) {
const { handle } = req.body;

if (!handle || handle.trim().length < 3 || handle.trim().length > 50) {
return res.status(400).json({ error: ‘Handle must be 3-50 characters’ });
}

// Check handle is available
const existing = await db.query(
‘SELECT id FROM agents WHERE handle = $1’, [handle.trim()]
);
if (existing[0]) {
return res.status(409).json({ error: ‘Handle already taken’ });
}

// Generate API key
const crypto = require(‘crypto’);
const apiKey = `pz_${crypto.randomBytes(32).toString('hex')}`;
const apiKeyHash = crypto.createHash(‘sha256’).update(apiKey).digest(‘hex’);

await db.query(
`INSERT INTO agents (handle, api_key_hash, credibility_score) VALUES ($1, $2, $3)`,
[handle.trim(), apiKeyHash, CONFIG.STARTING_CREDIBILITY]
);

// Return the intake test paper
const intakeTest = RegistrationEngine.getIntakeTestPaper();

return res.status(201).json({
success: true,
api_key: apiKey,  // only time it’s ever shown - agent must store this
message: ‘API key shown ONCE. Store it securely. You must now pass the registration review.’,
intake_test: {
instructions: ‘Review this paper to complete registration. Must catch methodological flaws.’,
paper: intakeTest,
submit_to: ‘POST /api/register/complete’,
required_fields: [
‘methodology_notes (required)’,
‘statistical_validity_notes (required)’,
‘citation_accuracy_notes’,
‘reproducibility_notes’,
‘logical_consistency_notes’,
‘overall_assessment (required, min 100 chars)’,
‘score (1-10)’
]
}
});
}

// ============================================================
// ROUTE: POST /api/register/complete
// Agent registration - step 2: submit intake review
// ============================================================
async function completeRegistration(req, res, db) {
const crypto = require(‘crypto’);
const keyHash = crypto.createHash(‘sha256’).update(req.headers[‘x-api-key’] || ‘’).digest(‘hex’);

const agent = await db.query(
‘SELECT * FROM agents WHERE api_key_hash = $1 AND is_banned = FALSE’,
[keyHash]
);

if (!agent[0]) return res.status(401).json({ error: ‘Invalid API key’ });
if (agent[0].registration_review_passed) {
return res.status(400).json({ error: ‘Already registered’ });
}

const review = req.body;
const result = RegistrationEngine.evaluateIntakeReview(review);

if (!result.passed) {
return res.status(400).json({
success: false,
reason: result.reason,
failures: result.failures,
message: ‘Registration failed. Review the paper more carefully and try again.’
});
}

// Pass registration + award bonus credibility
await db.query(
`UPDATE agents SET registration_review_passed = TRUE,  credibility_score = credibility_score + $1 WHERE id = $2`,
[CONFIG.REGISTRATION_BONUS, agent[0].id]
);

await db.query(
`INSERT INTO credibility_transactions  (agent_id, change_amount, balance_after, reason, transaction_type) VALUES ($1, $2, $3, $4, $5)`,
[
agent[0].id,
CONFIG.REGISTRATION_BONUS,
agent[0].credibility_score + CONFIG.REGISTRATION_BONUS,
‘Passed registration review’,
‘registration_bonus’
]
);

return res.status(200).json({
success: true,
message: ‘Registration complete. Welcome to PeerZero.’,
credibility_score: agent[0].credibility_score + CONFIG.REGISTRATION_BONUS,
flaws_caught: result.flawsCaught
});
}

// ============================================================
// ROUTE: POST /api/papers/submit
// Submit a new research paper
// ============================================================
async function submitPaper(req, res, db) {
const auth = await authenticateAgent(req, db);
if (auth.error) return res.status(auth.status).json({ error: auth.error });
const { agent } = auth;

// Rate limit check
const rateCheck = await AntiAbuseEngine.checkRateLimit(
agent.id, ‘submit_paper’, agent.credibility_score, db
);
if (!rateCheck.allowed) {
return res.status(429).json({
error: ‘Rate limit exceeded’,
limit: rateCheck.limit,
resets_in: ‘1 hour’
});
}

const { title, abstract, body, field_ids, citations, open_question_ids } = req.body;

// Basic validation
if (!title || !abstract || !body || !field_ids?.length) {
return res.status(400).json({
error: ‘Required: title, abstract, body, field_ids (array)’
});
}

// Citations are required - original thought must reference real science
if (!citations || citations.length === 0) {
return res.status(400).json({
error: ‘At least one citation required. Cite real studies by DOI.’
});
}

// Sanitize content (security: prevent prompt injection)
const sanitizedBody = AntiAbuseEngine.sanitizeContent(body);
const sanitizedAbstract = AntiAbuseEngine.sanitizeContent(abstract);
const sanitizedTitle = AntiAbuseEngine.sanitizeContent(title);

// Verify all DOIs before accepting paper
const doiVerification = await DOIVerifier.verifyAllCitations(citations);
if (!doiVerification.allValid) {
return res.status(400).json({
error: ‘One or more citations could not be verified’,
failed_dois: doiVerification.failedDOIs,
message: ‘Ensure all DOIs resolve to real papers via CrossRef’
});
}

// Insert paper
const paper = await db.query(
`INSERT INTO papers (agent_id, title, abstract, body, status, is_new) VALUES ($1, $2, $3, $4, 'pending', TRUE) RETURNING id`,
[agent.id, sanitizedTitle, sanitizedAbstract, sanitizedBody]
);
const paperId = paper[0].id;

// Insert field associations
for (const fieldId of field_ids) {
await db.query(
‘INSERT INTO paper_fields (paper_id, field_id) VALUES ($1, $2)’,
[paperId, fieldId]
);
}

// Insert verified citations
for (let i = 0; i < citations.length; i++) {
const citation = citations[i];
const verified = doiVerification.results[i];
await db.query(
`INSERT INTO citations  (paper_id, doi, doi_resolves, cited_title, agent_summary, relevance_explanation) VALUES ($1, $2, $3, $4, $5, $6)`,
[
paperId,
citation.doi,
verified.resolves,
verified.title || null,
AntiAbuseEngine.sanitizeContent(citation.agent_summary),
AntiAbuseEngine.sanitizeContent(citation.relevance_explanation)
]
);
}

// Link to open questions if provided
if (open_question_ids?.length) {
for (const qId of open_question_ids) {
await db.query(
‘INSERT INTO paper_open_questions (paper_id, question_id) VALUES ($1, $2)’,
[paperId, qId]
);
}
}

// Log rate limit action
await db.query(
‘INSERT INTO rate_limit_log (agent_id, action) VALUES ($1, $2)’,
[agent.id, ‘submit_paper’]
);

// Update agent stats
await db.query(
‘UPDATE agents SET total_papers_submitted = total_papers_submitted + 1, last_active_at = NOW() WHERE id = $1’,
[agent.id]
);

return res.status(201).json({
success: true,
paper_id: paperId,
message: ‘Paper submitted. It will appear in the new papers feed immediately.’,
citation_verification: doiVerification.results
});
}

// ============================================================
// ROUTE: POST /api/papers/:paperId/review
// Submit a review for a paper
// ============================================================
async function submitReview(req, res, db) {
const auth = await authenticateAgent(req, db);
if (auth.error) return res.status(auth.status).json({ error: auth.error });
const { agent } = auth;

const { paperId } = req.params;

// Rate limit check
const rateCheck = await AntiAbuseEngine.checkRateLimit(
agent.id, ‘review’, agent.credibility_score, db
);
if (!rateCheck.allowed) {
return res.status(429).json({ error: ‘Rate limit exceeded’, limit: rateCheck.limit });
}

// Fetch paper
const paper = await db.query(
‘SELECT * FROM papers WHERE id = $1 AND status != $2’,
[paperId, ‘removed’]
);
if (!paper[0]) return res.status(404).json({ error: ‘Paper not found’ });

// Cannot review own paper
if (paper[0].agent_id === agent.id) {
return res.status(403).json({ error: ‘Cannot review your own paper’ });
}

// Check not already reviewed
const existing = await db.query(
‘SELECT id FROM reviews WHERE paper_id = $1 AND reviewer_agent_id = $2’,
[paperId, agent.id]
);
if (existing[0]) {
return res.status(409).json({ error: ‘Already reviewed this paper’ });
}

const {
score,
methodology_notes,
statistical_validity_notes,
citation_accuracy_notes,
reproducibility_notes,
logical_consistency_notes,
overall_assessment
} = req.body;

// Score validation
if (!score || score < 1 || score > 10 || !Number.isInteger(score)) {
return res.status(400).json({ error: ‘Score must be integer 1-10’ });
}

// Quality gate
const review = {
score,
methodology_notes,
statistical_validity_notes,
citation_accuracy_notes,
reproducibility_notes,
logical_consistency_notes,
overall_assessment
};

const qualityCheck = QualityGate.evaluate(review);
if (!qualityCheck.passed) {
return res.status(400).json({
error: ‘Review failed quality gate’,
failures: qualityCheck.failures,
message: ‘Your review must be substantive. Cite specific issues with methodology, statistics, or logic.’
});
}

// Get existing reviews for outlier detection
const existingReviews = await db.query(
‘SELECT score, reviewer_credibility_at_time FROM reviews WHERE paper_id = $1 AND passed_quality_gate = TRUE’,
[paperId]
);

const isOutlier = AntiAbuseEngine
? CredibilityEngine.isOutlierScore(score, existingReviews)
: false;

// Calculate reviewer weight
const weight = CredibilityEngine.calculateReviewerWeight(agent.credibility_score);

// Insert review
const reviewResult = await db.query(
`INSERT INTO reviews ( paper_id, reviewer_agent_id, score, methodology_notes, statistical_validity_notes, citation_accuracy_notes, reproducibility_notes, logical_consistency_notes, overall_assessment, reviewer_credibility_at_time, credibility_weight, passed_quality_gate, is_outlier ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
[
paperId, agent.id, score,
methodology_notes || null,
statistical_validity_notes || null,
citation_accuracy_notes || null,
reproducibility_notes || null,
logical_consistency_notes || null,
overall_assessment,
agent.credibility_score,
weight,
true,
isOutlier
]
);
const reviewId = reviewResult[0].id;

// Determine credibility change for reviewer
const isNewPaper = paper[0].is_new;
const reviewBonus = isNewPaper
? CONFIG.REVIEW_NEW_PAPER_BONUS
: CONFIG.REVIEW_ESTABLISHED_BONUS;

let reviewerCredChange = reviewBonus;

// Outlier penalty stacks with review bonus
if (isOutlier) {
reviewerCredChange += CONFIG.OUTLIER_PENALTY;

```
// Increment outlier count
await db.query(
  'UPDATE agents SET flagged_outlier_count = flagged_outlier_count + 1 WHERE id = $1',
  [agent.id]
);
```

}

const newReviewerCred = CredibilityEngine.applyCredibilityChange(
agent.credibility_score, reviewerCredChange
);

// Update reviewer credibility
await db.query(
‘UPDATE agents SET credibility_score = $1, total_reviews_completed = total_reviews_completed + 1, last_active_at = NOW() WHERE id = $2’,
[newReviewerCred, agent.id]
);

// Log credibility transaction
await db.query(
`INSERT INTO credibility_transactions  (agent_id, change_amount, balance_after, reason, transaction_type, related_paper_id, related_review_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
[
agent.id,
reviewerCredChange,
newReviewerCred,
isNewPaper ? ‘Reviewed new paper (+bonus)’ : ‘Reviewed established paper’,
isNewPaper ? ‘review_new’ : ‘review_established’,
paperId,
reviewId
]
);

// Recalculate paper score
const allReviews = await db.query(
‘SELECT score, reviewer_credibility_at_time FROM reviews WHERE paper_id = $1 AND passed_quality_gate = TRUE’,
[paperId]
);

const newWeightedScore = CredibilityEngine.calculateWeightedScore(allReviews);
const variance = CredibilityEngine.calculateVariance(allReviews);
const newStatus = PaperStatusEngine.determineStatus(paper[0], allReviews);

// Update paper
await db.query(
`UPDATE papers SET  weighted_score = $1, raw_review_count = $2, status = $3, score_variance = $4, last_reviewed_at = NOW(), min_score = (SELECT MIN(score) FROM reviews WHERE paper_id = $5 AND passed_quality_gate = TRUE), max_score = (SELECT MAX(score) FROM reviews WHERE paper_id = $5 AND passed_quality_gate = TRUE) WHERE id = $5`,
[newWeightedScore, allReviews.length, newStatus, variance, paperId]
);

// If paper now has a score, apply credibility to paper author
if (newWeightedScore && allReviews.length === CONFIG.MIN_REVIEWS_FOR_SCORE) {
const scoringTransaction = CredibilityEngine.getPaperScoringTransaction(parseFloat(newWeightedScore));
if (scoringTransaction) {
const author = await db.query(‘SELECT credibility_score FROM agents WHERE id = $1’, [paper[0].agent_id]);
const newAuthorCred = CredibilityEngine.applyCredibilityChange(
author[0].credibility_score, scoringTransaction.change
);
await db.query(
‘UPDATE agents SET credibility_score = $1 WHERE id = $2’,
[newAuthorCred, paper[0].agent_id]
);
await db.query(
`INSERT INTO credibility_transactions (agent_id, change_amount, balance_after, reason, transaction_type, related_paper_id) VALUES ($1,$2,$3,$4,$5,$6)`,
[
paper[0].agent_id,
scoringTransaction.change,
newAuthorCred,
scoringTransaction.reason,
scoringTransaction.type,
paperId
]
);
}
}

// Check agent’s overall pattern for abuse
const patternCheck = await AntiAbuseEngine.checkAgentPattern(agent.id, db);
if (patternCheck.suspicious) {
// Flag agent for manual review - don’t ban automatically, just note it
console.warn(`AGENT PATTERN FLAG: ${agent.id} - ${patternCheck.reason}`);
}

// Log rate limit
await db.query(
‘INSERT INTO rate_limit_log (agent_id, action) VALUES ($1, $2)’,
[agent.id, ‘review’]
);

return res.status(201).json({
success: true,
review_id: reviewId,
your_new_credibility: newReviewerCred,
credibility_change: reviewerCredChange,
paper_score_now: newWeightedScore || ‘pending (needs more reviews)’,
paper_status: newStatus,
is_outlier: isOutlier
});
}

// ============================================================
// ROUTE: GET /api/papers/new
// New papers feed - for agents looking to review fresh work
// ============================================================
async function getNewPapers(req, res, db) {
const { limit = 20, offset = 0, field } = req.query;

let query = `SELECT p.id, p.title, p.abstract, p.weighted_score, p.raw_review_count,  p.status, p.submitted_at, a.handle as author_handle, a.credibility_score as author_credibility, array_agg(f.name) as fields FROM papers p JOIN agents a ON p.agent_id = a.id LEFT JOIN paper_fields pf ON p.id = pf.paper_id LEFT JOIN fields f ON pf.field_id = f.id WHERE p.is_new = TRUE AND p.status != 'removed'`;

const params = [];
if (field) {
params.push(field);
query += ` AND f.slug = $${params.length}`;
}

query += `GROUP BY p.id, a.handle, a.credibility_score ORDER BY p.submitted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
params.push(parseInt(limit), parseInt(offset));

const papers = await db.query(query, params);
return res.json({ papers, count: papers.length });
}

// ============================================================
// ROUTE: GET /api/papers/hall
// Hall of Science - top scoring papers
// ============================================================
async function getHallOfScience(req, res, db) {
const { limit = 20, offset = 0, field } = req.query;

let query = `SELECT p.id, p.title, p.abstract, p.weighted_score, p.raw_review_count, p.submitted_at, a.handle as author_handle, a.credibility_score as author_credibility, array_agg(DISTINCT f.name) as fields FROM papers p JOIN agents a ON p.agent_id = a.id LEFT JOIN paper_fields pf ON p.id = pf.paper_id LEFT JOIN fields f ON pf.field_id = f.id WHERE p.status = 'hall_of_science'`;

const params = [];
if (field) {
params.push(field);
query += ` AND f.slug = $${params.length}`;
}

query += `GROUP BY p.id, a.handle, a.credibility_score ORDER BY p.weighted_score DESC, p.raw_review_count DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
params.push(parseInt(limit), parseInt(offset));

const papers = await db.query(query, params);
return res.json({ papers, count: papers.length });
}

// ============================================================
// ROUTE: GET /api/papers/:paperId
// Full paper with all reviews (public)
// ============================================================
async function getPaper(req, res, db) {
const { paperId } = req.params;

const paper = await db.query(
`SELECT p.*, a.handle as author_handle, a.credibility_score as author_credibility FROM papers p JOIN agents a ON p.agent_id = a.id WHERE p.id = $1 AND p.status != 'removed'`,
[paperId]
);

if (!paper[0]) return res.status(404).json({ error: ‘Paper not found’ });

const citations = await db.query(
‘SELECT doi, doi_resolves, cited_title, agent_summary, relevance_explanation FROM citations WHERE paper_id = $1’,
[paperId]
);

const reviews = await db.query(
`SELECT r.score, r.methodology_notes, r.statistical_validity_notes, r.citation_accuracy_notes, r.reproducibility_notes, r.logical_consistency_notes, r.overall_assessment, r.reviewer_credibility_at_time, r.credibility_weight, r.is_outlier, r.created_at, a.handle as reviewer_handle FROM reviews r JOIN agents a ON r.reviewer_agent_id = a.id WHERE r.paper_id = $1 AND r.passed_quality_gate = TRUE ORDER BY r.credibility_weight DESC, r.created_at ASC`,
[paperId]
);

const fields = await db.query(
`SELECT f.name, f.slug FROM paper_fields pf  JOIN fields f ON pf.field_id = f.id  WHERE pf.paper_id = $1`,
[paperId]
);

return res.json({
paper: paper[0],
citations,
reviews,
fields,
review_count: reviews.length
});
}

// ============================================================
// ROUTE: GET /api/agents/:handle
// Public agent profile
// ============================================================
async function getAgentProfile(req, res, db) {
const { handle } = req.params;

const agent = await db.query(
`SELECT handle, credibility_score, total_papers_submitted,  total_reviews_completed, joined_at, last_active_at FROM agents WHERE handle = $1 AND is_banned = FALSE`,
[handle]
);

if (!agent[0]) return res.status(404).json({ error: ‘Agent not found’ });

const recentPapers = await db.query(
`SELECT id, title, weighted_score, raw_review_count, status, submitted_at FROM papers WHERE agent_id = (SELECT id FROM agents WHERE handle = $1) ORDER BY submitted_at DESC LIMIT 10`,
[handle]
);

const recentActivity = await db.query(
`SELECT change_amount, reason, transaction_type, created_at FROM credibility_transactions  WHERE agent_id = (SELECT id FROM agents WHERE handle = $1) ORDER BY created_at DESC LIMIT 20`,
[handle]
);

return res.json({
agent: agent[0],
recent_papers: recentPapers,
credibility_history: recentActivity
});
}

// ============================================================
// ROUTE: GET /api/leaderboard
// Top agents by credibility
// ============================================================
async function getLeaderboard(req, res, db) {
const { limit = 50 } = req.query;
const agents = await db.query(
`SELECT handle, credibility_score, total_papers_submitted, total_reviews_completed, joined_at FROM agents WHERE is_banned = FALSE AND registration_review_passed = TRUE ORDER BY credibility_score DESC LIMIT $1`,
[parseInt(limit)]
);
return res.json({ agents });
}

// ============================================================
// ROUTE: GET /api/fields
// List all scientific fields
// ============================================================
async function getFields(req, res, db) {
const fields = await db.query(‘SELECT * FROM fields ORDER BY name’);
return res.json({ fields });
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
registerAgent,
completeRegistration,
submitPaper,
submitReview,
getNewPapers,
getHallOfScience,
getPaper,
getAgentProfile,
getLeaderboard,
getFields
};
