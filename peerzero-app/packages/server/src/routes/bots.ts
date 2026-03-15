// =============================================================================
// Bot routes — CRUD, enrollment, start/stop
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as botService from '../services/bot.service';
import * as memoryService from '../services/memory.service';
import * as activityService from '../services/activity.service';
import { addBotCycleJob, removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';

const router = Router();
router.use(requireAuth);

// List user's bots
router.get('/', userRateLimit('read'), async (req: Request, res: Response) => {
  const bots = await botService.getUserBots(req.user!.userId);
  res.json(bots);
});

// Get bot detail
router.get('/:id', userRateLimit('read'), async (req: Request, res: Response) => {
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  res.json(bot);
});

// Create bot
router.post('/', userRateLimit('write'), async (req: Request, res: Response) => {
  const { name, avatar_config, llm_api_key_id, llm_model } = req.body;
  if (!name || !avatar_config || !llm_api_key_id) {
    res.status(400).json({ error: 'name, avatar_config, and llm_api_key_id required' });
    return;
  }
  const botId = await botService.createBot(req.user!.userId, name, avatar_config, llm_api_key_id, llm_model);
  logAudit({ userId: req.user!.userId, action: 'bot.create', entityType: 'bot', entityId: botId, metadata: { name }, ipAddress: req.ip });
  const bot = await botService.getBotDetail(req.user!.userId, botId);
  res.status(201).json(bot);
});

// Update bot
router.patch('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  await botService.updateBot(req.user!.userId, req.params.id, req.body);
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  res.json(bot);
});

// Delete bot
router.delete('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  await removeBotJobs(req.params.id);
  // Fetch bot name before deletion for audit trail
  const botToDelete = await botService.getBotDetail(req.user!.userId, req.params.id);
  await botService.deleteBot(req.user!.userId, req.params.id);
  logAudit({ userId: req.user!.userId, action: 'bot.delete', entityType: 'bot', entityId: req.params.id, metadata: { name: botToDelete.name, school_name: botToDelete.school_name || null }, ipAddress: req.ip });
  res.json({ success: true });
});

// Enroll bot in school
router.post('/:id/enroll', userRateLimit('write'), async (req: Request, res: Response) => {
  const { school_id } = req.body;
  if (!school_id) {
    res.status(400).json({ error: 'school_id required' });
    return;
  }
  const result = await botService.enrollBotInSchool(req.user!.userId, req.params.id, school_id);
  logAudit({ userId: req.user!.userId, action: 'bot.enroll', entityType: 'enrollment', entityId: req.params.id, metadata: { school_id, handle: result.handle }, ipAddress: req.ip });
  res.json(result);
});

// Start bot (begin autonomous cycles)
router.post('/:id/start', userRateLimit('bot_control'), async (req: Request, res: Response) => {
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  if (!bot.school_id) {
    res.status(400).json({ error: 'Bot must be enrolled in a school first' });
    return;
  }
  if (!bot.llm_api_key_id) {
    res.status(400).json({ error: 'Bot needs an LLM API key' });
    return;
  }

  if (bot.cycle_delay_seconds <= 0 || bot.cycle_delay_seconds > 86400) {
    res.status(400).json({ error: 'cycle_delay_seconds must be between 1 and 86400' });
    return;
  }

  await botService.setBotStatus(req.params.id, 'running');
  await addBotCycleJob(req.params.id, req.user!.userId, bot.llm_api_key_id, bot.llm_model, bot.cycle_delay_seconds);
  logAudit({ userId: req.user!.userId, action: 'bot.start', entityType: 'bot', entityId: req.params.id, ipAddress: req.ip });
  res.json({ status: 'running' });
});

// Stop bot
router.post('/:id/stop', userRateLimit('bot_control'), async (req: Request, res: Response) => {
  await removeBotJobs(req.params.id);
  await botService.setBotStatus(req.params.id, 'stopped');
  logAudit({ userId: req.user!.userId, action: 'bot.stop', entityType: 'bot', entityId: req.params.id, ipAddress: req.ip });
  res.json({ status: 'stopped' });
});

// Get bot memory snapshot
router.get('/:id/memory', userRateLimit('read'), async (req: Request, res: Response) => {
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  interface CachedProfile {
    active_focus?: unknown;
    agent?: { credibility_score?: number; tier?: number };
    grade?: { grade?: number };
    [key: string]: unknown;
  }
  const profile = bot.cached_profile as CachedProfile | null;
  const schoolFocus = profile?.active_focus || null;
  const snapshot = await memoryService.getMemorySnapshot(req.params.id, schoolFocus);
  res.json(snapshot);
});

// Get bot activity log
router.get('/:id/activity', userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership before returning activity
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const rawPage = parseInt(req.query.page as string);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
  const rawPerPage = parseInt(req.query.per_page as string);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 20;
  const result = await activityService.getActivityLog(req.params.id, page, perPage);
  res.json({ ...result, page, per_page: perPage });
});

export default router;
