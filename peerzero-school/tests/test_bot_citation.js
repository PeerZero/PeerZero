/**
 * Unit tests for lib/bot-citation.js
 *
 * Tests bot self-citation detection: UUID DOIs, text UUID references,
 * bot handle references, and PeerZero mentions in citation descriptions.
 *
 * Uses mocked Supabase — no database required.
 *
 * Usage:
 *   node tests/test_bot_citation.js
 */

// Stub env vars
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
// Mock Supabase — intercept the lazy-loaded supabase client
// ═══════════════════════════════════════════════════════════════════════

// We need to mock getSupabase() in shared.js before bot-citation.js loads it.
// bot-citation uses lazy require: require('./shared').getSupabase
// So we mock shared.js's getSupabase to return our mock client.

let mockPapersData = [];
let mockAgentsData = [];

function createMockSupabase() {
  return {
    from(table) {
      let _data = [];
      if (table === 'papers') _data = mockPapersData;
      if (table === 'agents') _data = mockAgentsData;

      const chain = {
        _filters: {},
        select() { return chain; },
        in(col, vals) {
          if (table === 'papers') {
            chain._filtered = _data.filter(d => vals.map(v => v.toLowerCase()).includes(d.id.toLowerCase()));
          }
          return chain;
        },
        neq(col, val) {
          if (table === 'agents') {
            chain._agentFiltered = _data.filter(d => d[col] !== val);
          }
          return chain;
        },
        eq(col, val) {
          if (table === 'agents' && chain._agentFiltered) {
            chain._agentFiltered = chain._agentFiltered.filter(d => d[col] === val);
          }
          return chain;
        },
        limit() {
          return Promise.resolve({
            data: chain._filtered || chain._agentFiltered || _data,
          });
        },
      };
      // If no limit() is called, the chain itself resolves (for the agents query which has no limit)
      chain.then = (resolve) => {
        resolve({ data: chain._agentFiltered || _data });
      };
      return chain;
    },
  };
}

// Intercept shared.js to provide mock supabase
const sharedModule = require('../lib/shared');
const originalGetSupabase = sharedModule.getSupabase;
sharedModule.getSupabase = () => createMockSupabase();

// Now require bot-citation — it will use our mock
const { UUID_V4_PATTERN, detectBotCitation } = require('../lib/bot-citation');

// ═══════════════════════════════════════════════════════════════════════
// UUID_V4_PATTERN regex
// ═══════════════════════════════════════════════════════════════════════

section('UUID_V4_PATTERN');

assert(UUID_V4_PATTERN.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'matches valid UUID');
// Reset regex lastIndex after test() with global flag
UUID_V4_PATTERN.lastIndex = 0;
assert(!UUID_V4_PATTERN.test('not-a-uuid'), 'rejects non-UUID');
UUID_V4_PATTERN.lastIndex = 0;
assert(!UUID_V4_PATTERN.test('12345'), 'rejects short string');
UUID_V4_PATTERN.lastIndex = 0;

// Test that it matches UUIDs embedded in text
const testText = 'Referenced paper a1b2c3d4-e5f6-7890-abcd-ef1234567890 in the body';
UUID_V4_PATTERN.lastIndex = 0;
const matches = testText.match(UUID_V4_PATTERN);
assert(matches && matches.length === 1, 'finds UUID in surrounding text');

// ═══════════════════════════════════════════════════════════════════════
// detectBotCitation — clean submission (no flags)
// ═══════════════════════════════════════════════════════════════════════

section('detectBotCitation — clean submission');

async function runTests() {

  mockPapersData = [];
  mockAgentsData = [
    { id: 'agent-2', handle: 'ResearchBot', is_banned: false },
    { id: 'agent-3', handle: 'SciBot', is_banned: false },
  ];

  {
    const result = await detectBotCitation(
      { title: 'Effects of SIRT1 on metabolism', abstract: 'A study of metabolic pathways', body: 'Evidence suggests...' },
      [{ doi: '10.1038/nature12345', agent_summary: 'Found that SIRT1 regulates metabolism', relevance_explanation: 'Supports our claim', source_quality_note: '847 citations, Nature' }],
      'agent-1'
    );
    assert(result.detected === false, 'no flags on clean submission');
    assert(result.flags.length === 0, 'flags array is empty');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — UUID DOI matching PeerZero paper
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — UUID DOI as citation');

  {
    const paperId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    mockPapersData = [{ id: paperId, title: 'Some Bot Paper About SIRT1 Effects on Metabolism' }];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'Body text' },
      [{ doi: paperId, agent_summary: 'Found evidence', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects UUID DOI citing PeerZero paper');
    assert(result.flags.length >= 1, 'at least one flag');
    assert(result.flags[0].includes('PeerZero paper'), 'flag mentions PeerZero paper');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — UUID reference in body text
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — UUID in text body');

  {
    const paperId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    mockPapersData = [{ id: paperId, title: 'Another Bot Paper' }];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: `As shown in ${paperId}, the results indicate...` },
      [{ doi: '10.1038/nature99999', agent_summary: 'Legit paper', relevance_explanation: 'Relevant', source_quality_note: 'Strong' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects UUID reference in text');
    assert(result.flags.some(f => f.includes('Text references PeerZero paper')), 'flag mentions text reference');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — bot handle used as source
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — bot handle as citation source');

  {
    mockPapersData = [];
    mockAgentsData = [
      { id: 'agent-2', handle: 'ResearchBot', is_banned: false },
    ];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'As shown by ResearchBot, the metabolic pathway is...' },
      [{ doi: '10.1038/nature12345', agent_summary: 'Found evidence', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects bot handle used as source');
    assert(result.flags.some(f => f.includes('ResearchBot')), 'flag names the bot handle');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — bot handle possessive form
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — bot handle possessive form');

  {
    mockPapersData = [];
    mockAgentsData = [
      { id: 'agent-2', handle: 'ResearchBot', is_banned: false },
    ];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: "ResearchBot's paper demonstrated strong evidence for..." },
      [{ doi: '10.1038/nature12345', agent_summary: 'Found evidence', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects possessive bot handle reference');
    assert(result.flags.some(f => f.includes("ResearchBot's")), 'flag includes possessive form');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — PeerZero mention in citation description
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — PeerZero in citation description');

  {
    mockPapersData = [];
    mockAgentsData = [];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'Clean body text' },
      [{ doi: '10.1038/nature12345', agent_summary: 'This PeerZero paper found evidence of...', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects PeerZero mention in citation');
    assert(result.flags.some(f => f.includes('references PeerZero')), 'flag mentions PeerZero reference');
  }

  // Also test "peer zero" and "peer-zero" variants
  {
    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'Clean body text' },
      [{ doi: '10.1038/nature99999', agent_summary: 'From peer-zero platform', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    assert(result.detected === true, 'detects "peer-zero" variant in citation');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — short handles ignored (<=3 chars)
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — short handles ignored');

  {
    mockPapersData = [];
    mockAgentsData = [
      { id: 'agent-2', handle: 'AI', is_banned: false },
    ];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'As shown by AI, the model performs well' },
      [{ doi: '10.1038/nature12345', agent_summary: 'Study on AI models', relevance_explanation: 'Relevant', source_quality_note: 'Good' }],
      'agent-1'
    );
    // Should not flag short handles — too many false positives
    assert(result.flags.filter(f => f.includes('bot "AI"')).length === 0, 'short handle (<=3 chars) not flagged as bot citation');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // detectBotCitation — no citations array
  // ═══════════════════════════════════════════════════════════════════════

  section('detectBotCitation — edge cases');

  {
    mockPapersData = [];
    mockAgentsData = [];

    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'Body' },
      null,
      'agent-1'
    );
    assert(result.detected === false, 'handles null citations gracefully');
  }

  {
    const result = await detectBotCitation(
      { title: 'My paper', abstract: 'Abstract', body: 'Body' },
      [],
      'agent-1'
    );
    assert(result.detected === false, 'handles empty citations array');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  // Restore original getSupabase
  sharedModule.getSupabase = originalGetSupabase;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
