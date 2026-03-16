// =============================================================================
// Platform job queue — manages platform cycle scheduling
// Separate from bot-cycles queue. Platform failures never block School learning.
// Each active bot_platform gets its own repeating job at its heartbeat interval.
// =============================================================================

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { runPlatformCycle, PlatformCycleContext } from '../runtime/platform-loop';
import { updatePlatformCycleStatus, getActivePlatforms } from '../services/platform.service';
import { queryOne } from '../db/client';

// Track consecutive failures per platform (in-memory, resets on worker restart)
const consecutiveFailures = new Map<string, number>();

let connection: IORedis | null = null;
let platformQueue: Queue | null = null;
let platformWorker: Worker | null = null;

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue(): Queue {
  if (!platformQueue) {
    platformQueue = new Queue('platform-cycles', { connection: getConnection() });
  }
  return platformQueue;
}

/** Schedule platform cycles for all active platforms on a bot. */
export async function schedulePlatformJobs(
  botId: string,
  userId: string,
  llmApiKeyId: string,
  llmModel: string,
): Promise<void> {
  const platforms = await getActivePlatforms(botId);
  const queue = getQueue();

  // Get bot handle for prompts
  const bot = await queryOne<{ school_agent_handle: string }>(
    'SELECT school_agent_handle FROM bots WHERE id = $1',
    [botId],
  );
  const botHandle = bot?.school_agent_handle || 'bot';

  for (const platform of platforms) {
    const jobName = `platform-${botId}-${platform.id}`;
    const data = {
      botId,
      userId,
      platformId: platform.id,
      llmApiKeyId,
      llmModel,
      botHandle,
    };

    // Check if this platform's heartbeat is due
    const lastCycle = platform.last_cycle_at ? new Date(platform.last_cycle_at).getTime() : 0;
    const heartbeatMs = platform.heartbeat_interval_seconds * 1000;
    const now = Date.now();

    if (now - lastCycle >= heartbeatMs) {
      // Due now — add immediate job
      await queue.add(jobName, data, {
        jobId: `${jobName}-now`,
        removeOnComplete: 50,
        removeOnFail: 25,
      });
    }
  }
}

/** Remove all platform jobs for a bot. */
export async function removePlatformJobs(botId: string): Promise<void> {
  const queue = getQueue();
  try {
    const repeatables = await queue.getRepeatableJobs();
    for (const job of repeatables) {
      if (job.name?.startsWith(`platform-${botId}-`)) {
        await queue.removeRepeatableByKey(job.key);
      }
    }
  } catch {
    // Job may not exist
  }
}

/** Start the worker that processes platform cycle jobs. */
export function startPlatformWorker(): void {
  if (platformWorker) return;

  platformWorker = new Worker(
    'platform-cycles',
    async (job: Job) => {
      const ctx: PlatformCycleContext = job.data;

      // Check if platform is still active
      const platform = await queryOne<{ status: string }>(
        'SELECT status FROM bot_platforms WHERE id = $1',
        [ctx.platformId],
      );
      if (!platform || platform.status !== 'active') return;

      try {
        await runPlatformCycle(ctx);
        consecutiveFailures.delete(ctx.platformId);
      } catch (err) {
        logger.error({ platformId: ctx.platformId, err }, 'Platform cycle failed');

        const failures = (consecutiveFailures.get(ctx.platformId) || 0) + 1;
        consecutiveFailures.set(ctx.platformId, failures);

        // 3 consecutive failures = pause platform (NOT stop bot)
        if (failures >= 3) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await updatePlatformCycleStatus(
            ctx.platformId,
            'paused',
            `Paused after ${failures} consecutive failures: ${errorMsg.slice(0, 400)}`,
          );
          consecutiveFailures.delete(ctx.platformId);
        }
      }
    },
    {
      connection: getConnection(),
      concurrency: 3, // Lower than school (5) — school gets priority
    },
  );

  platformWorker.on('error', (err) => {
    logger.error({ err }, 'Platform worker error');
  });

  logger.info('Platform cycle worker started');
}

/** Graceful shutdown. */
export async function stopPlatformWorker(): Promise<void> {
  if (platformWorker) {
    await platformWorker.close();
    platformWorker = null;
  }
  if (platformQueue) {
    await platformQueue.close();
    platformQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
