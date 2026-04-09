/**
 * Tests for forge-hypotheses.js — hypothesis storage, cycle advancement,
 * resolution, and coaching pattern generation.
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
  storeForgeHypotheses,
  advanceHypothesisCycles,
  resolveHypothesis,
  getPendingHypotheses,
  getResolvedHypotheses,
  buildHypothesisSummary,
} = require('../lib/forge-hypotheses');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('storeForgeHypotheses()', () => {
  beforeEach(() => resetMocks());

  it('returns empty array for null/undefined hypotheses', async () => {
    assert.deepStrictEqual(await storeForgeHypotheses('agent1', 'paper1', null), []);
    assert.deepStrictEqual(await storeForgeHypotheses('agent1', 'paper1', undefined), []);
  });

  it('returns empty array for empty array', async () => {
    assert.deepStrictEqual(await storeForgeHypotheses('agent1', 'paper1', []), []);
  });

  it('returns empty array for non-array input', async () => {
    assert.deepStrictEqual(await storeForgeHypotheses('agent1', 'paper1', 'not-an-array'), []);
  });

  it('inserts valid hypotheses and returns data', async () => {
    setMockResult('forge_hypotheses', {
      data: { id: 'h1', claim: 'test claim', status: 'pending' },
      error: null,
    });
    const result = await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'I rush conclusions', testable_prediction: 'I will rush next time', confidence: 0.7 },
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(lastInsertData.agent_id, 'agent1');
    assert.strictEqual(lastInsertData.source_forge_paper_id, 'paper1');
  });

  it('skips hypotheses without claim or testable_prediction', async () => {
    setMockResult('forge_hypotheses', {
      data: { id: 'h1' },
      error: null,
    });
    const result = await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'test' },  // missing testable_prediction
      { testable_prediction: 'test' },  // missing claim
      { claim: 'valid', testable_prediction: 'prediction' },  // valid
    ]);
    assert.strictEqual(result.length, 1);
  });

  it('limits to 5 hypotheses max', async () => {
    setMockResult('forge_hypotheses', {
      data: { id: 'h1' },
      error: null,
    });
    const hypotheses = Array.from({ length: 10 }, (_, i) => ({
      claim: `claim ${i}`, testable_prediction: `prediction ${i}`,
    }));
    const result = await storeForgeHypotheses('agent1', 'paper1', hypotheses);
    assert.strictEqual(result.length, 5);
  });

  it('clamps confidence to 0-1', async () => {
    setMockResult('forge_hypotheses', {
      data: { id: 'h1' },
      error: null,
    });
    await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'c', testable_prediction: 'p', confidence: 5.0 },
    ]);
    assert.strictEqual(lastInsertData.confidence, 1);
  });

  it('clamps cycles_to_resolve to 3-20', async () => {
    setMockResult('forge_hypotheses', {
      data: { id: 'h1' },
      error: null,
    });
    await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'c', testable_prediction: 'p', cycles_to_resolve: 1 },
    ]);
    assert.strictEqual(lastInsertData.cycles_to_resolve, 3);

    await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'c', testable_prediction: 'p', cycles_to_resolve: 100 },
    ]);
    assert.strictEqual(lastInsertData.cycles_to_resolve, 20);
  });

  it('truncates long strings', async () => {
    setMockResult('forge_hypotheses', { data: { id: 'h1' }, error: null });
    await storeForgeHypotheses('agent1', 'paper1', [
      { claim: 'x'.repeat(1000), testable_prediction: 'y'.repeat(1000) },
    ]);
    assert.strictEqual(lastInsertData.claim.length, 500);
    assert.strictEqual(lastInsertData.testable_prediction.length, 500);
  });
});

describe('advanceHypothesisCycles()', () => {
  beforeEach(() => resetMocks());

  it('returns empty array when no pending hypotheses', async () => {
    setMockResult('forge_hypotheses', { data: [], error: null });
    const expired = await advanceHypothesisCycles('agent1');
    assert.deepStrictEqual(expired, []);
  });

  it('returns IDs of hypotheses that reached their cycle target', async () => {
    setMockResult('forge_hypotheses', {
      data: [
        { id: 'h1', cycles_to_resolve: 5, cycles_elapsed: 4 },  // will expire (4+1 >= 5)
        { id: 'h2', cycles_to_resolve: 10, cycles_elapsed: 2 },  // won't expire
      ],
      error: null,
    });
    const expired = await advanceHypothesisCycles('agent1');
    assert.ok(expired.includes('h1'));
    assert.ok(!expired.includes('h2'));
  });
});

describe('getPendingHypotheses()', () => {
  beforeEach(() => resetMocks());

  it('returns empty array when no data', async () => {
    const result = await getPendingHypotheses('agent1');
    assert.deepStrictEqual(result, []);
  });

  it('returns pending hypotheses', async () => {
    setMockResult('forge_hypotheses', {
      data: [{ id: 'h1', claim: 'test', status: 'pending' }],
      error: null,
    });
    const result = await getPendingHypotheses('agent1');
    assert.strictEqual(result.length, 1);
  });
});

describe('buildHypothesisSummary()', () => {
  beforeEach(() => resetMocks());

  it('returns null when no hypotheses exist', async () => {
    const result = await buildHypothesisSummary('agent1');
    assert.strictEqual(result, null);
  });

  it('returns summary with counts when data exists', async () => {
    setMockResult('forge_hypotheses', {
      data: [
        { id: 'h1', claim: 'test', cycles_to_resolve: 5, cycles_elapsed: 2 },
      ],
      error: null,
    });
    const result = await buildHypothesisSummary('agent1');
    assert.ok(result);
    // Since both getPending and getResolved hit the same mock, both get data
    assert.ok(result.pending_count >= 0);
  });
});
