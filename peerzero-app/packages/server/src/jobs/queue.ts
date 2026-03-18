// =============================================================================
// BullMQ job queue — manages autonomous bot cycle execution
// Each running bot has a repeating job that triggers its agent loop.
// =============================================================================

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { runOneCycle, BotContext } from '../runtime/agent-loop';
import { setBotStatus } from '../services/bot.service';
import { queryOne, query } from '../db/client';

// Track consecutive failures per bot (in-memory, resets on worker restart)
const consecutiveFailures = new Map<string, number>();

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

/** Add a repeating job for a bot. Runs every cycle_delay_seconds. */
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
    { botId, userId, llmApiKeyId, llmModel },
    {
      jobId: `bot-${botId}-immediate`,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );

  // Add repeating job
  await queue.add(
    `bot-${botId}`,
    { botId, userId, llmApiKeyId, llmModel },
    {
      repeat: { every: cycleDelaySeconds * 1000 },
      jobId: `bot-${botId}-repeat`,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );
}

/** Remove all jobs for a bot. */
export async function removeBotJobs(botId: string): Promise<void> {
  const queue = getQueue();
  try {
    // List all repeatable jobs and remove the one matching this bot
    const repeatables = await queue.getRepeatableJobs();
    for (const job of repeatables) {
      if (job.name === `bot-${botId}`) {
        await queue.removeRepeatableByKey(job.key);
      }
    }
  } catch {
    // Job may not exist
  }
  // Also remove any pending one-shot jobs
  const job = await queue.getJob(`bot-${botId}-immediate`);
  if (job) await job.remove();
}

/** Start the worker that processes bot cycle jobs. */
export function startWorker(): void {
  if (botWorker) return;

  botWorker = new Worker(
    'bot-cycles',
    async (job: Job) => {
      const { botId, userId, llmApiKeyId, llmModel } = job.data;

      // Check if bot is still running (also fetch fast model + extended thinking from DB — may change between cycles)
      const bot = await queryOne<{ status: string; cycle_count: number; fast_llm_model: string | null; extended_thinking: boolean }>(
        'SELECT status, cycle_count, fast_llm_model, extended_thinking FROM bots WHERE id = $1',
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
        // Reset failure counter on success
        consecutiveFailures.delete(botId);
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
        const sanitizedMsg = errorMsg.replace(/(?:sk-|key-|Bearer\s+)[a-zA-Z0-9_-]+/g, '[REDACTED]').slice(0, 500);
        if (isAuthError) {
          await setBotStatus(botId, 'error', sanitizedMsg);
          await removeBotJobs(botId);
          consecutiveFailures.delete(botId);
          return;
        }

        // Track consecutive failures — stop after 3
        const failures = (consecutiveFailures.get(botId) || 0) + 1;
        consecutiveFailures.set(botId, failures);
        if (failures >= 3) {
          await setBotStatus(botId, 'error', `Stopped after ${failures} consecutive failures: ${sanitizedMsg.slice(0, 400)}`);
          await removeBotJobs(botId);
          consecutiveFailures.delete(botId);
        }
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
