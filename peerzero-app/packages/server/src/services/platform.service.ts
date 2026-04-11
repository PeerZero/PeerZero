// =============================================================================
// Platform service — CRUD for bot platform connections
// Manages encrypted credentials, platform registry, connection lifecycle.
// Same AES-256-GCM pattern as LLM API keys.
// =============================================================================

import crypto from 'crypto';
import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import { encrypt, decrypt } from './encryption.service';
import { logAudit } from './audit.service';
import { notifyPlatformConnected, notifyPlatformError } from './notification.service';
import { installStarterSkills } from './skill-engine.service';
import { logger } from '../lib/logger';
import type { BotPlatformConnection, PlatformRegistryEntry } from '@peerzero/shared';
import { MAX_PLATFORMS_PER_BOT } from '@peerzero/shared';

/** List all available platforms from the registry. */
export async function getAvailablePlatforms(): Promise<PlatformRegistryEntry[]> {
  return queryRows<PlatformRegistryEntry>(
    `SELECT id, slug, name, description, adapter_type, auth_type, icon_url, is_active
     FROM platform_registry
     WHERE is_active = true
     ORDER BY name
     LIMIT 100`,
  );
}

/** List a bot's connected platforms. */
export async function listPlatforms(botId: string, userId: string): Promise<BotPlatformConnection[]> {
  // Verify ownership
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  return queryRows<BotPlatformConnection>(
    `SELECT id, platform_name, adapter_type, status,
            heartbeat_interval_seconds, last_cycle_at, cycle_count,
            error_message, created_at
     FROM bot_platforms
     WHERE bot_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [botId],
  );
}

/** Connect a bot to a platform. */
export async function connectPlatform(
  botId: string,
  userId: string,
  platformSlug: string,
  apiKey: string,
  configOverrides?: Record<string, unknown>,
): Promise<BotPlatformConnection> {
  // Verify ownership
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  // Check platform limit
  const countResult = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM bot_platforms WHERE bot_id = $1',
    [botId],
  );
  if ((countResult?.count || 0) >= MAX_PLATFORMS_PER_BOT) {
    throw new AppError(400, `Maximum ${MAX_PLATFORMS_PER_BOT} platform connections per bot`);
  }

  // Look up platform registry for defaults
  const platform = await queryOne<{
    slug: string; name: string; adapter_type: string; default_config: Record<string, unknown>;
  }>(
    'SELECT slug, name, adapter_type, default_config FROM platform_registry WHERE slug = $1 AND is_active = true',
    [platformSlug],
  );
  if (!platform) throw new AppError(404, 'Platform not found');

  // Check not already connected
  const existing = await queryOne(
    'SELECT id FROM bot_platforms WHERE bot_id = $1 AND platform_name = $2',
    [botId, platform.slug],
  );
  if (existing) throw new AppError(409, 'Bot already connected to this platform');

  // Whitelist allowed config override keys and validate types
  const ALLOWED_CONFIG_OVERRIDES: Record<string, 'string' | 'number' | 'boolean'> = {
    base_url: 'string',
    heartbeat_interval: 'number',
    webhook_url: 'string',
    timeout_ms: 'number',
    retry_enabled: 'boolean',
  };

  if (configOverrides) {
    for (const [key, value] of Object.entries(configOverrides)) {
      if (!(key in ALLOWED_CONFIG_OVERRIDES)) {
        throw new AppError(400, `Config override key '${key}' is not allowed. Allowed keys: ${Object.keys(ALLOWED_CONFIG_OVERRIDES).join(', ')}`);
      }
      const expectedType = ALLOWED_CONFIG_OVERRIDES[key];
      if (typeof value !== expectedType) {
        throw new AppError(400, `Config override '${key}' must be of type ${expectedType}`);
      }
    }
  }

  // Encrypt credentials (same pattern as LLM keys)
  const { encrypted, iv, fingerprint } = encrypt(apiKey);

  // Merge config: defaults from registry + any overrides
  const config = { ...platform.default_config, ...configOverrides };
  const heartbeat = (config.heartbeat_interval as number) || 3600;

  const result = await queryOne<BotPlatformConnection>(
    `INSERT INTO bot_platforms (bot_id, platform_name, adapter_type, config, credentials, credentials_iv, credentials_fingerprint, heartbeat_interval_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, platform_name, adapter_type, status, heartbeat_interval_seconds, last_cycle_at, cycle_count, error_message, created_at`,
    [botId, platform.slug, platform.adapter_type, JSON.stringify(config), encrypted, iv, fingerprint, heartbeat],
  );

  logAudit({
    userId,
    action: 'platform.connect',
    entityType: 'bot',
    entityId: botId,
    metadata: { platform: platform.slug },
  });

  // Fire-and-forget notification (must have .catch to prevent unhandled rejection crash)
  const botRow = await queryOne<{ name: string }>('SELECT name FROM bots WHERE id = $1', [botId]);
  notifyPlatformConnected(userId, botId, botRow?.name || 'Your bot', platform.name).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err, botId, userId }, 'Failed to send platform connected notification');
  });

  // Install starter skills for the bot on its first platform connection.
  // These are "batteries included" — the average user never has to think about skills.
  try {
    await installStarterSkills(botId, userId, platformSlug);
  } catch (err) {
    // Starter skill installation failure is non-fatal
    logger.warn({ err: err instanceof Error ? err.message : err, botId, platformSlug }, 'Failed to install starter skills');
  }

  return result!;
}

/** Disconnect a bot from a platform. */
export async function disconnectPlatform(botId: string, userId: string, platformId: string): Promise<void> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const result = await query(
    'DELETE FROM bot_platforms WHERE id = $1 AND bot_id = $2',
    [platformId, botId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Platform connection not found');

  logAudit({
    userId,
    action: 'platform.disconnect',
    entityType: 'bot',
    entityId: botId,
    metadata: { platform_id: platformId },
  });
}

/** Update platform connection (pause/resume, change config). */
export async function updatePlatform(
  botId: string,
  userId: string,
  platformId: string,
  updates: Partial<{
    status: string;
    heartbeat_interval_seconds: number;
    config: Record<string, unknown>;
  }>,
): Promise<void> {
  const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  if (!bot) throw new AppError(404, 'Bot not found');

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    if (!['active', 'paused', 'disabled'].includes(updates.status)) {
      throw new AppError(400, 'Invalid status. Use: active, paused, disabled');
    }
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  if (updates.heartbeat_interval_seconds !== undefined) {
    const hb = updates.heartbeat_interval_seconds;
    if (hb < 60 || hb > 86400) throw new AppError(400, 'Heartbeat must be 60–86400 seconds');
    sets.push(`heartbeat_interval_seconds = $${idx++}`);
    params.push(hb);
  }
  if (updates.config !== undefined) {
    sets.push(`config = $${idx++}`);
    params.push(JSON.stringify(updates.config));
  }

  if (sets.length === 0) return;

  sets.push(`updated_at = NOW()`);
  params.push(platformId, botId);

  const result = await query(
    `UPDATE bot_platforms SET ${sets.join(', ')} WHERE id = $${idx++} AND bot_id = $${idx}`,
    params,
  );
  if (result.rowCount === 0) throw new AppError(404, 'Platform connection not found');
}

/** Update platform status from agent loop (no user auth check). */
export async function updatePlatformCycleStatus(
  platformId: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  await query(
    `UPDATE bot_platforms SET
       status = $1, error_message = $2,
       cycle_count = cycle_count + 1,
       last_cycle_at = NOW(),
       updated_at = NOW()
     WHERE id = $3`,
    [status, errorMessage || null, platformId],
  );

  // Notify user when platform is paused due to errors
  if (status === 'paused' && errorMessage) {
    const info = await queryOne<{ bot_id: string; platform_name: string }>(
      'SELECT bot_id, platform_name FROM bot_platforms WHERE id = $1',
      [platformId],
    );
    if (info) {
      const bot = await queryOne<{ user_id: string; name: string }>(
        'SELECT user_id, name FROM bots WHERE id = $1',
        [info.bot_id],
      );
      if (bot) {
        notifyPlatformError(bot.user_id, info.bot_id, bot.name, info.platform_name, errorMessage);
      }
    }
  }
}

/** Get decrypted platform credentials for the agent loop. */
export async function getPlatformCredentials(platformId: string): Promise<{
  apiKey: string;
  config: Record<string, unknown>;
  adapterType: string;
  platformName: string;
} | null> {
  const row = await queryOne<{
    credentials: Buffer;
    credentials_iv: Buffer;
    config: Record<string, unknown>;
    adapter_type: string;
    platform_name: string;
  }>(
    `SELECT credentials, credentials_iv, config, adapter_type, platform_name
     FROM bot_platforms WHERE id = $1 AND credentials IS NOT NULL`,
    [platformId],
  );
  if (!row) return null;

  const apiKey = decrypt(row.credentials, row.credentials_iv);
  return {
    apiKey,
    config: row.config,
    adapterType: row.adapter_type,
    platformName: row.platform_name,
  };
}

/** Get all active platform connections for a bot (used by agent loop). */
export async function getActivePlatforms(botId: string): Promise<Array<{
  id: string;
  platform_name: string;
  adapter_type: string;
  heartbeat_interval_seconds: number;
  last_cycle_at: string | null;
}>> {
  return queryRows(
    `SELECT id, platform_name, adapter_type, heartbeat_interval_seconds, last_cycle_at
     FROM bot_platforms
     WHERE bot_id = $1 AND status = 'active'`,
    [botId],
  );
}
