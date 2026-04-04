import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

let isDev = true;

vi.mock('../../config', () => ({
  config: {
    get isDev() { return isDev; },
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AppError, errorHandler } from '../../middleware/error-handler';

beforeEach(() => {
  vi.clearAllMocks();
  isDev = true;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockReq() {
  return {} as any;
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

const mockNext = vi.fn();

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AppError', () => {
  it('creates an error with statusCode and message', () => {
    const err = new AppError(404, 'Not found');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('AppError');
    expect(err instanceof Error).toBe(true);
  });
});

describe('errorHandler middleware', () => {
  it('returns the AppError statusCode and sanitized message', () => {
    const err = new AppError(403, 'Forbidden action');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res._body).toEqual({ error: 'Forbidden action' });
  });

  it('returns 400 for an AppError with statusCode 400', () => {
    const err = new AppError(400, 'Bad request');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res._body).toEqual({ error: 'Bad request' });
  });

  it('returns 500 for a generic Error in dev mode (with sanitized message)', () => {
    isDev = true;
    const err = new Error('Something broke internally');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._body.error).toBe('Something broke internally');
  });

  it('returns 500 with generic message for a generic Error in production', () => {
    isDev = false;
    const err = new Error('Database connection pool exhausted');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
  });

  it('sanitizes API keys from error messages', () => {
    const err = new AppError(500, 'Failed to call api_key=sk-abc123xyz with secret=mysecretvalue');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res._body.error).not.toContain('sk-abc123xyz');
    expect(res._body.error).not.toContain('mysecretvalue');
    expect(res._body.error).toContain('[REDACTED]');
  });

  it('sanitizes Bearer tokens from error messages', () => {
    const err = new AppError(401, 'Auth failed with Bearer eyJhbGciOiJIUzI1NiJ9');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res._body.error).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(res._body.error).toContain('[REDACTED]');
  });

  it('sanitizes password values from error messages', () => {
    const err = new AppError(500, 'Error with password=hunter2 in query');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res._body.error).not.toContain('hunter2');
    expect(res._body.error).toContain('[REDACTED]');
  });

  it('sanitizes URLs with embedded credentials', () => {
    const err = new AppError(500, 'Cannot connect to https://user:secret@db.example.com/mydb');
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res._body.error).not.toContain('secret');
    expect(res._body.error).toContain('[REDACTED_URL]');
  });

  it('truncates very long error messages to 500 characters', () => {
    const longMsg = 'x'.repeat(1000);
    const err = new AppError(400, longMsg);
    const res = mockRes();

    errorHandler(err, mockReq(), res, mockNext);

    expect(res._body.error.length).toBeLessThanOrEqual(500);
  });

  it('handles unknown error types as 500', () => {
    // Simulate a thrown non-Error object (cast to Error for the handler)
    const weirdErr = { message: 'something weird', name: 'WeirdError' } as Error;
    const res = mockRes();

    errorHandler(weirdErr, mockReq(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
