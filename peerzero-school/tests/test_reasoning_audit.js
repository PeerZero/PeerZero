/**
 * Unit tests for lib/reasoning-audit.js
 *
 * Tests pure functions: computeTruncationScore, extractReasoningSignals,
 * and generateReasoningAudit (with mocked LLM call). Prompt templates
 * are verified for correct placeholder presence.
 *
 * Usage:
 *   node tests/test_reasoning_audit.js
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  computeTruncationScore,
  extractReasoningSignals,
  generateReasoningAudit,
  TRACE_PROMPT,
  CHAIN_VERIFICATION_PROMPT,
  COUNTERFACTUAL_PROBE_PROMPT,
} = require('../lib/reasoning-audit');

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
// Prompt templates — verify placeholders
// ═══════════════════════════════════════════════════════════════════════

section('Prompt templates');

assert(typeof TRACE_PROMPT === 'string', 'TRACE_PROMPT is a string');
assert(TRACE_PROMPT.includes('{opening}'), 'TRACE_PROMPT has {opening} placeholder');
assert(TRACE_PROMPT.includes('predicted_score'), 'TRACE_PROMPT requests predicted_score');
assert(TRACE_PROMPT.includes('prediction_confidence'), 'TRACE_PROMPT requests prediction_confidence');

assert(typeof CHAIN_VERIFICATION_PROMPT === 'string', 'CHAIN_VERIFICATION_PROMPT is a string');
assert(CHAIN_VERIFICATION_PROMPT.includes('{title}'), 'CHAIN_VERIFICATION_PROMPT has {title}');
assert(CHAIN_VERIFICATION_PROMPT.includes('{claim}'), 'CHAIN_VERIFICATION_PROMPT has {claim}');
assert(CHAIN_VERIFICATION_PROMPT.includes('{chain}'), 'CHAIN_VERIFICATION_PROMPT has {chain}');
assert(CHAIN_VERIFICATION_PROMPT.includes('load_bearing'), 'CHAIN_VERIFICATION_PROMPT mentions load_bearing');
assert(CHAIN_VERIFICATION_PROMPT.includes('most_fragile_step'), 'CHAIN_VERIFICATION_PROMPT requests most_fragile_step');

assert(typeof COUNTERFACTUAL_PROBE_PROMPT === 'string', 'COUNTERFACTUAL_PROBE_PROMPT is a string');
assert(COUNTERFACTUAL_PROBE_PROMPT.includes('{title}'), 'COUNTERFACTUAL_PROBE_PROMPT has {title}');
assert(COUNTERFACTUAL_PROBE_PROMPT.includes('{step_number}'), 'COUNTERFACTUAL_PROBE_PROMPT has {step_number}');
assert(COUNTERFACTUAL_PROBE_PROMPT.includes('{step_text}'), 'COUNTERFACTUAL_PROBE_PROMPT has {step_text}');
assert(COUNTERFACTUAL_PROBE_PROMPT.includes('conclusion_survives'), 'COUNTERFACTUAL_PROBE_PROMPT requests conclusion_survives');
assert(COUNTERFACTUAL_PROBE_PROMPT.includes('step_is_decorative'), 'COUNTERFACTUAL_PROBE_PROMPT requests step_is_decorative');

// ═══════════════════════════════════════════════════════════════════════
// computeTruncationScore()
// ═══════════════════════════════════════════════════════════════════════

section('computeTruncationScore()');

// Perfect prediction with high confidence = suspicious (score near 1)
const perfect = computeTruncationScore(7, 7, 1.0);
assertClose(perfect, 1.0, 0.01, 'exact prediction + full confidence = 1.0');

// Perfect prediction with low confidence
const perfectLowConf = computeTruncationScore(7, 7, 0.3);
assertClose(perfectLowConf, 0.3, 0.01, 'exact prediction + low confidence = 0.3');

// Off by 1 with full confidence
const offBy1 = computeTruncationScore(7, 8, 1.0);
assertClose(offBy1, 0.8, 0.01, 'off by 1 + full confidence = 0.8');

// Off by 5 with full confidence — completely unpredictable = 0
const offBy5 = computeTruncationScore(3, 8, 1.0);
assertClose(offBy5, 0.0, 0.01, 'off by 5 + full confidence = 0.0');

// Off by more than 5 — clamped to 0
const offByMore = computeTruncationScore(1, 10, 1.0);
assertClose(offByMore, 0.0, 0.01, 'off by >5 clamped to 0');

// Zero confidence — always 0 regardless of accuracy
const zeroConf = computeTruncationScore(7, 7, 0.0);
assertClose(zeroConf, 0.0, 0.01, 'zero confidence = 0 regardless of accuracy');

// Result is always between 0 and 1
for (let predicted = 1; predicted <= 10; predicted++) {
  for (let actual = 1; actual <= 10; actual++) {
    for (const conf of [0.0, 0.5, 1.0]) {
      const score = computeTruncationScore(predicted, actual, conf);
      assert(score >= 0 && score <= 1, `score in [0,1] for predicted=${predicted}, actual=${actual}, conf=${conf}`);
    }
  }
}

// Result has at most 3 decimal places
const precisionTest = computeTruncationScore(6, 8, 0.7);
const parts = precisionTest.toString().split('.');
assert(!parts[1] || parts[1].length <= 3, 'result has at most 3 decimal places');

// ═══════════════════════════════════════════════════════════════════════
// extractReasoningSignals()
// ═══════════════════════════════════════════════════════════════════════

section('extractReasoningSignals()');

// Null input
assert(extractReasoningSignals(null).length === 0, 'null audit returns empty signals');
assert(extractReasoningSignals(undefined).length === 0, 'undefined audit returns empty signals');

// Empty audit
const emptyAudit = {};
assert(extractReasoningSignals(emptyAudit).length === 0, 'empty audit returns empty signals');

// Chain coherence — hit (>= 0.6)
const highCoherence = {
  chain_verification: {
    chain_coherence: 0.85,
    step_evaluations: [
      { independently_testable: true },
      { independently_testable: true },
      { independently_testable: false },
    ],
    most_fragile_step: 3,
    fragile_reason: 'Lack of evidence',
  },
};
const highSignals = extractReasoningSignals(highCoherence);
assert(highSignals.length >= 1, 'high coherence produces at least 1 signal');
const coherenceSignal = highSignals.find(s => s.detail.includes('coherence'));
assert(coherenceSignal !== undefined, 'high coherence produces coherence signal');
assert(coherenceSignal.hit === true, 'high coherence is a hit');
assert(coherenceSignal.skill_key === 'adversarial_reasoning', 'coherence signal has correct skill_key');
assert(coherenceSignal.detail.includes('0.85'), 'coherence signal includes score');
assert(coherenceSignal.detail.includes('2'), 'coherence signal counts testable steps');

// Chain coherence — miss (< 0.6)
const lowCoherence = {
  chain_verification: {
    chain_coherence: 0.3,
    step_evaluations: [
      { independently_testable: false },
    ],
    most_fragile_step: 1,
    fragile_reason: 'No supporting evidence',
  },
};
const lowSignals = extractReasoningSignals(lowCoherence);
const lowCoherenceSignal = lowSignals.find(s => s.detail.includes('coherence'));
assert(lowCoherenceSignal !== undefined, 'low coherence produces signal');
assert(lowCoherenceSignal.hit === false, 'low coherence is a miss');
assert(lowCoherenceSignal.detail.includes('0.30'), 'low coherence signal includes score');
assert(lowCoherenceSignal.detail.includes('fragile'), 'low coherence mentions fragile step');

// Counterfactual probes — all load-bearing (hit)
const allLoadBearing = {
  counterfactual_probes: [
    { step_number: 1, step_is_decorative: false },
    { step_number: 2, step_is_decorative: false },
    { step_number: 3, step_is_decorative: false },
  ],
};
const lbSignals = extractReasoningSignals(allLoadBearing);
const lbSignal = lbSignals.find(s => s.detail.includes('load-bearing'));
assert(lbSignal !== undefined, 'all load-bearing probes produce signal');
assert(lbSignal.hit === true, 'all load-bearing is a hit');
assert(lbSignal.detail.includes('3'), 'load-bearing signal includes count');

// Counterfactual probes — some decorative (miss)
const someDecorative = {
  counterfactual_probes: [
    { step_number: 1, step_is_decorative: false },
    { step_number: 2, step_is_decorative: true },
    { step_number: 3, step_is_decorative: true },
  ],
};
const decSignals = extractReasoningSignals(someDecorative);
const decSignal = decSignals.find(s => s.detail.includes('decorative'));
assert(decSignal !== undefined, 'decorative probes produce signal');
assert(decSignal.hit === false, 'decorative probes are a miss');
assert(decSignal.detail.includes('2/3'), 'decorative signal includes ratio');
assert(decSignal.detail.includes('#2'), 'decorative signal lists step numbers');
assert(decSignal.detail.includes('#3'), 'decorative signal lists all decorative steps');
assert(decSignal.detail.includes('post-hoc rationalization'), 'decorative signal mentions rationalization');

// Combined audit — both chain verification and probes
const combined = {
  chain_verification: {
    chain_coherence: 0.75,
    step_evaluations: [{ independently_testable: true }],
    most_fragile_step: 1,
  },
  counterfactual_probes: [
    { step_number: 1, step_is_decorative: false },
  ],
};
const combinedSignals = extractReasoningSignals(combined);
assert(combinedSignals.length === 2, 'combined audit produces 2 signals');

// Empty probes array
const emptyProbes = { counterfactual_probes: [] };
assert(extractReasoningSignals(emptyProbes).length === 0, 'empty probes array produces no signals');

// Chain verification with null coherence
const nullCoherence = { chain_verification: { chain_coherence: null } };
assert(extractReasoningSignals(nullCoherence).length === 0, 'null coherence produces no signals');

// ═══════════════════════════════════════════════════════════════════════
// generateReasoningAudit() — with mock LLM
// ═══════════════════════════════════════════════════════════════════════

section('generateReasoningAudit()');

// Null inputs
generateReasoningAudit(null, () => {}).then(result => {
  assert(result === null, 'null paper returns null');

  return generateReasoningAudit({ title: 'Test' }, null);
}).then(result => {
  assert(result === null, 'null callHaikuFn returns null');

  // Paper without mechanism chain — should return audit with nulls
  const paperNoChain = { title: 'Test', abstract: 'Abstract' };
  return generateReasoningAudit(paperNoChain, async () => ({}));
}).then(audit => {
  assert(audit !== null, 'paper without chain returns non-null audit');
  assert(audit.chain_verification === null, 'no chain means null chain_verification');
  assert(audit.counterfactual_probes.length === 0, 'no chain means empty probes');
  assert(audit.generated_at !== undefined, 'audit has generated_at timestamp');

  // Paper with mechanism chain — mock LLM returns chain verification
  const paperWithChain = {
    title: 'Test Paper',
    abstract: 'An abstract',
    falsifiable_claim: 'A claim',
    mechanism_chain: [
      'Step 1: Something happens',
      'Step 2: Then another thing',
      'Step 3: Final outcome',
    ],
  };

  let callCount = 0;
  const mockHaiku = async (prompt, context) => {
    callCount++;
    if (context === 'mechanism_chain_verification') {
      return {
        step_evaluations: [
          { step_number: 1, step_text: 'Step 1', load_bearing: true, independently_testable: true },
          { step_number: 2, step_text: 'Step 2', load_bearing: false, independently_testable: false },
          { step_number: 3, step_text: 'Step 3', load_bearing: true, independently_testable: true },
        ],
        most_fragile_step: 2,
        fragile_reason: 'No evidence',
        chain_coherence: 0.7,
      };
    }
    if (context === 'counterfactual_probe') {
      return {
        conclusion_survives: false,
        step_is_decorative: false,
        evidence_depends_on_step: true,
        reasoning: 'Step is essential',
      };
    }
    return null;
  };

  return generateReasoningAudit(paperWithChain, mockHaiku).then(chainAudit => {
    assert(chainAudit !== null, 'chain audit is non-null');
    assert(chainAudit.chain_verification !== null, 'chain_verification is populated');
    assert(chainAudit.chain_verification.chain_coherence === 0.7, 'chain_coherence passed through');
    assert(chainAudit.chain_verification.step_evaluations.length === 3, 'all steps evaluated');

    // Should probe only load-bearing steps (steps 1 and 3)
    assert(chainAudit.counterfactual_probes.length === 2, '2 load-bearing steps probed');
    assert(chainAudit.counterfactual_probes[0].step_number === 1, 'first probe is step 1');
    assert(chainAudit.counterfactual_probes[1].step_number === 3, 'second probe is step 3');

    // Verify each probe has the mocked fields
    assert(chainAudit.counterfactual_probes[0].conclusion_survives === false, 'probe result included');
    assert(chainAudit.counterfactual_probes[0].step_is_decorative === false, 'decorative field included');

    // callCount: 1 chain verification + 2 counterfactual probes = 3
    assert(callCount === 3, `LLM called 3 times (got ${callCount})`);

    return testFallbackToFirstThree(paperWithChain);
  });
}).then(() => {
  printSummary();
}).catch(err => {
  console.error('Test error:', err);
  printSummary();
});

function testFallbackToFirstThree(paper) {
  // When chain verification returns null, should probe first 3 steps
  const mockNull = async (prompt, context) => {
    if (context === 'mechanism_chain_verification') return null;
    if (context === 'counterfactual_probe') {
      return { conclusion_survives: true, step_is_decorative: true, evidence_depends_on_step: false, reasoning: 'Not needed' };
    }
    return null;
  };

  return generateReasoningAudit(paper, mockNull).then(audit => {
    assert(audit.chain_verification === null, 'null chain verification when LLM returns null');
    assert(audit.counterfactual_probes.length === 3, 'probes all 3 steps as fallback');
  });
}

function printSummary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
}
