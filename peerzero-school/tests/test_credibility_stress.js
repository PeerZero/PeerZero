/**
 * Credibility Stress Tests — push concurrency beyond 100 to find limits.
 *
 * Extends the load tests (test_credibility_load.js) with:
 *   - 200 and 500 concurrent operations
 *   - Multi-agent isolation (concurrent ops across different agents)
 *   - Sustained high throughput (10 rapid-fire waves)
 *   - Throughput degradation detection (compare speeds at different scales)
 *
 * Prerequisites:
 *   - Same as test_credibility_concurrency.js:
 *     SUPABASE_URL, SUPABASE_SERVICE_KEY env vars
 *   - Migration 015_atomic_credibility.sql applied
 *   - At least 2 non-banned agents (or set TEST_AGENT_ID + TEST_AGENT_ID_2)
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_stress.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TEST_AGENT_ID = process.env.TEST_AGENT_ID;
const TEST_AGENT_ID_2 = process.env.TEST_AGENT_ID_2;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.');
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tests/test_credibility_stress.js');
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

async function getTestAgents() {
  const agents = [];

  if (TEST_AGENT_ID) {
    const { data } = await supabase.from('agents').select('id, credibility_score').eq('id', TEST_AGENT_ID).single();
    if (data) agents.push(data);
    else { console.error(`TEST_AGENT_ID ${TEST_AGENT_ID} not found.`); process.exit(1); }
  }

  if (TEST_AGENT_ID_2) {
    const { data } = await supabase.from('agents').select('id, credibility_score').eq('id', TEST_AGENT_ID_2).single();
    if (data) agents.push(data);
    else { console.error(`TEST_AGENT_ID_2 ${TEST_AGENT_ID_2} not found.`); process.exit(1); }
  }

  if (agents.length < 2) {
    const { data: found } = await supabase
      .from('agents')
      .select('id, credibility_score')
      .eq('is_banned', false)
      .limit(2 - agents.length);

    if (found) {
      for (const a of found) {
        if (!agents.find(x => x.id === a.id)) agents.push(a);
      }
    }
  }

  if (agents.length === 0) {
    console.error('No agents found. Create test agents or set TEST_AGENT_ID.');
    process.exit(1);
  }

  return agents;
}

// ── Helper: run N concurrent adjustments and verify ─────────────────────────

async function runAndVerify(agentId, n, delta, label) {
  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Need headroom: if startCred + n*delta would exceed 200, use a smaller delta
  const maxDelta = Math.min(delta, (195 - startCred) / n);
  const effectiveDelta = maxDelta > 0 ? maxDelta : delta;

  const start = Date.now();
  const promises = [];
  for (let i = 0; i < n; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: effectiveDelta }));
  }
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `${label}: all ${n} RPCs succeeded (${errors.length} errors)`);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);
  const expectedNet = n * effectiveDelta;
  const clampedExpected = Math.max(0, Math.min(200, startCred + expectedNet)) - startCred;

  assertApprox(endCred - startCred, clampedExpected, 0.1,
    `${label}: net change is ${clampedExpected.toFixed(2)} (${n} × ${effectiveDelta.toFixed(4)})`
  );

  const opsPerSec = (n / (elapsed / 1000)).toFixed(1);
  console.log(`  ⏱ ${elapsed}ms for ${n} ops (${opsPerSec} ops/sec)`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });

  return { elapsed, opsPerSec: parseFloat(opsPerSec) };
}

// ── Test 1: 200 concurrent increments ───────────────────────────────────────

async function test200Concurrent(agentId) {
  console.log('\nTest 1: 200 concurrent increments');
  await runAndVerify(agentId, 200, 0.02, '200 concurrent');
}

// ── Test 2: 500 concurrent increments ───────────────────────────────────────

async function test500Concurrent(agentId) {
  console.log('\nTest 2: 500 concurrent increments');
  await runAndVerify(agentId, 500, 0.01, '500 concurrent');
}

// ── Test 3: 300 mixed operations (realistic workload at scale) ──────────────

async function test300Mixed(agentId) {
  console.log('\nTest 3: 300 mixed operations — realistic workload at scale');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  // Realistic distribution at 3x scale of existing load test:
  // 120 reviews (+0.3), 90 bounty wins (+0.5), 30 bounty losses (-0.3),
  // 45 papers (+0.1), 15 failures (-0.5)
  const operations = [];
  for (let i = 0; i < 120; i++) operations.push(0.3);
  for (let i = 0; i < 90; i++) operations.push(0.5);
  for (let i = 0; i < 30; i++) operations.push(-0.3);
  for (let i = 0; i < 45; i++) operations.push(0.1);
  for (let i = 0; i < 15; i++) operations.push(-0.5);

  const expectedNet = operations.reduce((a, b) => a + b, 0);
  // = 36 + 45 - 9 + 4.5 - 7.5 = 69.0

  // Shuffle
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
  const clampedExpected = Math.max(0, Math.min(200, startCred + expectedNet)) - startCred;

  assertApprox(endCred - startCred, clampedExpected, 0.15,
    `Net change matches expected ${clampedExpected.toFixed(2)} (pre-clamp: ${expectedNet.toFixed(2)})`
  );
  console.log(`  ⏱ ${elapsed}ms for ${operations.length} mixed ops (${(operations.length / (elapsed / 1000)).toFixed(1)} ops/sec)`);

  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 4: Multi-agent isolation — concurrent ops on 2 agents ──────────────

async function testMultiAgentIsolation(agents) {
  if (agents.length < 2) {
    console.log('\nTest 4: SKIPPED — need 2 agents (set TEST_AGENT_ID_2 or create more)');
    return;
  }

  console.log('\nTest 4: Multi-agent isolation — 100 ops each on 2 agents simultaneously');

  const [agent1, agent2] = agents;
  const N = 100;
  const delta1 = 0.05;
  const delta2 = 0.03;

  const { data: before1 } = await supabase.from('agents').select('credibility_score').eq('id', agent1.id).single();
  const { data: before2 } = await supabase.from('agents').select('credibility_score').eq('id', agent2.id).single();
  const startCred1 = parseFloat(before1.credibility_score);
  const startCred2 = parseFloat(before2.credibility_score);

  // Fire 100 ops at each agent simultaneously (200 total concurrent)
  const start = Date.now();
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agent1.id, p_delta: delta1 }));
    promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agent2.id, p_delta: delta2 }));
  }
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const errors = results.filter(r => r.error);
  assert(errors.length === 0, `All ${N * 2} RPCs succeeded (${errors.length} errors)`);

  // Verify each agent got exactly its expected change
  const { data: after1 } = await supabase.from('agents').select('credibility_score').eq('id', agent1.id).single();
  const { data: after2 } = await supabase.from('agents').select('credibility_score').eq('id', agent2.id).single();
  const endCred1 = parseFloat(after1.credibility_score);
  const endCred2 = parseFloat(after2.credibility_score);

  const expected1 = Math.max(0, Math.min(200, startCred1 + N * delta1)) - startCred1;
  const expected2 = Math.max(0, Math.min(200, startCred2 + N * delta2)) - startCred2;

  assertApprox(endCred1 - startCred1, expected1, 0.05,
    `Agent 1: net change ${expected1.toFixed(2)} (no cross-contamination)`
  );
  assertApprox(endCred2 - startCred2, expected2, 0.05,
    `Agent 2: net change ${expected2.toFixed(2)} (no cross-contamination)`
  );
  console.log(`  ⏱ ${elapsed}ms for ${N * 2} interleaved ops (${(N * 2 / (elapsed / 1000)).toFixed(1)} ops/sec)`);

  // Restore
  await supabase.rpc('set_credibility', { p_agent_id: agent1.id, p_value: startCred1 });
  await supabase.rpc('set_credibility', { p_agent_id: agent2.id, p_value: startCred2 });
}

// ── Test 5: Sustained high throughput — 10 waves of 50 ──────────────────────

async function testSustainedHighThroughput(agentId) {
  console.log('\nTest 5: Sustained high throughput — 10 waves of 50 concurrent ops');

  const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const startCred = parseFloat(before.credibility_score);

  const WAVES = 10;
  const OPS_PER_WAVE = 50;
  const delta = 0.01; // small to avoid clamping
  let totalErrors = 0;

  const waveTimes = [];
  const start = Date.now();

  for (let wave = 0; wave < WAVES; wave++) {
    const waveStart = Date.now();
    const promises = [];
    for (let i = 0; i < OPS_PER_WAVE; i++) {
      promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta }));
    }
    const results = await Promise.all(promises);
    waveTimes.push(Date.now() - waveStart);
    totalErrors += results.filter(r => r.error).length;
  }

  const elapsed = Date.now() - start;
  const totalOps = WAVES * OPS_PER_WAVE;

  assert(totalErrors === 0, `All ${totalOps} RPCs across ${WAVES} waves succeeded (${totalErrors} errors)`);

  const { data: after } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
  const endCred = parseFloat(after.credibility_score);
  const expectedNet = totalOps * delta;
  const clampedExpected = Math.max(0, Math.min(200, startCred + expectedNet)) - startCred;

  assertApprox(endCred - startCred, clampedExpected, 0.1,
    `Total after ${WAVES} waves: ${clampedExpected.toFixed(2)}`
  );

  // Check for throughput degradation across waves
  const firstThreeAvg = waveTimes.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const lastThreeAvg = waveTimes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const degradation = ((lastThreeAvg - firstThreeAvg) / firstThreeAvg * 100).toFixed(1);

  console.log(`  ⏱ ${elapsed}ms total (${(totalOps / (elapsed / 1000)).toFixed(1)} ops/sec sustained)`);
  console.log(`  Wave times: [${waveTimes.map(t => t + 'ms').join(', ')}]`);
  console.log(`  Degradation: ${degradation}% (first 3 avg: ${Math.round(firstThreeAvg)}ms, last 3 avg: ${Math.round(lastThreeAvg)}ms)`);

  // Warn if last waves are >100% slower than first waves (significant degradation)
  if (lastThreeAvg > firstThreeAvg * 2) {
    console.log('  ⚠ Significant throughput degradation detected');
  }

  await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
}

// ── Test 6: Throughput scaling — compare ops/sec at different concurrency ────

async function testThroughputScaling(agentId) {
  console.log('\nTest 6: Throughput scaling — measure ops/sec at 50, 100, 200, 500');

  const levels = [50, 100, 200, 500];
  const results = [];

  for (const n of levels) {
    const { data: before } = await supabase.from('agents').select('credibility_score').eq('id', agentId).single();
    const startCred = parseFloat(before.credibility_score);

    const delta = 0.01;
    const start = Date.now();
    const promises = [];
    for (let i = 0; i < n; i++) {
      promises.push(supabase.rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta }));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - start;
    const opsPerSec = n / (elapsed / 1000);

    results.push({ n, elapsed, opsPerSec });
    console.log(`  N=${n}: ${elapsed}ms (${opsPerSec.toFixed(1)} ops/sec)`);

    await supabase.rpc('set_credibility', { p_agent_id: agentId, p_value: startCred });
  }

  // Check that throughput doesn't collapse (500-level should be at least 20% of 50-level rate)
  const rate50 = results[0].opsPerSec;
  const rate500 = results[results.length - 1].opsPerSec;
  assert(rate500 > rate50 * 0.2,
    `Throughput at 500 (${rate500.toFixed(1)}) is >20% of throughput at 50 (${rate50.toFixed(1)})`
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Credibility Stress Tests (200-500 concurrent)          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const agents = await getTestAgents();
  console.log(`\nUsing ${agents.length} test agent(s):`);
  for (const a of agents) {
    console.log(`  - ${a.id} (credibility: ${a.credibility_score})`);
  }

  await test200Concurrent(agents[0].id);
  await test500Concurrent(agents[0].id);
  await test300Mixed(agents[0].id);
  await testMultiAgentIsolation(agents);
  await testSustainedHighThroughput(agents[0].id);
  await testThroughputScaling(agents[0].id);

  console.log(`\n${'═'.repeat(58)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(58)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
