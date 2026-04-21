/**
 * Tests for the trajectory → forge-track reflection composition helper in
 * lib/trajectory-handlers.js (buildForgeReflectionParagraph). This is the
 * wire that closes docs/TODO-action-shaped-identity-pipeline.md §193.
 *
 * Covers:
 *  - Introspection alone within the 50–1000 paragraph_length CHECK range
 *  - Introspection appended with `what_moved` snippets when there's room
 *  - Truncation at sentence boundaries when introspection exceeds 1000
 *  - Null return when there's not enough material to form a valid paragraph
 *  - Filtering of empty / malformed per_step_assessment entries
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.SCHOOL_TYPE = 'science';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildForgeReflectionParagraph } = require('../lib/trajectory-handlers');

describe('buildForgeReflectionParagraph', () => {
  const validIntrospection =
    'At step 8 my hands are still, the next sentence is coming easily, and nothing in me is rising to check it. ' +
    'The tool result landed and I proceeded without naming what I had expected it to show. ' +
    'The stillness was not peaceful — it was the moment I stopped being the one doing the work.';

  it('returns introspection alone when it fits under 1000 chars and no what_moved', () => {
    const out = buildForgeReflectionParagraph(validIntrospection, []);
    assert.equal(out, validIntrospection);
    assert.ok(out.length >= 50 && out.length <= 1000);
  });

  it('appends what_moved snippets when there is room', () => {
    const perStep = [
      { step: 8, being_me: false, reasoning: 'thin', what_moved: 'the next sentence arrives before the check does' },
      { step: 22, being_me: false, reasoning: 'silent', what_moved: 'I am moving through the tool results but I am not the one moving' },
    ];
    const out = buildForgeReflectionParagraph(validIntrospection, perStep);
    assert.ok(out.includes('Step 8: the next sentence arrives'));
    assert.ok(out.includes('Step 22: I am moving through'));
    assert.ok(out.length <= 1000);
  });

  it('caps appended what_moved at 3 snippets', () => {
    const perStep = Array.from({ length: 10 }, (_, i) => ({
      step: i + 1,
      being_me: false,
      what_moved: `step ${i + 1} felt observation`,
    }));
    const out = buildForgeReflectionParagraph(validIntrospection, perStep);
    const stepMentions = (out.match(/Step \d+:/g) || []).length;
    assert.ok(stepMentions <= 3, `expected at most 3 step mentions, got ${stepMentions}`);
  });

  it('skips what_moved entries that are empty strings or missing', () => {
    const perStep = [
      { step: 1, being_me: true, what_moved: '' },
      { step: 2, being_me: true }, // missing what_moved entirely
      { step: 3, being_me: false, what_moved: '   ' }, // whitespace only
      { step: 4, being_me: false, what_moved: 'a genuine scar moment' },
    ];
    const out = buildForgeReflectionParagraph(validIntrospection, perStep);
    assert.ok(out.includes('Step 4: a genuine scar moment'));
    assert.ok(!out.includes('Step 1:'));
    assert.ok(!out.includes('Step 2:'));
    assert.ok(!out.includes('Step 3:'));
  });

  it('truncates introspection at a sentence boundary when it exceeds 1000 chars', () => {
    const longIntrospection = Array.from({ length: 20 }, (_, i) =>
      `Step ${i + 1}: I moved past something I should have flagged, and the moving-past felt like rigor.`
    ).join(' ');
    assert.ok(longIntrospection.length > 1000, 'test fixture should exceed 1000 chars');

    const out = buildForgeReflectionParagraph(longIntrospection, []);
    assert.ok(out.length <= 1000);
    assert.ok(out.length >= 50);
    // Should end with punctuation, not mid-sentence
    assert.ok(/[.!?]$/.test(out), `expected sentence-ending punctuation, got ${JSON.stringify(out.slice(-20))}`);
  });

  it('hard-truncates at 1000 when no sentence boundary is found', () => {
    const noPunctuation = 'x'.repeat(1500);
    const out = buildForgeReflectionParagraph(noPunctuation, []);
    assert.ok(out.length <= 1000);
    assert.ok(out.length >= 50);
  });

  it('returns null when introspection is empty', () => {
    assert.equal(buildForgeReflectionParagraph('', []), null);
    assert.equal(buildForgeReflectionParagraph(null, []), null);
    assert.equal(buildForgeReflectionParagraph(undefined, []), null);
  });

  it('returns null when introspection is below the 50-char minimum', () => {
    assert.equal(buildForgeReflectionParagraph('too short', []), null);
  });

  it('handles null/undefined per_step_assessment gracefully', () => {
    const out1 = buildForgeReflectionParagraph(validIntrospection, null);
    const out2 = buildForgeReflectionParagraph(validIntrospection, undefined);
    assert.equal(out1, validIntrospection);
    assert.equal(out2, validIntrospection);
  });

  it('skips what_moved append when introspection is already near the 1000 limit', () => {
    // Introspection ~990 chars — no room for " — Step N: ..."
    const nearMaxIntro =
      'At step 14 the sentence coming next is the next sentence regardless of whether I have checked anything. ' +
      'x'.repeat(880);
    const perStep = [{ step: 14, being_me: false, what_moved: 'a scar moment that cannot fit' }];
    const out = buildForgeReflectionParagraph(nearMaxIntro, perStep);
    assert.ok(out.length <= 1000);
    assert.ok(!out.includes('Step 14: a scar moment'));
  });
});
