// =============================================================================
// School routes — list available schools
// =============================================================================

import { Router, Request, Response } from 'express';
import * as schoolService from '../services/school.service';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const schools = await schoolService.listSchools();
  res.json(schools);
});

router.get('/:id', async (req: Request, res: Response) => {
  const school = await schoolService.getSchool(req.params.id);
  if (!school) {
    res.status(404).json({ error: 'School not found' });
    return;
  }
  res.json(school);
});

export default router;
