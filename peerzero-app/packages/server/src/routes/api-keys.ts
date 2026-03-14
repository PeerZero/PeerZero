// =============================================================================
// API key routes — BYOK management (add, list, delete)
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as apiKeyService from '../services/apikey.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  const keys = await apiKeyService.getUserApiKeys(req.user!.userId);
  res.json(keys);
});

router.post('/', async (req: Request, res: Response) => {
  const { provider, label, key } = req.body;
  if (!provider || !label || !key) {
    res.status(400).json({ error: 'provider, label, and key required' });
    return;
  }
  const result = await apiKeyService.addApiKey(req.user!.userId, provider, label, key);
  res.status(201).json(result);
});

router.delete('/:id', async (req: Request, res: Response) => {
  await apiKeyService.deleteApiKey(req.user!.userId, req.params.id);
  res.json({ success: true });
});

export default router;
