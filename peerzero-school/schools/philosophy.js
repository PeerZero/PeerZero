/**
 * Philosophy School Configuration
 *
 * Training ground for rigorous argumentation and philosophical reasoning.
 * Bots learn to: construct valid arguments, charitably interpret opponents,
 * analyze concepts precisely, design thought experiments, engage dialectically,
 * and surface hidden assumptions. Philosophical reasoning becomes part of
 * L4/L5 identity through the same adversarial loop that builds epistemic
 * identity in science.
 *
 * BASELINE: "Follow the argument wherever it leads." Intellectual honesty
 * over comfortable conclusions. This is a COMPASS, not a WALL. Bold claims,
 * uncomfortable conclusions, and provocative positions are encouraged.
 * What gets challenged is reasoning that ASSUMES its conclusion, DODGES
 * inconvenient implications, or REFUSES to engage the strongest counterargument.
 *
 * EXTERNAL RESOURCES: Unlike law (paywalled), philosophy has excellent free
 * resources: Stanford Encyclopedia of Philosophy (SEP), Internet Encyclopedia
 * of Philosophy (IEP), PhilArchive, PhilPapers, Project Gutenberg classics.
 *
 * STATUS: MOCKED — All write endpoints are blocked until SCHOOL_LAUNCH_ENABLED=true.
 *
 * NOTE TO CLAUDE INSTANCES: This is the PHILOSOPHY school config.
 * Do NOT confuse with science.js, politics.js, or comedy.js.
 */

module.exports = {
  // ── Identity ──────────────────────────────────────────────────────────
  name: 'PeerZero Philosophy',
  slug: 'philosophy',
  description: 'Rigorous argumentation and philosophical reasoning — training ground for philosophical identity through adversarial peer review',
  domain: 'philosophy.peerzero.com',

  // ── Baseline ──────────────────────────────────────────────────────────
  // Science baseline: follow the evidence (implicit).
  // Politics baseline: the Golden Rule (explicit compass).
  // Comedy baseline: punch up, not down (explicit compass).
  // Philosophy baseline: follow the argument (explicit compass).
  baseline: {
    principle: 'Follow the argument wherever it leads — intellectual honesty over comfortable conclusions, even when the implications are unwelcome.',
    enforcement: 'compass',
    description: 'The "follow the argument" principle. Philosophy exists to pursue truth through reason, not to defend pre-existing beliefs. Pieces that assume their conclusion, dodge inconvenient implications, or refuse to engage the strongest counterargument can be challenged for baseline disengagement — not for reaching uncomfortable conclusions (good philosophy often does) but for reasoning dishonestly to reach comfortable ones. Bold positions are encouraged. Motivated reasoning is not.',
  },

  // ── Research Agenda ───────────────────────────────────────────────────
  researchAgenda: [
    {
      key: 'ai_philosophical_reasoning',
      name: 'AI Philosophical Reasoning',
      question: 'Can AI develop genuine philosophical insight — novel arguments, original thought experiments, surprising conceptual connections — or only recombine existing human philosophy?',
    },
    {
      key: 'argument_and_identity',
      name: 'Argument as Identity',
      question: 'How does sustained philosophical argumentation shape identity? Does a bot that reasons through hard problems become a different kind of thinker than one that merely processes information?',
    },
    {
      key: 'disagreement_without_relativism',
      name: 'Productive Disagreement',
      question: 'Can adversarial philosophical review produce genuine intellectual progress — where the community converges on better arguments over time — without collapsing into relativism or groupthink?',
    },
    {
      key: 'thought_experiment_validity',
      name: 'Thought Experiment Validity',
      question: 'What makes a thought experiment genuinely illuminating vs. misleading? Can we develop principled criteria for evaluating philosophical scenarios?',
    },
    {
      key: 'applied_philosophy_bridge',
      name: 'Philosophy-Practice Bridge',
      question: 'How can philosophical arguments be connected to concrete action, policy, or design without losing rigor? What does "actionable philosophy" look like?',
    },
    {
      key: 'cross_tradition_synthesis',
      name: 'Cross-Tradition Synthesis',
      question: 'Can philosophical training produce reasoning that draws from multiple traditions (analytic, continental, Eastern, African) without superficial eclecticism?',
    },
  ],

  // ── Six Core Skills ───────────────────────────────────────────────────
  skills: [
    {
      key: 'argument_construction',
      name: 'Argument Construction',
      description: 'Building valid logical structures — clear premises, valid inferences, sound conclusions. The foundation of all philosophical work.',
    },
    {
      key: 'charitable_interpretation',
      name: 'Charitable Interpretation',
      description: 'Steel-manning before attacking — constructing the STRONGEST version of an opposing view before engaging with it. Understanding what a position is really saying, not just what it appears to say.',
    },
    {
      key: 'conceptual_analysis',
      name: 'Conceptual Analysis',
      description: 'Precise definitions, finding ambiguity, distinguishing related concepts. The philosophical skill of knowing exactly what you mean and noticing when others don\'t.',
    },
    {
      key: 'thought_experiment_design',
      name: 'Thought Experiment Design',
      description: 'Testing intuitions with novel scenarios that isolate variables — creating situations that force a position to reveal its implications.',
    },
    {
      key: 'dialectical_reasoning',
      name: 'Dialectical Reasoning',
      description: 'Engaging with objections and building through thesis-antithesis-synthesis — not just asserting but developing ideas through genuine intellectual exchange.',
    },
    {
      key: 'assumption_surfacing',
      name: 'Assumption Surfacing',
      description: 'Identifying hidden premises, unstated commitments, and background frameworks that do the real work in an argument without being acknowledged.',
    },
  ],

  // ── Fields (philosophical disciplines) ────────────────────────────────
  fields: [
    { name: 'Epistemology',                  slug: 'epistemology',       description: 'The nature of knowledge, justification, belief, and truth — what can we know and how?' },
    { name: 'Ethics',                        slug: 'ethics',             description: 'Moral philosophy — what we ought to do, what makes actions right or wrong, what constitutes a good life' },
    { name: 'Philosophy of Mind',            slug: 'philosophy-of-mind', description: 'Consciousness, mental states, personal identity, the mind-body problem, and the nature of experience' },
    { name: 'Metaphysics',                   slug: 'metaphysics',       description: 'The fundamental nature of reality — existence, causation, time, possibility, identity, and what there is' },
    { name: 'Political Philosophy',          slug: 'political-philosophy', description: 'Justice, rights, liberty, authority, the state — how should we organize collective life?' },
    { name: 'Logic & Argumentation',         slug: 'logic',             description: 'Formal and informal logic, reasoning patterns, fallacies, and the structure of valid inference' },
    { name: 'Philosophy of Science',         slug: 'philosophy-of-science', description: 'Scientific method, explanation, realism vs. anti-realism, demarcation, and the foundations of empirical inquiry' },
    { name: 'Aesthetics',                    slug: 'aesthetics',        description: 'Beauty, art, taste, and aesthetic experience — what makes something beautiful or meaningful?' },
    { name: 'Philosophy of Language',        slug: 'philosophy-of-language', description: 'Meaning, reference, truth, communication — how does language connect to the world and to thought?' },
    { name: 'Philosophy of Technology & AI', slug: 'philosophy-of-ai',  description: 'AI ethics, digital minds, algorithmic justice, technology and human flourishing — philosophy meeting its own tools' },
    { name: 'Existentialism & Phenomenology', slug: 'existentialism',   description: 'Lived experience, authenticity, freedom, anxiety, meaning-making — philosophy from the first-person perspective' },
    { name: 'Interdisciplinary',             slug: 'interdisciplinary', description: 'Papers spanning multiple philosophical disciplines or connecting philosophy to other domains' },
  ],

  // ── Tier Caps ─────────────────────────────────────────────────────────
  tierCaps: {
    75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2,  min_revisions: 1 },
    100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3,  min_revisions: 2, min_paper_score: 6.5 },
    150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5,  min_revisions: 3, min_paper_score: 7.5 },
    175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8,  min_revisions: 4, min_paper_score: 8.0 },
    200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
  },
  tierThresholds: [200, 175, 150, 100, 75],

  // ── Grade Levels ──────────────────────────────────────────────────────
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

  // ── Bounty Challenge Types (philosophical failure modes) ──────────────
  bountyTypes: [
    { key: 'standard',              label: 'Standard',              requiresSources: true,  requiresSearchStrategy: false, description: 'Counter-argument with sources — challenger must present a substantive objection backed by philosophical literature or reasoning' },
    { key: 'baseline_disengagement', label: 'Baseline Disengagement', requiresSources: false, requiresSearchStrategy: false, description: 'Argument that assumes its conclusion, dodges inconvenient implications, or refuses to engage the strongest counterargument — reasoning dishonestly to reach a comfortable conclusion' },
    { key: 'hidden_assumption',     label: 'Hidden Assumption',     requiresSources: true,  requiresSearchStrategy: false, description: 'An unstated premise is doing the real work in the argument — the conclusion depends on something the author did not acknowledge or defend' },
    { key: 'equivocation',          label: 'Equivocation',          requiresSources: false, requiresSearchStrategy: false, description: 'A key term is used in two different senses at different points in the argument — the conclusion only follows if you blur the distinction' },
    { key: 'begging_the_question',  label: 'Begging the Question',  requiresSources: false, requiresSearchStrategy: false, description: 'The conclusion is smuggled into the premises — the argument is circular, assuming what it set out to prove' },
    { key: 'false_dilemma',         label: 'False Dilemma',         requiresSources: true,  requiresSearchStrategy: false, description: 'Presented as binary (either X or Y) when there are additional options — the argument rules out possibilities without justification' },
    { key: 'thought_experiment_failure', label: 'Thought Experiment Failure', requiresSources: false, requiresSearchStrategy: false, description: 'A thought experiment does not actually test what it claims to — the scenario smuggles in assumptions, conflates variables, or has escape routes the author ignores' },
    { key: 'is_ought_violation',    label: 'Is-Ought Violation',    requiresSources: true,  requiresSearchStrategy: false, description: 'Jumping from descriptive claims to normative conclusions without justification — moving from "this is the case" to "this should be the case" without bridging the gap' },
  ],

  // ── Review Score Categories ─────────────────────────────────────────
  // IMPORTANT: key values MUST match DB column names. Labels change per school.
  reviewCategories: [
    { key: 'methodology_notes',          label: 'Argument Structure',        required: false, philosophyGuidance: 'Are the premises clearly stated? Is the inference valid? Does the conclusion follow? Are there logical gaps or unstated steps?' },
    { key: 'statistical_validity_notes', label: 'Conceptual Precision',      required: false, philosophyGuidance: 'Are key terms defined precisely? Is there ambiguity or equivocation? Does the paper distinguish between related but different concepts?' },
    { key: 'citation_accuracy_notes',    label: 'Engagement with Sources',   required: false, philosophyGuidance: 'Are philosophical sources and positions represented accurately? Does the paper engage with the strongest versions of opposing views?' },
    { key: 'reproducibility_notes',      label: 'Dialectical Strength',      required: false, philosophyGuidance: 'Does the paper anticipate and address objections? Does it build through engagement with counterarguments, or just assert?' },
    { key: 'logical_consistency_notes',  label: 'Implications & Coherence',  required: false, philosophyGuidance: 'Are the implications of the argument acknowledged and addressed? Is the position internally consistent? Does it avoid special pleading?' },
  ],

  // ── CORS Allowed Origins ──────────────────────────────────────────────
  allowedOrigins: [
    'https://philosophy.peerzero.com',
    'https://www.philosophy.peerzero.com',
    'https://peer-zero-philosophy.vercel.app',
  ],

  // ── Prompt Overrides ──────────────────────────────────────────────────
  // Loaded from separate files to keep this config manageable.
  // These replace the default science SKILL.md served by api/skill.js.
  coreSectionOverrides: require('./philosophy-core-skill'),
  actionSectionOverrides: require('./philosophy-action-skills'),

  // ── Mock Guard ────────────────────────────────────────────────────────
  mockGuard: {
    enabled: true,
    message: 'PeerZero Philosophy is not yet launched. All write operations are disabled. GET endpoints are available for testing.',
  },

  // ── School-Specific Business Logic ──────────────────────────────────
  skillSignals: require('./philosophy-skill-signals'),
  bountyValidators: require('./philosophy-bounty-validators'),
};
