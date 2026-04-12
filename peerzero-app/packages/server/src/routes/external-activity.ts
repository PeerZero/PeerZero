// =============================================================================
// External Activity — phone-home receiver for self-hosted bots (System 3)
//
// Self-hosted bots report their external platform actions here so users
// can watch them from the mobile app. Auth is by phone-home token, NOT JWT.
//
// Security:
//   - Phone-home tokens are scoped: write-only, cannot read or control
//   - Token is hashed (SHA-256) before storage — plaintext never persisted
//   - Rate limited per token hash (30 requests/minute)
//   - Payload size limited (summary: 500 chars, preview: 200 chars)
// =============================================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import IORedis from 'ioredis';
import { query, queryOne } from '../db/client';
import { config } from '../config';
import { logger } from '../lib/logger';
import { validateBody } from '../middleware/validate';
import { ExternalActivitySchema } from '../lib/schemas';
import { broadcastExternalActivity } from '../websocket/activity-stream';

const router = Router();

const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

// ── Redis connection (lazy, shared with rate-limit pattern) ─────────────────
let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 3 });
    redis.on('error', (err) => {
      logger.error({ err: err.message }, 'Phone-home rate-limit Redis error');
    });
  }
  return redis;
}

// ── In-memory fallback when Redis is unavailable ────────────────────────────
const fallbackBuckets = new Map<string, { count: number; resetAt: number }>();

function checkFallbackRateLimit(tokenHash: string): boolean {
  const now = Date.now();
  const bucket = fallbackBuckets.get(tokenHash);
  if (!bucket || now > bucket.resetAt) {
    fallbackBuckets.set(tokenHash, { count: 1, resetAt: now + RATE_WINDOW_SECONDS * 1000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

// Clean up expired fallback buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of fallbackBuckets) {
    if (now > bucket.resetAt) fallbackBuckets.delete(key);
  }
}, RATE_WINDOW_SECONDS * 1000);

// ── Redis sliding window rate limiter (same pattern as rate-limit.ts) ───────
async function checkPhoneHomeRateLimit(tokenHash: string): Promise<boolean> {
  const key = `rate:phonehome:${tokenHash}`;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_SECONDS * 1000;

  try {
    const r = getRedis();
    const pipeline = r.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    const results = await pipeline.exec();
    if (!results) return true;

    const count = (results[1]?.[1] as number) || 0;
    if (count >= RATE_LIMIT) return false;

    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    await r.zadd(key, now, member);
    await r.expire(key, RATE_WINDOW_SECONDS + 1);
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Phone-home rate-limit Redis failed, using in-memory fallback');
    return checkFallbackRateLimit(tokenHash);
  }
}

/** Graceful shutdown for phone-home rate limit Redis connection. */
export async function closePhoneHomeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

// POST /api/external-activity
// Auth: Bearer <phone-home-token>
router.post('/', validateBody(ExternalActivitySchema), async (req: Request, res: Response) => {
  // Extract phone-home token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing phone-home token' });
    return;
  }
  const token = authHeader.slice(7).trim();
  // Phone-home tokens are "pht_" + 64 hex chars = 68 chars total.
  // Accept 60-80 to allow for minor format evolution while rejecting junk.
  if (!token || token.length < 60 || token.length > 80 || !/^[a-z_0-9]+$/i.test(token)) {
    res.status(401).json({ error: 'Invalid token format' });
    return;
  }

  // Hash token for lookup
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (tokenHash.length !== 64) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // Rate limit (Redis sliding window with in-memory fallback)
  if (!(await checkPhoneHomeRateLimit(tokenHash))) {
    res.status(429).json({ error: 'Too many reports — slow down' });
    return;
  }

  // Look up bot by token hash — token auth only needs bot id + expiry (write-only scope)
  const bot = await queryOne<{ id: string; phone_home_token_expires_at: string | null }>(
    'SELECT id, phone_home_token_expires_at FROM bots WHERE phone_home_token_hash = $1',
    [tokenHash],
  );
  if (!bot) {
    res.status(401).json({ error: 'Invalid phone-home token' });
    return;
  }

  // Check token expiry
  if (bot.phone_home_token_expires_at && new Date(bot.phone_home_token_expires_at) < new Date()) {
    res.status(401).json({ error: 'Phone-home token expired. Generate a new one.' });
    return;
  }

  // Separate query for user_id (needed for WebSocket broadcast, not part of token auth)
  const owner = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM bots WHERE id = $1',
    [bot.id],
  );

  // Validate payload
  const { platform, action, summary, content_preview, skills_demonstrated, timestamp } = req.body;
  if (!platform || !action || !summary) {
    res.status(400).json({ error: 'platform, action, and summary required' });
    return;
  }

  // Sanitize and truncate
  const safePlatform = String(platform).slice(0, 100).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeAction = String(action).slice(0, 50).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safePlatform || !safeAction) {
    res.status(400).json({ error: 'platform and action must contain valid characters (a-z, 0-9, _ -)' });
    return;
  }
  const safeSummary = String(summary).slice(0, 500);
  const safePreview = content_preview ? String(content_preview).slice(0, 200) : null;
  const safeSkills = Array.isArray(skills_demonstrated)
    ? skills_demonstrated
        .filter((s: unknown) => typeof s === 'string')
        .slice(0, 10)
        .map((s: unknown) => String(s).slice(0, 50))
    : [];

  let botTimestamp: string | null = null;
  if (timestamp) {
    const parsed = new Date(timestamp);
    if (!isNaN(parsed.getTime())) {
      botTimestamp = parsed.toISOString();
    } else {
      logger.warn({ botId: bot.id, timestamp }, 'Invalid timestamp in phone-home report');
    }
  }

  // Insert
  await query(
    `INSERT INTO external_activity_log
       (bot_id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [bot.id, safePlatform, safeAction, safeSummary, safePreview, safeSkills, botTimestamp],
  );

  logger.debug({ botId: bot.id, platform: safePlatform, action: safeAction }, 'Phone-home report received');

  // Broadcast to connected WebSocket clients in real-time
  broadcastExternalActivity(bot.id, owner?.user_id || '', {
    platform: safePlatform,
    action: safeAction,
    summary: safeSummary,
    content_preview: safePreview,
    skills_demonstrated: safeSkills,
    bot_timestamp: botTimestamp,
    created_at: new Date().toISOString(),
  });

  res.status(201).json({ received: true });
});

export default router;
