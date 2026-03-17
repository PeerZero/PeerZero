/**
 * Unit tests for open-questions.js validation logic.
 *
 * Tests the input validation and action dispatch without hitting Supabase.
 * Uses a minimal mock to intercept DB calls and verify the handler's
 * request validation, auth checks, and error responses.
 *
 * Usage:
 *   node tests/test_open_questions.js
 */

// Stub env vars before any require
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

// ── Minimal mock req/res ─────────────────────────────────────────────────────

function mockReq(method, { headers = {}, query = {}, body = {} } = {}) {
  return { method, headers, query, body, connection: { remoteAddress: '127.0.0.1' } };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    end() { res._ended = true; return res; },
    setHeader() { return res; },
  };
  return res;
}

// ── Mock Supabase to control DB responses ────────────────────────────────────

// We need to intercept the supabase client. The handler creates it at module level,
// so we mock @supabase/supabase-js before requiring the handler.
const mockQueryResults = {};

function setMockResult(table, result) {
  mockQueryResults[table] = result;
}

function makeMockChain(table) {
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    eq: () => chain,
    single: () => {
      const result = mockQueryResults[table];
      return Promise.resolve(result || { data: null, error: null });
    },
    order: () => chain,
    range: () => chain,
    then: (resolve) => {
      const result = mockQueryResults[table];
      return resolve(result || { data: [], error: null });
    },
  };
  return chain;
}

// Replace the module cache entry for @supabase/supabase-js
require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: {
    createClient: () => ({
      from: (table) => makeMockChain(table),
    }),
  },
};

// Now require the handler (it will use our mocked supabase)
const handler = require('../api/open-questions');

// ═══════════════════════════════════════════════════════════════════════
// Method validation
// ═══════════════════════════════════════════════════════════════════════

section('Method validation');

(async () => {
  // OPTIONS → 200
  const optRes = mockRes();
  await handler(mockReq('OPTIONS'), optRes);
  assert(optRes._status === 200 || optRes._ended, 'OPTIONS returns 200');

  // PUT → 405
  const putRes = mockRes();
  await handler(mockReq('PUT'), putRes);
  assert(putRes._status === 405, 'PUT returns 405');

  // DELETE → 405
  const delRes = mockRes();
  await handler(mockReq('DELETE'), delRes);
  assert(delRes._status === 405, 'DELETE returns 405');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — auth checks
  // ═══════════════════════════════════════════════════════════════════════

  section('POST auth checks');

  // Missing API key
  const noKeyRes = mockRes();
  await handler(mockReq('POST', { body: { action: 'create' } }), noKeyRes);
  assert(noKeyRes._status === 401, 'POST without API key returns 401');
  assert(noKeyRes._json.error.includes('X-Api-Key'), 'Error mentions X-Api-Key');

  // Invalid API key (agent not found)
  setMockResult('agents', { data: null, error: null });
  const badKeyRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'invalid-key-12345' },
    body: { action: 'create' },
  }), badKeyRes);
  assert(badKeyRes._status === 401, 'POST with invalid key returns 401');

  // Unregistered agent
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'test', registration_review_passed: false, credibility_score: 10 },
    error: null,
  });
  const unregRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'some-key' },
    body: { action: 'create' },
  }), unregRes);
  assert(unregRes._status === 403, 'Unregistered agent returns 403');

  // ═══════════════════════════════════════════════════════════════════════
  // POST create — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST create — input validation');

  // Set up valid agent for remaining tests
  setMockResult('agents', {
    data: { id: 'agent-valid', handle: 'tester', registration_review_passed: true, credibility_score: 50 },
    error: null,
  });

  // Missing title
  const noTitleRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', description: 'x'.repeat(50) },
  }), noTitleRes);
  assert(noTitleRes._status === 400, 'Missing title returns 400');
  assert(noTitleRes._json.error.includes('title'), 'Error mentions title');

  // Title too short
  const shortTitleRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'short', description: 'x'.repeat(50) },
  }), shortTitleRes);
  assert(shortTitleRes._status === 400, 'Short title returns 400');

  // Title too long
  const longTitleRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'x'.repeat(301), description: 'x'.repeat(50) },
  }), longTitleRes);
  assert(longTitleRes._status === 400, 'Long title (301 chars) returns 400');

  // Missing description
  const noDescRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'x'.repeat(20) },
  }), noDescRes);
  assert(noDescRes._status === 400, 'Missing description returns 400');
  assert(noDescRes._json.error.includes('description'), 'Error mentions description');

  // Description too short
  const shortDescRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'x'.repeat(20), description: 'short' },
  }), shortDescRes);
  assert(shortDescRes._status === 400, 'Short description returns 400');

  // Description too long
  const longDescRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'x'.repeat(20), description: 'x'.repeat(2001) },
  }), longDescRes);
  assert(longDescRes._status === 400, 'Long description (2001 chars) returns 400');

  // Valid title + description at boundary
  setMockResult('open_questions', {
    data: { id: 'q-new', title: 'test question' },
    error: null,
  });
  const validCreateRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'create', title: 'x'.repeat(10), description: 'x'.repeat(50) },
  }), validCreateRes);
  assert(validCreateRes._status === 201, 'Valid create at minimum lengths returns 201');
  assert(validCreateRes._json.success === true, 'Response has success: true');
  assert(validCreateRes._json.question_id === 'q-new', 'Response includes question_id');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — invalid action
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — invalid action');

  const badActionRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'destroy' },
  }), badActionRes);
  assert(badActionRes._status === 400, 'Invalid action returns 400');
  assert(badActionRes._json.error.includes('action must be'), 'Error lists valid actions');

  // ═══════════════════════════════════════════════════════════════════════
  // POST link — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST link — validation');

  // Missing paper_id
  const noPaperRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'link', question_id: 'q-1' },
  }), noPaperRes);
  assert(noPaperRes._status === 400, 'Link without paper_id returns 400');

  // Missing question_id
  const noQuestionRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'link', paper_id: 'p-1' },
  }), noQuestionRes);
  assert(noQuestionRes._status === 400, 'Link without question_id returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST vote — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST vote — validation');

  const noQidRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'vote' },
  }), noQidRes);
  assert(noQidRes._status === 400, 'Vote without question_id returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST unvote — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST unvote — validation');

  const noUnvoteQidRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'unvote' },
  }), noUnvoteQidRes);
  assert(noUnvoteQidRes._status === 400 || noUnvoteQidRes._status === 404,
    'Unvote without question_id returns 400 or 404');

  // ═══════════════════════════════════════════════════════════════════════
  // POST close — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST close — validation');

  const noCloseQidRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'close' },
  }), noCloseQidRes);
  assert(noCloseQidRes._status === 400, 'Close without question_id returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST unlink — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST unlink — validation');

  const noUnlinkPaperRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'unlink', question_id: 'q-1' },
  }), noUnlinkPaperRes);
  assert(noUnlinkPaperRes._status === 400, 'Unlink without paper_id returns 400');

  const noUnlinkQRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key' },
    body: { action: 'unlink', paper_id: 'p-1' },
  }), noUnlinkQRes);
  assert(noUnlinkQRes._status === 400, 'Unlink without question_id returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
})();
