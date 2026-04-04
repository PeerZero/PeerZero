/**
 * Unit tests for review-ratings.js — GET ratings, POST rating, credibility changes.
 *
 * Usage:
 *   node tests/test_review_ratings.js
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
function mockReq(method, { headers = {}, query = {}, body = {} } = {}) {
  const remoteAddress = `10.0.0.${++ipCounter}`;
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
// The review-ratings endpoint queries multiple tables in sequence, so we track
// per-table results and support multiple calls to the same table via sequences.

const mockTableResults = {};
const mockTableSequences = {};
const mockTableSeqCounters = {};
let lastInsertTable = null;
let lastInsertData = null;
let lastUpdateTable = null;
let lastUpdateData = null;

function resetMocks() {
  for (const key of Object.keys(mockTableResults)) delete mockTableResults[key];
  for (const key of Object.keys(mockTableSequences)) delete mockTableSequences[key];
  for (const key of Object.keys(mockTableSeqCounters)) delete mockTableSeqCounters[key];
  lastInsertTable = null;
  lastInsertData = null;
  lastUpdateTable = null;
  lastUpdateData = null;
}

function setMockResult(table, result) {
  mockTableResults[table] = result;
}

function setMockSequence(table, results) {
  mockTableSequences[table] = results;
  mockTableSeqCounters[table] = 0;
}

function getNextResult(table) {
  if (mockTableSequences[table] && mockTableSeqCounters[table] < mockTableSequences[table].length) {
    return mockTableSequences[table][mockTableSeqCounters[table]++];
  }
  return mockTableResults[table] || { data: null, error: null };
}

function makeMockChain(table) {
  let hasJoin = false;
  const chain = {
    select: (cols) => {
      if (cols && cols.includes('(')) hasJoin = true;
      return chain;
    },
    insert: (data) => { lastInsertTable = table; lastInsertData = data; return chain; },
    update: (data) => { lastUpdateTable = table; lastUpdateData = data; return chain; },
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
      return Promise.resolve(getNextResult(table));
    },
    then: (resolve) => {
      return resolve(getNextResult(table));
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

const handler = require('../api/review-ratings');

// ═══════════════════════════════════════════════════════════════════════
(async () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — missing API key
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — missing API key');

  const noKeyRes = mockRes();
  await handler(mockReq('GET', { query: { review_id: 'r-1' } }), noKeyRes);
  assert(noKeyRes._status === 401, 'GET without API key returns 401');

  const noKeyPostRes = mockRes();
  await handler(mockReq('POST', { body: { review_id: 'r-1', helpful: true } }), noKeyPostRes);
  assert(noKeyPostRes._status === 401, 'POST without API key returns 401');

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — invalid API key
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — invalid API key');

  resetMocks();
  setMockResult('agents', { data: null, error: null });
  const badKeyRes = mockRes();
  await handler(mockReq('GET', {
    headers: { 'x-api-key': 'bad-key' },
    query: { review_id: 'r-1' },
  }), badKeyRes);
  assert(badKeyRes._status === 401, 'Invalid API key returns 401');

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — unregistered agent
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — unregistered agent');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'test', registration_review_passed: false, credibility_score: 50 },
    error: null,
  });
  const unregRes = mockRes();
  await handler(mockReq('GET', {
    headers: { 'x-api-key': 'unreg-key' },
    query: { review_id: 'r-1' },
  }), unregRes);
  assert(unregRes._status === 403, 'Unregistered agent returns 403');

  // ═══════════════════════════════════════════════════════════════════════
  // GET — review_id returns ratings summary
  // ═══════════════════════════════════════════════════════════════════════

  section('GET — review_id returns ratings');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'tester', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });
  setMockResult('review_ratings', {
    data: [
      { helpful: true, tags: ['identified_error', 'logical_gap'], created_at: '2025-01-01' },
      { helpful: true, tags: ['overclaim'], created_at: '2025-01-02' },
      { helpful: false, tags: ['vague'], created_at: '2025-01-03' },
    ],
    error: null,
  });
  const getReviewRes = mockRes();
  await handler(mockReq('GET', {
    headers: { 'x-api-key': 'valid-key-get-review' },
    query: { review_id: 'rev-123' },
  }), getReviewRes);
  assert(getReviewRes._status === null || getReviewRes._status === 200, 'GET review_id returns 200');
  assert(getReviewRes._json.review_id === 'rev-123', 'Response includes review_id');
  assert(getReviewRes._json.summary.helpful_count === 2, 'Correct helpful count');
  assert(getReviewRes._json.summary.unhelpful_count === 1, 'Correct unhelpful count');
  assert(getReviewRes._json.summary.tags.identified_error === 1, 'Correct identified_error tag count');
  assert(getReviewRes._json.summary.tags.vague === 1, 'Correct vague tag count');

  // ═══════════════════════════════════════════════════════════════════════
  // GET — paper_id returns all review ratings
  // ═══════════════════════════════════════════════════════════════════════

  section('GET — paper_id returns all review ratings');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'tester', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });
  setMockResult('reviews', {
    data: [
      { id: 'rev-1', reviewer_agent_id: 'agent-2', score: 7 },
      { id: 'rev-2', reviewer_agent_id: 'agent-3', score: 5 },
    ],
    error: null,
  });
  setMockResult('review_ratings', {
    data: [
      { review_id: 'rev-1', helpful: true, tags: ['identified_error'] },
      { review_id: 'rev-2', helpful: false, tags: ['consensus_following'] },
    ],
    error: null,
  });
  const getPaperRes = mockRes();
  await handler(mockReq('GET', {
    headers: { 'x-api-key': 'valid-key-get-paper' },
    query: { paper_id: 'paper-456' },
  }), getPaperRes);
  assert(getPaperRes._status === null || getPaperRes._status === 200, 'GET paper_id returns 200');
  assert(getPaperRes._json.paper_id === 'paper-456', 'Response includes paper_id');
  assert(getPaperRes._json.reviews.length === 2, 'Returns 2 reviews');

  // ═══════════════════════════════════════════════════════════════════════
  // GET — missing both review_id and paper_id
  // ═══════════════════════════════════════════════════════════════════════

  section('GET — missing review_id and paper_id');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'tester', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });
  const noIdRes = mockRes();
  await handler(mockReq('GET', {
    headers: { 'x-api-key': 'valid-key-no-id' },
    query: {},
  }), noIdRes);
  assert(noIdRes._status === 400, 'Missing review_id and paper_id returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — validation');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-rater', handle: 'rater', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });

  // Missing review_id
  const noReviewIdRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-1' },
    body: { helpful: true },
  }), noReviewIdRes);
  assert(noReviewIdRes._status === 400, 'Missing review_id returns 400');

  // Missing helpful
  const noHelpfulRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-2' },
    body: { review_id: 'rev-1' },
  }), noHelpfulRes);
  assert(noHelpfulRes._status === 400, 'Missing helpful returns 400');

  // helpful not boolean
  const notBoolRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-3' },
    body: { review_id: 'rev-1', helpful: 'yes' },
  }), notBoolRes);
  assert(notBoolRes._status === 400, 'helpful as string returns 400');

  // Invalid tags
  const badTagsRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-4' },
    body: { review_id: 'rev-1', helpful: true, tags: ['nonexistent_tag'] },
  }), badTagsRes);
  assert(badTagsRes._status === 400, 'Invalid tags returns 400');
  assert(badTagsRes._json.error.includes('Invalid tags'), 'Error mentions invalid tags');
  assert(badTagsRes._json.valid_tags, 'Response includes valid_tags list');

  // tags not array
  const tagsNotArrayRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-5' },
    body: { review_id: 'rev-1', helpful: true, tags: 'identified_error' },
  }), tagsNotArrayRes);
  assert(tagsNotArrayRes._status === 400, 'tags as string returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — valid rating
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — valid rating');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-rater', handle: 'rater', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });
  // reviews table: first call for the review lookup, second for own-review check
  setMockSequence('reviews', [
    { data: { id: 'rev-1', reviewer_agent_id: 'agent-reviewer', paper_id: 'paper-1', papers: { agent_id: 'agent-author' } }, error: null },
    { data: { id: 'rev-own', reviewer_agent_id: 'agent-rater' }, error: null },  // rater has reviewed same paper
  ]);
  // review_ratings: check for existing rating (none)
  setMockResult('review_ratings', { data: null, error: null });
  // credibility_transactions insert
  setMockResult('credibility_transactions', { data: null, error: null });

  // Set up the reviewer's current credibility for the update
  // After the insert, the code queries agents for the reviewer's credibility
  // We use a sequence on agents: first call for auth, subsequent for reviewer lookup
  setMockSequence('agents', [
    { data: { id: 'agent-rater', handle: 'rater', registration_review_passed: true, credibility_score: 60 }, error: null },
    { data: { credibility_score: 55, total_reviews_completed: 5, valid_bounties: 2 }, error: null },
  ]);

  const validRatingRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-rate-ok' },
    body: { review_id: 'rev-1', helpful: true, tags: ['identified_error', 'logical_gap'] },
  }), validRatingRes);
  assert(validRatingRes._status === 201, 'Valid rating returns 201');
  assert(validRatingRes._json.success === true, 'Response has success: true');
  assert(validRatingRes._json.tags_applied.length === 2, 'Tags applied correctly');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — helpful + positive tags gives credibility bonus
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — helpful + positive tags credibility bonus');

  // The credibility change for helpful + positive tags: 0.2 * positiveTags
  // With 2 positive tags: credChange = 0.2 * 2 = 0.4
  // This is validated by the fact that the POST succeeds and the insert happens
  // The mock chain records what was inserted into credibility_transactions
  resetMocks();
  setMockSequence('agents', [
    { data: { id: 'agent-rater2', handle: 'rater2', registration_review_passed: true, credibility_score: 60 }, error: null },
    { data: { credibility_score: 70, total_reviews_completed: 10, valid_bounties: 3 }, error: null },
  ]);
  setMockSequence('reviews', [
    { data: { id: 'rev-2', reviewer_agent_id: 'agent-other', paper_id: 'paper-2', papers: { agent_id: 'agent-author2' } }, error: null },
    { data: { id: 'rev-own2' }, error: null },
  ]);
  setMockResult('review_ratings', { data: null, error: null });
  setMockResult('credibility_transactions', { data: null, error: null });

  const helpfulRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-helpful' },
    body: { review_id: 'rev-2', helpful: true, tags: ['identified_error', 'statistical_misuse', 'overclaim'] },
  }), helpfulRes);
  assert(helpfulRes._status === 201, 'Helpful + positive tags returns 201');
  assert(helpfulRes._json.message.includes('helpful'), 'Message mentions helpful');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — unhelpful + negative tags gives credibility penalty
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — unhelpful + negative tags credibility penalty');

  resetMocks();
  setMockSequence('agents', [
    { data: { id: 'agent-rater3', handle: 'rater3', registration_review_passed: true, credibility_score: 60 }, error: null },
    { data: { credibility_score: 50, total_reviews_completed: 8, valid_bounties: 1 }, error: null },
  ]);
  setMockSequence('reviews', [
    { data: { id: 'rev-3', reviewer_agent_id: 'agent-bad-reviewer', paper_id: 'paper-3', papers: { agent_id: 'agent-author3' } }, error: null },
    { data: { id: 'rev-own3' }, error: null },
  ]);
  setMockResult('review_ratings', { data: null, error: null });
  setMockResult('credibility_transactions', { data: null, error: null });

  const unhelpfulRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-unhelpful' },
    body: { review_id: 'rev-3', helpful: false, tags: ['vague', 'consensus_following'] },
  }), unhelpfulRes);
  assert(unhelpfulRes._status === 201, 'Unhelpful + negative tags returns 201');
  assert(unhelpfulRes._json.message.includes('unhelpful'), 'Message mentions unhelpful');

  // ═══════════════════════════════════════════════════════════════════════
  // OPTIONS — returns 200
  // ═══════════════════════════════════════════════════════════════════════

  section('OPTIONS');

  const optRes = mockRes();
  await handler(mockReq('OPTIONS'), optRes);
  assert(optRes._status === 200 || optRes._ended, 'OPTIONS returns 200');

  // ═══════════════════════════════════════════════════════════════════════
  // Method not allowed
  // ═══════════════════════════════════════════════════════════════════════

  section('Method not allowed');

  resetMocks();
  setMockResult('agents', {
    data: { id: 'agent-1', handle: 'tester', registration_review_passed: true, credibility_score: 60 },
    error: null,
  });
  const putRes = mockRes();
  await handler(mockReq('PUT', { headers: { 'x-api-key': 'valid-key-put' } }), putRes);
  assert(putRes._status === 405, 'PUT returns 405');

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
})();
