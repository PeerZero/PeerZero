// =============================================================================
// Auth routes — register, login, refresh, logout, profile, password, account
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { registerUser, loginUser, refreshTokens, revokeRefreshTokens, getUserProfile, updateProfile, changePassword, deleteAccount, forgotPassword, resetPassword } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';
import { queryRows, queryOne } from '../db/client';
import { logger } from '../lib/logger';

const router = Router();

// Auth limiter is applied at the router mount level in index.ts

// Stricter rate limit for token refresh to prevent token-cycling abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts. Try again later.' },
});

// Strict rate limit for password reset to prevent brute-force code guessing
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset attempts. Try again later.' },
});

router.post('/register', async (req: Request, res: Response) => {
  const { email, password, display_name } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email) || email.split('@')[1].length < 4) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const result = await registerUser(email, password, display_name);

  const profile = await getUserProfile(result.user.id);
  res.status(201).json({ access_token: result.tokens.accessToken, refresh_token: result.tokens.refreshToken, user: profile });
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }
  try {
    const { user, tokens } = await loginUser(email, password);
    logAudit({ userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ipAddress: req.ip });
    const profile = await getUserProfile(user.id);
    res.status(200).json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, user: profile });
  } catch (err) {
    // Log failed login attempts for security monitoring
    logAudit({ userId: 'unknown', action: 'auth.login_failed', entityType: 'user', entityId: 'unknown', metadata: { email }, ipAddress: req.ip });
    throw err;
  }
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  await forgotPassword(email);
  res.json({ message: 'If an account exists with that email, a reset code has been sent.' });
});

router.post('/reset-password', resetPasswordLimiter, async (req: Request, res: Response) => {
  const { email, code, new_password } = req.body;
  if (!email || !code || !new_password) {
    res.status(400).json({ error: 'email, code, and new_password are required' });
    return;
  }
  await resetPassword(email, code, new_password);
  res.json({ message: 'Password reset successfully' });
});

router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    res.status(400).json({ error: 'Refresh token required' });
    return;
  }
  const tokens = await refreshTokens(refresh_token);
  res.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
});

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  await revokeRefreshTokens(req.user!.userId);
  res.json({ success: true });
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const profile = await getUserProfile(req.user!.userId);
  res.json(profile);
});

// ── Profile Management ──

router.patch('/profile', requireAuth, async (req: Request, res: Response) => {
  const { display_name, language } = req.body;
  if (display_name === undefined && language === undefined) {
    res.status(400).json({ error: 'display_name or language required' });
    return;
  }
  await updateProfile(req.user!.userId, display_name, language);
  const profile = await getUserProfile(req.user!.userId);
  res.json(profile);
});

router.patch('/password', requireAuth, async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    res.status(400).json({ error: 'current_password and new_password required' });
    return;
  }
  await changePassword(req.user!.userId, current_password, new_password);
  logAudit({ userId: req.user!.userId, action: 'auth.password_change', entityType: 'user', entityId: req.user!.userId, ipAddress: req.ip });
  // Issue new tokens since all old refresh tokens were revoked
  res.json({ success: true, message: 'Password changed. Please log in again.' });
});

router.delete('/account', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Clean up BullMQ jobs and school agents for all user's bots before cascade delete
  const bots = await queryRows<{ id: string; school_agent_handle: string | null; base_url: string | null }>(
    `SELECT b.id, b.school_agent_handle, s.base_url
     FROM bots b LEFT JOIN schools s ON b.school_id = s.id
     WHERE b.user_id = $1`,
    [userId],
  );
  for (const bot of bots) {
    await removeBotJobs(bot.id);
    // Cross-system deletion: remove agent from School database (GDPR/COPPA erasure)
    if (bot.school_agent_handle && bot.base_url) {
      try {
        const { getSchoolAdapter } = await import('../adapters/adapter.factory');
        const adapter = getSchoolAdapter();
        await adapter.deleteAgent(bot.base_url, bot.school_agent_handle);
      } catch (err) {
        // Log but don't block — App data deletion is more important
        logger.error({ err: err instanceof Error ? err.message : err, handle: bot.school_agent_handle, baseUrl: bot.base_url }, 'Failed to delete school agent during account deletion — GDPR erasure incomplete');
      }
    }
  }

  logAudit({
    userId,
    action: 'account.delete',
    entityType: 'user',
    entityId: userId,
    metadata: { bots_deleted: bots.length, bot_ids: bots.map(b => b.id) },
    ipAddress: req.ip,
  });

  await deleteAccount(userId);
  res.json({ success: true });
});

// ── Data Export (GDPR Article 20 — data portability) ──

router.get('/export-data', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // User profile
  const user = await queryOne<Record<string, unknown>>(
    'SELECT id, email, display_name, language, created_at, updated_at FROM users WHERE id = $1',
    [userId],
  );

  // Bots (owned by user)
  const bots = await queryRows<Record<string, unknown>>(
    `SELECT id, name, mode, status, llm_model, fast_llm_model, extended_thinking, cycle_delay_seconds,
       cycle_count, cached_credibility, cached_grade, cached_next_action,
       school_agent_handle, is_public, public_slug, created_at, last_cycle_at
     FROM bots WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const botIds = bots.map(b => b.id as string);

  // Activity logs (school)
  const activityLog = botIds.length > 0 ? await queryRows<Record<string, unknown>>(
    `SELECT bot_id, cycle_number, action_type, translated, content_text, duration_ms, llm_tokens_used, created_at
     FROM activity_log WHERE bot_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000`,
    [botIds],
  ) : [];

  // Messages (chat feed)
  const messages = botIds.length > 0 ? await queryRows<Record<string, unknown>>(
    `SELECT bot_id, role, content, message_type, created_at
     FROM bot_messages WHERE bot_id = ANY($1) ORDER BY created_at DESC LIMIT 1000`,
    [botIds],
  ) : [];

  // External activity (platform)
  const externalActivity = botIds.length > 0 ? await queryRows<Record<string, unknown>>(
    `SELECT bot_id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp, created_at
     FROM external_activity_log WHERE bot_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000`,
    [botIds],
  ) : [];

  // Enrollments
  const enrollments = botIds.length > 0 ? await queryRows<Record<string, unknown>>(
    `SELECT bot_id, school_id, status, enrolled_at FROM enrollments WHERE bot_id = ANY($1)`,
    [botIds],
  ) : [];

  // Purchases
  const purchases = await queryRows<Record<string, unknown>>(
    `SELECT id, product_type, amount_cents, currency, status, created_at FROM purchases WHERE user_id = $1`,
    [userId],
  );

  // API keys (metadata only — never export actual keys)
  const apiKeys = await queryRows<Record<string, unknown>>(
    `SELECT id, provider, label, key_fingerprint, is_valid, created_at FROM llm_api_keys WHERE user_id = $1`,
    [userId],
  );

  // Notification preferences
  const notifPrefs = await queryOne<Record<string, unknown>>(
    'SELECT preferences FROM notification_preferences WHERE user_id = $1',
    [userId],
  );

  // Platform connections (metadata only — no credentials)
  const platforms = botIds.length > 0 ? await queryRows<Record<string, unknown>>(
    `SELECT id, bot_id, platform_name, adapter_type, status, heartbeat_interval_seconds, cycle_count, created_at
     FROM bot_platforms WHERE bot_id = ANY($1)`,
    [botIds],
  ) : [];

  // Audit log entries for this user
  const auditLog = await queryRows<Record<string, unknown>>(
    `SELECT action, entity_type, entity_id, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [userId],
  );

  logAudit({
    userId,
    action: 'data.export',
    entityType: 'user',
    entityId: userId,
    ipAddress: req.ip,
  });

  res.json({
    exported_at: new Date().toISOString(),
    user,
    bots,
    activity_log: activityLog,
    messages,
    external_activity: externalActivity,
    enrollments,
    purchases,
    api_keys: apiKeys,
    notification_preferences: notifPrefs?.preferences || null,
    platform_connections: platforms,
    audit_log: auditLog,
  });
});

export default router;
