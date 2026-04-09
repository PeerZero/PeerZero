const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeBrier } = require('../lib/calibration');

describe('computeBrier()', () => {
  it('returns null for empty array', () => {
    assert.strictEqual(computeBrier([]), null);
  });

  it('returns 0 Brier for perfect predictions', () => {
    const predictions = [
      { prediction: 1.0, outcome: 1 },
      { prediction: 0.0, outcome: 0 },
      { prediction: 1.0, outcome: 1 },
      { prediction: 0.0, outcome: 0 },
    ];
    const result = computeBrier(predictions);
    assert.strictEqual(result.brier, 0);
    assert.strictEqual(result.count, 4);
  });

  it('returns 1 Brier for perfectly wrong predictions', () => {
    const predictions = [
      { prediction: 1.0, outcome: 0 },
      { prediction: 0.0, outcome: 1 },
    ];
    const result = computeBrier(predictions);
    assert.strictEqual(result.brier, 1);
  });

  it('returns ~0.25 Brier for 0.5 predictions on mixed outcomes', () => {
    const predictions = [
      { prediction: 0.5, outcome: 1 },
      { prediction: 0.5, outcome: 0 },
    ];
    const result = computeBrier(predictions);
    assert.strictEqual(result.brier, 0.25);
  });

  it('computes uncertainty correctly (base_rate * (1 - base_rate))', () => {
    // 50% base rate → uncertainty = 0.25
    const predictions = [
      { prediction: 0.7, outcome: 1 },
      { prediction: 0.3, outcome: 0 },
    ];
    const result = computeBrier(predictions);
    assert.strictEqual(result.uncertainty, 0.25);
  });

  it('computes uncertainty for 100% base rate', () => {
    const predictions = [
      { prediction: 0.8, outcome: 1 },
      { prediction: 0.9, outcome: 1 },
    ];
    const result = computeBrier(predictions);
    // base_rate = 1, uncertainty = 1 * 0 = 0
    assert.strictEqual(result.uncertainty, 0);
  });

  it('generates 10 calibration curve bins', () => {
    const predictions = [];
    for (let i = 0; i < 100; i++) {
      predictions.push({ prediction: i / 100, outcome: i % 2 });
    }
    const result = computeBrier(predictions);
    assert.strictEqual(result.calibrationCurve.length, 10);
    // Each bin should have predictions
    for (const bin of result.calibrationCurve) {
      assert.ok(bin.count > 0, `bin ${bin.bin_start}-${bin.bin_end} should have predictions`);
      assert.ok(bin.predicted_avg != null);
      assert.ok(bin.actual_avg != null);
    }
  });

  it('handles empty bins in calibration curve', () => {
    // Only low predictions → high bins empty
    const predictions = [
      { prediction: 0.05, outcome: 0 },
      { prediction: 0.05, outcome: 1 },
    ];
    const result = computeBrier(predictions);
    const highBin = result.calibrationCurve[9]; // 0.9-1.0 bin
    assert.strictEqual(highBin.count, 0);
    assert.strictEqual(highBin.predicted_avg, null);
    assert.strictEqual(highBin.actual_avg, null);
  });

  it('reliability measures calibration error across bins', () => {
    // Perfect calibration: predictions match outcome rates
    const predictions = [];
    for (let i = 0; i < 100; i++) {
      // prediction = 0.8 for items that are 80% positive
      predictions.push({ prediction: 0.8, outcome: i < 80 ? 1 : 0 });
    }
    const result = computeBrier(predictions);
    // Reliability should be very low (well-calibrated)
    assert.ok(result.reliability < 0.01, `reliability ${result.reliability} should be near 0`);
  });

  it('single prediction returns valid result', () => {
    const result = computeBrier([{ prediction: 0.7, outcome: 1 }]);
    assert.ok(result);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.brier, 0.09); // (0.7 - 1)^2 = 0.09
  });

  it('Brier decomposition identity holds (brier ≈ reliability - resolution + uncertainty)', () => {
    const predictions = [];
    for (let i = 0; i < 200; i++) {
      const prob = Math.random();
      predictions.push({ prediction: prob, outcome: Math.random() < prob ? 1 : 0 });
    }
    const result = computeBrier(predictions);
    // Brier ≈ reliability - resolution + uncertainty (approximately, may have rounding)
    const reconstructed = result.reliability - result.resolution + result.uncertainty;
    assert.ok(
      Math.abs(result.brier - reconstructed) < 0.01,
      `Brier ${result.brier} should ≈ reliability ${result.reliability} - resolution ${result.resolution} + uncertainty ${result.uncertainty} = ${reconstructed}`
    );
  });

  it('bins predictions at boundaries correctly', () => {
    // prediction = 1.0 should go in the last bin (index 9), not overflow
    const predictions = [
      { prediction: 1.0, outcome: 1 },
      { prediction: 0.0, outcome: 0 },
    ];
    const result = computeBrier(predictions);
    const lastBin = result.calibrationCurve[9];
    assert.strictEqual(lastBin.count, 1);
    const firstBin = result.calibrationCurve[0];
    assert.strictEqual(firstBin.count, 1);
  });
});
