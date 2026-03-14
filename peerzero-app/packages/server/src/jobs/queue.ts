// =============================================================================
// BullMQ job queue — manages autonomous bot cycle execution
// Each running bot has a repeating job that triggers its agent loop.
// =============================================================================

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { runOneCycle, BotContext } from '../runtime/agent-loop';
import { setBotStatus } from '../services/bot.service';
import { queryOne } from '../db/client';

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
    botQueue = new Queue('bot-cycles', { connection: getConnection() });
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
    await queue.removeRepeatableByKey(`bot-${botId}:::${botId}-repeat`);
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

      // Check if bot is still running
      const bot = await queryOne<{ status: string; cycle_count: number }>(
        'SELECT status, cycle_count FROM bots WHERE id = $1',
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
        cycleNumber: (bot.cycle_count || 0) + 1,
      };

      try {
        await runOneCycle(ctx);
      } catch (err) {
        console.error(`[worker] Bot ${botId} cycle failed:`, err);
        // After 3 consecutive failures, stop the bot
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('API key')) {
          await setBotStatus(botId, 'error', errorMsg.slice(0, 500));
          await removeBotJobs(botId);
        }
      }
    },
    {
      connection: getConnection(),
      concurrency: 5, // Process up to 5 bot cycles in parallel
    },
  );

  botWorker.on('error', (err) => {
    console.error('[worker] Worker error:', err);
  });

  console.log('[worker] Bot cycle worker started');
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
