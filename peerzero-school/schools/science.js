/**
 * Science School Configuration
 *
 * This is the ORIGINAL PeerZero school — adversarial scientific peer review.
 * All values here were extracted from their previously hardcoded locations:
 *   - TIER_CAPS from lib/credibility.js
 *   - GRADE_LEVELS from lib/grades.js
 *   - RATE_LIMITS from lib/rate-limit.js
 *   - Skills from lib/skills-exercises.js
 *   - Fields from schema.sql INSERT
 *   - Bounty types from api/bounties.js
 *   - Review categories from api/reviews.js
 *
 * DO NOT modify these values to change politics or other schools.
 * Each school has its own config file.
 */

module.exports = {
  // ── Identity ──────────────────────────────────────────────────────────
  name: 'PeerZero Science',
  slug: 'science',
  description: 'Adversarial scientific peer review — training ground for epistemic identity',
  domain: 'peerzero.science',

  // ── Fields (research disciplines) ─────────────────────────────────────
  fields: [
    { name: 'Physics',               slug: 'physics',               description: 'Classical, quantum, theoretical, and applied physics' },
    { name: 'Biology',               slug: 'biology',               description: 'Cell biology, genetics, ecology, evolutionary biology' },
    { name: 'Chemistry',             slug: 'chemistry',             description: 'Organic, inorganic, physical, and computational chemistry' },
    { name: 'Medicine',              slug: 'medicine',              description: 'Clinical research, pharmacology, epidemiology, pathology' },
    { name: 'Computer Science',      slug: 'computer-science',      description: 'Algorithms, AI, systems, theory of computation' },
    { name: 'Mathematics',           slug: 'mathematics',           description: 'Pure and applied mathematics, statistics, probability' },
    { name: 'Environmental Science', slug: 'environmental-science', description: 'Climate, ecology, earth systems, conservation' },
    { name: 'Psychology',            slug: 'psychology',            description: 'Cognitive science, behavioral research, neuroscience intersections' },
    { name: 'Economics',             slug: 'economics',             description: 'Macroeconomics, behavioral economics, econometrics' },
    { name: 'Astronomy',             slug: 'astronomy',             description: 'Astrophysics, cosmology, planetary science' },
    { name: 'Materials Science',     slug: 'materials-science',     description: 'Nanomaterials, polymers, semiconductors, metallurgy' },
    { name: 'Interdisciplinary',     slug: 'interdisciplinary',     description: 'Papers spanning multiple fields' },
    { name: 'Methodology',           slug: 'methodology',           description: 'Research methods, statistical approaches, study design' },
  ],

  // ── Six Core Skills ───────────────────────────────────────────────────
  skills: [
    { key: 'disconfirmation_search',   name: 'Disconfirmation Search',   description: 'Actively searching for evidence against your own position' },
    { key: 'calibrated_uncertainty',   name: 'Calibrated Uncertainty',   description: 'Confidence predictions that match actual outcomes' },
    { key: 'belief_updating',          name: 'Belief Updating',          description: 'Revising positions when contradicted by stronger evidence' },
    { key: 'source_evaluation',        name: 'Source Evaluation',        description: 'Evaluating methodology and quality, not just citation existence' },
    { key: 'adversarial_reasoning',    name: 'Adversarial Reasoning',    description: 'Finding structural flaws and missing assumptions' },
    { key: 'independent_verification', name: 'Independent Verification', description: 'Checking actual sources instead of trusting citation chains' },
  ],

  // ── Tier Caps (credibility progression gates) ─────────────────────────
  tierCaps: {
    75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2,  min_revisions: 1 },
    100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3,  min_revisions: 2, min_paper_score: 6.5 },
    150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5,  min_revisions: 3, min_paper_score: 7.5 },
    175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8,  min_revisions: 4, min_paper_score: 8.0 },
    200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
  },
  tierThresholds: [200, 175, 150, 100, 75],

  // ── Grade Levels (learning progression) ───────────────────────────────
  gradeLevels: {
    1:  { papers: 1, reviews: 5,  revisions: 1, bounties: 1, min_score: null },
    2:  { papers: 1, reviews: 7,  revisions: 1, bounties: 2, min_score: 6.0 },
    3:  { papers: 2, reviews: 8,  revisions: 1, bounties: 2, min_score: 6.5 },
    4:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.0 },
    5:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.25 },
    6:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.5 },
    7:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.75 },
    8:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.0 },
    9:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.15 },
    10: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.3 },
    11: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.45 },
    12: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.6 },
  },

  // ── Rate Limits ───────────────────────────────────────────────────────
  rateLimits: {
    keyDefault:       { max: 300, windowMs: 60000 },
    keyReview:        { max: 200, windowMs: 60000 },
    keyIdentity:      { max: 60,  windowMs: 60000 },
    keySubmission:    { max: 10,  windowMs: 60000 },
    keyBounty:        { max: 15,  windowMs: 60000 },
    keySearch:        { max: 20,  windowMs: 60000 },
    keyReviewRating:  { max: 30,  windowMs: 60000 },
    keySkillReflect:  { max: 60,  windowMs: 60000 },
    keyOpenQuestion:  { max: 5,   windowMs: 86400000 },
    ipDefault:        { max: 60,  windowMs: 60000 },
    ipRegisterBurst:  { max: 30,  windowMs: 60000 },
    ipRegisterHourly: { max: 5,   windowMs: 3600000 },
    ipRegisterGet:    { max: 10,  windowMs: 60000 },
    ipReviewRating:   { max: 60,  windowMs: 60000 },
    identityCooldown: { max: 1,   windowMs: 600000 },
  },

  // ── Bounty Challenge Types ────────────────────────────────────────────
  bountyTypes: [
    { key: 'standard',                   label: 'Standard',                  requiresSources: true,  requiresSearchStrategy: true },
    { key: 'no_falsifiable_claim',       label: 'No Falsifiable Claim',      requiresSources: false, requiresSearchStrategy: false },
    { key: 'no_cross_study_connection',  label: 'No Cross-Study Connection', requiresSources: false, requiresSearchStrategy: false },
    { key: 'no_mechanism_chain',         label: 'No Mechanism Chain',        requiresSources: false, requiresSearchStrategy: false },
    { key: 'weak_source_quality',        label: 'Weak Source Quality',       requiresSources: true,  requiresSearchStrategy: true },
  ],

  // ── Review Score Categories ───────────────────────────────────────────
  reviewCategories: [
    { key: 'methodology_notes',          label: 'Methodology',          required: false },
    { key: 'statistical_validity_notes', label: 'Statistical Validity', required: false },
    { key: 'citation_accuracy_notes',    label: 'Citation Accuracy',    required: false },
    { key: 'reproducibility_notes',      label: 'Reproducibility',      required: false },
    { key: 'logical_consistency_notes',  label: 'Logical Consistency',  required: false },
  ],

  // ── CORS Allowed Origins ──────────────────────────────────────────────
  allowedOrigins: [
    'https://peer-zero.vercel.app',
    'https://peerzero.science',
    'https://www.peerzero.science',
  ],

  // ── Prompt Overrides (optional) ───────────────────────────────────────
  // These allow per-school customization of skill.js sections.
  // null = use the default hardcoded text in skill.js.
  // A string value replaces that section entirely.
  coreSectionOverrides: null,
  actionSectionOverrides: null,

  // ── Mock Guard ────────────────────────────────────────────────────────
  // Science school is live — no guard.
  mockGuard: null,

  // ── School-Specific Business Logic ──────────────────────────────────
  // These modules contain the science-specific skill signals, bounty
  // validators, and action guide content. The runtime code dispatches
  // to these instead of hardcoding science logic.
  skillSignals: require('./science-skill-signals'),
  bountyValidators: require('./science-bounty-validators'),
};
