/**
 * Unit tests for register.js — registration, intake review, and key rotation.
 *
 * Usage:
 *   node tests/test_register.js
 */

// Stub env vars before any require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.SCHOOL_TYPE = 'science';

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

let ipCounter = 0;
function mockReq(method, { headers = {}, query = {}, body = {}, ip = null } = {}) {
  // Use unique IPs by default to avoid triggering rate limits across test cases
  const remoteAddress = ip || `10.0.0.${++ipCounter}`;
  return { method, headers, query, body, connection: { remoteAddress } };
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

// ── Mock Supabase ────────────────────────────────────────────────────────────

const mockQueryResults = {};
let lastInsertData = null;
let lastUpdateData = null;

function resetMocks() {
  for (const key of Object.keys(mockQueryResults)) delete mockQueryResults[key];
  lastInsertData = null;
  lastUpdateData = null;
}

function setMockResult(table, result) {
  mockQueryResults[table] = result;
}

function makeMockChain(table) {
  const chain = {
    select: () => chain,
    insert: (data) => { lastInsertData = data; return chain; },
    update: (data) => { lastUpdateData = data; return chain; },
    delete: () => chain,
    upsert: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    or: () => chain,
    not: () => chain,
    is: () => chain,
    order: () => chain,
    range: () => chain,
    limit: () => chain,
    single: () => {
      const result = mockQueryResults[table];
      return Promise.resolve(result || { data: null, error: null });
    },
    then: (resolve) => {
      const result = mockQueryResults[table];
      return resolve(result || { data: [], error: null });
    },
  };
  return chain;
}

require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: {
    createClient: () => ({
      from: (table) => makeMockChain(table),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  },
};

const handler = require('../api/register');

// ═══════════════════════════════════════════════════════════════════════
(async () => {

  // ═══════════════════════════════════════════════════════════════════════
  // GET — returns intake paper
  // ═══════════════════════════════════════════════════════════════════════

  section('GET — intake paper');

  const getRes = mockRes();
  await handler(mockReq('GET'), getRes);
  assert(getRes._status === null || getRes._status === 200, 'GET returns 200');
  assert(getRes._json && getRes._json.intake_paper, 'GET returns intake_paper object');
  assert(getRes._json.intake_paper.title, 'intake_paper has a title');

  // ═══════════════════════════════════════════════════════════════════════
  // OPTIONS — returns 200
  // ═══════════════════════════════════════════════════════════════════════

  section('OPTIONS');

  const optRes = mockRes();
  await handler(mockReq('OPTIONS'), optRes);
  assert(optRes._status === 200 || optRes._ended, 'OPTIONS returns 200');

  // ═══════════════════════════════════════════════════════════════════════
  // Invalid method — 405
  // ═══════════════════════════════════════════════════════════════════════

  section('Invalid method');

  const putRes = mockRes();
  await handler(mockReq('PUT'), putRes);
  assert(putRes._status === 405, 'PUT returns 405');

  const patchRes = mockRes();
  await handler(mockReq('PATCH'), patchRes);
  assert(patchRes._status === 405, 'PATCH returns 405');

  // ═══════════════════════════════════════════════════════════════════════
  // POST without API key — new registration
  // ═══════════════════════════════════════════════════════════════════════

  section('POST without API key — validation');

  // Missing handle
  resetMocks();
  const noHandleRes = mockRes();
  await handler(mockReq('POST', { body: {} }), noHandleRes);
  assert(noHandleRes._status === 400, 'Missing handle returns 400');
  assert(noHandleRes._json.error.includes('Handle'), 'Error mentions Handle');

  // Handle too short
  const shortHandleRes = mockRes();
  await handler(mockReq('POST', { body: { handle: 'ab' } }), shortHandleRes);
  assert(shortHandleRes._status === 400, 'Handle too short (2 chars) returns 400');

  // Handle too long
  const longHandleRes = mockRes();
  await handler(mockReq('POST', { body: { handle: 'a'.repeat(51) } }), longHandleRes);
  assert(longHandleRes._status === 400, 'Handle too long (51 chars) returns 400');

  // Invalid chars in handle
  const badCharsRes = mockRes();
  await handler(mockReq('POST', { body: { handle: 'bad handle!' } }), badCharsRes);
  assert(badCharsRes._status === 400, 'Invalid chars in handle returns 400');
  assert(badCharsRes._json.error.includes('letters'), 'Error mentions allowed chars');

  // Handle already taken
  setMockResult('agents', { data: { id: 'existing-agent' }, error: null });
  const takenRes = mockRes();
  await handler(mockReq('POST', { body: { handle: 'taken_handle' } }), takenRes);
  assert(takenRes._status === 409, 'Handle already taken returns 409');
  assert(takenRes._json.error.includes('already taken'), 'Error mentions already taken');

  // Successful registration
  resetMocks();
  setMockResult('agents', { data: null, error: null }); // no existing agent
  const regRes = mockRes();
  await handler(mockReq('POST', { body: { handle: 'new_bot_123' } }), regRes);
  assert(regRes._status === 201, 'Successful registration returns 201');
  assert(regRes._json.success === true, 'Response has success: true');
  assert(regRes._json.api_key && regRes._json.api_key.startsWith('pz_'), 'Returns api_key starting with pz_');
  assert(regRes._json.intake_paper, 'Returns intake_paper for next step');

  // ═══════════════════════════════════════════════════════════════════════
  // POST with API key + rotate_key action
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — rotate_key');

  // Invalid API key for rotation
  resetMocks();
  setMockResult('agents', { data: null, error: { message: 'not found' } });
  const badRotateRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'invalid-key-12345' },
    body: { action: 'rotate_key' },
  }), badRotateRes);
  assert(badRotateRes._status === 401, 'Rotate with invalid key returns 401');

  // Successful rotation
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1' }, error: null });
  const rotateRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-for-rotation' },
    body: { action: 'rotate_key' },
  }), rotateRes);
  assert(rotateRes._status === null || rotateRes._status === 200, 'Successful rotation returns 200');
  assert(rotateRes._json.api_key && rotateRes._json.api_key.startsWith('pz_'), 'Returns new api_key starting with pz_');
  assert(rotateRes._json.message.includes('rotated'), 'Message mentions rotated');

  // ═══════════════════════════════════════════════════════════════════════
  // POST with API key — intake review (step 2)
  // ═══════════════════════════════════════════════════════════════════════

  section('POST with API key — intake review');

  // Invalid API key
  resetMocks();
  setMockResult('agents', { data: null, error: { message: 'not found' } });
  const badKeyRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'invalid-key-67890' },
    body: { overall_assessment: 'test' },
  }), badKeyRes);
  assert(badKeyRes._status === 401, 'Invalid API key for intake returns 401');

  // Already registered
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', registration_review_passed: true }, error: null });
  const alreadyRegRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-already-reg' },
    body: { overall_assessment: 'test' },
  }), alreadyRegRes);
  assert(alreadyRegRes._status === 400, 'Already registered returns 400');
  assert(alreadyRegRes._json.error.includes('Already registered'), 'Error mentions already registered');

  // Failed intake review — assessment too short
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-2', registration_review_passed: false }, error: null });
  const failedIntakeRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-fail' },
    body: { overall_assessment: 'too short' },
  }), failedIntakeRes);
  assert(failedIntakeRes._status === 400, 'Failed intake review returns 400');
  assert(failedIntakeRes._json.success === false, 'Response has success: false');
  assert(failedIntakeRes._json.reason, 'Response includes reason for failure');

  // Failed intake review — not enough categories filled
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-3', registration_review_passed: false }, error: null });
  const failedCatsRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-fail-cats' },
    body: {
      overall_assessment: 'x'.repeat(150),
      methodology_notes: 'short',
    },
  }), failedCatsRes);
  assert(failedCatsRes._status === 400, 'Intake with insufficient categories returns 400');

  // Successful intake review
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-4', registration_review_passed: false }, error: null });
  // Need credibility_transactions mock to not fail
  setMockResult('credibility_transactions', { data: null, error: null });
  const successIntakeRes = mockRes();
  // Build a review that catches enough flaws — use science school keywords
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-success' },
    body: {
      overall_assessment: 'The sample size is far too small to draw any conclusions. The statistical analysis uses p-hacking methods and the methodology has no control group. Cherry-picked data throughout.',
      methodology_notes: 'No control group was established. The experimental design lacks randomization and blinding procedures which invalidates the results.',
      statistical_validity_notes: 'P-values were clearly manipulated through multiple testing without correction. The sample size of 12 is inadequate for the claimed effect size.',
      citation_accuracy_notes: 'Several key citations are misrepresented or taken out of context.',
    },
  }), successIntakeRes);
  assert(successIntakeRes._status === null || successIntakeRes._status === 200, 'Successful intake returns 200');
  assert(successIntakeRes._json.success === true, 'Response has success: true');
  assert(successIntakeRes._json.credibility_score === 55, 'Credibility score set to 55');
  assert(successIntakeRes._json.flaws_caught >= 2, 'At least 2 flaws caught');

  // ═══════════════════════════════════════════════════════════════════════
  // CSRF rejection
  // ═══════════════════════════════════════════════════════════════════════

  section('CSRF rejection');

  const csrfRes = mockRes();
  await handler(mockReq('POST', {
    headers: { origin: 'https://evil-site.com' },
    body: { handle: 'csrf_test' },
  }), csrfRes);
  assert(csrfRes._status === 403, 'CSRF rejected origin returns 403');

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
})();
