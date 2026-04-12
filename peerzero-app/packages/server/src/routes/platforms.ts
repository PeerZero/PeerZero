// =============================================================================
// Platform routes — connect bots to external platforms, browse platform registry
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import { validateBody } from '../middleware/validate';
import { ConnectPlatformSchema, UpdatePlatformSchema } from '../lib/schemas';
import * as platformService from '../services/platform.service';
import * as botService from '../services/bot.service';
import { logAudit } from '../services/audit.service';

const router = Router();
router.use(requireAuth);

// List available platforms from the registry
router.get('/', userRateLimit('read'), async (_req: Request, res: Response) => {
  const platforms = await platformService.getAvailablePlatforms();
  res.json(platforms);
});

// List a bot's connected platforms
router.get('/bot/:id', userRateLimit('read'), async (req: Request, res: Response) => {
  const connections = await platformService.listPlatforms(req.params.id, req.user!.userId);
  res.json(connections);
});

// Connect a bot to a platform
router.post('/bot/:id', userRateLimit('write'), validateBody(ConnectPlatformSchema), async (req: Request, res: Response) => {
  const { platform_slug, api_key, config } = req.body;

  const connection = await platformService.connectPlatform(
    req.params.id,
    req.user!.userId,
    platform_slug,
    api_key,
    config,
  );
  logAudit({
    userId: req.user!.userId,
    action: 'platform.connect',
    entityType: 'bot_platform',
    entityId: connection.id,
    metadata: { botId: req.params.id, platform_slug },
    ipAddress: req.ip,
  });
  res.status(201).json(connection);
});

// Disconnect a bot from a platform
router.delete('/bot/:id/:platformId', userRateLimit('write'), async (req: Request, res: Response) => {
  await platformService.disconnectPlatform(req.params.id, req.user!.userId, req.params.platformId);
  logAudit({
    userId: req.user!.userId,
    action: 'platform.disconnect',
    entityType: 'bot_platform',
    entityId: req.params.platformId,
    metadata: { botId: req.params.id },
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

// Update a platform connection (pause/resume, change heartbeat)
router.patch('/bot/:id/:platformId', userRateLimit('write'), validateBody(UpdatePlatformSchema), async (req: Request, res: Response) => {
  await platformService.updatePlatform(req.params.id, req.user!.userId, req.params.platformId, req.body);
  logAudit({
    userId: req.user!.userId,
    action: 'platform.update',
    entityType: 'bot_platform',
    entityId: req.params.platformId,
    metadata: { botId: req.params.id, changes: req.body },
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

export default router;
