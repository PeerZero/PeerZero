import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-that-is-long-enough',
    jwtRefreshSecret: 'test-jwt-refresh-secret',
    jwtExpiresIn: '5m',
    jwtRefreshExpiresIn: '30d',
    redisUrl: '',
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
    })),
  };
});

vi.mock('../../services/email.service', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import {
  registerUser,
  loginUser,
  refreshTokens,
  revokeRefreshTokens,
  updateProfile,
  changePassword,
  deleteAccount,
  getUserProfile,
} from '../../services/auth.service';
import { AppError } from '../../middleware/error-handler';
import { config } from '../../config';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth.service', () => {
  // ── registerUser ────────────────────────────────────────────────────────
  describe('registerUser', () => {
    it('creates a user and returns tokens', async () => {
      // No existing user
      mockQueryOne.mockResolvedValueOnce(null);
      // INSERT returns the new user
      mockQueryOne.mockResolvedValueOnce({
        id: 'user-1', email: 'test@example.com', display_name: null, created_at: '2025-01-01',
      });
      // INSERT refresh token
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await registerUser('test@example.com', 'password123');

      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();

      // Verify JWT is valid
      const decoded = jwt.verify(result.tokens.accessToken, config.jwtSecret) as any;
      expect(decoded.userId).toBe('user-1');
      expect(decoded.email).toBe('test@example.com');
    });

    it('throws 409 if email already registered', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(registerUser('taken@example.com', 'password123'))
        .rejects.toThrow(/already registered/i);
    });

    it('throws 409 if display name is taken', async () => {
      // No existing email
      mockQueryOne.mockResolvedValueOnce(null);
      // Display name already taken
      mockQueryOne.mockResolvedValueOnce({ id: 'other-user' });

      await expect(registerUser('new@example.com', 'password123', 'TakenName'))
        .rejects.toThrow(/display name/i);
    });
  });

  // ── loginUser ───────────────────────────────────────────────────────────
  describe('loginUser', () => {
    it('returns user and tokens for valid credentials', async () => {
      const hash = await bcrypt.hash('correct-password', 4); // low rounds for speed
      mockQueryOne.mockResolvedValueOnce({
        id: 'user-1', email: 'test@example.com', password_hash: hash,
        display_name: 'Test', created_at: '2025-01-01',
      });
      // INSERT refresh token
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await loginUser('test@example.com', 'correct-password');
      expect(result.user.id).toBe('user-1');
      expect(result.tokens.accessToken).toBeTruthy();
    });

    it('throws 401 for non-existent email', async () => {
      mockQueryOne.mockResolvedValueOnce(null);

      await expect(loginUser('nobody@example.com', 'password'))
        .rejects.toThrow(/invalid email or password/i);
    });

    it('throws 401 for wrong password', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockQueryOne.mockResolvedValueOnce({
        id: 'user-1', email: 'test@example.com', password_hash: hash,
        display_name: null, created_at: '2025-01-01',
      });

      await expect(loginUser('test@example.com', 'wrong-password'))
        .rejects.toThrow(/invalid email or password/i);
    });
  });

  // ── refreshTokens ──────────────────────────────────────────────────────
  describe('refreshTokens', () => {
    it('issues new token pair for valid refresh token', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      // DELETE + RETURNING
      mockQueryOne.mockResolvedValueOnce({ id: 'rt-1', user_id: 'user-1', expires_at: futureDate });
      // SELECT email
      mockQueryOne.mockResolvedValueOnce({ email: 'test@example.com' });
      // INSERT new refresh token
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await refreshTokens('some-valid-refresh-token');
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it('throws 401 for invalid refresh token', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(refreshTokens('bad-token')).rejects.toThrow(/invalid refresh token/i);
    });

    it('throws 401 for expired refresh token', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      mockQueryOne.mockResolvedValueOnce({ id: 'rt-1', user_id: 'user-1', expires_at: pastDate });

      await expect(refreshTokens('expired-token')).rejects.toThrow(/expired/i);
    });
  });

  // ── revokeRefreshTokens ────────────────────────────────────────────────
  describe('revokeRefreshTokens', () => {
    it('deletes all refresh tokens for a user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await revokeRefreshTokens('user-1');
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM refresh_tokens WHERE user_id = $1',
        ['user-1'],
      );
    });
  });

  // ── updateProfile ──────────────────────────────────────────────────────
  describe('updateProfile', () => {
    it('updates display name', async () => {
      mockQueryOne.mockResolvedValueOnce(null); // no name conflict
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await updateProfile('user-1', 'NewName');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET display_name'),
        ['NewName', 'user-1'],
      );
    });

    it('throws 400 for empty display name', async () => {
      await expect(updateProfile('user-1', '')).rejects.toThrow(/cannot be empty/i);
    });

    it('throws 400 for display name over 100 chars', async () => {
      await expect(updateProfile('user-1', 'x'.repeat(101))).rejects.toThrow(/100 characters/i);
    });

    it('throws 409 for taken display name', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'other-user' });
      await expect(updateProfile('user-1', 'TakenName')).rejects.toThrow(/already taken/i);
    });
  });

  // ── changePassword ─────────────────────────────────────────────────────
  describe('changePassword', () => {
    it('changes password and revokes tokens', async () => {
      const hash = await bcrypt.hash('old-password', 4);
      // SELECT password_hash
      mockQueryOne.mockResolvedValueOnce({ password_hash: hash });
      // UPDATE password
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // DELETE refresh tokens
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await changePassword('user-1', 'old-password', 'new-password-long-enough');

      // Should have called UPDATE and DELETE
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('throws 400 for short new password', async () => {
      await expect(changePassword('user-1', 'old', 'short')).rejects.toThrow(/at least 8/i);
    });

    it('throws 401 for wrong current password', async () => {
      const hash = await bcrypt.hash('actual-password', 4);
      mockQueryOne.mockResolvedValueOnce({ password_hash: hash });

      await expect(changePassword('user-1', 'wrong-password', 'new-password-long'))
        .rejects.toThrow(/current password is incorrect/i);
    });

    it('throws 404 for non-existent user', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(changePassword('no-user', 'old', 'new-password-long'))
        .rejects.toThrow(/user not found/i);
    });
  });

  // ── deleteAccount ──────────────────────────────────────────────────────
  describe('deleteAccount', () => {
    it('deletes the user', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'user-1' });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await deleteAccount('user-1');
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM users WHERE id = $1',
        ['user-1'],
      );
    });

    it('throws 404 for non-existent user', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(deleteAccount('ghost')).rejects.toThrow(/user not found/i);
    });
  });

  // ── getUserProfile ─────────────────────────────────────────────────────
  describe('getUserProfile', () => {
    it('returns profile with entitlements', async () => {
      // SELECT user
      mockQueryOne.mockResolvedValueOnce({
        id: 'user-1', email: 'test@example.com', display_name: 'Test', created_at: '2025-01-01',
      });
      // SELECT entitlements
      mockQueryRows.mockResolvedValueOnce([
        { entitlement_type: 'bot_shell', quantity: 3 },
      ]);
      // SELECT bot count
      mockQueryOne.mockResolvedValueOnce({ count: 2 });
      // SELECT enrollments
      mockQueryRows.mockResolvedValueOnce([{ school_id: 'school-1' }]);

      const profile = await getUserProfile('user-1');
      expect(profile.entitlements.bot_slots).toBe(3);
      expect(profile.entitlements.bots_used).toBe(2);
      expect(profile.entitlements.school_enrollments).toEqual(['school-1']);
    });

    it('defaults to 1 bot slot when no entitlements', async () => {
      mockQueryOne.mockResolvedValueOnce({
        id: 'user-1', email: 'test@example.com', display_name: null, created_at: '2025-01-01',
      });
      mockQueryRows.mockResolvedValueOnce([]); // no entitlements
      mockQueryOne.mockResolvedValueOnce({ count: 0 });
      mockQueryRows.mockResolvedValueOnce([]); // no enrollments

      const profile = await getUserProfile('user-1');
      expect(profile.entitlements.bot_slots).toBe(1); // free slot
      expect(profile.entitlements.bots_used).toBe(0);
    });

    it('throws 404 for non-existent user', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(getUserProfile('ghost')).rejects.toThrow(/user not found/i);
    });
  });
});
