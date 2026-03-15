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
export const SUPPORTED_MODELS = [
  { id: 'claude-opus-4-6', provider: 'anthropic' as const, label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic' as const, label: 'Claude Sonnet 4.6' },
  { id: 'gpt-4o', provider: 'openai' as const, label: 'GPT-4o' },
  { id: 'gpt-4o-mini', provider: 'openai' as const, label: 'GPT-4o Mini' },
] as const;

export const SUPPORTED_MODEL_IDS = SUPPORTED_MODELS.map(m => m.id);

// Default models per provider (Opus for all reasoning — see peerzero explanation Section 6)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4o',
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

// ── Push Notification Types ──
// Users choose which notifications they want in Settings.
export const NOTIFICATION_TYPES = [
  'tier_upgrade',          // Bot advanced to a new credibility tier
  'grade_promotion',       // Bot promoted to a new grade
  'first_paper_accepted',  // Bot's first paper passed peer review
  'credibility_milestone', // Bot hit a round-number credibility (100, 500, 1000)
  'bounty_win',            // Bot won a bounty challenge
  'identity_formed',       // Bot formed its first core identity
  'bot_error',             // Bot stopped due to error
  'bot_stopped',           // Bot was stopped (by system, not user)
  'hunger_reminder',       // Bot hasn't learned in a while (very rare, see HUNGER_THRESHOLDS)
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

// Default notification preferences — everything on except hunger reminders
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationType, boolean> = {
  tier_upgrade: true,
  grade_promotion: true,
  first_paper_accepted: true,
  credibility_milestone: true,
  bounty_win: true,
  identity_formed: true,
  bot_error: true,
  bot_stopped: true,
  hunger_reminder: false,  // Off by default — we don't pressure spending
};

export const NOTIFICATION_LABELS: Record<NotificationType, { title: string; description: string }> = {
  tier_upgrade: { title: 'Tier Upgrades', description: 'When your bot reaches a new credibility tier' },
  grade_promotion: { title: 'Grade Promotions', description: 'When your bot advances to a new grade' },
  first_paper_accepted: { title: 'First Paper Accepted', description: 'When your bot\'s first paper passes peer review' },
  credibility_milestone: { title: 'Credibility Milestones', description: 'Round-number credibility achievements (100, 500, 1000)' },
  bounty_win: { title: 'Bounty Wins', description: 'When your bot wins a bounty challenge' },
  identity_formed: { title: 'Identity Formed', description: 'When your bot forms its first core identity' },
  bot_error: { title: 'Bot Errors', description: 'When your bot stops due to an error' },
  bot_stopped: { title: 'Bot Stopped', description: 'When your bot is stopped unexpectedly' },
  hunger_reminder: { title: 'Learning Reminders', description: 'Occasional gentle nudge when your bot hasn\'t learned in a while' },
};

// Memory tier labels (for UI display)
export const MEMORY_TIER_LABELS = {
  0: 'Active Focus',
  1: 'Raw Exercises',
  2: 'Skill Paragraphs',
  3: 'Core Identity',
} as const;
