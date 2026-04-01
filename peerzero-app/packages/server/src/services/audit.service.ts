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
