import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// ── Mock deps ───────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation';

vi.mock('../../config', () => ({
  config: {
    jwtSecret: process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation',
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requireAuth } from '../../middleware/auth';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockReq(headers: Record<string, string | undefined> = {}) {
  return {
    headers: { ...headers },
    path: '/test',
    ip: '127.0.0.1',
    user: undefined as any,
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    _body: null as any,
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res._body = body; return res; });
  return res;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('requireAuth middleware', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', () => {
    const req = mockReq({ authorization: 'Basic abc123' });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid JWT', () => {
    const req = mockReq({ authorization: 'Bearer not-a-real-jwt' });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired JWT', () => {
    const token = jwt.sign(
      { userId: 'user-1', email: 'test@example.com' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-10s' },
    );
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a JWT signed with the wrong secret', () => {
    const token = jwt.sign(
      { userId: 'user-1', email: 'test@example.com' },
      TEST_JWT_SECRET + '-wrong',
      { algorithm: 'HS256', expiresIn: '5m' },
    );
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.user and calls next() for a valid JWT', () => {
    const payload = { userId: 'user-1', email: 'test@example.com' };
    const token = jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe('user-1');
    expect(req.user.email).toBe('test@example.com');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 for empty Bearer token', () => {
    const req = mockReq({ authorization: 'Bearer ' });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    // Empty string after "Bearer " is still an invalid JWT
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
