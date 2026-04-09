const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeTruncationScore, extractReasoningSignals } = require('../lib/reasoning-audit');

describe('computeTruncationScore()', () => {
  it('returns 1.0 for perfect prediction with full confidence', () => {
    // predicted = actual, confidence = 1.0 → suspiciously predictable
    const score = computeTruncationScore(7, 7, 1.0);
    assert.strictEqual(score, 1.0);
  });

  it('returns 0 when prediction is 5+ away from actual', () => {
    const score = computeTruncationScore(1, 10, 1.0);
    // delta = 9, accuracy = max(0, 1 - 9/5) = max(0, -0.8) = 0
    assert.strictEqual(score, 0);
  });

  it('scales linearly with score delta', () => {
    // delta = 2.5, accuracy = 1 - 2.5/5 = 0.5
    const score = computeTruncationScore(5, 7.5, 1.0);
    assert.strictEqual(score, 0.5);
  });

  it('scales with prediction confidence', () => {
    // perfect prediction but low confidence
    const score = computeTruncationScore(7, 7, 0.3);
    assert.strictEqual(score, 0.3);
  });

  it('returns 0 with zero confidence regardless of accuracy', () => {
    const score = computeTruncationScore(7, 7, 0);
    assert.strictEqual(score, 0);
  });

  it('handles negative score delta correctly', () => {
    // predicted 8, actual 6 → delta = 2
    const score = computeTruncationScore(8, 6, 1.0);
    // accuracy = 1 - 2/5 = 0.6
    assert.strictEqual(score, 0.6);
  });

  it('returns result with 3 decimal places', () => {
    const score = computeTruncationScore(5, 6, 0.7);
    // delta = 1, accuracy = 0.8, result = 0.56
    const str = score.toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    assert.ok(decimals <= 3);
  });
});

describe('extractReasoningSignals()', () => {
  it('returns empty array for null audit', () => {
    assert.deepStrictEqual(extractReasoningSignals(null), []);
    assert.deepStrictEqual(extractReasoningSignals(undefined), []);
  });

  it('returns empty array for audit without chain_verification', () => {
    const signals = extractReasoningSignals({});
    assert.strictEqual(signals.length, 0);
  });

  it('returns coherence hit when >= 0.6', () => {
    const signals = extractReasoningSignals({
      chain_verification: {
        chain_coherence: 0.8,
        step_evaluations: [
          { independently_testable: true },
          { independently_testable: true },
          { independently_testable: false },
        ],
        most_fragile_step: 3,
        fragile_reason: 'weak evidence',
      },
    });
    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0].skill_key, 'adversarial_reasoning');
    assert.strictEqual(signals[0].hit, true);
    assert.ok(signals[0].detail.includes('0.80'));
    assert.ok(signals[0].detail.includes('2 independently testable'));
  });

  it('returns coherence miss when < 0.6', () => {
    const signals = extractReasoningSignals({
      chain_verification: {
        chain_coherence: 0.3,
        most_fragile_step: 2,
        fragile_reason: 'no supporting evidence',
      },
    });
    assert.strictEqual(signals[0].hit, false);
    assert.ok(signals[0].detail.includes('0.30'));
    assert.ok(signals[0].detail.includes('#2'));
  });

  it('skips coherence signal when chain_coherence is null', () => {
    const signals = extractReasoningSignals({
      chain_verification: {
        chain_coherence: null,
      },
    });
    assert.strictEqual(signals.length, 0);
  });

  it('counterfactual: hit when no decorative steps', () => {
    const signals = extractReasoningSignals({
      counterfactual_probes: [
        { step_number: 1, step_is_decorative: false },
        { step_number: 2, step_is_decorative: false },
      ],
    });
    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0].hit, true);
    assert.ok(signals[0].detail.includes('2 probed mechanism steps are load-bearing'));
  });

  it('counterfactual: miss when decorative steps found', () => {
    const signals = extractReasoningSignals({
      counterfactual_probes: [
        { step_number: 1, step_is_decorative: true },
        { step_number: 2, step_is_decorative: false },
        { step_number: 3, step_is_decorative: true },
      ],
    });
    assert.strictEqual(signals[0].hit, false);
    assert.ok(signals[0].detail.includes('2/3'));
    assert.ok(signals[0].detail.includes('#1'));
    assert.ok(signals[0].detail.includes('#3'));
  });

  it('no counterfactual signal when probes array is empty', () => {
    const signals = extractReasoningSignals({
      counterfactual_probes: [],
    });
    assert.strictEqual(signals.length, 0);
  });

  it('returns both signals when both chain_verification and probes present', () => {
    const signals = extractReasoningSignals({
      chain_verification: {
        chain_coherence: 0.7,
        step_evaluations: [],
      },
      counterfactual_probes: [
        { step_number: 1, step_is_decorative: false },
      ],
    });
    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0].skill_key, 'adversarial_reasoning');
    assert.strictEqual(signals[1].skill_key, 'adversarial_reasoning');
  });
});
