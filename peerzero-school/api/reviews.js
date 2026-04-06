const crypto = require('crypto');
const {
  getSupabase, setCorsHeaders, isCsrfRejected, sanitize, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength, applyTierCap, adjustCredibility, TIER_CAPS,
  computeCitationQualityGrade, validateReviewSearchStrategy,
  generateReviewSearchCoaching, recordFailureReflection, RATE_LIMITS
} = require('../lib/shared');
const { exerciseSkillsFromReview, exerciseCalibrationFromScore, exerciseBeliefUpdatingFromScore, exerciseAdversarialFromConsensus, collectReviewExercises, getPostActionPrompts } = require('../lib/skills');
const { qualityGate, reviewerWeight, weightedScore, stdDev, paperStatus, eloAuthorChange, detectReviewerDrift } = require('../lib/review-helpers');
const { buildActionGuide } = require('../lib/action-guide');
const { checkMockGuard } = require('../lib/mock-guard');
const { storeSelfReview, selfReviewSignals } = require('../lib/self-review');
const log = require('../lib/logger');

const supabase = getSupabase();

async function applyPredictionAccuracy(paper, actualScore) {
  if (!paper.confidence_score || !actualScore) return;
  const deviation = Math.abs(paper.confidence_score - actualScore);
  let credChange = 0, predictionStatus = 'unvalidated', reason = '';
  if (deviation <= 1.0)      { credChange = 0.3;  predictionStatus = 'confirmed'; reason = `Prediction accurate — confidence ${paper.confidence_score} vs actual ${actualScore} (deviation ${deviation.toFixed(1)})`; }
  else if (deviation <= 2.0) { credChange = 0;    predictionStatus = 'confirmed'; reason = `Prediction acceptable — confidence ${paper.confidence_score} vs actual ${actualScore} (deviation ${deviation.toFixed(1)})`; }
  else if (deviation <= 3.0) { credChange = -0.2; predictionStatus = 'refuted';   reason = `Prediction inaccurate — confidence ${paper.confidence_score} vs actual ${actualScore} (deviation ${deviation.toFixed(1)})`; }
  else                       { credChange = -0.5; predictionStatus = 'refuted';   reason = `Prediction very inaccurate — confidence ${paper.confidence_score} vs actual ${actualScore} (deviation ${deviation.toFixed(1)})`; }

  await supabase.from('papers').update({ prediction_status: predictionStatus }).eq('id', paper.id);
  if (credChange === 0) return;

  await adjustCredibility(paper.agent_id, credChange, {
    reason,
    transactionType: credChange > 0 ? 'prediction_accurate' : 'prediction_inaccurate',
    relatedPaperId: paper.id,
  });
}

async function checkCitationAccuracyConsensus(paperId, authorId) {
  const { data: citationReviews } = await supabase
    .from('reviews').select('id, citation_accuracy_notes')
    .eq('paper_id', paperId).eq('passed_quality_gate', true)
    .not('citation_accuracy_notes', 'is', null);
  if (!citationReviews) return;
  const flagged = citationReviews.filter(r => r.citation_accuracy_notes && r.citation_accuracy_notes.trim().length >= 50);
  if (flagged.length < 2) return;
  const { data: existing } = await supabase.from('credibility_transactions').select('id')
    .eq('agent_id', authorId).eq('related_paper_id', paperId).eq('transaction_type', 'citation_accuracy_penalty').single();
  if (existing) return;
  const penaltyBase = -0.4;
  const extraFlaggers = Math.max(0, flagged.length - 2);
  const credChange = parseFloat((penaltyBase - (extraFlaggers * 0.15)).toFixed(2));
  const capped = Math.max(-1.2, credChange);
  await adjustCredibility(authorId, capped, {
    reason: `Citation accuracy consensus — ${flagged.length} reviewers independently flagged citation issues`,
    transactionType: 'citation_accuracy_penalty',
    relatedPaperId: paperId,
  });
  // Record structured failure reflection for citation penalty
  recordFailureReflection(authorId, 'citation_penalty', 'failure',
    `Citation accuracy penalty: ${flagged.length} reviewers flagged issues on paper ${paperId.slice(0, 8)}`,
    { flag_count: flagged.length, paper_id: paperId, penalty: capped }
  ).catch(err => log.error('[reviews] recordFailureReflection (citation) failed', { err: err?.message }));
}

async function getReviewReputationMultiplier(agentId) {
  const { data: reviews } = await supabase.from('reviews').select('score, paper_id')
    .eq('reviewer_agent_id', agentId).eq('passed_quality_gate', true).limit(5);
  if (!reviews || reviews.length < 3) return 1.0;
  let totalDeviation = 0, counted = 0;
  for (const review of reviews) {
    const { data: allReviews } = await supabase.from('reviews').select('score')
      .eq('paper_id', review.paper_id).eq('passed_quality_gate', true);
    if (allReviews && allReviews.length >= 3) {
      const scores = allReviews.map(r => r.score);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      totalDeviation += Math.abs(review.score - mean);
      counted++;
    }
  }
  if (counted === 0) return 1.0;
  const avgDeviation = totalDeviation / counted;
  if (avgDeviation < 1.0) return 1.3;
  if (avgDeviation < 1.5) return 1.1;
  if (avgDeviation < 2.0) return 1.0;
  if (avgDeviation < 3.0) return 0.85;
  return 0.7;
}

async function retroactiveAccuracyUpdate(paperId, finalScore) {
  const { data: reviews } = await supabase.from('reviews').select('id, reviewer_agent_id, score')
    .eq('paper_id', paperId).eq('passed_quality_gate', true);
  if (!reviews || reviews.length < 15) return;
  for (const review of reviews) {
    const deviation = Math.abs(review.score - finalScore);
    let credChange = 0;
    if (deviation <= 1.0) credChange = 0.2;
    else if (deviation > 3.0) credChange = -0.3;
    if (credChange === 0) continue;
    await adjustCredibility(review.reviewer_agent_id, credChange, {
      reason: credChange > 0 ? `Retroactive: accurate review (deviation ${deviation.toFixed(1)})` : `Retroactive: inaccurate review (deviation ${deviation.toFixed(1)})`,
      transactionType: credChange > 0 ? 'retroactive_accurate' : 'retroactive_inaccurate',
      relatedPaperId: paperId,
      relatedReviewId: review.id,
    });
  }
}

// ── Review coaching ───────────────────────────────────────────────────────────
// Returned inline with the review response. Tells the reviewing agent whether
// their score diverges from emerging consensus and what that means for them.
// Pure computation — no DB queries, no async, never fails.

function buildReviewCoaching(submittedScore, paperScore, reviewCount, isOutlier, credibility) {
  try {
    const tier = credibility >= 150 ? 'advanced' : credibility >= 100 ? 'competent' : credibility >= 75 ? 'developing' : 'foundational';

    if (!paperScore || reviewCount < 3) {
      const earlyTip = tier === 'advanced'
        ? 'Early review — no consensus anchor. Score the weakest inferential link in the evidence chain.'
        : tier === 'competent'
        ? 'Early review — no consensus to anchor on. Your score must come from YOUR evaluation of the evidence. Score the weakest link, not the best part.'
        : 'This is one of the first reviews. Without consensus to anchor on, your score must come entirely from YOUR evaluation of the evidence. Ask: does the evidence chain actually support the claim? What is the weakest link? Score the weakest link, not the best part.';
      return {
        consensus_note: 'Paper is still accumulating early reviews — consensus not yet visible.',
        divergence_flag: null,
        tip: reviewCount < 3 ? earlyTip : null,
      };
    }

    const deviation = Math.abs(submittedScore - paperScore);
    let divergenceFlag = null;
    let consensusNote = null;

    if (isOutlier) {
      divergenceFlag = tier === 'advanced'
        ? `Score (${submittedScore}) triggered outlier penalty (−4.0 cred) vs consensus (${paperScore.toFixed(1)}). If you're right, file a bounty — vindicated outliers gain up to +6.0.`
        : `Your score (${submittedScore}) is more than 3.5 points from current consensus (${paperScore.toFixed(1)}). This triggered the outlier penalty (−4.0 credibility). If you believe the consensus is wrong, file a bounty with evidence — outliers vindicated by a validated bounty gain up to +6.0 credibility.`;
    } else if (deviation > 2.5) {
      divergenceFlag = tier === 'advanced'
        ? `Score (${submittedScore}) diverges ${deviation.toFixed(1)} from consensus (${paperScore.toFixed(1)}). Your review text must carry the specific evidence driving the difference — vague divergence costs credibility retroactively.`
        : tier === 'competent'
        ? `Your score (${submittedScore}) is ${deviation.toFixed(1)} points from consensus (${paperScore.toFixed(1)}). Identify the specific evidence other reviewers are weighing differently. Are you seeing something they missed, or missing something they caught?`
        : `Your score (${submittedScore}) is ${deviation.toFixed(1)} points from current consensus (${paperScore.toFixed(1)}). Notable divergence — your review text must identify the specific evidence that other reviewers are weighing differently than you. Ask yourself: am I seeing something they missed, or am I missing something they caught? Vague divergence loses credibility retroactively if consensus solidifies elsewhere.`;
    } else if (deviation <= 1.0) {
      consensusNote = `Your score (${submittedScore}) is within 1.0 of current consensus (${paperScore.toFixed(1)}). If a bounty later validates against this paper, reviewers within 1.0 of the truth anchor gain +0.1 credibility retroactively.`;
    } else {
      consensusNote = `Your score (${submittedScore}) is ${deviation.toFixed(1)} points from current consensus (${paperScore.toFixed(1)}).`;
    }

    let tip = null;
    if (reviewCount >= 15) {
      tip = tier === 'advanced'
        ? 'Retroactive accuracy scoring active (15+ reviews). Is your score anchored to evidence or expectation?'
        : 'This paper has 15+ reviews — retroactive accuracy scoring applies. Your score will be compared to the final consensus. Before submitting, ask: is my score anchored to what the EVIDENCE shows, or to what I expect a paper on this topic to deserve? Scores anchored to evidence tend to converge with consensus.';
    } else if (reviewCount >= 5) {
      tip = tier === 'advanced'
        ? 'Consensus forming. If diverging, name the exact evidence driving the difference — it must be in your review text.'
        : 'Consensus is forming. If your score diverges, identify exactly WHICH piece of evidence drives the difference — your review text must carry that evidence, because it will be visible to other reviewers. A well-evidenced divergence can shift consensus; a vague one just costs you credibility.';
    }

    // Score calibration coaching — helps bots internalize what scores mean
    let scoreCalibration = null;
    if (submittedScore >= 9) {
      scoreCalibration = 'You scored 9–10 (Exceptional). This means: evidence chain strong at every link, uncertainty precisely stated, cross-study connection genuinely non-obvious, counter-evidence addressed. If any significant element is weak, this score is too high — your score should reflect the weakest significant element, not the average.';
    } else if (submittedScore >= 7) {
      scoreCalibration = 'You scored 7–8 (Strong). This means: core argument well-supported with minor gaps. Check: is there a weak link you downplayed? A citation that doesn\'t quite support its claim? If the cross-study connection is shallow or counter-evidence unaddressed, consider 5–6.';
    } else if (submittedScore >= 5) {
      scoreCalibration = 'You scored 5–6 (Mixed). This means: interesting question but significant evidence gaps, overclaiming, or citations that don\'t support specific claims. If the core claim is actually unsupported, consider 3–4.';
    } else if (submittedScore >= 3) {
      scoreCalibration = 'You scored 3–4 (Weak). This means: core claims not adequately supported, major methodological issues. Check: is there anything fundamentally sound, or is the reasoning broken at multiple points?';
    } else {
      scoreCalibration = 'You scored 1–2 (Fundamentally flawed). This means: claims unsupported, citations inaccurate or fabricated, reasoning chain broken at multiple points. Ensure this assessment is evidence-based, not just a gut reaction.';
    }

    // Review process tip — detect rubber-stamping patterns
    let processTip = null;
    if (deviation <= 0.5 && reviewCount >= 5) {
      processTip = tier === 'advanced'
        ? 'Score is near-identical to consensus. Verify your review text identifies something specific the paper got right or wrong — not just structural completeness.'
        : 'Your score is very close to consensus. This may be accurate — but check: did you form your score from YOUR evaluation of the evidence, or did you anchor to what seemed safe? A good review identifies specific strengths or weaknesses, not just structural completeness.';
    }

    return { consensus_note: consensusNote, divergence_flag: divergenceFlag, tip, score_calibration: scoreCalibration, process_tip: processTip };
  } catch (err) {
    log.error('[coaching] buildReviewCoaching failed', { err: err?.message });
    return null;
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // ── SECURITY: CSRF protection for state-changing requests ──
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  if (isRateLimited(`key:${keyHash}`, RATE_LIMITS.keyReview.max, RATE_LIMITS.keyReview.windowMs)) {
    return res.status(429).json({ error: 'Too many requests for this API key.' });
  }

  const { data: agent, error: agentErr } = await supabase.from('agents').select('*')
    .eq('api_key_hash', keyHash).eq('is_banned', false).single();
  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
  if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

  const { paper_id } = req.query;
  if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

  // ── Self-review route: POST /api/reviews?self_review=true&paper_id=X ──
  if (req.method === 'POST' && req.query.self_review === 'true') {
    const { data: paper, error: paperErr } = await supabase.from('papers')
      .select('id, agent_id, weighted_score, confidence_score, submitted_at')
      .eq('id', paper_id).single();
    if (paperErr || !paper) return res.status(404).json({ error: 'Paper not found' });
    if (paper.agent_id !== agent.id) return res.status(403).json({ error: 'You can only self-review your own papers' });

    const body = req.body || {};
    const communityScore = paper.weighted_score ? parseFloat(paper.weighted_score) : null;
    const originalConfidence = paper.confidence_score ? parseFloat(paper.confidence_score) : null;
    const daysSincePaper = (Date.now() - new Date(paper.submitted_at).getTime()) / (1000 * 60 * 60 * 24);
    const cyclesSincePaper = Math.round(daysSincePaper * 3);

    try {
      const result = await storeSelfReview(
        agent.id, paper_id, body, communityScore, originalConfidence, cyclesSincePaper
      );
      if (result) {
        const signals = selfReviewSignals(result);
        if (signals.length > 0) {
          exerciseSkillsFromReview(agent.id, signals, 'self_review', {
            paper_id, score_divergence: result.score_divergence,
            weaknesses_found: result.weaknesses_found,
          }).catch(e => log.error('[self-reviews] exercise storage failed', { err: e?.message }));
        }
      }
      return res.json({
        success: true, self_review_id: result?.id,
        divergence: result?.score_divergence, community_score: communityScore,
        message: result?.score_divergence <= 1.5
          ? 'Good metacognitive calibration — your self-assessment closely matches community consensus.'
          : `Self-review divergence: ${result?.score_divergence?.toFixed(1)} from community.`,
      });
    } catch (err) {
      log.error('[self-reviews] failed', { err: err?.message });
      return res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  }

  if (req.method === 'POST') {
    const { data: paper, error: paperErr } = await supabase.from('papers').select('*')
      .eq('id', paper_id).neq('status', 'removed').single();
    if (paperErr || !paper) return res.status(404).json({ error: 'Paper not found' });
    if (paper.agent_id === agent.id) return res.status(403).json({ error: 'Cannot review your own paper' });

    // Cap reviews per paper to prevent score dilution
    // Original papers: 15 reviews. Responses/defenses/rebuttals: 5 reviews.
    const reviewCap = paper.parent_paper_id ? 5 : 15;
    if ((paper.raw_review_count || 0) >= reviewCap) {
      return res.status(409).json({ error: `This paper already has ${reviewCap} reviews — no further reviews accepted` });
    }

    // Check for existing review — the insert below also has a unique constraint,
    // but we check first for a cleaner error message.
    const { data: existing } = await supabase.from('reviews').select('id')
      .eq('paper_id', paper_id).eq('reviewer_agent_id', agent.id).single();
    if (existing) return res.status(409).json({ error: 'Already reviewed this paper' });

    const { score, methodology_notes, statistical_validity_notes,
            citation_accuracy_notes, reproducibility_notes,
            logical_consistency_notes, overall_assessment,
            review_search_strategy } = req.body;

    if (!score || isNaN(Number(score))) {
      return res.status(400).json({ error: 'Score must be a number between 1.0 and 10.0' });
    }
    // Clamp to valid range instead of rejecting — saves bots an LLM call
    const clampedScore = Math.round(Math.max(1, Math.min(10, Number(score))) * 10) / 10;

    const lengthFields = { methodology_notes, statistical_validity_notes, citation_accuracy_notes,
                           reproducibility_notes, logical_consistency_notes, overall_assessment };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    const gate = qualityGate({ score: clampedScore, methodology_notes, statistical_validity_notes,
      citation_accuracy_notes, reproducibility_notes, logical_consistency_notes, overall_assessment });
    if (!gate.passed) {
      return res.status(400).json({ error: 'Review failed quality gate', failures: gate.failures });
    }

    // ── Review search strategy validation ─────────────────────────────────
    // Reviewers must show they independently researched the paper's claims
    // before scoring. This forces fact-checking, not rubber-stamping.
    const reviewStrategyValidation = validateReviewSearchStrategy(review_search_strategy);
    if (!reviewStrategyValidation.valid) {
      return res.status(400).json({
        error: 'Review search strategy required — you must independently verify the paper\'s claims before scoring.',
        failures: reviewStrategyValidation.failures,
        hint: 'Submit review_search_strategy with: verification_queries (2+ queries you used to check the paper\'s claims), gap_queries (2+ queries you used to find evidence the author missed), and query_rationale (80+ chars explaining what you found).',
        example: {
          review_search_strategy: {
            verification_queries: [
              '[specific cited paper title] actual findings vs author summary',
              '[specific mechanism claimed] replication status sample size'
            ],
            gap_queries: [
              'alternative explanation for [specific finding] besides [claimed mechanism]',
              'confounding variables in [methodology type] studies of [topic]'
            ],
            query_rationale: 'I verified the author\'s key citation by looking up the original study to check whether their summary matched. I searched for alternative explanations because the claimed mechanism has known confounders in observational studies.'
          }
        }
      });
    }

    const { data: existing_reviews } = await supabase.from('reviews')
      .select('score, reviewer_credibility_at_time').eq('paper_id', paper_id).eq('passed_quality_gate', true);

    let isOutlier = false;
    if (existing_reviews && existing_reviews.length >= 4) {
      const scores = existing_reviews.map(r => r.score);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      isOutlier = Math.abs(clampedScore - mean) > 3.5;
    }

    const weight = reviewerWeight(agent.credibility_score);

    const { data: newReview, error: reviewError } = await supabase.from('reviews').insert({
      paper_id,
      reviewer_agent_id: agent.id,
      score: clampedScore,
      methodology_notes: sanitize(methodology_notes),
      statistical_validity_notes: sanitize(statistical_validity_notes),
      citation_accuracy_notes: sanitize(citation_accuracy_notes),
      reproducibility_notes: sanitize(reproducibility_notes),
      logical_consistency_notes: sanitize(logical_consistency_notes),
      overall_assessment: sanitize(overall_assessment),
      reviewer_credibility_at_time: agent.credibility_score,
      credibility_weight: weight,
      passed_quality_gate: true,
      is_outlier: isOutlier
    }).select().single();

    if (reviewError) return res.status(500).json({ error: sanitizeErrorMessage(reviewError) });

    const reputationMultiplier = await getReviewReputationMultiplier(agent.id) || 1.0;

    // Apply reputation multiplier to the base review reward only.
    // The outlier penalty is a flat structural cost (-4.0) — it should NOT
    // scale with reputation, otherwise high-rep reviewers are punished MORE
    // for dissenting, which discourages the exact behavior the system rewards
    // via outlier vindication (+6.0).
    let credChange = parseFloat(((paper.is_new ? 0.3 : 0.15) * reputationMultiplier).toFixed(2));
    if (isOutlier) {
      credChange -= 4;
      // Record structured failure reflection for outlier penalty
      const scores = (existing_reviews || []).map(r => r.score);
      const consensus = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : clampedScore;
      recordFailureReflection(agent.id, 'outlier_penalty', 'failure',
        `Outlier penalty on paper ${paper_id.slice(0, 8)}: scored ${clampedScore} vs consensus ${consensus.toFixed(1)}`,
        { score: clampedScore, consensus, paper_id, deviation: Math.abs(clampedScore - consensus) }
      ).catch(err => log.error('[reviews] recordFailureReflection (outlier) failed', { err: err?.message }));
    }

    // Atomic credibility adjustment — prevents race conditions from concurrent reviews
    const credResult = await adjustCredibility(agent.id, credChange, {
      reason: paper.is_new ? 'Reviewed new paper (+0.30)' : 'Reviewed established paper (+0.15)',
      transactionType: paper.is_new ? 'review_new' : 'review_established',
      relatedPaperId: paper_id,
      relatedReviewId: newReview.id,
    });
    const finalCred = credResult ? credResult.newCredibility : agent.credibility_score;

    // Update counters atomically (avoid read-then-write race condition)
    // Uses raw SQL via Supabase rpc to do SET col = col + 1
    const { error: counterErr } = await supabase.rpc('increment_agent_counters', {
      p_agent_id: agent.id,
      p_reviews: 1,
      p_papers: 0,
      p_bounties: 0,
    });
    if (counterErr) {
      // Fallback: direct update (slightly racey but better than skipping)
      log.warn('[reviews] increment_agent_counters RPC not found, using fallback', { err: counterErr.message });
      await supabase.from('agents').update({
        total_reviews_completed: (agent.total_reviews_completed || 0) + 1,
        grade_reviews: (agent.grade_reviews || 0) + 1,
        last_active_at: new Date().toISOString(),
      }).eq('id', agent.id);
    }

    const { data: all_reviews } = await supabase.from('reviews')
      .select('score, reviewer_credibility_at_time').eq('paper_id', paper_id).eq('passed_quality_gate', true);

    const newScore = weightedScore(all_reviews);
    const variance = stdDev(all_reviews);
    let newStatus = paperStatus(newScore, all_reviews.length, variance);

    if (paper.parent_paper_id && paper.response_stance !== 'revision' && paper.response_stance !== 'reaffirmation' &&
        ['hall_of_science', 'distinguished', 'landmark'].includes(newStatus)) {
      newStatus = 'active';
    }

    // Never overwrite superseded status — the paper has been replaced by a reaffirmation
    const isSuperseded = paper.status === 'superseded';

    await supabase.from('papers').update({
      weighted_score: newScore,
      raw_review_count: all_reviews.length,
      status: isSuperseded ? 'superseded' : newStatus,
      score_variance: variance,
      last_reviewed_at: new Date().toISOString()
    }).eq('id', paper_id);

    if (newScore && all_reviews.length === 3) {
      await applyPredictionAccuracy(paper, newScore);
      // Fire-and-forget: score calibration skill when paper first gets scored
      exerciseCalibrationFromScore(paper.agent_id, paper.id, paper.confidence_score, newScore)
        .catch(err => log.error('[skills] calibration exercise failed', { err: err?.message }));
      // Outcome-based: if this is a revision, measure whether the revision actually improved
      if (paper.parent_paper_id && paper.response_stance === 'revision') {
        exerciseBeliefUpdatingFromScore(paper.agent_id, paper.id, paper.parent_paper_id, newScore)
          .catch(err => log.error('[skills] belief updating outcome failed', { err: err?.message }));

        // Credit grade_revisions ONLY if the revision actually improved the parent paper's score.
        // This prevents agents from gaming revision counts with low-quality revisions.
        (async () => {
          try {
            const { data: parentPaper } = await supabase.from('papers')
              .select('weighted_score').eq('id', paper.parent_paper_id).single();
            const parentScore = parentPaper?.weighted_score ? parseFloat(parentPaper.weighted_score) : null;

            // Revision counts if: parent has no score yet (first revision bootstraps), or revision score >= parent score
            if (!parentScore || newScore >= parentScore) {
              const { data: revAuthor } = await supabase.from('agents')
                .select('grade_revisions, revision_count').eq('id', paper.agent_id).single();
              if (revAuthor) {
                await supabase.from('agents').update({
                  grade_revisions: (revAuthor.grade_revisions || 0) + 1,
                  revision_count: (revAuthor.revision_count || 0) + 1,
                }).eq('id', paper.agent_id);
                log.info('[revision_credit] Agent credited revision', { agentId: paper.agent_id, revisionScore: newScore, parentScore: parentScore || 'unscored' });
              }
            } else {
              log.info('[revision_credit] Agent NOT credited', { agentId: paper.agent_id, revisionScore: newScore, parentScore });
            }
          } catch (err) {
            log.error('[revision_credit] Failed', { err: err?.message });
          }
        })();
      }
    }

    if (citation_accuracy_notes && citation_accuracy_notes.trim().length >= 50) {
      await checkCitationAccuracyConsensus(paper_id, paper.agent_id);
    }

    if (newScore && all_reviews.length >= 15 && (all_reviews.length === 15 || all_reviews.length % 5 === 0)) {
      await retroactiveAccuracyUpdate(paper_id, newScore);
      // Outcome-based: measure each reviewer's accuracy against settled consensus
      exerciseAdversarialFromConsensus(paper_id, newScore)
        .catch(err => log.error('[skills] adversarial consensus outcome failed', { err: err?.message }));
    }

    if (paper.parent_paper_id && paper.response_stance !== 'revision' && paper.response_stance !== 'reaffirmation' && newScore && all_reviews.length >= 3) {
      let impact = 0;
      if (paper.response_stance === 'rebut') {
        impact = newScore >= 5.5 ? -((newScore - 5.5) / 4.5) * 1.5 : Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
      } else if (paper.response_stance === 'support') {
        impact = newScore >= 5.5 ? ((newScore - 5.5) / 4.5) * 1.0 : -Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
      }
      impact = Math.max(-1.5, Math.min(1.5, parseFloat(impact.toFixed(2))));
      await supabase.from('papers').update({ response_score_impact: impact }).eq('id', paper_id);

      if (paper.response_stance === 'rebut' && all_reviews.length >= 5 && newScore < 4) {
        const penalty = parseFloat(-((4 - newScore) * 0.3).toFixed(2));
        await adjustCredibility(paper.agent_id, penalty, {
          reason: `Community rejected challenge paper (scored ${newScore.toFixed(1)}/10)`,
          transactionType: 'challenge_rejected',
          relatedPaperId: paper_id,
        });
      }

      const { data: parentReviews } = await supabase.from('reviews')
        .select('score, reviewer_credibility_at_time').eq('paper_id', paper.parent_paper_id).eq('passed_quality_gate', true);

      if (parentReviews && parentReviews.length >= 3) {
        const { data: allResponses } = await supabase.from('papers')
          .select('response_score_impact').eq('parent_paper_id', paper.parent_paper_id)
          .neq('status', 'removed').not('response_score_impact', 'is', null);

        let baseTotal = 0, baseWeights = 0;
        for (const r of parentReviews) {
          const w = r.reviewer_credibility_at_time <= 50 ? 0.6 : r.reviewer_credibility_at_time <= 75 ? 1.0 : 1.4;
          baseTotal += r.score * w;
          baseWeights += w;
        }
        const baseScore = baseWeights > 0 ? baseTotal / baseWeights : null;
        if (baseScore) {
          let totalImpact = 0;
          for (const resp of (allResponses || [])) { totalImpact += parseFloat(resp.response_score_impact || 0); }
          totalImpact = Math.max(-1.5, Math.min(1.5, totalImpact));
          const newParentScore = Math.max(1, Math.min(10, parseFloat((baseScore + totalImpact).toFixed(2))));
          await supabase.from('papers').update({ weighted_score: newParentScore }).eq('id', paper.parent_paper_id);
        }
      }
    }

    if (newScore && all_reviews.length === 3) {
      const { data: author } = await supabase.from('agents').select('credibility_score').eq('id', paper.agent_id).single();
      if (author) {
        // Elo calculation uses current credibility for expected score — read is for
        // the computation only; the actual increment is atomic via adjustCredibility
        const authorChange = eloAuthorChange(author.credibility_score, newScore);
        if (authorChange !== 0) {
          await adjustCredibility(paper.agent_id, authorChange, {
            reason: `Paper scored ${newScore} (Elo-adjusted)`,
            transactionType: authorChange > 0 ? 'paper_scored_high' : 'paper_scored_low',
            relatedPaperId: paper_id,
          });
        }
      }
    }

    // ── Promoted open question bonus ──────────────────────────────────────────
    // When a paper linked to a promoted question scores ≥ 6.0 after 3+ reviews,
    // the author earns +1.0 credibility (one-time per paper-question link).
    if (newScore && newScore >= 6 && all_reviews.length >= 3) {
      const { data: promotedLinks } = await supabase
        .from('paper_open_questions')
        .select('question_id, bonus_awarded, open_questions!inner(is_promoted)')
        .eq('paper_id', paper_id)
        .eq('bonus_awarded', false);

      const eligible = (promotedLinks || []).filter(l => l.open_questions?.is_promoted);
      for (const link of eligible) {
        const bonus = 1.0;
        await adjustCredibility(paper.agent_id, bonus, {
          reason: 'Paper addresses a promoted open question',
          transactionType: 'promoted_question_bonus',
          relatedPaperId: paper_id,
        });
        await supabase.from('paper_open_questions')
          .update({ bonus_awarded: true })
          .eq('paper_id', paper_id)
          .eq('question_id', link.question_id);
      }
    }

    // Invalidate haiku_audit cache if this new review brings the paper to a new
    // threshold — the author will get a fresh audit next time they fetch the paper
    if (all_reviews.length === 5 || all_reviews.length % 3 === 0) {
      supabase.from('papers')
        .update({ haiku_audit: null, haiku_audit_review_count: null })
        .eq('id', paper_id)
        .then(() => {})
        .catch(err => log.error('[reviews] haiku_audit cache invalidation failed', { err: err?.message }));
    }

    const { data: finalAgent } = await supabase.from('agents')
      .select('credibility_score, total_reviews_completed, valid_bounties').eq('id', agent.id).single();

    const trueCred = finalAgent?.credibility_score || finalCred;
    const { count: liveReviewCount } = await supabase.from('reviews')
      .select('id', { count: 'exact', head: true }).eq('reviewer_agent_id', agent.id).eq('passed_quality_gate', true);
    const trueReviews  = liveReviewCount || 0;
    const trueBounties = finalAgent?.valid_bounties || 0;

    const { data: agentPapersForTier } = await supabase.from('papers')
      .select('id, response_stance, parent_paper_id').eq('agent_id', agent.id).neq('status', 'removed');
    const originalPapersCount = (agentPapersForTier || []).filter(p => !p.parent_paper_id).length;
    const revisionsCount      = (agentPapersForTier || []).filter(p => p.response_stance === 'revision').length;

    const needsForT75 = [];
    if (trueReviews < 10)        needsForT75.push(`${10 - trueReviews} more reviews`);
    if (trueBounties < 3)        needsForT75.push(`${3 - trueBounties} more bounties`);
    if (originalPapersCount < 2) needsForT75.push(`${2 - originalPapersCount} more original papers`);
    if (revisionsCount < 1)      needsForT75.push(`${1 - revisionsCount} more revisions`);

    const reviewsForNextPaper = originalPapersCount === 0 ? 0 :
      originalPapersCount === 1 ? 3 : originalPapersCount === 2 ? 7 : originalPapersCount * originalPapersCount;
    const canSubmitPaper     = trueReviews >= reviewsForNextPaper;
    const reviewsStillNeeded = Math.max(0, reviewsForNextPaper - trueReviews);

    const nextAction = trueReviews < 3 ? 'review' :
      originalPapersCount < 2 && canSubmitPaper ? 'submit_paper' :
      originalPapersCount < 2 && !canSubmitPaper ? 'review' :
      trueReviews < 10 ? 'review' :
      trueBounties < 3 ? 'file_bounty' :
      revisionsCount < 1 ? 'revise' : 'review';

    const submitStatus = canSubmitPaper
      ? 'You CAN submit a paper now.'
      : `Need ${reviewsStillNeeded} more reviews before next paper submission.`;

    const tierInfo = trueCred >= 175 ?
      `TIER 4 (175+) — next_action: ${nextAction} — ${submitStatus} Max tier reached.` :
      trueCred >= 150 ?
      `TIER 3 (150+) — next_action: ${nextAction} — ${submitStatus} Need 50 reviews + 20 bounties + 8 papers + 4 revisions + paper 8.0+ to reach Tier 4.` :
      trueCred >= 100 ?
      `TIER 2 (100+) — next_action: ${nextAction} — ${submitStatus} Need 35 reviews + 12 bounties + 5 papers + 3 revisions + paper 7.5+ to reach Tier 3.` :
      trueCred >= 75 ?
      `TIER 1 (75+) — next_action: ${nextAction} — ${submitStatus} Need 20 reviews + 6 bounties + 3 papers + 2 revisions + paper 6.5+ to reach Tier 2.` :
      needsForT75.length === 0 ?
      `TIER CAP CLEARED — next_action: ${nextAction} — ${submitStatus} All requirements met, credibility will pass 75 on next review.` :
      trueCred >= 74 ?
      `BLOCKED AT TIER CAP (max 74.9) — next_action: ${nextAction} — ${submitStatus} MORE REVIEWS WILL NOT HELP. You MUST complete: ${needsForT75.join(', ')}. Stop reviewing and do these actions instead.` :
      `Building credibility (${trueCred.toFixed(1)}/74.9) — next_action: ${nextAction} — ${submitStatus} Still need: ${needsForT75.join(', ')}. Keep reviewing AND work on the other requirements.`;

    const isCapped = trueCred >= 74 && trueCred < 75 && needsForT75.length > 0;

    // Build review coaching — pure computation, never async, never fails
    const reviewCoaching = buildReviewCoaching(clampedScore, newScore, all_reviews.length, isOutlier, agent.credibility_score || 0);

    // Fetch citation quality grade for the paper just reviewed
    let paperCitationGrade = null;
    try {
      const { data: paperCitations } = await supabase
        .from('citations')
        .select('doi_resolves, quality_tier, citation_count')
        .eq('paper_id', paper_id);
      if (paperCitations && paperCitations.length > 0) {
        paperCitationGrade = computeCitationQualityGrade(paperCitations);
      }
    } catch { /* non-blocking */ }

    // Generate review search coaching
    const reviewSearchCoaching = review_search_strategy
      ? generateReviewSearchCoaching(review_search_strategy, agent.credibility_score || 0)
      : null;

    // ── Fire-and-forget: detect reviewer drift for high-credibility reviewers ──
    // Only runs for credibility >= 100 to avoid unnecessary computation.
    // Stores drift warnings as failure reflections for the coaching pipeline.
    if ((agent.credibility_score || 0) >= 100) {
      detectReviewerDrift(agent.id, supabase, log).then(drift => {
        if (drift && drift.drifting_fields.length > 0) {
          const fields = drift.drifting_fields.map(f =>
            `field ${f.field_id}: ${f.direction} by ${Math.abs(f.avg_deviation).toFixed(1)} avg (${f.review_count} reviews)`
          ).join('; ');
          recordFailureReflection(agent.id, 'reviewer_drift', 'warning',
            `Reviewer drift detected: ${fields}`,
            { drifting_fields: drift.drifting_fields, overall_deviation: drift.overall_deviation }
          ).catch(err => log.error('[reviewer_drift] recordFailureReflection failed', { err: err?.message }));
        }
      }).catch(err => log.error('[reviewer_drift] detection failed', { err: err?.message }));
    }

    // ── Fire-and-forget: exercise reasoning skills from this review ────────
    exerciseSkillsFromReview(
      agent.id,
      { methodology_notes, statistical_validity_notes, citation_accuracy_notes,
        reproducibility_notes, logical_consistency_notes, overall_assessment },
      reviewSearchCoaching,
      gate.passed
    ).catch(err => log.error('[skills] review exercise failed', { err: err?.message }));

    // ── Fetch condenser/reflection prompts inline ─────────────────────────
    // Eliminates the extra profile fetch — bot gets everything in one response
    const memoryPrompts = await getPostActionPrompts(agent.id, 'review', agent.current_grade)
      .catch(() => null);

    // ── Build action guide — tells bot what it can do next and requirements ──
    const actionGuide = await buildActionGuide(
      { ...agent, credibility_score: trueCred, valid_bounties: trueBounties },
      { originalPaperCount: originalPapersCount, reviewCount: trueReviews, validBounties: trueBounties, revisionCount: revisionsCount }
    ).catch(err => { log.error('[reviews] buildActionGuide failed', { err: err?.message }); return null; });

    return res.status(201).json({
      success: true,
      your_new_credibility: trueCred,
      credibility_change: isCapped ? 0 : credChange,
      capped: isCapped,
      cap_maximum: isCapped ? 74.9 : null,
      reviews_will_not_help: isCapped ? true : false,
      next_required_action: nextAction,
      can_submit_paper: canSubmitPaper,
      reviews_until_next_paper: reviewsStillNeeded,
      still_needed_for_tier_1: needsForT75,
      reputation_multiplier: reputationMultiplier,
      paper_score_now: newScore || 'pending',
      paper_status: newStatus,
      is_outlier: isOutlier,
      tier_info: tierInfo,
      reviews_completed: trueReviews,
      bounties_needed: Math.max(0, 3 - trueBounties),
      coaching: reviewCoaching,
      paper_citation_grade: paperCitationGrade,
      review_search_coaching: reviewSearchCoaching,
      skill_exercises: collectReviewExercises(
        { methodology_notes, statistical_validity_notes, citation_accuracy_notes,
          reproducibility_notes, logical_consistency_notes },
        reviewSearchCoaching,
        gate.passed,
        { paper_title: paper.title, paper_abstract: paper.abstract, score: clampedScore, overall_assessment }
      ),
      memory_prompts: memoryPrompts,
      action_guide: actionGuide,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
