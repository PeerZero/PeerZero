// =============================================================================
// Public bot profile routes — no authentication required
// User-facing only: these profiles are NEVER injected into bot prompts.
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getBotPublicProfile } from '../services/bot-public.service';

const publicBotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

const router = Router();

// Get a public bot profile by slug
router.get('/:slug', publicBotLimiter, async (req: Request, res: Response) => {
  const profile = await getBotPublicProfile(req.params.slug);
  if (!profile) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  res.json(profile);
});

export default router;
