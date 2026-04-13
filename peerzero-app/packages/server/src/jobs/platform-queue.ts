// =============================================================================
// Platform job queue — manages platform cycle scheduling
// Separate from bot-cycles queue. Platform failures never block School learning.
// Each active bot_platform gets its own repeating job at its heartbeat interval.
// =============================================================================

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { acquireLock } from '../lib/redis-lock';
import { runPlatformCycle, PlatformCycleContext } from '../runtime/platform-loop';
import { updatePlatformCycleStatus, getActivePlatforms } from '../services/platform.service';
import { queryOne, query } from '../db/client';

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
    platformQueue = new Queue('platform-cycles', { connection: getConnection() as any });
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
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, botId }, 'removePlatformJobs failed — stale jobs may continue running');
  }
}

/** Start the worker that processes platform cycle jobs. */
export function startPlatformWorker(): void {
  if (platformWorker) return;

  platformWorker = new Worker(
    'platform-cycles',
    async (job: Job) => {
      const ctx: PlatformCycleContext = job.data;

      // Distributed lock: prevent concurrent platform cycle execution for the same platform.
      // Platform actions make external HTTP calls that must not be duplicated.
      const PLATFORM_LOCK_TTL_MS = 3 * 60 * 1000; // 3 minutes
      const lock = await acquireLock(getConnection(), `botlock:platform:${ctx.platformId}`, PLATFORM_LOCK_TTL_MS);
      if (!lock) {
        logger.info({ botId: ctx.botId, platformId: ctx.platformId }, 'Skipping platform cycle — another worker holds the lock');
        return;
      }

      try {
      // Check if platform is still active
      const platform = await queryOne<{ status: string }>(
        'SELECT status FROM bot_platforms WHERE id = $1',
        [ctx.platformId],
      );
      if (!platform || platform.status !== 'active') return;

      try {
        await runPlatformCycle(ctx);
        // Reset failure counter on success (persistent in DB)
        await query(
          'UPDATE bot_platforms SET consecutive_failures = 0 WHERE id = $1',
          [ctx.platformId],
        );
      } catch (err) {
        logger.error({ platformId: ctx.platformId, err }, 'Platform cycle failed');

        // Increment persistent failure counter
        const row = await queryOne<{ consecutive_failures: number }>(
          `UPDATE bot_platforms SET consecutive_failures = consecutive_failures + 1, updated_at = now()
           WHERE id = $1 RETURNING consecutive_failures`,
          [ctx.platformId],
        );
        const failures = row?.consecutive_failures || 1;

        // 3 consecutive failures = pause platform (NOT stop bot)
        if (failures >= 3) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await updatePlatformCycleStatus(
            ctx.platformId,
            'paused',
            `Paused after ${failures} consecutive failures: ${errorMsg.slice(0, 400)}`,
          );
          // Reset counter after pausing so reactivation starts fresh
          await query(
            'UPDATE bot_platforms SET consecutive_failures = 0 WHERE id = $1',
            [ctx.platformId],
          );
        }
      }

      } finally {
        await lock.release();
      }
    },
    {
      connection: getConnection() as any,
      concurrency: 3, // Lower than school (5) — school gets priority
      lockDuration: 3 * 60 * 1000, // 3 minutes — platform actions involve external HTTP calls
      lockRenewTime: 60_000, // Renew lock every 60s to prevent expiry during long LLM calls
      stalledInterval: 3 * 60 * 1000, // Match lock duration — don't mark jobs as stalled prematurely
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing
    },
  );

  platformWorker.on('error', (err) => {
    logger.error({ err }, 'Platform worker error');
  });

  logger.info('Platform cycle worker started');
}

/** Clean up old completed/failed BullMQ platform jobs. */
export async function cleanupOldPlatformJobs(retentionDays: number = 30): Promise<{ completed: number; failed: number }> {
  const queue = getQueue();
  const grace = retentionDays * 24 * 60 * 60 * 1000;
  const [completed, failed] = await Promise.all([
    queue.clean(grace, 1000, 'completed'),
    queue.clean(grace, 1000, 'failed'),
  ]);
  const counts = { completed: completed.length, failed: failed.length };
  if (counts.completed > 0 || counts.failed > 0) {
    logger.info(counts, 'Cleaned up old BullMQ platform jobs');
  }
  return counts;
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
