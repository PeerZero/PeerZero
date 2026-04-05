import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logAudit, purgeExpiredAuditLogs } from '../../services/audit.service';
import { logger } from '../../lib/logger';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('audit.service', () => {
  describe('logAudit', () => {
    it('inserts an audit entry with all fields', () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      logAudit({
        userId: 'user-1',
        action: 'bot.create',
        entityType: 'bot',
        entityId: 'bot-1',
        metadata: { name: 'MyBot' },
        ipAddress: '192.168.1.1',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        ['user-1', 'bot.create', 'bot', 'bot-1', '{"name":"MyBot"}', '192.168.1.1'],
      );
    });

    it('defaults metadata to empty object when not provided', () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      logAudit({
        userId: 'user-1',
        action: 'key.add',
        entityType: 'llm_api_key',
        entityId: 'key-1',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        ['user-1', 'key.add', 'llm_api_key', 'key-1', '{}', null],
      );
    });

    it('defaults ipAddress to null when not provided', () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      logAudit({
        userId: 'user-1',
        action: 'bot.delete',
        entityType: 'bot',
        entityId: 'bot-2',
        metadata: {},
      });

      const callArgs = mockQuery.mock.calls[0][1];
      expect(callArgs[5]).toBeNull(); // ipAddress
    });

    it('does not throw when the DB insert fails (fire-and-forget)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

      // logAudit is fire-and-forget — it should not throw
      expect(() => {
        logAudit({
          userId: 'user-1',
          action: 'bot.start',
          entityType: 'bot',
          entityId: 'bot-3',
        });
      }).not.toThrow();

      // Wait for the promise rejection to be caught
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: 'DB connection lost' }),
          'Failed to write audit log',
        );
      });
    });

    it('serializes complex metadata to JSON', () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      logAudit({
        userId: 'user-1',
        action: 'payment.completed',
        entityType: 'payment',
        entityId: 'pay-1',
        metadata: { amount: 500, grades: [2, 3, 4], nested: { deep: true } },
      });

      const callArgs = mockQuery.mock.calls[0][1];
      const parsed = JSON.parse(callArgs[4]);
      expect(parsed.amount).toBe(500);
      expect(parsed.grades).toEqual([2, 3, 4]);
      expect(parsed.nested.deep).toBe(true);
    });

    it('handles all known action types', () => {
      const actions = ['bot.create', 'bot.delete', 'key.add', 'key.delete', 'bot.enroll', 'bot.start', 'bot.stop', 'payment.completed'];
      for (const action of actions) {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        logAudit({ userId: 'u', action, entityType: 'bot', entityId: 'b' });
      }
      expect(mockQuery).toHaveBeenCalledTimes(actions.length);
    });
  });

  // ===========================================================================
  // purgeExpiredAuditLogs
  // ===========================================================================

  describe('purgeExpiredAuditLogs', () => {
    it('deletes entries older than 90 days and returns count', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 42 });

      const result = await purgeExpiredAuditLogs();

      expect(result).toBe(42);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM audit_log"),
        [],
      );
      expect(mockQuery.mock.calls[0][0]).toContain("90 days");
    });

    it('returns 0 when no entries are purged', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const result = await purgeExpiredAuditLogs();
      expect(result).toBe(0);
    });

    it('returns 0 when rowCount is missing', async () => {
      mockQuery.mockResolvedValueOnce({});

      const result = await purgeExpiredAuditLogs();
      expect(result).toBe(0);
    });

    it('logs info when entries are purged', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });

      await purgeExpiredAuditLogs();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deleted: 5 }),
        'Purged expired audit log entries',
      );
    });

    it('does not log info when zero entries purged', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await purgeExpiredAuditLogs();

      expect(logger.info).not.toHaveBeenCalled();
    });

    it('returns 0 and logs error when query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB down'));

      const result = await purgeExpiredAuditLogs();

      expect(result).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'DB down' }),
        'Failed to purge audit logs',
      );
    });
  });
});
