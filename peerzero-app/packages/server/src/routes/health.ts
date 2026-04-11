// =============================================================================
// Health check + metrics routes
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getPool, queryRows, queryOne } from '../db/client';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    await getPool().query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
  }
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

export default router;
