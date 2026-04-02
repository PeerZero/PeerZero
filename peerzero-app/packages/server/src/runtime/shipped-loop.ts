// =============================================================================
// Shipped loop — executes one cycle for a bot in shipped (deployed) mode
//
// Shipped mode = platform interactions + task coordination. No school training.
// The bot's School-formed identity still informs every action, but the bot
// does NOT submit papers, reviews, or bounties to the school.
//
// Each cycle:
// 1. Process pending incoming tasks (A2A task lifecycle)
// 2. Schedule platform cycles for all active connections
// 3. Increment cycle count
//
// School training is artifact-only (papers, reviews, bounties).
// Platform interactions and agent-to-agent coordination are shipped-only.
// =============================================================================

import { logger } from '../lib/logger';
import { query, queryOne, queryRows } from '../db/client';
import { schedulePlatformJobs } from '../jobs/platform-queue';
import type { BotContext } from './agent-loop';

export async function runShippedCycle(ctx: BotContext): Promise<void> {
  const startTime = Date.now();

  // 1. Process pending incoming tasks
  const pendingTasks = await queryRows<{ id: string; request_id: string; action_requested: string; payload: Record<string, unknown> }>(
    `SELECT id, request_id, action_requested, payload
     FROM bot_tasks
     WHERE bot_id = $1 AND direction = 'incoming' AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT 5`,
    [ctx.botId],
  );

  for (const task of pendingTasks) {
    try {
      // Mark as processing
      await query(
        `UPDATE bot_tasks SET status = 'processing', updated_at = now() WHERE id = $1`,
        [task.id],
      );

      // Task execution is handled by the platform cycle when it picks up
      // the task context. For now, mark as completed — the full LLM-powered
      // task handling will be added when the task service is built.
      // TODO: Route through LLM with bot identity for real task processing
      await query(
        `UPDATE bot_tasks SET status = 'completed', completed_at = now(), updated_at = now(),
         result = $2 WHERE id = $1`,
        [task.id, JSON.stringify({ acknowledged: true, action: task.action_requested })],
      );

      logger.info(
        { botId: ctx.botId, taskId: task.id, action: task.action_requested },
        'Processed incoming task',
      );
    } catch (err) {
      logger.error(
        { botId: ctx.botId, taskId: task.id, err: err instanceof Error ? err.message : err },
        'Failed to process incoming task',
      );
      await query(
        `UPDATE bot_tasks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [task.id, err instanceof Error ? err.message : String(err)],
      );
    }
  }

  // 2. Schedule platform cycles for all active platform connections
  try {
    const utilityModel = ctx.fastLlmModel || ctx.llmModel;
    await schedulePlatformJobs(ctx.botId, ctx.userId, ctx.llmApiKeyId, utilityModel);
  } catch (err) {
    logger.warn(
      { botId: ctx.botId, err: err instanceof Error ? err.message : err },
      'Failed to schedule platform cycles',
    );
  }

  // 3. Expire overdue tasks
  await query(
    `UPDATE bot_tasks SET status = 'expired', updated_at = now()
     WHERE bot_id = $1 AND status = 'pending' AND deadline IS NOT NULL AND deadline < now()`,
    [ctx.botId],
  );

  // 4. Increment cycle count
  await query(
    'UPDATE bots SET cycle_count = cycle_count + 1, last_cycle_at = now() WHERE id = $1',
    [ctx.botId],
  );

  const elapsed = Date.now() - startTime;
  logger.info(
    { botId: ctx.botId, elapsed, tasksProcessed: pendingTasks.length },
    'Shipped cycle complete',
  );
}
