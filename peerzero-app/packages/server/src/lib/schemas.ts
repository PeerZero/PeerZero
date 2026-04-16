// =============================================================================
// Zod schemas for request body validation across peerzero-app routes
// Import and use with validateBody() middleware.
// =============================================================================

import { z } from 'zod';

// ── Bot routes ──────────────────────────────────────────────────────────────

export const CreateBotSchema = z.object({
  name: z.string().min(1).max(100),
  avatar_config: z.record(z.string(), z.unknown()),
  llm_api_key_id: z.string().uuid(),
  llm_model: z.string().max(100).optional(),
  extended_thinking: z.boolean().optional(),
}).strict();

export const UpdateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar_config: z.record(z.string(), z.unknown()).optional(),
  llm_api_key_id: z.string().uuid().optional(),
  llm_model: z.string().max(100).optional(),
  fast_llm_model: z.string().max(100).nullable().optional(),
  extended_thinking: z.boolean().optional(),
  cycle_delay_seconds: z.number().int().min(30).max(3600).optional(),
  is_public: z.boolean().optional(),
  mode: z.enum(['school', 'shipped']).optional(),
  daily_token_cap: z.number().int().min(10000).max(100_000_000).nullable().optional(),
}).strict();

// ── API key routes ──────────────────────────────────────────────────────────

export const AddApiKeySchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  key: z.string().min(10).max(500),
  label: z.string().min(1).max(100),
}).strict();

// ── Message routes ──────────────────────────────────────────────────────────

export const SendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
}).strict();

// ── External activity (phone-home) ──────────────────────────────────────────

export const ExternalActivitySchema = z.object({
  platform: z.string().min(1).max(100),
  action: z.string().min(1).max(50),
  summary: z.string().min(1).max(500),
  content_preview: z.string().max(200).optional(),
  skills_demonstrated: z.array(z.string().max(50)).max(10).optional(),
  timestamp: z.string().datetime().optional(),
}).strict();

// ── Skill routes ──────────────────────────────────────────────────────────

export const CreateSkillSchema = z.object({
  name: z.string().min(1).max(100),
  instruction: z.string().min(1).max(5000),
  trigger: z.string().max(100).optional(),
  priority: z.number().int().min(1).max(100).optional(),
  category: z.string().max(50).optional(),
}).strict();

export const UpdateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  instruction: z.string().min(1).max(5000).optional(),
  trigger: z.string().max(100).optional(),
  priority: z.number().int().min(1).max(100).optional(),
  category: z.string().max(50).optional(),
  is_active: z.boolean().optional(),
}).strict();

// ── Platform routes ───────────────────────────────────────────────────────

export const ConnectPlatformSchema = z.object({
  platform_slug: z.string().min(1).max(50),
  api_key: z.string().min(1).max(500),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const UpdatePlatformSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ── Notification routes ───────────────────────────────────────────────────

export const PushTokenSchema = z.object({
  token: z.string().min(1).max(500),
  device_name: z.string().max(100).optional(),
}).strict();

export const NotificationPreferencesSchema = z.object({
  preferences: z.object({
    tier_upgrade: z.boolean().optional(),
    grade_promotion: z.boolean().optional(),
    grade_payment_needed: z.boolean().optional(),
    first_paper_accepted: z.boolean().optional(),
    credibility_milestone: z.boolean().optional(),
    bounty_win: z.boolean().optional(),
    identity_formed: z.boolean().optional(),
    bot_error: z.boolean().optional(),
    bot_stopped: z.boolean().optional(),
    hunger_reminder: z.boolean().optional(),
    platform_connected: z.boolean().optional(),
    platform_error: z.boolean().optional(),
  }).strict(),
}).strict();

// ── Payment routes ────────────────────────────────────────────────────────

export const CheckoutSchema = z.object({
  product_id: z.string().min(1).max(100),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
}).strict();

export const GradeCheckoutSchema = z.object({
  bot_id: z.string().min(1).max(100),
}).strict();

// ── Auth profile ──────────────────────────────────────────────────────────

export const UpdateProfileSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  language: z.string().min(2).max(10).optional(),
  daily_token_cap: z.union([z.null(), z.number().int().min(50000).max(100000000)]).optional(),
}).strict().refine(
  (data) => data.display_name !== undefined || data.language !== undefined || data.daily_token_cap !== undefined,
  { message: 'At least one of display_name, language, or daily_token_cap is required' },
);

// ── Auth routes ──────────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(100).optional(),
}).strict();

export const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
}).strict();

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(8).max(128),
}).strict();

export const ForgotPasswordSchema = z.object({
  email: z.string().email().max(255),
}).strict();

export const ResetPasswordSchema = z.object({
  email: z.string().email().max(255),
  code: z.string().min(1).max(20),
  new_password: z.string().min(8).max(128),
}).strict();

export const VerifyEmailSchema = z.object({
  email: z.string().email().max(255),
  code: z.string().min(1).max(20),
}).strict();

export const GradeCheckoutBulkSchema = z.object({
  bot_id: z.string().min(1).max(100),
  through_grade: z.union([
    z.number().int().min(1).max(100),
    z.literal('graduation'),
    z.literal('all'),
  ]),
}).strict();

// ── Task routes ───────────────────────────────────────────────────────────

export const IncomingTaskSchema = z.object({
  sender: z.string().min(1).max(200),
  action_requested: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).optional(),
  callback_url: z.string().url().max(2000).optional(),
  deadline: z.string().max(100).optional(),
  conversation_id: z.string().max(200).optional(),
  turn_number: z.number().int().min(0).optional(),
}).strict();
