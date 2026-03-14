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

// Activity mood (for UI styling)
export const MOOD_TYPES = ['positive', 'negative', 'neutral', 'milestone'] as const;
export type MoodType = typeof MOOD_TYPES[number];

// LLM providers the app supports
export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LLMProvider = typeof LLM_PROVIDERS[number];

// Default models per provider (Opus for all reasoning — see peerzero explanation Section 6)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4o',
};

// Memory tier labels (for UI display)
export const MEMORY_TIER_LABELS = {
  0: 'Active Focus',
  1: 'Raw Exercises',
  2: 'Skill Paragraphs',
  3: 'Core Identity',
} as const;
