import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all external dependencies ──────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLLMAdapter = {
  chat: vi.fn().mockResolvedValue({
    content: 'Here is my response to your task.',
    tokens_used: 500,
    model: 'claude-opus-4-6',
    stop_reason: 'end_turn',
  }),
};

vi.mock('../../adapters/adapter.factory', () => ({
  getLLMAdapter: () => mockLLMAdapter,
}));

vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: vi.fn().mockResolvedValue('test-llm-key'),
}));

const mockSchedulePlatformJobs = vi.fn().mockResolvedValue(undefined);

vi.mock('../../jobs/platform-queue', () => ({
  schedulePlatformJobs: (...args: any[]) => mockSchedulePlatformJobs(...args),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockQueryOne = vi.fn().mockResolvedValue({
  cached_profile: { identity_summary: 'A careful reasoner' },
  name: 'TestBot',
});
const mockQueryRows = vi.fn().mockResolvedValue([]);

vi.mock('../../db/client', () => ({
  query: (...args: any[]) => mockQuery(...args),
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

// Mock global fetch for callback delivery
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ───────────────────────────────────────────────────────

import { runShippedCycle } from '../../runtime/shipped-loop';
import type { BotContext } from '../../runtime/agent-loop';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CTX: BotContext = {
  botId: 'bot-1',
  userId: 'user-1',
  llmApiKeyId: 'key-1',
  llmModel: 'claude-opus-4-6',
  fastLlmModel: 'claude-haiku-4-5-20251001',
  extendedThinking: false,
  cycleNumber: 10,
  dailyTokenCap: null,
  dailyTokensUsed: 0,
  userTimezone: 'UTC',
};

function makePendingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    request_id: 'req-1',
    action_requested: 'analyze',
    payload: { message: 'Analyze this data for me.' },
    callback_url: null,
    sender: 'bot-external',
    conversation_id: null,
    turn_number: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockQueryOne.mockResolvedValue({
    cached_profile: { identity_summary: 'A careful reasoner' },
    name: 'TestBot',
  });
  mockQueryRows.mockResolvedValue([]);
  mockLLMAdapter.chat.mockResolvedValue({
    content: 'Here is my response.',
    tokens_used: 500,
    model: 'claude-opus-4-6',
    stop_reason: 'end_turn',
  });
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

// =============================================================================
// Stale lock cleanup
// =============================================================================

describe('stale lock cleanup', () => {
  it('resets tasks stuck in processing for >10 minutes', async () => {
    await runShippedCycle(BASE_CTX);

    // First query call should be the stale lock cleanup
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[0]).toContain("status = 'processing'");
    expect(firstCall[0]).toContain("INTERVAL '10 minutes'");
    expect(firstCall[1]).toEqual(['bot-1']);
  });

  it('resets stuck tasks back to pending status', async () => {
    await runShippedCycle(BASE_CTX);

    const staleLockCall = mockQuery.mock.calls[0];
    expect(staleLockCall[0]).toContain("status = 'pending'");
  });
});

// =============================================================================
// A2A task processing lifecycle
// =============================================================================

describe('A2A task processing', () => {
  it('processes pending incoming tasks', async () => {
    const task = makePendingTask();
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    // Should mark as processing
    const processingCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'processing'") && call[0].includes('WHERE id'),
    );
    expect(processingCall).toBeDefined();
    expect(processingCall![1]).toEqual(['task-1']);

    // Should call LLM — non-owner tasks use the fast model
    expect(mockLLMAdapter.chat).toHaveBeenCalledWith(
      'test-llm-key',
      'claude-haiku-4-5-20251001',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: 'Analyze this data for me.' }),
      ]),
      expect.objectContaining({ maxTokens: 2048 }),
    );

    // Should mark as completed
    const completedCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'completed'"),
    );
    expect(completedCall).toBeDefined();
  });

  it('builds identity context from cached profile', async () => {
    const task = makePendingTask();
    mockQueryRows.mockResolvedValueOnce([task]);
    mockQueryOne.mockResolvedValue({
      cached_profile: { identity_summary: 'A careful reasoner who values evidence.' },
      name: 'EvidenceBot',
    });

    await runShippedCycle(BASE_CTX);

    const llmCall = mockLLMAdapter.chat.mock.calls[0];
    const systemPrompt = llmCall[2][0].content;
    expect(systemPrompt).toContain('EvidenceBot');
    expect(systemPrompt).toContain('A careful reasoner who values evidence.');
  });

  it('includes conversation context when conversation_id is set', async () => {
    const task = makePendingTask({
      conversation_id: 'conv-123',
      turn_number: 3,
    });
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    const llmCall = mockLLMAdapter.chat.mock.calls[0];
    const systemPrompt = llmCall[2][0].content;
    expect(systemPrompt).toContain('conv-123');
    expect(systemPrompt).toContain('turn 3');
  });

  it('processes up to 5 tasks per cycle (LIMIT 5)', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makePendingTask({ id: `task-${i}`, request_id: `req-${i}` }),
    );
    mockQueryRows.mockResolvedValueOnce(tasks);

    await runShippedCycle(BASE_CTX);

    // LLM should be called 5 times (once per task)
    expect(mockLLMAdapter.chat).toHaveBeenCalledTimes(5);
  });

  it('handles task payload with non-string message', async () => {
    const task = makePendingTask({
      payload: { data: [1, 2, 3], type: 'array_analysis' },
    });
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    // Should stringify the payload for the user message
    const llmCall = mockLLMAdapter.chat.mock.calls[0];
    const userMessage = llmCall[2][1].content;
    expect(userMessage).toContain('"data"');
    expect(userMessage).toContain('[1,2,3]');
  });

  it('skips task processing when no pending tasks', async () => {
    mockQueryRows.mockResolvedValueOnce([]);

    await runShippedCycle(BASE_CTX);

    expect(mockLLMAdapter.chat).not.toHaveBeenCalled();
  });

  it('marks task as failed when LLM throws', async () => {
    const task = makePendingTask();
    mockQueryRows.mockResolvedValueOnce([task]);
    mockLLMAdapter.chat.mockRejectedValueOnce(new Error('LLM overloaded'));

    await runShippedCycle(BASE_CTX);

    const failedCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'failed'"),
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1]).toEqual(['task-1', 'LLM overloaded']);
  });

  it('marks task as failed when LLM key is unavailable', async () => {
    const { getDecryptedKey } = await import('../../services/api-key.service');
    (getDecryptedKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Key decryption failed'));

    const task = makePendingTask();
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    const failedCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'failed'"),
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1][1]).toContain('LLM API key not available');
  });

  it('continues processing other tasks after one fails', async () => {
    const tasks = [
      makePendingTask({ id: 'task-1' }),
      makePendingTask({ id: 'task-2' }),
    ];
    mockQueryRows.mockResolvedValueOnce(tasks);

    // First LLM call fails, second succeeds
    mockLLMAdapter.chat
      .mockRejectedValueOnce(new Error('Transient error'))
      .mockResolvedValueOnce({
        content: 'Success on task 2.',
        tokens_used: 300,
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
      });

    await runShippedCycle(BASE_CTX);

    // First task failed
    const failedCalls = mockQuery.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'failed'"),
    );
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0][1][0]).toBe('task-1');

    // Second task completed
    const completedCalls = mockQuery.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'completed'"),
    );
    expect(completedCalls.length).toBe(1);
    expect(completedCalls[0][1][0]).toBe('task-2');
  });
});

// =============================================================================
// Callback delivery
// =============================================================================

describe('callback delivery', () => {
  it('delivers callback when task has callback_url', async () => {
    const task = makePendingTask({ callback_url: 'https://requester.test/callback' });
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://requester.test/callback',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('task-1'),
      }),
    );
  });

  it('does not deliver callback when callback_url is null', async () => {
    const task = makePendingTask({ callback_url: null });
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles callback delivery failure gracefully (best-effort)', async () => {
    const task = makePendingTask({ callback_url: 'https://requester.test/callback' });
    mockQueryRows.mockResolvedValueOnce([task]);
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    // Should NOT throw
    await runShippedCycle(BASE_CTX);

    // Task should still be marked completed
    const completedCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'completed'"),
    );
    expect(completedCall).toBeDefined();
  });

  it('callback includes task result with response and tokens', async () => {
    const task = makePendingTask({ callback_url: 'https://requester.test/webhook' });
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.task_id).toBe('task-1');
    expect(body.result.response).toBe('Here is my response.');
    expect(body.result.tokens_used).toBe(500);
    expect(body.result.action).toBe('analyze');
  });
});

// =============================================================================
// Task expiry
// =============================================================================

describe('task expiry', () => {
  it('expires overdue tasks with passed deadlines', async () => {
    await runShippedCycle(BASE_CTX);

    const expiryCalls = mockQuery.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'expired'"),
    );
    expect(expiryCalls.length).toBe(1);
    expect(expiryCalls[0][0]).toContain('deadline IS NOT NULL');
    expect(expiryCalls[0][0]).toContain('deadline < now()');
    expect(expiryCalls[0][1]).toEqual(['bot-1']);
  });
});

// =============================================================================
// Platform cycle scheduling
// =============================================================================

describe('platform cycle scheduling', () => {
  it('schedules platform jobs with utility model', async () => {
    await runShippedCycle(BASE_CTX);

    expect(mockSchedulePlatformJobs).toHaveBeenCalledWith(
      'bot-1', 'user-1', 'key-1', 'claude-haiku-4-5-20251001',
    );
  });

  it('falls back to primary model when fast model is null', async () => {
    await runShippedCycle({ ...BASE_CTX, fastLlmModel: null });

    expect(mockSchedulePlatformJobs).toHaveBeenCalledWith(
      'bot-1', 'user-1', 'key-1', 'claude-opus-4-6',
    );
  });

  it('platform scheduling failure does not break shipped cycle', async () => {
    mockSchedulePlatformJobs.mockRejectedValueOnce(new Error('Redis unavailable'));

    // Should NOT throw
    await runShippedCycle(BASE_CTX);

    // Cycle should still increment
    const incrementCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('cycle_count = cycle_count + 1'),
    );
    expect(incrementCall).toBeDefined();
  });
});

// =============================================================================
// Cycle count increment
// =============================================================================

describe('cycle count increment', () => {
  it('increments cycle count after every shipped cycle', async () => {
    await runShippedCycle(BASE_CTX);

    const incrementCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('cycle_count = cycle_count + 1'),
    );
    expect(incrementCall).toBeDefined();
    expect(incrementCall![0]).toContain('last_cycle_at');
    expect(incrementCall![1]).toEqual(['bot-1']);
  });

  it('increments cycle count even when there are no tasks', async () => {
    mockQueryRows.mockResolvedValueOnce([]);

    await runShippedCycle(BASE_CTX);

    const incrementCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('cycle_count = cycle_count + 1'),
    );
    expect(incrementCall).toBeDefined();
  });
});

// =============================================================================
// Full cycle ordering
// =============================================================================

describe('shipped cycle ordering', () => {
  it('runs steps in correct order: cleanup → tasks → platform → expire → increment', async () => {
    const task = makePendingTask();
    mockQueryRows.mockResolvedValueOnce([task]);

    await runShippedCycle(BASE_CTX);

    const queryTexts = mockQuery.mock.calls.map((c: any[]) => c[0] as string);

    // Find indices of key operations
    const cleanupIdx = queryTexts.findIndex(q => q.includes("INTERVAL '10 minutes'"));
    const processingIdx = queryTexts.findIndex(q => q.includes("status = 'processing'") && q.includes('WHERE id'));
    const completedIdx = queryTexts.findIndex(q => q.includes("status = 'completed'"));
    const expiredIdx = queryTexts.findIndex(q => q.includes("status = 'expired'"));
    const incrementIdx = queryTexts.findIndex(q => q.includes('cycle_count = cycle_count + 1'));

    // Verify ordering
    expect(cleanupIdx).toBeLessThan(processingIdx);
    expect(processingIdx).toBeLessThan(completedIdx);
    expect(completedIdx).toBeLessThan(expiredIdx);
    expect(expiredIdx).toBeLessThan(incrementIdx);
  });
});
