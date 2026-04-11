/**
 * Unit tests for lib/bounty-helpers.js
 *
 * Tests: isValidDoiFormat, validateExternalSources, validateWeakSourceQualityChallenge,
 *        tokenize, jaccardSimilarity, MIN_SCORE_DROP, STRUCTURAL_CHALLENGE_TYPES
 *
 * Skips: callHaikuDriftJudge (requires API key)
 *
 * Usage:
 *   node tests/test_bounty_helpers.js
 */

// Stub env vars so getSupabase() doesn't throw during require
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  MIN_SCORE_DROP,
  STRUCTURAL_CHALLENGE_TYPES,
  isValidDoiFormat,
  validateExternalSources,
  validateWeakSourceQualityChallenge,
  SCIENTIFIC_STOPWORDS,
  tokenize,
  jaccardSimilarity,
} = require('../lib/bounty-helpers');

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
// Constants
// ═══════════════════════════════════════════════════════════════════════

section('MIN_SCORE_DROP constant');

assert(MIN_SCORE_DROP === 0.2, 'MIN_SCORE_DROP is 0.2');
assert(typeof MIN_SCORE_DROP === 'number', 'MIN_SCORE_DROP is a number');

section('STRUCTURAL_CHALLENGE_TYPES constant');

assert(typeof STRUCTURAL_CHALLENGE_TYPES.has === 'function', 'STRUCTURAL_CHALLENGE_TYPES has Set-like .has()');
assert(STRUCTURAL_CHALLENGE_TYPES.size >= 3, 'STRUCTURAL_CHALLENGE_TYPES has at least 3 entries');
assert(STRUCTURAL_CHALLENGE_TYPES.has('no_mechanism_chain'), 'contains no_mechanism_chain');
assert(STRUCTURAL_CHALLENGE_TYPES.has('no_falsifiable_claim'), 'contains no_falsifiable_claim');
assert(STRUCTURAL_CHALLENGE_TYPES.has('no_cross_study_connection'), 'contains no_cross_study_connection');
assert(!STRUCTURAL_CHALLENGE_TYPES.has('some_other_type'), 'does not contain arbitrary strings');

// ═══════════════════════════════════════════════════════════════════════
// isValidDoiFormat()
// ═══════════════════════════════════════════════════════════════════════

section('isValidDoiFormat() — valid DOIs');

assert(isValidDoiFormat('10.1234/test-doi') === true, 'standard DOI is valid');
assert(isValidDoiFormat('10.1000/xyz123') === true, 'simple DOI is valid');
assert(isValidDoiFormat('10.1038/nature12373') === true, 'Nature DOI is valid');
assert(isValidDoiFormat('10.1371/journal.pone.0000000') === true, 'PLOS ONE DOI is valid');
assert(isValidDoiFormat('  10.1234/test  ') === true, 'DOI with surrounding whitespace is valid (trimmed)');

section('isValidDoiFormat() — invalid DOIs');

assert(isValidDoiFormat('11.1234/test') === false, 'does not start with "10." → invalid');
assert(isValidDoiFormat('10.1234') === false, 'missing "/" separator → invalid');
assert(isValidDoiFormat('10./ab') === false, 'too short (< 7 chars) → invalid');
assert(isValidDoiFormat(null) === false, 'null → invalid');
assert(isValidDoiFormat(undefined) === false, 'undefined → invalid');
assert(isValidDoiFormat('') === false, 'empty string → invalid');
assert(isValidDoiFormat(12345) === false, 'number → invalid (non-string)');
assert(isValidDoiFormat({}) === false, 'object → invalid (non-string)');
assert(isValidDoiFormat('doi:10.1234/test') === false, 'prefixed with "doi:" does not start with "10."');

// ═══════════════════════════════════════════════════════════════════════
// validateExternalSources()
// ═══════════════════════════════════════════════════════════════════════

section('validateExternalSources() — invalid inputs');

assert(validateExternalSources(null).length > 0, 'null → failures');
assert(validateExternalSources(undefined).length > 0, 'undefined → failures');
assert(validateExternalSources([]).length > 0, 'empty array → failures');
assert(validateExternalSources('not-array').length > 0, 'non-array string → failures');
assert(validateExternalSources(42).length > 0, 'number → failures');

section('validateExternalSources() — valid source');

const goodSource = {
  doi: '10.1234/test-doi',
  specific_finding: 'x'.repeat(50),
  target_claim: 'x'.repeat(30),
  logical_bridge: 'x'.repeat(80),
};
assert(validateExternalSources([goodSource]).length === 0, 'single valid source passes');

const twoGoodSources = [{ ...goodSource }, { ...goodSource, doi: '10.5678/other-doi' }];
assert(validateExternalSources(twoGoodSources).length === 0, 'two valid sources pass');

const fiveGoodSources = Array.from({ length: 5 }, () => ({ ...goodSource }));
assert(validateExternalSources(fiveGoodSources).length === 0, 'five valid sources pass (max allowed)');

section('validateExternalSources() — too many sources');

const sixSources = Array.from({ length: 6 }, () => ({ ...goodSource }));
const sixResult = validateExternalSources(sixSources);
assert(sixResult.some(f => f.includes('Maximum 5')), '6 sources triggers max limit');

section('validateExternalSources() — missing fields');

const missingDoi = { specific_finding: 'x'.repeat(50), target_claim: 'x'.repeat(30), logical_bridge: 'x'.repeat(80) };
assert(validateExternalSources([missingDoi]).some(f => f.includes('doi')), 'missing doi → failure');

const missingFinding = { doi: '10.1234/test', target_claim: 'x'.repeat(30), logical_bridge: 'x'.repeat(80) };
assert(validateExternalSources([missingFinding]).some(f => f.includes('specific_finding')), 'missing specific_finding → failure');

const missingClaim = { doi: '10.1234/test', specific_finding: 'x'.repeat(50), logical_bridge: 'x'.repeat(80) };
assert(validateExternalSources([missingClaim]).some(f => f.includes('target_claim')), 'missing target_claim → failure');

const missingBridge = { doi: '10.1234/test', specific_finding: 'x'.repeat(50), target_claim: 'x'.repeat(30) };
assert(validateExternalSources([missingBridge]).some(f => f.includes('logical_bridge')), 'missing logical_bridge → failure');

section('validateExternalSources() — short fields');

const shortFields = {
  doi: '10.1234/test',
  specific_finding: 'short',
  target_claim: 'short',
  logical_bridge: 'short',
};
const shortResult = validateExternalSources([shortFields]);
assert(shortResult.some(f => f.includes('specific_finding')), 'short specific_finding → failure');
assert(shortResult.some(f => f.includes('target_claim')), 'short target_claim → failure');
assert(shortResult.some(f => f.includes('logical_bridge')), 'short logical_bridge → failure');

section('validateExternalSources() — invalid DOI format');

const invalidDoiSource = {
  doi: 'not-a-doi-format',
  specific_finding: 'x'.repeat(50),
  target_claim: 'x'.repeat(30),
  logical_bridge: 'x'.repeat(80),
};
const invalidDoiResult = validateExternalSources([invalidDoiSource]);
assert(invalidDoiResult.some(f => f.includes('valid DOI')), 'invalid DOI format → failure mentioning valid DOI');

section('validateExternalSources() — all fields bad');

const badSource = { doi: '', specific_finding: 'short', target_claim: '', logical_bridge: '' };
const badResult = validateExternalSources([badSource]);
assert(badResult.length === 4, `all-bad source produces 4 failures (got ${badResult.length})`);

// ═══════════════════════════════════════════════════════════════════════
// validateWeakSourceQualityChallenge()
// ═══════════════════════════════════════════════════════════════════════

section('validateWeakSourceQualityChallenge() — valid challenge');

const goodChallenge = {
  challenged_doi: '10.1234/challenged',
  quality_challenge_reason: 'x'.repeat(80),
};
assert(validateWeakSourceQualityChallenge(goodChallenge).length === 0, 'valid challenge passes');

section('validateWeakSourceQualityChallenge() — missing fields');

assert(validateWeakSourceQualityChallenge({}).length === 2, 'empty body → 2 failures');

const noDoi = { quality_challenge_reason: 'x'.repeat(80) };
const noDoiResult = validateWeakSourceQualityChallenge(noDoi);
assert(noDoiResult.length === 1, 'missing challenged_doi → 1 failure');
assert(noDoiResult[0].includes('challenged_doi'), 'failure mentions challenged_doi');

const noReason = { challenged_doi: '10.1234/challenged' };
const noReasonResult = validateWeakSourceQualityChallenge(noReason);
assert(noReasonResult.length === 1, 'missing quality_challenge_reason → 1 failure');
assert(noReasonResult[0].includes('quality_challenge_reason'), 'failure mentions quality_challenge_reason');

section('validateWeakSourceQualityChallenge() — short fields');

const shortReason = { challenged_doi: '10.1234/x', quality_challenge_reason: 'too short' };
assert(validateWeakSourceQualityChallenge(shortReason).length === 1, 'short reason → 1 failure');

const shortDoi = { challenged_doi: 'ab', quality_challenge_reason: 'x'.repeat(80) };
assert(validateWeakSourceQualityChallenge(shortDoi).length === 1, 'short doi (< 5 chars) → 1 failure');

section('validateWeakSourceQualityChallenge() — invalid DOI format');

const invalidDoi = { challenged_doi: 'not-a-doi-12345', quality_challenge_reason: 'x'.repeat(80) };
const invalidDoiChallengeResult = validateWeakSourceQualityChallenge(invalidDoi);
assert(invalidDoiChallengeResult.length === 1, 'invalid DOI format → 1 failure');
assert(invalidDoiChallengeResult[0].includes('valid DOI'), 'failure mentions valid DOI');

// ═══════════════════════════════════════════════════════════════════════
// tokenize()
// ═══════════════════════════════════════════════════════════════════════

section('tokenize() — normal text');

const tokens1 = tokenize('The CRISPR gene editing technique modifies DNA sequences');
assert(tokens1 instanceof Set, 'tokenize returns a Set');
assert(tokens1.size > 0, 'tokenize produces tokens from normal text');
assert(tokens1.has('crispr'), 'scientific terms preserved (lowercased)');
assert(tokens1.has('editing'), 'content words preserved');
assert(tokens1.has('technique'), 'content words preserved (technique)');
assert(tokens1.has('modifies'), 'content words preserved (modifies)');

section('tokenize() — short words filtered');

assert(!tokens1.has('the'), '"the" filtered (length <= 3)');
assert(!tokens1.has('dna'), '"dna" filtered (length <= 3)');
// "gene" has length 4, so it passes the > 3 filter
assert(tokens1.has('gene'), '"gene" preserved (length = 4, passes > 3)');

const shortWordText = tokenize('I am a big fan of the art');
assert(!shortWordText.has('am'), '"am" filtered (length 2)');
assert(!shortWordText.has('big'), '"big" filtered (length 3)');
assert(!shortWordText.has('the'), '"the" filtered (length 3)');
assert(!shortWordText.has('art'), '"art" filtered (length 3)');
assert(!shortWordText.has('fan'), '"fan" filtered (length 3)');

section('tokenize() — stopword removal');

assert(!tokenize('study research evidence findings').has('study'), '"study" is a scientific stopword');
assert(!tokenize('study research evidence findings').has('research'), '"research" is a scientific stopword');
assert(!tokenize('study research evidence findings').has('evidence'), '"evidence" is a scientific stopword');
assert(!tokenize('statistical significance analysis methodology').has('statistical'), '"statistical" is a scientific stopword');
assert(!tokenize('statistical significance analysis methodology').has('analysis'), '"analysis" is a scientific stopword');
assert(!tokenize('statistical significance analysis methodology').has('methodology'), '"methodology" is a scientific stopword');

section('tokenize() — empty and edge cases');

const emptyTokens = tokenize('');
assert(emptyTokens.size === 0, 'empty string → empty set');

const onlyShort = tokenize('I am a to be or if');
assert(onlyShort.size === 0, 'text with only short words → empty set');

const onlyStopwords = tokenize('study research evidence analysis method');
assert(onlyStopwords.size === 0, 'text with only stopwords → empty set');

const punctuation = tokenize('Hello, world! This is a test.');
assert(punctuation.has('hello'), 'punctuation is stripped, words preserved');
assert(punctuation.has('world'), 'punctuation stripped from "world!"');
assert(punctuation.has('test'), 'punctuation stripped from "test."');

// ═══════════════════════════════════════════════════════════════════════
// jaccardSimilarity()
// ═══════════════════════════════════════════════════════════════════════

section('jaccardSimilarity() — identical texts');

assertClose(jaccardSimilarity('quantum entanglement photon laser', 'quantum entanglement photon laser'), 1.0, 0.01, 'identical texts → 1.0');

section('jaccardSimilarity() — completely different texts');

const diffSim = jaccardSimilarity('quantum entanglement photon laser', 'climate ocean temperature salinity');
assert(diffSim === 0, `completely unrelated texts → 0 (got ${diffSim})`);

section('jaccardSimilarity() — partial overlap');

const partialSim = jaccardSimilarity('quantum entanglement photon experiment', 'quantum mechanics photon wavelength');
assert(partialSim > 0 && partialSim < 1, `partial overlap → between 0 and 1 (got ${partialSim.toFixed(2)})`);
// "quantum" and "photon" overlap, "entanglement"+"experiment" vs "mechanics"+"wavelength" differ
// Set A: {quantum, entanglement, photon, experiment} (4 tokens)
// Set B: {quantum, mechanics, photon, wavelength} (4 tokens)
// Intersection: {quantum, photon} = 2
// Union: 6
// Jaccard = 2/6 = 0.333...
assertClose(partialSim, 2/6, 0.01, 'partial overlap Jaccard computed correctly');

section('jaccardSimilarity() — empty texts');

assertClose(jaccardSimilarity('', 'something here today'), 0, 0.01, 'empty vs text → 0');
assertClose(jaccardSimilarity('quantum photon laser', ''), 0, 0.01, 'text vs empty → 0');
assertClose(jaccardSimilarity('', ''), 0, 0.01, 'empty vs empty → 0');

section('jaccardSimilarity() — texts with only stopwords');

assertClose(jaccardSimilarity('study research evidence', 'analysis method findings'), 0, 0.01, 'all-stopword texts → 0 (no meaningful tokens)');

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n══ Results: ${passed} passed, ${failed} failed ══`);
process.exit(failed > 0 ? 1 : 0);
