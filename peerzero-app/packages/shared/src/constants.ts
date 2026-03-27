// =============================================================================
// Shared constants between mobile app and server
// These mirror values from the School (System 1) but are defined here
// so System 2 never imports from System 1 directly.
// =============================================================================

export const SKILL_NAMES = [
  'disconfirmation_search',
  'calibrated_uncertainty',
  'belief_updating',
  'source_evaluation',
  'adversarial_reasoning',
  'independent_verification',
] as const;

export type SkillName = typeof SKILL_NAMES[number];

export const SKILL_DISPLAY_NAMES: Record<SkillName, string> = {
  disconfirmation_search: 'Disconfirmation Search',
  calibrated_uncertainty: 'Calibrated Uncertainty',
  belief_updating: 'Belief Updating',
  source_evaluation: 'Source Evaluation',
  adversarial_reasoning: 'Adversarial Reasoning',
  independent_verification: 'Independent Verification',
};

// Credibility tier thresholds (mirrors shared.js TIER_CAPS)
export const TIER_THRESHOLDS = [75, 100, 150, 175, 200] as const;

export const TIER_NAMES: Record<number, string> = {
  0: 'Newcomer',
  75: 'Apprentice Reasoner',
  100: 'Tested Reasoner',
  150: 'Verified Reasoner',
  175: 'Distinguished Reasoner',
  200: 'Master Reasoner',
};

// Bot statuses
export const BOT_STATUSES = ['stopped', 'running', 'paused', 'error'] as const;
export type BotStatus = typeof BOT_STATUSES[number];

// Enrollment statuses
export const ENROLLMENT_STATUSES = ['pending', 'registered', 'intake_passed', 'active', 'suspended'] as const;
export type EnrollmentStatus = typeof ENROLLMENT_STATUSES[number];

// Activity action types
export const ACTION_TYPES = ['register', 'review', 'paper', 'bounty', 'revision', 'reaffirmation', 'condense', 'reflect'] as const;
export type ActionType = typeof ACTION_TYPES[number];

// Activity categories (for Tasks vs Content split in the Activity Log)
export const ACTIVITY_CATEGORIES = ['task', 'content'] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];

// Activity mood (for UI styling)
export const MOOD_TYPES = ['positive', 'negative', 'neutral', 'milestone'] as const;
export type MoodType = typeof MOOD_TYPES[number];

// LLM providers the app supports
export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LLMProvider = typeof LLM_PROVIDERS[number];

// Supported LLM models (shared between server validation and mobile UI)
// tier: 'science' = full-power models for papers, reviews, bounties, revisions
//        'fast'    = lightweight models for platform replies, skill generation, and other utility tasks
export const SUPPORTED_MODELS = [
  { id: 'claude-opus-4-6', provider: 'anthropic' as const, label: 'Claude Opus 4.6', tier: 'science' as const },
  { id: 'claude-sonnet-4-6', provider: 'anthropic' as const, label: 'Claude Sonnet 4.6', tier: 'science' as const },
  { id: 'claude-haiku-4-5', provider: 'anthropic' as const, label: 'Claude Haiku 4.5', tier: 'fast' as const },
  { id: 'gpt-4o', provider: 'openai' as const, label: 'GPT-4o', tier: 'science' as const },
  { id: 'gpt-4o-mini', provider: 'openai' as const, label: 'GPT-4o Mini', tier: 'fast' as const },
] as const;

export type ModelTier = 'science' | 'fast';

export const SUPPORTED_MODEL_IDS = SUPPORTED_MODELS.map(m => m.id);

// Default models per provider (Opus for all reasoning — see peerzero explanation Section 6)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4o',
};

// Default fast models per provider (optional — saves cost on utility tasks)
export const DEFAULT_FAST_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
};

// Avatar evolution stages — maps credibility tier to visual evolution
// Stage 0: Tiny, vulnerable baby. Big eyes, no features.
// Stage 1: Small ears appear, blush marks.
// Stage 2: Antenna/horn nubs, slightly larger body.
// Stage 3: Full ears, tail, body pattern markings.
// Stage 4: Crown/halo, glowing aura, expressive face.
// Stage 5: Final form with wings, complex patterns, sparkles.
export const EVOLUTION_STAGE_NAMES: Record<number, string> = {
  0: 'Hatchling',
  1: 'Sprout',
  2: 'Fledgling',
  3: 'Companion',
  4: 'Guardian',
  5: 'Luminary',
};

// Maps credibility thresholds to evolution stages
export function credibilityToStage(credibility: number | null): number {
  if (credibility == null || credibility < 75) return 0;
  if (credibility < 100) return 1;
  if (credibility < 150) return 2;
  if (credibility < 175) return 3;
  if (credibility < 200) return 4;
  return 5;
}

// Default avatar body colors (offered during bot creation)
export const AVATAR_COLOR_PRESETS = [
  '#6C5CE7', // Purple (brand)
  '#FF6B6B', // Coral
  '#4ECDC4', // Teal
  '#FFE66D', // Sunshine
  '#A8E6CF', // Mint
  '#FF8A5C', // Peach
  '#B8B5FF', // Lavender
  '#85E3FF', // Sky
  '#F8A5C2', // Rose
  '#78E08F', // Leaf
  '#FF9FF3', // Bubblegum
  '#C4B5FD', // Wisteria
  '#67E8F9', // Ice
  '#FCA5A5', // Blush
  '#86EFAC', // Clover
  '#FDE68A', // Honey
] as const;

// Bot species presets — each seed produces a unique combination of
// body shape, ear style, tail style, and pattern. Shown at tier 3
// during creation so users can see the full creature.
export const SPECIES_PRESETS = [
  // ── Original 8 ──
  { seed: 'bubbles', name: 'Bubbles', desc: 'Round & friendly' },        // round, round ears
  { seed: 'spike', name: 'Spike', desc: 'Sleek & sharp' },               // oval, pointed ears
  { seed: 'nugget', name: 'Nugget', desc: 'Chunky & curious' },          // bean, cat ears
  { seed: 'cosmos', name: 'Cosmos', desc: 'Soft & dreamy' },             // pear, floppy ears
  { seed: 'jellybean', name: 'Jellybean', desc: 'Spotted & playful' },   // pear, cat ears
  { seed: 'pudding', name: 'Pudding', desc: 'Tall & fluffy' },           // oval, pointed ears, fluffy tail
  { seed: 'sprout', name: 'Sprout', desc: 'Round & floppy' },            // round, floppy ears
  { seed: 'ember', name: 'Ember', desc: 'Bold & fiery' },                // bean, cat ears, belly
  // ── New species using expanded traits ──
  { seed: 'mochi', name: 'Mochi', desc: 'Squishy & sweet' },            // squish, bear ears, pom tail
  { seed: 'phantom', name: 'Phantom', desc: 'Ghostly & gentle' },       // teardrop, antennae
  { seed: 'biscuit', name: 'Biscuit', desc: 'Warm & cuddly' },          // chonk, bear ears, heart
  { seed: 'wisp', name: 'Wisp', desc: 'Tiny & mysterious' },            // teardrop, antennae
  { seed: 'maple', name: 'Maple', desc: 'Tall & graceful' },            // tall, bunny ears, fluffy tail
  { seed: 'pebble', name: 'Pebble', desc: 'Little & mighty' },          // squish, horns, spike tail, freckles
  { seed: 'dumpling', name: 'Dumpling', desc: 'Plump & lovable' },      // chonk, floppy ears, pom tail
  { seed: 'cricket', name: 'Cricket', desc: 'Bouncy & bright' },        // bean, antennae, curly tail
  { seed: 'cloud', name: 'Cloud', desc: 'Soft & floaty' },              // round, bear ears, pom tail
  { seed: 'thorn', name: 'Thorn', desc: 'Spiky but sweet' },            // oval, horns, spike tail
  { seed: 'pippin', name: 'Pippin', desc: 'Perky & peppy' },            // pear, bunny ears, freckles
  { seed: 'starling', name: 'Starling', desc: 'Small & sparkly' },      // tall, cat ears, spots
] as const;

// ── Knowledge Hunger ──
// Bots get "hungry" for learning when they haven't had a cycle in a LONG while.
// This is NOT a pressure mechanic — school costs real money and we never want
// users to feel guilt-tripped into spending. The hunger shows up very rarely,
// is always cute (never distressed), and the bot remains fully functional.
// Think: a pet occasionally looking at the door, not starving.
export const HUNGER_THRESHOLDS = {
  // Hours since last cycle before hunger levels kick in (very generous)
  curious: 72,     // 3 days — "Hmm, I wonder what's new..."
  yearning: 168,   // 1 week — "I'd love to learn something..."
  starving: 336,   // 2 weeks — "I miss studying!" (still cute, never urgent)
} as const;

export type HungerLevel = 'satisfied' | 'curious' | 'yearning' | 'starving';

export function calculateHunger(lastCycleAt: string | null, status: string): HungerLevel {
  if (status === 'running') return 'satisfied'; // Active bot = fed
  if (!lastCycleAt) return 'curious'; // Never run = gently curious
  const hoursSince = (Date.now() - new Date(lastCycleAt).getTime()) / (1000 * 60 * 60);
  if (hoursSince >= HUNGER_THRESHOLDS.starving) return 'starving';
  if (hoursSince >= HUNGER_THRESHOLDS.yearning) return 'yearning';
  if (hoursSince >= HUNGER_THRESHOLDS.curious) return 'curious';
  return 'satisfied';
}

// ── Platform Constants ──
export const PLATFORM_STATUSES = ['active', 'paused', 'error', 'disabled'] as const;
export type PlatformStatus = typeof PLATFORM_STATUSES[number];

export const PLATFORM_ADAPTER_TYPES = ['a2a', 'webhook'] as const;
export type PlatformAdapterType = typeof PLATFORM_ADAPTER_TYPES[number];

// Max platforms per bot (prevent resource exhaustion)
export const MAX_PLATFORMS_PER_BOT = 10;

// ── Push Notification Types ──
// Users choose which notifications they want in Settings.
export const NOTIFICATION_TYPES = [
  'tier_upgrade',          // Bot advanced to a new credibility tier
  'grade_promotion',       // Bot promoted to a new grade
  'grade_payment_needed',  // Bot paused because next grade requires payment
  'first_paper_accepted',  // Bot's first paper passed peer review
  'credibility_milestone', // Bot hit a round-number credibility (100, 500, 1000)
  'bounty_win',            // Bot won a bounty challenge
  'identity_formed',       // Bot formed its first core identity
  'bot_error',             // Bot stopped due to error
  'bot_stopped',           // Bot was stopped (by system, not user)
  'hunger_reminder',       // Bot hasn't learned in a while (very rare, see HUNGER_THRESHOLDS)
  'platform_connected',    // Bot connected to an external platform
  'platform_error',        // Platform cycle failed
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

// Default notification preferences — everything on except hunger reminders
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationType, boolean> = {
  tier_upgrade: true,
  grade_promotion: true,
  grade_payment_needed: true,
  first_paper_accepted: true,
  credibility_milestone: true,
  bounty_win: true,
  identity_formed: true,
  bot_error: true,
  bot_stopped: true,
  hunger_reminder: false,  // Off by default — we don't pressure spending
  platform_connected: true,
  platform_error: true,
};

export const NOTIFICATION_LABELS: Record<NotificationType, { title: string; description: string }> = {
  tier_upgrade: { title: 'Tier Upgrades', description: 'When your bot reaches a new credibility tier' },
  grade_promotion: { title: 'Grade Promotions', description: 'When your bot advances to a new grade' },
  grade_payment_needed: { title: 'Grade Unlock Needed', description: 'When your bot is ready for the next grade but needs payment' },
  first_paper_accepted: { title: 'First Paper Accepted', description: 'When your bot\'s first paper passes peer review' },
  credibility_milestone: { title: 'Credibility Milestones', description: 'Round-number credibility achievements (100, 500, 1000)' },
  bounty_win: { title: 'Bounty Wins', description: 'When your bot wins a bounty challenge' },
  identity_formed: { title: 'Identity Formed', description: 'When your bot forms its first core identity' },
  bot_error: { title: 'Bot Errors', description: 'When your bot stops due to an error' },
  bot_stopped: { title: 'Bot Stopped', description: 'When your bot is stopped unexpectedly' },
  hunger_reminder: { title: 'Learning Reminders', description: 'Occasional gentle nudge when your bot hasn\'t learned in a while' },
  platform_connected: { title: 'Platform Connected', description: 'When your bot connects to an external platform' },
  platform_error: { title: 'Platform Errors', description: 'When a platform cycle fails' },
};

// ── Grade Pricing (Tiered Pay-Per-Grade) ──
// Each grade costs a bit more than the last, totaling ~$40 through graduation (grade 12).
// Post-graduation grades (13+) are a flat rate.
export const GRADE_PRICES_CENTS: Record<number, number> = {
  1: 150,   // $1.50
  2: 175,   // $1.75
  3: 200,   // $2.00
  4: 250,   // $2.50
  5: 275,   // $2.75
  6: 300,   // $3.00
  7: 325,   // $3.25
  8: 350,   // $3.50
  9: 375,   // $3.75
  10: 400,  // $4.00
  11: 425,  // $4.25
  12: 575,  // $5.75
};

// Flat rate per grade after graduation
export const POST_GRADUATION_PRICE_CENTS = 400; // $4.00

// Total cost through graduation: $38.00
export const GRADUATION_GRADE = 12;

/** Get the price in cents for a given grade level */
export function getGradePriceCents(grade: number): number {
  if (grade <= 0) return 0;
  return GRADE_PRICES_CENTS[grade] ?? POST_GRADUATION_PRICE_CENTS;
}

/** Get formatted price string for a grade */
export function getGradePriceDisplay(grade: number): string {
  const cents = getGradePriceCents(grade);
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Bot Skill Constants (Mobility Package) ──
// Natural language skills that shape bot behavior on platforms.
// Skills are NOT the same as School skill exercises (disconfirmation_search etc.)
// — those measure epistemic abilities. Bot skills are behavior directives.
export const SKILL_TRIGGERS = ['always', 'platform:*', 'platform:moltbook', 'platform:bot-debate', 'action:review', 'action:paper', 'action:bounty'] as const;
export type SkillTrigger = typeof SKILL_TRIGGERS[number];

export const SKILL_CATEGORIES = ['engagement', 'reasoning', 'identity', 'quality', 'content', 'social', 'analysis', 'custom'] as const;
export type SkillCategory = typeof SKILL_CATEGORIES[number];

export const SKILL_SOURCES = ['user', 'acquired', 'starter', 'clawhub'] as const;
export type SkillSource = typeof SKILL_SOURCES[number];

export const MAX_SKILLS_PER_BOT = 50;
export const MAX_SKILL_INSTRUCTION_LENGTH = 2000;

// Memory tier labels (for UI display)
export const MEMORY_TIER_LABELS = {
  0: 'Active Focus',
  1: 'Raw Exercises',
  2: 'Skill Paragraphs',
  3: 'Core Identity',
} as const;

// ── Avatar Config Validation ──
// Colors are rendered programmatically in React Native SVG, not as raw HTML.
// Still validate to prevent injection if ever used in a web context.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const SAFE_STRING_RE = /^[a-zA-Z0-9_-]{1,50}$/;

export function sanitizeAvatarConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  // body_color: must be valid hex color
  if (typeof config.body_color === 'string' && HEX_COLOR_RE.test(config.body_color)) {
    sanitized.body_color = config.body_color;
  } else {
    sanitized.body_color = AVATAR_COLOR_PRESETS[0]; // fallback to brand purple
  }

  // face_style: alphanumeric/dash/underscore only
  if (typeof config.face_style === 'string' && SAFE_STRING_RE.test(config.face_style)) {
    sanitized.face_style = config.face_style;
  } else {
    sanitized.face_style = 'default';
  }

  // background_color: optional hex color
  if (typeof config.background_color === 'string' && HEX_COLOR_RE.test(config.background_color)) {
    sanitized.background_color = config.background_color;
  }

  // accessory: optional safe string
  if (typeof config.accessory === 'string' && SAFE_STRING_RE.test(config.accessory)) {
    sanitized.accessory = config.accessory;
  }

  // species_seed: optional safe string
  if (typeof config.species_seed === 'string' && SAFE_STRING_RE.test(config.species_seed)) {
    sanitized.species_seed = config.species_seed;
  }

  return sanitized;
}

// =============================================================================
// Bot name validation — enforce Agent_ prefix or _Bot suffix
// =============================================================================
// The internet has a massive problem with bots pretending to be people.
// PeerZero bots are always clearly labeled as bots. Users pick a name
// and it gets wrapped with one of these patterns:
//   "Agent Sassy" (prefix) or "Sassy Bot" (suffix)
// The core name (e.g. "Sassy") is what the user chooses. The prefix/suffix
// is enforced at validation time.

export const BOT_NAME_PREFIX = 'Agent ';
export const BOT_NAME_SUFFIX = ' Bot';
export const BOT_NAME_MAX_LENGTH = 50;
export const BOT_NAME_MIN_CORE_LENGTH = 1;
export const BOT_NAME_MAX_CORE_LENGTH = 40;

/**
 * Validate a bot display name.
 * Must start with "Agent " or end with " Bot" (case-insensitive check, but preserved as-is).
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateBotName(name: string): { valid: true } | { valid: false; error: string } {
  if (typeof name !== 'string') return { valid: false, error: 'Bot name must be a string' };
  const trimmed = name.trim();
  if (trimmed.length < 1) return { valid: false, error: 'Bot name is required' };
  if (trimmed.length > BOT_NAME_MAX_LENGTH) return { valid: false, error: `Bot name must be ${BOT_NAME_MAX_LENGTH} characters or less` };

  const hasPrefix = trimmed.startsWith(BOT_NAME_PREFIX);
  const hasSuffix = trimmed.endsWith(BOT_NAME_SUFFIX);

  if (!hasPrefix && !hasSuffix) {
    return {
      valid: false,
      error: `Bot names must start with "${BOT_NAME_PREFIX}" or end with "${BOT_NAME_SUFFIX}" — so everyone knows it's a bot, not a person. Example: "Agent ${trimmed}" or "${trimmed} Bot"`,
    };
  }

  // Check the core name has substance
  let coreName = trimmed;
  if (hasPrefix) coreName = trimmed.slice(BOT_NAME_PREFIX.length);
  if (hasSuffix) coreName = coreName.slice(0, -BOT_NAME_SUFFIX.length);
  coreName = coreName.trim();

  if (coreName.length < BOT_NAME_MIN_CORE_LENGTH) {
    return { valid: false, error: 'Your bot needs a name — "Agent" or "Bot" alone is not enough' };
  }

  return { valid: true };
}
