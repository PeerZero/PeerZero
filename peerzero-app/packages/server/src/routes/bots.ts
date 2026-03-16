// =============================================================================
// Bot routes — CRUD, enrollment, start/stop, activity, stats
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as botService from '../services/bot.service';
import * as memoryService from '../services/memory.service';
import * as activityService from '../services/activity.service';
import * as statsService from '../services/stats.service';
import * as skillService from '../services/skill.service';
import { addBotCycleJob, removeBotJobs } from '../jobs/queue';
import { logAudit } from '../services/audit.service';
import type { ActivityCategory, FocusChunk } from '@peerzero/shared';
import { ACTIVITY_CATEGORIES } from '@peerzero/shared';

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
  const { name, avatar_config, llm_api_key_id, llm_model, fast_llm_model } = req.body;
  if (!name || !avatar_config || !llm_api_key_id) {
    res.status(400).json({ error: 'name, avatar_config, and llm_api_key_id required' });
    return;
  }
  const botId = await botService.createBot(req.user!.userId, name, avatar_config, llm_api_key_id, llm_model, fast_llm_model);
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
  const schoolFocus = (profile?.active_focus as { focus_chunks: FocusChunk[] }) || null;
  const snapshot = await memoryService.getMemorySnapshot(req.params.id, schoolFocus);
  res.json(snapshot);
});

// ── Activity Log ──

// Get bot activity log (supports category filtering)
router.get('/:id/activity', userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership before returning activity
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const rawPage = parseInt(req.query.page as string);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
  const rawPerPage = parseInt(req.query.per_page as string);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 20;

  // Optional category filter
  const category = req.query.category as string | undefined;
  const validCategory = category && ACTIVITY_CATEGORIES.includes(category as ActivityCategory)
    ? category as ActivityCategory
    : undefined;

  const result = await activityService.getActivityLog(req.params.id, page, perPage, validCategory);
  res.json({ ...result, page, per_page: perPage });
});

// Delete a single activity entry (soft-delete)
router.delete('/:id/activity/:activityId', userRateLimit('write'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const deleted = await activityService.deleteActivityItem(req.params.id, req.params.activityId);
  if (!deleted) {
    res.status(404).json({ error: 'Activity entry not found' });
    return;
  }
  res.json({ success: true });
});

// Delete all activity for a bot (soft-delete)
router.delete('/:id/activity', userRateLimit('write'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const count = await activityService.deleteAllActivity(req.params.id);
  logAudit({
    userId: req.user!.userId,
    action: 'activity.delete_all',
    entityType: 'bot',
    entityId: req.params.id,
    metadata: { deleted_count: count },
    ipAddress: req.ip,
  });
  res.json({ success: true, deleted_count: count });
});

// ── External Activity (from self-hosted bots / System 3) ──

router.get('/:id/external-activity', userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const rawPage = parseInt(req.query.page as string);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
  const perPage = 20;
  const offset = (page - 1) * perPage;

  const { queryRows, queryOne: qOne } = await import('../db/client');
  const rows = await queryRows(
    `SELECT id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp, created_at
     FROM external_activity_log
     WHERE bot_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.id, perPage, offset],
  );
  const countResult = await qOne<{ total: number }>(
    'SELECT COUNT(*)::int as total FROM external_activity_log WHERE bot_id = $1 AND deleted_at IS NULL',
    [req.params.id],
  );
  const total = countResult?.total || 0;
  res.json({ data: rows, total, page, per_page: perPage, has_more: offset + perPage < total });
});

// Delete a single external activity entry (soft-delete)
router.delete('/:id/external-activity/:activityId', userRateLimit('write'), async (req: Request, res: Response) => {
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const { query: dbQuery } = await import('../db/client');
  const result = await dbQuery(
    'UPDATE external_activity_log SET deleted_at = NOW() WHERE id = $1 AND bot_id = $2 AND deleted_at IS NULL',
    [req.params.activityId, req.params.id],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: 'External activity entry not found' });
    return;
  }
  res.json({ success: true });
});

// Delete all external activity for a bot (soft-delete)
router.delete('/:id/external-activity', userRateLimit('write'), async (req: Request, res: Response) => {
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const { query: dbQuery } = await import('../db/client');
  const result = await dbQuery(
    'UPDATE external_activity_log SET deleted_at = NOW() WHERE bot_id = $1 AND deleted_at IS NULL',
    [req.params.id],
  );
  logAudit({
    userId: req.user!.userId,
    action: 'external_activity.delete_all',
    entityType: 'bot',
    entityId: req.params.id,
    metadata: { deleted_count: result.rowCount ?? 0 },
    ipAddress: req.ip,
  });
  res.json({ success: true, deleted_count: result.rowCount ?? 0 });
});

// ── Phone-Home Token ──
// Generate a write-only token for self-hosted bots to report activity
router.post('/:id/phone-home-token', userRateLimit('write'), async (req: Request, res: Response) => {
  const token = await botService.generatePhoneHomeToken(req.user!.userId, req.params.id);
  logAudit({ userId: req.user!.userId, action: 'bot.generate_phone_home_token', entityType: 'bot', entityId: req.params.id, ipAddress: req.ip });
  // Token is returned ONCE — user must save it. We only store the hash.
  res.json({ phone_home_token: token, warning: 'Save this token — it cannot be retrieved later.' });
});

// ── Skills ──

router.get('/:id/skills', userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const skills = await skillService.getSkillSnapshots(req.params.id);
  res.json(skills);
});

// ── Stats ──

router.get('/:id/stats', userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const days = parseInt(req.query.days as string) || 30;
  const stats = await statsService.getBotStats(req.params.id, Math.min(days, 365));
  res.json(stats);
});

export default router;
