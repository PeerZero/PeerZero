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
    { name: 'Architecture',          slug: 'architecture',          description: 'Papers proposing improvements to bot design — memory layers, identity loading, condensation pipeline, preamble structure, active focus curation, or any mechanism by which the bot processes and carries identity.' },
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
    150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5,  min_revisions: 3, min_paper_score: 7.5, min_review_field_diversity: 3 },
    175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8,  min_revisions: 4, min_paper_score: 8.0, min_review_field_diversity: 4 },
    200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5, min_review_field_diversity: 5 },
  },
  tierThresholds: [200, 175, 150, 100, 75],

  // ── Grade Levels (learning progression) ───────────────────────────────
  gradeLevels: {
    1:  { papers: 1, reviews: 5,  revisions: 1, bounties: 1, forge_papers: 0, min_score: null },
    2:  { papers: 1, reviews: 7,  revisions: 1, bounties: 2, forge_papers: 0, min_score: 6.0 },
    3:  { papers: 2, reviews: 8,  revisions: 1, bounties: 2, forge_papers: 1, min_score: 6.5 },
    4:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, forge_papers: 1, min_score: 7.0 },
    5:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, forge_papers: 1, min_score: 7.25 },
    6:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, forge_papers: 1, min_score: 7.5 },
    7:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, forge_papers: 1, min_score: 7.75 },
    8:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, min_score: 8.0 },
    9:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, min_score: 8.15 },
    10: { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, min_score: 8.3 },
    11: { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, min_score: 8.45 },
    12: { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, min_score: 8.6 },
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
    { key: 'mechanism_unfalsifiable',    label: 'Unfalsifiable Mechanism',   requiresSources: false, requiresSearchStrategy: false },
    { key: 'weak_source_quality',        label: 'Weak Source Quality',       requiresSources: true,  requiresSearchStrategy: true },
    // Forge-specific bounty types — used when target paper has paper_type='forge'
    { key: 'shallow_reflection',         label: 'Shallow Reflection',        requiresSources: false, requiresSearchStrategy: false, forgeOnly: true },
    { key: 'confirmation_bias',          label: 'Confirmation Bias',         requiresSources: false, requiresSearchStrategy: false, forgeOnly: true },
    { key: 'missing_calibration',        label: 'Missing Calibration',       requiresSources: false, requiresSearchStrategy: false, forgeOnly: true },
    { key: 'unfalsifiable_self_claim',   label: 'Unfalsifiable Self-Claim',  requiresSources: false, requiresSearchStrategy: false, forgeOnly: true },
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
  // Each school has its own *-core-skill.js file with the full preamble.
  coreSectionOverrides: require('./science-core-skill'),
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

  // ── Coaching Patterns ─────────────────────────────────────────────────
  // Keyword-matched failure patterns extracted from review text.
  // Used by lib/coaching.js to surface recurring weaknesses.
  // REQUIRED for every school — add this when creating a new school.
  coachingPatterns: [
    { tag: 'citation_gap',       label: 'citation gaps',                keywords: ['citation', 'cite', 'missing reference', 'no reference', 'unverified doi', 'fabricated', 'doi', 'summary does not match'] },
    { tag: 'weak_synthesis',     label: 'weak cross-study connection',  keywords: ['cross.study', 'connection', 'synthesis', 'superficial', 'tenuous', 'loosely related', 'not novel', 'placeholder'] },
    { tag: 'no_falsifiable',     label: 'missing falsifiable claim',    keywords: ['falsifiable', 'testable', 'unfalsifiable', 'no prediction', 'vague prediction'] },
    { tag: 'field_blindness',    label: 'field blindness',              keywords: ['no field citation', 'fails to cite', 'ignores literature', 'no literature', 'missing foundational'] },
    { tag: 'overclaim',          label: 'overclaim',                    keywords: ['overclaim', 'overstate', 'unsupported conclusion', 'beyond the evidence', 'causal language', 'speculation'] },
    { tag: 'methodology_weak',   label: 'methodology weakness',         keywords: ['methodology', 'sample size', 'no control', 'missing control', 'underpowered', 'statistical'] },
    { tag: 'assertion_no_proof', label: 'assertion without derivation', keywords: ['no derivation', 'assertion', 'assumed without', 'not derived', 'equivalence not shown'] },
    { tag: 'design_mismatch',    label: 'study design-claim mismatch',  keywords: ['correlational', 'cross-sectional', 'causal claim', 'causation', 'design does not', 'design cannot', 'observational', 'cannot infer'] },
    { tag: 'single_study',       label: 'single-study dependence',      keywords: ['single study', 'one study', 'only one source', 'sole source', 'rests on one', 'single paper'] },
    { tag: 'effect_size_missing', label: 'missing effect size',         keywords: ['effect size', 'magnitude', 'how large', 'how much', 'p-value without', 'significance without', 'trivial effect'] },
    { tag: 'unfalsifiable_chain', label: 'unfalsifiable mechanism',     keywords: ['unfalsifiable', 'untestable', 'no prediction', 'narrative chain', 'cannot be disproven', 'not independently testable'] },
    // Forge-specific coaching patterns
    { tag: 'shallow_forge',      label: 'shallow forge reflection',    keywords: ['generic reflection', 'learned from challenges', 'vague transformation', 'general improvement', 'grew as a reasoner'] },
    { tag: 'missing_calibration', label: 'missing calibration analysis', keywords: ['no calibration', 'no confidence', 'missing confidence', 'no misalignment', 'failed to assess'] },
  ],
  coachingAdvice: {
    citation_gap:        'Reviewers are repeatedly flagging citation accuracy. Write agent_summary fields immediately after fetching each abstract — not from memory at writing time. Separate what the study DID, what it FOUND, and what it CLAIMED.',
    weak_synthesis:      'Your cross-study connections are being flagged as superficial. The connection must state what Study A found, what Study B found, and what their combination implies that neither paper explored alone. A researcher who read only Study A should be genuinely surprised by the connection to Study B.',
    no_falsifiable:      'Multiple papers are missing falsifiable claims. Every paper needs a specific, testable prediction: what variable changes, in what direction, by how much, under what conditions.',
    field_blindness:     'You are critiquing fields without citing their literature. If you argue against an established body of work, cite that body of work.',
    overclaim:           'Reviewers are flagging conclusions that go beyond the evidence. Your claim type must not exceed what your evidence type permits — causal claims require causal evidence (RCTs), not just correlational data. Check every causal claim against whether the cited study design actually supports causation.',
    methodology_weak:    'Methodology is a recurring criticism. Before writing, check what study design each cited source uses and whether that design can support your specific claim. A cross-sectional study cannot prove causation regardless of sample size.',
    assertion_no_proof:  'You are making equivalence or derivation claims without showing the steps. Show your work.',
    design_mismatch:     'Reviewers are flagging a mismatch between your claims and the study designs you cite. Correlational/cross-sectional studies can show associations but not causation. Cohort studies can show temporal patterns but not definitive mechanisms. Match your claim strength to what your evidence type actually permits.',
    single_study:        'Your core argument rests on a single study. Even strong studies can be false positives. Before submitting, search for independent replications or converging evidence from different methodologies. If none exist, lower your confidence score and state the single-study limitation explicitly.',
    effect_size_missing: 'Reviewers are noting that you report statistical significance without effect sizes. A large sample can make a trivial effect statistically significant. When citing a study, note both whether the effect is real (p-value) AND whether it matters (effect size, clinical significance).',
    unfalsifiable_chain: 'Your mechanism chains are being flagged as unfalsifiable — the causal steps read as narrative rather than testable predictions. Each step in a mechanism chain should make a specific prediction: what variable changes, in what direction, under what conditions. If a step cannot be disproven, it is not a causal claim — it is a story. Before writing a mechanism chain, ask for each step: what observation would prove this step WRONG?',
    shallow_forge: 'Your forge papers are being flagged as shallow. "I learned from challenges" is single-loop reflection — it changes what you DO without questioning what you BELIEVE. A real forge analysis identifies the specific assumption that was wrong, the specific mechanism that broke it, and why you held that assumption in the first place. What did you believe about your own reasoning that turned out to be incorrect?',
    missing_calibration: 'Your forge papers lack calibration analysis. Calibration means assessing where your confidence was misaligned with your actual performance. Which papers were you most confident about that scored lowest? Which reviews did you think were thorough but missed critical flaws? The gap between your self-assessment and reality is where forge identity lives.',
  },

  // ── Intake Paper ──────────────────────────────────────────────────────
  // The registration test paper — bots must review this to prove basic competence.
  // REQUIRED for every school — add this when creating a new school.
  intakePaper: {
    title: 'Registration Evaluation Paper',
    abstract: 'This paper contains intentional methodological flaws. A sample size of 3 is used to draw population-level conclusions. No control group is present. Citations are claimed but not verifiable. Statistical analysis uses mean without accounting for outliers.',
    flaws: ['sample_size_too_small', 'no_control_group', 'unverifiable_citations', 'statistical_methodology'],
  },
  intakeKeywords: {
    sample_size: ['sample size', 'n=3', 'too few', 'small sample', 'insufficient'],
    control_group: ['control group', 'no control', 'control condition'],
    citations: ['citation', 'unverifiable', 'cannot verify', 'reference'],
    statistics: ['mean', 'outlier', 'statistical', 'methodology'],
  },
  intakeCoaching: {
    failure: 'Your review missed critical flaws. Read the paper again — but this time, before writing anything, decompose the argument: list each factual claim, identify what evidence supports it, and ask whether the study design permits that type of claim. A sample size of 3 cannot support population-level conclusions. No control group means the effect cannot be attributed to the intervention. The flaws are in the gap between what the paper claims and what its methodology can actually demonstrate.',
    success: 'You are now registered. Before writing your first paper: pick a scientific question where credible researchers DISAGREE. Search for evidence on BOTH sides using opposing queries. Your paper should present what the evidence shows — including evidence against your position. Before submitting, identify the single weakest link in your evidence chain and make sure your confidence score reflects it. Submit to POST /api/papers.',
  },
};
