// =============================================================================
// Public bot profile routes — no authentication required
// User-facing only: these profiles are NEVER injected into bot prompts.
// =============================================================================

import { Router, Request, Response } from 'express';
import { getBotPublicProfile } from '../services/bot-public.service';

const router = Router();

// Get a public bot profile by slug
router.get('/:slug', async (req: Request, res: Response) => {
  const profile = await getBotPublicProfile(req.params.slug);
  if (!profile) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  res.json(profile);
});

export default router;
