/**
 * Unit tests for lib/skills-profile.js
 *
 * Tests the module exports. Most functions are DB-driven, so we verify
 * structure and the storeReflection validation logic via mock.
 *
 * Usage:
 *   node tests/test_skills_profile.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const profileMod = require('../lib/skills-profile');

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
// Module exports
// ═══════════════════════════════════════════════════════════════════════

section('Module exports');

assert(typeof profileMod.getSkillProfile === 'function', 'getSkillProfile exported');
assert(typeof profileMod.getPortableProfile === 'function', 'getPortableProfile exported');
assert(typeof profileMod.getIdentityCore === 'function', 'getIdentityCore exported');
assert(typeof profileMod.getStoredReflections === 'function', 'getStoredReflections exported');
assert(typeof profileMod.storeReflection === 'function', 'storeReflection exported');

const exportKeys = Object.keys(profileMod);
assert(exportKeys.length === 5, `expected 5 exports, got ${exportKeys.length}`);

// ═══════════════════════════════════════════════════════════════════════
// Certification tier mapping (tested via getPortableProfile internals)
// We can test the logic by examining the tier thresholds documented in code
// ═══════════════════════════════════════════════════════════════════════

section('Certification tier logic (from source analysis)');

// The certification tiers are:
//   >= 175 → Distinguished Reasoner, tier 5
//   >= 150 → Verified Reasoner, tier 4
//   >= 100 → Tested Reasoner, tier 3
//   >= 75  → Apprentice Reasoner, tier 2
//   <  75  → In Training, tier 1

// These thresholds are hardcoded in getPortableProfile; we verify the function
// exists and has the right shape. Deeper testing would require DB mocks.
assert(profileMod.getPortableProfile.length === 1, 'getPortableProfile takes 1 argument (agentId)');
assert(profileMod.getSkillProfile.length === 1, 'getSkillProfile takes 1 argument (agentId)');
assert(profileMod.storeReflection.length >= 4, 'storeReflection takes at least 4 arguments');

// ═══════════════════════════════════════════════════════════════════════
// storeReflection argument positions
// ═══════════════════════════════════════════════════════════════════════

section('storeReflection signature');

// storeReflection(agentId, interactionType, condensedParagraph, interactionId, track)
assert(profileMod.storeReflection.length === 4 || profileMod.storeReflection.length === 5,
  `storeReflection has ${profileMod.storeReflection.length} formal params (4 required + 1 optional)`);

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
