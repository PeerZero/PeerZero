// =============================================================================
// Types for the App's own API (System 2 endpoints)
// These define the contract between the mobile app and the app server.
// =============================================================================

import { BotStatus, EnrollmentStatus, ActionType, MoodType, LLMProvider, ActivityCategory } from './constants';

// ── Auth ──
export interface RegisterRequest {
  email: string;
  password: string;
  display_name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user: UserProfile;
}

export interface UserProfile {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  entitlements: {
    bot_slots: number;
    bots_used: number;
    school_enrollments: string[];  // school IDs with active enrollment
  };
}

// ── Bots ──
export interface CreateBotRequest {
  name: string;
  avatar_config: AvatarConfig;
  llm_api_key_id: string;
  llm_model?: string;
}

export interface AvatarConfig {
  body_color: string;
  face_style: string;
  accessory?: string;
  background_color?: string;
  // Extended avatar fields (populated by creature generator)
  species_seed?: string;  // Override seed for creature shape (defaults to bot ID)
}

export interface BotSummary {
  id: string;
  name: string;
  avatar_config: AvatarConfig;
  status: BotStatus;
  cached_credibility: number | null;
  cached_grade: number | null;
  cached_tier: number | null;
  school_name: string | null;
  cycle_count: number;
  last_cycle_at: string | null;
}

export interface BotDetail extends BotSummary {
  school_id: string | null;
  school_agent_handle: string | null;
  llm_api_key_id: string | null;
  llm_model: string;
  cycle_delay_seconds: number;
  cached_next_action: string | null;
  cached_profile: Record<string, unknown> | null;
  cache_stale: boolean;
  cache_updated_at: string | null;
  error_message: string | null;
  created_at: string;
  // Grade unlock info
  highest_unlocked_grade: number;
  grade_payment_required: boolean;
  next_grade_price_cents: number | null;
}

// ── Memory ──
export interface MemorySnapshot {
  tier0_focus: FocusChunk[];
  tier1_exercises: MemoryExercise[];
  tier2_paragraphs: MemoryParagraph[];
  tier3_core: MemoryCore | null;
  tier3_self_identity: MemorySelfIdentity | null;
}

export interface FocusChunk {
  source: string;
  content: string;
  label: string;
}

export interface MemoryExercise {
  id: string;
  cycle_number: number;
  action_type: string;
  exercise_data: Record<string, unknown>;
  created_at: string;
}

export interface MemoryParagraph {
  id: string;
  interaction_type: string;
  paragraph: string;
  trigger_cycle: number | null;
  created_at: string;
}

export interface MemoryCore {
  core_identity: string;
  trigger_label: string | null;
  version: number;
  created_at: string;
}

export interface MemorySelfIdentity {
  self_narrative: string | null;
  claimed_values: string[];
  active_tensions: string | null;
  formed_convictions: string | null;
  cached_at: string;
}

// ── Activity ──
export interface ActivityEntry {
  id: string;
  cycle_number: number;
  action_type: ActionType;
  category: ActivityCategory;
  translated: TranslatedActivity;
  content_text: string | null;
  error: string | null;
  duration_ms: number | null;
  llm_tokens_used: number | null;
  created_at: string;
}

export interface TranslatedActivity {
  headline: string;
  summary: string;
  details: string[];
  mood: MoodType;
  credibility_change?: number;
  new_credibility?: number;
}

// ── Schools ──
export interface SchoolInfo {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  is_active: boolean;
}

export interface EnrollRequest {
  bot_id: string;
}

export interface EnrollmentInfo {
  bot_id: string;
  school_id: string;
  status: EnrollmentStatus;
  enrolled_at: string;
}

// ── API Keys ──
export interface AddApiKeyRequest {
  provider: LLMProvider;
  label: string;
  key: string;  // plaintext — encrypted on receipt, never stored
}

export interface ApiKeyInfo {
  id: string;
  provider: LLMProvider;
  label: string;
  key_fingerprint: string;  // e.g. "sk-ant-...xyz9"
  is_valid: boolean;
  created_at: string;
}

// ── Payments ──
export interface CheckoutRequest {
  product_id: string;
  metadata?: Record<string, string>;  // e.g. { bot_id: "...", school_id: "..." }
}

export interface CheckoutResponse {
  session_url: string;
}

export interface ProductInfo {
  id: string;
  name: string;
  type: 'bot_shell' | 'school_enrollment' | 'grade_advancement' | 'feature';
  price_cents: number;
  description: string | null;
}

// ── Grade Advancement ──
export interface GradeCheckoutRequest {
  bot_id: string;
}

export interface GradeStatusResponse {
  unlocked_grades: number[];
  highest_unlocked: number;
}

export interface BulkGradeCheckoutRequest {
  bot_id: string;
  through_grade: number | 'graduation' | 'all';
}

export interface GradePricePreview {
  grades: number[];
  total_cents: number;
}

// ── External Activity (Phone-Home from System 3) ──
export interface ExternalActivityEntry {
  id: string;
  platform: string;
  action: string;
  summary: string;
  content_preview: string | null;
  skills_demonstrated: string[];
  bot_timestamp: string | null;
  created_at: string;
}

// ── Push Notifications ──
export interface PushTokenRequest {
  token: string;          // Expo push token (ExponentPushToken[...])
  device_name?: string;   // Optional device identifier
}

export interface NotificationPrefsResponse {
  preferences: Record<string, boolean>;
}

export interface UpdateNotificationPrefsRequest {
  preferences: Record<string, boolean>;  // Partial update — only keys present are changed
}

// ── Profile Management ──
export interface UpdateProfileRequest {
  display_name?: string;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

// ── Bot Stats ──
export interface BotStats {
  credibility_history: Array<{ date: string; value: number }>;
  action_breakdown: Array<{ action_type: string; count: number }>;
  skill_progress: Array<{ skill: string; strength: number; reps: number }>;
  token_usage_trend: Array<{ date: string; tokens: number }>;
  total_cycles: number;
  total_tokens: number;
}

// ── Paginated response wrapper ──
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
}
