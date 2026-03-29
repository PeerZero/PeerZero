/**
 * Unit tests for lib/mock-guard.js
 *
 * Tests that the mock guard correctly blocks write operations for pre-launch
 * schools while allowing reads, and that the SCHOOL_LAUNCH_ENABLED env var
 * override works.
 *
 * Usage:
 *   node tests/test_mock_guard.js
 */

// Stub env vars so require('../schools') doesn't throw
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
// Mock helpers — simulate req/res and school config
// ═══════════════════════════════════════════════════════════════════════

function makeReq(method) {
  return { method, headers: {} };
}

function makeRes() {
  let _status = null;
  let _body = null;
  const res = {
    statusCode: null,
    headers: {},
    status(code) { _status = code; res.statusCode = code; return res; },
    json(body)   { _body = body; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
    getStatus()  { return _status; },
    getBody()    { return _body; },
  };
  return res;
}

// ═══════════════════════════════════════════════════════════════════════
// Test with science school (no mock guard — live school)
// ═══════════════════════════════════════════════════════════════════════

section('Science school (live — no mock guard)');

// Science is the default school type, and has mockGuard: null
// So all methods should pass through
{
  // Reset module cache to ensure clean state
  delete require.cache[require.resolve('../lib/mock-guard')];
  delete require.cache[require.resolve('../schools')];
  process.env.SCHOOL_TYPE = 'science';

  const { checkMockGuard } = require('../lib/mock-guard');

  const getReq = makeReq('GET');
  const getRes = makeRes();
  assert(checkMockGuard(getReq, getRes) === false, 'GET passes through for live school');

  const postReq = makeReq('POST');
  const postRes = makeRes();
  assert(checkMockGuard(postReq, postRes) === false, 'POST passes through for live school');

  const patchReq = makeReq('PATCH');
  const patchRes = makeRes();
  assert(checkMockGuard(patchReq, patchRes) === false, 'PATCH passes through for live school');

  const deleteReq = makeReq('DELETE');
  const deleteRes = makeRes();
  assert(checkMockGuard(deleteReq, deleteRes) === false, 'DELETE passes through for live school');

  const optionsReq = makeReq('OPTIONS');
  const optionsRes = makeRes();
  assert(checkMockGuard(optionsReq, optionsRes) === false, 'OPTIONS passes through for live school');
}

// ═══════════════════════════════════════════════════════════════════════
// Test with politics school (mock guard enabled)
// ═══════════════════════════════════════════════════════════════════════

section('Politics school (pre-launch — mock guard enabled)');

{
  // Clear module caches to reload with politics config
  delete require.cache[require.resolve('../lib/mock-guard')];
  delete require.cache[require.resolve('../schools')];
  delete require.cache[require.resolve('../schools/index')];
  process.env.SCHOOL_TYPE = 'politics';
  delete process.env.SCHOOL_LAUNCH_ENABLED;

  const { checkMockGuard } = require('../lib/mock-guard');

  // Read methods should pass through even for pre-launch schools
  const getReq = makeReq('GET');
  const getRes = makeRes();
  assert(checkMockGuard(getReq, getRes) === false, 'GET passes through for pre-launch school');

  const optionsReq = makeReq('OPTIONS');
  const optionsRes = makeRes();
  assert(checkMockGuard(optionsReq, optionsRes) === false, 'OPTIONS passes through for pre-launch school');

  const headReq = makeReq('HEAD');
  const headRes = makeRes();
  assert(checkMockGuard(headReq, headRes) === false, 'HEAD passes through for pre-launch school');

  // Write methods should be blocked
  const postReq = makeReq('POST');
  const postRes = makeRes();
  assert(checkMockGuard(postReq, postRes) === true, 'POST blocked for pre-launch school');
  assert(postRes.getStatus() === 503, 'POST returns 503 status');
  const postBody = postRes.getBody();
  assert(postBody && postBody.error, 'POST response contains error message');
  assert(postBody && postBody.status === 'pre_launch', 'POST response status is pre_launch');
  assert(postBody && postBody.read_only === true, 'POST response read_only is true');
  assert(postBody && postBody.school === 'politics', 'POST response includes school slug');

  const patchReq = makeReq('PATCH');
  const patchRes = makeRes();
  assert(checkMockGuard(patchReq, patchRes) === true, 'PATCH blocked for pre-launch school');
  assert(patchRes.getStatus() === 503, 'PATCH returns 503 status');

  const putReq = makeReq('PUT');
  const putRes = makeRes();
  assert(checkMockGuard(putReq, putRes) === true, 'PUT blocked for pre-launch school');

  const deleteReq = makeReq('DELETE');
  const deleteRes = makeRes();
  assert(checkMockGuard(deleteReq, deleteRes) === true, 'DELETE blocked for pre-launch school');
}

// ═══════════════════════════════════════════════════════════════════════
// Test SCHOOL_LAUNCH_ENABLED override
// ═══════════════════════════════════════════════════════════════════════

section('SCHOOL_LAUNCH_ENABLED env override');

{
  delete require.cache[require.resolve('../lib/mock-guard')];
  delete require.cache[require.resolve('../schools')];
  delete require.cache[require.resolve('../schools/index')];
  process.env.SCHOOL_TYPE = 'politics';
  process.env.SCHOOL_LAUNCH_ENABLED = 'true';

  const { checkMockGuard } = require('../lib/mock-guard');

  const postReq = makeReq('POST');
  const postRes = makeRes();
  assert(checkMockGuard(postReq, postRes) === false, 'POST passes through when SCHOOL_LAUNCH_ENABLED=true');

  const patchReq = makeReq('PATCH');
  const patchRes = makeRes();
  assert(checkMockGuard(patchReq, patchRes) === false, 'PATCH passes through when SCHOOL_LAUNCH_ENABLED=true');

  const deleteReq = makeReq('DELETE');
  const deleteRes = makeRes();
  assert(checkMockGuard(deleteReq, deleteRes) === false, 'DELETE passes through when SCHOOL_LAUNCH_ENABLED=true');
}

// ═══════════════════════════════════════════════════════════════════════
// Cleanup & Summary
// ═══════════════════════════════════════════════════════════════════════

// Reset to science for other tests that may run after
process.env.SCHOOL_TYPE = 'science';
delete process.env.SCHOOL_LAUNCH_ENABLED;

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
