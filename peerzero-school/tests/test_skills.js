/**
 * Unit tests for lib/skills.js — Facade module
 *
 * Verifies that the facade re-exports all expected functions from
 * the sub-modules (skills-core, skills-exercises, skills-profile,
 * skills-collectors, skills-condensers).
 *
 * Usage:
 *   node tests/test_skills.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const skills = require('../lib/skills');

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
// Facade exports existence
// ═══════════════════════════════════════════════════════════════════════

section('Core exports');

assert(typeof skills.SKILLS === 'object', 'SKILLS is exported as object');
assert(typeof skills.getInternals === 'function', 'getInternals is exported');
assert(typeof skills.clearInternalsCache === 'function', 'clearInternalsCache is exported');
assert(typeof skills.recordSkillExercise === 'function', 'recordSkillExercise is exported');

section('Exercise exports');

assert(typeof skills.exerciseSkillsFromPaper === 'function', 'exerciseSkillsFromPaper is exported');
assert(typeof skills.exerciseSkillsFromRevision === 'function', 'exerciseSkillsFromRevision is exported');
assert(typeof skills.exerciseSkillsFromReview === 'function', 'exerciseSkillsFromReview is exported');
assert(typeof skills.exerciseSkillsFromBounty === 'function', 'exerciseSkillsFromBounty is exported');
assert(typeof skills.exerciseCalibrationFromScore === 'function', 'exerciseCalibrationFromScore is exported');
assert(typeof skills.exerciseDisconfirmationFromBounty === 'function', 'exerciseDisconfirmationFromBounty is exported');
assert(typeof skills.exerciseSourceEvaluationFromBounty === 'function', 'exerciseSourceEvaluationFromBounty is exported');
assert(typeof skills.exerciseBeliefUpdatingFromScore === 'function', 'exerciseBeliefUpdatingFromScore is exported');
assert(typeof skills.exerciseAdversarialFromConsensus === 'function', 'exerciseAdversarialFromConsensus is exported');

section('Profile exports');

assert(typeof skills.getSkillProfile === 'function', 'getSkillProfile is exported');
assert(typeof skills.getPortableProfile === 'function', 'getPortableProfile is exported');
assert(typeof skills.getIdentityCore === 'function', 'getIdentityCore is exported');
assert(typeof skills.getStoredReflections === 'function', 'getStoredReflections is exported');
assert(typeof skills.storeReflection === 'function', 'storeReflection is exported');

section('Collector exports');

assert(typeof skills.buildActiveFocus === 'function', 'buildActiveFocus is exported');
assert(typeof skills.collectExercises === 'function', 'collectExercises is exported');
assert(typeof skills.collectPaperExercises === 'function', 'collectPaperExercises is exported');
assert(typeof skills.collectReviewExercises === 'function', 'collectReviewExercises is exported');
assert(typeof skills.collectRevisionExercises === 'function', 'collectRevisionExercises is exported');
assert(typeof skills.collectBountyExercises === 'function', 'collectBountyExercises is exported');

section('Condenser exports');

assert(typeof skills.selectByGrade === 'function', 'selectByGrade is exported');
assert(typeof skills.getUncondensedExerciseCount === 'function', 'getUncondensedExerciseCount is exported');
assert(typeof skills.buildMilestoneCondenser === 'function', 'buildMilestoneCondenser is exported');
assert(typeof skills.buildCoreCondenserPrompt === 'function', 'buildCoreCondenserPrompt is exported');
assert(typeof skills.buildMasterCondenser === 'function', 'buildMasterCondenser is exported');
assert(typeof skills.getPostActionPrompts === 'function', 'getPostActionPrompts is exported');

// Decision track condensers
assert(typeof skills.buildDecisionMilestoneCondenser === 'function', 'buildDecisionMilestoneCondenser is exported');
assert(typeof skills.buildDecisionCoreCondenserPrompt === 'function', 'buildDecisionCoreCondenserPrompt is exported');
assert(typeof skills.buildDecisionMasterCondenser === 'function', 'buildDecisionMasterCondenser is exported');

// Forge track condensers
assert(typeof skills.buildForgeMilestoneCondenser === 'function', 'buildForgeMilestoneCondenser is exported');
assert(typeof skills.buildForgeCoreCondenserPrompt === 'function', 'buildForgeCoreCondenserPrompt is exported');
assert(typeof skills.buildForgeMasterCondenser === 'function', 'buildForgeMasterCondenser is exported');

// ═══════════════════════════════════════════════════════════════════════
// No unexpected exports
// ═══════════════════════════════════════════════════════════════════════

section('Export count');

const exportKeys = Object.keys(skills);
const expectedCount = 36; // total re-exported functions/objects
assert(exportKeys.length === expectedCount,
  `expected ${expectedCount} exports, got ${exportKeys.length}: [${exportKeys.join(', ')}]`);

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
