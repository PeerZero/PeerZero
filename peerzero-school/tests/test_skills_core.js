/**
 * Unit tests for lib/skills-core.js
 *
 * Tests pure functions: updateEMA, computeStrength, addEvidence, jitter,
 * signPortableProfile, SKILLS proxy, and getInternals cache behavior.
 *
 * Usage:
 *   node tests/test_skills_core.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  SKILLS,
  getInternals,
  clearInternalsCache,
  jitter,
  signPortableProfile,
  updateEMA,
  computeStrength,
  addEvidence,
} = require('../lib/skills-core');

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

function assertClose(actual, expected, epsilon, message) {
  assert(Math.abs(actual - expected) < epsilon, `${message} (got ${actual}, expected ~${expected})`);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ═══════════════════════════════════════════════════════════════════════
// updateEMA()
// ═══════════════════════════════════════════════════════════════════════

section('updateEMA()');

// First value: when current is 0 and new > 0, returns new value directly
assert(updateEMA(0, 1.0, 0.15) === 1.0, 'first hit returns 1.0 directly');
assert(updateEMA(0, 0.5, 0.15) === 0.5, 'first partial value returned directly');

// Zero new value with zero current: standard EMA
assert(updateEMA(0, 0, 0.15) === 0, 'zero EMA stays zero');

// Standard EMA calculation
const ema1 = updateEMA(0.8, 1.0, 0.15);
const expected1 = 0.15 * 1.0 + 0.85 * 0.8;
assertClose(ema1, expected1, 0.001, 'EMA with alpha=0.15 on hit after 0.8');

const ema2 = updateEMA(0.8, 0.0, 0.15);
const expected2 = 0.15 * 0.0 + 0.85 * 0.8;
assertClose(ema2, expected2, 0.001, 'EMA with alpha=0.15 on miss after 0.8');

// Higher alpha = more responsive
const emaHigh = updateEMA(0.5, 1.0, 0.5);
const emaLow = updateEMA(0.5, 1.0, 0.1);
assert(emaHigh > emaLow, 'higher alpha is more responsive to new value');

// Repeated hits converge toward 1.0
let ema = 0.5;
for (let i = 0; i < 50; i++) {
  ema = updateEMA(ema, 1.0, 0.15);
}
assertClose(ema, 1.0, 0.01, 'repeated hits converge toward 1.0');

// Repeated misses converge toward 0.0
ema = 0.8;
for (let i = 0; i < 50; i++) {
  ema = updateEMA(ema, 0.0, 0.15);
}
assertClose(ema, 0.0, 0.01, 'repeated misses converge toward 0.0');

// ═══════════════════════════════════════════════════════════════════════
// computeStrength()
// ═══════════════════════════════════════════════════════════════════════

section('computeStrength()');

// Default config (scale=100, dp=1)
const s1 = computeStrength(1.0, 15, 15, null);
assertClose(s1, 100.0, 0.1, 'perfect reliability at target reps = 100.0');

const s2 = computeStrength(1.0, 1, 15, null);
// maturity = sqrt(1)/sqrt(15) ≈ 0.258
assertClose(s2, 25.8, 0.2, '1 rep of 15 target gives ~25.8 strength');

const s3 = computeStrength(0.5, 15, 15, null);
assertClose(s3, 50.0, 0.1, 'half reliability at target reps = 50.0');

// Zero reliability
assert(computeStrength(0, 10, 15, null) === 0, 'zero reliability = zero strength');

// Custom config
const s4 = computeStrength(1.0, 15, 15, { scale: 200, decimal_places: 2 });
assertClose(s4, 200.0, 0.01, 'custom scale 200 with perfect stats');

// Maturity caps at 1.0 (reps > target)
const s5 = computeStrength(1.0, 100, 15, null);
assertClose(s5, 100.0, 0.1, 'reps beyond target still cap at maturity 1.0');

// Maturity uses sqrt scaling
const s6 = computeStrength(1.0, 4, 16, null);
// maturity = sqrt(4)/sqrt(16) = 2/4 = 0.5
assertClose(s6, 50.0, 0.1, 'sqrt scaling: 4/16 reps gives 0.5 maturity');

// ═══════════════════════════════════════════════════════════════════════
// addEvidence()
// ═══════════════════════════════════════════════════════════════════════

section('addEvidence()');

// Empty trail
const trail1 = addEvidence([], { id: 1 }, 5);
assert(trail1.length === 1, 'adds to empty trail');
assert(trail1[0].id === 1, 'first entry is the new one');

// Prepends (newest first)
const trail2 = addEvidence([{ id: 1 }], { id: 2 }, 5);
assert(trail2.length === 2, 'trail grows');
assert(trail2[0].id === 2, 'newest entry is first');
assert(trail2[1].id === 1, 'old entry pushed back');

// Respects max size
const existing = [{ id: 1 }, { id: 2 }, { id: 3 }];
const trail3 = addEvidence(existing, { id: 4 }, 3);
assert(trail3.length === 3, 'trail capped at maxSize');
assert(trail3[0].id === 4, 'newest entry at front');
assert(trail3[2].id === 2, 'oldest entry dropped');

// Handles null/undefined existing gracefully
const trail4 = addEvidence(null, { id: 1 }, 5);
assert(trail4.length === 1, 'null existing treated as empty');

const trail5 = addEvidence(undefined, { id: 1 }, 5);
assert(trail5.length === 1, 'undefined existing treated as empty');

// Does not mutate original
const original = [{ id: 1 }, { id: 2 }];
const trail6 = addEvidence(original, { id: 3 }, 5);
assert(original.length === 2, 'original array not mutated');
assert(trail6.length === 3, 'new array is longer');

// ═══════════════════════════════════════════════════════════════════════
// jitter()
// ═══════════════════════════════════════════════════════════════════════

section('jitter()');

// No range = no jitter
assert(jitter(50, 0) === 50, 'zero range returns base');
assert(jitter(50, null) === 50, 'null range returns base');
assert(jitter(50, undefined) === 50, 'undefined range returns base');

// With range, result is within [base-range, base+range]
let allInRange = true;
for (let i = 0; i < 100; i++) {
  const val = jitter(50, 5);
  if (val < 45 || val > 55) {
    allInRange = false;
    break;
  }
}
assert(allInRange, 'jitter(50, 5) stays within [45, 55] over 100 samples');

// Jitter is not always the same (has randomness)
const vals = new Set();
for (let i = 0; i < 20; i++) {
  vals.add(jitter(50, 5));
}
assert(vals.size > 1, 'jitter produces varying results');

// ═══════════════════════════════════════════════════════════════════════
// signPortableProfile() — without signing key
// ═══════════════════════════════════════════════════════════════════════

section('signPortableProfile() — no key');

// Without PROFILE_SIGNING_PRIVATE_KEY, profile returned as-is
delete process.env.PROFILE_SIGNING_PRIVATE_KEY;
const testProfile = { handle: 'test-bot', overall_reasoning_score: 42 };
const unsigned = signPortableProfile(testProfile);
assert(unsigned.handle === 'test-bot', 'profile data preserved');
assert(unsigned.overall_reasoning_score === 42, 'score preserved');
assert(!unsigned.signature, 'no signature without key');
assert(!unsigned.signed_at, 'no signed_at without key');

// ═══════════════════════════════════════════════════════════════════════
// SKILLS proxy
// ═══════════════════════════════════════════════════════════════════════

section('SKILLS proxy');

// SKILLS should be an object (Proxy) that reads from school config
assert(typeof SKILLS === 'object', 'SKILLS is an object');

// The science school has 6 skills; accessing them should work
const keys = Object.keys(SKILLS);
assert(keys.length === 6, `SKILLS has 6 keys from science config (got ${keys.length})`);

// Each skill should have name and description
for (const key of keys) {
  const skill = SKILLS[key];
  assert(skill && typeof skill.name === 'string', `SKILLS[${key}] has a name`);
  assert(skill && typeof skill.description === 'string', `SKILLS[${key}] has a description`);
}

// Non-existent skill returns undefined
assert(SKILLS['nonexistent_skill'] === undefined, 'unknown skill key returns undefined');

// 'in' operator works
assert(keys[0] in SKILLS, '"in" operator works for existing skill');
assert(!('fake_skill' in SKILLS), '"in" operator returns false for missing skill');

// ═══════════════════════════════════════════════════════════════════════
// clearInternalsCache()
// ═══════════════════════════════════════════════════════════════════════

section('clearInternalsCache()');

// Should not throw
clearInternalsCache();
assert(true, 'clearInternalsCache runs without error');

// ═══════════════════════════════════════════════════════════════════════
// Module exports
// ═══════════════════════════════════════════════════════════════════════

section('Module exports');

const mod = require('../lib/skills-core');
assert(typeof mod.SKILLS === 'object', 'SKILLS exported');
assert(typeof mod.getInternals === 'function', 'getInternals exported');
assert(typeof mod.clearInternalsCache === 'function', 'clearInternalsCache exported');
assert(typeof mod.jitter === 'function', 'jitter exported');
assert(typeof mod.signPortableProfile === 'function', 'signPortableProfile exported');
assert(typeof mod.updateEMA === 'function', 'updateEMA exported');
assert(typeof mod.computeStrength === 'function', 'computeStrength exported');
assert(typeof mod.addEvidence === 'function', 'addEvidence exported');
assert(typeof mod.recordSkillExercise === 'function', 'recordSkillExercise exported');

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
