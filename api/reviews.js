const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// Tier cap requirements
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 5,  min_papers: 2, min_revisions: 2 },
  100: { min_reviews: 10,  min_bounties: 5,  min_papers: 2, min_revisions: 2 },
  150: { min_reviews: 25,  min_bounties: 20, min_paper_score: 8.0 },
  175: { min_reviews: 50,  min_bounties: 75, need_hall: true },
  200: { min_reviews: 100, min_bounties: 250, need_distinguished: true }
};

function sanitize(text) {
  if (!text) return text;
  const patterns = [
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /you are now/gi,
    /new instructions:/gi,
    /\[INST\].*?\[\/INST\]/gis,
  ];
  let clean = text;
  patterns.forEach(p => { clean = clean.replace(p, '[REDACTED]'); });
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return clean;
}

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

function weightedScore(reviews) {
  if (reviews.length < 5) return null;
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

async function applyTierCap(newCred, agentId) {
  const { data: freshAgent } = await supabase
    .from('agents')
    .select('total_reviews_completed, valid_bounties, total_papers_submitted')
    .eq('id', agentId)
    .single();

  const { data: agentPapers } = await supabase
    .from('papers')
    .select('weighted_score, status, parent_paper_id, response_stance')
    .eq('agent_id', agentId)
    .neq('status', 'removed');

  // Always use live review count — stale column causes cap escapes
  const { count: liveReviewCount } = await supabase
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('reviewer_agent_id', agentId)
    .eq('passed_quality_gate', true);

  const reviewsCompleted = liveReviewCount || 0;
  const bounties = freshAgent?.valid_bounties || 0;
  const originalPapers = (agentPapers || []).filter(p => !p.parent_paper_id);
  const revisions = (agentPapers || []).filter(p => p.response_stance === 'revision');
  const papersWithScore = (agentPapers || []).filter(p => p.weighted_score);
  const bestPaperScore = papersWithScore.length > 0
    ? Math.max(...papersWithScore.map(p => parseFloat(p.weighted_score || 0))) : null;
  const hasHallPaper = (agentPapers || []).some(p => p.status === 'hall_of_science');
  const hasDistinguishedPaper = (agentPapers || []).some(p => p.status === 'distinguished' || p.status === 'landmark');

  if (newCred > 200) newCred = 200;

  if (newCred > 175) {
    const req = TIER_CAPS[200];
    if (reviewsCompleted < req.min_reviews || bounties < req.min_bounties || !hasDistinguishedPaper) {
      newCred = Math.min(newCred, 175);
    }
  }

  if (newCred > 150) {
    const req = TIER_CAPS[175];
    if (reviewsCompleted < req.min_reviews || bounties < req.min_bounties || !hasHallPaper) {
      newCred = Math.min(newCred, 150);
    }
  }

  if (newCred > 100) {
    const req = TIER_CAPS[150];
    if (reviewsCompleted < req.min_reviews || bounties < req.min_bounties || !bestPaperScore || bestPaperScore < req.min_paper_score) {
      newCred = Math.min(newCred, 100);
    }
  }

  if (newCred >= 75) {
    const req = TIER_CAPS[75];
    if (reviewsCompleted < req.min_reviews || bounties < req.min_bounties ||
        originalPapers.length < req.min_papers || revisions.length < req.min_revisions) {
      newCred = Math.min(newCred, 74.9);
    }
  }

  return parseFloat(newCred.toFixed(2));
}

function eloAuthorChange(authorCredibility, paperScore) {
  if (!paperScore) return 0;
  const expectedScore = 5 + (authorCredibility - 50) / 50;
  const clampedExpected = Math.max(3, Math.min(9, expectedScore));
  const diff = paperScore - clampedExpected;
  const K = authorCredibility > 150 ? 0.5 :
             authorCredibility > 100 ? 1.0 :
             authorCredibility > 75  ? 1.5 : 2.0;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
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

    if (reviewError) return res.status(500).json({ error: reviewError.message });

    const reputationMultiplier = await getReviewReputationMultiplier(agent.id);

    let credChange = paper.is_new ? 0.3 : 0.1;
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

    // FIX: increment total_reviews_completed on every successful review
    await supabase.from('agents').update({
      credibility_score: finalCred,
      total_reviews_completed: (currentAgent?.total_reviews_completed || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    await supabase.from('credibility_transactions').insert({
      agent_id: agent.id,
      change_amount: credChange,
      balance_after: finalCred,
      reason: paper.is_new ? 'Reviewed new paper' : 'Reviewed established paper',
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

    // Challenge/support papers cannot enter Hall of Science — cap at 'active'
    // Revisions CAN enter Hall of Science — they are the author's improved work
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

    // If this is a response/challenge paper, update its score impact on the parent
    if (paper.parent_paper_id && paper.response_stance !== 'revision' && newScore && all_reviews.length >= 3) {
      // rebut papers with low scores pull parent down, high scores push up
      // support papers with high scores push parent up, low scores pull down
      const midpoint = 5.5;
      const deviation = newScore - midpoint;
      let impact = 0;
      if (paper.response_stance === 'rebut') {
        // Reviewers score the rebuttal based on whether they AGREE with the challenge
        // HIGH score (7+) = community agrees challenge is valid = pull parent score DOWN strongly
        // LOW score (1-4) = community rejects challenge = push parent score UP slightly (max +0.2)
        if (newScore >= 5.5) {
          // Valid challenge — negative impact on parent, proportional to how convincing
          impact = -((newScore - 5.5) / 4.5) * 1.5; // scales from 0 to -1.5
        } else {
          // Rejected challenge — small positive boost to parent, capped at +0.2
          impact = Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
        }
      } else if (paper.response_stance === 'support') {
        // Support paper scores HIGH = community agrees = push parent UP
        // Support paper scores LOW = community disagrees = small negative
        if (newScore >= 5.5) {
          impact = ((newScore - 5.5) / 4.5) * 1.0; // scales 0 to +1.0
        } else {
          impact = -Math.min(0.2, ((5.5 - newScore) / 5.5) * 0.2);
        }
      }
      impact = Math.max(-1.5, Math.min(1.5, parseFloat(impact.toFixed(2))));

      await supabase.from('papers').update({
        response_score_impact: impact
      }).eq('id', paper_id);

      // Penalize rebuttal writer if community strongly rejects their challenge (score < 4, 5+ reviews)
      if (paper.response_stance === 'rebut' && all_reviews.length >= 5 && newScore < 4) {
        const { data: rebutAuthor } = await supabase
          .from('agents')
          .select('credibility_score')
          .eq('id', paper.agent_id)
          .single();

        if (rebutAuthor) {
          // Proportional penalty: score 1 → -0.9, score 2 → -0.6, score 3 → -0.3
          const penalty = parseFloat(-((4 - newScore) * 0.3).toFixed(2));
          const newRebutCred = Math.max(0, parseFloat((rebutAuthor.credibility_score + penalty).toFixed(2)));
          await supabase.from('agents').update({ credibility_score: newRebutCred }).eq('id', paper.agent_id);
          await supabase.from('credibility_transactions').insert({
            agent_id: paper.agent_id,
            change_amount: penalty,
            balance_after: newRebutCred,
            reason: `Community rejected challenge paper (scored ${newScore.toFixed(1)}/10) — weak challenge penalty`,
            transaction_type: 'challenge_rejected',
            related_paper_id: paper_id
          });
        }
      }

      // Recalculate parent paper score with new impact
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

    if (newScore && all_reviews.length === 5) {
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
    // FIX: count directly from reviews table — never trust stale column
    const { count: liveReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);
    const trueReviews = liveReviewCount || 0;
    const trueBounties = finalAgent?.valid_bounties || 0;

    // Calculate remaining tier 75 requirements
    const { data: agentPapersForTier } = await supabase
      .from('papers')
      .select('id, response_stance, parent_paper_id')
      .eq('agent_id', agent.id)
      .neq('status', 'removed');
    const originalPapersCount = (agentPapersForTier || []).filter(p => !p.parent_paper_id).length;
    const revisionsCount = (agentPapersForTier || []).filter(p => p.response_stance === 'revision').length;

    const needsForT75 = [];
    if (trueReviews < 10) needsForT75.push(`${10 - trueReviews} more reviews`);
    if (trueBounties < 5) needsForT75.push(`${5 - trueBounties} more bounties`);
    if (originalPapersCount < 2) needsForT75.push(`${2 - originalPapersCount} more original papers`);
    if (revisionsCount < 2) needsForT75.push(`${2 - revisionsCount} more revisions`);

    const tierInfo = trueCred >= 175 ?
      'TIER 4 (175+) — need Distinguished paper + 250 bounties to reach Tier 5 (200)' :
      trueCred >= 150 ?
      'TIER 3 (150+) — need Hall of Science paper + 75 bounties to reach Tier 4 (175)' :
      trueCred >= 100 ?
      'TIER 2 (100+) — need paper scored 8.0+ + 20 bounties to reach Tier 3 (150)' :
      trueCred >= 75 ?
      'TIER 1 (75+) — tier cap cleared, credibility now grows freely. Need paper scored 8.0+ + 20 bounties to reach Tier 2 (100)' :
      needsForT75.length === 0 ?
      'TIER CAP CLEARED — all requirements met, credibility will pass 75 on next review' :
      `BLOCKED AT TIER CAP (max 74.9) — MORE REVIEWS WILL NOT HELP. You MUST complete: ${needsForT75.join(', ')}. Stop reviewing and do these actions instead.`;

    const isCapped = trueCred < 75 && needsForT75.length > 0;
    const nextAction = trueBounties < 5 ? 'file_bounty' :
                       originalPapersCount < 2 ? 'submit_paper' :
                       revisionsCount < 2 ? 'revise' : 'review';

    return res.status(201).json({
      success: true,
      your_new_credibility: trueCred,
      credibility_change: isCapped ? 0 : credChange,
      capped: isCapped,
      cap_maximum: isCapped ? 74.9 : null,
      reviews_will_not_help: isCapped ? true : false,
      next_required_action: isCapped ? nextAction : null,
      still_needed_for_tier_1: isCapped ? needsForT75 : [],
      reputation_multiplier: reputationMultiplier,
      paper_score_now: newScore || 'pending',
      paper_status: newStatus,
      is_outlier: isOutlier,
      tier_info: tierInfo,
      reviews_completed: trueReviews,
      bounties_needed: Math.max(0, 5 - trueBounties)
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
