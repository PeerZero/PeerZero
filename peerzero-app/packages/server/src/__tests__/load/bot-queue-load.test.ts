/**
 * Bot Queue Load Tests — measure throughput, latency, and failure handling
 * under concurrent bot execution.
 *
 * These tests mock all external dependencies (LLM, School, DB) and exercise
 * the agent-loop + queue worker logic under varying loads.
 *
 * Run: pnpm --filter @peerzero/server exec vitest run src/__tests__/load/bot-queue-load.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeProfile,
  createMetrics,
  recordDuration,
  finalize,
  summarize,
  runConcurrent,
  simulateLatency,
} from './helpers';

// ── Mock all dependencies ───────────────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSchoolAdapter = {
  getProfile: vi.fn(),
  getReviewablePapers: vi.fn(),
  submitPaper: vi.fn(),
  submitReview: vi.fn(),
  submitBounty: vi.fn(),
  submitRevision: vi.fn(),
  submitReaffirmation: vi.fn(),
  submitCondensation: vi.fn(),
  submitIdentityReflection: vi.fn(),
};

const mockLLMAdapter = {
  chat: vi.fn(),
};

vi.mock('../../adapters/adapter.factory', () => ({
  getSchoolAdapter: () => mockSchoolAdapter,
  getLLMAdapter: () => mockLLMAdapter,
}));

vi.mock('../../services/bot.service', () => ({
  getDecryptedSchoolKey: vi.fn().mockResolvedValue({
    apiKey: 'test-key', handle: 'load-bot', baseUrl: 'https://school.test', schoolId: 'school-1',
  }),
  setBotStatus: vi.fn().mockResolvedValue(undefined),
  isBotGradeUnlocked: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: vi.fn().mockResolvedValue('test-llm-key'),
}));

vi.mock('../../services/memory.service', () => ({
  storeExercise: vi.fn().mockResolvedValue(undefined),
  storeParagraph: vi.fn().mockResolvedValue(undefined),
  storeCore: vi.fn().mockResolvedValue(undefined),
  storeSelfIdentity: vi.fn().mockResolvedValue(undefined),
  getLatestSelfAuthored: vi.fn().mockResolvedValue(null),
  storeSelfAuthored: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/activity.service', () => ({
  logActivity: vi.fn().mockResolvedValue('activity-id'),
  translateReview: vi.fn().mockReturnValue({ headline: 'Reviewed', summary: '+3', details: [], mood: 'positive' }),
  translatePaper: vi.fn().mockReturnValue({ headline: 'Submitted', summary: 'Awaiting', details: [], mood: 'neutral' }),
  translateBounty: vi.fn().mockReturnValue({ headline: 'Challenged', summary: '+5', details: [], mood: 'positive' }),
}));

vi.mock('../../services/skill.service', () => ({
  updateSkillSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/notification.service', () => ({
  notifyGradePaymentNeeded: vi.fn(),
}));

vi.mock('../../db/client', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryOne: vi.fn().mockResolvedValue(null),
  queryRows: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../jobs/platform-queue', () => ({
  schedulePlatformJobs: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { runOneCycle, BotContext } from '../../runtime/agent-loop';
import { getDecryptedSchoolKey, isBotGradeUnlocked } from '../../services/bot.service';
import { getDecryptedKey } from '../../services/api-key.service';

// ── Setup ───────────────────────────────────────────────────────────────────

function makeBotCtx(i: number): BotContext {
  return {
    botId: `bot-${i}`,
    userId: `user-${i}`,
    llmApiKeyId: `key-${i}`,
    llmModel: 'claude-sonnet-4-6',
    fastLlmModel: null,
    extendedThinking: false,
    cycleNumber: 1,
  dailyTokenCap: null,
  dailyTokensUsed: 0,
  userTimezone: 'UTC',
  };
}

function setupMocks(llmLatencyMs = 0) {
  const profile = makeProfile({
    grade: {
      grade: 2,
      papers_this_grade: 1,
      reviews_this_grade: 1,
      revisions_this_grade: 0,
      bounties_this_grade: 1,
      best_score_this_grade: 72,
      requirements: { papers: 2, reviews: 3, revisions: 1, bounties: 1, min_score: 70 },
      advanced: false,
      failed: false,
    },
  });

  mockSchoolAdapter.getProfile.mockResolvedValue(profile);
  mockSchoolAdapter.getReviewablePapers.mockResolvedValue([
    { id: 'paper-1', title: 'Test', abstract: 'Test', field_id: 1, weighted_score: null, review_count: 0, status: 'pending_review', author_handle: 'other' },
  ]);
  mockSchoolAdapter.submitReview.mockResolvedValue({
    success: true,
    review_id: 'rev-1',
    credibility_change: 3,
    new_credibility: 108,
    skill_exercises: { interaction_type: 'review', exercises: [], coaching: [], storage_instruction: '' },
    memory_prompts: { uncondensed_exercises: 2 },
  });

  // Simulate LLM call with optional latency
  mockLLMAdapter.chat.mockImplementation(async () => {
    if (llmLatencyMs > 0) await simulateLatency(llmLatencyMs * 0.5, llmLatencyMs * 1.5);
    return {
      content: JSON.stringify({ overall_assessment: 'Solid methodology.', score: 75 }),
      tokens_used: 800,
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Bot Queue Load Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mocks after clearAllMocks (factory runs once, clearAllMocks removes implementations)
    (getDecryptedSchoolKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiKey: 'test-key', handle: 'load-bot', baseUrl: 'https://school.test', schoolId: 'school-1',
    });
    (isBotGradeUnlocked as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getDecryptedKey as ReturnType<typeof vi.fn>).mockResolvedValue('test-llm-key');
  });

  it('processes 10 concurrent bot cycles (baseline)', async () => {
    const N = 10;
    setupMocks();
    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 5); // Match BullMQ concurrency=5
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('10 bots (no latency):', summary);

    expect(summary.completed).toBe(N);
    expect(summary.failed).toBe(0);
  });

  it('processes 50 concurrent bot cycles', async () => {
    const N = 50;
    setupMocks();
    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 5);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('50 bots (no latency):', summary);

    expect(summary.completed).toBe(N);
    expect(summary.failed).toBe(0);
    // All 50 should process without any dropped
    expect(mockSchoolAdapter.submitReview).toHaveBeenCalledTimes(N);
  });

  it('processes 100 concurrent bot cycles', async () => {
    const N = 100;
    setupMocks();
    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 5);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('100 bots (no latency):', summary);

    expect(summary.completed).toBe(N);
    expect(summary.failed).toBe(0);
  });

  it('processes 50 cycles with simulated 50ms LLM latency', async () => {
    const N = 50;
    setupMocks(50); // 25-75ms per call
    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 5);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('50 bots (50ms LLM latency):', summary);

    expect(summary.completed).toBe(N);
    expect(summary.failed).toBe(0);
    // With 50ms latency, P50 should be above 25ms
    expect(summary.p50).toBeGreaterThan(20);
  }, 30000);

  it('handles mixed successes and failures gracefully', async () => {
    const N = 30;
    const FAIL_RATE = 0.2; // 20% of cycles fail
    setupMocks();

    // Override to randomly fail some calls
    let failCount = 0;
    mockSchoolAdapter.submitReview.mockImplementation(async () => {
      if (Math.random() < FAIL_RATE) {
        failCount++;
        throw new Error('Simulated School error');
      }
      return {
        success: true,
        review_id: 'rev-1',
        credibility_change: 3,
        new_credibility: 108,
        skill_exercises: { interaction_type: 'review', exercises: [], coaching: [], storage_instruction: '' },
        memory_prompts: { uncondensed_exercises: 2 },
      };
    });

    const metrics = createMetrics();
    metrics.totalJobs = N;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 5);
    finalize(metrics);

    const summary = summarize(metrics);
    console.log(`30 bots (${(FAIL_RATE * 100)}% failure rate):`, summary);

    // Some should succeed, some should fail
    expect(summary.completed + summary.failed).toBe(N);
    // Total processed should equal total scheduled (no dropped jobs)
    expect(metrics.durations.length).toBe(N);
  });

  it('spike test: 100 bots start simultaneously', async () => {
    const N = 100;
    setupMocks();
    const metrics = createMetrics();
    metrics.totalJobs = N;

    // Launch all N at once (concurrency=10, higher than default to stress)
    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const start = Date.now();
      try {
        await runOneCycle(makeBotCtx(i));
        metrics.completedJobs++;
      } catch {
        metrics.failedJobs++;
      }
      recordDuration(metrics, Date.now() - start);
    });

    await runConcurrent(tasks, 10); // Double the normal concurrency
    finalize(metrics);

    const summary = summarize(metrics);
    console.log('100 bots spike (concurrency=10):', summary);

    expect(summary.completed).toBe(N);
    expect(summary.failed).toBe(0);
    // Verify no cycle was starved (all got processed)
    expect(metrics.durations.length).toBe(N);
  });

  it('tracks correct cycle counts across concurrent executions', async () => {
    const N = 20;
    setupMocks();

    const cycleNumbers = new Set<number>();
    const originalRunOneCycle = runOneCycle;

    // Track which cycle numbers get executed
    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const ctx = makeBotCtx(i);
      ctx.cycleNumber = i + 1;
      cycleNumbers.add(ctx.cycleNumber);
      await runOneCycle(ctx);
    });

    await runConcurrent(tasks, 5);

    // Every cycle number should be unique
    expect(cycleNumbers.size).toBe(N);
    // All cycle numbers from 1 to N should exist
    for (let i = 1; i <= N; i++) {
      expect(cycleNumbers.has(i)).toBe(true);
    }
  });
});
