import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  config: {
    redisUrl: '',
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock ioredis so the module never opens a real connection.
// We simulate Redis being unavailable so the in-memory fallback is exercised.
vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      pipeline: vi.fn().mockReturnValue({
        zremrangebyscore: vi.fn(),
        zcard: vi.fn(),
        exec: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      }),
      zadd: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      expire: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      quit: vi.fn().mockResolvedValue('OK'),
    })),
  };
});

// Mock express-rate-limit to return a passthrough middleware for authLimiter
vi.mock('express-rate-limit', () => ({
  default: vi.fn().mockImplementation((opts: any) => {
    // Store the options so tests can inspect them
    const middleware = (req: any, res: any, next: any) => next();
    Object.assign(middleware, { _opts: opts });
    return middleware;
  }),
}));

import { authLimiter, userRateLimit, type RateLimitCategory } from '../../middleware/rate-limit';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockReq(userId?: string) {
  return {
    user: userId ? { userId, email: `${userId}@test.com` } : undefined,
    headers: {},
    ip: '127.0.0.1',
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    _body: null as any,
    _headers: {} as Record<string, string | number>,
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res._body = body; return res; });
  res.setHeader = vi.fn((key: string, val: string | number) => { res._headers[key] = val; });
  return res;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('authLimiter', () => {
  it('is configured with 10 requests per 15 minutes', () => {
    // authLimiter is the result of express-rate-limit() with our mock
    const opts = (authLimiter as any)._opts;
    expect(opts.windowMs).toBe(15 * 60 * 1000);
    expect(opts.max).toBe(10);
  });

  it('calls next() for requests under the limit (mock passthrough)', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    (authLimiter as any)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('userRateLimit', () => {
  it('calls next() when no user is authenticated', async () => {
    const middleware = userRateLimit('read');
    const req = mockReq(); // no user
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows a read request and sets rate limit headers', async () => {
    const middleware = userRateLimit('read');
    const req = mockReq('user-read-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._headers['RateLimit-Limit']).toBe(200);
    expect(res._headers['RateLimit-Remaining']).toBeGreaterThanOrEqual(0);
  });

  it('allows a write request and sets rate limit headers', async () => {
    const middleware = userRateLimit('write');
    const req = mockReq('user-write-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._headers['RateLimit-Limit']).toBe(30);
  });

  it('allows a bot_control request and sets rate limit headers', async () => {
    const middleware = userRateLimit('bot_control');
    const req = mockReq('user-botctrl-1');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._headers['RateLimit-Limit']).toBe(10);
  });

  it('blocks after exceeding bot_control limit (10 requests)', async () => {
    const middleware = userRateLimit('bot_control');
    const userId = 'user-botctrl-flood';

    // Exhaust the 10-request limit
    for (let i = 0; i < 10; i++) {
      const req = mockReq(userId);
      const res = mockRes();
      const next = vi.fn();
      await middleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }

    // The 11th request should be blocked
    const req = mockReq(userId);
    const res = mockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res._body.error).toContain('Rate limit exceeded');
  });

  it('blocks after exceeding write limit (30 requests)', async () => {
    const middleware = userRateLimit('write');
    const userId = 'user-write-flood';

    // Exhaust the 30-request limit
    for (let i = 0; i < 30; i++) {
      const req = mockReq(userId);
      const res = mockRes();
      const next = vi.fn();
      await middleware(req, res, next);
    }

    // The 31st request should be blocked
    const req = mockReq(userId);
    const res = mockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('uses in-memory fallback when Redis is unavailable', async () => {
    // Redis is mocked to reject above, so this exercises the fallback path.
    // The fact that previous tests pass proves the fallback works.
    const middleware = userRateLimit('read');
    const req = mockReq('user-redis-fallback');
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    // The limit header should reflect the read category limit
    expect(res._headers['RateLimit-Limit']).toBe(200);
  });

  it('different users have independent rate limits', async () => {
    const middleware = userRateLimit('bot_control');

    // Exhaust user A's limit
    for (let i = 0; i < 10; i++) {
      const req = mockReq('user-A-independent');
      const res = mockRes();
      await middleware(req, res, vi.fn());
    }

    // User B should still be allowed
    const req = mockReq('user-B-independent');
    const res = mockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
