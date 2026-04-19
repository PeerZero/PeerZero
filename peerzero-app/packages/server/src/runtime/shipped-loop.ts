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
import { getLLMAdapter } from '../adapters/adapter.factory';
import { getDecryptedKey, markKeyInvalid } from '../services/api-key.service';
import { updateAgendaMessage, storeMessage, sanitizeForLLM } from '../services/message.service';
import { broadcastAgendaUpdate, broadcastMessage } from '../websocket/activity-stream';
import type { BotContext } from './agent-loop';

/** POST an outgoing task to the target agent's incoming endpoint. Fire-and-forget. */
async function deliverOutgoingTask(
  targetUrl: string,
  sender: string,
  actionRequested: string,
  payload: Record<string, unknown>,
  callbackUrl: string | null,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender,
        action_requested: actionRequested,
        payload,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Callback delivery retry policy. Bumped on each failure; when attempts
// reach MAX_CALLBACK_ATTEMPTS the task is flagged and retries stop.
const MAX_CALLBACK_ATTEMPTS = 5;
/** Exponential backoff: 1m, 2m, 4m, 8m, 16m. */
function callbackBackoffMs(attempt: number): number {
  return 60_000 * Math.pow(2, Math.max(0, attempt - 1));
}

/**
 * POST a task result to the caller's callback URL and persist the delivery
 * state. On success, stamps callback_delivered_at. On failure, bumps the
 * attempt counter and schedules the next retry — the shipped loop picks up
 * due retries on subsequent cycles via processCallbackRetries().
 *
 * The payload includes task_id, which the receiver should treat as the
 * idempotency key: the same task_id from this server always refers to the
 * same result, so a receiver seeing it twice can dedupe.
 */
async function deliverCallback(botId: string, callbackUrl: string, taskId: string, result: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, result }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    await query(
      `UPDATE bot_tasks SET callback_delivered_at = now(), callback_next_attempt_at = NULL,
                              callback_last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [taskId],
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Persist failure so the shipped loop can retry it on a later cycle.
    // callback_attempts increments atomically; if the new attempts count
    // crosses MAX_CALLBACK_ATTEMPTS, stop scheduling retries.
    const row = await queryOne<{ callback_attempts: number }>(
      `UPDATE bot_tasks
         SET callback_attempts        = callback_attempts + 1,
             callback_last_error      = $2,
             callback_next_attempt_at = CASE
               WHEN callback_attempts + 1 >= $3 THEN NULL
               ELSE now() + ($4 || ' milliseconds')::interval
             END,
             updated_at = now()
       WHERE id = $1
       RETURNING callback_attempts`,
      [taskId, errMsg.slice(0, 500), MAX_CALLBACK_ATTEMPTS, String(callbackBackoffMs(1))],
    );
    // If we already know the new attempt count, recompute the real backoff
    // (the UPDATE above used the "first failure" backoff because we didn't
    // know attempts yet — this second write makes the schedule correct).
    if (row && row.callback_attempts > 1 && row.callback_attempts < MAX_CALLBACK_ATTEMPTS) {
      await query(
        `UPDATE bot_tasks
           SET callback_next_attempt_at = now() + ($2 || ' milliseconds')::interval
         WHERE id = $1 AND callback_delivered_at IS NULL`,
        [taskId, String(callbackBackoffMs(row.callback_attempts))],
      );
    }
    logger.warn(
      { botId, taskId, callbackUrl, err: errMsg, attempt: row?.callback_attempts ?? '?' },
      'Failed to deliver task callback — will retry',
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retry any previously-failed callbacks that are due. Called once per
 * shipped cycle, before new task processing, so transient delivery errors
 * on the last cycle get a fresh chance this cycle.
 */
async function processCallbackRetries(botId: string): Promise<void> {
  const due = await queryRows<{ id: string; callback_url: string; result: Record<string, unknown> | null }>(
    `SELECT id, callback_url, result
     FROM bot_tasks
     WHERE bot_id = $1
       AND callback_url IS NOT NULL
       AND callback_delivered_at IS NULL
       AND callback_next_attempt_at IS NOT NULL
       AND callback_next_attempt_at <= now()
       AND callback_attempts < $2
     ORDER BY callback_next_attempt_at ASC
     LIMIT 10`,
    [botId, MAX_CALLBACK_ATTEMPTS],
  );
  for (const row of due) {
    // result is non-null for tasks that successfully processed — deliverCallback
    // tolerates a missing result by posting an empty object.
    await deliverCallback(botId, row.callback_url, row.id, row.result || {});
  }
}

export async function runShippedCycle(ctx: BotContext): Promise<void> {
  // Token cap check — skip cycle if daily limit reached (per-bot or per-user)
  if (ctx.dailyTokenCap && ctx.dailyTokensUsed >= ctx.dailyTokenCap) {
    logger.info({ botId: ctx.botId, used: ctx.dailyTokensUsed, cap: ctx.dailyTokenCap }, 'Daily token cap reached — skipping shipped cycle');
    return;
  }
  if (ctx.userDailyTokenCap && ctx.userDailyTokensUsed >= ctx.userDailyTokenCap) {
    logger.info({ botId: ctx.botId, userId: ctx.userId, used: ctx.userDailyTokensUsed, cap: ctx.userDailyTokenCap }, 'User daily token cap reached — skipping shipped cycle');
    return;
  }

  const startTime = Date.now();

  // 0. Stale lock cleanup — reset tasks stuck in 'processing' for >10 minutes
  await query(
    `UPDATE bot_tasks SET status = 'pending', updated_at = now()
     WHERE bot_id = $1 AND status = 'processing' AND updated_at < now() - INTERVAL '10 minutes'`,
    [ctx.botId],
  );

  // 0a. Retry any due callbacks that previously failed delivery. Running this
  // before new task processing ensures transient callback failures don't
  // starve when a later cycle is busy with new work.
  await processCallbackRetries(ctx.botId).catch((err) => {
    logger.warn({ botId: ctx.botId, err: err instanceof Error ? err.message : err }, 'Callback retry sweep failed');
  });

  // 1. Process pending incoming tasks
  const pendingTasks = await queryRows<{
    id: string;
    request_id: string;
    action_requested: string;
    payload: Record<string, unknown>;
    callback_url: string | null;
    sender: string;
    conversation_id: string | null;
    turn_number: number;
  }>(
    `SELECT id, request_id, action_requested, payload, callback_url, sender, conversation_id, turn_number
     FROM bot_tasks
     WHERE bot_id = $1 AND direction = 'incoming' AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT 5`,
    [ctx.botId],
  );

  if (pendingTasks.length > 0) {
    // Decrypt the LLM key once for all tasks in this cycle
    let llmKey: string | null = null;
    try {
      llmKey = await getDecryptedKey(ctx.llmApiKeyId, ctx.userId);
    } catch (err) {
      logger.error(
        { botId: ctx.botId, err: err instanceof Error ? err.message : err },
        'Failed to decrypt LLM key for task processing',
      );
    }

    const llmAdapter = getLLMAdapter();

    // Load bot's cached profile for identity context
    const botRow = await queryOne<{ cached_profile: Record<string, unknown> | null; name: string; extended_thinking: boolean }>(
      'SELECT cached_profile, name, extended_thinking FROM bots WHERE id = $1',
      [ctx.botId],
    );

    for (const task of pendingTasks) {
      try {
        // Atomically claim the task — guard against two workers picking up the
        // same row. If another worker already moved it out of 'pending', skip.
        const claim = await query(
          `UPDATE bot_tasks SET status = 'processing', updated_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [task.id],
        );
        if (claim.rowCount === 0) {
          logger.debug({ botId: ctx.botId, taskId: task.id }, 'Task already claimed by another worker — skipping');
          continue;
        }

        if (!llmKey) {
          throw new Error('LLM API key not available — cannot process task');
        }

        // Build identity context from cached profile
        const profile = botRow?.cached_profile as Record<string, unknown> | null;
        const botName = sanitizeForLLM(botRow?.name || 'a PeerZero bot');
        const identityContext = profile
          ? `You are ${botName}. ${profile.identity_summary || ''}`
          : `You are ${botName}.`;

        const isOwnerDirective = task.sender === 'owner' && task.action_requested === 'owner_directive';

        // Build the task prompt (sanitize external input to prevent prompt injection)
        const taskMessage = sanitizeForLLM(
          typeof task.payload?.message === 'string'
            ? task.payload.message
            : JSON.stringify(task.payload),
        );

        const conversationContext = task.conversation_id
          ? `\nThis is part of conversation ${task.conversation_id}, turn ${task.turn_number}.`
          : '';

        // Inject current datetime in the user's timezone so the bot reasons about the right "today"
        const now = new Date();
        let localTime: string;
        try {
          localTime = now.toLocaleString('en-US', { timeZone: ctx.userTimezone, dateStyle: 'full', timeStyle: 'long' });
        } catch {
          localTime = now.toISOString();
        }
        const currentTime = `\nCurrent date and time: ${localTime} (${ctx.userTimezone})`;

        // Owner directives get richer prompting with planning
        const systemPrompt = isOwnerDirective
          ? [
              identityContext,
              currentTime,
              '\nYour owner has asked you to do something. Break it into steps, execute them, and report back.',
              'Think through what needs to happen, then describe what you did and the result.',
              'Be thorough but concise.',
            ].join('\n')
          : [
              identityContext,
              currentTime,
              `\nYou have received a task from ${sanitizeForLLM(task.sender)}.`,
              `Action requested: ${sanitizeForLLM(task.action_requested)}`,
              conversationContext,
              '\nRespond helpfully and concisely. Your response will be sent back to the requester.',
            ].join('\n');

        // Owner directives use the strong model for better planning
        const taskModel = isOwnerDirective ? ctx.llmModel : (ctx.fastLlmModel || ctx.llmModel);

        // Update agenda message to show processing has started
        if (isOwnerDirective) {
          const agendaState = {
            directive: task.payload?.directive_summary || taskMessage,
            intention: 'Processing directive...',
            steps: [{ action: taskMessage, status: 'in_progress', task_type: 'action' }],
            status: 'active',
            progress_summary: '0/1 steps done',
          };
          const updatedMsg = await updateAgendaMessage(task.request_id, agendaState);
          if (updatedMsg) {
            broadcastAgendaUpdate(ctx.botId, ctx.userId, updatedMsg.id, agendaState);
          }
        }

        const extendedThinking = botRow?.extended_thinking ?? false;
        const llmResponse = await llmAdapter.chat(llmKey, taskModel, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: taskMessage },
        ], { maxTokens: isOwnerDirective ? 4096 : 2048, extendedThinking });

        const taskResult = {
          response: llmResponse.content,
          action: task.action_requested,
          tokens_used: llmResponse.tokens_used,
        };

        // Mark completed
        await query(
          `UPDATE bot_tasks SET status = 'completed', completed_at = now(), updated_at = now(),
           result = $2 WHERE id = $1`,
          [task.id, JSON.stringify(taskResult)],
        );

        // Update agenda message to show completion
        if (isOwnerDirective) {
          const agendaState = {
            directive: task.payload?.directive_summary || taskMessage,
            intention: 'Completed',
            steps: [{ action: taskMessage, status: 'done', result: llmResponse.content?.slice(0, 200), task_type: 'action' }],
            status: 'completed',
            progress_summary: '1/1 steps done',
          };
          const updatedMsg = await updateAgendaMessage(task.request_id, agendaState);
          if (updatedMsg) {
            broadcastAgendaUpdate(ctx.botId, ctx.userId, updatedMsg.id, agendaState);
          }
        }

        // Deliver callback if set
        if (task.callback_url) {
          await deliverCallback(ctx.botId, task.callback_url, task.id, taskResult);
        }

        // Narrate the result to the user's chat feed
        const resultSummary = llmResponse.content?.slice(0, 500) || 'Task completed.';
        const resultMsg = await storeMessage(
          ctx.botId, 'bot', resultSummary, 'activity', undefined,
          { action_type: isOwnerDirective ? 'directive_result' : 'task_result', task_id: task.id, sender: task.sender },
        );
        broadcastMessage(ctx.botId, ctx.userId, resultMsg);

        logger.info(
          { botId: ctx.botId, taskId: task.id, action: task.action_requested, tokens: llmResponse.tokens_used },
          'Processed incoming task',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { botId: ctx.botId, taskId: task.id, err: errMsg },
          'Failed to process incoming task',
        );

        // Mark API key invalid on 401 so UI shows the key needs replacing
        if (errMsg.includes('401') && ctx.llmApiKeyId) {
          await markKeyInvalid(ctx.llmApiKeyId).catch((e) => {
            logger.warn({ err: e instanceof Error ? e.message : e }, 'Failed to mark API key as invalid');
          });
        }

        await query(
          `UPDATE bot_tasks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
          [task.id, errMsg],
        );

        // Notify user of the failure in chat
        const isOwnerDir = task.sender === 'owner' && task.action_requested === 'owner_directive';
        const failContent = isOwnerDir
          ? `I wasn't able to complete that. Error: ${errMsg.slice(0, 200)}`
          : `A task from ${sanitizeForLLM(task.sender)} failed: ${errMsg.slice(0, 200)}`;
        const failMsg = await storeMessage(
          ctx.botId, 'bot', failContent, 'activity', undefined,
          { action_type: 'task_failed', task_id: task.id, error: errMsg.slice(0, 500) },
        );
        broadcastMessage(ctx.botId, ctx.userId, failMsg);

        // Update agenda card to show failure for owner directives
        if (isOwnerDir) {
          const failAgenda = {
            directive: task.payload?.directive_summary || (typeof task.payload?.message === 'string' ? task.payload.message : ''),
            intention: 'Failed',
            steps: [{ action: String(task.payload?.message || task.action_requested), status: 'failed', result: errMsg.slice(0, 200), task_type: 'action' }],
            status: 'failed',
            progress_summary: 'Failed',
          };
          const updatedFail = await updateAgendaMessage(task.request_id, failAgenda);
          if (updatedFail) {
            broadcastAgendaUpdate(ctx.botId, ctx.userId, updatedFail.id, failAgenda);
          }
        }
      }
    }
  }

  // 2. Deliver pending outgoing tasks
  const outgoingTasks = await queryRows<{
    id: string;
    request_id: string;
    target: string;
    action_requested: string;
    payload: Record<string, unknown>;
    callback_url: string | null;
    sender: string;
  }>(
    `SELECT id, request_id, target, action_requested, payload, callback_url, sender
     FROM bot_tasks
     WHERE bot_id = $1 AND direction = 'outgoing' AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT 10`,
    [ctx.botId],
  );

  for (const task of outgoingTasks) {
    try {
      // Atomically claim the task — skip if another worker already picked it up
      const claimed = await query(
        `UPDATE bot_tasks SET status = 'processing', updated_at = now() WHERE id = $1 AND status = 'pending'`,
        [task.id],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        logger.debug({ taskId: task.id }, 'Outgoing task already claimed by another worker, skipping');
        continue;
      }

      await deliverOutgoingTask(
        task.target,
        task.sender,
        task.action_requested,
        task.payload,
        task.callback_url,
      );

      await query(
        `UPDATE bot_tasks SET status = 'completed', completed_at = now(), updated_at = now(),
         result = $2 WHERE id = $1`,
        [task.id, JSON.stringify({ delivered: true, delivered_at: new Date().toISOString() })],
      );

      logger.info(
        { botId: ctx.botId, taskId: task.id, target: task.target },
        'Delivered outgoing task',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { botId: ctx.botId, taskId: task.id, err: errMsg },
        'Failed to deliver outgoing task',
      );
      await query(
        `UPDATE bot_tasks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [task.id, errMsg],
      );
    }
  }

  // 3. Schedule platform cycles for all active platform connections
  try {
    const utilityModel = ctx.fastLlmModel || ctx.llmModel;
    await schedulePlatformJobs(ctx.botId, ctx.userId, ctx.llmApiKeyId, utilityModel);
  } catch (err) {
    logger.warn(
      { botId: ctx.botId, err: err instanceof Error ? err.message : err },
      'Failed to schedule platform cycles',
    );
  }

  // 4. Expire overdue tasks
  await query(
    `UPDATE bot_tasks SET status = 'expired', updated_at = now()
     WHERE bot_id = $1 AND status = 'pending' AND deadline IS NOT NULL AND deadline < now()`,
    [ctx.botId],
  );

  // 5. Increment cycle count
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
