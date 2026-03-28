// =============================================================================
// Auth routes — register, login, refresh, logout, profile, password, account
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { registerUser, loginUser, refreshTokens, revokeRefreshTokens, getUserProfile, updateProfile, changePassword, deleteAccount, forgotPassword, resetPassword } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';
import { queryRows } from '../db/client';

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
  const { user, tokens } = await registerUser(email, password, display_name);
  const profile = await getUserProfile(user.id);
  res.status(201).json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, user: profile });
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

  // Clean up BullMQ jobs for all user's bots before cascade delete
  const bots = await queryRows<{ id: string }>('SELECT id FROM bots WHERE user_id = $1', [userId]);
  for (const bot of bots) {
    await removeBotJobs(bot.id);
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

export default router;
