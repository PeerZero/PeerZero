// =============================================================================
// Task service — manages structured agent-to-agent task coordination
//
// Handles: creating tasks, processing inbox, posting callbacks, expiry.
// Tasks follow the A2A lifecycle: pending → processing → completed/failed.
// =============================================================================

import { query, queryOne, queryRows } from '../db/client';
import { logger } from '../lib/logger';
import { randomUUID } from 'crypto';

export interface CreateTaskParams {
  botId: string;
  direction: 'incoming' | 'outgoing';
  sender: string;
  target?: string;
  actionRequested: string;
  payload?: Record<string, unknown>;
  callbackUrl?: string;
  deadline?: string;       // ISO 8601
  conversationId?: string;
  turnNumber?: number;
}

export interface TaskRow {
  id: string;
  bot_id: string;
  request_id: string;
  direction: string;
  sender: string;
  target: string;
  action_requested: string;
  payload: Record<string, unknown>;
  callback_url: string | null;
  deadline: string | null;
  conversation_id: string | null;
  turn_number: number;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Create a new task (incoming or outgoing). */
export async function createTask(params: CreateTaskParams): Promise<TaskRow> {
  const requestId = `task-${randomUUID()}`;
  const row = await queryOne<TaskRow>(
    `INSERT INTO bot_tasks (bot_id, request_id, direction, sender, target, action_requested,
       payload, callback_url, deadline, conversation_id, turn_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, bot_id, request_id, direction, sender, target, action_requested,
       payload, callback_url, deadline, conversation_id, turn_number,
       status, result, error, created_at, completed_at`,
    [
      params.botId,
      requestId,
      params.direction,
      params.sender,
      params.target || '',
      params.actionRequested,
      JSON.stringify(params.payload || {}),
      params.callbackUrl || null,
      params.deadline || null,
      params.conversationId || null,
      params.turnNumber || 0,
    ],
  );
  if (!row) throw new Error('Failed to create task');
  return row;
}

/** Get pending incoming tasks for a bot (for shipped-loop processing). */
export async function getPendingTasks(botId: string, limit = 5): Promise<TaskRow[]> {
  return queryRows<TaskRow>(
    `SELECT id, bot_id, request_id, direction, sender, target, action_requested,
       payload, callback_url, deadline, conversation_id, turn_number,
       status, result, error, created_at, completed_at
     FROM bot_tasks
     WHERE bot_id = $1 AND direction = 'incoming' AND status = 'pending'
     ORDER BY created_at ASC LIMIT $2`,
    [botId, limit],
  );
}

/** Update task status. */
export async function updateTaskStatus(
  taskId: string,
  status: string,
  result?: Record<string, unknown>,
  error?: string,
): Promise<void> {
  const isTerminal = ['completed', 'failed', 'rejected', 'expired'].includes(status);
  await query(
    `UPDATE bot_tasks SET status = $2, result = $3, error = $4,
       completed_at = CASE WHEN $5 THEN now() ELSE completed_at END, updated_at = now()
     WHERE id = $1`,
    [taskId, status, result ? JSON.stringify(result) : null, error || null, isTerminal],
  );
}

/** List tasks for a bot (paginated, for API). */
export async function listTasks(
  botId: string,
  opts: { direction?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<{ data: TaskRow[]; total: number }> {
  const conditions = ['bot_id = $1'];
  const params: unknown[] = [botId];
  let idx = 2;

  if (opts.direction) {
    conditions.push(`direction = $${idx++}`);
    params.push(opts.direction);
  }
  if (opts.status) {
    conditions.push(`status = $${idx++}`);
    params.push(opts.status);
  }

  const limit = Math.min(opts.limit || 50, 100);
  const offset = opts.offset || 0;

  const where = conditions.join(' AND ');
  const [rows, countResult] = await Promise.all([
    queryRows<TaskRow>(
      `SELECT id, bot_id, request_id, direction, sender, target, action_requested,
         payload, callback_url, deadline, conversation_id, turn_number,
         status, result, error, created_at, completed_at
       FROM bot_tasks WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset],
    ),
    queryOne<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM bot_tasks WHERE ${where}`,
      params,
    ),
  ]);

  return { data: rows, total: countResult?.count || 0 };
}

/** Get a specific task by request_id. */
export async function getTaskByRequestId(requestId: string): Promise<TaskRow | null> {
  return queryOne<TaskRow>(
    `SELECT id, bot_id, request_id, direction, sender, target, action_requested,
       payload, callback_url, deadline, conversation_id, turn_number,
       status, result, error, created_at, completed_at
     FROM bot_tasks WHERE request_id = $1`,
    [requestId],
  );
}

/** Get conversation thread (all tasks in a conversation). */
export async function getConversationThread(conversationId: string): Promise<TaskRow[]> {
  return queryRows<TaskRow>(
    `SELECT id, bot_id, request_id, direction, sender, target, action_requested,
       payload, callback_url, deadline, conversation_id, turn_number,
       status, result, error, created_at, completed_at
     FROM bot_tasks WHERE conversation_id = $1 ORDER BY turn_number ASC LIMIT 100`,
    [conversationId],
  );
}

/** Expire overdue tasks. Called periodically. */
export async function expireOverdueTasks(botId: string): Promise<number> {
  const result = await query(
    `UPDATE bot_tasks SET status = 'expired', updated_at = now()
     WHERE bot_id = $1 AND status = 'pending' AND deadline IS NOT NULL AND deadline < now()`,
    [botId],
  );
  const expired = result.rowCount || 0;
  if (expired > 0) {
    logger.info({ botId, expired }, 'Expired overdue tasks');
  }
  return expired;
}
