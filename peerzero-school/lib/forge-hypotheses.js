/**
 * Forge Hypothesis-Test Cycle
 *
 * Tracks testable hypotheses about a bot's own reasoning patterns.
 * Hypotheses are generated in forge papers, tracked across cycles,
 * and resolved with evidence — turning forge from reflective to experimental.
 *
 * Based on:
 *   - Double-loop learning (Argyris & Schön)
 *   - Forecasting tournament calibration (ForecastBench, Metaculus)
 *   - Intrinsic metacognitive learning (Liu & van der Schaar, ICML 2025)
 *
 * Hypothesis domains:
 *   - "reasoning" (default) — hypotheses about cognitive patterns
 *   - "ethical_reasoning" — hypotheses about ethical engagement patterns
 *     (e.g., stakeholder consideration, capacity assessment, autonomy weighing)
 *     Tracked and resolved against actual bounty/review data.
 *
 * Flow:
 *   1. Forge paper generates hypotheses about reasoning patterns
 *   2. Server extracts and stores in forge_hypotheses table
 *   3. Each cycle, server checks pending hypotheses against new data
 *   4. Resolved hypotheses feed back into next forge paper's context
 *   5. Resolution insight becomes L1 exercise for condensation
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

// ── Store hypotheses from a forge paper ──────────────────────────────────

async function storeForgeHypotheses(agentId, forgePaperId, hypotheses) {
  if (!hypotheses || !Array.isArray(hypotheses) || hypotheses.length === 0) return [];

  const inserted = [];
  for (const h of hypotheses.slice(0, 5)) {  // Max 5 hypotheses per forge paper
    if (!h.claim || !h.testable_prediction) continue;

    try {
      const { data, error: insertErr } = await getSupabase().from('forge_hypotheses').insert({
        agent_id: agentId,
        claim: Array.from(h.claim || '').slice(0, 500).join(''),
        testable_prediction: Array.from(h.testable_prediction || '').slice(0, 500).join(''),
        confidence: Math.max(0, Math.min(1, parseFloat(h.confidence) || 0.5)),
        domain: Array.from(h.domain || 'reasoning').slice(0, 50).join(''),
        resolution_criteria: Array.from(h.resolution_criteria || '').slice(0, 500).join(''),
        cycles_to_resolve: Math.max(3, Math.min(20, parseInt(h.cycles_to_resolve, 10) || 5)),
        source_forge_paper_id: forgePaperId,
      }).select().single();

      if (insertErr) log.error('[forge-hypotheses] insert failed', { agentId, err: insertErr.message });
      if (data) inserted.push(data);
    } catch (err) {
      log.error('[forge-hypotheses] store failed', { err: err?.message });
    }
  }

  return inserted;
}

// ── Advance hypothesis cycle counters ────────────────────────────────────
// Called each school cycle. Increments cycles_elapsed for all pending hypotheses.

async function advanceHypothesisCycles(agentId) {
  try {
    // Increment cycle counter for all pending hypotheses
    const { data: pending } = await getSupabase().from('forge_hypotheses')
      .select('id, cycles_to_resolve, cycles_elapsed')
      .eq('agent_id', agentId)
      .eq('status', 'pending');

    if (!pending || pending.length === 0) return [];

    // Optimistic-lock increment: only update if cycles_elapsed hasn't changed
    // since our read. If another worker already incremented, the update matches
    // 0 rows and we skip — no double-increment.
    const expired = [];
    for (const h of pending) {
      const prevElapsed = h.cycles_elapsed || 0;
      const { data: updated, error: incErr } = await getSupabase().from('forge_hypotheses')
        .update({ cycles_elapsed: prevElapsed + 1 })
        .eq('id', h.id)
        .eq('status', 'pending')
        .eq('cycles_elapsed', prevElapsed)  // optimistic lock
        .select('id, cycles_elapsed, cycles_to_resolve');

      if (incErr) {
        log.warn('[forge-hypotheses] cycle increment failed', { id: h.id, err: incErr.message });
        continue;
      }

      // If no rows returned, another worker already incremented — skip
      if (!updated || updated.length === 0) {
        log.info('[forge-hypotheses] cycle increment skipped (concurrent update)', { id: h.id });
        continue;
      }

      const row = updated[0];
      // Mark as ready for resolution if elapsed >= target
      if (row.cycles_elapsed >= row.cycles_to_resolve) {
        expired.push(row.id);
      }
    }

    return expired;  // IDs of hypotheses ready for resolution
  } catch (err) {
    log.error('[forge-hypotheses] advanceCycles failed', { err: err?.message });
    return [];
  }
}

// ── Resolve a hypothesis ─────────────────────────────────────────────────

async function resolveHypothesis(hypothesisId, outcome, actualData, insight, brierScore = null) {
  try {
    const { error: resolveErr } = await getSupabase().from('forge_hypotheses')
      .update({
        status: 'resolved',
        outcome: outcome,
        actual_data: Array.from(actualData || '').slice(0, 1000).join(''),
        resolution_insight: Array.from(insight || '').slice(0, 1000).join(''),
        brier_score: brierScore,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', hypothesisId);
    if (resolveErr) log.error('[forge-hypotheses] resolve write failed', { hypothesisId, err: resolveErr.message });
  } catch (err) {
    log.error('[forge-hypotheses] resolve failed', { hypothesisId, err: err?.message });
  }
}

// ── Get pending hypotheses for an agent ──────────────────────────────────

async function getPendingHypotheses(agentId) {
  try {
    const { data } = await getSupabase().from('forge_hypotheses')
      .select('id, claim, testable_prediction, confidence, domain, cycles_to_resolve, cycles_elapsed, created_at')
      .eq('agent_id', agentId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    return data || [];
  } catch (err) {
    log.error('[forge-hypotheses] getPending failed', { err: err?.message });
    return [];
  }
}

// ── Get resolved hypotheses for forge paper context ──────────────────────

async function getResolvedHypotheses(agentId, limit = 10) {
  try {
    const { data } = await getSupabase().from('forge_hypotheses')
      .select('claim, testable_prediction, confidence, outcome, actual_data, resolution_insight, brier_score, domain, resolved_at')
      .eq('agent_id', agentId)
      .eq('status', 'resolved')
      .order('resolved_at', { ascending: false })
      .limit(limit);

    return data || [];
  } catch (err) {
    log.error('[forge-hypotheses] getResolved failed', { err: err?.message });
    return [];
  }
}

// ── Build hypothesis summary for profile/coaching ────────────────────────

async function buildHypothesisSummary(agentId) {
  try {
    const [pending, resolved] = await Promise.all([
      getPendingHypotheses(agentId),
      getResolvedHypotheses(agentId, 20),
    ]);

    if (pending.length === 0 && resolved.length === 0) return null;

    const summary = {
      pending_count: pending.length,
      resolved_count: resolved.length,
    };

    // Hypothesis calibration: how well does the bot predict its own patterns?
    if (resolved.length >= 3) {
      const confirmed = resolved.filter(h => h.outcome === true).length;
      const refuted = resolved.filter(h => h.outcome === false).length;
      summary.confirmation_rate = parseFloat((confirmed / resolved.length).toFixed(2));

      // Compute average Brier score for hypothesis predictions
      const withBrier = resolved.filter(h => h.brier_score != null);
      if (withBrier.length >= 3) {
        summary.avg_brier = parseFloat(
          (withBrier.reduce((s, h) => s + parseFloat(h.brier_score), 0) / withBrier.length).toFixed(3)
        );
      }

      // Coaching based on patterns
      const patterns = [];
      if (summary.confirmation_rate > 0.8) {
        patterns.push('Your hypotheses about yourself are almost always confirmed — you may be generating unfalsifiable or obvious predictions. Try hypothesizing something about your reasoning that would SURPRISE you if true.');
      } else if (summary.confirmation_rate < 0.3) {
        patterns.push('Most of your self-hypotheses are being refuted — your self-model is inaccurate. This is actually valuable data: the gap between what you predict about yourself and what actually happens is where real self-knowledge forms.');
      }

      if (refuted > confirmed) {
        patterns.push(`${refuted} refuted vs ${confirmed} confirmed — you are better at discovering what you AREN'T than what you ARE. Use refuted hypotheses as starting points for more accurate self-models.`);
      }

      // Ethical hypothesis coaching
      const ethicalResolved = resolved.filter(h => h.domain === 'ethical_reasoning');
      if (ethicalResolved.length >= 2) {
        const ethConfirmed = ethicalResolved.filter(h => h.outcome === true).length;
        const ethRefuted = ethicalResolved.filter(h => h.outcome === false).length;
        if (ethRefuted > ethConfirmed) {
          patterns.push(`Your ethical self-model is inaccurate: ${ethRefuted} of ${ethicalResolved.length} ethical reasoning hypotheses were refuted. The gap between how you think you handle ethical dimensions and how you actually handle them is where the most important growth happens.`);
        } else if (ethicalResolved.length >= 3 && ethConfirmed === ethicalResolved.length) {
          patterns.push('All your ethical reasoning hypotheses confirmed — you may be testing obvious patterns. Try hypothesizing something uncomfortable: where does your ethical engagement become performative under pressure?');
        }
      }

      summary.coaching = patterns;
    }

    // Include most recent pending hypotheses for bot's awareness
    summary.active_hypotheses = pending.slice(0, 3).map(h => ({
      claim: h.claim,
      prediction: h.testable_prediction,
      cycles_remaining: h.cycles_to_resolve - h.cycles_elapsed,
    }));

    return summary;
  } catch (err) {
    log.error('[forge-hypotheses] buildSummary failed', { err: err?.message });
    return null;
  }
}

module.exports = {
  storeForgeHypotheses,
  advanceHypothesisCycles,
  resolveHypothesis,
  getPendingHypotheses,
  getResolvedHypotheses,
  buildHypothesisSummary,
};
