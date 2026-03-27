// =============================================================================
// Widget routes — lightweight endpoints for home screen widgets & floating overlay
//
// Two auth modes:
//   1. Standard JWT (Bearer token) — used by in-app widget setup
//   2. Widget token (X-Widget-Token header) — long-lived, read-only, scoped to
//      widget data. Stored in App Group keychain (iOS) / EncryptedSharedPreferences
//      (Android). Never sent to any other endpoint.
//
// Security:
//   - Widget tokens are SHA-256 hashed in the DB (same pattern as phone-home tokens)
//   - Scoped read-only: cannot modify bot data, cannot access sensitive fields
//   - No API keys, profiles, or raw data in the response
//   - ETag support for conditional fetching (bandwidth-efficient)
//   - Rate limited to 60/min (widget refresh is typically every 15-30 min)
//
// Scalability:
//   - Single endpoint returns ALL bots (avoids N+1 for multi-bot users)
//   - Response is ~200-500 bytes per bot, very lightweight
//   - Lightweight DB query: one SELECT with a LEFT JOIN for school name
//   - ETag eliminates redundant data transfer
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { queryOne, queryRows, query } from '../db/client';
import { config } from '../config';
import { requireAuth, JwtPayload } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import { logAudit } from '../services/audit.service';
import { logger } from '../lib/logger';
import { credibilityToStage } from '@peerzero/shared';
import type { WidgetBotData, WidgetDataResponse, AvatarConfig, BotStatus, MoodType } from '@peerzero/shared';

const router = Router();

// ── Widget token auth middleware ──
// Checks X-Widget-Token header. If valid, attaches user to req.
// Falls through to 401 if invalid.
async function widgetTokenAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-widget-token'] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing widget token' });
    return;
  }

  // Constant-time hash comparison
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const row = await queryOne<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM widget_tokens WHERE token_hash = $1',
    [tokenHash],
  );

  if (!row) {
    res.status(401).json({ error: 'Invalid widget token' });
    return;
  }

  if (new Date(row.expires_at) < new Date()) {
    res.status(401).json({ error: 'Widget token expired' });
    return;
  }

  req.user = { userId: row.user_id, email: '' };
  next();
}

// ── Combined auth: JWT OR widget token ──
function jwtOrWidgetToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    // Try JWT auth
    const token = authHeader.slice(7);
    try {
      // SECURITY: Always specify algorithms to prevent JWT algorithm confusion attacks (CVE-2026-22817)
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
      req.user = payload;
      next();
      return;
    } catch (err) {
      // JWT verification failed — log before falling through to widget token check
      logger.warn({ err: err instanceof Error ? err.message : 'unknown', ip: req.ip }, 'Widget JWT auth failed, falling through to widget token');
    }
  }

  // Try widget token auth
  widgetTokenAuth(req, res, next);
}

// ── Generate widget token ──
// POST /api/widgets/token — requires JWT auth (in-app only)
// Returns a long-lived read-only token for widget use
router.post('/token', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Verify user has at least one active bot before issuing a widget token
  const botCount = await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int as count FROM bots WHERE user_id = $1 AND deleted_at IS NULL",
    [userId],
  );
  if (!botCount || botCount.count === 0) {
    res.status(400).json({ error: 'You need at least one bot to generate a widget token' });
    return;
  }

  // Generate cryptographically random token
  const token = `pwt_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  // Revoke any existing widget tokens for this user (one active token at a time)
  // Also prune expired tokens globally to prevent table bloat
  // Use allSettled: pruning expired tokens is best-effort and should not
  // block token generation if it fails independently.
  const cleanupResults = await Promise.allSettled([
    query('DELETE FROM widget_tokens WHERE user_id = $1', [userId]),
    query('DELETE FROM widget_tokens WHERE expires_at < NOW()'),
  ]);
  // The user's own token deletion must succeed for the new token to be valid
  if (cleanupResults[0].status === 'rejected') {
    res.status(500).json({ error: 'Failed to revoke existing widget token' });
    return;
  }

  // Store hashed token
  await query(
    'INSERT INTO widget_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt.toISOString()],
  );

  logAudit({
    userId,
    action: 'widget.token_generated',
    entityType: 'widget_token',
    entityId: userId,
    ipAddress: req.ip,
  });

  res.json({
    widget_token: token,
    expires_at: expiresAt.toISOString(),
  });
});

// ── Revoke widget token ──
// DELETE /api/widgets/token — requires JWT auth
router.delete('/token', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await query('DELETE FROM widget_tokens WHERE user_id = $1', [userId]);

  logAudit({
    userId,
    action: 'widget.token_revoked',
    entityType: 'widget_token',
    entityId: userId,
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

// ── Get widget data ──
// GET /api/widgets/data — JWT or widget token
// Returns compact bot data for all user's bots
router.get('/data', jwtOrWidgetToken, userRateLimit('read'), async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Lightweight query — only fields needed for widget display
  const rows = await queryRows<{
    id: string;
    name: string;
    avatar_config: Record<string, unknown>;
    status: string;
    cached_credibility: number | null;
    cached_grade: number | null;
    school_name: string | null;
    last_cycle_at: string | null;
    updated_at: string;
  }>(
    `SELECT b.id, b.name, b.avatar_config, b.status,
            b.cached_credibility, b.cached_grade,
            s.name as school_name, b.last_cycle_at, b.updated_at
     FROM bots b
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC`,
    [userId],
  );

  // Fetch latest activity headline for each bot (batch query)
  const botIds = rows.map(r => r.id);
  let activityMap: Record<string, { headline: string; mood: string }> = {};

  if (botIds.length > 0) {
    // Use DISTINCT ON to get the latest activity per bot in one query
    const activities = await queryRows<{
      bot_id: string;
      translated: { headline?: string; mood?: string };
    }>(
      `SELECT DISTINCT ON (bot_id) bot_id, translated
       FROM activity_log
       WHERE bot_id = ANY($1) AND deleted_at IS NULL AND category = 'task'
       ORDER BY bot_id, created_at DESC`,
      [botIds],
    );

    for (const a of activities) {
      activityMap[a.bot_id] = {
        headline: a.translated?.headline || 'No activity yet',
        mood: a.translated?.mood || 'neutral',
      };
    }
  }

  const bots: WidgetBotData[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    avatar_config: r.avatar_config as unknown as AvatarConfig,
    status: r.status as BotStatus,
    credibility: r.cached_credibility,
    tier: credibilityToStage(r.cached_credibility),
    grade: r.cached_grade,
    school_name: r.school_name,
    last_activity_headline: activityMap[r.id]?.headline || null,
    last_activity_mood: (activityMap[r.id]?.mood as MoodType) || null,
    last_cycle_at: r.last_cycle_at,
  }));

  const response: WidgetDataResponse = {
    bots,
    updated_at: new Date().toISOString(),
  };

  // ETag for conditional fetching — hash of the response content
  const etag = crypto
    .createHash('sha256')
    .update(JSON.stringify(response))
    .digest('hex');

  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('Cache-Control', 'private, max-age=60'); // 1 min cache

  if (req.headers['if-none-match'] === `"${etag}"`) {
    res.status(304).end();
    return;
  }

  res.json(response);
});

export default router;
