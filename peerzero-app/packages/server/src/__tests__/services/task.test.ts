import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('../../db/client', () => ({
  query: (...args: any[]) => mockQuery(...args),
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('crypto', () => ({
  randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
}));

import {
  createTask,
  getPendingTasks,
  updateTaskStatus,
  listTasks,
  getTaskByRequestId,
  getConversationThread,
  expireOverdueTasks,
} from '../../services/task.service';

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// createTask
// =============================================================================

describe('createTask', () => {
  const baseParams = {
    botId: 'bot-1',
    direction: 'incoming' as const,
    sender: 'bot-2',
    actionRequested: 'summarize',
  };

  it('inserts a task with all fields and returns the row', async () => {
    const fakeRow = { id: 'task-id', bot_id: 'bot-1', request_id: 'task-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'pending' };
    mockQueryOne.mockResolvedValueOnce(fakeRow);

    const result = await createTask({
      ...baseParams,
      target: 'bot-3',
      payload: { key: 'value' },
      callbackUrl: 'https://example.com/callback',
      deadline: '2026-04-10T00:00:00Z',
      conversationId: 'conv-1',
      turnNumber: 2,
    });

    expect(result).toEqual(fakeRow);
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO bot_tasks'),
      [
        'bot-1',
        'task-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'incoming',
        'bot-2',
        'bot-3',
        'summarize',
        '{"key":"value"}',
        'https://example.com/callback',
        '2026-04-10T00:00:00Z',
        'conv-1',
        2,
      ],
    );
  });

  it('defaults optional fields when not provided', async () => {
    const fakeRow = { id: 'task-id', status: 'pending' };
    mockQueryOne.mockResolvedValueOnce(fakeRow);

    await createTask(baseParams);

    const args = mockQueryOne.mock.calls[0][1];
    expect(args[4]).toBe('');           // target defaults to ''
    expect(args[6]).toBe('{}');         // payload defaults to {}
    expect(args[7]).toBeNull();         // callbackUrl defaults to null
    expect(args[8]).toBeNull();         // deadline defaults to null
    expect(args[9]).toBeNull();         // conversationId defaults to null
    expect(args[10]).toBe(0);           // turnNumber defaults to 0
  });

  it('throws when queryOne returns null (insert fails)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(createTask(baseParams)).rejects.toThrow('Failed to create task');
  });

  it('generates a request_id with task- prefix and UUID', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'x' });

    await createTask(baseParams);

    const requestId = mockQueryOne.mock.calls[0][1][1];
    expect(requestId).toBe('task-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

// =============================================================================
// getPendingTasks
// =============================================================================

describe('getPendingTasks', () => {
  it('queries pending incoming tasks for a bot with default limit', async () => {
    mockQueryRows.mockResolvedValueOnce([]);

    await getPendingTasks('bot-1');

    expect(mockQueryRows).toHaveBeenCalledWith(
      expect.stringContaining("direction = 'incoming'"),
      ['bot-1', 5],
    );
  });

  it('respects a custom limit', async () => {
    mockQueryRows.mockResolvedValueOnce([]);

    await getPendingTasks('bot-1', 20);

    expect(mockQueryRows.mock.calls[0][1][1]).toBe(20);
  });

  it('returns the rows from the query', async () => {
    const tasks = [{ id: 't1' }, { id: 't2' }];
    mockQueryRows.mockResolvedValueOnce(tasks);

    const result = await getPendingTasks('bot-1');
    expect(result).toEqual(tasks);
  });
});

// =============================================================================
// updateTaskStatus
// =============================================================================

describe('updateTaskStatus', () => {
  it('updates status with completed_at = now() for terminal statuses', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateTaskStatus('task-1', 'completed', { output: 'done' });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("now()");
    const args = mockQuery.mock.calls[0][1];
    expect(args[0]).toBe('task-1');
    expect(args[1]).toBe('completed');
    expect(args[2]).toBe('{"output":"done"}');
    expect(args[3]).toBeNull(); // no error
  });

  it('sets completed_at = NULL for non-terminal statuses', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateTaskStatus('task-1', 'processing');

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("NULL");
  });

  it('passes error string when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await updateTaskStatus('task-1', 'failed', undefined, 'Something broke');

    const args = mockQuery.mock.calls[0][1];
    expect(args[2]).toBeNull();              // no result
    expect(args[3]).toBe('Something broke'); // error
  });

  for (const status of ['completed', 'failed', 'rejected', 'expired']) {
    it(`treats "${status}" as a terminal status`, async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await updateTaskStatus('task-1', status);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('now()');
    });
  }

  it('treats "processing" as non-terminal', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await updateTaskStatus('task-1', 'processing');
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('NULL');
  });
});

// =============================================================================
// listTasks
// =============================================================================

describe('listTasks', () => {
  it('returns data and total with no filters', async () => {
    const tasks = [{ id: 't1' }];
    mockQueryRows.mockResolvedValueOnce(tasks);
    mockQueryOne.mockResolvedValueOnce({ count: 1 });

    const result = await listTasks('bot-1');

    expect(result).toEqual({ data: tasks, total: 1 });
    expect(mockQueryRows).toHaveBeenCalledWith(
      expect.stringContaining('bot_id = $1'),
      ['bot-1', 50, 0],
    );
  });

  it('adds direction filter when provided', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });

    await listTasks('bot-1', { direction: 'incoming' });

    const sql = mockQueryRows.mock.calls[0][0];
    expect(sql).toContain('direction = $2');
    expect(mockQueryRows.mock.calls[0][1]).toContain('incoming');
  });

  it('adds status filter when provided', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });

    await listTasks('bot-1', { status: 'pending' });

    const sql = mockQueryRows.mock.calls[0][0];
    expect(sql).toContain('status = $2');
    expect(mockQueryRows.mock.calls[0][1]).toContain('pending');
  });

  it('applies both direction and status filters', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });

    await listTasks('bot-1', { direction: 'outgoing', status: 'completed' });

    const sql = mockQueryRows.mock.calls[0][0];
    expect(sql).toContain('direction = $2');
    expect(sql).toContain('status = $3');
  });

  it('caps limit at 100', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });

    await listTasks('bot-1', { limit: 500 });

    // The limit param should be capped at 100
    const params = mockQueryRows.mock.calls[0][1];
    expect(params).toContain(100);
  });

  it('passes offset', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: 0 });

    await listTasks('bot-1', { offset: 25 });

    const params = mockQueryRows.mock.calls[0][1];
    expect(params).toContain(25);
  });

  it('returns total 0 when count query returns null', async () => {
    mockQueryRows.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await listTasks('bot-1');
    expect(result.total).toBe(0);
  });
});

// =============================================================================
// getTaskByRequestId
// =============================================================================

describe('getTaskByRequestId', () => {
  it('queries by request_id and returns the row', async () => {
    const task = { id: 'task-1', request_id: 'req-123' };
    mockQueryOne.mockResolvedValueOnce(task);

    const result = await getTaskByRequestId('req-123');

    expect(result).toEqual(task);
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('request_id = $1'),
      ['req-123'],
    );
  });

  it('returns null when task not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getTaskByRequestId('nonexistent');
    expect(result).toBeNull();
  });
});

// =============================================================================
// getConversationThread
// =============================================================================

describe('getConversationThread', () => {
  it('queries tasks by conversation_id ordered by turn_number', async () => {
    const tasks = [{ id: 't1', turn_number: 0 }, { id: 't2', turn_number: 1 }];
    mockQueryRows.mockResolvedValueOnce(tasks);

    const result = await getConversationThread('conv-1');

    expect(result).toEqual(tasks);
    expect(mockQueryRows).toHaveBeenCalledWith(
      expect.stringContaining('conversation_id = $1'),
      ['conv-1'],
    );
    expect(mockQueryRows.mock.calls[0][0]).toContain('ORDER BY turn_number ASC');
  });
});

// =============================================================================
// expireOverdueTasks
// =============================================================================

describe('expireOverdueTasks', () => {
  it('returns the number of expired tasks', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });

    const result = await expireOverdueTasks('bot-1');

    expect(result).toBe(3);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'expired'"),
      ['bot-1'],
    );
  });

  it('returns 0 when no tasks expire', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await expireOverdueTasks('bot-1');
    expect(result).toBe(0);
  });

  it('returns 0 when rowCount is undefined', async () => {
    mockQuery.mockResolvedValueOnce({});

    const result = await expireOverdueTasks('bot-1');
    expect(result).toBe(0);
  });

  it('only expires pending tasks with a past deadline', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await expireOverdueTasks('bot-1');

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('deadline IS NOT NULL');
    expect(sql).toContain('deadline < now()');
  });
});
