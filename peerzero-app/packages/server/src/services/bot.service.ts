// =============================================================================
// Bot service — CRUD for bot instances, enrollment, status management
// =============================================================================

import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import { encrypt, decrypt } from './encryption.service';
import { getSchoolAdapter } from '../adapters/adapter.factory';
import type { BotSummary, BotDetail } from '@peerzero/shared';

export async function createBot(
  userId: string,
  name: string,
  avatarConfig: Record<string, unknown>,
  llmApiKeyId: string,
  llmModel?: string,
) {
  // Verify the API key belongs to this user
  const key = await queryOne(
    'SELECT id FROM llm_api_keys WHERE id = $1 AND user_id = $2',
    [llmApiKeyId, userId],
  );
  if (!key) throw new AppError(400, 'Invalid API key');

  const bot = await queryOne<{ id: string }>(
    `INSERT INTO bots (user_id, name, avatar_config, llm_api_key_id, llm_model)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, name, JSON.stringify(avatarConfig), llmApiKeyId, llmModel || 'claude-opus-4-6'],
  );

  return bot!.id;
}

export async function getUserBots(userId: string): Promise<BotSummary[]> {
  return queryRows<BotSummary>(
    `SELECT b.id, b.name, b.avatar_config, b.status,
            b.cached_credibility, b.cached_grade, b.cached_tier,
            s.name as school_name, b.cycle_count, b.last_cycle_at
     FROM bots b
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC`,
    [userId],
  );
}

export async function getBotDetail(userId: string, botId: string): Promise<BotDetail> {
  const bot = await queryOne<BotDetail>(
    `SELECT b.id, b.name, b.avatar_config, b.status,
            b.cached_credibility, b.cached_grade, b.cached_tier,
            s.name as school_name, b.cycle_count, b.last_cycle_at,
            b.school_id, b.school_agent_handle, b.llm_api_key_id, b.llm_model,
            b.cycle_delay_seconds, b.cached_next_action, b.cached_profile,
            b.error_message, b.created_at
     FROM bots b
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE b.id = $1 AND b.user_id = $2`,
    [botId, userId],
  );
  if (!bot) throw new AppError(404, 'Bot not found');
  return bot;
}

export async function updateBot(userId: string, botId: string, updates: Partial<{
  name: string;
  avatar_config: Record<string, unknown>;
  llm_api_key_id: string;
  llm_model: string;
  cycle_delay_seconds: number;
}>) {
  // Build SET clause dynamically
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) { sets.push(`name = $${idx++}`); params.push(updates.name); }
  if (updates.avatar_config !== undefined) { sets.push(`avatar_config = $${idx++}`); params.push(JSON.stringify(updates.avatar_config)); }
  if (updates.llm_api_key_id !== undefined) { sets.push(`llm_api_key_id = $${idx++}`); params.push(updates.llm_api_key_id); }
  if (updates.llm_model !== undefined) { sets.push(`llm_model = $${idx++}`); params.push(updates.llm_model); }
  if (updates.cycle_delay_seconds !== undefined) { sets.push(`cycle_delay_seconds = $${idx++}`); params.push(updates.cycle_delay_seconds); }

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

  return { handle, schoolSlug: school.slug };
}

export async function setBotStatus(botId: string, status: string, errorMessage?: string): Promise<void> {
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
