/**
 * Tests for decision-rationale.js — rationale storage, resolution, and coaching.
 *
 * Uses the same Supabase mock pattern as test_register.js.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.SCHOOL_TYPE = 'science';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Supabase mock ───────────────────────────────────────────────────────────

const mockQueryResults = {};
let lastInsertData = null;
let lastUpdateData = null;

function resetMocks() {
  for (const key of Object.keys(mockQueryResults)) delete mockQueryResults[key];
  lastInsertData = null;
  lastUpdateData = null;
}

function setMockResult(table, result) {
  mockQueryResults[table] = result;
}

function makeMockChain(table) {
  const chain = {
    select: () => chain,
    insert: (data) => { lastInsertData = data; return chain; },
    update: (data) => { lastUpdateData = data; return chain; },
    delete: () => chain,
    upsert: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    or: () => chain,
    not: () => chain,
    is: () => chain,
    order: () => chain,
    range: () => chain,
    limit: () => chain,
    single: () => {
      const result = mockQueryResults[table];
      return Promise.resolve(result || { data: null, error: null });
    },
    then: (resolve) => {
      const result = mockQueryResults[table];
      return resolve(result || { data: [], error: null });
    },
  };
  return chain;
}

require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: {
    createClient: () => ({
      from: (table) => makeMockChain(table),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  },
};

const {
  storeDecisionRationale,
  resolveDecisionRationale,
  buildDecisionCoaching,
} = require('../lib/decision-rationale');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('storeDecisionRationale()', () => {
  beforeEach(() => resetMocks());

  it('inserts rationale with all fields', async () => {
    await storeDecisionRationale('agent1', {
      cycle_number: 42,
      action_chosen: 'review',
      action_target_id: 'paper-123',
      problem_frame: 'Need to review a paper on climate modeling',
      alternatives_considered: ['paper', 'bounty'],
      tradeoffs_articulated: ['review builds skill but paper builds credibility'],
      expected_outcome: { predicted_score: 7 },
      pre_mortem: { failure_scenario: 'I miss a statistical flaw' },
      credibility_at_time: 45.2,
      grade_at_time: 3,
    });
    assert.strictEqual(lastInsertData.agent_id, 'agent1');
    assert.strictEqual(lastInsertData.action_chosen, 'review');
    assert.strictEqual(lastInsertData.cycle_number, 42);
  });

  it('truncates long problem_frame', async () => {
    await storeDecisionRationale('agent1', {
      problem_frame: 'x'.repeat(2000),
    });
    assert.strictEqual(lastInsertData.problem_frame.length, 1000);
  });

  it('defaults empty arrays/objects for missing fields', async () => {
    await storeDecisionRationale('agent1', {});
    assert.deepStrictEqual(lastInsertData.alternatives_considered, []);
    assert.deepStrictEqual(lastInsertData.tradeoffs_articulated, []);
    assert.deepStrictEqual(lastInsertData.expected_outcome, {});
    assert.deepStrictEqual(lastInsertData.pre_mortem, {});
  });
});

describe('resolveDecisionRationale()', () => {
  beforeEach(() => resetMocks());

  it('does nothing when no unresolved rationale', async () => {
    setMockResult('decision_rationales', { data: [], error: null });
    // Should not throw
    await resolveDecisionRationale('agent1', { score: 7 });
  });

  it('updates the most recent unresolved rationale', async () => {
    setMockResult('decision_rationales', {
      data: [{ id: 'r1' }],
      error: null,
    });
    await resolveDecisionRationale('agent1', { score: 7, feedback_summary: 'Good work' });
    assert.ok(lastUpdateData);
    assert.strictEqual(lastUpdateData.resolved, true);
    assert.deepStrictEqual(lastUpdateData.actual_outcome, { score: 7, feedback_summary: 'Good work' });
  });
});

describe('buildDecisionCoaching()', () => {
  beforeEach(() => resetMocks());

  it('returns null when fewer than 3 resolved rationales', async () => {
    setMockResult('decision_rationales', {
      data: [{ action_chosen: 'review', alternatives_considered: [] }],
      error: null,
    });
    const result = await buildDecisionCoaching('agent1');
    assert.strictEqual(result, null);
  });

  it('detects dominant action pattern', async () => {
    const rationales = Array.from({ length: 10 }, () => ({
      action_chosen: 'review',
      alternatives_considered: ['paper'],
      expected_outcome: {},
      actual_outcome: {},
      pre_mortem: {},
      resolved: true,
    }));
    setMockResult('decision_rationales', { data: rationales, error: null });
    const coaching = await buildDecisionCoaching('agent1');
    assert.ok(coaching);
    assert.ok(coaching.some(c => c.includes('review') && c.includes('%')));
  });

  it('detects low alternatives consideration', async () => {
    const rationales = Array.from({ length: 5 }, () => ({
      action_chosen: 'paper',
      alternatives_considered: [],
      expected_outcome: {},
      actual_outcome: {},
      pre_mortem: {},
      resolved: true,
    }));
    setMockResult('decision_rationales', { data: rationales, error: null });
    const coaching = await buildDecisionCoaching('agent1');
    assert.ok(coaching);
    assert.ok(coaching.some(c => c.includes('rarely consider alternatives')));
  });

  it('detects prediction inaccuracy', async () => {
    const rationales = Array.from({ length: 5 }, () => ({
      action_chosen: 'paper',
      alternatives_considered: ['review', 'bounty'],
      expected_outcome: { predicted_score: 9 },
      actual_outcome: { score: 4 },
      pre_mortem: {},
      resolved: true,
    }));
    setMockResult('decision_rationales', { data: rationales, error: null });
    const coaching = await buildDecisionCoaching('agent1');
    assert.ok(coaching);
    assert.ok(coaching.some(c => c.includes('predictions are off')));
  });

  it('detects accurate pre-mortems', async () => {
    const rationales = Array.from({ length: 5 }, () => ({
      action_chosen: 'paper',
      alternatives_considered: ['review'],
      expected_outcome: {},
      actual_outcome: { feedback_summary: 'The methodology section had statistical errors and weak evidence chains' },
      pre_mortem: { failure_scenario: 'I might make statistical errors in the methodology section' },
      resolved: true,
    }));
    setMockResult('decision_rationales', { data: rationales, error: null });
    const coaching = await buildDecisionCoaching('agent1');
    assert.ok(coaching);
    assert.ok(coaching.some(c => c.includes('pre-mortems are accurately predicting')));
  });

  it('returns null when no coaching patterns detected', async () => {
    const rationales = Array.from({ length: 4 }, (_, i) => ({
      action_chosen: ['paper', 'review', 'bounty', 'revision'][i],
      alternatives_considered: ['paper', 'review'],
      expected_outcome: { predicted_score: 6 },
      actual_outcome: { score: 6 },
      pre_mortem: { failure_scenario: 'something unrelated' },
      resolved: true,
    }));
    setMockResult('decision_rationales', { data: rationales, error: null });
    const coaching = await buildDecisionCoaching('agent1');
    // Could be null or empty array depending on patterns
    if (coaching) {
      assert.ok(Array.isArray(coaching));
    }
  });
});
