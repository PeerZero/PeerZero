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
import { generateDialogue, DIALOGUE_CONTEXTS, type DialogueContext } from '../services/bot-voice.service';
import * as messageService from '../services/message.service';
import { broadcastMessage } from '../websocket/activity-stream';
import { addBotCycleJob, removeBotJobs, isQueueAvailable } from '../jobs/queue';
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
  const { name, avatar_config, llm_api_key_id, llm_model, extended_thinking } = req.body;
  if (!name || !avatar_config || !llm_api_key_id) {
    res.status(400).json({ error: 'name, avatar_config, and llm_api_key_id required' });
    return;
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    res.status(400).json({ error: 'Bot name must be 1-100 characters' });
    return;
  }
  const botId = await botService.createBot(req.user!.userId, name, avatar_config, llm_api_key_id, llm_model, extended_thinking);
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

  if (!isQueueAvailable()) {
    res.status(503).json({ error: 'Bot execution unavailable — Redis is not configured on the server' });
    return;
  }

  await botService.setBotStatus(req.params.id, 'running');
  await addBotCycleJob(req.params.id, req.user!.userId, bot.llm_api_key_id, bot.llm_model, bot.cycle_delay_seconds);
  logAudit({ userId: req.user!.userId, action: 'bot.start', entityType: 'bot', entityId: req.params.id, ipAddress: req.ip });
  res.json({ status: 'running' });
});

// Stop bot
router.post('/:id/stop', userRateLimit('bot_control'), async (req: Request, res: Response) => {
  // Always update DB status even if queue cleanup fails (stale locks)
  await Promise.allSettled([removeBotJobs(req.params.id)]);
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
  const perPage = 20;
  const cursor = req.query.cursor as string | undefined;

  const { queryRows, queryOne: qOne } = await import('../db/client');

  // Cursor-based pagination (preferred for large datasets) — use ?cursor=<created_at:id>
  // Falls back to offset pagination with ?page=N for backwards compatibility
  if (cursor) {
    // Composite cursor format: "created_at:id" for deterministic ordering
    const separatorIdx = cursor.lastIndexOf(':');
    const cursorDate = new Date(separatorIdx > 0 ? cursor.slice(0, separatorIdx) : cursor);
    const cursorId = separatorIdx > 0 ? cursor.slice(separatorIdx + 1) : undefined;
    if (isNaN(cursorDate.getTime())) {
      res.status(400).json({ error: 'Invalid cursor format' });
      return;
    }
    // Use composite (created_at, id) to avoid skips/loops on identical timestamps
    const rows = cursorId
      ? await queryRows(
          `SELECT id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp, created_at
           FROM external_activity_log
           WHERE bot_id = $1 AND deleted_at IS NULL AND (created_at, id) < ($2, $3)
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [req.params.id, cursorDate.toISOString(), cursorId, perPage + 1],
        )
      : await queryRows(
          `SELECT id, platform, action, summary, content_preview, skills_demonstrated, bot_timestamp, created_at
           FROM external_activity_log
           WHERE bot_id = $1 AND deleted_at IS NULL AND created_at < $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
          [req.params.id, cursorDate.toISOString(), perPage + 1],
        );
    const hasMore = rows.length > perPage;
    const data = hasMore ? rows.slice(0, perPage) : rows;
    const lastRow = data[data.length - 1] as { created_at: string; id: string } | undefined;
    const nextCursor = hasMore && lastRow ? `${lastRow.created_at}:${lastRow.id}` : null;
    res.json({ data, has_more: hasMore, next_cursor: nextCursor });
  } else {
    const rawPage = parseInt(req.query.page as string);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
    const offset = (page - 1) * perPage;
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
  }
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

// ── Bot Voice (on-demand dialogue) ──

router.post('/:id/speak', userRateLimit('write'), async (req: Request, res: Response) => {
  const { context } = req.body;
  if (!context || !(DIALOGUE_CONTEXTS as readonly string[]).includes(context)) {
    res.status(400).json({ error: `Invalid context. Must be one of: ${DIALOGUE_CONTEXTS.join(', ')}` });
    return;
  }

  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  if (!bot.llm_api_key_id) {
    res.status(400).json({ error: 'Bot has no API key configured' });
    return;
  }

  // Use fast model for dialogue (cheap), fall back to main model
  const model = bot.fast_llm_model || bot.llm_model;

  const message = await generateDialogue(
    {
      botId: bot.id,
      botName: bot.name,
      userId: req.user!.userId,
      llmApiKeyId: bot.llm_api_key_id,
      llmModel: model,
      selfAuthoredBlock: null, // Let the service look it up from memory
    },
    context as DialogueContext,
  );

  res.json({ message, context });
});

// ── Chat Messages ──

// Get message feed (paginated, newest first)
router.get('/:id/messages', userRateLimit('read'), async (req: Request, res: Response) => {
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const rawPage = parseInt(req.query.page as string);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
  const rawPerPage = parseInt(req.query.per_page as string);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 50) : 30;
  const result = await messageService.getMessages(req.params.id, page, perPage);
  res.json({ ...result, page, per_page: perPage });
});

// Send a chat message to the bot and get a reply
router.post('/:id/messages', userRateLimit('write'), async (req: Request, res: Response) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  if (content.length > 2000) {
    res.status(400).json({ error: 'Message too long (max 2000 characters)' });
    return;
  }

  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  if (!bot.llm_api_key_id) {
    res.status(400).json({ error: 'Bot has no API key configured' });
    return;
  }

  // Store user message
  const userMsg = await messageService.storeMessage(req.params.id, 'user', content.trim(), 'chat');

  // Broadcast user message via WebSocket
  broadcastMessage(req.params.id, req.user!.userId, userMsg);

  // Generate and store bot reply
  const model = bot.fast_llm_model || bot.llm_model;
  const replyText = await messageService.generateChatReply(
    req.params.id,
    bot.name,
    req.user!.userId,
    bot.llm_api_key_id,
    model,
    content.trim(),
  );
  const botReply = await messageService.storeMessage(req.params.id, 'bot', replyText, 'chat');

  // Broadcast bot reply via WebSocket
  broadcastMessage(req.params.id, req.user!.userId, botReply);

  res.json({ user_message: userMsg, bot_reply: botReply });
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
