/**
 * Unit tests for lib/skills-condensers.js
 *
 * Tests the pure function selectByGrade() and the condenser builder
 * functions using mocked getInternals(). The condenser builders are
 * async (they call getInternals), so we mock the internals cache.
 *
 * Usage:
 *   node tests/test_skills_condensers.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  selectByGrade,
  buildMilestoneCondenser,
  buildCoreCondenserPrompt,
  buildMasterCondenser,
  buildDecisionMilestoneCondenser,
  buildDecisionCoreCondenserPrompt,
  buildDecisionMasterCondenser,
  buildForgeMilestoneCondenser,
  buildForgeCoreCondenserPrompt,
  buildForgeMasterCondenser,
  getUncondensedExerciseCount,
  getPostActionPrompts,
} = require('../lib/skills-condensers');

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
// selectByGrade() — pure function, no DB access
// ═══════════════════════════════════════════════════════════════════════

section('selectByGrade() — exact match');

const gradeMap = {
  '1': 'grade-1-prompt',
  '5': 'grade-5-prompt',
  '7': 'grade-7-prompt',
  '12': 'grade-12-prompt',
  '13+': 'post-graduation-prompt',
};

assert(selectByGrade(gradeMap, 1) === 'grade-1-prompt', 'exact match grade 1');
assert(selectByGrade(gradeMap, 5) === 'grade-5-prompt', 'exact match grade 5');
assert(selectByGrade(gradeMap, 12) === 'grade-12-prompt', 'exact match grade 12');

section('selectByGrade() — post-graduation');

assert(selectByGrade(gradeMap, 13) === 'post-graduation-prompt', 'grade 13 gets 13+');
assert(selectByGrade(gradeMap, 20) === 'post-graduation-prompt', 'grade 20 gets 13+');
assert(selectByGrade(gradeMap, 100) === 'post-graduation-prompt', 'grade 100 gets 13+');

section('selectByGrade() — band fallback');

const bandMap = {
  '1-3': 'early-prompt',
  '4-6': 'mid-prompt',
  '7-9': 'advanced-prompt',
  '10-12': 'expert-prompt',
  '13+': 'post-grad-prompt',
};

assert(selectByGrade(bandMap, 1) === 'early-prompt', 'grade 1 falls to 1-3 band');
assert(selectByGrade(bandMap, 2) === 'early-prompt', 'grade 2 falls to 1-3 band');
assert(selectByGrade(bandMap, 3) === 'early-prompt', 'grade 3 falls to 1-3 band');
assert(selectByGrade(bandMap, 4) === 'mid-prompt', 'grade 4 falls to 4-6 band');
assert(selectByGrade(bandMap, 6) === 'mid-prompt', 'grade 6 falls to 4-6 band');
assert(selectByGrade(bandMap, 7) === 'advanced-prompt', 'grade 7 falls to 7-9 band');
assert(selectByGrade(bandMap, 9) === 'advanced-prompt', 'grade 9 falls to 7-9 band');
assert(selectByGrade(bandMap, 10) === 'expert-prompt', 'grade 10 falls to 10-12 band');
assert(selectByGrade(bandMap, 12) === 'expert-prompt', 'grade 12 falls to 10-12 band');
assert(selectByGrade(bandMap, 15) === 'post-grad-prompt', 'grade 15 falls to 13+');

section('selectByGrade() — mixed exact and band');

const mixedMap = {
  '1': 'exact-1',
  '4-6': 'band-4-6',
  '13+': 'post-grad',
};

assert(selectByGrade(mixedMap, 1) === 'exact-1', 'exact match preferred over band');
assert(selectByGrade(mixedMap, 4) === 'band-4-6', 'band match for grade 4');
assert(selectByGrade(mixedMap, 2) === 'exact-1', 'grade 2 falls to first available key when no band');

section('selectByGrade() — edge cases');

assert(selectByGrade(null, 5) === null, 'null gradeMap returns null');
assert(selectByGrade(undefined, 5) === null, 'undefined gradeMap returns null');
assert(selectByGrade('not-an-object', 5) === null, 'non-object gradeMap returns null');
assert(selectByGrade({}, 5) === null, 'empty gradeMap returns null');

// Null/undefined grade defaults to 1
const simpleMap = { '1': 'default-prompt', '5': 'grade-5' };
assert(selectByGrade(simpleMap, null) === 'default-prompt', 'null grade defaults to 1');
assert(selectByGrade(simpleMap, undefined) === 'default-prompt', 'undefined grade defaults to 1');
assert(selectByGrade(simpleMap, 0) === 'default-prompt', 'grade 0 defaults to 1');

// First available key fallback when nothing matches
const oddMap = { '99': 'very-high' };
assert(selectByGrade(oddMap, 1) === 'very-high', 'falls back to first available key');

// ═══════════════════════════════════════════════════════════════════════
// Module exports
// ═══════════════════════════════════════════════════════════════════════

section('Module exports');

const mod = require('../lib/skills-condensers');
assert(typeof mod.selectByGrade === 'function', 'selectByGrade exported');
assert(typeof mod.getUncondensedExerciseCount === 'function', 'getUncondensedExerciseCount exported');
assert(typeof mod.buildMilestoneCondenser === 'function', 'buildMilestoneCondenser exported');
assert(typeof mod.buildCoreCondenserPrompt === 'function', 'buildCoreCondenserPrompt exported');
assert(typeof mod.buildMasterCondenser === 'function', 'buildMasterCondenser exported');
assert(typeof mod.getPostActionPrompts === 'function', 'getPostActionPrompts exported');
assert(typeof mod.buildDecisionMilestoneCondenser === 'function', 'buildDecisionMilestoneCondenser exported');
assert(typeof mod.buildDecisionCoreCondenserPrompt === 'function', 'buildDecisionCoreCondenserPrompt exported');
assert(typeof mod.buildDecisionMasterCondenser === 'function', 'buildDecisionMasterCondenser exported');
assert(typeof mod.buildForgeMilestoneCondenser === 'function', 'buildForgeMilestoneCondenser exported');
assert(typeof mod.buildForgeCoreCondenserPrompt === 'function', 'buildForgeCoreCondenserPrompt exported');
assert(typeof mod.buildForgeMasterCondenser === 'function', 'buildForgeMasterCondenser exported');

const exportKeys = Object.keys(mod);
assert(exportKeys.length === 12, `expected 12 exports, got ${exportKeys.length}`);

// ═══════════════════════════════════════════════════════════════════════
// Async condenser builders (with mocked getInternals)
//
// We mock the internals cache by calling clearInternalsCache then
// pre-populating it via a controlled getInternals call. Since the
// real getInternals hits Supabase, we instead test the condenser
// builders' response to getInternals returning defaults (catch path).
// ═══════════════════════════════════════════════════════════════════════

// We can test the condenser builders by monkey-patching getInternals.
// The condensers import getInternals from skills-core. We intercept
// the module's reference by overwriting the cache.

const { clearInternalsCache } = require('../lib/skills-core');

// Helper: set up a mock internals cache by temporarily replacing the module
// Since the condensers call getInternals() which hits Supabase, we need
// to intercept. We'll use the module's internal cache mechanism.
// clearInternalsCache + calling getInternals will fail on Supabase,
// but the condenser functions have defaults for all config values.

// For the async tests, we monkey-patch the skills-core module's getInternals
// to return mock data.
const skillsCoreModule = require('../lib/skills-core');
const originalGetInternals = skillsCoreModule.getInternals;

function mockInternals(mockData) {
  skillsCoreModule.getInternals = async () => mockData;
}

function restoreInternals() {
  skillsCoreModule.getInternals = originalGetInternals;
}

async function runAsyncTests() {
  section('buildMilestoneCondenser() — below trigger');

  mockInternals({ milestone_condenser_trigger: 5 });
  const belowTrigger = await buildMilestoneCondenser(3, 1);
  assert(belowTrigger === null, 'returns null when uncondensed < trigger');

  section('buildMilestoneCondenser() — at trigger');

  const atTrigger = await buildMilestoneCondenser(5, 1);
  assert(atTrigger !== null, 'returns result when uncondensed >= trigger');
  assert(typeof atTrigger.condenser_prompt === 'string', 'has condenser_prompt');
  assert(typeof atTrigger.storage_instruction === 'string', 'has storage_instruction');
  assert(typeof atTrigger.method_guidance === 'string', 'has method_guidance');

  section('buildMilestoneCondenser() — with grade map');

  mockInternals({
    milestone_condenser_trigger: 5,
    milestone_condenser_by_grade: {
      '1-3': 'early prompt for {uncondensed_count} exercises',
      '4-6': 'mid prompt',
    },
  });

  const graded = await buildMilestoneCondenser(10, 2);
  assert(graded.condenser_prompt.includes('early prompt'), 'grade-scaled prompt selected');
  assert(graded.condenser_prompt.includes('10'), '{uncondensed_count} replaced');

  const graded2 = await buildMilestoneCondenser(10, 5);
  assert(graded2.condenser_prompt.includes('mid prompt'), 'grade 5 gets mid prompt');

  section('buildCoreCondenserPrompt()');

  mockInternals({});
  const core = await buildCoreCondenserPrompt('milestone-1', null, 5);
  assert(typeof core.core_condenser_prompt === 'string', 'has core_condenser_prompt');
  assert(typeof core.skill_reference === 'string', 'has skill_reference');
  assert(Array.isArray(core.instructions), 'has instructions array');

  section('buildCoreCondenserPrompt() — with skill summary');

  const skillSummary = {
    verified: [{ name: 'Calibration', strength: 75, reps: 20, streak: 5 }],
    developing: [{ name: 'Source Evaluation', strength: 30, reps: 8 }],
  };
  const coreWithSkills = await buildCoreCondenserPrompt('milestone-2', skillSummary, 7);
  assert(coreWithSkills.skill_reference.includes('Calibration'), 'verified skill in reference');
  assert(coreWithSkills.skill_reference.includes('Source Evaluation'), 'developing skill in reference');

  section('buildMasterCondenser()');

  mockInternals({});
  const master = await buildMasterCondenser(skillSummary);
  assert(typeof master.master_condenser_prompt === 'string', 'has master_condenser_prompt');
  assert(master.is_graduation === true, 'is_graduation flag set');
  assert(typeof master.skill_reference === 'string', 'has skill_reference');
  assert(master.skill_reference.includes('Calibration'), 'verified skill in master reference');

  section('buildDecisionMilestoneCondenser() — below trigger');

  mockInternals({ milestone_condenser_trigger: 5 });
  const decBelow = await buildDecisionMilestoneCondenser(3, 1);
  assert(decBelow === null, 'returns null below trigger');

  section('buildDecisionMilestoneCondenser() — at trigger');

  const decAt = await buildDecisionMilestoneCondenser(5, 1);
  assert(decAt !== null, 'returns result at trigger');
  assert(typeof decAt.decision_condenser_prompt === 'string', 'has decision_condenser_prompt');

  section('buildDecisionCoreCondenserPrompt()');

  mockInternals({});
  const decCore = await buildDecisionCoreCondenserPrompt('milestone-1', 5);
  assert(typeof decCore.decision_paragraph_prompt === 'string', 'has decision_paragraph_prompt');
  assert(typeof decCore.decision_identity_prompt === 'string', 'has decision_identity_prompt');

  section('buildDecisionMasterCondenser()');

  const decMaster = await buildDecisionMasterCondenser();
  assert(typeof decMaster.decision_master_condenser_prompt === 'string', 'has decision_master_condenser_prompt');
  assert(decMaster.is_graduation === true, 'decision master has is_graduation flag');

  section('buildForgeMilestoneCondenser() — below trigger');

  mockInternals({ milestone_condenser_trigger: 5 });
  const forgeBelow = await buildForgeMilestoneCondenser(3, 1);
  assert(forgeBelow === null, 'returns null below trigger');

  section('buildForgeMilestoneCondenser() — at trigger');

  const forgeAt = await buildForgeMilestoneCondenser(5, 1);
  assert(forgeAt !== null, 'returns result at trigger');
  assert(typeof forgeAt.forge_condenser_prompt === 'string', 'has forge_condenser_prompt');
  assert(typeof forgeAt.forge_storage_instruction === 'string', 'has forge_storage_instruction');

  section('buildForgeCoreCondenserPrompt()');

  mockInternals({});
  const forgeCore = await buildForgeCoreCondenserPrompt('milestone-1', 5);
  assert(typeof forgeCore.forge_paragraph_prompt === 'string', 'has forge_paragraph_prompt');
  assert(typeof forgeCore.forge_identity_prompt === 'string', 'has forge_identity_prompt');

  section('buildForgeMasterCondenser()');

  const forgeMaster = await buildForgeMasterCondenser();
  assert(typeof forgeMaster.forge_master_condenser_prompt === 'string', 'has forge_master_condenser_prompt');
  assert(forgeMaster.is_graduation === true, 'forge master has is_graduation flag');

  // Restore
  restoreInternals();
}

// Run async tests then print summary
runAsyncTests().then(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Async test runner failed:', err);
  process.exit(1);
});
