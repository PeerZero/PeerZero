// =============================================================================
// API key routes — BYOK management (add, list, delete)
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as apiKeyService from '../services/api-key.service';
import { logAudit } from '../services/audit.service';

const router = Router();
router.use(requireAuth);

router.get('/', userRateLimit('read'), async (req: Request, res: Response) => {
  const keys = await apiKeyService.getUserApiKeys(req.user!.userId);
  res.json(keys);
});

const ALLOWED_PROVIDERS = ['anthropic', 'openai'] as const;

router.post('/', userRateLimit('write'), async (req: Request, res: Response) => {
  const { provider, label, key } = req.body;
  if (!provider || !label || !key) {
    res.status(400).json({ error: 'provider, label, and key required' });
    return;
  }
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${ALLOWED_PROVIDERS.join(', ')}` });
    return;
  }
  if (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 100) {
    res.status(400).json({ error: 'label must be 1-100 characters' });
    return;
  }
  if (typeof key !== 'string' || key.length < 20 || key.length > 256) {
    res.status(400).json({ error: 'key format invalid' });
    return;
  }
  const result = await apiKeyService.addApiKey(req.user!.userId, provider, label, key);
  logAudit({ userId: req.user!.userId, action: 'key.add', entityType: 'llm_api_key', entityId: result.id, metadata: { provider, label, fingerprint: result.key_fingerprint }, ipAddress: req.ip });
  res.status(201).json(result);
});

router.delete('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  await apiKeyService.deleteApiKey(req.user!.userId, req.params.id);
  logAudit({ userId: req.user!.userId, action: 'key.delete', entityType: 'llm_api_key', entityId: req.params.id, ipAddress: req.ip });
  res.json({ success: true });
});

export default router;
