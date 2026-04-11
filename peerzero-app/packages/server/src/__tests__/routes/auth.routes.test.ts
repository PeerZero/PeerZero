import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Mock deps ───────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation';

vi.mock('../../config', () => ({
  config: {
    jwtSecret: process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation',
    jwtRefreshSecret: process.env.TEST_JWT_REFRESH_SECRET || 'test-jwt-refresh-secret',
    jwtExpiresIn: '5m',
    jwtRefreshExpiresIn: '30d',
    redisUrl: '',
    isDev: true,
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockRegisterUser = vi.fn();
const mockLoginUser = vi.fn();
const mockRefreshTokens = vi.fn();
const mockRevokeRefreshTokens = vi.fn();
const mockGetUserProfile = vi.fn();
const mockUpdateProfile = vi.fn();
const mockChangePassword = vi.fn();
const mockDeleteAccount = vi.fn();
const mockForgotPassword = vi.fn();
const mockResetPassword = vi.fn();
vi.mock('../../services/auth.service', () => ({
  registerUser: (...args: any[]) => mockRegisterUser(...args),
  loginUser: (...args: any[]) => mockLoginUser(...args),
  refreshTokens: (...args: any[]) => mockRefreshTokens(...args),
  revokeRefreshTokens: (...args: any[]) => mockRevokeRefreshTokens(...args),
  getUserProfile: (...args: any[]) => mockGetUserProfile(...args),
  updateProfile: (...args: any[]) => mockUpdateProfile(...args),
  changePassword: (...args: any[]) => mockChangePassword(...args),
  deleteAccount: (...args: any[]) => mockDeleteAccount(...args),
  forgotPassword: (...args: any[]) => mockForgotPassword(...args),
  resetPassword: (...args: any[]) => mockResetPassword(...args),
}));

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: vi.fn(),
}));

vi.mock('../../jobs/queue', () => ({
  removeBotJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/audit.service', () => ({
  logAudit: vi.fn(),
}));

// Mock express-rate-limit to be a passthrough (we test rate limiting separately)
vi.mock('express-rate-limit', () => ({
  default: vi.fn().mockImplementation(() => (req: any, res: any, next: any) => next()),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));

import jwt from 'jsonwebtoken';
import authRouter from '../../routes/auth';
import { errorHandler } from '../../middleware/error-handler';

// ── App setup ───────────────────────────────────────────────────────────────

let app: Express;

function makeToken(payload: { userId: string; email: string }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

beforeEach(() => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/auth/register').send({ password: 'longpassword' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email and password required/i);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email and password required/i);
  });

  it('returns 400 for invalid email format', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'not-an-email', password: 'longpassword' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid email/i);
  });

  it('returns 400 when password is too short', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'test@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8/i);
  });

  it('returns 201 with tokens for registration', async () => {
    mockRegisterUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'test@example.com' },
      tokens: { accessToken: 'at-123', refreshToken: 'rt-123' },
    });
    mockGetUserProfile.mockResolvedValueOnce({
      id: 'user-1', email: 'test@example.com', display_name: null,
    });

    const res = await request(app).post('/auth/register').send({
      email: 'test@example.com', password: 'longpassword',
    });

    expect(res.status).toBe(201);
    expect(res.body.access_token).toBe('at-123');
    expect(res.body.refresh_token).toBe('rt-123');
    expect(res.body.user).toBeDefined();
  });
});

describe('POST /auth/login', () => {
  it('returns 400 when email or password is missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email and password required/i);
  });

  it('returns tokens on successful login', async () => {
    mockLoginUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'test@example.com' },
      tokens: { accessToken: 'at-login', refreshToken: 'rt-login' },
    });
    mockGetUserProfile.mockResolvedValueOnce({
      id: 'user-1', email: 'test@example.com', display_name: 'Test',
    });

    const res = await request(app).post('/auth/login').send({
      email: 'test@example.com', password: 'longpassword',
    });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('at-login');
    expect(res.body.user.id).toBe('user-1');
  });
});

describe('POST /auth/forgot-password', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/auth/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email is required/i);
  });

  it('returns success message (does not reveal if account exists)', async () => {
    mockForgotPassword.mockResolvedValueOnce(undefined);

    const res = await request(app).post('/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });
});

describe('POST /auth/reset-password', () => {
  it('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/auth/reset-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*code.*new_password/i);
  });

  it('returns success on valid reset', async () => {
    mockResetPassword.mockResolvedValueOnce(undefined);

    const res = await request(app).post('/auth/reset-password').send({
      email: 'test@example.com', code: '123456', new_password: 'newlongpassword',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/password reset successfully/i);
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user profile with valid auth', async () => {
    mockGetUserProfile.mockResolvedValueOnce({
      id: 'user-1', email: 'test@example.com', display_name: 'TestUser',
    });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-1');
  });
});

describe('PATCH /auth/profile', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).patch('/auth/profile').send({ display_name: 'New' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when neither display_name nor language provided', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .patch('/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/display_name or language/i);
  });

  it('updates display_name and returns updated profile', async () => {
    mockUpdateProfile.mockResolvedValueOnce(undefined);
    mockGetUserProfile.mockResolvedValueOnce({
      id: 'user-1', email: 'test@example.com', display_name: 'UpdatedName',
    });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .patch('/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'UpdatedName' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('UpdatedName');
    expect(mockUpdateProfile).toHaveBeenCalledWith('user-1', 'UpdatedName', undefined);
  });
});

describe('DELETE /auth/account', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/auth/account');
    expect(res.status).toBe(401);
  });

  it('deletes account and returns success', async () => {
    mockQueryRows.mockResolvedValueOnce([]); // no bots
    mockDeleteAccount.mockResolvedValueOnce(undefined);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .delete('/auth/account')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeleteAccount).toHaveBeenCalledWith('user-1');
  });
});

describe('POST /auth/refresh', () => {
  it('returns 400 when refresh_token is missing', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refresh token required/i);
  });

  it('returns new token pair on success', async () => {
    mockRefreshTokens.mockResolvedValueOnce({
      accessToken: 'at-new', refreshToken: 'rt-new',
    });

    const res = await request(app).post('/auth/refresh').send({ refresh_token: 'rt-old' });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('at-new');
    expect(res.body.refresh_token).toBe('rt-new');
  });
});

describe('POST /auth/logout', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(401);
  });

  it('revokes tokens and returns success', async () => {
    mockRevokeRefreshTokens.mockResolvedValueOnce(undefined);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith('user-1');
  });
});

describe('PATCH /auth/password', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).patch('/auth/password').send({
      current_password: 'old', new_password: 'newpassword',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when fields are missing', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .patch('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'old' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current_password and new_password/i);
  });

  it('changes password and returns success', async () => {
    mockChangePassword.mockResolvedValueOnce(undefined);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .patch('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'oldpassword', new_password: 'newlongpassword' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
