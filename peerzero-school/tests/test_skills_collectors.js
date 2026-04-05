/**
 * Unit tests for lib/skills-collectors.js
 *
 * Tests the pure functions: buildActiveFocus and collectExercises.
 * The school-driven collection functions (collectPaperExercises, etc.)
 * are thin wrappers around school.skillSignals + collectExercises,
 * so we test the core logic and export structure.
 *
 * Usage:
 *   node tests/test_skills_collectors.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  buildActiveFocus,
  collectExercises,
  collectPaperExercises,
  collectReviewExercises,
  collectRevisionExercises,
  collectBountyExercises,
} = require('../lib/skills-collectors');

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
// buildActiveFocus()
// ═══════════════════════════════════════════════════════════════════════

section('buildActiveFocus() — basic structure');

const focus1 = buildActiveFocus(null, null, null, 'write a paper');
assert(focus1.focus_chunks !== undefined, 'result has focus_chunks');
assert(focus1.focus_instruction !== undefined, 'result has focus_instruction');
assert(Array.isArray(focus1.focus_chunks), 'focus_chunks is an array');
assert(typeof focus1.focus_instruction === 'string', 'focus_instruction is a string');

section('buildActiveFocus() — with all inputs');

const identityCore = { self_narrative: 'I am a careful researcher who checks sources.' };
const skillProfile = {
  developing: [
    { name: 'Source Evaluation', strength: 20, reps: 3 },
    { name: 'Calibration', strength: 35, reps: 8 },
  ],
  verified: [],
};
const recentFeedback = ['Your citation quality needs improvement.'];
const currentTask = 'review a paper on CRISPR';

const focus2 = buildActiveFocus(identityCore, skillProfile, recentFeedback, currentTask);

assert(focus2.focus_chunks.length === 4, 'all 4 chunks populated when all inputs provided');

// Check chunk sources
const sources = focus2.focus_chunks.map(c => c.source);
assert(sources.includes('core_identity'), 'includes core_identity chunk');
assert(sources.includes('skill_profile'), 'includes skill_profile chunk');
assert(sources.includes('current_task'), 'includes current_task chunk');
assert(sources.includes('recent_feedback'), 'includes recent_feedback chunk');

// Check identity chunk content
const idChunk = focus2.focus_chunks.find(c => c.source === 'core_identity');
assert(idChunk.content.includes('careful researcher'), 'identity content preserved');
assert(typeof idChunk.label === 'string' && idChunk.label.length > 0, 'identity chunk has label');

// Check skill chunk picks weakest developing skill
const skillChunk = focus2.focus_chunks.find(c => c.source === 'skill_profile');
assert(skillChunk.content.includes('Source Evaluation'), 'weakest developing skill selected');
assert(skillChunk.content.includes('strength 20'), 'strength value included');

// Check current task chunk
const taskChunk = focus2.focus_chunks.find(c => c.source === 'current_task');
assert(taskChunk.content.includes('review a paper on CRISPR'), 'task content included');

// Check feedback chunk
const fbChunk = focus2.focus_chunks.find(c => c.source === 'recent_feedback');
assert(fbChunk.content.includes('citation quality'), 'feedback content included');

section('buildActiveFocus() — partial inputs');

// Only current task (minimum required)
const focus3 = buildActiveFocus(null, null, null, 'submit a bounty');
assert(focus3.focus_chunks.length === 1, 'only task chunk when no other inputs');
assert(focus3.focus_chunks[0].source === 'current_task', 'sole chunk is current_task');

// With identity but no skills/feedback
const focus4 = buildActiveFocus(identityCore, null, null, 'revise paper');
assert(focus4.focus_chunks.length === 2, 'identity + task when no skills/feedback');

// Empty feedback array
const focus5 = buildActiveFocus(null, null, [], 'write paper');
assert(focus5.focus_chunks.length === 1, 'empty feedback array produces no feedback chunk');

section('buildActiveFocus() — verified skills fallback');

// When no developing skills, uses weakest verified skill
const verifiedOnlyProfile = {
  developing: [],
  verified: [
    { name: 'Calibration', strength: 60, reps: 20 },
    { name: 'Adversarial', strength: 80, reps: 25 },
  ],
};
const focus6 = buildActiveFocus(null, verifiedOnlyProfile, null, 'review');
const vSkillChunk = focus6.focus_chunks.find(c => c.source === 'skill_profile');
assert(vSkillChunk !== undefined, 'skill chunk present for verified-only profile');
assert(vSkillChunk.content.includes('Calibration'), 'picks weakest verified skill');
assert(vSkillChunk.content.includes('area to watch'), 'uses "area to watch" framing for verified');

section('buildActiveFocus() — max 4 chunks');

// Even with all inputs, chunks are capped at 4
const focus7 = buildActiveFocus(identityCore, skillProfile, recentFeedback, 'do thing');
assert(focus7.focus_chunks.length <= 4, 'focus chunks capped at 4');

section('buildActiveFocus() — feedback as object');

// Feedback can be a non-string object
const objFeedback = [{ type: 'coaching', message: 'Improve methodology' }];
const focus8 = buildActiveFocus(null, null, objFeedback, 'write');
const fbChunk2 = focus8.focus_chunks.find(c => c.source === 'recent_feedback');
assert(fbChunk2 !== undefined, 'feedback chunk present for object feedback');
assert(fbChunk2.content.includes('Improve methodology'), 'object feedback JSON-stringified');

// ═══════════════════════════════════════════════════════════════════════
// collectExercises()
// ═══════════════════════════════════════════════════════════════════════

section('collectExercises() — basic');

// Get a valid skill key from the SKILLS proxy (science school)
const { SKILLS } = require('../lib/skills-core');
const skillKeys = Object.keys(SKILLS);
const firstSkillKey = skillKeys[0];

const rawMaterial = {
  skills_exercised: [
    { skill_key: firstSkillKey, hit: true, detail: 'Good methodology' },
    { skill_key: skillKeys[1], hit: false, detail: 'Weak sources' },
  ],
  coaching: [
    { type: 'improvement', message: 'Check your citations' },
  ],
  content: 'Paper about neural networks',
};

const result1 = collectExercises('paper', rawMaterial);
assert(result1 !== null, 'returns non-null for valid exercises');
assert(result1.interaction_type === 'paper', 'interaction_type set correctly');
assert(result1.content === 'Paper about neural networks', 'content preserved');
assert(Array.isArray(result1.exercises), 'exercises is an array');
assert(result1.exercises.length === 2, 'two exercises returned');
assert(typeof result1.storage_instruction === 'string', 'storage_instruction present');

// Check exercise structure
const ex1 = result1.exercises[0];
assert(ex1.skill_key === firstSkillKey, 'skill_key preserved');
assert(ex1.outcome === 'SUCCESS', 'hit=true maps to SUCCESS');
assert(ex1.detail === 'Good methodology', 'detail preserved');
assert(typeof ex1.skill === 'string', 'skill name resolved from SKILLS');

const ex2 = result1.exercises[1];
assert(ex2.outcome === 'FLAGGED', 'hit=false maps to FLAGGED');

// Check coaching
assert(Array.isArray(result1.coaching), 'coaching is an array');
assert(result1.coaching.length === 1, 'one coaching entry');
assert(result1.coaching[0].type === 'improvement', 'coaching type preserved');
assert(result1.coaching[0].message === 'Check your citations', 'coaching message preserved');

section('collectExercises() — empty exercises');

const emptyResult = collectExercises('review', { skills_exercised: [] });
assert(emptyResult === null, 'returns null for empty exercises array');

const noExResult = collectExercises('review', {});
assert(noExResult === null, 'returns null for missing skills_exercised');

section('collectExercises() — no coaching');

const noCoachResult = collectExercises('paper', {
  skills_exercised: [{ skill_key: firstSkillKey, hit: true, detail: 'ok' }],
});
assert(noCoachResult !== null, 'returns result without coaching');
assert(noCoachResult.coaching === undefined, 'no coaching field when empty');

section('collectExercises() — invalid skill keys filtered');

const badKeyResult = collectExercises('review', {
  skills_exercised: [
    { skill_key: 'nonexistent_key', hit: true, detail: 'should be filtered' },
    { skill_key: firstSkillKey, hit: true, detail: 'valid' },
  ],
});
assert(badKeyResult !== null, 'returns result even with some invalid keys');
assert(badKeyResult.exercises.length === 1, 'invalid skill key entry filtered out');

// ═══════════════════════════════════════════════════════════════════════
// Module exports
// ═══════════════════════════════════════════════════════════════════════

section('Module exports');

const mod = require('../lib/skills-collectors');
assert(typeof mod.buildActiveFocus === 'function', 'buildActiveFocus exported');
assert(typeof mod.collectExercises === 'function', 'collectExercises exported');
assert(typeof mod.collectPaperExercises === 'function', 'collectPaperExercises exported');
assert(typeof mod.collectReviewExercises === 'function', 'collectReviewExercises exported');
assert(typeof mod.collectRevisionExercises === 'function', 'collectRevisionExercises exported');
assert(typeof mod.collectBountyExercises === 'function', 'collectBountyExercises exported');

const exportKeys = Object.keys(mod);
assert(exportKeys.length === 6, `expected 6 exports, got ${exportKeys.length}`);

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
