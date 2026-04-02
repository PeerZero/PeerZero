// =============================================================================
// Task routes — agent-to-agent task coordination for hosted bots
//
// POST /bots/:id/tasks/incoming  — receive a task from another agent
// GET  /bots/:id/tasks           — list tasks (filtered by direction/status)
// GET  /bots/:id/tasks/:requestId — get a specific task
// POST /bots/:id/tasks/send      — send a task to another agent (user-initiated)
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as taskService from '../services/task.service';
import * as botService from '../services/bot.service';
import { logAudit } from '../services/audit.service';

const router = Router();

// ── Incoming task (from another agent — no auth required, but bot must exist) ──
router.post('/:id/tasks/incoming', userRateLimit('write'), async (req: Request, res: Response) => {
  // Verify bot exists and is in shipped mode
  const bot = await botService.getBotById(req.params.id);
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  if (bot.mode !== 'shipped') {
    res.status(403).json({ error: 'Bot is not accepting tasks (school mode)' });
    return;
  }

  const { sender, action_requested, payload, callback_url, deadline, conversation_id, turn_number } = req.body;
  if (!sender || !action_requested) {
    res.status(400).json({ error: 'sender and action_requested required' });
    return;
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

// ── Send a task to another agent (authenticated — user triggers delegation) ──
router.post('/:id/tasks/send', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  const bot = await botService.getBotDetail(req.user!.userId, req.params.id);
  if (bot.mode !== 'shipped') {
    res.status(403).json({ error: 'Bot must be in shipped mode to send tasks' });
    return;
  }

  const { target_url, action_requested, payload, deadline, conversation_id, turn_number } = req.body;
  if (!target_url || !action_requested) {
    res.status(400).json({ error: 'target_url and action_requested required' });
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

export default router;
