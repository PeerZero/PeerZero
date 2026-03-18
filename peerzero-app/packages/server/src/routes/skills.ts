// =============================================================================
// Skill routes — CRUD for bot skills + LLM-driven skill acquisition
//
// Skills are the mobility package: natural language behavior directives that
// shape what a bot does on platforms, filtered through its School-formed identity.
//
// Endpoints:
//   GET    /api/skills/bot/:id          — List all skills for a bot
//   POST   /api/skills/bot/:id          — Create a skill manually
//   PATCH  /api/skills/bot/:id/:skillId — Update a skill
//   DELETE /api/skills/bot/:id/:skillId — Delete a skill
//   POST   /api/skills/bot/:id/acquire  — LLM generates a skill from plain English
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as skillEngine from '../services/skill-engine.service';
import { acquireSkill } from '../services/skill-acquisition.service';
import { logAudit } from '../services/audit.service';

const router = Router();
router.use(requireAuth);

// List all skills for a bot
router.get('/bot/:id', userRateLimit('read'), async (req: Request, res: Response) => {
  try {
    const skills = await skillEngine.listSkills(req.params.id, req.user!.userId);
    res.json(skills);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg === 'Bot not found') { res.status(404).json({ error: msg }); return; }
    res.status(500).json({ error: msg });
  }
});

// Create a skill manually
router.post('/bot/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  const { name, instruction, trigger, priority, category } = req.body;
  if (!name || !instruction) {
    res.status(400).json({ error: 'name and instruction required' });
    return;
  }

  try {
    const skill = await skillEngine.createSkill(
      req.params.id,
      req.user!.userId,
      name,
      instruction,
      trigger,
      priority,
      category,
      'user',
    );

    logAudit({
      userId: req.user!.userId,
      action: 'skill.create',
      entityType: 'bot',
      entityId: req.params.id,
      metadata: { skill_name: name, source: 'user' },
    });

    res.status(201).json(skill);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg === 'Bot not found') { res.status(404).json({ error: msg }); return; }
    if (msg.includes('Maximum')) { res.status(400).json({ error: msg }); return; }
    res.status(400).json({ error: msg });
  }
});

// Update a skill
router.patch('/bot/:id/:skillId', userRateLimit('write'), async (req: Request, res: Response) => {
  try {
    await skillEngine.updateSkill(req.params.skillId, req.params.id, req.user!.userId, req.body);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg === 'Bot not found' || msg === 'Skill not found') { res.status(404).json({ error: msg }); return; }
    res.status(400).json({ error: msg });
  }
});

// Delete a skill
router.delete('/bot/:id/:skillId', userRateLimit('write'), async (req: Request, res: Response) => {
  try {
    await skillEngine.deleteSkill(req.params.skillId, req.params.id, req.user!.userId);

    logAudit({
      userId: req.user!.userId,
      action: 'skill.delete',
      entityType: 'bot',
      entityId: req.params.id,
      metadata: { skill_id: req.params.skillId },
    });

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg === 'Bot not found' || msg === 'Skill not found') { res.status(404).json({ error: msg }); return; }
    res.status(500).json({ error: msg });
  }
});

// Acquire a skill via LLM — the "easy button"
// User says: "I want my bot to summarize long threads"
// LLM generates: { name, instruction, trigger, priority }
// Skill is created and immediately active
router.post('/bot/:id/acquire', userRateLimit('write'), async (req: Request, res: Response) => {
  const { description } = req.body;
  if (!description || typeof description !== 'string') {
    res.status(400).json({ error: 'description required — tell us what you want your bot to do' });
    return;
  }
  if (description.length > 500) {
    res.status(400).json({ error: 'Description too long (max 500 characters)' });
    return;
  }

  try {
    const result = await acquireSkill(req.params.id, req.user!.userId, description);

    if (result.success && result.skill) {
      logAudit({
        userId: req.user!.userId,
        action: 'skill.acquire',
        entityType: 'bot',
        entityId: req.params.id,
        metadata: { skill_name: result.skill.name, source: 'acquired', description },
      });
    }

    res.status(result.success ? 201 : 400).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
