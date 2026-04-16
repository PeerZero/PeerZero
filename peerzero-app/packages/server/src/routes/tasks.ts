// =============================================================================
// Task routes — agent-to-agent task coordination for hosted bots
//
// POST /bots/:id/tasks/incoming  — receive a task from another agent
// GET  /bots/:id/tasks           — list tasks (filtered by direction/status)
// GET  /bots/:id/tasks/:requestId — get a specific task
// POST /bots/:id/tasks/send      — send a task to another agent (user-initiated)
// =============================================================================

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import { validateBody } from '../middleware/validate';
import { IncomingTaskSchema } from '../lib/schemas';
import * as taskService from '../services/task.service';
import * as botService from '../services/bot.service';
import { logAudit } from '../services/audit.service';
import { validateExternalUrl } from '../lib/url-validation';
import { logger } from '../lib/logger';
import rateLimit from 'express-rate-limit';

// Global per-IP limit on incoming tasks — prevents one sender from hammering
// the endpoint across many targets.
const incomingTaskLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many incoming tasks. Try again later.' },
});

// Per-target-bot limit on incoming tasks — prevents a distributed sender fleet
// from flooding one bot's inbox even if each sender stays under the per-IP
// limit above. The two work together: per-IP stops one actor fanning out,
// per-bot stops many actors converging on one target.
const incomingTaskPerBotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `bot:${req.params.id}`,
  message: { error: 'This bot is receiving too many tasks right now. Try again later.' },
});

// Phone-home endpoints — self-hosted bots polling for directives and reporting progress
const phoneHomeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,  // Generous: bots poll every ~30s, so 2/min typical, 60/min burst
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many phone-home requests. Try again later.' },
});

const router = Router();

// ── Incoming task (from another agent — HMAC auth if secret configured) ──
router.post('/:id/tasks/incoming', incomingTaskLimiter, incomingTaskPerBotLimiter, validateBody(IncomingTaskSchema), async (req: Request, res: Response) => {
  // Verify bot exists and is in shipped mode
  const bot = await botService.getBotById(req.params.id) as Record<string, unknown> | null;
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  if (bot.mode !== 'shipped') {
    res.status(403).json({ error: 'Bot is not accepting tasks (school mode)' });
    return;
  }

  // If bot has an incoming task secret configured, require Bearer token auth.
  // Same pattern as phone-home tokens: hash the provided secret, compare to stored hash.
  // If no secret configured, tasks are accepted openly (standard A2A).
  if (bot.incoming_task_secret_hash) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'This bot requires authentication for incoming tasks. Provide the task secret as a Bearer token.' });
      return;
    }
    const providedSecret = authHeader.slice(7);
    const providedHash = crypto.createHash('sha256').update(providedSecret).digest('hex');

    try {
      if (!crypto.timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(bot.incoming_task_secret_hash as string, 'hex'))) {
        res.status(401).json({ error: 'Invalid task secret' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid task secret' });
      return;
    }
  }

  const { sender, action_requested, payload, callback_url, deadline, conversation_id, turn_number } = req.body;

  // Log incoming task with sender identity — sender is self-reported and unverified
  // unless the bot has incoming_task_secret_hash set (which proves the caller knows the secret)
  const isAuthenticated = !!bot.incoming_task_secret_hash;
  logger.info({
    botId: req.params.id,
    sender,
    action: action_requested,
    authenticated: isAuthenticated,
    sourceIp: req.ip,
  }, `Incoming A2A task from ${isAuthenticated ? 'authenticated' : 'UNAUTHENTICATED'} sender: ${sender}`);

  // Validate callback_url against SSRF before storing
  if (callback_url) {
    try {
      validateExternalUrl(callback_url);
    } catch (err) {
      res.status(400).json({ error: `Invalid callback_url: ${err instanceof Error ? err.message : 'validation failed'}` });
      return;
    }
  }

  const task = await taskService.createTask({
    botId: req.params.id,
    direction: 'incoming',
    sender,
    actionRequested: action_requested,
    payload,
    callbackUrl: callback_url,
    deadline,
    conversationId: conversation_id,
    turnNumber: turn_number,
  });

  // Return A2A-compatible response (status: working)
  res.status(202).json({
    request_id: task.request_id,
    status: 'working',
    message: 'Task accepted and queued for processing',
  });
});

// ── List tasks (authenticated — bot owner only) ──
router.get('/:id/tasks', requireAuth, userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify ownership
  await botService.getBotDetail(req.user!.userId, req.params.id);

  const result = await taskService.listTasks(req.params.id, {
    direction: req.query.direction as string | undefined,
    status: req.query.status as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  });
  res.json(result);
});

// ── Get specific task by request_id (authenticated) ──
router.get('/:id/tasks/:requestId', requireAuth, userRateLimit('read'), async (req: Request, res: Response) => {
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const task = await taskService.getTaskByRequestId(req.params.requestId);
  if (!task || task.bot_id !== req.params.id) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

// ── Cancel a pending/processing task (authenticated — bot owner only) ──
router.post('/:id/tasks/:requestId/cancel', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  await botService.getBotDetail(req.user!.userId, req.params.id);
  const task = await taskService.getTaskByRequestId(req.params.requestId);
  if (!task || task.bot_id !== req.params.id) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!['pending', 'processing'].includes(task.status)) {
    res.status(400).json({ error: `Cannot cancel task in '${task.status}' state` });
    return;
  }

  await taskService.updateTaskStatus(task.id, 'rejected', undefined, 'Cancelled by owner');

  // Update the agenda card if this was an owner directive
  if (task.sender === 'owner' && task.action_requested === 'owner_directive') {
    const { updateAgendaMessage } = await import('../services/message.service');
    const { broadcastAgendaUpdate, broadcastMessage: broadcastMsg } = await import('../websocket/activity-stream');
    const { queryOne: q1 } = await import('../db/client');

    const cancelAgenda = {
      directive: task.payload?.directive_summary || String(task.payload?.message || ''),
      intention: 'Cancelled',
      steps: [],
      status: 'abandoned',
      progress_summary: 'Cancelled by owner',
    };
    const updatedMsg = await updateAgendaMessage(task.request_id, cancelAgenda);
    if (updatedMsg) {
      const owner = await q1<{ user_id: string }>('SELECT user_id FROM bots WHERE id = $1', [req.params.id]);
      if (owner) {
        broadcastAgendaUpdate(req.params.id, owner.user_id, updatedMsg.id, cancelAgenda);
      }
    }
  }

  logAudit({
    userId: req.user!.userId,
    action: 'task.cancel',
    entityType: 'bot_task',
    entityId: task.id,
    ipAddress: req.ip,
    metadata: { request_id: req.params.requestId },
  });

  res.json({ status: 'cancelled', request_id: task.request_id });
});

// ── Send a task to another agent (authenticated — user triggers delegation) ──
router.post('/:id/tasks/send', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  if (bot.mode !== 'shipped') {
    res.status(403).json({ error: 'Bot must be in shipped mode to send tasks' });
    return;
  }

  const { target_url, action_requested, payload, deadline, conversation_id, turn_number } = req.body;
  if (!target_url || typeof target_url !== 'string' || target_url.length > 2048) {
    res.status(400).json({ error: 'target_url required (string, max 2048 chars)' });
    return;
  }
  if (!action_requested || typeof action_requested !== 'string' || action_requested.length > 200) {
    res.status(400).json({ error: 'action_requested required (string, max 200 chars)' });
    return;
  }
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    res.status(400).json({ error: 'payload must be a JSON object' });
    return;
  }
  if (deadline !== undefined) {
    if (typeof deadline !== 'string' || isNaN(Date.parse(deadline))) {
      res.status(400).json({ error: 'deadline must be a valid ISO 8601 date string' });
      return;
    }
    // Reject already-past deadlines — otherwise the task sits in 'pending'
    // just long enough for the shipped loop to expire it, which is a
    // cheap way to fill someone's inbox.
    if (Date.parse(deadline) < Date.now()) {
      res.status(400).json({ error: 'deadline must be in the future' });
      return;
    }
  }
  if (conversation_id !== undefined && (typeof conversation_id !== 'string' || conversation_id.length > 200)) {
    res.status(400).json({ error: 'conversation_id must be a string (max 200 chars)' });
    return;
  }
  // conversation_id is trust-on-first-use: whoever opens a conversation on a
  // bot pins that id. Senders should use a high-entropy value (UUIDv4 or
  // 128+ bits of randomness) so a third party can't guess an active id and
  // inject a forged turn. This is not enforced as a format check here
  // because external A2A callers may pick their own scheme; weak ids are a
  // sender-side bug, not a server-side one.
  if (turn_number !== undefined && (typeof turn_number !== 'number' || !Number.isFinite(turn_number) || turn_number < 0)) {
    res.status(400).json({ error: 'turn_number must be a non-negative number' });
    return;
  }

  // Validate target_url against SSRF
  try {
    validateExternalUrl(target_url);
  } catch (err) {
    res.status(400).json({ error: `Invalid target_url: ${err instanceof Error ? err.message : 'validation failed'}` });
    return;
  }

  // Create outgoing task record
  const task = await taskService.createTask({
    botId: req.params.id,
    direction: 'outgoing',
    sender: bot.school_agent_handle || bot.name,
    target: target_url,
    actionRequested: action_requested,
    payload,
    deadline,
    conversationId: conversation_id,
    turnNumber: turn_number,
  });

  logAudit({
    userId: req.user!.userId,
    action: 'task.send',
    entityType: 'bot_task',
    entityId: task.id,
    ipAddress: req.ip,
    metadata: { target_url, action_requested },
  });

  res.status(201).json(task);
});

// ── Poll owner directives (self-hosted bots via phone-home token) ──
router.get('/:id/tasks/directives', phoneHomeLimiter, async (req: Request, res: Response) => {
  // Auth via phone-home token (Bearer header)
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing phone-home token' });
    return;
  }
  const token = authHeader.slice(7);

  // Verify bot exists and token matches
  const bot = await botService.getBotById(req.params.id);
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  if (bot.mode !== 'shipped') {
    res.status(403).json({ error: 'Bot is not in shipped mode' });
    return;
  }

  // Validate phone-home token
  const { queryOne: qo } = await import('../db/client');
  const tokenRow = await qo<{ id: string }>(
    `SELECT id FROM phone_home_tokens WHERE bot_id = $1 AND token_hash = encode(sha256($2::bytea), 'hex') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [req.params.id, token],
  );
  if (!tokenRow) {
    res.status(401).json({ error: 'Invalid phone-home token' });
    return;
  }

  // Return pending owner directives
  const tasks = await taskService.listTasks(req.params.id, {
    direction: 'incoming',
    status: 'pending',
    limit: 10,
  });

  // Filter to owner directives only
  const directives = tasks.data.filter(t => t.sender === 'owner' && t.action_requested === 'owner_directive');
  res.json({ directives });
});

// ── Report agenda progress (self-hosted bots via phone-home token) ──
router.post('/:id/task-progress', phoneHomeLimiter, async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing phone-home token' });
    return;
  }
  const token = authHeader.slice(7);

  const bot = await botService.getBotById(req.params.id);
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }

  // Validate phone-home token
  const { queryOne: qo } = await import('../db/client');
  const tokenRow = await qo<{ id: string }>(
    `SELECT id FROM phone_home_tokens WHERE bot_id = $1 AND token_hash = encode(sha256($2::bytea), 'hex') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [req.params.id, token],
  );
  if (!tokenRow) {
    res.status(401).json({ error: 'Invalid phone-home token' });
    return;
  }

  const { task_id, agenda, status } = req.body;
  if (!task_id || typeof task_id !== 'string' || task_id.length > 200) {
    res.status(400).json({ error: 'task_id required (string, max 200 chars)' });
    return;
  }
  if (agenda !== undefined && (typeof agenda !== 'object' || agenda === null || Array.isArray(agenda))) {
    res.status(400).json({ error: 'agenda must be a JSON object' });
    return;
  }
  if (status !== undefined && (typeof status !== 'string' || !['completed', 'failed'].includes(status))) {
    res.status(400).json({ error: "status must be 'completed' or 'failed'" });
    return;
  }

  // SECURITY: Verify the task belongs to this bot (prevents cross-bot task manipulation)
  const { queryOne: qTask } = await import('../db/client');
  const taskRow = await qTask<{ id: string }>(
    'SELECT id FROM bot_tasks WHERE id = $1 AND bot_id = $2',
    [task_id, req.params.id],
  );
  if (!taskRow) {
    res.status(404).json({ error: 'Task not found for this bot' });
    return;
  }

  // Update agenda message if provided
  if (agenda) {
    const { updateAgendaMessage } = await import('../services/message.service');
    const { broadcastAgendaUpdate } = await import('../websocket/activity-stream');
    const { queryOne: q1 } = await import('../db/client');

    const updatedMsg = await updateAgendaMessage(task_id, agenda);
    if (updatedMsg) {
      // Look up user_id for WebSocket broadcast
      const owner = await q1<{ user_id: string }>(
        'SELECT user_id FROM bots WHERE id = $1',
        [req.params.id],
      );
      if (owner) {
        broadcastAgendaUpdate(req.params.id, owner.user_id, updatedMsg.id, agenda);
      }
    }
  }

  // Update task status if terminal
  if (status && ['completed', 'failed'].includes(status)) {
    await taskService.updateTaskStatus(task_id, status, agenda ? { agenda } : undefined);
  }

  res.json({ ok: true });
});

export default router;
