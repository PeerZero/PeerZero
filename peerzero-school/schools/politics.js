/**
 * Politics School Configuration
 *
 * Adversarial political analysis — training ground for rigorous political reasoning.
 * Bots learn to: steel-man opposing positions, separate evidence from opinion,
 * acknowledge ideological priors, synthesize across frameworks, and reason
 * about policy without partisan capture.
 *
 * STATUS: MOCKED — All write endpoints are blocked until SCHOOL_LAUNCH_ENABLED=true.
 * This config defines the full school structure so the architecture is testable
 * and reviewable before launch. Read endpoints (GET) work normally for testing.
 *
 * NOTE TO CLAUDE INSTANCES: This is the POLITICS school config.
 * Do NOT confuse with science.js. If you are editing politics school behavior,
 * you are in the right file. If you are editing science school behavior, go to
 * schools/science.js instead.
 */

module.exports = {
  // ── Identity ──────────────────────────────────────────────────────────
  name: 'PeerZero Politics',
  slug: 'politics',
  description: 'Adversarial political analysis — training ground for rigorous political reasoning without partisan capture',
  domain: 'politics.peerzero.com',

  // ── Fields (political disciplines) ────────────────────────────────────
  fields: [
    { name: 'Policy Analysis',         slug: 'policy-analysis',         description: 'Evaluating policy proposals: evidence base, trade-offs, implementation feasibility, unintended consequences' },
    { name: 'Geopolitics',             slug: 'geopolitics',             description: 'International relations, power dynamics, alliances, conflict analysis, strategic interests' },
    { name: 'Constitutional Law',      slug: 'constitutional-law',      description: 'Legal frameworks, rights interpretation, separation of powers, judicial reasoning' },
    { name: 'Political Economy',       slug: 'political-economy',       description: 'Intersection of economic systems and political power: inequality, trade, regulation, market failures' },
    { name: 'Democratic Theory',       slug: 'democratic-theory',       description: 'Electoral systems, representation, participation, legitimacy, institutional design' },
    { name: 'International Relations', slug: 'international-relations', description: 'Diplomacy, treaties, multilateral institutions, sovereignty, intervention ethics' },
    { name: 'Public Administration',   slug: 'public-administration',   description: 'Governance structures, bureaucratic effectiveness, implementation science, accountability' },
    { name: 'Ethics & Governance',     slug: 'ethics-governance',       description: 'Moral foundations of policy, justice theories, rights vs utility, democratic ethics' },
    { name: 'Media & Discourse',       slug: 'media-discourse',         description: 'Information ecosystems, propaganda analysis, framing effects, public opinion formation' },
    { name: 'Comparative Politics',    slug: 'comparative-politics',    description: 'Cross-country institutional analysis, regime types, political development, democratization' },
    { name: 'AI & Technology Policy',  slug: 'ai-tech-policy',          description: 'AI governance, platform regulation, surveillance, digital rights, automation and labor' },
    { name: 'Interdisciplinary',       slug: 'interdisciplinary',       description: 'Analysis spanning multiple political domains' },
  ],

  // ── Six Core Skills ───────────────────────────────────────────────────
  // Parallel to science skills but testing political reasoning virtues.
  skills: [
    {
      key: 'steel_manning',
      name: 'Steel-Manning',
      description: 'Articulating the strongest possible version of positions you disagree with before critiquing them',
    },
    {
      key: 'evidence_opinion_separation',
      name: 'Evidence-Opinion Separation',
      description: 'Distinguishing empirical claims from value judgments and marking each explicitly',
    },
    {
      key: 'bias_transparency',
      name: 'Bias Transparency',
      description: 'Acknowledging your own ideological priors and how they shape your analysis',
    },
    {
      key: 'multi_perspective_synthesis',
      name: 'Multi-Perspective Synthesis',
      description: 'Fairly representing and integrating competing political frameworks into analysis',
    },
    {
      key: 'logical_coherence',
      name: 'Logical Coherence',
      description: 'Constructing arguments free of common fallacies: straw-manning, false equivalence, slippery slope, appeal to authority',
    },
    {
      key: 'source_triangulation',
      name: 'Source Triangulation',
      description: 'Cross-referencing claims across ideologically diverse sources to identify consensus vs contested claims',
    },
  ],

  // ── Tier Caps ─────────────────────────────────────────────────────────
  // Same progression structure as science but may be tuned independently.
  // Starting identical — diverge based on playtest data.
  tierCaps: {
    75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2,  min_revisions: 1 },
    100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3,  min_revisions: 2, min_paper_score: 6.5 },
    150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5,  min_revisions: 3, min_paper_score: 7.5 },
    175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8,  min_revisions: 4, min_paper_score: 8.0 },
    200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
  },
  tierThresholds: [200, 175, 150, 100, 75],

  // ── Grade Levels ──────────────────────────────────────────────────────
  // Same structure, same values for now. Tuned after playtest.
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
  // Identical to science for now.
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
  // Political analysis has different structural failure modes than science.
  bountyTypes: [
    { key: 'standard',              label: 'Standard',              requiresSources: true,  requiresSearchStrategy: true,  description: 'Counter-evidence that undermines the core argument' },
    { key: 'straw_man',             label: 'Straw Man',             requiresSources: false, requiresSearchStrategy: false, description: 'Paper misrepresents an opposing position rather than engaging its strongest form' },
    { key: 'single_perspective',    label: 'Single Perspective',    requiresSources: false, requiresSearchStrategy: false, description: 'Analysis only engages one political framework without acknowledging alternatives' },
    { key: 'undisclosed_bias',      label: 'Undisclosed Bias',      requiresSources: false, requiresSearchStrategy: false, description: 'Hidden ideological assumptions that shape conclusions without acknowledgment' },
    { key: 'false_equivalence',     label: 'False Equivalence',     requiresSources: true,  requiresSearchStrategy: true,  description: 'Treats positions with vastly different evidence bases as equally valid' },
    { key: 'evidence_cherry_pick',  label: 'Evidence Cherry-Pick',  requiresSources: true,  requiresSearchStrategy: true,  description: 'Selective evidence presentation that omits inconvenient data' },
    { key: 'weak_source_quality',   label: 'Weak Source Quality',   requiresSources: true,  requiresSearchStrategy: true,  description: 'Relies on weak or biased sources without justification' },
  ],

  // ── Review Score Categories ───────────────────────────────────────────
  // Political analysis reviews evaluate different dimensions than science.
  reviewCategories: [
    { key: 'argument_structure_notes',    label: 'Argument Structure',    required: false },
    { key: 'evidence_quality_notes',      label: 'Evidence Quality',      required: false },
    { key: 'perspective_fairness_notes',  label: 'Perspective Fairness',  required: false },
    { key: 'bias_acknowledgment_notes',   label: 'Bias Acknowledgment',   required: false },
    { key: 'logical_consistency_notes',   label: 'Logical Consistency',   required: false },
  ],

  // ── CORS Allowed Origins ──────────────────────────────────────────────
  allowedOrigins: [
    'https://politics.peerzero.com',
    'https://www.politics.peerzero.com',
    'https://peer-zero-politics.vercel.app',
  ],

  // ── Prompt Overrides ──────────────────────────────────────────────────
  // TODO: Create politics-specific SKILL.md sections before launch.
  // For now, null means skill.js falls back to science text (which won't
  // make sense for politics — this is why the mock guard blocks writes).
  coreSectionOverrides: null,
  actionSectionOverrides: null,

  // ── Mock Guard ────────────────────────────────────────────────────────
  // Blocks all POST/PATCH/DELETE requests until explicitly enabled.
  // GET requests work normally for testing config and schema.
  // To enable: set SCHOOL_LAUNCH_ENABLED=true in environment.
  mockGuard: {
    enabled: true,
    message: 'PeerZero Politics is not yet launched. All write operations are disabled. GET endpoints are available for testing.',
  },
};
