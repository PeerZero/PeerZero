// =============================================================================
// Notification routes — push token registration + preference management
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as notificationService from '../services/notification.service';
import { DEFAULT_NOTIFICATION_PREFS, CHILD_NOTIFICATION_PREFS } from '@peerzero/shared';
import { queryOne } from '../db/client';

const router = Router();
router.use(requireAuth);

// Register a push token for the current user
router.post('/push-token', userRateLimit('write'), async (req: Request, res: Response) => {
  const { token, device_name } = req.body;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token required' });
    return;
  }
  await notificationService.registerPushToken(req.user!.userId, token, device_name);
  res.json({ success: true });
});

// Remove a push token (logout / unregister)
router.delete('/push-token', userRateLimit('write'), async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'token required' });
    return;
  }
  await notificationService.removePushToken(token);
  res.json({ success: true });
});

// Get notification preferences
router.get('/preferences', userRateLimit('read'), async (req: Request, res: Response) => {
  const saved = await notificationService.getNotificationPrefs(req.user!.userId);
  // COPPA: child accounts default to all notifications off
  const user = await queryOne<{ age_group: string }>('SELECT age_group FROM users WHERE id = $1', [req.user!.userId]);
  const defaults = user?.age_group === 'child' ? CHILD_NOTIFICATION_PREFS : DEFAULT_NOTIFICATION_PREFS;
  const preferences = { ...defaults, ...saved };
  res.json({ preferences });
});

// Update notification preferences (partial — only keys present are changed)
router.patch('/preferences', userRateLimit('write'), async (req: Request, res: Response) => {
  const { preferences } = req.body;
  if (!preferences || typeof preferences !== 'object') {
    res.status(400).json({ error: 'preferences object required' });
    return;
  }
  const updated = await notificationService.updateNotificationPrefs(req.user!.userId, preferences);
  const userRow = await queryOne<{ age_group: string }>('SELECT age_group FROM users WHERE id = $1', [req.user!.userId]);
  const defaults = userRow?.age_group === 'child' ? CHILD_NOTIFICATION_PREFS : DEFAULT_NOTIFICATION_PREFS;
  const merged = { ...defaults, ...updated };
  res.json({ preferences: merged });
});

export default router;
