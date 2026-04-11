// =============================================================================
// Redis distributed lock — prevents concurrent cycle execution per bot
//
// Uses the standard SET NX PX pattern (single-instance Redlock).
// Safe for our use case: single Redis instance, lock holder always releases
// in a finally block, and TTL is a safety net for crashed workers.
// =============================================================================

import type IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import { logger } from './logger';

export interface Lock {
  /** Release the lock. Safe to call multiple times. */
  release(): Promise<void>;
  /** The unique value identifying this lock holder. */
  value: string;
}

/**
 * Attempt to acquire a distributed lock.
 *
 * @param redis  - IORedis connection
 * @param key    - Lock key (e.g. "botlock:school:{botId}")
 * @param ttlMs  - Lock auto-expiry in milliseconds (safety net for crashed workers)
 * @returns Lock handle if acquired, null if another holder has the lock
 */
export async function acquireLock(
  redis: IORedis,
  key: string,
  ttlMs: number,
): Promise<Lock | null> {
  const value = randomUUID();

  // SET key value NX PX ttlMs — atomic acquire-or-fail
  const result = await redis.set(key, value, 'PX', ttlMs, 'NX');

  if (result !== 'OK') {
    return null; // Lock held by another worker
  }

  let released = false;

  return {
    value,
    async release() {
      if (released) return;
      released = true;

      // Lua script: only delete if we still own the lock (compare-and-delete)
      // This prevents releasing a lock that expired and was re-acquired by someone else.
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await redis.eval(script, 1, key, value);
      } catch (err) {
        logger.warn(
          { key, err: err instanceof Error ? err.message : err },
          'Failed to release Redis lock — will expire via TTL',
        );
      }
    },
  };
}
