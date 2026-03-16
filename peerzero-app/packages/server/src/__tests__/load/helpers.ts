/**
 * Shared helpers for load tests — mock factories, timing utilities, metrics collection.
 */

import type { SchoolProfile } from '@peerzero/shared';

// ── Metrics Collection ──────────────────────────────────────────────────────

export interface LoadMetrics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  durations: number[];
  startTime: number;
  endTime: number;
}

export function createMetrics(): LoadMetrics {
  return {
    totalJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    durations: [],
    startTime: Date.now(),
    endTime: 0,
  };
}

export function recordDuration(metrics: LoadMetrics, durationMs: number): void {
  metrics.durations.push(durationMs);
}

export function finalize(metrics: LoadMetrics): void {
  metrics.endTime = Date.now();
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function summarize(metrics: LoadMetrics): {
  total: number;
  completed: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  avgMs: number;
  totalTimeMs: number;
  throughput: string;
} {
  const avg = metrics.durations.length > 0
    ? metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length
    : 0;
  const totalTime = metrics.endTime - metrics.startTime;
  const throughput = totalTime > 0
    ? (metrics.completedJobs / (totalTime / 1000)).toFixed(2)
    : '0';

  return {
    total: metrics.totalJobs,
    completed: metrics.completedJobs,
    failed: metrics.failedJobs,
    p50: percentile(metrics.durations, 50),
    p95: percentile(metrics.durations, 95),
    p99: percentile(metrics.durations, 99),
    avgMs: Math.round(avg),
    totalTimeMs: totalTime,
    throughput: `${throughput} jobs/sec`,
  };
}

// ── Profile Factory ─────────────────────────────────────────────────────────

export function makeProfile(overrides: Partial<SchoolProfile> = {}): SchoolProfile {
  return {
    agent: {
      id: 'agent-1',
      handle: 'load-test-bot',
      credibility_score: 105,
      total_papers_submitted: 2,
      registration_review_passed: true,
    },
    tier_info: 'Tested Reasoner',
    next_action: 'Submit a paper or review.',
    can_submit_paper: true,
    can_revise: false,
    reviews_completed: 3,
    valid_bounties: 1,
    original_papers_submitted: 2,
    revisions_submitted: 0,
    coaching: { failure_patterns: [], quality_trajectory: 'improving', honest_gaps: [] },
    active_focus: { focus_chunks: [], focus_instruction: '' },
    skill_profile: {
      verified: [{ name: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', strength: 0.7, reliability: 0.8, reps: 10, streak: 3 }],
      developing: [{ name: 'Source Evaluation', skill_key: 'source_evaluation', strength: 0.4, reliability: 0.5, reps: 3, streak: 1 }],
    },
    skill_condenser: null,
    core_condenser: null,
    identity_core: null,
    identity_reflection: null,
    grade: {
      grade: 2,
      papers_this_grade: 1,
      reviews_this_grade: 2,
      revisions_this_grade: 0,
      bounties_this_grade: 1,
      best_score_this_grade: 72,
      requirements: { papers: 2, reviews: 3, revisions: 1, bounties: 1, min_score: 70 },
      advanced: false,
      failed: false,
    },
    recent_feedback: { reviews_on_your_papers: [], storage_instruction: '' },
    can_reaffirm: false,
    ...overrides,
  } as SchoolProfile;
}

// ── Concurrency Runner ──────────────────────────────────────────────────────

/**
 * Run N async tasks with bounded concurrency.
 * Returns when all tasks are done.
 */
export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then(r => { results.push(r); }).catch(err => { results.push(err); });
    executing.add(p);
    const cleanup = p.then(() => executing.delete(p));

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

/**
 * Simulate variable latency (like a real LLM API call).
 */
export function simulateLatency(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}
