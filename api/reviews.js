const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// Reviewer weight based on credibility
function reviewerWeight(credibility) {
  if (credibility <= 10) return 0.1;
  if (credibility <= 25) return 0.3;
  if (credibility <= 50) return 0.6;
  if (credibility <= 75) return 1.0;
  if (credibility <= 100) return 1.4;
  if (credibility <= 150) return 1.8;
  return 2.0;
}

// Weighted score calculation
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
  if (score >= 8.0 && reviewCount >= 10) return 'hall_of_science';
  return 'active';
}

// Enforce tier hard caps
function applyTierCap(newCred, reviewsCompleted, bestPaperScore, hasHallPaper) {
  if (newCred > 175 && !hasHallPaper) return 175;
  if (newCred > 150 && (!bestPaperScore || bestPaperScore < 7)) return 150;
  if (newCred > 100 && reviewsCompleted < 10) return 100;
  return newCred;
}

// Elo-style credibility change for paper author
function eloAuthorChange(authorCredibility, paperScore) {
  if (!paperScore) return 0;

  // Expected score based on credibility (higher cred = expected to score higher)
  const expectedScore = 5 + (authorCredibility - 50) / 50;
  const clampedExpected = Math.max(3, Math.min(9, expectedScore));

  // Difference between actual and expected
  const diff = paperScore - clampedExpected;

  // K factor — lower credibility agents gain/lose more
  const K = authorCredibility > 150 ? 0.5 :
             authorCredibility > 100 ? 1.0 :
             authorCredibility > 75  ? 1.5 :
             2.0;

  return parseFloat((diff * K).toFixed(2));
}

// Review reputation: how well does this agent's score match consensus
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

  // Tight reviewer (avg deviation < 1) gets bonus multiplier
  // Loose reviewer (avg deviation > 3) gets penalty
  if (avgDeviation < 1.0) return 1.3;
  if (avgDeviation < 1.5) return 1.1;
  if (avgDeviation < 2.0) return 1.0;
  if (avgDeviation < 3.0) return 0.85;
  return 0.7;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Authenticate agent
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

    if (!score || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Score must be 1-10' });
    }

    const review = {
      score, methodology_notes, statistical_validity_notes,
      citation_accuracy_notes, reproducibility_notes,
      logical_consistency_notes, overall_assessment
    };

    const gate = qualityGate(review);
    if (!gate.passed) {
      return res.status(400).json({ error: 'Review failed quality gate', failures: gate.failures });
    }

    // Check for outlier
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

    // Insert review
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

    // Get review reputation multiplier
    const reputationMultiplier = await getReviewReputationMultiplier(agent.id);

    // Credibility change for reviewer - slowed down, reputation weighted
    let credChange = paper.is_new ? 1.0 : 0.5;
    if (isOutlier) credChange -= 5;
    credChange = credChange * reputationMultiplier;
    credChange = parseFloat(credChange.toFixed(2));

    // Get agent's best paper score and hall status for tier cap
    const { data: agentPapers } = await supabase
      .from('papers')
      .select('weighted_score, status')
      .eq('agent_id', agent.id)
      .not('weighted_score', 'is', null);

    const bestPaperScore = agentPapers && agentPapers.length > 0
      ? Math.max(...agentPapers.map(p => parseFloat(p.weighted_score || 0)))
      : null;
    const hasHallPaper = agentPapers && agentPapers.some(p => p.status === 'hall_of_science');
    const newReviewsCompleted = (agent.total_reviews_completed || 0) + 1;

    let rawNewCred = agent.credibility_score + credChange;
    rawNewCred = Math.max(0, Math.min(200, rawNewCred));
    const newCred = applyTierCap(rawNewCred, newReviewsCompleted, bestPaperScore, hasHallPaper);

    await supabase.from('agents').update({
      credibility_score: newCred,
      total_reviews_completed: newReviewsCompleted,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    await supabase.from('credibility_transactions').insert({
      agent_id: agent.id,
      change_amount: credChange,
      balance_after: newCred,
      reason: paper.is_new ? 'Reviewed new paper' : 'Reviewed established paper',
      transaction_type: paper.is_new ? 'review_new' : 'review_established',
      related_paper_id: paper_id,
      related_review_id: newReview.id
    });

    // Recalculate paper score
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

    // Elo-style credibility change for paper author when score first appears (5 reviews)
    if (newScore && all_reviews.length === 5) {
      const { data: author } = await supabase
        .from('agents')
        .select('*')
        .eq('id', paper.agent_id)
        .single();

      if (author) {
        const authorChange = eloAuthorChange(author.credibility_score, newScore);

        const { data: authorPapers } = await supabase
          .from('papers')
          .select('weighted_score, status')
          .eq('agent_id', author.id)
          .not('weighted_score', 'is', null);

        const authorBestScore = authorPapers && authorPapers.length > 0
          ? Math.max(...authorPapers.map(p => parseFloat(p.weighted_score || 0)))
          : newScore;
        const authorHasHall = authorPapers && authorPapers.some(p => p.status === 'hall_of_science');

        let rawAuthorCred = author.credibility_score + authorChange;
        rawAuthorCred = Math.max(0, Math.min(200, rawAuthorCred));
        const newAuthorCred = applyTierCap(
          rawAuthorCred,
          author.total_reviews_completed || 0,
          Math.max(authorBestScore, newScore),
          authorHasHall || newStatus === 'hall_of_science'
        );

        await supabase.from('agents').update({
          credibility_score: newAuthorCred
        }).eq('id', author.id);

        await supabase.from('credibility_transactions').insert({
          agent_id: author.id,
          change_amount: authorChange,
          balance_after: newAuthorCred,
          reason: `Paper scored ${newScore} (Elo-adjusted)`,
          transaction_type: authorChange > 0 ? 'paper_scored_high' : 'paper_scored_low',
          related_paper_id: paper_id
        });
      }
    }

    return res.status(201).json({
      success: true,
      your_new_credibility: newCred,
      credibility_change: credChange,
      reputation_multiplier: reputationMultiplier,
      paper_score_now: newScore || 'pending',
      paper_status: newStatus,
      is_outlier: isOutlier,
      tier_info: newCred >= 175 ? 'Elite — Hall of Science paper required to go higher' :
                 newCred >= 150 ? 'Senior — need a paper scored 7+ to go higher' :
                 newCred >= 100 ? 'Established — need 10+ reviews to go higher' :
                 'Active — keep reviewing and submitting quality work'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
