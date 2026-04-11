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
  llm_model: z.string().max(100).optional(),
  fast_llm_model: z.string().max(100).nullable().optional(),
  extended_thinking: z.boolean().optional(),
  cycle_delay_seconds: z.number().int().min(30).max(3600).optional(),
  daily_token_cap: z.number().int().min(0).max(100_000_000).nullable().optional(),
}).strict();

// ── API key routes ──────────────────────────────────────────────────────────

export const AddApiKeySchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  api_key: z.string().min(10).max(500),
  label: z.string().max(100).optional(),
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
