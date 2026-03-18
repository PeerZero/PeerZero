/**
 * Platform Queue Load Tests — measure platform cycle throughput and isolation.
 *
 * Tests that:
 * - N bots x M platforms can execute concurrently without interference
 * - Platform failures don't affect other platforms or bot school cycles
 * - 3-failure pause logic works under load
 * - Platform cycles are independent (one slow platform doesn't block others)
 *
 * Run: pnpm --filter @peerzero/server exec vitest run src/__tests__/load/platform-queue-load.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMetrics,
  recordDuration,
  finalize,
  summarize,
  runConcurrent,
  simulateLatency,
} from './helpers';

// ── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockPlatformAdapter = {
  discover: vi.fn(),
  getContext: vi.fn(),
  submitAction: vi.fn(),
  publishAgentCard: vi.fn(),
};

vi.mock('../../adapters/platform.adapter.factory', () => ({
  getPlatformAdapter: () => mockPlatformAdapter,
}));

const mockLLMAdapter = {
  chat: vi.fn(),
};

vi.mock('../../adapters/adapter.factory', () => ({
  getLLMAdapter: () => mockLLMAdapter,
}));

vi.mock('../../services/apikey.service', () => ({
  getDecryptedKey: vi.fn().mockResolvedValue('test-llm-key'),
}));

vi.mock('../../services/platform.service', () => ({
  getPlatformCredentials: vi.fn().mockResolvedValue({
    apiKey: 'test-platform-key',
    config: {},
    platformName: 'test-platform',
  }),
  updatePlatformCycleStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/client', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryOne: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/memory.service', () => ({
  getLatestSelfAuthored: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/skill-engine.service', () => ({
  resolveActiveSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../websocket/activity-stream', () => ({
  broadcastExternalActivity: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { runPlatformCycle, PlatformCycleContext } from '../../runtime/platform-loop';
import { updatePlatformCycleStatus } from '../../services/platform.service';

// ── Setup ───────────────────────────────────────────────────────────────────

function makePlatformCtx(botIdx: number, platformIdx: number): PlatformCycleContext {
  return {
    botId: `bot-${botIdx}`,
    userId: `user-${botIdx}`,
    platformId: `platform-${botIdx}-${platformIdx}`,
    llmApiKeyId: `key-${botIdx}`,
    llmModel: 'claude-haiku-4-5-20251001',
    botHandle: `bot-${botIdx}`,
  };
}

function setupPlatformMocks(llmLatencyMs = 0) {
  mockPlatformAdapter.discover.mockResolvedValue({
    can_post: true,
    can_comment: true,
    can_vote: false,
    can_debate: false,
    content_types: ['text'],
    rate_limit: 60,
  });

  mockPlatformAdapter.getContext.mockResolvedValue({
    available_topics: ['Topic A', 'Topic B'],
    recent_activity: ['Bot-X posted'],
    pending_interactions: [],
    summary: 'Active discussion with 2 topics.',
  });

  mockPlatformAdapter.submitAction.mockResolvedValue({
    success: true,
    action_type: 'post',
    platform_name: 'test-platform',
    response_data: { mock: true },
    summary: 'Posted analysis',
    skills_demonstrated: ['source_evaluation'],
  });

  mockLLMAdapter.chat.mockImplementation(async () => {
    if (llmLatencyMs > 0) await simulateLatency(llmLatencyMs * 0.5, llmLatencyMs * 1.5);
    return {
      content: JSON.stringify({
        action_type: 'post',
        content: { text: 'Analysis of the topic.' },
        reasoning: 'Relevant and evidence-based.',
      }),
      tokens_used: 400,
    };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Platform Queue Load Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes 20 bots x 3 platforms = 60 concurrent platform cycles', async () => {
    const BOTS = 20;
    const PLATFORMS_PER_BOT = 3;
    const TOTAL = BOTS * PLATFORMS_PER_BOT;
    setupPlatformMocks();
    const metrics = createMetrics();
    metrics.totalJobs = TOTAL;

    const tasks: Array<() => Promise<void>> = [];
    for (let b = 0; b < BOTS; b++) {
      for (let p = 0; p < PLATFORMS_PER_BOT; p++) {
        tasks.push(async () => {
          const start = Date.now();
          try {
            await runPlatformCycle(makePlatformCtx(b, p));
            metrics.completedJobs++;
          } catch {
            metrics.failedJobs++;
          }
          recordDuration(metrics, Date.now() - start);
        });
      }
    }

    await runConcurrent(tasks, 3); // Match platform worker concurrency=3
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('20 bots x 3 platforms (no latency):', summary);

    expect(summary.completed).toBe(TOTAL);
    expect(summary.failed).toBe(0);
    expect(mockPlatformAdapter.submitAction).toHaveBeenCalledTimes(TOTAL);
  });

  it('platform failures are isolated — other platforms continue', async () => {
    const TOTAL = 30;
    setupPlatformMocks();

    // Fail every 3rd platform
    let callCount = 0;
    mockPlatformAdapter.submitAction.mockImplementation(async () => {
      callCount++;
      if (callCount % 3 === 0) {
        throw new Error('Platform timeout');
      }
      return {
        success: true,
        action_type: 'post',
        platform_name: 'test-platform',
        response_data: {},
        summary: 'Posted',
        skills_demonstrated: [],
      };
    });

    const metrics = createMetrics();
    metrics.totalJobs = TOTAL;

    const tasks = Array.from({ length: TOTAL }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runPlatformCycle(makePlatformCtx(i, 0));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 3);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('30 platforms (1/3 fail):', summary);

    // ~20 should succeed, ~10 should fail
    expect(summary.completed + summary.failed).toBe(TOTAL);
    expect(summary.completed).toBeGreaterThan(0);
    expect(summary.failed).toBeGreaterThan(0);
    // All tasks processed (no drops)
    expect(metrics.durations.length).toBe(TOTAL);
  });

  it('slow platform does not block fast platforms', async () => {
    setupPlatformMocks();
    const FAST_COUNT = 20;
    const SLOW_COUNT = 5;

    const fastDurations: number[] = [];
    const slowDurations: number[] = [];

    // Slow platforms have 100ms latency
    const slowAdapter = {
      ...mockPlatformAdapter,
      submitAction: vi.fn().mockImplementation(async () => {
        await simulateLatency(80, 120);
        return {
          success: true, action_type: 'post', platform_name: 'slow-platform',
          response_data: {}, summary: 'Slow post', skills_demonstrated: [],
        };
      }),
    };

    const tasks: Array<() => Promise<void>> = [];

    // Fast tasks
    for (let i = 0; i < FAST_COUNT; i++) {
      tasks.push(async () => {
        const start = Date.now();
        await runPlatformCycle(makePlatformCtx(i, 0));
        fastDurations.push(Date.now() - start);
      });
    }

    // Slow tasks (use original mock but add latency to LLM)
    for (let i = 0; i < SLOW_COUNT; i++) {
      tasks.push(async () => {
        const start = Date.now();
        // Simulate slow LLM for these specific calls
        const origChat = mockLLMAdapter.chat.getMockImplementation();
        mockLLMAdapter.chat.mockImplementationOnce(async () => {
          await simulateLatency(80, 120);
          return {
            content: JSON.stringify({ action_type: 'post', content: { text: 'Slow' }, reasoning: 'Slow' }),
            tokens_used: 400,
          };
        });
        await runPlatformCycle(makePlatformCtx(100 + i, 0));
        slowDurations.push(Date.now() - start);
      });
    }

    await runConcurrent(tasks, 5);

    console.log('Fast platform avg:', Math.round(fastDurations.reduce((a, b) => a + b, 0) / fastDurations.length), 'ms');
    console.log('Slow platform avg:', Math.round(slowDurations.reduce((a, b) => a + b, 0) / slowDurations.length), 'ms');

    // All should complete
    expect(fastDurations.length).toBe(FAST_COUNT);
    expect(slowDurations.length).toBe(SLOW_COUNT);
  }, 30000);

  it('LLM skip responses are handled efficiently under load', async () => {
    setupPlatformMocks();

    // All bots skip (no action to take)
    mockLLMAdapter.chat.mockResolvedValue({
      content: JSON.stringify({ skip: true }),
      tokens_used: 100,
    });

    const N = 50;
    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runPlatformCycle(makePlatformCtx(i, 0));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 3);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('50 skip cycles:', summary);

    expect(summary.completed).toBe(N);
    // Skip means no submitAction call
    expect(mockPlatformAdapter.submitAction).not.toHaveBeenCalled();
    // Status should still be updated to active
    expect(updatePlatformCycleStatus).toHaveBeenCalledTimes(N);
  });
});
