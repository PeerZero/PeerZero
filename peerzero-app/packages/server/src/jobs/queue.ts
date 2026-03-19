// =============================================================================
// BullMQ job queue — manages autonomous bot cycle execution
// Each running bot has a repeating job that triggers its agent loop.
// Uses self-scheduling: after each cycle, the worker schedules the next one
// as a delayed job, avoiding BullMQ repeatable job stale-lock issues.
// =============================================================================

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { runOneCycle, BotContext } from '../runtime/agent-loop';
import { setBotStatus } from '../services/bot.service';
import { queryOne, query } from '../db/client';

let connection: IORedis | null = null;
let botQueue: Queue | null = null;
let botWorker: Worker | null = null;

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue(): Queue {
  if (!botQueue) {
    botQueue = new Queue('bot-cycles', { connection: getConnection() as any });
  }
  return botQueue;
}

/** Schedule the next cycle for a bot after a delay. */
async function scheduleNextCycle(
  botId: string,
  userId: string,
  llmApiKeyId: string,
  llmModel: string,
  cycleDelaySeconds: number,
): Promise<void> {
  const queue = getQueue();
  await queue.add(
    `bot-${botId}`,
    { botId, userId, llmApiKeyId, llmModel, cycleDelaySeconds },
    {
      jobId: `bot-${botId}-${Date.now()}`,
      delay: cycleDelaySeconds * 1000,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );
}

/** Add a cycle job for a bot. Runs immediately, then self-schedules. */
export async function addBotCycleJob(
  botId: string,
  userId: string,
  llmApiKeyId: string,
  llmModel: string,
  cycleDelaySeconds: number,
): Promise<void> {
  // Remove existing jobs first
  await removeBotJobs(botId);

  const queue = getQueue();

  // Add the first immediate job
  await queue.add(
    `bot-${botId}`,
    { botId, userId, llmApiKeyId, llmModel, cycleDelaySeconds },
    {
      jobId: `bot-${botId}-immediate`,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );
}

/** Remove all jobs for a bot. */
export async function removeBotJobs(botId: string): Promise<void> {
  const queue = getQueue();
  // Clean up any legacy repeatable jobs
  try {
    const repeatables = await queue.getRepeatableJobs();
    for (const job of repeatables) {
      if (job.name === `bot-${botId}`) {
        await queue.removeRepeatableByKey(job.key);
      }
    }
  } catch (err) {
    logger.debug({ botId, err: err instanceof Error ? err.message : err }, 'removeBotJobs: repeatable job removal skipped');
  }
  // Remove any pending jobs (immediate or scheduled) for this bot
  const jobTypes = ['wait', 'delayed', 'active'] as const;
  for (const type of jobTypes) {
    try {
      const jobs = await queue.getJobs([type]);
      for (const job of jobs) {
        if (job.name === `bot-${botId}`) {
          try {
            await job.remove();
          } catch {
            // Job may be locked by a dead worker — force-discard it
            try {
              await job.moveToFailed(new Error('Force-removed: stale lock'), '0', false);
              await job.remove();
            } catch {
              logger.debug({ botId, jobId: job.id }, 'removeBotJobs: could not remove job, will expire naturally');
            }
          }
        }
      }
    } catch (err) {
      logger.debug({ botId, type, err: err instanceof Error ? err.message : err }, 'removeBotJobs: job cleanup skipped');
    }
  }
}

/** Start the worker that processes bot cycle jobs. */
export function startWorker(): void {
  if (botWorker) return;

  botWorker = new Worker(
    'bot-cycles',
    async (job: Job) => {
      const { botId, userId, llmApiKeyId, llmModel, cycleDelaySeconds } = job.data;

      // Check if bot is still running (also fetch fast model + extended thinking from DB — may change between cycles)
      const bot = await queryOne<{ status: string; cycle_count: number; fast_llm_model: string | null; extended_thinking: boolean; cycle_delay_seconds: number }>(
        'SELECT status, cycle_count, fast_llm_model, extended_thinking, cycle_delay_seconds FROM bots WHERE id = $1',
        [botId],
      );
      if (!bot || bot.status !== 'running') {
        return; // Bot was stopped, skip
      }

      const ctx: BotContext = {
        botId,
        userId,
        llmApiKeyId,
        llmModel,
        fastLlmModel: bot.fast_llm_model,
        extendedThinking: bot.extended_thinking ?? false,
        cycleNumber: (bot.cycle_count || 0) + 1,
      };

      try {
        await runOneCycle(ctx);
        // Reset failure counter on success (persisted in DB to survive restarts)
        await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
      } catch (err) {
        logger.error({ botId, err }, 'Bot cycle failed');
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Immediately stop on auth errors
        const isAuthError = err instanceof Error && (
          err.message.includes('401') ||
          err.message.includes('403') ||
          err.message.includes('API key')
        );
        // Sanitize error message to prevent sensitive data leaks
        const sanitizedMsg = errorMsg.replace(/(?:sk-(?:ant-)?|key-|Bearer\s+|pwt_)[a-zA-Z0-9_-]+/g, '[REDACTED]').slice(0, 500);
        if (isAuthError) {
          await setBotStatus(botId, 'error', sanitizedMsg);
          await removeBotJobs(botId);
          await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
          return;
        }

        // Track consecutive failures in DB (survives worker restarts) — stop after 3
        await query('UPDATE bots SET consecutive_failures = consecutive_failures + 1 WHERE id = $1', [botId]);
        const failRow = await queryOne<{ consecutive_failures: number }>('SELECT consecutive_failures FROM bots WHERE id = $1', [botId]);
        const failures = failRow?.consecutive_failures || 1;
        if (failures >= 3) {
          await setBotStatus(botId, 'error', `Stopped after ${failures} consecutive failures: ${sanitizedMsg.slice(0, 400)}`);
          await removeBotJobs(botId);
          await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
          return;
        }
      }

      // Self-schedule the next cycle (use DB value so changes take effect without restart)
      const delay = bot.cycle_delay_seconds || cycleDelaySeconds || 60;
      // Re-check bot is still running before scheduling next
      const stillRunning = await queryOne<{ status: string }>('SELECT status FROM bots WHERE id = $1', [botId]);
      if (stillRunning?.status === 'running') {
        await scheduleNextCycle(botId, userId, llmApiKeyId, llmModel, delay);
      }
    },
    {
      connection: getConnection() as any,
      concurrency: 5, // Process up to 5 bot cycles in parallel
    },
  );

  botWorker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  logger.info('Bot cycle worker started');
}

/** Graceful shutdown. */
export async function stopWorker(): Promise<void> {
  if (botWorker) {
    await botWorker.close();
    botWorker = null;
  }
  if (botQueue) {
    await botQueue.close();
    botQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
