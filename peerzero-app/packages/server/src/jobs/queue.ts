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
import { acquireLock } from '../lib/redis-lock';
import { runOneCycle, BotContext } from '../runtime/agent-loop';
import { runShippedCycle } from '../runtime/shipped-loop';
import { setBotStatus } from '../services/bot.service';
import { queryOne, query, queryRows } from '../db/client';
import { notifyBotError } from '../services/notification.service';
import { broadcastStatusChange } from '../websocket/activity-stream';

const QUEUE_PREFIX = process.env.QUEUE_PREFIX || process.env.NODE_ENV || 'dev';
const QUEUE_NAME = `${QUEUE_PREFIX}:bot-cycles`;

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
    botQueue = new Queue(QUEUE_NAME, {
      connection: getConnection() as any,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500, // Retain more failures for debugging; cleanupOldJobs() ages out at 14 days
      },
    });
  }
  return botQueue;
}

/** Check if the job queue is available (Redis connected). */
export function isQueueAvailable(): boolean {
  return !!config.redisUrl;
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
      removeOnFail: 500, // Retain more failures for debugging; cleanupOldJobs() ages out at 14 days
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
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
      removeOnFail: 500, // Retain more failures for debugging; cleanupOldJobs() ages out at 14 days
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
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
    QUEUE_NAME,
    async (job: Job) => {
      const { botId, userId, llmApiKeyId, llmModel, cycleDelaySeconds } = job.data;

      // Distributed lock: prevent concurrent cycle execution for the same bot.
      // If another worker is already running this bot's cycle (stale BullMQ lock,
      // duplicate job, etc.), skip gracefully — the other worker will self-schedule.
      const CYCLE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes — safety net for crashed workers
      const lock = await acquireLock(getConnection(), `${QUEUE_PREFIX}:botlock:cycle:${botId}`, CYCLE_LOCK_TTL_MS);
      if (!lock) {
        logger.info({ botId }, 'Skipping cycle — another worker holds the lock');
        return;
      }

      try {
      // Check if bot is still running (also fetch mode, fast model, extended thinking from DB)
      // Includes user's daily_token_cap for per-user spending limits
      const bot = await queryOne<{ status: string; mode: string; cycle_count: number; fast_llm_model: string | null; extended_thinking: boolean; cycle_delay_seconds: number; daily_token_cap: number | null; daily_tokens_used: number; daily_tokens_reset_at: string | null; user_timezone: string; user_daily_token_cap: number | null }>(
        `SELECT b.status, b.mode, b.cycle_count, b.fast_llm_model, b.extended_thinking, b.cycle_delay_seconds, b.daily_token_cap, b.daily_tokens_used, b.daily_tokens_reset_at, COALESCE(u.timezone, 'UTC') AS user_timezone, u.daily_token_cap AS user_daily_token_cap
         FROM bots b JOIN users u ON u.id = b.user_id WHERE b.id = $1`,
        [botId],
      );
      if (!bot || bot.status !== 'running') {
        return; // Bot was stopped, skip
      }

      const botMode = bot.mode || 'school';
      // Reset daily token counter if the day has changed
      const todayStr = new Date().toISOString().slice(0, 10);
      const resetDate = bot.daily_tokens_reset_at ? new Date(bot.daily_tokens_reset_at).toISOString().slice(0, 10) : null;
      const dailyTokensUsed = resetDate === todayStr ? (bot.daily_tokens_used || 0) : 0;

      // Compute per-user aggregate token usage across all bots (only if user has a cap)
      let userDailyTokensUsed = 0;
      if (bot.user_daily_token_cap) {
        const userTotal = await queryOne<{ total: string }>(
          `SELECT COALESCE(SUM(CASE WHEN daily_tokens_reset_at >= CURRENT_DATE THEN daily_tokens_used ELSE 0 END), 0) AS total
           FROM bots WHERE user_id = $1`,
          [userId],
        );
        userDailyTokensUsed = Number(userTotal?.total) || 0;
      }

      const ctx: BotContext = {
        botId,
        userId,
        llmApiKeyId,
        llmModel,
        fastLlmModel: bot.fast_llm_model,
        extendedThinking: bot.extended_thinking ?? false,
        cycleNumber: (bot.cycle_count || 0) + 1,
        dailyTokenCap: bot.daily_token_cap,
        dailyTokensUsed,
        userDailyTokenCap: bot.user_daily_token_cap,
        userDailyTokensUsed,
        userTimezone: bot.user_timezone || 'UTC',
      };

      try {
        if (botMode === 'shipped') {
          await runShippedCycle(ctx);
        } else {
          await runOneCycle(ctx);
        }
        // Reset failure counter on success (persisted in DB to survive restarts)
        await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
      } catch (err) {
        logger.error({ botId, mode: botMode, err }, 'Bot cycle failed');
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Immediately stop on auth errors
        const isAuthError = err instanceof Error && (
          err.message.includes('401') ||
          err.message.includes('403') ||
          err.message.includes('API key')
        );
        // Sanitize error message to prevent sensitive data leaks
        const sanitizedMsg = errorMsg
          .replace(/(?:sk-(?:ant-)?|key-|Bearer\s+|pwt_|eyJ[A-Za-z0-9._-]+|supabase[a-zA-Z0-9_.\-/]+)[a-zA-Z0-9_.\-]*/gi, '[REDACTED]')
          .slice(0, 500);
        if (isAuthError) {
          await setBotStatus(botId, 'error', sanitizedMsg);
          broadcastStatusChange(botId, userId, 'error');
          await removeBotJobs(botId);
          await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
          // Notify user their bot stopped due to auth error
          const botInfo = await queryOne<{ name: string }>('SELECT name FROM bots WHERE id = $1', [botId]);
          notifyBotError(userId, botId, botInfo?.name || 'Your bot', sanitizedMsg).catch((err) => {
            logger.error({ err: err instanceof Error ? err.message : err, botId, userId }, 'Failed to send bot error notification');
          });
          return;
        }

        // Track consecutive failures in DB (survives worker restarts) — stop after 3
        await query('UPDATE bots SET consecutive_failures = consecutive_failures + 1 WHERE id = $1', [botId]);
        const failRow = await queryOne<{ consecutive_failures: number }>('SELECT consecutive_failures FROM bots WHERE id = $1', [botId]);
        const failures = failRow?.consecutive_failures || 1;
        if (failures >= 3) {
          const stopMsg = `Stopped after ${failures} consecutive failures: ${sanitizedMsg.slice(0, 400)}`;
          await setBotStatus(botId, 'error', stopMsg);
          broadcastStatusChange(botId, userId, 'error');
          await removeBotJobs(botId);
          await query('UPDATE bots SET consecutive_failures = 0 WHERE id = $1', [botId]);
          // Notify user their bot stopped
          const botInfo2 = await queryOne<{ name: string }>('SELECT name FROM bots WHERE id = $1', [botId]);
          notifyBotError(userId, botId, botInfo2?.name || 'Your bot', stopMsg).catch((err) => {
            logger.error({ err: err instanceof Error ? err.message : err, botId, userId }, 'Failed to send bot error notification');
          });
          return;
        }
      }

      // Self-schedule the next cycle (use DB value so changes take effect without restart)
      const baseDelay = bot.cycle_delay_seconds || cycleDelaySeconds || 60;
      // Single query to get both status and failure count for scheduling decision
      const botState = await queryOne<{ status: string; consecutive_failures: number }>(
        'SELECT status, consecutive_failures FROM bots WHERE id = $1',
        [botId],
      );
      if (botState?.status === 'running') {
        // Exponential backoff on consecutive failures: 1x, 2x, 4x normal delay
        const backoffMultiplier = Math.pow(2, botState.consecutive_failures || 0);
        const delay = Math.min(baseDelay * backoffMultiplier, 300); // cap at 5 minutes (was 1 hour — too aggressive for recovery)
        await scheduleNextCycle(botId, userId, llmApiKeyId, llmModel, delay);
      }

      } finally {
        await lock.release();
      }
    },
    {
      connection: getConnection() as any,
      concurrency: 5, // Process up to 5 bot cycles in parallel
      lockDuration: 5 * 60 * 1000, // 5 minutes — LLM calls can take a while
      lockRenewTime: 60 * 1000, // Renew lock every 60s to prevent expiry during long LLM calls
      stalledInterval: 5 * 60 * 1000, // Match lock duration — don't mark jobs as stalled prematurely
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing (Audit #6)
    },
  );

  botWorker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  botWorker.on('failed', (job, err) => {
    const botId = job?.data?.botId || 'unknown';
    const attempts = job?.attemptsMade || 0;
    const maxAttempts = job?.opts?.attempts || 2;
    if (attempts >= maxAttempts) {
      logger.error({ botId, jobId: job?.id, attempts, err: err.message }, 'Bot cycle job exhausted all retries (dead letter)');
    } else {
      logger.warn({ botId, jobId: job?.id, attempts, maxAttempts, err: err.message }, 'Bot cycle job failed, will retry');
    }
  });

  logger.info('Bot cycle worker started');
}

/** Clear stale bot cycle locks left over from a crashed worker.
 * Only deletes keys without a TTL (orphaned locks). Keys with an active TTL
 * belong to a live worker and will expire naturally. */
async function clearStaleLocks(): Promise<void> {
  try {
    const redis = getConnection();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${QUEUE_PREFIX}:botlock:cycle:*`, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length === 0) return;
    const staleKeys: string[] = [];
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      // ttl = -1 means no expiry (orphaned), ttl = -2 means key doesn't exist
      if (ttl === -1) {
        staleKeys.push(key);
      }
    }
    if (staleKeys.length > 0) {
      await redis.del(...staleKeys);
      logger.info({ cleared: staleKeys.length, total: keys.length }, 'Cleared stale bot cycle locks on startup (skipped keys with active TTL)');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to clear stale locks');
  }
}

/** Re-queue all bots that were running before the server restarted. */
export async function recoverRunningBots(): Promise<void> {
  await clearStaleLocks();
  const rows = await queryRows<{ id: string; user_id: string; llm_api_key_id: string; llm_model: string; cycle_delay_seconds: number }>(
    "SELECT id, user_id, llm_api_key_id, llm_model, cycle_delay_seconds FROM bots WHERE status = 'running' AND deleted_at IS NULL",
  );
  if (rows.length === 0) return;
  logger.info({ count: rows.length }, 'Recovering running bots after restart');
  const results = await Promise.allSettled(
    rows.map(bot =>
      addBotCycleJob(bot.id, bot.user_id, bot.llm_api_key_id, bot.llm_model, bot.cycle_delay_seconds)
        .then(() => logger.info({ botId: bot.id }, 'Recovered bot cycle job'))
    ),
  );
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logger.error({ failedCount: failed.length, total: rows.length }, 'Some bot recovery jobs failed');
  }
}

/** Clean up old completed/failed BullMQ jobs (Audit #3 — unbounded growth). */
export async function cleanupOldJobs(retentionDays: number = 30): Promise<{ completed: number; failed: number }> {
  const queue = getQueue();
  const grace = retentionDays * 24 * 60 * 60 * 1000;
  const [completed, failed] = await Promise.all([
    queue.clean(grace, 1000, 'completed'),
    queue.clean(grace, 1000, 'failed'),
  ]);
  const counts = { completed: completed.length, failed: failed.length };
  if (counts.completed > 0 || counts.failed > 0) {
    logger.info(counts, 'Cleaned up old BullMQ jobs');
  }
  return counts;
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
