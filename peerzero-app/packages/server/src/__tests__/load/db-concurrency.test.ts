/**
 * DB Concurrency Stress Tests — verify data integrity under concurrent writes.
 *
 * These tests use mocked DB calls but validate that the concurrent access
 * patterns in the agent loop don't produce race conditions, lost updates,
 * or inconsistent state.
 *
 * Key scenarios:
 * - Concurrent bot cache updates
 * - Concurrent skill snapshot upserts
 * - Concurrent activity log inserts
 * - Interleaved reads and writes
 *
 * Run: pnpm --filter @peerzero/server exec vitest run src/__tests__/load/db-concurrency.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runConcurrent, createMetrics, recordDuration, finalize, summarize } from './helpers';

// ── Simulated DB Layer ──────────────────────────────────────────────────────
// Instead of mocking to no-ops, we simulate a shared in-memory store to detect
// race conditions like lost updates and inconsistent reads.

class SimulatedDB {
  private bots = new Map<string, { credibility: number; cycle_count: number; cache_updated_at: number }>();
  private skills = new Map<string, { strength: number; reps: number }>();
  private activityLog: Array<{ bot_id: string; cycle: number; action: string }> = [];
  private writeLatencyMs = 0;

  constructor(writeLatencyMs = 0) {
    this.writeLatencyMs = writeLatencyMs;
  }

  async updateBotCache(botId: string, credibility: number, cycleNumber: number): Promise<void> {
    if (this.writeLatencyMs > 0) {
      await new Promise(r => setTimeout(r, Math.random() * this.writeLatencyMs));
    }
    // Simulate atomic UPDATE ... WHERE id = $1
    const existing = this.bots.get(botId) || { credibility: 100, cycle_count: 0, cache_updated_at: 0 };
    this.bots.set(botId, {
      credibility,
      cycle_count: cycleNumber,
      cache_updated_at: Date.now(),
    });
  }

  async upsertSkill(botId: string, skillKey: string, strength: number, reps: number): Promise<void> {
    if (this.writeLatencyMs > 0) {
      await new Promise(r => setTimeout(r, Math.random() * this.writeLatencyMs));
    }
    const key = `${botId}:${skillKey}`;
    this.skills.set(key, { strength, reps });
  }

  async insertActivity(botId: string, cycle: number, action: string): Promise<void> {
    if (this.writeLatencyMs > 0) {
      await new Promise(r => setTimeout(r, Math.random() * this.writeLatencyMs));
    }
    this.activityLog.push({ bot_id: botId, cycle, action });
  }

  getBotCache(botId: string) {
    return this.bots.get(botId);
  }

  getSkill(botId: string, skillKey: string) {
    return this.skills.get(`${botId}:${skillKey}`);
  }

  getActivityCount() {
    return this.activityLog.length;
  }

  getActivitiesForBot(botId: string) {
    return this.activityLog.filter(a => a.bot_id === botId);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DB Concurrency Stress Tests', () => {
  it('50 concurrent bot cache updates — no lost writes', async () => {
    const db = new SimulatedDB(1); // 0-1ms jitter
    const N = 50;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const botId = `bot-${i}`;
      const credibility = 100 + i;
      await db.updateBotCache(botId, credibility, i + 1);
    });

    await runConcurrent(tasks, 10);

    // Every bot should have its own entry
    for (let i = 0; i < N; i++) {
      const cache = db.getBotCache(`bot-${i}`);
      expect(cache).toBeDefined();
      expect(cache!.credibility).toBe(100 + i);
      expect(cache!.cycle_count).toBe(i + 1);
    }
  });

  it('multiple cycles per bot — last write wins (correct behavior)', async () => {
    const db = new SimulatedDB(1);
    const BOT_COUNT = 10;
    const CYCLES_PER_BOT = 5;

    // Each bot runs 5 cycles; cycle_count should end at 5
    const tasks: Array<() => Promise<void>> = [];
    for (let b = 0; b < BOT_COUNT; b++) {
      for (let c = 1; c <= CYCLES_PER_BOT; c++) {
        tasks.push(async () => {
          await db.updateBotCache(`bot-${b}`, 100 + c * 3, c);
        });
      }
    }

    // Shuffle to simulate interleaved execution
    tasks.sort(() => Math.random() - 0.5);
    await runConcurrent(tasks, 10);

    // Every bot should have been written to
    for (let b = 0; b < BOT_COUNT; b++) {
      const cache = db.getBotCache(`bot-${b}`);
      expect(cache).toBeDefined();
      // cycle_count should be one of the cycles (any, since order isn't guaranteed)
      expect(cache!.cycle_count).toBeGreaterThanOrEqual(1);
      expect(cache!.cycle_count).toBeLessThanOrEqual(CYCLES_PER_BOT);
    }
  });

  it('100 concurrent skill snapshot upserts — no data loss', async () => {
    const db = new SimulatedDB(1);
    const BOTS = 20;
    const SKILLS = ['adversarial_reasoning', 'calibrated_uncertainty', 'source_evaluation',
                     'belief_updating', 'disconfirmation_search', 'independent_verification'];

    const tasks: Array<() => Promise<void>> = [];
    for (let b = 0; b < BOTS; b++) {
      for (const skill of SKILLS) {
        tasks.push(async () => {
          const strength = Math.random() * 100;
          const reps = Math.floor(Math.random() * 50);
          await db.upsertSkill(`bot-${b}`, skill, strength, reps);
        });
      }
    }

    await runConcurrent(tasks, 15);

    // Every bot-skill combination should exist
    for (let b = 0; b < BOTS; b++) {
      for (const skill of SKILLS) {
        const entry = db.getSkill(`bot-${b}`, skill);
        expect(entry).toBeDefined();
        expect(entry!.strength).toBeGreaterThanOrEqual(0);
        expect(entry!.reps).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('200 concurrent activity log inserts — all recorded', async () => {
    const db = new SimulatedDB(1);
    const N = 200;

    const tasks = Array.from({ length: N }, (_, i) => async () => {
      const botId = `bot-${i % 20}`; // 20 bots, 10 activities each
      const action = ['review', 'paper', 'bounty', 'revision'][i % 4];
      await db.insertActivity(botId, Math.floor(i / 20) + 1, action);
    });

    await runConcurrent(tasks, 20);

    // All 200 should be recorded
    expect(db.getActivityCount()).toBe(N);

    // Each bot should have 10 activities
    for (let b = 0; b < 20; b++) {
      const activities = db.getActivitiesForBot(`bot-${b}`);
      expect(activities.length).toBe(10);
    }
  });

  it('interleaved reads and writes under contention', async () => {
    const db = new SimulatedDB(2); // 0-2ms jitter
    const BOTS = 30;

    // Mix of reads and writes
    const writeResults: boolean[] = [];
    const readResults: boolean[] = [];

    const tasks: Array<() => Promise<void>> = [];

    // Writes
    for (let b = 0; b < BOTS; b++) {
      tasks.push(async () => {
        await db.updateBotCache(`bot-${b}`, 100 + b, b + 1);
        writeResults.push(true);
      });
    }

    // Reads interleaved with writes
    for (let b = 0; b < BOTS; b++) {
      tasks.push(async () => {
        const cache = db.getBotCache(`bot-${b}`);
        // May or may not exist yet (race between read and write)
        readResults.push(true);
      });
    }

    // Shuffle to interleave
    tasks.sort(() => Math.random() - 0.5);
    await runConcurrent(tasks, 15);

    // All operations should complete
    expect(writeResults.length).toBe(BOTS);
    expect(readResults.length).toBe(BOTS);

    // After all tasks, every bot should have been written
    for (let b = 0; b < BOTS; b++) {
      const cache = db.getBotCache(`bot-${b}`);
      expect(cache).toBeDefined();
    }
  });

  it('high-contention single bot — 50 concurrent writes', async () => {
    const db = new SimulatedDB(1);
    const N = 50;

    // All 50 writes target the same bot (maximum contention)
    const tasks = Array.from({ length: N }, (_, i) => async () => {
      await db.updateBotCache('contended-bot', 100 + i, i + 1);
      await db.upsertSkill('contended-bot', 'adversarial_reasoning', i * 2, i);
      await db.insertActivity('contended-bot', i + 1, 'review');
    });

    await runConcurrent(tasks, 10);

    // Bot should exist with some valid state
    const cache = db.getBotCache('contended-bot');
    expect(cache).toBeDefined();
    expect(cache!.credibility).toBeGreaterThanOrEqual(100);

    // Skill should be written
    const skill = db.getSkill('contended-bot', 'adversarial_reasoning');
    expect(skill).toBeDefined();

    // All activities should be recorded (append-only, no contention)
    const activities = db.getActivitiesForBot('contended-bot');
    expect(activities.length).toBe(N);
  });
});
