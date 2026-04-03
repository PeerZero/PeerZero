/**
 * Tests for checkGradeProgress() — grade advancement and failure logic.
 *
 * Uses mocked Supabase to test all code paths in lib/grades.js:checkGradeProgress.
 *
 * Usage:
 *   node tests/test_grade_progress.js
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

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
// Mock infrastructure
// ═══════════════════════════════════════════════════════════════════════

// Mock Supabase: tracks queries and returns configured data
let mockAgentData = null;
let mockPapersData = null;
let lastUpdate = null;

function buildChain(resolveData) {
  const chain = {
    _filters: {},
    select() { return chain; },
    eq(col, val) { chain._filters[col] = val; return chain; },
    neq() { return chain; },
    gte() { return chain; },
    is() { return chain; },
    not() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    single() { return Promise.resolve({ data: resolveData, error: null }); },
    then(resolve, reject) {
      return Promise.resolve({ data: resolveData, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

const mockSupabase = {
  from(table) {
    return {
      select() {
        if (table === 'agents') return buildChain(mockAgentData);
        if (table === 'papers') return buildChain(mockPapersData);
        return buildChain(null);
      },
      update(data) {
        lastUpdate = data;
        return {
          eq() { return Promise.resolve({ data: null, error: null }); },
        };
      },
    };
  },
};

// Inject mock Supabase into the module system
const shared = require('../lib/shared');
const origGetSupabase = shared.getSupabase;
shared.getSupabase = () => mockSupabase;

// Now require grades (it lazy-loads getSupabase from shared)
// We need to clear the cached lazy ref so it picks up our mock
delete require.cache[require.resolve('../lib/grades')];
const { checkGradeProgress } = require('../lib/grades');

function resetMocks() {
  mockAgentData = null;
  mockPapersData = null;
  lastUpdate = null;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

async function runTests() {

  // ── Agent not found ──
  section('Agent not found');
  resetMocks();
  mockAgentData = null;
  const notFound = await checkGradeProgress('nonexistent');
  assert(notFound === null, 'returns null when agent not found');

  // ── Grade 1: activity not met ──
  section('Grade 1 — activity not met (in progress)');
  resetMocks();
  mockAgentData = {
    current_grade: 1,
    grade_papers: 0,
    grade_reviews: 3,
    grade_revisions: 0,
    grade_bounties: 0,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 0,
    grade_fail_count: 0,
  };
  mockPapersData = [];
  const g1InProgress = await checkGradeProgress('agent-1');
  assert(g1InProgress.status === 'in_progress', 'status is in_progress');
  assert(g1InProgress.advanced === false, 'not advanced');
  assert(g1InProgress.failed === false, 'not failed');
  assert(g1InProgress.gradeInfo.activity_met === false, 'activity_met is false');
  assert(lastUpdate === null, 'no DB update when in progress');

  // ── Grade 1: activity met (no quality gate) → advance ──
  section('Grade 1 — activity met → advance (no quality gate)');
  resetMocks();
  mockAgentData = {
    current_grade: 1,
    grade_papers: 1,
    grade_reviews: 5,
    grade_revisions: 1,
    grade_bounties: 1,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 0,
    grade_fail_count: 0,
  };
  mockPapersData = []; // No scored papers — doesn't matter, grade 1 has min_score: null
  const g1Advance = await checkGradeProgress('agent-1');
  assert(g1Advance.status === 'advanced', 'status is advanced');
  assert(g1Advance.grade === 2, 'advanced to grade 2');
  assert(g1Advance.previousGrade === 1, 'previousGrade is 1');
  assert(g1Advance.advanced === true, 'advanced flag is true');
  assert(g1Advance.failed === false, 'failed flag is false');
  assert(lastUpdate !== null, 'DB update was issued');
  assert(lastUpdate.current_grade === 2, 'DB updated to grade 2');
  assert(lastUpdate.grade_papers === 0, 'counters reset');
  assert(lastUpdate.highest_grade_completed === 1, 'highest_grade_completed set to 1');

  // ── Grade 2: activity met + quality met → advance ──
  section('Grade 2 — activity met + quality met → advance');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  // Paper with score above min_score (6.0), recently reviewed so minimal decay
  mockPapersData = [
    { weighted_score: 7.5, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const g2Advance = await checkGradeProgress('agent-2');
  assert(g2Advance.status === 'advanced', 'status is advanced');
  assert(g2Advance.grade === 3, 'advanced to grade 3');
  assert(g2Advance.advanced === true, 'advanced flag');
  assert(g2Advance.failed === false, 'not failed');

  // ── Grade 2: activity met + quality NOT met → FAIL ──
  section('Grade 2 — activity met + quality NOT met → FAIL');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  // Paper scored below min_score of 6.0
  mockPapersData = [
    { weighted_score: 5.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const g2Fail = await checkGradeProgress('agent-2');
  assert(g2Fail.status === 'failed', 'status is failed');
  assert(g2Fail.grade === 2, 'stays at grade 2');
  assert(g2Fail.advanced === false, 'not advanced');
  assert(g2Fail.failed === true, 'failed flag is true');
  assert(g2Fail.gradeInfo.grade_fail_count === 1, 'fail count incremented to 1');
  assert(lastUpdate !== null, 'DB update was issued');
  assert(lastUpdate.grade_papers === 0, 'counters reset on failure');
  assert(lastUpdate.grade_fail_count === 1, 'fail count written to DB');
  assert(lastUpdate.current_grade === undefined, 'grade NOT changed on failure (stays same)');

  // ── Grade 2: activity met + NO scored papers → FAIL ──
  section('Grade 2 — activity met + no scored papers → FAIL');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  // Papers exist but none have weighted_score
  mockPapersData = [
    { weighted_score: null, last_reviewed_at: null, submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const g2FailNoScore = await checkGradeProgress('agent-2');
  assert(g2FailNoScore.status === 'failed', 'status is failed when no scored papers');
  assert(g2FailNoScore.failed === true, 'failed flag');
  assert(g2FailNoScore.bestGradeScore === null, 'bestGradeScore is null');

  // ── Grade 2: activity met + no papers at all → FAIL ──
  section('Grade 2 — activity met + empty papers list → FAIL');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  mockPapersData = [];
  const g2FailEmpty = await checkGradeProgress('agent-2');
  assert(g2FailEmpty.status === 'failed', 'fails with empty papers list');
  assert(g2FailEmpty.failed === true, 'failed flag');

  // ── grade_started_at null → bestGradeScore stays null → FAIL ──
  section('grade_started_at null — skips paper query → FAIL');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: null,  // <-- null
    highest_grade_completed: 1,
    grade_fail_count: 2,
  };
  mockPapersData = [
    { weighted_score: 9.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const nullStarted = await checkGradeProgress('agent-3');
  assert(nullStarted.status === 'failed', 'fails when grade_started_at is null (paper query skipped)');
  assert(nullStarted.bestGradeScore === null, 'bestGradeScore null because paper query was skipped');
  assert(nullStarted.gradeInfo.grade_fail_count === 3, 'fail count incremented from 2 to 3');

  // ── Multiple papers: best score used ──
  section('Multiple papers — uses best score');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  const now = new Date().toISOString();
  mockPapersData = [
    { weighted_score: 4.0, last_reviewed_at: now, submitted_at: '2025-01-15T00:00:00Z' },
    { weighted_score: 6.5, last_reviewed_at: now, submitted_at: '2025-02-01T00:00:00Z' },
    { weighted_score: 5.0, last_reviewed_at: now, submitted_at: '2025-02-15T00:00:00Z' },
  ];
  const multPapers = await checkGradeProgress('agent-4');
  assert(multPapers.status === 'advanced', 'advances using best paper score (6.5 >= 6.0)');
  assert(multPapers.bestGradeScore >= 6.0, 'best score is the max of all papers');

  // ── Grade 12 completion → graduation ──
  section('Grade 12 — activity + quality met → graduate');
  resetMocks();
  mockAgentData = {
    current_grade: 12,
    grade_papers: 2,
    grade_reviews: 10,
    grade_revisions: 2,
    grade_bounties: 4,
    grade_forge_papers: 1,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 11,
    grade_fail_count: 0,
  };
  mockPapersData = [
    { weighted_score: 9.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const g12 = await checkGradeProgress('agent-5');
  assert(g12.status === 'advanced', 'advanced past grade 12');
  assert(g12.grade === 13, 'now at grade 13');
  assert(g12.gradeInfo.highest_grade_completed === 12, 'highest_grade_completed is 12');
  assert(g12.gradeInfo.graduated === true, 'graduated flag is true');

  // ── Repeated failure increments fail count ──
  section('Repeated failures — fail count accumulates');
  resetMocks();
  mockAgentData = {
    current_grade: 5,
    grade_papers: 2,
    grade_reviews: 10,
    grade_revisions: 2,
    grade_bounties: 3,
    grade_forge_papers: 1,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 4,
    grade_fail_count: 4,
  };
  mockPapersData = [
    { weighted_score: 6.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const repeatFail = await checkGradeProgress('agent-6');
  assert(repeatFail.status === 'failed', 'fails (6.0 < 7.25 for grade 5)');
  assert(repeatFail.gradeInfo.grade_fail_count === 5, 'fail count now 5');
  assert(lastUpdate.grade_fail_count === 5, 'DB gets fail count 5');

  // ── Partial activity: one counter short ──
  section('Partial activity — one counter short');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 1,  // needs 2
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  mockPapersData = [
    { weighted_score: 3.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const partial = await checkGradeProgress('agent-7');
  assert(partial.status === 'in_progress', 'in_progress when bounties short by 1');
  assert(partial.failed === false, 'not failed — bad score is irrelevant since activity not met');
  assert(lastUpdate === null, 'no DB write');

  // ── Score exactly at threshold → advance ──
  section('Score exactly at threshold — advances');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  mockPapersData = [
    { weighted_score: 6.0, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const exact = await checkGradeProgress('agent-8');
  assert(exact.status === 'advanced', 'advances when score exactly equals min_score');

  // ── Score just below threshold → fail ──
  section('Score just below threshold — fails');
  resetMocks();
  mockAgentData = {
    current_grade: 2,
    grade_papers: 1,
    grade_reviews: 7,
    grade_revisions: 1,
    grade_bounties: 2,
    grade_started_at: '2025-01-01T00:00:00Z',
    highest_grade_completed: 1,
    grade_fail_count: 0,
  };
  mockPapersData = [
    { weighted_score: 5.99, last_reviewed_at: new Date().toISOString(), submitted_at: '2025-01-15T00:00:00Z' },
  ];
  const justBelow = await checkGradeProgress('agent-9');
  assert(justBelow.status === 'failed', 'fails when score is 5.99 (needs 6.0)');

  // ═══════════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n════════════════════════════════════════`);
  console.log(`checkGradeProgress: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed.');

  // Restore original
  shared.getSupabase = origGetSupabase;
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
