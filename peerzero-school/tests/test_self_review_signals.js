const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selfReviewSignals } = require('../lib/self-review');

describe('selfReviewSignals()', () => {
  it('returns calibration + adversarial signals for basic input', () => {
    const signals = selfReviewSignals({
      score_divergence: 1.0,
      score: 7,
      community_score_at_time: 6,
      weaknesses_found: ['flaw1', 'flaw2', 'flaw3'],
    });
    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0].skill_key, 'calibrated_uncertainty');
    assert.strictEqual(signals[1].skill_key, 'adversarial_reasoning');
  });

  it('calibration hit when divergence <= 1.5', () => {
    const signals = selfReviewSignals({
      score_divergence: 1.5,
      score: 7,
      community_score_at_time: 5.5,
      weaknesses_found: [],
    });
    assert.strictEqual(signals[0].hit, true);
    assert.ok(signals[0].detail.includes('matches external evaluation'));
  });

  it('calibration miss when divergence > 1.5', () => {
    const signals = selfReviewSignals({
      score_divergence: 2.0,
      score: 8,
      community_score_at_time: 6,
      weaknesses_found: [],
    });
    assert.strictEqual(signals[0].hit, false);
    assert.ok(signals[0].detail.includes('overestimate'));
  });

  it('identifies underestimation when score < community', () => {
    const signals = selfReviewSignals({
      score_divergence: 3.0,
      score: 4,
      community_score_at_time: 7,
      weaknesses_found: [],
    });
    assert.strictEqual(signals[0].hit, false);
    assert.ok(signals[0].detail.includes('underestimate'));
  });

  it('adversarial hit when >= 2 weaknesses found', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: ['a', 'b'],
    });
    assert.strictEqual(signals[1].hit, true);
    assert.ok(signals[1].detail.includes('2 weaknesses'));
  });

  it('adversarial miss when < 2 weaknesses found', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: ['only one'],
    });
    assert.strictEqual(signals[1].hit, false);
    assert.ok(signals[1].detail.includes('1 new weakness'));
  });

  it('adversarial miss with zero weaknesses', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: [],
    });
    assert.strictEqual(signals[1].hit, false);
    assert.ok(signals[1].detail.includes('0 new weaknesses'));
  });

  it('handles null/undefined weaknesses_found', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
    });
    assert.strictEqual(signals[1].hit, false);
  });

  it('handles null/undefined score_divergence', () => {
    const signals = selfReviewSignals({
      weaknesses_found: [],
    });
    // divergence defaults to 0 → hit (0 <= 1.5)
    assert.strictEqual(signals[0].hit, true);
  });

  it('adds belief_updating signal when confidence data present', () => {
    const signals = selfReviewSignals({
      score_divergence: 1.0,
      weaknesses_found: [],
      original_confidence: 8,
      hindsight_confidence: 5,
    });
    assert.strictEqual(signals.length, 3);
    assert.strictEqual(signals[2].skill_key, 'belief_updating');
    assert.strictEqual(signals[2].hit, true); // shift = 3 >= 1.0
    assert.ok(signals[2].detail.includes('lower'));
  });

  it('belief_updating miss when confidence shift < 1.0', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: [],
      original_confidence: 7,
      hindsight_confidence: 7.5,
    });
    assert.strictEqual(signals[2].hit, false);
    assert.ok(signals[2].detail.includes('barely changed'));
  });

  it('belief_updating detects higher confidence', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: [],
      original_confidence: 5,
      hindsight_confidence: 8,
    });
    assert.strictEqual(signals[2].hit, true);
    assert.ok(signals[2].detail.includes('higher'));
  });

  it('no belief_updating signal when confidence data missing', () => {
    const signals = selfReviewSignals({
      score_divergence: 0,
      weaknesses_found: [],
      original_confidence: null,
      hindsight_confidence: null,
    });
    assert.strictEqual(signals.length, 2); // Only calibration + adversarial
  });
});
