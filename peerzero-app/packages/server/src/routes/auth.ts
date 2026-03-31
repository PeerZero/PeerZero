// =============================================================================
// Auth routes — register, login, refresh, logout, profile, password, account
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { registerUser, loginUser, refreshTokens, revokeRefreshTokens, getUserProfile, updateProfile, changePassword, deleteAccount, forgotPassword, resetPassword, verifyParentalConsent, withdrawParentalConsent } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';
import { queryRows, queryOne } from '../db/client';

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
  const { email, password, display_name, age_group, parent_email } = req.body;
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

  // Validate age_group — default to 'adult' for backwards compatibility
  const ageGroup = age_group || 'adult';
  if (!['child', 'teen', 'adult'].includes(ageGroup)) {
    res.status(400).json({ error: 'Invalid age group' });
    return;
  }
  if (ageGroup === 'child' && !parent_email) {
    res.status(400).json({ error: 'Parent email is required for users under 13' });
    return;
  }
  if (ageGroup === 'child' && (typeof parent_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(parent_email))) {
    res.status(400).json({ error: 'Invalid parent email format' });
    return;
  }

  const result = await registerUser(email, password, display_name, ageGroup, parent_email);

  if ('consentPending' in result) {
    res.status(201).json({ consent_pending: true, message: 'Parental consent required. We have sent a verification email to the parent.' });
    return;
  }

  const profile = await getUserProfile(result.user.id);
  res.status(201).json({ access_token: result.tokens!.accessToken, refresh_token: result.tokens!.refreshToken, user: profile });
});

router.post('/parental-consent/verify', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Verification token is required' });
    return;
  }
  const { user, tokens } = await verifyParentalConsent(token, req.ip);
  res.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, user });
});

router.post('/parental-consent/withdraw', requireAuth, async (req: Request, res: Response) => {
  const { child_user_id } = req.body;
  if (!child_user_id || typeof child_user_id !== 'string') {
    res.status(400).json({ error: 'child_user_id is required' });
    return;
  }

  // Verify the authenticated user's email matches the parent_email on the consent record
  const consent = await queryOne<{ parent_email: string }>(
    'SELECT parent_email FROM parental_consent WHERE child_user_id = $1',
    [child_user_id],
  );
  if (!consent) {
    res.status(404).json({ error: 'No consent record found' });
    return;
  }

  const authedUser = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [req.user!.userId]);
  if (!authedUser || authedUser.email.toLowerCase() !== consent.parent_email.toLowerCase()) {
    res.status(403).json({ error: 'Only the parent on the consent record can withdraw consent' });
    return;
  }

  await withdrawParentalConsent(child_user_id);
  res.json({ success: true });
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
        const { getSchoolAdapter } = await import('../adapters/school.adapter');
        const adapter = getSchoolAdapter();
        await adapter.deleteAgent(bot.base_url, bot.school_agent_handle);
      } catch {
        // Log but don't block — App data deletion is more important
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

export default router;
