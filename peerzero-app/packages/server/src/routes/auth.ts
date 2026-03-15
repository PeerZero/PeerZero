// =============================================================================
// Auth routes — register, login, refresh, logout
// =============================================================================

import { Router, Request, Response } from 'express';
import { registerUser, loginUser, refreshTokens, revokeRefreshTokens, getUserProfile } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';

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

export default router;
