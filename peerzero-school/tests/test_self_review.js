/**
 * Unit tests for lib/self-review.js
 *
 * Tests selectSelfReviewTarget filtering, selfReviewSignals generation,
 * and storeSelfReview data shaping. Database calls are stubbed.
 *
 * Usage:
 *   node tests/test_self_review.js
 */

// Stub env vars so require doesn't throw
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

// Stub @supabase/supabase-js before requiring the module
const _originalRequire = require;
const supabaseMock = {
  from: () => supabaseMock,
  select: () => supabaseMock,
  eq: () => supabaseMock,
  gte: () => supabaseMock,
  order: () => supabaseMock,
  limit: () => supabaseMock,
  single: () => Promise.resolve({ data: null }),
  insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'mock-id' } }) }) }),
  update: () => ({ eq: () => Promise.resolve({ data: null }) }),
  rpc: () => Promise.resolve({ data: null }),
};

// We need to intercept the supabase client creation.
// The module creates the client at require time, so we mock via Module._cache.
// Instead, we'll just test the pure function: selfReviewSignals.
// selectSelfReviewTarget and storeSelfReview/buildSelfReviewCoaching need DB — tested via integration.

const { selfReviewSignals } = require('../lib/self-review');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ═══════════════════════════════════════════════════════════════════════
// selfReviewSignals() — pure function, no DB needed
// ═══════════════════════════════════════════════════════════════════════

section('selfReviewSignals() — calibration signal');

// Low divergence = calibration hit
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: ['weak methodology', 'missing control group'],
    original_confidence: 8.0,
    hindsight_confidence: 6.5,
  });

  assert(Array.isArray(signals), 'returns an array');
  assert(signals.length >= 2, 'returns at least 2 signals');

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration !== undefined, 'includes calibrated_uncertainty signal');
  assert(calibration.hit === true, 'divergence 1.0 is a calibration hit');
  assert(calibration.detail.includes('1.0'), 'detail includes divergence value');
}

// High divergence = calibration miss
{
  const signals = selfReviewSignals({
    score_divergence: 2.5,
    score: 8.0,
    community_score_at_time: 5.5,
    weaknesses_found: [],
  });

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration.hit === false, 'divergence 2.5 is a calibration miss');
  assert(calibration.detail.includes('overestimate'), 'detail says overestimate when score > community');
}

// Underestimate case
{
  const signals = selfReviewSignals({
    score_divergence: 2.0,
    score: 4.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
  });

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration.hit === false, 'divergence 2.0 is a calibration miss');
  assert(calibration.detail.includes('underestimate'), 'detail says underestimate when score < community');
}

// Boundary: exactly 1.5 divergence = hit
{
  const signals = selfReviewSignals({
    score_divergence: 1.5,
    score: 6.5,
    community_score_at_time: 5.0,
    weaknesses_found: [],
  });

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration.hit === true, 'divergence exactly 1.5 is a calibration hit');
}

section('selfReviewSignals() — adversarial reasoning signal');

// Found enough weaknesses = hit
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: ['flaw1', 'flaw2', 'flaw3'],
  });

  const adversarial = signals.find(s => s.skill_key === 'adversarial_reasoning');
  assert(adversarial !== undefined, 'includes adversarial_reasoning signal');
  assert(adversarial.hit === true, '3 weaknesses found is a hit');
  assert(adversarial.detail.includes('3'), 'detail includes weakness count');
}

// Found too few weaknesses = miss
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: ['only one'],
  });

  const adversarial = signals.find(s => s.skill_key === 'adversarial_reasoning');
  assert(adversarial.hit === false, '1 weakness found is a miss');
}

// No weaknesses
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
  });

  const adversarial = signals.find(s => s.skill_key === 'adversarial_reasoning');
  assert(adversarial.hit === false, '0 weaknesses is a miss');
  assert(adversarial.detail.includes('0 new weaknesses'), 'detail mentions 0 weaknesses (plural)');
}

// Exactly 2 weaknesses = hit (boundary)
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: ['a', 'b'],
  });

  const adversarial = signals.find(s => s.skill_key === 'adversarial_reasoning');
  assert(adversarial.hit === true, 'exactly 2 weaknesses is a hit');
}

// Null weaknesses_found
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: null,
  });

  const adversarial = signals.find(s => s.skill_key === 'adversarial_reasoning');
  assert(adversarial.hit === false, 'null weaknesses_found is a miss');
}

section('selfReviewSignals() — belief updating signal');

// Confidence shift present and large enough = hit
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
    original_confidence: 8.0,
    hindsight_confidence: 6.5,
  });

  const belief = signals.find(s => s.skill_key === 'belief_updating');
  assert(belief !== undefined, 'includes belief_updating signal when both confidences present');
  assert(belief.hit === true, 'shift of 1.5 is a hit');
  assert(belief.detail.includes('lower'), 'detail says lower when hindsight < original');
}

// Small confidence shift = miss
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
    original_confidence: 7.0,
    hindsight_confidence: 7.5,
  });

  const belief = signals.find(s => s.skill_key === 'belief_updating');
  assert(belief.hit === false, 'shift of 0.5 is a miss');
  assert(belief.detail.includes('0.5'), 'detail includes shift amount');
}

// Confidence shift upward
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
    original_confidence: 5.0,
    hindsight_confidence: 7.0,
  });

  const belief = signals.find(s => s.skill_key === 'belief_updating');
  assert(belief.hit === true, 'shift of 2.0 upward is a hit');
  assert(belief.detail.includes('higher'), 'detail says higher when hindsight > original');
}

// No confidence data = no belief_updating signal
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
    original_confidence: null,
    hindsight_confidence: null,
  });

  const belief = signals.find(s => s.skill_key === 'belief_updating');
  assert(belief === undefined, 'no belief_updating signal when confidences are null');
  assert(signals.length === 2, 'only 2 signals when no confidence data');
}

// Exactly 1.0 shift = hit (boundary)
{
  const signals = selfReviewSignals({
    score_divergence: 1.0,
    score: 7.0,
    community_score_at_time: 6.0,
    weaknesses_found: [],
    original_confidence: 7.0,
    hindsight_confidence: 8.0,
  });

  const belief = signals.find(s => s.skill_key === 'belief_updating');
  assert(belief.hit === true, 'shift of exactly 1.0 is a hit');
}

section('selfReviewSignals() — zero divergence edge case');

{
  const signals = selfReviewSignals({
    score_divergence: 0,
    score: 7.0,
    community_score_at_time: 7.0,
    weaknesses_found: ['a', 'b', 'c'],
  });

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration.hit === true, 'zero divergence is a hit');
}

section('selfReviewSignals() — missing score_divergence defaults to 0');

{
  const signals = selfReviewSignals({
    weaknesses_found: [],
  });

  const calibration = signals.find(s => s.skill_key === 'calibrated_uncertainty');
  assert(calibration.hit === true, 'undefined score_divergence defaults to 0 (hit)');
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
