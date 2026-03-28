// =============================================================================
// Auth service — registration, login, JWT issuance, refresh token rotation
// =============================================================================

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import IORedis from 'ioredis';
import { config } from '../config';
import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import { JwtPayload } from '../middleware/auth';
import { logger } from '../lib/logger';
import { sendPasswordResetEmail } from './email.service';

const SALT_ROUNDS = 12;

// ── Redis-backed password reset codes ──
const RESET_CODE_TTL_SECONDS = 15 * 60; // 15 minutes

let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 3 });
    redis.on('error', (err) => {
      logger.error({ err: err.message }, 'Auth Redis error');
    });
  }
  return redis;
}

function resetCodeKey(email: string): string {
  return `reset:${email.toLowerCase()}`;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(email: string, password: string, displayName?: string) {
  // Check for existing user
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) throw new AppError(409, 'Email already registered');

  // Enforce unique display name (case-insensitive)
  if (displayName) {
    const nameTaken = await queryOne('SELECT id FROM users WHERE LOWER(display_name) = LOWER($1)', [displayName.trim()]);
    if (nameTaken) throw new AppError(409, 'Display name is already taken');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await queryOne<{ id: string; email: string; display_name: string | null; created_at: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName || null],
  );

  const tokens = await issueTokens(user!.id, user!.email);
  return { user: user!, tokens };
}

export async function loginUser(email: string, password: string) {
  const user = await queryOne<{ id: string; email: string; password_hash: string; display_name: string | null; created_at: string }>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1',
    [email],
  );
  if (!user) throw new AppError(401, 'Invalid email or password');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AppError(401, 'Invalid email or password');

  const tokens = await issueTokens(user.id, user.email);
  return {
    user: { id: user.id, email: user.email, display_name: user.display_name, created_at: user.created_at },
    tokens,
  };
}

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const tokenHash = hashToken(refreshToken);

  // Atomic delete-and-return prevents race conditions where two concurrent
  // refresh requests could both consume the same token.
  const stored = await queryOne<{ id: string; user_id: string; expires_at: string }>(
    'DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING id, user_id, expires_at',
    [tokenHash],
  );
  if (!stored) throw new AppError(401, 'Invalid refresh token');
  if (new Date(stored.expires_at) < new Date()) {
    throw new AppError(401, 'Refresh token expired');
  }

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [stored.user_id]);
  if (!user) throw new AppError(401, 'User not found');

  return issueTokens(stored.user_id, user.email);
}

export async function revokeRefreshTokens(userId: string): Promise<void> {
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

async function issueTokens(userId: string, email: string): Promise<TokenPair> {
  const payload: JwtPayload = { userId, email };

  const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

  // Generate opaque refresh token, store hash
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  );

  return { accessToken, refreshToken };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'pt', 'it', 'ru', 'ar', 'hi'];

export async function updateProfile(userId: string, displayName?: string, language?: string): Promise<void> {
  if (displayName !== undefined) {
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw new AppError(400, 'Display name cannot be empty');
    }
    if (displayName.length > 100) {
      throw new AppError(400, 'Display name must be 100 characters or less');
    }
    // Enforce unique display name (case-insensitive, excluding current user)
    const nameTaken = await queryOne('SELECT id FROM users WHERE LOWER(display_name) = LOWER($1) AND id != $2', [displayName.trim(), userId]);
    if (nameTaken) throw new AppError(409, 'Display name is already taken');

    await query('UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2', [displayName.trim(), userId]);
  }

  if (language !== undefined) {
    if (typeof language !== 'string' || !SUPPORTED_LANGUAGES.includes(language)) {
      throw new AppError(400, `Unsupported language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}`);
    }
    await query('UPDATE users SET language = $1, updated_at = NOW() WHERE id = $2', [language, userId]);
  }
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new AppError(400, 'New password must be at least 8 characters');
  }

  const user = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(404, 'User not found');

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) throw new AppError(401, 'Current password is incorrect');

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, userId]);

  // Revoke all refresh tokens — force re-login on all devices
  await revokeRefreshTokens(userId);
}

export async function deleteAccount(userId: string): Promise<void> {
  // Verify user exists
  const user = await queryOne('SELECT id FROM users WHERE id = $1', [userId]);
  if (!user) throw new AppError(404, 'User not found');

  // ON DELETE CASCADE handles: bots, keys, tokens, entitlements, purchases, push_tokens, notification_prefs
  // BullMQ jobs must be cleaned up by the caller before invoking this.
  await query('DELETE FROM users WHERE id = $1', [userId]);
}

export async function forgotPassword(email: string): Promise<void> {
  // Check if user exists (but don't reveal this to the caller)
  const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (user) {
    const code = crypto.randomBytes(8).toString('hex'); // 16-char hex code (64 bits entropy)
    // Hash the code before storing — even Redis compromise won't leak usable codes
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const r = getRedis();
    await r.set(resetCodeKey(email), codeHash, 'EX', RESET_CODE_TTL_SECONDS);
    // Send code via email (fire-and-forget — don't block the response)
    sendPasswordResetEmail(email, code).catch(() => {});
  }
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new AppError(400, 'New password must be at least 8 characters');
  }

  const r = getRedis();
  const storedHash = await r.get(resetCodeKey(email));
  if (!storedHash) {
    throw new AppError(400, 'Invalid or expired reset code');
  }

  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(codeHash, 'hex'))) {
    throw new AppError(400, 'Invalid or expired reset code');
  }

  const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!user) throw new AppError(400, 'Invalid or expired reset code');

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, user.id]);

  // Revoke all refresh tokens — force re-login on all devices
  await revokeRefreshTokens(user.id);

  // Clear the reset code
  await r.del(resetCodeKey(email));
}

export async function getUserProfile(userId: string) {
  const user = await queryOne<{ id: string; email: string; display_name: string | null; language: string; created_at: string }>(
    'SELECT id, email, display_name, language, created_at FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(404, 'User not found');

  // Compute entitlements
  const entitlements = await queryRows<{ entitlement_type: string; quantity: number }>(
    'SELECT entitlement_type, SUM(quantity)::int as quantity FROM user_entitlements WHERE user_id = $1 GROUP BY entitlement_type',
    [userId],
  );

  const botSlots = entitlements.find(e => e.entitlement_type === 'bot_shell')?.quantity || 1; // 1 free slot
  const botCount = await queryOne<{ count: number }>('SELECT COUNT(*)::int as count FROM bots WHERE user_id = $1', [userId]);

  const enrollments = await queryRows<{ school_id: string }>(
    `SELECT DISTINCT e.school_id FROM enrollments e
     JOIN bots b ON b.id = e.bot_id
     WHERE b.user_id = $1 AND e.status IN ('active', 'intake_passed', 'registered')`,
    [userId],
  );

  return {
    ...user,
    entitlements: {
      bot_slots: botSlots,
      bots_used: botCount?.count || 0,
      school_enrollments: enrollments.map(e => e.school_id),
    },
  };
}

export async function closeAuthRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
