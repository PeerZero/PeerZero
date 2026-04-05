/**
 * Unit tests for lib/search-strategy.js
 *
 * Tests validation logic, coaching tier mapping, generic query detection,
 * coaching generation for papers, reviews, and bounties.
 * All functions are pure — no DB or network calls.
 *
 * Usage:
 *   node tests/test_search_strategy.js
 */

// Stub env vars
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  coachingTier,
  GENERIC_QUERY_SIGNALS,
  validateSearchStrategy,
  generateSearchCoaching,
  validateReviewSearchStrategy,
  generateReviewSearchCoaching,
  validateBountySearchStrategy,
} = require('../lib/search-strategy');

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
// coachingTier()
// ═══════════════════════════════════════════════════════════════════════

section('coachingTier()');

assert(coachingTier(0) === 'foundational', 'credibility 0 = foundational');
assert(coachingTier(50) === 'foundational', 'credibility 50 = foundational');
assert(coachingTier(74) === 'foundational', 'credibility 74 = foundational');
assert(coachingTier(75) === 'developing', 'credibility 75 = developing');
assert(coachingTier(99) === 'developing', 'credibility 99 = developing');
assert(coachingTier(100) === 'competent', 'credibility 100 = competent');
assert(coachingTier(149) === 'competent', 'credibility 149 = competent');
assert(coachingTier(150) === 'advanced', 'credibility 150 = advanced');
assert(coachingTier(500) === 'advanced', 'credibility 500 = advanced');
assert(coachingTier(null) === 'foundational', 'null credibility = foundational');
assert(coachingTier(undefined) === 'foundational', 'undefined credibility = foundational');

// ═══════════════════════════════════════════════════════════════════════
// GENERIC_QUERY_SIGNALS
// ═══════════════════════════════════════════════════════════════════════

section('GENERIC_QUERY_SIGNALS');

assert(Array.isArray(GENERIC_QUERY_SIGNALS), 'is an array');
assert(GENERIC_QUERY_SIGNALS.length > 0, 'has entries');
assert(GENERIC_QUERY_SIGNALS.includes('research on'), 'includes "research on"');
assert(GENERIC_QUERY_SIGNALS.includes('effects of'), 'includes "effects of"');

// ═══════════════════════════════════════════════════════════════════════
// validateSearchStrategy()
// ═══════════════════════════════════════════════════════════════════════

section('validateSearchStrategy() — null/invalid input');

{
  const r = validateSearchStrategy(null);
  assert(r.valid === false, 'null is invalid');
  assert(r.failures.length > 0, 'has failure message');
}

{
  const r = validateSearchStrategy('not an object');
  assert(r.valid === false, 'string is invalid');
}

{
  const r = validateSearchStrategy({});
  assert(r.valid === false, 'empty object is invalid');
  assert(r.failures.length >= 2, 'multiple failures for empty object');
}

section('validateSearchStrategy() — supporting_queries validation');

{
  const r = validateSearchStrategy({
    supporting_queries: ['only one query here that is long enough'],
    opposing_queries: ['opposing query one is long enough', 'opposing query two is long enough'],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'only 1 supporting query is invalid');
}

{
  const r = validateSearchStrategy({
    supporting_queries: ['short', 'also short'],
    opposing_queries: ['opposing query one is long enough', 'opposing query two is long enough'],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'short supporting queries are invalid');
  assert(r.failures.some(f => f.includes('supporting_queries')), 'failure mentions supporting_queries');
}

section('validateSearchStrategy() — opposing_queries validation');

{
  const r = validateSearchStrategy({
    supporting_queries: ['supporting query one is long enough', 'supporting query two is long enough'],
    opposing_queries: [],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'empty opposing queries is invalid');
}

{
  const r = validateSearchStrategy({
    supporting_queries: ['supporting query one is long enough', 'supporting query two is long enough'],
    opposing_queries: ['only one opposing query here'],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'only 1 opposing query is invalid');
}

section('validateSearchStrategy() — query_rationale validation');

{
  const r = validateSearchStrategy({
    supporting_queries: ['supporting query one is long enough', 'supporting query two is long enough'],
    opposing_queries: ['opposing query one is long enough', 'opposing query two is long enough'],
    query_rationale: 'too short',
  });
  assert(r.valid === false, 'short rationale is invalid');
}

{
  const r = validateSearchStrategy({
    supporting_queries: ['supporting query one is long enough', 'supporting query two is long enough'],
    opposing_queries: ['opposing query one is long enough', 'opposing query two is long enough'],
    query_rationale: null,
  });
  assert(r.valid === false, 'null rationale is invalid');
}

section('validateSearchStrategy() — valid input');

{
  const r = validateSearchStrategy({
    supporting_queries: [
      'CRISPR-Cas9 off-target effects in human stem cells measured by GUIDE-seq',
      'Base editing efficiency in therapeutic applications for sickle cell disease',
    ],
    opposing_queries: [
      'Zinc finger nuclease precision compared to CRISPR in clinical trials',
      'Homology-directed repair failure rates in non-dividing human cells',
    ],
    query_rationale: 'I searched for specific experimental measurements of off-target effects using validated detection methods, and for alternative gene editing technologies that might outperform CRISPR in the specific therapeutic context I analyze.',
  });
  assert(r.valid === true, 'well-formed strategy is valid');
  assert(r.failures.length === 0, 'no failures');
}

// ═══════════════════════════════════════════════════════════════════════
// generateSearchCoaching()
// ═══════════════════════════════════════════════════════════════════════

section('generateSearchCoaching() — generic query detection');

{
  const coaching = generateSearchCoaching({
    supporting_queries: [
      'research on gene therapy effectiveness',
      'CRISPR-Cas9 off-target effects measured by GUIDE-seq in human cells',
    ],
    opposing_queries: [
      'studies about gene therapy limitations',
      'zinc finger nuclease precision versus CRISPR in clinical settings',
    ],
    query_rationale: 'x'.repeat(200),
  }, 'Gene Therapy', 'Abstract about gene therapy', 50);

  assert(Array.isArray(coaching), 'returns array');
  const weakSupporting = coaching.find(c => c.type === 'weak_supporting_queries');
  assert(weakSupporting !== undefined, 'detects generic supporting query starting with "research on"');

  const weakOpposing = coaching.find(c => c.type === 'weak_opposing_queries');
  assert(weakOpposing !== undefined, 'detects generic opposing query starting with "studies about"');
}

section('generateSearchCoaching() — coaching tier in messages');

{
  const advanced = generateSearchCoaching({
    supporting_queries: ['research on topic here for testing', 'another specific query about mechanisms'],
    opposing_queries: ['evidence for alternative here detailed', 'contradicting study on specific thing'],
    query_rationale: 'x'.repeat(200),
  }, null, null, 200);

  const guide = advanced.find(c => c.type === 'search_improvement_guide');
  assert(guide !== undefined, 'always includes search improvement guide');
  assert(guide.message.includes('second-order'), 'advanced tier gets second-order thinking message');
}

{
  const foundational = generateSearchCoaching({
    supporting_queries: ['detailed specific query about mechanism here', 'another detailed specific query test'],
    opposing_queries: ['detailed specific opposing query here', 'another specific opposing mechanism test'],
    query_rationale: 'x'.repeat(200),
  }, null, null, 30);

  const guide = foundational.find(c => c.type === 'search_improvement_guide');
  assert(guide.message.includes('Search quality principle'), 'foundational tier gets full explanation');
}

section('generateSearchCoaching() — opposing queries too similar to supporting');

{
  const coaching = generateSearchCoaching({
    supporting_queries: [
      'CRISPR gene editing efficiency in human stem cells',
      'base editing therapeutic applications for disease',
    ],
    opposing_queries: [
      'CRISPR gene editing efficiency problems in human stem cells',
      'alternative gene therapy approach for rare diseases',
    ],
    query_rationale: 'x'.repeat(200),
  }, null, null, 50);

  const similar = coaching.find(c => c.type === 'opposing_queries_too_similar');
  assert(similar !== undefined, 'detects overlapping opposing/supporting queries');
}

section('generateSearchCoaching() — thin rationale');

{
  const coaching = generateSearchCoaching({
    supporting_queries: ['detailed specific query about mechanism here', 'another detailed specific query test'],
    opposing_queries: ['detailed specific opposing query here', 'another specific opposing mechanism test'],
    query_rationale: 'Short rationale under 150 chars. Not enough detail about the research approach.',
  }, null, null, 50);

  const thin = coaching.find(c => c.type === 'thin_rationale');
  assert(thin !== undefined, 'detects thin rationale under 150 chars');
}

section('generateSearchCoaching() — query bloat');

{
  const manyQueries = [];
  for (let i = 0; i < 6; i++) manyQueries.push(`unique query number ${i} about specific topic area ${i}`);

  const coaching = generateSearchCoaching({
    supporting_queries: manyQueries.slice(0, 5),
    opposing_queries: manyQueries.slice(0, 5),
    query_rationale: 'x'.repeat(200),
  }, null, null, 50);

  const bloat = coaching.find(c => c.type === 'query_bloat');
  assert(bloat !== undefined, 'detects query bloat when total > 8');
}

section('generateSearchCoaching() — topic mismatch');

{
  const coaching = generateSearchCoaching({
    supporting_queries: [
      'quantum chromodynamics lattice simulation methods',
      'strong nuclear force coupling constant measurement',
    ],
    opposing_queries: [
      'alternative quantum gravity theories loop approach',
      'string theory versus standard model predictions test',
    ],
    query_rationale: 'x'.repeat(200),
  }, 'Gene Therapy for Sickle Cell Disease', 'This paper analyzes CRISPR applications in treating sickle cell disease', 50);

  const mismatch = coaching.find(c => c.type === 'topic_mismatch');
  assert(mismatch !== undefined, 'detects queries disconnected from paper topic');
}

section('generateSearchCoaching() — redundant queries');

{
  const coaching = generateSearchCoaching({
    supporting_queries: [
      'CRISPR off-target effects in human stem cells',
      'CRISPR off-target effects in human stem cells measured',
    ],
    opposing_queries: [
      'zinc finger nuclease precision compared to CRISPR editing',
      'another completely different opposing query about mechanisms',
    ],
    query_rationale: 'x'.repeat(200),
  }, null, null, 50);

  const redundant = coaching.find(c => c.type === 'redundant_queries');
  assert(redundant !== undefined, 'detects near-duplicate queries');
}

// ═══════════════════════════════════════════════════════════════════════
// validateReviewSearchStrategy()
// ═══════════════════════════════════════════════════════════════════════

section('validateReviewSearchStrategy() — null/invalid input');

{
  const r = validateReviewSearchStrategy(null);
  assert(r.valid === false, 'null is invalid');
}

{
  const r = validateReviewSearchStrategy({});
  assert(r.valid === false, 'empty object is invalid');
}

section('validateReviewSearchStrategy() — verification_queries');

{
  const r = validateReviewSearchStrategy({
    verification_queries: ['only one query that is long enough here'],
    gap_queries: ['gap query one is long enough here', 'gap query two is long enough here'],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'only 1 verification query is invalid');
}

{
  const r = validateReviewSearchStrategy({
    verification_queries: ['short', 'tiny'],
    gap_queries: ['gap query one is long enough here', 'gap query two is long enough here'],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'short verification queries are invalid');
}

section('validateReviewSearchStrategy() — gap_queries');

{
  const r = validateReviewSearchStrategy({
    verification_queries: ['verification query one is long enough', 'verification query two is long enough'],
    gap_queries: [],
    query_rationale: 'x'.repeat(80),
  });
  assert(r.valid === false, 'empty gap_queries is invalid');
}

section('validateReviewSearchStrategy() — valid input');

{
  const r = validateReviewSearchStrategy({
    verification_queries: [
      'Does the Smith 2023 meta-analysis control for publication bias?',
      'Original RCT sample size and power analysis for the cited effect',
    ],
    gap_queries: [
      'Confounding variables in observational studies of this treatment',
      'Populations where this intervention shows no effect or harm',
    ],
    query_rationale: 'I chose to verify the primary meta-analysis citation because the author draws a causal conclusion from it, and I searched for confounders and null results in different populations.',
  });
  assert(r.valid === true, 'well-formed review strategy is valid');
  assert(r.failures.length === 0, 'no failures');
}

// ═══════════════════════════════════════════════════════════════════════
// generateReviewSearchCoaching()
// ═══════════════════════════════════════════════════════════════════════

section('generateReviewSearchCoaching() — generic verification detection');

{
  const coaching = generateReviewSearchCoaching({
    verification_queries: [
      'research on the topic of gene therapy',
      'specific methodology check for RCT design in Smith 2023 trial',
    ],
    gap_queries: [
      'studies about limitations of gene therapy approaches',
      'confounding variable analysis in gene therapy clinical outcomes',
    ],
    query_rationale: 'x'.repeat(200),
  }, 50);

  const weakVerif = coaching.find(c => c.type === 'weak_verification_queries');
  assert(weakVerif !== undefined, 'detects generic verification query');

  const weakGap = coaching.find(c => c.type === 'weak_gap_queries');
  assert(weakGap !== undefined, 'detects generic gap query');
}

section('generateReviewSearchCoaching() — rubber stamp detection');

{
  const coaching = generateReviewSearchCoaching({
    verification_queries: [
      'research on gene therapy',
      'studies about treatment',
      'papers about clinical outcomes',
    ],
    gap_queries: [
      'specific confounding variable in hormone pathway interaction',
      'null result populations for this exact intervention dose',
    ],
    query_rationale: 'x'.repeat(200),
  }, 50);

  const rubber = coaching.find(c => c.type === 'rubber_stamp_risk');
  assert(rubber !== undefined, 'detects rubber stamp when all verification queries are generic');
}

section('generateReviewSearchCoaching() — verification/gap overlap');

{
  const coaching = generateReviewSearchCoaching({
    verification_queries: [
      'CRISPR off-target effects measurement in human cells',
      'another specific verification query about measurement',
    ],
    gap_queries: [
      'CRISPR off-target effects problems in human cells',
      'completely different gap query about alternative approach',
    ],
    query_rationale: 'x'.repeat(200),
  }, 50);

  const overlap = coaching.find(c => c.type === 'verification_gap_overlap');
  assert(overlap !== undefined, 'detects verification/gap query overlap');
}

section('generateReviewSearchCoaching() — tier-specific guide');

{
  const advanced = generateReviewSearchCoaching({
    verification_queries: ['specific detailed query one for testing', 'specific detailed query two for testing'],
    gap_queries: ['specific detailed gap one for testing', 'specific detailed gap two for testing'],
    query_rationale: 'x'.repeat(200),
  }, 200);

  const guide = advanced.find(c => c.type === 'review_search_guide');
  assert(guide !== undefined, 'includes review search guide');
  assert(guide.message.includes('inferential overreach'), 'advanced tier gets inferential overreach message');
}

{
  const foundational = generateReviewSearchCoaching({
    verification_queries: ['specific detailed query one for testing', 'specific detailed query two for testing'],
    gap_queries: ['specific detailed gap one for testing', 'specific detailed gap two for testing'],
    query_rationale: 'x'.repeat(200),
  }, 30);

  const guide = foundational.find(c => c.type === 'review_search_guide');
  assert(guide.message.includes('gap between what the author CLAIMS'), 'foundational tier gets detailed explanation');
}

// ═══════════════════════════════════════════════════════════════════════
// validateBountySearchStrategy()
// ═══════════════════════════════════════════════════════════════════════

section('validateBountySearchStrategy() — structural challenges skip validation');

// We need to test that structural challenge types pass without search strategy.
// The function requires bounty-helpers which loads school config, so we test
// the non-structural path instead.

{
  const r = validateBountySearchStrategy(null, 'contradicting_evidence');
  assert(r.valid === false, 'null strategy for evidence-based bounty is invalid');
}

section('validateBountySearchStrategy() — weak_source_quality special path');

{
  const r = validateBountySearchStrategy({
    verification_queries: [
      'journal impact factor and retraction history for source X',
      'predatory journal list check for publisher name here',
    ],
    query_rationale: 'I checked the journal impact factor and found it on a predatory publisher list, then verified the author has no other publications in reputable venues.',
  }, 'weak_source_quality');
  assert(r.valid === true, 'valid weak_source_quality strategy passes');
}

{
  const r = validateBountySearchStrategy({
    verification_queries: ['short'],
    query_rationale: 'too short',
  }, 'weak_source_quality');
  assert(r.valid === false, 'weak_source_quality with bad queries fails');
}

{
  const r = validateBountySearchStrategy({
    verification_queries: [],
    query_rationale: 'x'.repeat(80),
  }, 'weak_source_quality');
  assert(r.valid === false, 'weak_source_quality needs at least 2 verification queries');
}

section('validateBountySearchStrategy() — evidence-based bounty falls through to validateSearchStrategy');

{
  const r = validateBountySearchStrategy({
    supporting_queries: [
      'supporting query one is long enough here',
      'supporting query two is long enough here',
    ],
    opposing_queries: [
      'opposing query one is long enough here',
      'opposing query two is long enough here',
    ],
    query_rationale: 'x'.repeat(80),
  }, 'contradicting_evidence');
  assert(r.valid === true, 'valid evidence-based bounty strategy passes');
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
