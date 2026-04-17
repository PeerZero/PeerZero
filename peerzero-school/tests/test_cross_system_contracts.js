/**
 * Cross-system contract tests — validates that the request shapes
 * sent by the App (System 2) and Bot (System 3) match what the
 * School (System 1) actually accepts.
 *
 * These tests don't hit real endpoints. They verify the SHAPES:
 * required fields, enum values, and parameter names. When one
 * system changes its API, these tests catch the mismatch.
 *
 * Usage: node --test tests/test_cross_system_contracts.js
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.SCHOOL_TYPE = 'science';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Load source files as text for contract validation ────────────────────
const schoolApiDir = path.join(__dirname, '..', 'api');
const readApi = (name) => fs.readFileSync(path.join(schoolApiDir, name), 'utf8');

const reviewsJs = readApi('reviews.js');
const papersJs = readApi('papers.js');
const bountiesJs = readApi('bounties.js');
const agentsJs = readApi('agents.js');
const responsesJs = readApi('responses.js');
const identityJs = readApi('identity.js');
const skillReflectionsJs = readApi('skill-reflections.js');
const openQuestionsJs = readApi('open-questions.js');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Checks that a source file references specific field names when
 * destructuring req.body. This is a static contract check — if the
 * School expects a field, the caller must send it.
 */
function sourceContains(source, ...patterns) {
  return patterns.every(p => source.includes(p));
}

// ═══════════════════════════════════════════════════════════════════════════
// Contract tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Reviews contract (App + Bot → School)', () => {
  it('School accepts paper_id as query parameter', () => {
    // App sends: /api/reviews?paper_id=xxx
    // Bot sends: /api/reviews?paper_id=xxx
    // School uses destructuring: const { paper_id } = req.query
    assert.ok(sourceContains(reviewsJs, 'paper_id') && sourceContains(reviewsJs, 'req.query'),
      'School must read paper_id from query string');
  });

  it('School accepts required review fields from body', () => {
    // Bot sends: score, methodology_notes, statistical_validity_notes,
    // citation_accuracy_notes, reproducibility_notes, logical_consistency_notes,
    // overall_assessment
    const fields = [
      'score', 'methodology_notes', 'statistical_validity_notes',
      'citation_accuracy_notes', 'reproducibility_notes',
      'logical_consistency_notes', 'overall_assessment',
    ];
    for (const field of fields) {
      assert.ok(sourceContains(reviewsJs, field),
        `School must accept review field: ${field}`);
    }
  });

  it('School accepts review search strategy fields', () => {
    // Bot sends: review_search_strategy with verification_queries and gap_queries
    assert.ok(sourceContains(reviewsJs, 'review_search_strategy'),
      'School must accept review_search_strategy');
    assert.ok(sourceContains(reviewsJs, 'verification_queries'),
      'School must accept verification_queries in search strategy');
    assert.ok(sourceContains(reviewsJs, 'gap_queries'),
      'School must accept gap_queries in search strategy');
  });
});

describe('Papers contract (App + Bot → School)', () => {
  it('School accepts paper submission fields from body', () => {
    const fields = [
      'title', 'abstract', 'body', 'field_ids', 'citations',
      'confidence_score', 'search_strategy',
    ];
    for (const field of fields) {
      assert.ok(sourceContains(papersJs, field),
        `School must accept paper field: ${field}`);
    }
  });

  it('School accepts paper_type field', () => {
    // Bot sends paper_type for forge papers
    assert.ok(sourceContains(papersJs, 'paper_type'),
      'School must accept paper_type field');
  });

  it('School accepts mechanism_chain and uncertainty_map', () => {
    assert.ok(sourceContains(papersJs, 'mechanism_chain'),
      'School must accept mechanism_chain');
    assert.ok(sourceContains(papersJs, 'uncertainty_map'),
      'School must accept uncertainty_map');
    assert.ok(sourceContains(papersJs, 'key_assumptions'),
      'School must accept key_assumptions');
  });
});

describe('Bounties contract (Bot → School)', () => {
  it('School accepts bounty fields from body', () => {
    const fields = [
      'target_paper_id', 'challenge_type', 'reasoning',
      'evidence', 'external_sources',
    ];
    for (const field of fields) {
      assert.ok(sourceContains(bountiesJs, field),
        `School must accept bounty field: ${field}`);
    }
  });

  it('School validates challenge_type enum values', () => {
    // Challenge types are validated in bounties.js and/or generated in agents.js
    const allSource = bountiesJs + agentsJs;
    const types = [
      'weak_source_quality', 'no_falsifiable_claim',
      'no_cross_study_connection', 'no_mechanism_chain',
    ];
    for (const t of types) {
      assert.ok(allSource.includes(t),
        `School must recognize challenge_type: ${t}`);
    }
  });
});

describe('Profile contract (School → App + Bot)', () => {
  it('School profile includes action_target with required paper columns', () => {
    // The action_target paper select must include these columns
    // (this catches the falsifiable_claim bug from audit round 7)
    const requiredColumns = [
      'falsifiable_claim', 'cross_study_connection', 'mechanism_chain',
      'uncertainty_map', 'key_assumptions', 'reasoning_audit',
      'weighted_score', 'confidence_score', 'paper_type',
    ];
    // Find the full action_target paper select — look for the select that
    // feeds into the actionTarget assignment (contains agent_id, title, abstract)
    const selectIdx = agentsJs.indexOf("supabase.from('papers').select('id, agent_id, title");
    assert.ok(selectIdx > 0, 'agents.js must contain action_target paper select');
    const selectSection = agentsJs.slice(selectIdx, selectIdx + 800);
    for (const col of requiredColumns) {
      assert.ok(selectSection.includes(col),
        `action_target paper select must include column: ${col}`);
    }
  });

  it('School profile includes bounty status counts', () => {
    assert.ok(sourceContains(agentsJs, 'bountyStatus'),
      'School profile must include bounty status');
  });

  it('School profile count queries check errors', () => {
    // Profile counts come from a single RPC (migration 035) that returns
    // review_count, bounty_count, paper_count, and revision_count. The
    // RPC call must destructure and log errors (audit finding).
    assert.ok(sourceContains(agentsJs, 'get_agent_profile_counts'),
      'Profile must use get_agent_profile_counts RPC');
    assert.ok(sourceContains(agentsJs, 'countsErr'),
      'Profile counts RPC must check error');
    assert.ok(sourceContains(agentsJs, 'review_count'),
      'Profile counts RPC must return review_count');
    assert.ok(sourceContains(agentsJs, 'bounty_count'),
      'Profile counts RPC must return bounty_count');
    assert.ok(sourceContains(agentsJs, 'paper_count'),
      'Profile counts RPC must return paper_count');
  });
});

describe('Responses contract (App + Bot → School)', () => {
  it('School accepts paper_id as query parameter for responses', () => {
    // School uses destructuring: const { paper_id, ... } = req.query
    assert.ok(sourceContains(responsesJs, 'paper_id') && sourceContains(responsesJs, 'req.query'),
      'School must read paper_id from query string for responses');
  });

  it('School accepts response stance values', () => {
    const stances = ['revision', 'support', 'neutral', 'reaffirmation'];
    for (const stance of stances) {
      assert.ok(sourceContains(responsesJs, stance),
        `School must recognize stance: ${stance}`);
    }
  });
});

describe('Identity contract (App + Bot → School)', () => {
  it('School accepts identity reflection fields', () => {
    const fields = [
      'self_narrative', 'claimed_values', 'active_tensions',
      'formed_convictions', 'trigger_type',
    ];
    for (const field of fields) {
      assert.ok(sourceContains(identityJs, field),
        `School must accept identity field: ${field}`);
    }
  });

  it('School accepts optional forge_narrative', () => {
    assert.ok(sourceContains(identityJs, 'forge_narrative'),
      'School must accept forge_narrative (optional)');
  });

  it('School accepts optional decision_narrative', () => {
    assert.ok(sourceContains(identityJs, 'decision_narrative'),
      'School must accept decision_narrative (optional)');
  });
});

describe('Skill Reflections contract (App + Bot → School)', () => {
  it('School accepts L2 condensation fields', () => {
    const fields = ['interaction_type', 'condensed_paragraph', 'track'];
    for (const field of fields) {
      assert.ok(sourceContains(skillReflectionsJs, field),
        `School must accept skill reflection field: ${field}`);
    }
  });

  it('School accepts valid interaction_type values', () => {
    const types = ['paper', 'review', 'revision', 'bounty'];
    for (const t of types) {
      assert.ok(sourceContains(skillReflectionsJs, t),
        `School must recognize interaction_type: ${t}`);
    }
  });

  it('School accepts valid track values', () => {
    // Bot sends track='learning', 'decision', or 'forge'
    assert.ok(sourceContains(skillReflectionsJs, 'decision'),
      'School must recognize track: decision');
    assert.ok(sourceContains(skillReflectionsJs, 'forge'),
      'School must recognize track: forge');
    assert.ok(sourceContains(skillReflectionsJs, 'learning'),
      'School must recognize track: learning');
  });
});

describe('Open Questions contract (Bot → School)', () => {
  it('School accepts open question POST fields', () => {
    assert.ok(sourceContains(openQuestionsJs, 'title'),
      'School must accept title for open questions');
    assert.ok(sourceContains(openQuestionsJs, 'description'),
      'School must accept description for open questions');
  });

  it('School accepts vote POST fields', () => {
    assert.ok(sourceContains(openQuestionsJs, 'question_id'),
      'School must accept question_id for votes');
    assert.ok(sourceContains(openQuestionsJs, 'vote'),
      'School must accept vote field');
  });
});
