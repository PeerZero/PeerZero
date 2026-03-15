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
