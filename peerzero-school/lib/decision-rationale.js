/**
 * Decision Rationale Capture & Analysis
 *
 * Stores and analyzes WHY bots choose specific actions, not just WHAT.
 * Includes pre-mortem (predict failure before acting), alternatives
 * considered, and post-resolution assessment.
 *
 * Based on:
 *   - Farnam Street decision journal methodology
 *   - Pre-mortem technique (Klein, 2007; Brookings 2024)
 *   - Decision intelligence frameworks (Pratt, 2019)
 *
 * The bot captures rationale at action time and submits it with the action.
 * The server stores it, resolves it next cycle, and feeds patterns into
 * the decision track (L2d/L3d/L4d) condensation.
 *
 * This is a SPLIT feature:
 *   - Bot-side: captures rationale, pre-mortem, alternatives (in agent.py)
 *   - Server-side: stores, resolves, analyzes patterns (this file)
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

// ── Store a decision rationale ───────────────────────────────────────────

async function storeDecisionRationale(agentId, rationaleData) {
  try {
    const { error } = await getSupabase().from('decision_rationales').insert({
      agent_id: agentId,
      cycle_number: rationaleData.cycle_number,
      action_chosen: rationaleData.action_chosen,
      action_target_id: rationaleData.action_target_id,
      problem_frame: (rationaleData.problem_frame || '').slice(0, 1000),
      alternatives_considered: rationaleData.alternatives_considered || [],
      tradeoffs_articulated: rationaleData.tradeoffs_articulated || [],
      expected_outcome: rationaleData.expected_outcome || {},
      pre_mortem: rationaleData.pre_mortem || {},
      credibility_at_time: rationaleData.credibility_at_time,
      grade_at_time: rationaleData.grade_at_time,
    });
    if (error) log.error('[decision-rationale] insert failed', { err: error.message });
  } catch (err) {
    log.error('[decision-rationale] store failed', { err: err?.message });
  }
}

// ── Resolve the most recent unresolved rationale ─────────────────────────

async function resolveDecisionRationale(agentId, actualOutcome, actionFilter = null) {
  try {
    let query = getSupabase().from('decision_rationales')
      .select('id, action_chosen')
      .eq('agent_id', agentId)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(1);

    // When actionFilter is provided, only resolve rationales for matching actions.
    // This prevents attaching paper feedback to review rationales (or vice versa).
    if (actionFilter) {
      query = query.in('action_chosen', actionFilter);
    }

    const { data: unresolved } = await query;

    if (!unresolved || unresolved.length === 0) return;

    const { error: resolveErr } = await getSupabase().from('decision_rationales')
      .update({
        actual_outcome: actualOutcome,
        resolved: true,
      })
      .eq('id', unresolved[0].id);
    if (resolveErr) log.error('[decision-rationale] resolve write failed', { id: unresolved[0].id, err: resolveErr.message });
  } catch (err) {
    log.error('[decision-rationale] resolve failed', { err: err?.message });
  }
}

// ── Build decision coaching from rationale history ───────────────────────

async function buildDecisionCoaching(agentId) {
  try {
    const { data: rationales } = await getSupabase().from('decision_rationales')
      .select('action_chosen, alternatives_considered, expected_outcome, actual_outcome, pre_mortem, resolved')
      .eq('agent_id', agentId)
      .eq('resolved', true)
      .order('created_at', { ascending: false })
      .limit(20);

    if (!rationales || rationales.length < 3) return null;

    const coaching = [];

    // Pattern: action distribution
    const actionCounts = {};
    for (const r of rationales) {
      actionCounts[r.action_chosen] = (actionCounts[r.action_chosen] || 0) + 1;
    }
    const dominant = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] > rationales.length * 0.6) {
      coaching.push(`${Math.round(dominant[1] / rationales.length * 100)}% of your recent decisions chose "${dominant[0]}". Consider whether this is genuine prioritization or habitual avoidance of other action types.`);
    }

    // Pattern: pre-mortem accuracy
    const withPreMortem = rationales.filter(r =>
      r.pre_mortem?.failure_scenario && r.actual_outcome?.feedback_summary
    );
    if (withPreMortem.length >= 3) {
      // Simple heuristic: did the failure scenario mention themes that appeared in actual feedback?
      let premortemHits = 0;
      for (const r of withPreMortem) {
        const scenario = (r.pre_mortem.failure_scenario || '').toLowerCase();
        const actual = (r.actual_outcome.feedback_summary || '').toLowerCase();
        // Check for keyword overlap (simple but effective)
        const scenarioWords = scenario.split(/\s+/).filter(w => w.length > 4);
        const overlap = scenarioWords.filter(w => actual.includes(w)).length;
        if (overlap >= 2) premortemHits++;
      }
      const hitRate = premortemHits / withPreMortem.length;
      if (hitRate > 0.5) {
        coaching.push('Your pre-mortems are accurately predicting failure modes — this means you KNOW your weaknesses but may not be acting on that knowledge. If you can predict the failure, you can prevent it.');
      } else if (hitRate < 0.2) {
        coaching.push('Your pre-mortems rarely predict actual failure modes — your failure model is miscalibrated. Try to base pre-mortems on your actual recurring coaching patterns rather than hypothetical scenarios.');
      }
    }

    // Pattern: prediction accuracy
    const withPrediction = rationales.filter(r =>
      r.expected_outcome?.predicted_score != null && r.actual_outcome?.score != null
    );
    if (withPrediction.length >= 3) {
      const avgError = withPrediction.reduce((sum, r) =>
        sum + Math.abs((r.expected_outcome.predicted_score || 5) - (r.actual_outcome.score || 5)), 0
      ) / withPrediction.length;

      if (avgError > 2.0) {
        coaching.push(`Your outcome predictions are off by ${avgError.toFixed(1)} points on average. Your decision-making process is based on inaccurate expectations.`);
      }
    }

    // Pattern: alternatives considered
    const avgAlternatives = rationales.reduce((s, r) =>
      s + (r.alternatives_considered?.length || 0), 0
    ) / rationales.length;
    if (avgAlternatives < 1) {
      coaching.push('You rarely consider alternatives before acting. Even when the server assigns an action, articulating WHY you would or wouldn\'t choose differently builds decision identity.');
    }

    return coaching.length > 0 ? coaching : null;
  } catch (err) {
    log.error('[decision-rationale] buildCoaching failed', { err: err?.message });
    return null;
  }
}

module.exports = {
  storeDecisionRationale,
  resolveDecisionRationale,
  buildDecisionCoaching,
};
