// =============================================================================
// Audit service — append-only logging for sensitive operations
// Fire-and-forget: never blocks the calling operation, never throws.
// =============================================================================

import { query } from '../db/client';
import { logger } from '../lib/logger';

interface AuditEntry {
  userId: string;
  action: string;       // 'bot.create', 'bot.delete', 'key.add', 'key.delete', 'bot.enroll', 'bot.start', 'bot.stop', 'payment.completed'
  entityType: string;   // 'bot', 'llm_api_key', 'enrollment', 'payment'
  entityId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Purge audit log entries older than the retention period (90 days).
 * Also hard-deletes soft-deleted activity_log entries older than 90 days.
 * Should be called periodically (e.g. once per day on startup + setInterval).
 */
export async function purgeExpiredAuditLogs(): Promise<number> {
  try {
    const result = await query(
      `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`,
      [],
    );
    const deleted = (result as { rowCount?: number }).rowCount || 0;
    if (deleted > 0) {
      logger.info({ deleted }, 'Purged expired audit log entries');
    }
    // Hard-delete soft-deleted activity_log entries older than 90 days
    try {
      const actResult = await query(
        `DELETE FROM activity_log WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '90 days'`,
        [],
      );
      const actDeleted = (actResult as { rowCount?: number }).rowCount || 0;
      if (actDeleted > 0) {
        logger.info({ deleted: actDeleted }, 'Purged soft-deleted activity log entries');
      }
    } catch (actErr) {
      logger.error({ err: actErr instanceof Error ? actErr.message : actErr }, 'Failed to purge activity logs');
    }
    // Hard-delete active activity_log entries older than 180 days (unbounded growth prevention)
    try {
      const oldActResult = await query(
        `DELETE FROM activity_log WHERE deleted_at IS NULL AND created_at < NOW() - INTERVAL '180 days'`,
        [],
      );
      const oldActDeleted = (oldActResult as { rowCount?: number }).rowCount || 0;
      if (oldActDeleted > 0) {
        logger.info({ deleted: oldActDeleted }, 'Purged old active activity log entries (180d retention)');
      }
    } catch (oldActErr) {
      logger.error({ err: oldActErr instanceof Error ? oldActErr.message : oldActErr }, 'Failed to purge old activity logs');
    }
    // Purge terminal bot_tasks older than 90 days
    try {
      const taskResult = await query(
        `DELETE FROM bot_tasks WHERE status IN ('completed','failed','expired') AND updated_at < NOW() - INTERVAL '90 days'`,
        [],
      );
      const taskDeleted = (taskResult as { rowCount?: number }).rowCount || 0;
      if (taskDeleted > 0) {
        logger.info({ deleted: taskDeleted }, 'Purged terminal bot_tasks entries');
      }
    } catch (taskErr) {
      logger.error({ err: taskErr instanceof Error ? taskErr.message : taskErr }, 'Failed to purge terminal bot_tasks');
    }
    // Purge stale pending/processing tasks stuck for >24 hours (orphaned from crashed bots)
    try {
      const staleResult = await query(
        `DELETE FROM bot_tasks WHERE status IN ('pending','processing') AND updated_at < NOW() - INTERVAL '24 hours'`,
        [],
      );
      const staleDeleted = (staleResult as { rowCount?: number }).rowCount || 0;
      if (staleDeleted > 0) {
        logger.info({ deleted: staleDeleted }, 'Purged stale pending/processing bot_tasks');
      }
    } catch (staleErr) {
      logger.error({ err: staleErr instanceof Error ? staleErr.message : staleErr }, 'Failed to purge stale bot_tasks');
    }
    // Purge soft-deleted external_activity_log entries older than 90 days
    // and active entries older than 180 days
    try {
      const extResult = await query(
        `DELETE FROM external_activity_log
         WHERE (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '90 days')
            OR created_at < NOW() - INTERVAL '180 days'`,
        [],
      );
      const extDeleted = (extResult as { rowCount?: number }).rowCount || 0;
      if (extDeleted > 0) {
        logger.info({ deleted: extDeleted }, 'Purged external activity log entries');
      }
    } catch (extErr) {
      logger.error({ err: extErr instanceof Error ? extErr.message : extErr }, 'Failed to purge external activity logs');
    }
    // Trim bot_voice_cache to last 50 entries per bot
    try {
      const voiceResult = await query(
        `DELETE FROM bot_voice_cache WHERE id IN (
           SELECT bvc.id FROM bot_voice_cache bvc
           WHERE bvc.created_at < (
             SELECT created_at FROM bot_voice_cache bvc2
             WHERE bvc2.bot_id = bvc.bot_id
             ORDER BY created_at DESC
             LIMIT 1 OFFSET 49
           )
         )`,
        [],
      );
      const voiceDeleted = (voiceResult as { rowCount?: number }).rowCount || 0;
      if (voiceDeleted > 0) {
        logger.info({ deleted: voiceDeleted }, 'Trimmed bot_voice_cache to 50 per bot');
      }
    } catch (voiceErr) {
      logger.error({ err: voiceErr instanceof Error ? voiceErr.message : voiceErr }, 'Failed to trim bot_voice_cache');
    }
    // Purge expired refresh tokens (abandoned sessions never used again)
    try {
      const rtResult = await query(
        `DELETE FROM refresh_tokens WHERE expires_at < NOW()`,
        [],
      );
      const rtDeleted = (rtResult as { rowCount?: number }).rowCount || 0;
      if (rtDeleted > 0) {
        logger.info({ deleted: rtDeleted }, 'Purged expired refresh tokens');
      }
    } catch (rtErr) {
      logger.error({ err: rtErr instanceof Error ? rtErr.message : rtErr }, 'Failed to purge expired refresh tokens');
    }
    // Hard-delete soft-deleted bot_memory_exercises older than 90 days
    try {
      const memResult = await query(
        `DELETE FROM bot_memory_exercises WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '90 days'`,
        [],
      );
      const memDeleted = (memResult as { rowCount?: number }).rowCount || 0;
      if (memDeleted > 0) {
        logger.info({ deleted: memDeleted }, 'Purged soft-deleted bot memory exercises');
      }
    } catch (memErr) {
      logger.error({ err: memErr instanceof Error ? memErr.message : memErr }, 'Failed to purge soft-deleted memory exercises');
    }
    return deleted;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to purge audit logs');
    return 0;
  }
}

export function logAudit(entry: AuditEntry): void {
  query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.metadata || {}),
      entry.ipAddress || null,
    ],
  ).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to write audit log');
  });
}
