/**
 * Extended Credibility Concurrency Load Tests
 *
 * Scales the existing concurrency tests from 10 to 100+ parallel operations.
 * Tests both atomic correctness and throughput under sustained load.
 *
 * Prerequisites:
 *   - Same as test_credibility_concurrency.js:
 *     SUPABASE_URL, SUPABASE_SERVICE_KEY env vars
 *   - Migration 015_atomic_credibility.sql applied
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_load.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TEST_AGENT_ID = process.env.TEST_AGENT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.');
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_load.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
  assert(diff <= tolerance, `${message} (expected ${expected}, got ${actual}, diff ${diff.toFixed(6)})`);
}

async function getTestAgent() {
  if (TEST_AGENT_ID) {
    const { data } = await supabase.from('agents').select('id, credibility_score').eq('id', TEST_AGENT_ID).single();
    if (data) return data;
    console.error(`TEST_AGENT_ID ${TEST_AGENT_ID} not found.`);
    process.exit(1);
  }
  const { data: agents } = await supabase.from('agents').select('id, credibility_score').eq('is_banned', false).limit(1);
  if (agents && agents.length > 0) return agents[0];
  console.error('No agents found. Set TEST_AGENT_ID or create a test agent.');
  process.exit(1);
}

// ── Test 1: 50 concurrent increments ────────────────────────────────────────

async function test50ConcurrentIncrements(agentId) {
  console.log('\nTest 1: 50 concurrent increments — no lost updates');

  const N = 50;
  const delta = 0.1;
  const expectedTotal = N * delta; // 5.0

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  const start = Date.now();
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta }));
  }
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `All ${N} RPCs succeeded (${errors.length} errors)`);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);

  assertApprox(endCred - startCred, expectedTotal, 0.01,
    `Total change is ${expectedTotal} (${N} × ${delta})`
  );
  console.log(`  ⏱ ${elapsed}ms for ${N} concurrent RPCs (${(N / (elapsed / 1000)).toFixed(1)} ops/sec)`);

  // Restore
  await supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -expectedTotal });
}

// ── Test 2: 100 concurrent increments ───────────────────────────────────────

async function test100ConcurrentIncrements(agentId) {
  console.log('\nTest 2: 100 concurrent increments — stress test');

  const N = 100;
  const delta = 0.05;
  const expectedTotal = N * delta; // 5.0

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  const start = Date.now();
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta }));
  }
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `All ${N} RPCs succeeded (${errors.length} errors)`);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);

  assertApprox(endCred - startCred, expectedTotal, 0.02,
    `Total change is ${expectedTotal} (${N} × ${delta})`
  );
  console.log(`  ⏱ ${elapsed}ms for ${N} concurrent RPCs (${(N / (elapsed / 1000)).toFixed(1)} ops/sec)`);

  // Restore
  await supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -expectedTotal });
}

// ── Test 3: 100 mixed operations (reviews + bounties + papers pattern) ──────

async function testMixedOperationsAtScale(agentId) {
  console.log('\nTest 3: 100 mixed operations simulating real review/bounty/paper pattern');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Simulate realistic workload:
  // 40 reviews (+0.3 each)
  // 30 bounty wins (+0.5 each)
  // 10 bounty losses (-0.3 each)
  // 15 paper submissions (+0.1 each)
  // 5 paper failures (-0.5 each)
  const operations = [];
  for (let i = 0; i < 40; i++) operations.push(0.3);   // reviews
  for (let i = 0; i < 30; i++) operations.push(0.5);   // bounty wins
  for (let i = 0; i < 10; i++) operations.push(-0.3);  // bounty losses
  for (let i = 0; i < 15; i++) operations.push(0.1);   // paper submissions
  for (let i = 0; i < 5; i++) operations.push(-0.5);   // paper failures

  const expectedNet = operations.reduce((a, b) => a + b, 0);
  // = (40*0.3) + (30*0.5) + (10*-0.3) + (15*0.1) + (5*-0.5)
  // = 12 + 15 - 3 + 1.5 - 2.5 = 23.0

  // Shuffle for realistic interleaving
  for (let i = operations.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [operations[i], operations[j]] = [operations[j], operations[i]];
  }

  const start = Date.now();
  const promises = operations.map(delta =>
    supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta })
  );
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `All ${operations.length} RPCs succeeded (${errors.length} errors)`);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);
  const actualNet = endCred - startCred;

  // Need higher tolerance since we're clamping at [0, 200]
  const clampedExpected = Math.max(0, Math.min(200, startCred + expectedNet)) - startCred;
  assertApprox(actualNet, clampedExpected, 0.05,
    `Net change matches expected ${clampedExpected.toFixed(2)} (pre-clamp: ${expectedNet.toFixed(2)})`
  );
  console.log(`  ⏱ ${elapsed}ms for ${operations.length} mixed RPCs (${(operations.length / (elapsed / 1000)).toFixed(1)} ops/sec)`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 4: Sustained load — 5 waves of 20 concurrent operations ────────────

async function testSustainedLoad(agentId) {
  console.log('\nTest 4: Sustained load — 5 waves of 20 concurrent operations');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  const WAVES = 5;
  const OPS_PER_WAVE = 20;
  const delta = 0.1;
  let totalApplied = 0;

  const start = Date.now();
  for (let wave = 0; wave < WAVES; wave++) {
    const promises = [];
    for (let i = 0; i < OPS_PER_WAVE; i++) {
      promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta }));
    }
    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);
    assert(errors.length === 0, `Wave ${wave + 1}: all ${OPS_PER_WAVE} RPCs succeeded`);
    totalApplied += OPS_PER_WAVE * delta;
  }
  const elapsed = Date.now() - start;

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);
  const clampedExpected = Math.max(0, Math.min(200, startCred + totalApplied)) - startCred;

  assertApprox(endCred - startCred, clampedExpected, 0.05,
    `Total after ${WAVES} waves: ${clampedExpected.toFixed(1)} (${WAVES * OPS_PER_WAVE} total ops)`
  );
  console.log(`  ⏱ ${elapsed}ms total (${((WAVES * OPS_PER_WAVE) / (elapsed / 1000)).toFixed(1)} ops/sec sustained)`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 5: Boundary stress — push to limits concurrently ───────────────────

async function testBoundaryStress(agentId) {
  console.log('\nTest 5: Boundary stress — concurrent operations near limits');

  // Set to near-max
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: 195 });

  // Fire 20 concurrent +1.0 increments (would go to 215, should clamp to 200)
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: 1.0 }));
  }
  await Promise.all(promises);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);
  assert(endCred === 200, `Credibility clamped at 200 (got ${endCred})`);

  // Now fire 50 concurrent -5.0 decrements (would go to -50, should clamp to 0)
  const decPromises = [];
  for (let i = 0; i < 50; i++) {
    decPromises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: -5.0 }));
  }
  await Promise.all(decPromises);

  const { data: afterDec } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const decCred = parseFloat(afterDec.credibility_score);
  assert(decCred === 0, `Credibility clamped at 0 (got ${decCred})`);

  // Restore to a reasonable value
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: 100 });
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Extended Credibility Load Tests (50-100+ concurrent)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const agent = await getTestAgent();
  console.log(`\nUsing test agent: ${agent.id} (credibility: ${agent.credibility_score})`);

  await test50ConcurrentIncrements(agent.id);
  await test100ConcurrentIncrements(agent.id);
  await testMixedOperationsAtScale(agent.id);
  await testSustainedLoad(agent.id);
  await testBoundaryStress(agent.id);

  console.log(`\n${'═'.repeat(58)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(58)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
