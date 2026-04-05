/**
 * Unit tests for lib/paper-helpers.js
 *
 * Tests paper cap logic, mechanism chain validation/coaching,
 * and weak synthesis flagging. No database required — pure function tests.
 * (buildSubmissionCoaching and getRevisionEligibility are async + DB-dependent,
 * so they are not tested here.)
 *
 * Usage:
 *   node tests/test_paper_helpers.js
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  getMaxPapers,
  WEAK_SYNTHESIS_SIGNALS,
  validateMechanismChain,
  coachMechanismChain,
  flagWeakSynthesis,
} = require('../lib/paper-helpers');

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
// getMaxPapers()
// ═══════════════════════════════════════════════════════════════════════

section('getMaxPapers()');

assert(getMaxPapers(0) === 2, 'cred=0 allows 2 papers');
assert(getMaxPapers(50) === 2, 'cred=50 allows 2 papers');
assert(getMaxPapers(74) === 2, 'cred=74 allows 2 papers');
assert(getMaxPapers(75) === 4, 'cred=75 allows 4 papers');
assert(getMaxPapers(99) === 4, 'cred=99 allows 4 papers');
assert(getMaxPapers(100) === 8, 'cred=100 allows 8 papers');
assert(getMaxPapers(149) === 8, 'cred=149 allows 8 papers');
assert(getMaxPapers(150) === 16, 'cred=150 allows 16 papers');
assert(getMaxPapers(174) === 16, 'cred=174 allows 16 papers');
assert(getMaxPapers(175) === 32, 'cred=175 allows 32 papers');
assert(getMaxPapers(999) === 32, 'cred=999 allows 32 papers');

// Monotonic increase
let prev = getMaxPapers(0);
for (const c of [25, 50, 75, 100, 150, 175, 200]) {
  const cur = getMaxPapers(c);
  assert(cur >= prev, `getMaxPapers(${c}) >= getMaxPapers at lower credibility`);
  prev = cur;
}

// ═══════════════════════════════════════════════════════════════════════
// WEAK_SYNTHESIS_SIGNALS
// ═══════════════════════════════════════════════════════════════════════

section('WEAK_SYNTHESIS_SIGNALS');

assert(Array.isArray(WEAK_SYNTHESIS_SIGNALS), 'WEAK_SYNTHESIS_SIGNALS is an array');
assert(WEAK_SYNTHESIS_SIGNALS.length > 0, 'WEAK_SYNTHESIS_SIGNALS is non-empty');
assert(WEAK_SYNTHESIS_SIGNALS.includes('similarly'), 'includes "similarly"');
assert(WEAK_SYNTHESIS_SIGNALS.includes('also found'), 'includes "also found"');

// ═══════════════════════════════════════════════════════════════════════
// validateMechanismChain()
// ═══════════════════════════════════════════════════════════════════════

section('validateMechanismChain()');

// Null/undefined — optional field, valid
const nullChain = validateMechanismChain(null);
assert(nullChain.valid === true, 'null chain is valid');
assert(nullChain.coaching === null, 'null chain has no coaching');

const undefinedChain = validateMechanismChain(undefined);
assert(undefinedChain.valid === true, 'undefined chain is valid');

// Not an array
const notArray = validateMechanismChain('a string');
assert(notArray.valid === false, 'string chain is invalid');
assert(notArray.coaching.includes('JSON array'), 'string chain coaching mentions array');

const objectChain = validateMechanismChain({ step: 1 });
assert(objectChain.valid === false, 'object chain is invalid');

// Too few steps
const oneStep = validateMechanismChain(['Only one step here with enough characters']);
assert(oneStep.valid === false, 'single-step chain is invalid');
assert(oneStep.coaching.includes('at least 2'), 'single-step coaching mentions minimum');

// Too many steps
const elevenSteps = validateMechanismChain(Array(11).fill('A sufficiently long step description for validation'));
assert(elevenSteps.valid === false, '11-step chain is invalid');
assert(elevenSteps.coaching.includes('10 steps'), '11-step coaching mentions limit');

// Non-string step
const nonStringStep = validateMechanismChain([123, 'A valid step with enough characters']);
assert(nonStringStep.valid === false, 'non-string step is invalid');

// Short step
const shortStep = validateMechanismChain(['short', 'A sufficiently long second step for validation']);
assert(shortStep.valid === false, 'short step is invalid');
assert(shortStep.coaching.includes('too short'), 'short step coaching mentions length');

// Long step
const longStep = validateMechanismChain(['x'.repeat(501), 'A sufficiently long second step for validation']);
assert(longStep.valid === false, 'long step is invalid');
assert(longStep.coaching.includes('too long'), 'long step coaching mentions length');

// Valid chain
const validChain = validateMechanismChain([
  'Step 1: This is a sufficiently long description of the first causal link in the chain',
  'Step 2: This is a sufficiently long description of the second causal link in the chain',
]);
assert(validChain.valid === true, 'valid 2-step chain passes');
assert(validChain.coaching === null, 'valid chain has no coaching');

// Exactly 10 steps — should be valid
const tenSteps = validateMechanismChain(Array(10).fill('This step is exactly long enough to pass the twenty character minimum threshold'));
assert(tenSteps.valid === true, '10-step chain is valid');

// ═══════════════════════════════════════════════════════════════════════
// coachMechanismChain()
// ═══════════════════════════════════════════════════════════════════════

section('coachMechanismChain()');

// Null/empty chain — no coaching
assert(coachMechanismChain(null, [], []).length === 0, 'null chain produces no coaching');
assert(coachMechanismChain([], [], []).length === 0, 'empty chain produces no coaching');
assert(coachMechanismChain(undefined, [], []).length === 0, 'undefined chain produces no coaching');

// Single-source chain — all steps cite same DOI
const singleSourceChain = [
  'Step 1: Some mechanism based on 10.1234/test-paper-alpha findings',
  'Step 2: Another mechanism also from 10.1234/test-paper-alpha findings',
  'Step 3: Final conclusion from 10.1234/test-paper-alpha conclusions',
];
const singleSourceResult = coachMechanismChain(singleSourceChain, [], []);
const hasSingleSourceCoaching = singleSourceResult.some(c => c.type === 'single_source_chain');
assert(hasSingleSourceCoaching, 'single-source chain gets coaching');

// Unsupported chain — steps lack evidence anchors
const unsupportedChain = [
  'Step 1: Something happens in the cell membrane',
  'Step 2: Then another thing occurs downstream',
  'Step 3: Finally the outcome manifests in the organism',
];
const unsupportedResult = coachMechanismChain(unsupportedChain, [], []);
const hasUnsupportedCoaching = unsupportedResult.some(c => c.type === 'unsupported_chain');
assert(hasUnsupportedCoaching, 'unsupported chain gets coaching');

// Shallow chain — only 2 steps but 4+ citations
const shallowChain = [
  'Step 1: The initial mechanism studied by researchers',
  'Step 2: The final outcome observed in studies',
];
const citations4 = [{ doi: '10.1/a' }, { doi: '10.1/b' }, { doi: '10.1/c' }, { doi: '10.1/d' }];
const shallowResult = coachMechanismChain(shallowChain, citations4, []);
const hasShallowCoaching = shallowResult.some(c => c.type === 'shallow_chain');
assert(hasShallowCoaching, 'shallow chain (2 steps, 4+ citations) gets coaching');

// Non-shallow — 2 steps but fewer than 4 citations
const nonShallowResult = coachMechanismChain(shallowChain, [{ doi: '10.1/a' }], []);
const hasNoShallowCoaching = !nonShallowResult.some(c => c.type === 'shallow_chain');
assert(hasNoShallowCoaching, '2-step chain with few citations does not get shallow coaching');

// Cross-field anchor gap
const crossFieldChain = [
  'Step 1: Based on findings from 10.1234/neuro-study about neural pathways',
  'Step 2: Leading to immune response through unknown mechanism',
  'Step 3: Resulting in behavioral outcome per unrelated observations',
];
const crossFieldCitations = [
  { doi: '10.1234/neuro-study' },
  { doi: '10.5678/immune-study' },
  { doi: '10.9012/behavior-study' },
];
const crossFieldResult = coachMechanismChain(crossFieldChain, crossFieldCitations, ['neuro', 'immune']);
const hasCrossFieldCoaching = crossFieldResult.some(c => c.type === 'no_cross_field_anchor');
assert(hasCrossFieldCoaching, 'cross-field chain with single-DOI mechanism gets coaching');

// ═══════════════════════════════════════════════════════════════════════
// flagWeakSynthesis()
// ═══════════════════════════════════════════════════════════════════════

section('flagWeakSynthesis()');

// Null input
const nullSynth = flagWeakSynthesis(null);
assert(nullSynth.flagged === true, 'null synthesis is flagged');
assert(nullSynth.reason.includes('No cross_study_connection'), 'null synthesis reason');

// Empty string
const emptySynth = flagWeakSynthesis('');
assert(emptySynth.flagged === true, 'empty synthesis is flagged');

// Too short
const shortSynth = flagWeakSynthesis('This is a very short connection.');
assert(shortSynth.flagged === true, 'short synthesis is flagged');
assert(shortSynth.reason.includes('very short'), 'short synthesis reason mentions length');

// Weak signals — 2+ matches
const weakSynth = flagWeakSynthesis('Study A similarly found that both studies examine the relationship between X and Y. ' + 'x'.repeat(200));
assert(weakSynth.flagged === true, 'synthesis with weak signals is flagged');
assert(weakSynth.reason.includes('superficial'), 'weak synthesis reason mentions superficial');

// Single weak signal — "similarly" alone is only 1 match, not enough to flag (if long enough)
// Note: "Study A" matches the weak signal "study a" so we avoid that phrase here
const oneSignal = flagWeakSynthesis('The first experiment similarly produced an interesting result but then provides a detailed and specific explanation of the non-obvious implication that emerges only when combining the two different methodologies across these different research domains and experimental contexts that nobody expected.');
assert(oneSignal.flagged === false, 'single weak signal with good length is not flagged');

// Strong synthesis — long, avoids weak signal phrases ("study a", "study b", etc.)
const strongSynth = flagWeakSynthesis(
  'The CRISPR-Cas9 editing experiment on the BRCA1 gene in mouse models demonstrated ' +
  'increased tumor suppression in breast tissue. The microbiome profiling experiment showed that specific gut ' +
  'compositions modulate immune checkpoint proteins. Combining these results implies that ' +
  'CRISPR-mediated BRCA1 restoration with targeted probiotic intervention could ' +
  'create a synergistic anti-tumor effect — a combination therapy neither experiment anticipated.'
);
assert(strongSynth.flagged === false, 'strong synthesis is not flagged');
assert(strongSynth.reason === null, 'strong synthesis has no reason');

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
