// =============================================================================
// Health check + metrics routes
// =============================================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import IORedis from 'ioredis';
import { getPool, queryRows, queryOne, query } from '../db/client';
import { config } from '../config';
import { logger } from '../lib/logger';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = { database: 'unknown', redis: 'unknown' };
  let healthy = true;

  // Check database
  try {
    await getPool().query('SELECT 1');
    checks.database = 'ok';
  } catch {
    checks.database = 'unhealthy';
    healthy = false;
  }

  // Check Redis (optional — skip if not configured)
  if (config.redisUrl) {
    try {
      const redis = new IORedis(config.redisUrl, { lazyConnect: true, connectTimeout: 3000 });
      await redis.connect();
      await redis.ping();
      checks.redis = 'ok';
      await redis.quit();
    } catch {
      checks.redis = 'unhealthy';
      healthy = false;
    }
  } else {
    checks.redis = 'not_configured';
  }

  const status = healthy ? 200 : 503;
  res.status(status).json({ status: healthy ? 'ok' : 'unhealthy', timestamp: new Date().toISOString(), checks });
});

// Rate limit metrics endpoint to prevent abuse (10 requests per minute per IP)
const metricsLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many metrics requests' },
});

/**
 * GET /health/metrics — operational metrics aggregated from existing tables.
 * Useful for dashboards, alerting, and understanding system behavior.
 * Rate-limited to prevent enumeration/abuse. No PII exposed.
 */
router.get('/metrics', metricsLimiter, async (_req: Request, res: Response) => {
  const pool = getPool();

  // Run all queries in parallel for speed
  const [bots, cycles24h, errors24h, tokenUsage, actionBreakdown, avgCycleDuration] = await Promise.all([
    // Active bots by status
    queryRows<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int as count FROM bots GROUP BY status`,
    ),

    // Total cycles in last 24h
    queryOne<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM activity_log WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),

    // Errors in last 24h
    queryOne<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM activity_log WHERE error IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'`,
    ),

    // Token usage last 24h
    queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(llm_tokens_used), 0)::int as total FROM activity_log WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),

    // Action type breakdown last 24h
    queryRows<{ action_type: string; count: number }>(
      `SELECT action_type, COUNT(*)::int as count FROM activity_log WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY action_type ORDER BY count DESC`,
    ),

    // Average cycle duration last 24h
    queryOne<{ avg_ms: number }>(
      `SELECT COALESCE(AVG(duration_ms), 0)::int as avg_ms FROM activity_log WHERE duration_ms IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);

  // Shape bot counts into an object
  const botsByStatus: Record<string, number> = {};
  for (const row of bots) {
    botsByStatus[row.status] = row.count;
  }

  res.json({
    timestamp: new Date().toISOString(),
    bots: botsByStatus,
    last_24h: {
      total_cycles: cycles24h?.count || 0,
      errors: errors24h?.count || 0,
      error_rate: cycles24h?.count
        ? parseFloat(((errors24h?.count || 0) / cycles24h.count * 100).toFixed(2))
        : 0,
      llm_tokens_used: tokenUsage?.total || 0,
      avg_cycle_duration_ms: avgCycleDuration?.avg_ms || 0,
      actions: actionBreakdown,
    },
  });
});

// Rate limit emergency stop to prevent brute-force on admin key (5 attempts per hour)
const emergencyStopLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts' },
});

/**
 * POST /health/emergency-stop — Kill switch: stop ALL running bots immediately.
 * Protected by ADMIN_SECRET env var (X-Admin-Key header).
 * Rate-limited to 5 attempts/hour to prevent brute-force.
 * Use when: bad deployment, runaway costs, or system-wide incident.
 */
router.post('/emergency-stop', emergencyStopLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const adminKey = req.headers['x-admin-key'];

  if (!adminSecret || !adminKey || typeof adminKey !== 'string'
    || adminKey.length !== adminSecret.length
    || !crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(adminSecret))) {
    return res.status(401).json({ error: 'Unauthorized — X-Admin-Key required' });
  }

  try {
    const result = await query(
      `UPDATE bots SET status = 'stopped', updated_at = NOW()
       WHERE status = 'running' AND deleted_at IS NULL
       RETURNING id`,
    );
    const stoppedCount = result.rows?.length || 0;
    logger.warn({ stoppedCount, triggeredBy: 'admin' }, 'EMERGENCY STOP: All running bots stopped');
    res.json({ stopped: stoppedCount, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, 'Emergency stop failed');
    res.status(500).json({ error: 'Emergency stop failed' });
  }
});

export default router;
