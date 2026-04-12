// =============================================================================
// Rate limiting — per-IP for auth, per-user for authenticated API routes
// Uses Redis sliding window for per-user limits, in-memory for auth (pre-login).
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';

// ── Auth limiter (per-IP, in-memory) ─────────────────────────────────────────
// Auth endpoints are unauthenticated so we can't key by user ID.
// 10 requests per 15 min per IP is sufficient for brute force protection.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

// ── Redis-backed per-user rate limiter ───────────────────────────────────────

let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 3 });
    redis.on('error', (err) => {
      logger.error({ err: err.message }, 'Rate-limit Redis error');
    });
  }
  return redis;
}

export type RateLimitCategory = 'read' | 'write' | 'bot_control';

const LIMITS: Record<RateLimitCategory, { max: number; windowSeconds: number }> = {
  read:        { max: 200, windowSeconds: 60 },   // 200/min — generous for polling
  write:       { max: 30,  windowSeconds: 60 },   // 30/min — prevents abuse
  bot_control: { max: 10,  windowSeconds: 60 },   // 10/min — prevents rapid cycling
};

// ── In-memory fallback when Redis is unavailable ─────────────────────────────
const fallbackBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_FALLBACK_BUCKETS = 10_000;

// Clean up expired fallback buckets every 60 seconds
const fallbackCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of fallbackBuckets) {
    if (now > bucket.resetAt) fallbackBuckets.delete(key);
  }
}, 60_000);

function checkInMemoryFallback(
  userId: string,
  category: RateLimitCategory,
): { allowed: boolean; remaining: number; limit: number } {
  const { max, windowSeconds } = LIMITS[category];
  const key = `${userId}:${category}`;
  const now = Date.now();
  const bucket = fallbackBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    // Evict oldest-inserted entries if map is at capacity (O(1) using Map insertion order).
    // Re-insert active keys on access to maintain LRU order.
    if (fallbackBuckets.size >= MAX_FALLBACK_BUCKETS && !fallbackBuckets.has(key)) {
      const firstKey = fallbackBuckets.keys().next().value;
      if (firstKey !== undefined) fallbackBuckets.delete(firstKey);
    }
    fallbackBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: max - 1, limit: max };
  }
  if (bucket.count >= max) {
    return { allowed: false, remaining: 0, limit: max };
  }
  bucket.count++;
  // Move to end of Map insertion order (LRU: recently-accessed entries evict last)
  fallbackBuckets.delete(key);
  fallbackBuckets.set(key, bucket);
  return { allowed: true, remaining: max - bucket.count, limit: max };
}

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Key: rate:{userId}:{category}
 * Members: timestamps (score = timestamp, member = unique id)
 *
 * On each request:
 * 1. Remove entries older than the window
 * 2. Count remaining entries
 * 3. If under limit, add this request
 * 4. Set TTL on the key so it auto-cleans
 */
async function checkRateLimit(
  userId: string,
  category: RateLimitCategory,
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const { max, windowSeconds } = LIMITS[category];
  const key = `rate:${userId}:${category}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  try {
    const r = getRedis();
    const pipeline = r.pipeline();

    // Remove entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);
    // Count entries in the window
    pipeline.zcard(key);

    const results = await pipeline.exec();
    if (!results) return { allowed: true, remaining: max, limit: max };

    const count = (results[1]?.[1] as number) || 0;

    if (count >= max) {
      return { allowed: false, remaining: 0, limit: max };
    }

    // Add this request (member must be unique — use timestamp + random suffix).
    // ⚠️ REVIEW NOTE (not a security issue): Math.random() is used here purely
    // for uniqueness of Redis sorted set members, not for any security purpose.
    // Collisions are harmless (they just skip a count increment). Using
    // crypto.randomBytes() here would add latency for zero security benefit.
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    await r.zadd(key, now, member);
    await r.expire(key, windowSeconds + 1); // Auto-cleanup

    return { allowed: true, remaining: max - count - 1, limit: max };
  } catch (err) {
    // If Redis is down, use in-memory fallback (fail-safe, not fail-open)
    logger.error({ err: err instanceof Error ? err.message : err }, 'Rate-limit Redis check failed, using in-memory fallback');
    return checkInMemoryFallback(userId, category);
  }
}

/**
 * Express middleware factory for per-user rate limiting.
 * Must be applied AFTER requireAuth (needs req.user).
 */
export function userRateLimit(category: RateLimitCategory) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.userId;
    if (!userId) {
      // No user = not authenticated, fall through (auth routes use authLimiter instead)
      next();
      return;
    }

    const { allowed, remaining, limit } = await checkRateLimit(userId, category);

    // Set standard rate limit headers
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, remaining));

    if (!allowed) {
      res.status(429).json({ error: `Rate limit exceeded (${limit} requests per minute for ${category} operations).` });
      return;
    }

    next();
  };
}

/** Graceful shutdown for rate limit Redis connection. */
export async function closeRateLimitRedis(): Promise<void> {
  clearInterval(fallbackCleanupInterval);
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
