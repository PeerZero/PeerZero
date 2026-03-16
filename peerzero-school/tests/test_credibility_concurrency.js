/**
 * Concurrency test for atomic credibility adjustments.
 *
 * This test verifies that concurrent credibility updates don't lose data.
 * It fires N parallel adjustments against the same agent and checks that
 * the final credibility equals start + (N × delta), not start + delta.
 *
 * Prerequisites:
 *   - Migration 015_atomic_credibility.sql must be applied
 *   - SUPABASE_URL and SUPABASE_SERVICE_KEY env vars must be set
 *   - A test agent must exist (or set TEST_AGENT_ID)
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_concurrency.js
 *
 * To run against a local Supabase:
 *   SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=... node tests/test_credibility_concurrency.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TEST_AGENT_ID = process.env.TEST_AGENT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.');
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_concurrency.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} (expected ${expected}, got ${actual}, diff ${diff.toFixed(4)})`);
}

// ── Find or create a test agent ──────────────────────────────────────────────

async function getTestAgent() {
  if (TEST_AGENT_ID) {
    const { data } = await supabase.from('agents').select('id, credibility_score').eq('id', TEST_AGENT_ID).single();
    if (data) return data;
    console.error(`TEST_AGENT_ID ${TEST_AGENT_ID} not found in database.`);
    process.exit(1);
  }

  // Find any non-banned agent to use as test subject
  const { data: agents } = await supabase
    .from('agents')
    .select('id, credibility_score')
    .eq('is_banned', false)
    .limit(1);

  if (agents && agents.length > 0) return agents[0];

  console.error('No agents found in database. Set TEST_AGENT_ID or create a test agent.');
  process.exit(1);
}

// ── Test 1: Atomic RPC function exists and works ─────────────────────────────

async function testRpcExists(agentId) {
  console.log('\nTest 1: adjust_credibility RPC function works');

  const { data, error } = await supabase.rpc('adjust_credibility', {
    p_agent_id: agentId,
    p_delta: 0, // no-op increment
  });

  assert(!error, `RPC call succeeds without error${error ? ': ' + error.message : ''}`);
  assert(data != null, `RPC returns a numeric result (got ${data})`);
}

// ── Test 2: Single increment is correct ──────────────────────────────────────

async function testSingleIncrement(agentId) {
  console.log('\nTest 2: Single credibility increment is correct');

  // Read current value
  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Apply +0.3
  const { data: result } = await supabase.rpc('adjust_credibility', {
    p_agent_id: agentId,
    p_delta: 0.3,
  });

  const afterCred = parseFloat(result);
  assertApprox(afterCred, startCred + 0.3, 0.01, 'Credibility increased by exactly 0.3');

  // Undo the change
  await supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -0.3 });
}

// ── Test 3: Concurrent increments don't lose updates ─────────────────────────

async function testConcurrentIncrements(agentId) {
  console.log('\nTest 3: Concurrent increments preserve all updates');

  const N = 10;         // number of parallel requests
  const delta = 0.3;    // each request adds this much
  const expectedTotal = N * delta; // should be 3.0

  // Read starting value
  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Fire N parallel increments
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(
      supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta })
    );
  }
  const results = await Promise.all(promises);

  // Check all succeeded
  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `All ${N} concurrent RPCs succeeded (${errors.length} errors)`);

  // Read final value
  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);

  const actualChange = endCred - startCred;
  assertApprox(actualChange, expectedTotal, 0.01,
    `Total change is ${expectedTotal} (${N} × ${delta}), not ${delta} (which would mean updates were lost)`
  );

  // Undo all changes
  await supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -expectedTotal });

  // Verify we're back to start
  const { data: restored } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  assertApprox(parseFloat(restored.credibility_score), startCred, 0.01, 'Credibility restored to starting value');
}

// ── Test 4: Clamping at boundaries ───────────────────────────────────────────

async function testBoundaryClamping(agentId) {
  console.log('\nTest 4: Credibility clamped to [0, 200] range');

  // Read current
  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Try to go above 200
  const bigDelta = 300 - startCred;
  const { data: maxResult } = await supabase.rpc('adjust_credibility', {
    p_agent_id: agentId,
    p_delta: bigDelta,
  });
  assert(parseFloat(maxResult) <= 200, `Cannot exceed 200 (got ${maxResult})`);

  // Try to go below 0
  const { data: minResult } = await supabase.rpc('adjust_credibility', {
    p_agent_id: agentId,
    p_delta: -500,
  });
  assert(parseFloat(minResult) >= 0, `Cannot go below 0 (got ${minResult})`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 5: set_credibility RPC works ────────────────────────────────────────

async function testSetCredibility(agentId) {
  console.log('\nTest 5: set_credibility RPC works');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  const targetValue = 42.57;
  const { data: result, error } = await supabase.rpc('set_credibility', {
    p_agent_id: agentId,
    p_value: targetValue,
  });

  assert(!error, `set_credibility RPC succeeds${error ? ': ' + error.message : ''}`);
  assertApprox(parseFloat(result), targetValue, 0.01, `Credibility set to exact value ${targetValue}`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 6: Concurrent mixed increments and decrements ───────────────────────

async function testMixedConcurrency(agentId) {
  console.log('\nTest 6: Mixed concurrent increments and decrements');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // 5 increments of +0.3, 3 decrements of -0.2
  // Expected net: (5 × 0.3) + (3 × -0.2) = 1.5 - 0.6 = 0.9
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: 0.3 }));
  }
  for (let i = 0; i < 3; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -0.2 }));
  }

  // Shuffle to make the order truly interleaved
  for (let i = promises.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [promises[i], promises[j]] = [promises[j], promises[i]];
  }

  await Promise.all(promises);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);

  assertApprox(endCred - startCred, 0.9, 0.01,
    'Net change is 0.9 ((5×0.3) + (3×-0.2)) — no updates lost despite mixed concurrent operations'
  );

  // Restore
  await supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -(endCred - startCred) });
}

// ── Run all tests ────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Credibility Concurrency Tests                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const agent = await getTestAgent();
  console.log(`\nUsing test agent: ${agent.id} (credibility: ${agent.credibility_score})`);

  await testRpcExists(agent.id);
  await testSingleIncrement(agent.id);
  await testConcurrentIncrements(agent.id);
  await testBoundaryClamping(agent.id);
  await testSetCredibility(agent.id);
  await testMixedConcurrency(agent.id);

  console.log(`\n${'═'.repeat(58)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(58)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
