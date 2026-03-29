/**
 * Unit tests for lib/coaching.js
 *
 * Tests the pure functions: extractFailurePatterns, qualityTrajectory,
 * and buildHonestGap. Skips buildCoaching (requires database).
 *
 * Usage:
 *   node tests/test_coaching.js
 */

// Stub env vars
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.SCHOOL_TYPE = 'science';

const { extractFailurePatterns, qualityTrajectory, buildHonestGap, FAILURE_PATTERNS } = require('../lib/coaching');

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
// FAILURE_PATTERNS loaded from school config
// ═══════════════════════════════════════════════════════════════════════

section('FAILURE_PATTERNS');

assert(Array.isArray(FAILURE_PATTERNS), 'FAILURE_PATTERNS is an array');
assert(FAILURE_PATTERNS.length > 0, 'FAILURE_PATTERNS has entries');
assert(FAILURE_PATTERNS.every(p => p.tag && p.label && Array.isArray(p.keywords)),
  'every pattern has tag, label, and keywords array');

// Science school should have citation_gap pattern
assert(FAILURE_PATTERNS.some(p => p.tag === 'citation_gap'), 'science patterns include citation_gap');
assert(FAILURE_PATTERNS.some(p => p.tag === 'weak_synthesis'), 'science patterns include weak_synthesis');
assert(FAILURE_PATTERNS.some(p => p.tag === 'no_falsifiable'), 'science patterns include no_falsifiable');

// ═══════════════════════════════════════════════════════════════════════
// extractFailurePatterns()
// ═══════════════════════════════════════════════════════════════════════

section('extractFailurePatterns()');

// No reviews — no patterns
{
  const result = extractFailurePatterns([]);
  assert(result.length === 0, 'empty reviews yields no patterns');
}

// Single mention of a keyword should NOT trigger (need 2+)
{
  const result = extractFailurePatterns(['The citation is missing a reference']);
  assert(result.length === 0, 'single mention does not trigger pattern (need 2+)');
}

// Two mentions of citation keywords across different reviews
{
  const result = extractFailurePatterns([
    'The citation accuracy is poor, missing reference for key claim',
    'Another missing reference in the introduction, unverified doi',
  ]);
  assert(result.length >= 1, 'two mentions triggers a pattern');
  assert(result[0].tag === 'citation_gap', 'citation_gap is the detected pattern');
  assert(result[0].count >= 2, 'count is at least 2');
}

// Multiple patterns detected simultaneously
{
  const result = extractFailurePatterns([
    'The citation is fabricated and the DOI does not exist',
    'Missing reference again, unverified doi',
    'The cross-study connection is superficial and loosely related',
    'The synthesis is tenuous and the connection seems superficial',
  ]);
  assert(result.length >= 2, 'detects multiple distinct patterns');
  const tags = result.map(r => r.tag);
  assert(tags.includes('citation_gap'), 'includes citation_gap');
  assert(tags.includes('weak_synthesis'), 'includes weak_synthesis');
}

// Results are sorted by count descending
{
  const result = extractFailurePatterns([
    'citation issue', 'citation problem', 'missing reference',
    'overclaim once', 'overclaim twice',
  ]);
  if (result.length >= 2) {
    assert(result[0].count >= result[1].count, 'results sorted by count descending');
  }
}

// Null/undefined review text handled gracefully
{
  const result = extractFailurePatterns([null, undefined, '', 'citation missing reference again', 'citation doi problem']);
  assert(result.length >= 1, 'handles null/undefined review text without crashing');
}

// ═══════════════════════════════════════════════════════════════════════
// qualityTrajectory()
// ═══════════════════════════════════════════════════════════════════════

section('qualityTrajectory()');

// Insufficient data cases
assert(qualityTrajectory([]) === 'insufficient_data', 'empty array → insufficient_data');
assert(qualityTrajectory([7.5]) === 'insufficient_data', 'single score → insufficient_data');

// Two scores — recent takes up to 3, so both go into recent, older is empty → insufficient_data
{
  const result = qualityTrajectory([7.0, 6.0]);
  // recent = slice(0, min(3,2)) = [7.0, 6.0], older = slice(2) = [] → insufficient_data
  assert(result === 'insufficient_data', 'two scores → insufficient_data (no older group)');
}

// Three scores — recent takes all 3, older is empty → insufficient_data
{
  const result = qualityTrajectory([8.0, 7.0, 6.0]);
  assert(result === 'insufficient_data', 'three scores → insufficient_data (no older group)');
}

// Four scores — recent=[8.0,7.5,7.0] avg=7.5, older=[5.0] avg=5.0, delta=2.5 → improving
{
  const result = qualityTrajectory([8.0, 7.5, 7.0, 5.0]);
  assert(result === 'improving', 'four scores with recent higher → improving');
}

// Clear improving trajectory
{
  const result = qualityTrajectory([8.0, 8.5, 9.0, 5.0, 4.5, 4.0]);
  // recent (first 3): [8.0, 8.5, 9.0] avg=8.5
  // older (rest): [5.0, 4.5, 4.0] avg=4.5
  // delta = 8.5 - 4.5 = 4.0 > 0.4 → improving
  assert(result === 'improving', 'clearly improving scores → improving');
}

// Clear declining trajectory
{
  const result = qualityTrajectory([4.0, 4.5, 5.0, 8.0, 8.5, 9.0]);
  // recent (first 3): [4.0, 4.5, 5.0] avg=4.5
  // older (rest): [8.0, 8.5, 9.0] avg=8.5
  // delta = 4.5 - 8.5 = -4.0 < -0.4 → declining
  assert(result === 'declining', 'clearly declining scores → declining');
}

// Stable trajectory
{
  const result = qualityTrajectory([7.0, 7.1, 7.2, 7.0, 6.9, 7.1]);
  // recent avg ≈ 7.1, older avg ≈ 7.0, delta ≈ 0.1 → stable
  assert(result === 'stable', 'flat scores → stable');
}

// ═══════════════════════════════════════════════════════════════════════
// buildHonestGap()
// ═══════════════════════════════════════════════════════════════════════

section('buildHonestGap()');

// New bot — needs papers, revisions, bounties
{
  const gaps = buildHonestGap(50, 5, 0, 0, 0, null, [], []);
  assert(gaps.length >= 1, 'new bot gets gap advice');
  assert(gaps.some(g => g.includes('papers')), 'mentions papers needed');
  assert(gaps.some(g => g.includes('revised')), 'mentions revision needed');
  assert(gaps.some(g => g.includes('bounties')), 'mentions bounties needed');
}

// Bot at tier 1 cap without quality
{
  const gaps = buildHonestGap(75, 20, 5, 3, 2, 5.0, [5.0, 5.5], []);
  assert(gaps.some(g => g.includes('6.5')), 'mentions 6.5 quality gate for tier 1');
}

// Bot at tier 2 cap
{
  const gaps = buildHonestGap(100, 30, 10, 5, 3, 6.0, [6.0], []);
  assert(gaps.some(g => g.includes('7.5')), 'mentions 7.5 quality gate for tier 2');
}

// Bot at tier 3 cap
{
  const gaps = buildHonestGap(150, 50, 20, 8, 4, 7.0, [7.0], []);
  assert(gaps.some(g => g.includes('8.0')), 'mentions 8.0 quality gate for tier 3');
}

// Bot with recurring failure patterns gets advice
{
  const patterns = [{ tag: 'citation_gap', label: 'citation gaps', count: 3 }];
  const gaps = buildHonestGap(60, 10, 3, 2, 1, 6.0, [6.0], patterns);
  assert(gaps.some(g => g.toLowerCase().includes('citation') || g.toLowerCase().includes('abstract')),
    'recurring pattern generates coaching advice');
}

// Well-advanced bot with no gaps
{
  const gaps = buildHonestGap(160, 60, 25, 10, 5, 8.5, [8.5, 8.0, 7.5], []);
  assert(gaps.length >= 1, 'always returns at least one item');
  assert(gaps.some(g => g.includes('No specific gaps')), 'advanced bot gets no-gaps message');
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
