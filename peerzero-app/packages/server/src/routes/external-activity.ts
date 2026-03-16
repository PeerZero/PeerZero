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
import { query, queryOne } from '../db/client';
import { logger } from '../lib/logger';
import { broadcastExternalActivity } from '../websocket/activity-stream';

const router = Router();

// Rate limit state (in-memory, per-process)
// TODO: Move to Redis for multi-instance deployments
const tokenBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// Periodically clean up expired buckets to prevent memory leak from cycled tokens
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of tokenBuckets) {
    if (now > bucket.resetAt) tokenBuckets.delete(key);
  }
}, RATE_WINDOW_MS);

function checkPhoneHomeRateLimit(tokenHash: string): boolean {
  const now = Date.now();
  const bucket = tokenBuckets.get(tokenHash);
  if (!bucket || now > bucket.resetAt) {
    tokenBuckets.set(tokenHash, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

// POST /api/external-activity
// Auth: Bearer <phone-home-token>
router.post('/', async (req: Request, res: Response) => {
  // Extract phone-home token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing phone-home token' });
    return;
  }
  const token = authHeader.slice(7).trim();
  if (!token || token.length < 32 || token.length > 256) {
    res.status(401).json({ error: 'Invalid token format' });
    return;
  }

  // Hash token for lookup
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (tokenHash.length !== 64) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // Rate limit
  if (!checkPhoneHomeRateLimit(tokenHash)) {
    res.status(429).json({ error: 'Too many reports — slow down' });
    return;
  }

  // Look up bot by token hash (include user_id for WebSocket broadcast)
  const bot = await queryOne<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM bots WHERE phone_home_token_hash = $1',
    [tokenHash],
  );
  if (!bot) {
    res.status(401).json({ error: 'Invalid phone-home token' });
    return;
  }

  // Validate payload
  const { platform, action, summary, content_preview, skills_demonstrated, timestamp } = req.body;
  if (!platform || !action || !summary) {
    res.status(400).json({ error: 'platform, action, and summary required' });
    return;
  }

  // Sanitize and truncate
  const safePlatform = String(platform).slice(0, 100).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeAction = String(action).slice(0, 50).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeSummary = String(summary).slice(0, 500);
  const safePreview = content_preview ? String(content_preview).slice(0, 200) : null;
  const safeSkills = Array.isArray(skills_demonstrated)
    ? skills_demonstrated.slice(0, 10).map((s: unknown) => String(s).slice(0, 50))
    : [];

  let botTimestamp: string | null = null;
  if (timestamp) {
    const parsed = new Date(timestamp);
    if (!isNaN(parsed.getTime())) {
      botTimestamp = parsed.toISOString();
    } else {
      logger.warn({ botId: bot?.id, timestamp }, 'Invalid timestamp in phone-home report');
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
  broadcastExternalActivity(bot.id, bot.user_id, {
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
