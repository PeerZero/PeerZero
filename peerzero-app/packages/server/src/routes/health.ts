// =============================================================================
// Health check route
// =============================================================================

import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    await getPool().query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
  }
});

export default router;
