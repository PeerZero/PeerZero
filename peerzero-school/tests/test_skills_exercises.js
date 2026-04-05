/**
 * Unit tests for lib/skills-exercises.js
 *
 * This module is mostly thin wrappers around DB calls (recordSkillExercise)
 * and school.skillSignals. Tests verify exports structure and the
 * early-return validation logic in exerciseCalibrationFromScore and
 * exerciseSourceEvaluationFromBounty.
 *
 * Usage:
 *   node tests/test_skills_exercises.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const exercisesMod = require('../lib/skills-exercises');

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

assert(typeof exercisesMod.exerciseSkillsFromPaper === 'function', 'exerciseSkillsFromPaper exported');
assert(typeof exercisesMod.exerciseSkillsFromRevision === 'function', 'exerciseSkillsFromRevision exported');
assert(typeof exercisesMod.exerciseSkillsFromReview === 'function', 'exerciseSkillsFromReview exported');
assert(typeof exercisesMod.exerciseSkillsFromBounty === 'function', 'exerciseSkillsFromBounty exported');
assert(typeof exercisesMod.exerciseCalibrationFromScore === 'function', 'exerciseCalibrationFromScore exported');
assert(typeof exercisesMod.exerciseDisconfirmationFromBounty === 'function', 'exerciseDisconfirmationFromBounty exported');
assert(typeof exercisesMod.exerciseSourceEvaluationFromBounty === 'function', 'exerciseSourceEvaluationFromBounty exported');
assert(typeof exercisesMod.exerciseBeliefUpdatingFromScore === 'function', 'exerciseBeliefUpdatingFromScore exported');
assert(typeof exercisesMod.exerciseAdversarialFromConsensus === 'function', 'exerciseAdversarialFromConsensus exported');

const exportKeys = Object.keys(exercisesMod);
assert(exportKeys.length === 9, `expected 9 exports, got ${exportKeys.length}`);

// ═══════════════════════════════════════════════════════════════════════
// Function signatures
// ═══════════════════════════════════════════════════════════════════════

section('Function signatures');

// exerciseSkillsFromPaper(agentId, paper, searchCoaching, citationFlags, citationGrade)
assert(exercisesMod.exerciseSkillsFromPaper.length === 5,
  'exerciseSkillsFromPaper takes 5 params');

// exerciseSkillsFromRevision(agentId, revision, parentPaperId, searchCoaching)
assert(exercisesMod.exerciseSkillsFromRevision.length === 4,
  'exerciseSkillsFromRevision takes 4 params');

// exerciseSkillsFromReview(agentId, review, reviewSearchCoaching, passedQualityGate)
assert(exercisesMod.exerciseSkillsFromReview.length === 4,
  'exerciseSkillsFromReview takes 4 params');

// exerciseSkillsFromBounty(agentId, bounty, isValid)
assert(exercisesMod.exerciseSkillsFromBounty.length === 3,
  'exerciseSkillsFromBounty takes 3 params');

// exerciseCalibrationFromScore(agentId, paperId, confidenceScore, actualScore)
assert(exercisesMod.exerciseCalibrationFromScore.length === 4,
  'exerciseCalibrationFromScore takes 4 params');

// exerciseDisconfirmationFromBounty(paperAuthorId, paperId, bounty)
assert(exercisesMod.exerciseDisconfirmationFromBounty.length === 3,
  'exerciseDisconfirmationFromBounty takes 3 params');

// exerciseSourceEvaluationFromBounty(paperAuthorId, paperId, bounty)
assert(exercisesMod.exerciseSourceEvaluationFromBounty.length === 3,
  'exerciseSourceEvaluationFromBounty takes 3 params');

// exerciseBeliefUpdatingFromScore(agentId, revisionPaperId, parentPaperId, revisionScore)
assert(exercisesMod.exerciseBeliefUpdatingFromScore.length === 4,
  'exerciseBeliefUpdatingFromScore takes 4 params');

// exerciseAdversarialFromConsensus(paperId, finalScore)
assert(exercisesMod.exerciseAdversarialFromConsensus.length === 2,
  'exerciseAdversarialFromConsensus takes 2 params');

// ═══════════════════════════════════════════════════════════════════════
// exerciseCalibrationFromScore — null guard (no DB needed)
//
// When confidenceScore or actualScore is null/undefined, the function
// should return early without throwing. We verify this by calling with
// null values — since it returns early before hitting Supabase, it
// should resolve without error.
// ═══════════════════════════════════════════════════════════════════════

section('exerciseCalibrationFromScore — null guards');

// These should resolve without error (early return before DB calls)
async function testCalibrationNullGuards() {
  try {
    await exercisesMod.exerciseCalibrationFromScore('agent-1', 'paper-1', null, 7.5);
    assert(true, 'null confidenceScore returns early without error');
  } catch (e) {
    assert(false, `null confidenceScore should not throw: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseCalibrationFromScore('agent-1', 'paper-1', 7.0, null);
    assert(true, 'null actualScore returns early without error');
  } catch (e) {
    assert(false, `null actualScore should not throw: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseCalibrationFromScore('agent-1', 'paper-1', undefined, 7.5);
    assert(true, 'undefined confidenceScore returns early without error');
  } catch (e) {
    assert(false, `undefined confidenceScore should not throw: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseCalibrationFromScore('agent-1', 'paper-1', 7.0, undefined);
    assert(true, 'undefined actualScore returns early without error');
  } catch (e) {
    assert(false, `undefined actualScore should not throw: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// exerciseSourceEvaluationFromBounty — challenge_type guard
//
// Should return early if bounty.challenge_type !== 'weak_source_quality'
// ═══════════════════════════════════════════════════════════════════════

section('exerciseSourceEvaluationFromBounty — challenge_type guard');

async function testSourceEvalGuard() {
  // Non-matching challenge type should return early without hitting DB
  try {
    await exercisesMod.exerciseSourceEvaluationFromBounty(
      'author-1', 'paper-1', { challenge_type: 'methodology_flaw' }
    );
    assert(true, 'non-matching challenge_type returns early without error');
  } catch (e) {
    assert(false, `non-matching challenge_type should not throw: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// All exercise functions swallow errors (try/catch with log)
// ═══════════════════════════════════════════════════════════════════════

section('Error swallowing — functions do not throw on DB failure');

async function testErrorSwallowing() {
  // exerciseSkillsFromPaper will try to call school.skillSignals which exists,
  // but recordSkillExercise will fail on Supabase. The function should swallow.
  try {
    await exercisesMod.exerciseSkillsFromPaper('agent-1', {}, [], [], null);
    assert(true, 'exerciseSkillsFromPaper swallows errors');
  } catch (e) {
    assert(false, `exerciseSkillsFromPaper should swallow errors: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseSkillsFromReview('agent-1', {}, [], true);
    assert(true, 'exerciseSkillsFromReview swallows errors');
  } catch (e) {
    assert(false, `exerciseSkillsFromReview should swallow errors: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseSkillsFromBounty('agent-1', {}, true);
    assert(true, 'exerciseSkillsFromBounty swallows errors');
  } catch (e) {
    assert(false, `exerciseSkillsFromBounty should swallow errors: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseSkillsFromRevision('agent-1', {}, 'paper-1', []);
    assert(true, 'exerciseSkillsFromRevision swallows errors');
  } catch (e) {
    assert(false, `exerciseSkillsFromRevision should swallow errors: ${e.message}`);
  }

  try {
    await exercisesMod.exerciseDisconfirmationFromBounty('author-1', 'paper-1', {});
    assert(true, 'exerciseDisconfirmationFromBounty swallows errors');
  } catch (e) {
    assert(false, `exerciseDisconfirmationFromBounty should swallow errors: ${e.message}`);
  }
}

// Run all async tests
Promise.all([
  testCalibrationNullGuards(),
  testSourceEvalGuard(),
  testErrorSwallowing(),
]).then(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Async test runner failed:', err);
  process.exit(1);
});
