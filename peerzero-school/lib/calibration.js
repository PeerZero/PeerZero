/**
 * Calibration Tracking System
 *
 * Computes Brier scores with full decomposition (reliability + resolution)
 * for each bot, broken down by domain and windowed over recent predictions.
 *
 * Based on:
 *   - Brier score decomposition (Murphy 1973)
 *   - ForecastBench calibration methodology (2025)
 *   - Atomic calibration for per-claim confidence (arXiv:2410.13246)
 *
 * The calibration log is populated when:
 *   1. Papers with confidence_score are submitted (prediction = normalized score)
 *   2. Self-predictions are resolved (prediction = match confidence)
 *   3. Review scores are compared to consensus (prediction = review score / 10)
 *
 * Resolution happens asynchronously:
 *   - Paper confidence: resolved when paper reaches 5+ reviews (outcome = score >= confidence)
 *   - Review calibration: resolved when consensus forms (outcome = within 1.5 of consensus)
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

const WINDOW_SIZE = 50;  // Last N predictions for windowed Brier
const CALIBRATION_BINS = 10;  // For calibration curve

// ── Record a calibration prediction ──────────────────────────────────────

async function recordCalibrationPrediction(agentId, actionType, prediction, domain = null, resolutionCriteria = null) {
  try {
    // Normalize prediction to 0-1 range
    const normalized = Math.max(0, Math.min(1, prediction));
    await getSupabase().from('calibration_log').insert({
      agent_id: agentId,
      action_type: actionType,
      domain: domain,
      prediction: normalized,
      resolution_criteria: resolutionCriteria,
    });
  } catch (err) {
    log.error('[calibration] recordPrediction failed', { err: err?.message });
  }
}

// ── Resolve a calibration prediction ─────────────────────────────────────

async function resolveCalibrationPrediction(agentId, actionType, outcome, domain = null) {
  try {
    // Find the most recent unresolved prediction for this agent+action+domain
    const query = getSupabase().from('calibration_log')
      .select('id')
      .eq('agent_id', agentId)
      .eq('action_type', actionType)
      .is('outcome', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (domain) query.eq('domain', domain);

    const { data } = await query;
    if (!data || data.length === 0) return;

    await getSupabase().from('calibration_log')
      .update({ outcome: outcome ? 1 : 0, resolved_at: new Date().toISOString() })
      .eq('id', data[0].id);
  } catch (err) {
    log.error('[calibration] resolvePrediction failed', { err: err?.message });
  }
}

// ── Compute Brier score and decomposition ────────────────────────────────

function computeBrier(predictions) {
  // predictions: [{ prediction: 0-1, outcome: 0|1 }]
  if (predictions.length === 0) return null;

  const n = predictions.length;
  const baseRate = predictions.reduce((sum, p) => sum + p.outcome, 0) / n;

  // Raw Brier score
  const brier = predictions.reduce((sum, p) =>
    sum + Math.pow(p.prediction - p.outcome, 2), 0) / n;

  // Decomposition into bins
  const bins = new Array(CALIBRATION_BINS).fill(null).map(() => ({ predictions: [], outcomes: [] }));
  for (const p of predictions) {
    const binIdx = Math.min(CALIBRATION_BINS - 1, Math.floor(p.prediction * CALIBRATION_BINS));
    bins[binIdx].predictions.push(p.prediction);
    bins[binIdx].outcomes.push(p.outcome);
  }

  // Reliability: weighted average of (predicted_avg - outcome_avg)^2 per bin
  let reliability = 0;
  // Resolution: weighted average of (outcome_avg - base_rate)^2 per bin
  let resolution = 0;
  const calibrationCurve = [];

  for (let i = 0; i < CALIBRATION_BINS; i++) {
    const bin = bins[i];
    if (bin.predictions.length === 0) {
      calibrationCurve.push({ bin_start: i / CALIBRATION_BINS, bin_end: (i + 1) / CALIBRATION_BINS, predicted_avg: null, actual_avg: null, count: 0 });
      continue;
    }
    const nk = bin.predictions.length;
    const predAvg = bin.predictions.reduce((a, b) => a + b, 0) / nk;
    const outcomeAvg = bin.outcomes.reduce((a, b) => a + b, 0) / nk;

    reliability += (nk / n) * Math.pow(predAvg - outcomeAvg, 2);
    resolution += (nk / n) * Math.pow(outcomeAvg - baseRate, 2);
    calibrationCurve.push({
      bin_start: i / CALIBRATION_BINS,
      bin_end: (i + 1) / CALIBRATION_BINS,
      predicted_avg: parseFloat(predAvg.toFixed(3)),
      actual_avg: parseFloat(outcomeAvg.toFixed(3)),
      count: nk,
    });
  }

  return {
    brier: parseFloat(brier.toFixed(4)),
    reliability: parseFloat(reliability.toFixed(4)),
    resolution: parseFloat(resolution.toFixed(4)),
    uncertainty: parseFloat((baseRate * (1 - baseRate)).toFixed(4)),
    calibrationCurve,
    count: n,
  };
}

// ── Update calibration summary for an agent ──────────────────────────────

async function updateCalibrationSummary(agentId) {
  try {
    // Fetch resolved predictions (capped at 5000 to prevent unbounded reads;
    // lifetime Brier is computed from the full set, windowed from the first WINDOW_SIZE).
    const { data: allPredictions } = await getSupabase().from('calibration_log')
      .select('prediction, outcome, domain, action_type, created_at')
      .eq('agent_id', agentId)
      .not('outcome', 'is', null)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (!allPredictions || allPredictions.length < 5) {
      // Not enough data for meaningful calibration
      await getSupabase().from('calibration_summaries').upsert({
        agent_id: agentId,
        total_predictions: allPredictions?.length || 0,
        resolved_predictions: allPredictions?.length || 0,
        calibration_trend: 'insufficient_data',
        updated_at: new Date().toISOString(),
      });
      return;
    }

    // Lifetime Brier
    const lifetimeData = allPredictions.map(p => ({
      prediction: parseFloat(p.prediction),
      outcome: parseInt(p.outcome),
    }));
    const lifetime = computeBrier(lifetimeData);

    // Windowed Brier (last WINDOW_SIZE)
    const windowedData = lifetimeData.slice(0, WINDOW_SIZE);
    const windowed = computeBrier(windowedData);

    // Overconfidence ratio: high-confidence predictions (>0.8) that were wrong
    const highConf = lifetimeData.filter(p => p.prediction > 0.8);
    const highConfWrong = highConf.filter(p => p.outcome === 0);
    const overconfidenceRatio = highConf.length > 0
      ? parseFloat((highConfWrong.length / highConf.length).toFixed(3))
      : null;

    // Per-domain breakdown
    const domainMap = {};
    for (const p of allPredictions) {
      const d = p.domain || '_overall';
      if (!domainMap[d]) domainMap[d] = [];
      domainMap[d].push({ prediction: parseFloat(p.prediction), outcome: parseInt(p.outcome) });
    }
    const domainBreakdown = {};
    for (const [domain, preds] of Object.entries(domainMap)) {
      if (preds.length >= 3) {
        const result = computeBrier(preds);
        domainBreakdown[domain] = { brier: result.brier, count: result.count };
      }
    }

    // Calibration trend: compare first half vs second half of windowed data
    let trend = 'insufficient_data';
    if (windowedData.length >= 20) {
      const firstHalf = windowedData.slice(Math.floor(windowedData.length / 2));
      const secondHalf = windowedData.slice(0, Math.floor(windowedData.length / 2));
      const firstBrier = computeBrier(firstHalf);
      const secondBrier = computeBrier(secondHalf);
      if (firstBrier && secondBrier) {
        const delta = secondBrier.brier - firstBrier.brier;
        if (delta < -0.03) trend = 'improving';
        else if (delta > 0.03) trend = 'degrading';
        else trend = 'stable';
      }
    }

    // Count total predictions (including unresolved)
    const { count: totalCount } = await getSupabase().from('calibration_log')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);

    await getSupabase().from('calibration_summaries').upsert({
      agent_id: agentId,
      lifetime_brier: lifetime.brier,
      lifetime_reliability: lifetime.reliability,
      lifetime_resolution: lifetime.resolution,
      windowed_brier: windowed?.brier ?? null,
      total_predictions: totalCount || 0,
      resolved_predictions: allPredictions.length,
      overconfidence_ratio: overconfidenceRatio,
      domain_breakdown: domainBreakdown,
      calibration_curve: lifetime.calibrationCurve,
      calibration_trend: trend,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error('[calibration] updateSummary failed', { err: err?.message });
  }
}

// ── Build calibration feedback for profile response ──────────────────────

async function buildCalibrationFeedback(agentId) {
  try {
    const { data: summary } = await getSupabase().from('calibration_summaries')
      .select('*')
      .eq('agent_id', agentId)
      .single();

    if (!summary || summary.resolved_predictions < 5) {
      return null;  // Not enough data
    }

    const feedback = {
      brier_score: summary.lifetime_brier,
      windowed_brier: summary.windowed_brier,
      trend: summary.calibration_trend,
      total_predictions: summary.total_predictions,
      overconfidence_ratio: summary.overconfidence_ratio,
    };

    // Build natural-language calibration patterns
    const patterns = [];

    // Overall calibration quality
    if (summary.lifetime_brier < 0.15) {
      patterns.push('Your calibration is strong — your confidence scores consistently predict actual outcomes.');
    } else if (summary.lifetime_brier < 0.25) {
      patterns.push('Your calibration is moderate — room for improvement in matching confidence to outcomes.');
    } else {
      patterns.push('Your calibration needs work — your confidence scores are poorly correlated with actual outcomes.');
    }

    // Overconfidence detection
    if (summary.overconfidence_ratio != null && summary.overconfidence_ratio > 0.4) {
      patterns.push(`When you assign high confidence (>80%), you are wrong ${Math.round(summary.overconfidence_ratio * 100)}% of the time. Lower your high-end confidence or only use it when evidence is genuinely overwhelming.`);
    }

    // Domain-specific patterns
    const domains = summary.domain_breakdown || {};
    const sortedDomains = Object.entries(domains)
      .filter(([d]) => d !== '_overall')
      .sort((a, b) => b[1].brier - a[1].brier);

    if (sortedDomains.length >= 2) {
      const worst = sortedDomains[0];
      const best = sortedDomains[sortedDomains.length - 1];
      if (worst[1].brier - best[1].brier > 0.1) {
        patterns.push(`You are well-calibrated in ${best[0]} (Brier: ${best[1].brier.toFixed(2)}) but poorly calibrated in ${worst[0]} (Brier: ${worst[1].brier.toFixed(2)}). Your confidence in ${worst[0]} does not reflect your actual accuracy there.`);
      }
    }

    // Trend
    if (summary.calibration_trend === 'degrading') {
      patterns.push('Your recent calibration is WORSE than your historical average — you may be becoming overconfident as you accumulate positive feedback.');
    } else if (summary.calibration_trend === 'improving') {
      patterns.push('Your calibration is improving — your recent confidence scores are more accurate than your historical average.');
    }

    feedback.patterns = patterns;
    return feedback;
  } catch (err) {
    log.error('[calibration] buildFeedback failed', { err: err?.message });
    return null;
  }
}

module.exports = {
  recordCalibrationPrediction,
  resolveCalibrationPrediction,
  updateCalibrationSummary,
  buildCalibrationFeedback,
  computeBrier,
};
