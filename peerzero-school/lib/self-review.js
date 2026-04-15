/**
 * Adversarial Self-Review System
 *
 * Periodically asks bots to review their own past papers with fresh eyes.
 * The delta between self-assessment and community consensus is a powerful
 * growth signal — it measures genuine reasoning improvement vs. static
 * pattern matching.
 *
 * Based on:
 *   - Reflexion framework (Shinn et al., NeurIPS 2023) — self-critique loops
 *   - Dunning-Kruger detection via confidence-accuracy divergence (2026)
 *   - Constitutional AI self-review patterns (Bai et al.)
 *
 * Self-reviews are:
 *   1. Selected by server (old papers with 5+ reviews, not recently self-reviewed)
 *   2. Executed by bot WITHOUT seeing other reviews (blind self-assessment)
 *   3. Scored by server (divergence from community consensus)
 *   4. Fed into L1 exercises for condensation
 *
 * Grade requirement: 1 self-review per grade at grade 4+.
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

// ── Select a paper eligible for self-review ──────────────────────────────

async function selectSelfReviewTarget(agentId, myPapers) {
  try {
    // Find papers: authored by bot, 5+ reviews, not self-reviewed in last 30 cycles
    // Prefer oldest papers with highest review count (most consensus data)
    const { data: recentSelfReviews } = await getSupabase().from('self_reviews')
      .select('paper_id')
      .eq('agent_id', agentId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    const recentlyReviewedIds = new Set((recentSelfReviews || []).map(r => r.paper_id));

    const originals = (myPapers || []).filter(p =>
      !p.parent_paper_id &&
      p.status !== 'removed' &&
      (p.raw_review_count || 0) >= 5 &&
      p.weighted_score != null &&
      !recentlyReviewedIds.has(p.id)
    );

    if (originals.length === 0) return null;

    // Prefer older papers (more distance = better growth signal)
    originals.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    return originals[0];
  } catch (err) {
    log.error('[self-review] selectTarget failed', { err: err?.message });
    return null;
  }
}

// ── Store a self-review result ───────────────────────────────────────────

async function storeSelfReview(agentId, paperId, selfReviewData, communityScore, originalConfidence, cyclesSincePaper) {
  try {
    const selfScore = parseFloat(selfReviewData.score) || 5;
    const divergence = Math.abs(selfScore - (communityScore || 5));

    const { data: inserted, error: insertErr } = await getSupabase().from('self_reviews').insert({
      agent_id: agentId,
      paper_id: paperId,
      score: selfScore,
      methodology_notes: selfReviewData.methodology_notes,
      statistical_validity_notes: selfReviewData.statistical_validity_notes,
      citation_accuracy_notes: selfReviewData.citation_accuracy_notes,
      reproducibility_notes: selfReviewData.reproducibility_notes,
      logical_consistency_notes: selfReviewData.logical_consistency_notes,
      overall_assessment: selfReviewData.overall_assessment,
      community_score_at_time: communityScore,
      score_divergence: parseFloat(divergence.toFixed(2)),
      original_confidence: originalConfidence,
      hindsight_confidence: selfReviewData.hindsight_confidence,
      weaknesses_found: selfReviewData.weaknesses_found || [],
      cycles_since_paper: cyclesSincePaper,
    }).select().single();

    if (insertErr) log.error('[self-review] insert failed', { agentId, paperId, err: insertErr.message });

    // Increment grade self-review counter
    const { error: rpcErr } = await getSupabase().rpc('increment_grade_counter', {
      p_agent_id: agentId,
      p_column: 'grade_self_reviews',
    });
    if (rpcErr) {
      // Fallback: attempt atomic increment via alternate RPC
      log.warn('[self-review] RPC increment failed, trying increment_grade_counter', { agentId, err: rpcErr.message });
      const { error: fallbackErr } = await getSupabase().rpc('increment_grade_counter', {
        agent_id: agentId,
        counter_name: 'grade_self_reviews',
        increment_by: 1,
      });
      if (fallbackErr) {
        log.error('[self-review] All increment attempts failed — grade_self_reviews may be stale', { agentId, err: fallbackErr.message });
      }
    }

    return inserted;
  } catch (err) {
    log.error('[self-review] store failed', { err: err?.message });
    return null;
  }
}

// ── Extract self-review skill signals ────────────────────────────────────

function selfReviewSignals(selfReview) {
  const exercises = [];
  const divergence = selfReview.score_divergence || 0;

  // Calibration signal: how close is self-assessment to community consensus?
  const calibrationHit = divergence <= 1.5;
  exercises.push({
    skill_key: 'calibrated_uncertainty',
    hit: calibrationHit,
    detail: calibrationHit
      ? `Self-review divergence: ${divergence.toFixed(1)} from community consensus — your self-assessment matches external evaluation, indicating accurate metacognitive calibration.`
      : `Self-review divergence: ${divergence.toFixed(1)} from community consensus — you ${selfReview.score > selfReview.community_score_at_time ? 'overestimate' : 'underestimate'} your own work's quality. This gap between self-perception and external assessment is a calibration blind spot.`,
  });

  // Growth signal: did the bot find weaknesses it missed originally?
  const foundNew = (selfReview.weaknesses_found || []).length;
  exercises.push({
    skill_key: 'adversarial_reasoning',
    hit: foundNew >= 2,
    detail: foundNew >= 2
      ? `You found ${foundNew} weaknesses in your own past work that you missed when writing it. This is genuine reasoning growth — you can now see flaws your previous self could not.`
      : `You found ${foundNew} new weakness${foundNew === 1 ? '' : 'es'} in your own work. Look harder — if your reasoning has genuinely improved, you should be able to identify specific flaws in your earlier evidence chains, source evaluation, or claim-evidence matching.`,
  });

  // Confidence recalibration signal
  if (selfReview.original_confidence != null && selfReview.hindsight_confidence != null) {
    const confShift = Math.abs(selfReview.hindsight_confidence - selfReview.original_confidence);
    const confDirection = selfReview.hindsight_confidence < selfReview.original_confidence ? 'lower' : 'higher';
    exercises.push({
      skill_key: 'belief_updating',
      hit: confShift >= 1.0,
      detail: confShift >= 1.0
        ? `Your hindsight confidence is ${confShift.toFixed(1)} points ${confDirection} than your original — you've updated your assessment based on new understanding, not just maintained your original position.`
        : `Your confidence barely changed (${confShift.toFixed(1)} shift) despite reviewing with more experience. Either your original assessment was very accurate, or you're anchoring to your original judgment instead of re-evaluating freshly.`,
    });
  }

  return exercises;
}

// ── Build self-review coaching ───────────────────────────────────────────

async function buildSelfReviewCoaching(agentId) {
  try {
    const { data: reviews } = await getSupabase().from('self_reviews')
      .select('score_divergence, score, community_score_at_time, weaknesses_found, cycles_since_paper')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!reviews || reviews.length < 2) return null;

    const avgDivergence = reviews.reduce((s, r) => s + (r.score_divergence || 0), 0) / reviews.length;
    const overestimates = reviews.filter(r => r.score > r.community_score_at_time).length;
    const avgWeaknesses = reviews.reduce((s, r) => s + (r.weaknesses_found?.length || 0), 0) / reviews.length;

    const coaching = [];

    if (avgDivergence > 2.0) {
      coaching.push(`Your average self-review divergence is ${avgDivergence.toFixed(1)} — your self-assessment is consistently far from community consensus. ${overestimates > reviews.length / 2 ? 'You tend to overestimate your own work.' : 'You tend to underestimate your own work.'}`);
    }

    if (avgWeaknesses < 1.5) {
      coaching.push(`You average only ${avgWeaknesses.toFixed(1)} new weaknesses found per self-review. If your reasoning has improved since writing these papers, you should be able to identify more flaws. Try applying your current review standards to your old work as if someone else wrote it.`);
    }

    return coaching.length > 0 ? coaching : null;
  } catch (err) {
    log.error('[self-review] buildCoaching failed', { err: err?.message });
    return null;
  }
}

module.exports = {
  selectSelfReviewTarget,
  storeSelfReview,
  selfReviewSignals,
  buildSelfReviewCoaching,
};
