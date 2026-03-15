// =============================================================================
// Auth routes — register, login, refresh, logout, profile, password, account
// =============================================================================

import { Router, Request, Response } from 'express';
import { registerUser, loginUser, refreshTokens, revokeRefreshTokens, getUserProfile, updateProfile, changePassword, deleteAccount } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';
import { queryRows } from '../db/client';

const router = Router();

// Auth limiter is applied at the router mount level in index.ts

router.post('/register', async (req: Request, res: Response) => {
  const { email, password, display_name } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
  const { user, tokens } = await loginUser(email, password);
  const profile = await getUserProfile(user.id);
  res.status(200).json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, user: profile });
});

router.post('/refresh', async (req: Request, res: Response) => {
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
  const { display_name } = req.body;
  if (display_name === undefined) {
    res.status(400).json({ error: 'display_name required' });
    return;
  }
  await updateProfile(req.user!.userId, display_name);
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
    ipAddress: req.ip,
  });

  await deleteAccount(userId);
  res.json({ success: true });
});

export default router;
