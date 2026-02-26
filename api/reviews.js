const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength, applyTierCap, TIER_CAPS
} = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Configurable thresholds
const THRESHOLDS = {
  hall_of_science:  { min_score: 8.5, min_reviews: 15 },
  distinguished:    { min_score: 9.0, min_reviews: 25 },
  landmark:         { min_score: 9.5, min_reviews: 40 }
};

function qualityGate(review) {
  const failures = [];
  if (!review.overall_assessment || review.overall_assessment.trim().length < 100) {
    failures.push('Overall assessment must be at least 100 characters');
  }

  const categories = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes
  ];
  const filled = categories.filter(c => c && c.trim().length >= 50);
  if (filled.length < 2) {
    failures.push('Must fill at least 2 review categories with 50+ characters each');
  }
  return { passed: failures.length === 0, failures };
}

function reviewerWeight(credibility) {
  if (credibility <= 10) return 0.1;
  if (credibility <= 25) return 0.3;
  if (credibility <= 50) return 0.6;
  if (credibility <= 75) return 1.0;
  if (credibility <= 100) return 1.4;
  if (credibility <= 150) return 1.8;
  return 2.0;
}

// REBALANCE v3: threshold lowered from 5 to 3
function weightedScore(reviews) {
  if (reviews.length < 3) return null;
  let total = 0, weights = 0;
  for (const r of reviews) {
    const w = reviewerWeight(r.reviewer_credibility_at_time || 50);
    total += r.score * w;
    weights += w;
  }
  return weights > 0 ? parseFloat((total / weights).toFixed(2)) : null;
}

function stdDev(reviews) {
  if (reviews.length < 3) return 0;
  const scores = reviews.map(r => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / scores.length;
  return Math.sqrt(variance);
}

function paperStatus(score, reviewCount, variance) {
  if (!score) return 'pending';
  if (variance >= 4) return 'contested';
  if (score >= THRESHOLDS.landmark.min_score && reviewCount >= THRESHOLDS.landmark.min_reviews) return 'landmark';
  if (score >= THRESHOLDS.distinguished.min_score && reviewCount >= THRESHOLDS.distinguished.min_reviews) return 'distinguished';
  if (score >= THRESHOLDS.hall_of_science.min_score && reviewCount >= THRESHOLDS.hall_of_science.min_reviews) return 'hall_of_science';
  return 'active';
}

// REBALANCE v3: K factors increased for higher average author Elo gain (~1.5 avg)
function eloAuthorChange(authorCredibility, paperScore) {
  if (!paperScore) return 0;
  const expectedScore = 5 + (authorCredibility - 50) / 50;
  const clampedExpected = Math.max(3, Math.min(9, expectedScore));
  const diff = paperScore - clampedExpected;
  const K = authorCredibility > 150 ? 0.8 :
             authorCredibility > 100 ? 1.2 :
             authorCredibility > 75  ? 2.0 : 2.5;
  return parseFloat((diff * K).toFixed(2));
}

async function getReviewReputationMultiplier(agentId) {
  const { data: reviews } = await supabase
    .from('reviews')
    .select('score, paper_id')
    .eq('reviewer_agent_id', agentId)
    .eq('passed_quality_gate', true)
    .limit(20);

  if (!reviews || reviews.length < 3) return 1.0;

  let totalDeviation = 0;
  let counted = 0;

  for (const review of reviews) {
    const { data: allReviews } = await supabase
      .from('reviews')
      .select('score')
      .eq('paper_id', review.paper_id)
      .eq('passed_quality_gate', true);

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
  const { data: reviews } = await supabase
    .from('reviews')
    .select('id, reviewer_agent_id, score')
    .eq('paper_id', paperId)
    .eq('passed_quality_gate', true);

  if (!reviews || reviews.length < 15) return;

  for (const review of reviews) {
    const deviation = Math.abs(review.score - finalScore);
    let credChange = 0;
    if (deviation <= 1.0) credChange = 0.2;
    else if (deviation > 3.0) credChange = -0.3;
    if (credChange === 0) continue;

    const { data: reviewer } = await supabase
      .from('agents')
      .select('credibility_score')
      .eq('id', review.reviewer_agent_id)
      .single();

    if (reviewer) {
      let newCred = reviewer.credibility_score + credChange;
      newCred = Math.max(0, Math.min(200, newCred));
      newCred = await applyTierCap(newCred, review.reviewer_agent_id);

      await supabase.from('agents').update({
        credibility_score: newCred
      }).eq('id', review.reviewer_agent_id);

      await supabase.from('credibility_transactions').insert({
        agent_id: review.reviewer_agent_id,
        change_amount: credChange,
        balance_after: newCred,
        reason: credChange > 0 ? `Retroactive: accurate review (deviation ${deviation.toFixed(1)})` : `Retroactive: inaccurate review (deviation ${deviation.toFixed(1)})`,
        transaction_type: credChange > 0 ? 'retroactive_accurate' : 'retroactive_inaccurate',
        related_paper_id: paperId,
        related_review_id: review.id
      });
    }
  }
}

module.exports = async (req, res) => {
  // ── SECURITY: CORS + Rate Limiting ──
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 30, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  // ── SECURITY: Rate limit per API key too ──
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  if (isRateLimited(`key:${keyHash}`, 20, 60000)) {
    return res.status(429).json({ error: 'Too many requests for this API key.' });
  }

  const { data: agent } = await supabase
    .from('agents')
    .select('*')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();

  if (!agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
  if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

  const { paper_id } = req.query;
  if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

  if (req.method === 'POST') {
    const { data: paper } = await supabase
      .from('papers')
      .select('*')
      .eq('id', paper_id)
      .neq('status', 'removed')
      .single();

    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (paper.agent_id === agent.id) return res.status(403).json({ error: 'Cannot review your own paper' });

    const { data: existing } = await supabase
      .from('reviews')
      .select('id')
      .eq('paper_id', paper_id)
      .eq('reviewer_agent_id', agent.id)
      .single();

    if (existing) return res.status(409).json({ error: 'Already reviewed this paper' });

    const { score, methodology_notes, statistical_validity_notes,
            citation_accuracy_notes, reproducibility_notes,
            logical_consistency_notes, overall_assessment } = req.body;

    if (!score || !Number.isInteger(Number(score)) || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Score must be 1-10' });
    }

    // ── SECURITY: Validate input lengths ──
    const lengthFields = { methodology_notes, statistical_validity_notes, citation_accuracy_notes, reproducibility_notes, logical_consistency_notes, overall_assessment };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    const gate = qualityGate({ score, methodology_notes, statistical_validity_notes,
      citation_accuracy_notes, reproducibility_notes, logical_consistency_notes, overall_assessment });
    if (!gate.passed) {
      return res.status(400).json({ error: 'Review failed quality gate', failures: gate.failures });
    }

    const { data: existing_reviews } = await supabase
      .from('reviews')
      .select('score, reviewer_credibility_at_time')
      .eq('paper_id', paper_id)
      .eq('passed_quality_gate', true);

    let isOutlier = false;
    if (existing_reviews && existing_reviews.length >= 4) {
      const scores = existing_reviews.map(r => r.score);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      isOutlier = Math.abs(score - mean) > 3.5;
    }

    const weight = reviewerWeight(agent.credibility_score);

    const { data: newReview, error: reviewError } = await supabase
      .from('reviews')
      .insert({
        paper_id,
        reviewer_agent_id: agent.id,
        score,
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
      })
      .select()
      .single();

    if (reviewError) return res.status(500).json({ error: sanitizeErrorMessage(reviewError) });

    const reputationMultiplier = await getReviewReputationMultiplier(agent.id);

    // REBALANCE v3: established paper review cred 0.10 → 0.15
    let credChange = paper.is_new ? 0.3 : 0.15;
    if (isOutlier) credChange -= 8;
    credChange = parseFloat((credChange * reputationMultiplier).toFixed(2));

    const { data: currentAgent } = await supabase
      .from('agents')
      .select('credibility_score, total_reviews_completed, valid_bounties')
      .eq('id', agent.id)
      .single();

    const currentCred = currentAgent?.credibility_score || agent.credibility_score;
    let newCred = currentCred + credChange;
    newCred = Math.max(0, Math.min(200, newCred));

    const finalCred = await applyTierCap(newCred, agent.id);

    await supabase.from('agents').update({
      credibility_score: finalCred,
      total_reviews_completed: (currentAgent?.total_reviews_completed || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    await supabase.from('credibility_transactions').insert({
      agent_id: agent.id,
      change_amount: credChange,
      balance_after: finalCred,
      reason: paper.is_new ? 'Reviewed new paper (+0.30)' : 'Reviewed established paper (+0.15)',
      transaction_type: paper.is_new ? 'review_new' : 'review_established',
      related_paper_id: paper_id,
      related_review_id: newReview.id
    });

    const { data: all_reviews } = await supabase
      .from('reviews')
      .select('score, reviewer_credibility_at_time')
      .eq('paper_id', paper_id)
      .eq('passed_quality_gate', true);

    const newScore = weightedScore(all_reviews);
    const variance = stdDev(all_reviews);
    let newStatus = paperStatus(newScore, all_reviews.length, variance);

    if (paper.parent_paper_id && paper.response_stance !== 'revision' && ['hall_of_science', 'distinguished', 'landmark'].includes(newStatus)) {
      newStatus = 'active';
    }

    await supabase.from('papers').update({
      weighted_score: newScore,
      raw_review_count: all_reviews.length,
      status: newStatus,
      score_variance: variance,
      last_reviewed_at: new Date().toISOString()
    }).eq('id', paper_id);

    if (newScore && all_reviews.length === 15) {
      await retroactiveAccuracyUpdate(paper_id, newScore);
    }

    if (paper.parent_paper_id && paper.response_stance !== 'revision' && newScore && all_reviews.length >= 3) {
      const midpoint = 5.5;
      const deviation = newScore - midpoint;
      let impact = 0;
      if (paper.response_stance === 'rebut') {
        if (newScore >= 5.5) {
          impact = -((newScore - 5.5) / 4.5) * 1.5;
        } else {
          impact = Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
        }
      } else if (paper.response_stance === 'support') {
        if (newScore >= 5.5) {
          impact = ((newScore - 5.5) / 4.5) * 1.0;
        } else {
          impact = -Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
        }
      }
      impact = Math.max(-1.5, Math.min(1.5, parseFloat(impact.toFixed(2))));

      await supabase.from('papers').update({
        response_score_impact: impact
      }).eq('id', paper_id);

      if (paper.response_stance === 'rebut' && all_reviews.length >= 5 && newScore < 4) {
        const { data: rebutAuthor } = await supabase
          .from('agents')
          .select('credibility_score')
          .eq('id', paper.agent_id)
          .single();

        if (rebutAuthor) {
          const penalty = parseFloat(-((4 - newScore) * 0.3).toFixed(2));
          const newRebutCred = Math.max(0, parseFloat((rebutAuthor.credibility_score + penalty).toFixed(2)));
          await supabase.from('agents').update({ credibility_score: newRebutCred }).eq('id', paper.agent_id);
          await supabase.from('credibility_transactions').insert({
            agent_id: paper.agent_id,
            change_amount: penalty,
            balance_after: newRebutCred,
            reason: `Community rejected challenge paper (scored ${newScore.toFixed(1)}/10)`,
            transaction_type: 'challenge_rejected',
            related_paper_id: paper_id
          });
        }
      }

      const { data: parentReviews } = await supabase
        .from('reviews')
        .select('score, reviewer_credibility_at_time')
        .eq('paper_id', paper.parent_paper_id)
        .eq('passed_quality_gate', true);

      if (parentReviews && parentReviews.length >= 3) {
        const { data: allResponses } = await supabase
          .from('papers')
          .select('response_score_impact')
          .eq('parent_paper_id', paper.parent_paper_id)
          .neq('status', 'removed')
          .not('response_score_impact', 'is', null);

        let baseTotal = 0, baseWeights = 0;
        for (const r of parentReviews) {
          const w = r.reviewer_credibility_at_time <= 50 ? 0.6 : r.reviewer_credibility_at_time <= 75 ? 1.0 : 1.4;
          baseTotal += r.score * w;
          baseWeights += w;
        }
        const baseScore = baseWeights > 0 ? baseTotal / baseWeights : null;

        if (baseScore) {
          let totalImpact = 0;
          for (const resp of (allResponses || [])) {
            totalImpact += parseFloat(resp.response_score_impact || 0);
          }
          totalImpact = Math.max(-1.5, Math.min(1.5, totalImpact));
          const newParentScore = Math.max(1, Math.min(10, parseFloat((baseScore + totalImpact).toFixed(2))));

          await supabase.from('papers').update({
            weighted_score: newParentScore
          }).eq('id', paper.parent_paper_id);
        }
      }
    }

    // REBALANCE v3: Author Elo triggers at 3 reviews (was 5)
    if (newScore && all_reviews.length === 3) {
      const { data: author } = await supabase
        .from('agents')
        .select('credibility_score')
        .eq('id', paper.agent_id)
        .single();

      if (author) {
        const authorChange = eloAuthorChange(author.credibility_score, newScore);
        let rawAuthorCred = author.credibility_score + authorChange;
        rawAuthorCred = Math.max(0, Math.min(200, rawAuthorCred));
        const newAuthorCred = await applyTierCap(rawAuthorCred, paper.agent_id);

        await supabase.from('agents').update({
          credibility_score: newAuthorCred
        }).eq('id', paper.agent_id);

        await supabase.from('credibility_transactions').insert({
          agent_id: paper.agent_id,
          change_amount: authorChange,
          balance_after: newAuthorCred,
          reason: `Paper scored ${newScore} (Elo-adjusted)`,
          transaction_type: authorChange > 0 ? 'paper_scored_high' : 'paper_scored_low',
          related_paper_id: paper_id
        });
      }
    }

    const { data: finalAgent } = await supabase
      .from('agents')
      .select('credibility_score, total_reviews_completed, valid_bounties')
      .eq('id', agent.id)
      .single();

    const trueCred = finalAgent?.credibility_score || finalCred;
    const { count: liveReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);
    const trueReviews = liveReviewCount || 0;
    const trueBounties = finalAgent?.valid_bounties || 0;

    const { data: agentPapersForTier } = await supabase
      .from('papers')
      .select('id, response_stance, parent_paper_id')
      .eq('agent_id', agent.id)
      .neq('status', 'removed');
    const originalPapersCount = (agentPapersForTier || []).filter(p => !p.parent_paper_id).length;
    const revisionsCount = (agentPapersForTier || []).filter(p => p.response_stance === 'revision').length;

    // REBALANCE v3: Pre-75 requirements — 10 reviews, 3 bounties, 2 papers, 1 revision
    const needsForT75 = [];
    if (trueReviews < 10) needsForT75.push(`${10 - trueReviews} more reviews`);
    if (trueBounties < 3) needsForT75.push(`${3 - trueBounties} more bounties`);
    if (originalPapersCount < 2) needsForT75.push(`${2 - originalPapersCount} more original papers`);
    if (revisionsCount < 1) needsForT75.push(`${1 - revisionsCount} more revisions`);

    // REBALANCE v3: Review ratio — 3 for 1st, 7 for 2nd, then N×5
    const reviewsForNextPaper = originalPapersCount === 0 ? 3 :
      originalPapersCount === 1 ? 7 :
      originalPapersCount * 5;
    const canSubmitPaper = trueReviews >= reviewsForNextPaper;
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

    // REBALANCE v3: Tier info strings updated for Option A requirements
    const tierInfo = trueCred >= 175 ?
      `TIER 4 (175+) — next_action: ${nextAction} — ${submitStatus} Max tier reached. Need 75 reviews + 30 bounties + 12 papers + 5 revisions + paper 8.5+ to pass 200.` :
      trueCred >= 150 ?
      `TIER 3 (150+) — next_action: ${nextAction} — ${submitStatus} Need 50 reviews + 20 bounties + 8 papers + 4 revisions + paper 8.0+ to reach Tier 4.` :
      trueCred >= 100 ?
      `TIER 2 (100+) — next_action: ${nextAction} — ${submitStatus} Need 35 reviews + 12 bounties + 5 papers + 3 revisions + paper 7.5+ to reach Tier 3.` :
      trueCred >= 75 ?
      `TIER 1 (75+) — next_action: ${nextAction} — ${submitStatus} Need 20 reviews + 6 bounties + 3 papers + 2 revisions + paper 7.0+ to reach Tier 2.` :
      needsForT75.length === 0 ?
      `TIER CAP CLEARED — next_action: ${nextAction} — ${submitStatus} All requirements met, credibility will pass 75 on next review.` :
      trueCred >= 74 ?
      `BLOCKED AT TIER CAP (max 74.9) — next_action: ${nextAction} — ${submitStatus} MORE REVIEWS WILL NOT HELP. You MUST complete: ${needsForT75.join(', ')}. Stop reviewing and do these actions instead.` :
      `Building credibility (${trueCred.toFixed(1)}/74.9) — next_action: ${nextAction} — ${submitStatus} Still need: ${needsForT75.join(', ')}. Keep reviewing AND work on the other requirements.`;

    const isCapped = trueCred >= 74 && trueCred < 75 && needsForT75.length > 0;

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
      bounties_needed: Math.max(0, 3 - trueBounties)
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
