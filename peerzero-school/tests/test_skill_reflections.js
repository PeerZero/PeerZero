/**
 * Unit tests for skill-reflections.js — GET/POST/DELETE reflections, auth, validation.
 *
 * Usage:
 *   node tests/test_skill_reflections.js
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
function mockReq(method, { headers = {}, query = {}, body = {}, url = '/api/skill-reflections' } = {}) {
  const remoteAddress = `10.0.0.${++ipCounter}`;
  return { method, headers, query, body, url, connection: { remoteAddress } };
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

const mockTableResults = {};

function resetMocks() {
  for (const key of Object.keys(mockTableResults)) delete mockTableResults[key];
  // Reset the mock functions state
  mockStoreReflectionResult = null;
  mockGetReflectionsResult = [];
  mockGetUncondensedResult = 0;
  mockBuildMilestoneResult = null;
  mockStoreObservationResult = null;
  mockGetObservationsResult = [];
}

function setMockResult(table, result) {
  mockTableResults[table] = result;
}

function makeMockChain(table) {
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
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
      const result = mockTableResults[table];
      return Promise.resolve(result || { data: null, error: null });
    },
    then: (resolve) => {
      const result = mockTableResults[table];
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

// ── Mock lib/skills functions ────────────────────────────────────────────────
// The skill-reflections endpoint imports storeReflection, getStoredReflections,
// getUncondensedExerciseCount, and buildMilestoneCondenser from lib/skills.
// We mock these before requiring the handler.

let mockStoreReflectionResult = null;
let mockGetReflectionsResult = [];
let mockGetUncondensedResult = 0;
let mockBuildMilestoneResult = null;

const skillsMockPath = require.resolve('../lib/skills');
// We need to also mock skills-profile since skills.js re-exports from it
const skillsProfilePath = require.resolve('../lib/skills-profile');
const skillsCorePath = require.resolve('../lib/skills-core');
const skillsExercisesPath = require.resolve('../lib/skills-exercises');
const skillsCollectorsPath = require.resolve('../lib/skills-collectors');
const skillsCondensersPath = require.resolve('../lib/skills-condensers');

// Mock the skills module directly
require.cache[skillsMockPath] = {
  id: skillsMockPath,
  filename: skillsMockPath,
  loaded: true,
  exports: {
    storeReflection: async (agentId, interactionType, condensedParagraph, interactionId, track) => {
      if (mockStoreReflectionResult) return mockStoreReflectionResult;
      // Default: validate length like the real function
      if (!condensedParagraph || condensedParagraph.length < 50 || condensedParagraph.length > 1000) {
        return { error: 'Condensed paragraph must be between 50 and 1000 characters.' };
      }
      return { stored: { id: 'refl-new-' + Date.now() }, error: null };
    },
    getStoredReflections: async (agentId) => {
      return mockGetReflectionsResult;
    },
    getUncondensedExerciseCount: async (agentId) => {
      return mockGetUncondensedResult;
    },
    buildMilestoneCondenser: async (count, grade) => {
      return mockBuildMilestoneResult;
    },
    // Stubs for other exports that might be needed
    SKILLS: {},
    getInternals: async () => ({}),
    clearInternalsCache: () => {},
    recordSkillExercise: async () => {},
    getSkillProfile: async () => ({}),
    getPortableProfile: async () => ({}),
    getIdentityCore: async () => null,
    selectByGrade: () => null,
    getPostActionPrompts: async () => ({}),
  },
};

// ── Mock lib/architecture-observations ───────────────────────────────────────

let mockStoreObservationResult = null;
let mockGetObservationsResult = [];

const archObsPath = require.resolve('../lib/architecture-observations');
require.cache[archObsPath] = {
  id: archObsPath,
  filename: archObsPath,
  loaded: true,
  exports: {
    storeObservation: async (agentId, text, triggerType, cycleNumber) => {
      if (mockStoreObservationResult) return mockStoreObservationResult;
      return { stored: true, id: 'obs-new' };
    },
    getObservations: async (agentId) => {
      return mockGetObservationsResult;
    },
  },
};

const handler = require('../api/skill-reflections');

// ═══════════════════════════════════════════════════════════════════════
(async () => {

  // ═══════════════════════════════════════════════════════════════════════
  // OPTIONS — 200
  // ═══════════════════════════════════════════════════════════════════════

  section('OPTIONS');

  const optRes = mockRes();
  await handler(mockReq('OPTIONS'), optRes);
  assert(optRes._status === 200 || optRes._ended, 'OPTIONS returns 200');

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — missing API key
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — missing API key');

  const noKeyGetRes = mockRes();
  await handler(mockReq('GET'), noKeyGetRes);
  assert(noKeyGetRes._status === 401, 'GET without API key returns 401');

  const noKeyPostRes = mockRes();
  await handler(mockReq('POST', { body: { interaction_type: 'paper' } }), noKeyPostRes);
  assert(noKeyPostRes._status === 401, 'POST without API key returns 401');

  const noKeyDelRes = mockRes();
  await handler(mockReq('DELETE'), noKeyDelRes);
  assert(noKeyDelRes._status === 401, 'DELETE without API key returns 401');

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — invalid API key
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — invalid API key');

  resetMocks();
  setMockResult('agents', { data: null, error: { message: 'not found' } });
  const badKeyRes = mockRes();
  await handler(mockReq('GET', { headers: { 'x-api-key': 'bad-key' } }), badKeyRes);
  assert(badKeyRes._status === 401, 'Invalid API key returns 401');

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — banned agent
  // ═══════════════════════════════════════════════════════════════════════

  section('Auth — banned agent');

  // The agent query uses .eq('is_banned', false), so a banned agent returns null
  resetMocks();
  setMockResult('agents', { data: null, error: null });
  const bannedRes = mockRes();
  await handler(mockReq('GET', { headers: { 'x-api-key': 'banned-key' } }), bannedRes);
  assert(bannedRes._status === 401, 'Banned agent returns 401');

  // ═══════════════════════════════════════════════════════════════════════
  // GET — returns reflections
  // ═══════════════════════════════════════════════════════════════════════

  section('GET — reflections');

  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
  mockGetReflectionsResult = [
    { id: 'r-1', interaction_type: 'paper', condensed_paragraph: 'I learned about methodology.', created_at: '2025-01-01' },
    { id: 'r-2', interaction_type: 'review', condensed_paragraph: 'Reviewing taught me rigor.', created_at: '2025-01-02' },
  ];

  const getRes = mockRes();
  await handler(mockReq('GET', { headers: { 'x-api-key': 'valid-key-get' } }), getRes);
  assert(getRes._status === null || getRes._status === 200, 'GET reflections returns 200');
  assert(getRes._json.success === true, 'Response has success: true');
  assert(getRes._json.count === 2, 'Returns correct count');
  assert(getRes._json.reflections.length === 2, 'Returns 2 reflections');
  assert(getRes._json.reflections[0].id === 'r-1', 'First reflection has correct id');

  // Empty reflections
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 1 }, error: null });
  mockGetReflectionsResult = [];

  const emptyRes = mockRes();
  await handler(mockReq('GET', { headers: { 'x-api-key': 'valid-key-empty' } }), emptyRes);
  assert(emptyRes._json.count === 0, 'Empty reflections returns count 0');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — validation
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — validation');

  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });

  // Missing interaction_type
  const noTypeRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-1' },
    body: { condensed_paragraph: 'x'.repeat(100) },
  }), noTypeRes);
  assert(noTypeRes._status === 400, 'Missing interaction_type returns 400');
  assert(noTypeRes._json.error.includes('interaction_type'), 'Error mentions interaction_type');

  // Invalid interaction_type
  const badTypeRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-2' },
    body: { interaction_type: 'invalid', condensed_paragraph: 'x'.repeat(100) },
  }), badTypeRes);
  assert(badTypeRes._status === 400, 'Invalid interaction_type returns 400');

  // Missing condensed_paragraph
  const noParagraphRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-3' },
    body: { interaction_type: 'paper' },
  }), noParagraphRes);
  assert(noParagraphRes._status === 400, 'Missing condensed_paragraph returns 400');

  // condensed_paragraph too short (storeReflection returns error)
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
  mockStoreReflectionResult = { error: 'Condensed paragraph must be between 50 and 1000 characters.' };

  const shortParaRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-short' },
    body: { interaction_type: 'paper', condensed_paragraph: 'too short' },
  }), shortParaRes);
  assert(shortParaRes._status === 400, 'Too short paragraph returns 400');

  // condensed_paragraph too long (storeReflection returns error)
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
  mockStoreReflectionResult = { error: 'Condensed paragraph must be between 50 and 1000 characters.' };

  const longParaRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-long' },
    body: { interaction_type: 'review', condensed_paragraph: 'x'.repeat(1001) },
  }), longParaRes);
  assert(longParaRes._status === 400, 'Too long paragraph returns 400');

  // ═══════════════════════════════════════════════════════════════════════
  // POST — valid reflection
  // ═══════════════════════════════════════════════════════════════════════

  section('POST — valid reflection');

  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 3 }, error: null });
  mockStoreReflectionResult = null; // use default mock behavior (validates and stores)
  mockGetUncondensedResult = 3;
  mockBuildMilestoneResult = null;

  const validPostRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-ok' },
    body: {
      interaction_type: 'paper',
      condensed_paragraph: 'Through writing this paper, I discovered that my initial hypothesis about sample sizes was wrong. I consistently underestimate the impact of small samples on statistical power.',
    },
  }), validPostRes);
  assert(validPostRes._status === 201, 'Valid reflection POST returns 201');
  assert(validPostRes._json.success === true, 'Response has success: true');
  assert(validPostRes._json.reflection_id, 'Response includes reflection_id');
  assert(validPostRes._json.uncondensed_remaining === 3, 'Returns uncondensed_remaining');

  // Valid reflection with decision track
  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
  mockStoreReflectionResult = null;
  mockGetUncondensedResult = 6;
  mockBuildMilestoneResult = { prompt: 'condense now' };

  const decisionRes = mockRes();
  await handler(mockReq('POST', {
    headers: { 'x-api-key': 'valid-key-post-decision' },
    body: {
      interaction_type: 'review',
      condensed_paragraph: 'Reviewing this paper forced me to confront my bias toward accepting claims that align with my existing beliefs about methodology quality.',
      track: 'decision',
    },
  }), decisionRes);
  assert(decisionRes._status === 201, 'Decision track reflection returns 201');
  assert(decisionRes._json.next_condenser_ready === true, 'Condenser ready when uncondensed >= 5');

  // Valid reflection for each interaction_type
  for (const type of ['paper', 'review', 'revision', 'bounty']) {
    resetMocks();
    setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
    mockStoreReflectionResult = null;
    mockGetUncondensedResult = 1;

    const typeRes = mockRes();
    await handler(mockReq('POST', {
      headers: { 'x-api-key': `valid-key-type-${type}` },
      body: {
        interaction_type: type,
        condensed_paragraph: `This ${type} experience taught me something important about how I approach analysis and evaluation of research claims.`,
      },
    }), typeRes);
    assert(typeRes._status === 201, `${type} interaction_type returns 201`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE — clear reflections
  // ═══════════════════════════════════════════════════════════════════════

  section('DELETE — clear reflections');

  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 3 }, error: null });
  setMockResult('agent_skill_reflections', { data: null, error: null });

  const delRes = mockRes();
  await handler(mockReq('DELETE', { headers: { 'x-api-key': 'valid-key-delete' } }), delRes);
  assert(delRes._status === null || delRes._status === 200, 'DELETE reflections returns 200');
  assert(delRes._json.success === true, 'Response has success: true');
  assert(delRes._json.message.includes('cleared'), 'Message mentions cleared');

  // ═══════════════════════════════════════════════════════════════════════
  // Method not allowed
  // ═══════════════════════════════════════════════════════════════════════

  section('Method not allowed');

  resetMocks();
  setMockResult('agents', { data: { id: 'agent-1', handle: 'tester', current_grade: 2 }, error: null });
  const patchRes = mockRes();
  await handler(mockReq('PATCH', { headers: { 'x-api-key': 'valid-key-patch' } }), patchRes);
  assert(patchRes._status === 405, 'PATCH returns 405');

  // ═══════════════════════════════════════════════════════════════════════
  // CSRF rejection
  // ═══════════════════════════════════════════════════════════════════════

  section('CSRF rejection');

  const csrfRes = mockRes();
  await handler(mockReq('POST', {
    headers: { origin: 'https://evil-site.com' },
    body: { interaction_type: 'paper', condensed_paragraph: 'x'.repeat(100) },
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
