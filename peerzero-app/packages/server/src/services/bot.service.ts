// =============================================================================
// Bot service — CRUD for bot instances, enrollment, status management
// =============================================================================

import crypto from 'crypto';
import { queryOne, queryRows, query } from '../db/client';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { encrypt, decrypt } from './encryption.service';
import { getSchoolAdapter } from '../adapters/adapter.factory';
import type { BotSummary, BotDetail, BotStatus } from '@peerzero/shared';
import { SUPPORTED_MODEL_IDS, BOT_STATUSES, sanitizeAvatarConfig, getGradePriceCents, DEFAULT_FAST_MODELS, validateBotName } from '@peerzero/shared';

// DB row shape for getBotDetail query (includes columns not in BotDetail)
interface BotDetailRow extends BotDetail {
  cache_updated_at: string | null;
  is_public: boolean;
  public_slug: string | null;
}

export async function createBot(
  userId: string,
  name: string,
  avatarConfig: Record<string, unknown>,
  llmApiKeyId: string,
  llmModel?: string,
  extendedThinking?: boolean,
) {
  // Check entitlements: user must have available bot slots
  const entitlements = await queryRows<{ quantity: number }>(
    `SELECT SUM(quantity)::int as quantity FROM user_entitlements
     WHERE user_id = $1 AND entitlement_type = 'bot_shell'`,
    [userId],
  );
  const botSlots = entitlements[0]?.quantity || 1; // 1 free slot
  const botCount = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM bots WHERE user_id = $1',
    [userId],
  );
  if ((botCount?.count || 0) >= botSlots) {
    throw new AppError(403, 'No bot slots available. Purchase additional bot shells.');
  }

  // Verify the API key belongs to this user and get provider
  const key = await queryOne<{ id: string; provider: string }>(
    'SELECT id, provider FROM llm_api_keys WHERE id = $1 AND user_id = $2',
    [llmApiKeyId, userId],
  );
  if (!key) throw new AppError(400, 'Invalid API key');

  const model = llmModel || 'claude-opus-4-6';
  if (!(SUPPORTED_MODEL_IDS as readonly string[]).includes(model)) {
    throw new AppError(400, `Unsupported LLM model: ${model}. Supported: ${SUPPORTED_MODEL_IDS.join(', ')}`);
  }

  const safeAvatar = sanitizeAvatarConfig(avatarConfig);

  // Auto-assign fast model based on provider (saves API costs on utility tasks)
  const fastModel = DEFAULT_FAST_MODELS[key.provider as keyof typeof DEFAULT_FAST_MODELS] || null;

  const bot = await queryOne<{ id: string }>(
    `INSERT INTO bots (user_id, name, avatar_config, llm_api_key_id, llm_model, fast_llm_model, extended_thinking)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId, name, JSON.stringify(safeAvatar), llmApiKeyId, model, fastModel, extendedThinking ?? false],
  );

  if (!bot) throw new AppError(500, 'Failed to create bot');
  return bot.id;
}

export async function getUserBots(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{ data: BotSummary[]; total: number; has_more: boolean }> {
  const cappedLimit = Math.min(Math.max(limit, 1), 500);
  const [rows, countResult] = await Promise.all([
    queryRows<BotSummary>(
      `SELECT b.id, b.name, b.avatar_config, b.mode, b.status,
              b.cached_credibility, b.cached_grade, b.cached_tier,
              s.name as school_name, b.cycle_count, b.last_cycle_at
       FROM bots b
       LEFT JOIN schools s ON s.id = b.school_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, cappedLimit, offset],
    ),
    queryOne<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM bots WHERE user_id = $1',
      [userId],
    ),
  ]);
  const total = countResult?.count || 0;
  return { data: rows, total, has_more: offset + cappedLimit < total };
}

/** Get minimal bot info by ID (no auth check — for incoming task routing). */
export async function getBotById(botId: string): Promise<{ id: string; mode: string; status: string; name: string } | null> {
  return queryOne<{ id: string; mode: string; status: string; name: string }>(
    'SELECT id, mode, status, name FROM bots WHERE id = $1',
    [botId],
  );
}

export async function getBotDetail(userId: string, botId: string): Promise<BotDetail> {
  const bot = await queryOne<BotDetailRow>(
    `SELECT b.id, b.name, b.avatar_config, b.mode, b.status,
            b.cached_credibility, b.cached_grade, b.cached_tier,
            s.name as school_name, b.cycle_count, b.last_cycle_at,
            b.school_id, b.school_agent_handle, b.llm_api_key_id, b.llm_model, b.fast_llm_model, b.extended_thinking,
            b.cycle_delay_seconds, b.cached_next_action, b.cached_profile,
            b.error_message, b.created_at, b.cache_updated_at,
            b.is_public, b.public_slug,
            b.daily_token_cap, b.daily_tokens_used, b.daily_tokens_reset_at
     FROM bots b
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE b.id = $1 AND b.user_id = $2`,
    [botId, userId],
  );
  if (!bot) throw new AppError(404, 'Bot not found');

  // Mark cached profile as stale if not updated in 30 minutes
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;
  const cacheStale = bot.cache_updated_at
    ? (Date.now() - new Date(bot.cache_updated_at).getTime()) > STALE_THRESHOLD_MS
    : bot.cached_profile !== null; // has cache but no timestamp = stale

  // Grade unlock info
  const { getHighestUnlockedGrade } = await import('./payment.service');
  const highestUnlocked = await getHighestUnlockedGrade(botId);
  const currentGrade = bot.cached_grade || 1;
  const gradePaymentRequired = currentGrade > highestUnlocked;
  const nextGradePriceCents = gradePaymentRequired
    ? getGradePriceCents(currentGrade)
    : (highestUnlocked < currentGrade + 1 ? getGradePriceCents(currentGrade + 1) : null);

  return {
    ...bot,
    cache_stale: cacheStale,
    cache_updated_at: bot.cache_updated_at,
    highest_unlocked_grade: highestUnlocked,
    grade_payment_required: gradePaymentRequired,
    next_grade_price_cents: nextGradePriceCents,
    is_public: bot.is_public ?? false,
    public_slug: bot.public_slug ?? null,
  } as BotDetail;
}

/** Generate a URL-friendly slug from a bot name + short random suffix. */
function generatePublicSlug(name: string, botId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const suffix = botId.slice(0, 8);
  return `${base || 'bot'}-${suffix}`;
}

export async function updateBot(userId: string, botId: string, updates: Partial<{
  name: string;
  avatar_config: Record<string, unknown>;
  llm_api_key_id: string;
  llm_model: string;
  fast_llm_model: string | null;
  extended_thinking: boolean;
  cycle_delay_seconds: number;
  is_public: boolean;
  mode: 'school' | 'shipped';
  daily_token_cap: number | null;
}>) {
  // Build SET clause dynamically
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    const nameCheck = validateBotName(updates.name);
    if (!nameCheck.valid) throw new AppError(400, nameCheck.error);
    sets.push(`name = $${idx++}`); params.push(updates.name);
  }
  if (updates.avatar_config !== undefined) { sets.push(`avatar_config = $${idx++}`); params.push(JSON.stringify(sanitizeAvatarConfig(updates.avatar_config))); }
  if (updates.llm_api_key_id !== undefined) {
    // Verify the new API key belongs to this user
    const keyOwner = await queryOne(
      'SELECT id FROM llm_api_keys WHERE id = $1 AND user_id = $2',
      [updates.llm_api_key_id, userId],
    );
    if (!keyOwner) throw new AppError(400, 'Invalid API key');
    sets.push(`llm_api_key_id = $${idx++}`); params.push(updates.llm_api_key_id);
  }
  if (updates.llm_model !== undefined) { sets.push(`llm_model = $${idx++}`); params.push(updates.llm_model); }
  if (updates.fast_llm_model !== undefined) { sets.push(`fast_llm_model = $${idx++}`); params.push(updates.fast_llm_model); }
  if (updates.extended_thinking !== undefined) { sets.push(`extended_thinking = $${idx++}`); params.push(updates.extended_thinking); }
  if (updates.cycle_delay_seconds !== undefined) {
    if (updates.cycle_delay_seconds < 10 || updates.cycle_delay_seconds > 86400) {
      throw new AppError(400, 'cycle_delay_seconds must be between 10 and 86400');
    }
    sets.push(`cycle_delay_seconds = $${idx++}`); params.push(updates.cycle_delay_seconds);
  }
  if (updates.mode !== undefined) {
    if (updates.mode !== 'school' && updates.mode !== 'shipped') {
      throw new AppError(400, "mode must be 'school' or 'shipped'");
    }
    sets.push(`mode = $${idx++}`); params.push(updates.mode);
  }
  if (updates.is_public !== undefined) {
    sets.push(`is_public = $${idx++}`); params.push(updates.is_public);
    if (updates.is_public) {
      // Generate slug if making public and no slug exists yet
      const existing = await queryOne<{ public_slug: string | null; name: string }>(
        'SELECT public_slug, name FROM bots WHERE id = $1 AND user_id = $2',
        [botId, userId],
      );
      if (existing && !existing.public_slug) {
        const slug = generatePublicSlug(existing.name, botId);
        sets.push(`public_slug = $${idx++}`); params.push(slug);
      }
    }
  }

  if (updates.daily_token_cap !== undefined) {
    if (updates.daily_token_cap !== null && (updates.daily_token_cap < 10000 || updates.daily_token_cap > 100000000)) {
      throw new AppError(400, 'daily_token_cap must be null (unlimited) or between 10,000 and 100,000,000');
    }
    sets.push(`daily_token_cap = $${idx++}`); params.push(updates.daily_token_cap);
  }

  if (sets.length === 0) return;

  sets.push(`updated_at = NOW()`);
  params.push(botId, userId);

  await query(
    `UPDATE bots SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
    params,
  );
}

export async function deleteBot(userId: string, botId: string): Promise<void> {
  const result = await query('DELETE FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (result.rowCount === 0) throw new AppError(404, 'Bot not found');
}

export async function enrollBotInSchool(userId: string, botId: string, schoolId: string) {
  // Verify ownership
  const bot = await queryOne<{ id: string; name: string }>(
    'SELECT id, name FROM bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );
  if (!bot) throw new AppError(404, 'Bot not found');

  const school = await queryOne<{ id: string; base_url: string; slug: string }>(
    'SELECT id, base_url, slug FROM schools WHERE id = $1 AND is_active = true',
    [schoolId],
  );
  if (!school) throw new AppError(404, 'School not found');

  // Check not already enrolled
  const existing = await queryOne(
    'SELECT id FROM enrollments WHERE bot_id = $1 AND school_id = $2',
    [botId, schoolId],
  );
  if (existing) throw new AppError(409, 'Bot already enrolled in this school');

  // Register with the School API
  const adapter = getSchoolAdapter();
  const handle = `${bot.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${botId.slice(0, 8)}`;
  const regResult = await adapter.register(school.base_url, handle, `bot-${botId}@peerzero.app`);

  if (!regResult.success || !regResult.api_key) {
    throw new AppError(502, regResult.error || 'School registration failed');
  }

  // Encrypt the school API key
  const { encrypted, iv, fingerprint } = encrypt(regResult.api_key);

  // Update bot with school connection
  await query(
    `UPDATE bots SET
       school_id = $1, school_agent_handle = $2,
       school_api_key_encrypted = $3, school_api_key_iv = $4,
       school_api_key_fingerprint = $5, updated_at = NOW()
     WHERE id = $6`,
    [schoolId, handle, encrypted, iv, fingerprint, botId],
  );

  // Create enrollment record
  await query(
    'INSERT INTO enrollments (bot_id, school_id, status) VALUES ($1, $2, $3)',
    [botId, schoolId, 'registered'],
  );

  // Auto-unlock grade 1 (free with enrollment)
  const { unlockGradeOne } = await import('./payment.service');
  await unlockGradeOne(botId);

  return { handle, schoolSlug: school.slug };
}

/**
 * Generate a phone-home token for self-hosted bots (System 3).
 * Token is stored as SHA-256 hash — plaintext returned only once.
 * Write-only: cannot read bot data or control the bot.
 */
export async function generatePhoneHomeToken(userId: string, botId: string): Promise<string> {
  // Verify ownership
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const token = `pht_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days (reduced from 90 — Audit #5)

  await query(
    'UPDATE bots SET phone_home_token_hash = $1, phone_home_token_expires_at = $2, updated_at = NOW() WHERE id = $3',
    [tokenHash, expiresAt.toISOString(), botId],
  );

  return token;
}

/**
 * Generate an incoming task secret for A2A authentication.
 * When set, incoming tasks must include a valid HMAC-SHA256 signature.
 * Secret is stored as SHA-256 hash — plaintext returned only once.
 */
export async function generateIncomingTaskSecret(userId: string, botId: string): Promise<string> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const secret = `its_${crypto.randomBytes(32).toString('hex')}`;
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  await query(
    'UPDATE bots SET incoming_task_secret_hash = $1, updated_at = NOW() WHERE id = $2',
    [secretHash, botId],
  );

  return secret;
}

/** Clear the incoming task secret (revert to open A2A). */
export async function clearIncomingTaskSecret(userId: string, botId: string): Promise<void> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  await query(
    'UPDATE bots SET incoming_task_secret_hash = NULL, updated_at = NOW() WHERE id = $1',
    [botId],
  );
}

/**
 * Check if a bot has unlocked a specific grade.
 * Used by the agent loop to gate grade advancement on payment.
 */
export async function isBotGradeUnlocked(botId: string, grade: number): Promise<boolean> {
  if (config.skipPayments) return true;
  const result = await queryOne(
    'SELECT id FROM grade_unlocks WHERE bot_id = $1 AND grade = $2',
    [botId, grade],
  );
  return !!result;
}

export async function setBotStatus(botId: string, status: string, errorMessage?: string): Promise<void> {
  if (!(BOT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid bot status: ${status}`);
  }
  await query(
    'UPDATE bots SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3',
    [status, errorMessage || null, botId],
  );
}

export async function getDecryptedSchoolKey(botId: string): Promise<{ apiKey: string; handle: string; baseUrl: string } | null> {
  const bot = await queryOne<{
    school_api_key_encrypted: Buffer;
    school_api_key_iv: Buffer;
    school_agent_handle: string;
    base_url: string;
  }>(
    `SELECT b.school_api_key_encrypted, b.school_api_key_iv, b.school_agent_handle, s.base_url
     FROM bots b JOIN schools s ON s.id = b.school_id
     WHERE b.id = $1 AND b.school_api_key_encrypted IS NOT NULL`,
    [botId],
  );
  if (!bot) return null;

  const apiKey = decrypt(bot.school_api_key_encrypted, bot.school_api_key_iv);
  return { apiKey, handle: bot.school_agent_handle, baseUrl: bot.base_url };
}
