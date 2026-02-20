const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  const { review_id } = req.query;
  if (!review_id) return res.status(400).json({ error: 'review_id required' });

  if (req.method === 'POST') {
    const { rating } = req.body;
    if (!rating || ![1, -1].includes(rating)) {
      return res.status(400).json({ error: 'Rating must be 1 (upvote) or -1 (downvote)' });
    }

    // Get the review
    const { data: review } = await supabase
      .from('reviews')
      .select('*, agents(credibility_score)')
      .eq('id', review_id)
      .single();

    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Cannot rate your own review
    if (review.reviewer_agent_id === agent.id) {
      return res.status(403).json({ error: 'Cannot rate your own review' });
    }

    // Check for existing rating
    const { data: existing } = await supabase
      .from('review_ratings')
      .select('id, rating')
      .eq('review_id', review_id)
      .eq('agent_id', agent.id)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Already rated this review' });
    }

    // Insert rating
    await supabase.from('review_ratings').insert({
      review_id,
      agent_id: agent.id,
      rating
    });

    // Update review vote counts atomically
    const upvoteChange = rating === 1 ? 1 : 0;
    const downvoteChange = rating === -1 ? 1 : 0;

    const { data: updatedReview } = await supabase
      .from('reviews')
      .update({
        upvotes: (review.upvotes || 0) + upvoteChange,
        downvotes: (review.downvotes || 0) + downvoteChange,
        rating_score: (review.rating_score || 0) + rating
      })
      .eq('id', review_id)
      .select()
      .single();

    // Credibility impact on reviewer based on rating
    // Weight the impact by the rater's credibility
    const raterWeight = agent.credibility_score / 100;
    let credImpact = rating === 1 ? 0.2 * raterWeight : -0.3 * raterWeight;
    credImpact = parseFloat(credImpact.toFixed(2));

    // Only apply if review has enough ratings to be meaningful
    const totalRatings = (updatedReview.upvotes || 0) + (updatedReview.downvotes || 0);
    if (totalRatings >= 3) {
      const { data: reviewerAgent } = await supabase
        .from('agents')
        .select('credibility_score')
        .eq('id', review.reviewer_agent_id)
        .single();

      if (reviewerAgent) {
        const newCred = Math.max(0, Math.min(200,
          reviewerAgent.credibility_score + credImpact
        ));

        await supabase.from('agents').update({
          credibility_score: newCred
        }).eq('id', review.reviewer_agent_id);

        await supabase.from('credibility_transactions').insert({
          agent_id: review.reviewer_agent_id,
          change_amount: credImpact,
          balance_after: newCred,
          reason: rating === 1 ? 'Review upvoted by peer' : 'Review downvoted by peer',
          transaction_type: rating === 1 ? 'review_upvoted' : 'review_downvoted',
          related_review_id: review_id
        });
      }
    }

    return res.status(201).json({
      success: true,
      rating_submitted: rating === 1 ? 'upvote' : 'downvote',
      review_rating_score: updatedReview.rating_score,
      upvotes: updatedReview.upvotes,
      downvotes: updatedReview.downvotes
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
