// =============================================================================
// API key routes — BYOK management (add, list, delete)
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as apiKeyService from '../services/apikey.service';
import { logAudit } from '../services/audit.service';

const router = Router();
router.use(requireAuth);

router.get('/', userRateLimit('read'), async (req: Request, res: Response) => {
  const keys = await apiKeyService.getUserApiKeys(req.user!.userId);
  res.json(keys);
});

router.post('/', userRateLimit('write'), async (req: Request, res: Response) => {
  const { provider, label, key } = req.body;
  if (!provider || !label || !key) {
    res.status(400).json({ error: 'provider, label, and key required' });
    return;
  }
  const result = await apiKeyService.addApiKey(req.user!.userId, provider, label, key);
  logAudit({ userId: req.user!.userId, action: 'key.add', entityType: 'llm_api_key', entityId: result.id, metadata: { provider, label, fingerprint: result.fingerprint }, ipAddress: req.ip });
  res.status(201).json(result);
});

router.delete('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  await apiKeyService.deleteApiKey(req.user!.userId, req.params.id);
  logAudit({ userId: req.user!.userId, action: 'key.delete', entityType: 'llm_api_key', entityId: req.params.id, ipAddress: req.ip });
  res.json({ success: true });
});

export default router;
