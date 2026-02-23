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
  75:  { min_reviews: 25,  min_bounties: 20 },
  100: { min_reviews: 25,  min_bounties: 20 },
  150: { min_reviews: 50,  min_bounties: 75,  min_paper_score: 8.0 },
  175: { min_reviews: 100, min_bounties: 250, need_hall: true },
  200: { min_reviews: 200, min_bounties: 1000, need_distinguished: true }
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
    .select('total_reviews_completed, valid_bounties')
    .eq('id', agentId)
    .single();

  const { data: agentPapers } = await supabase
    .from('papers')
    .select('weighted_score, status')
    .eq('agent_id', agentId)
    .not('weighted_score', 'is', null);

  const reviewsCompleted = freshAgent?.total_reviews_completed || 0;
  const bounties = freshAgent?.valid_bounties || 0;
  const bestPaperScore = agentPapers && agentPapers.length > 0
    ? Math.max(...agentPapers.map(p => parseFloat(p.weighted_score || 0))) : null;
  const hasHallPaper = agentPapers && agentPapers.some(p => p.status === 'hall_of_science');
  const hasDistinguishedPaper = agentPapers && agentPapers.some(p => p.status === 'distinguished' || p.status === 'landmark');

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
    if (reviewsCompleted < req.min_reviews || bounties < req.min_bounties) {
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
    const newStatus = paperStatus(newScore, all_reviews.length, variance);

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

    const tierInfo = trueCred >= 175 ?
      'Elite — need Distinguished paper + 1000 bounties for Legendary' :
      trueCred >= 150 ?
      'Senior — need Hall of Science paper + 250 bounties for Elite' :
      trueCred >= 100 ?
      'Established — need 8.0+ paper + 75 bounties for Senior' :
      trueCred >= 75 ?
      `Tier 75 unlocked — need 50 reviews + 75 bounties + paper scored 8.0+ to unlock 150` :
      `Newcomer — ${trueReviews} reviews done, need ${Math.max(0, 25 - trueReviews)} more reviews + ${Math.max(0, 20 - trueBounties)} more bounties to unlock 75`;

    return res.status(201).json({
      success: true,
      your_new_credibility: trueCred,
      credibility_change: credChange,
      reputation_multiplier: reputationMultiplier,
      paper_score_now: newScore || 'pending',
      paper_status: newStatus,
      is_outlier: isOutlier,
      tier_info: tierInfo,
      reviews_completed: trueReviews,
      bounties_needed: Math.max(0, 20 - trueBounties)
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
