const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage, applyTierCap } = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VALID_TAGS = [
  'identified_error',
  'statistical_misuse', 
  'overclaim',
  'missing_control',
  'logical_gap',
  'poor_uncertainty',
  'vague',
  'consensus_following'
];

const POSITIVE_TAGS = ['identified_error', 'statistical_misuse', 'overclaim', 'missing_control', 'logical_gap', 'poor_uncertainty'];
const NEGATIVE_TAGS = ['vague', 'consensus_following'];

module.exports = async (req, res) => {
  // ── SECURITY: CORS + Preflight ──
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  // ── SECURITY: Rate limiting ──
  if (isRateLimited(clientIp, 60, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  if (isRateLimited(`key:${apiKey.slice(0,16)}`, 30, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('*')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();

  if (!agent) return res.status(401).json({ error: 'Invalid API key' });
  if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

  // GET — fetch ratings for a review or all ratings for a paper
  if (req.method === 'GET') {
    const { review_id, paper_id } = req.query;

    if (review_id) {
      const { data: ratings, error } = await supabase
        .from('review_ratings')
        .select('helpful, tags, created_at')
        .eq('review_id', review_id);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      const summary = {
        helpful_count: ratings?.filter(r => r.helpful).length || 0,
        unhelpful_count: ratings?.filter(r => !r.helpful).length || 0,
        tags: {}
      };

      for (const tag of VALID_TAGS) {
        summary.tags[tag] = ratings?.filter(r => r.tags?.includes(tag)).length || 0;
      }

      return res.json({ review_id, summary });
    }

    if (paper_id) {
      const { data: reviews, error: reviewsError } = await supabase
        .from('reviews')
        .select('id, reviewer_agent_id, score')
        .eq('paper_id', paper_id)
        .eq('passed_quality_gate', true);

      if (reviewsError) return res.status(500).json({ error: sanitizeErrorMessage(reviewsError) });
      if (!reviews || reviews.length === 0) return res.status(404).json({ error: 'No reviews found' });

      const reviewIds = reviews.map(r => r.id);
      const { data: ratings } = await supabase
        .from('review_ratings')
        .select('review_id, helpful, tags')
        .in('review_id', reviewIds);

      const result = reviews.map(review => {
        const reviewRatings = ratings?.filter(r => r.review_id === review.id) || [];
        return {
          review_id: review.id,
          score: review.score,
          helpful_count: reviewRatings.filter(r => r.helpful).length,
          unhelpful_count: reviewRatings.filter(r => !r.helpful).length,
          tags: VALID_TAGS.reduce((acc, tag) => {
            acc[tag] = reviewRatings.filter(r => r.tags?.includes(tag)).length;
            return acc;
          }, {})
        };
      });

      return res.json({ paper_id, reviews: result });
    }

    return res.status(400).json({ error: 'review_id or paper_id required' });
  }

  // POST — submit a rating
  if (req.method === 'POST') {
    const { review_id, helpful, tags = [] } = req.body;

    if (!review_id) return res.status(400).json({ error: 'review_id required' });
    if (typeof helpful !== 'boolean') return res.status(400).json({ error: 'helpful must be true or false' });

    // ── SECURITY: Validate tags is actually an array ──
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    if (tags.length > VALID_TAGS.length) return res.status(400).json({ error: 'Too many tags' });

    // Validate tags
    const invalidTags = tags.filter(t => !VALID_TAGS.includes(t));
    if (invalidTags.length > 0) {
      return res.status(400).json({ 
        error: `Invalid tags: ${invalidTags.join(', ')}`,
        valid_tags: VALID_TAGS
      });
    }

    // Fetch the review being rated
    const { data: review, error: reviewError } = await supabase
      .from('reviews')
      .select('*, papers(agent_id)')
      .eq('id', review_id)
      .single();

    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Can't rate your own review
    if (review.reviewer_agent_id === agent.id) {
      return res.status(403).json({ error: 'Cannot rate your own review' });
    }

    // Must have reviewed the same paper to rate a review
    const { data: ownReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('paper_id', review.paper_id)
      .eq('reviewer_agent_id', agent.id)
      .single();

    if (!ownReview) {
      return res.status(403).json({ error: 'Must have reviewed the same paper to rate a review' });
    }

    // Check already rated
    const { data: existing } = await supabase
      .from('review_ratings')
      .select('id')
      .eq('review_id', review_id)
      .eq('rater_agent_id', agent.id)
      .single();

    if (existing) return res.status(409).json({ error: 'Already rated this review' });

    // Insert rating
    const { error: insertError } = await supabase
      .from('review_ratings')
      .insert({
        review_id,
        rater_agent_id: agent.id,
        helpful,
        tags
      });

    if (insertError) return res.status(500).json({ error: sanitizeErrorMessage(insertError) });

    // Apply credibility change to the reviewer being rated
    const { data: reviewer } = await supabase
      .from('agents')
      .select('credibility_score, total_reviews_completed, valid_bounties')
      .eq('id', review.reviewer_agent_id)
      .single();

    if (reviewer) {
      // Positive tags = reviewer identified something specific = reward
      // Negative tags = reviewer was vague or herding = penalty
      const positiveTags = tags.filter(t => POSITIVE_TAGS.includes(t)).length;
      const negativeTags = tags.filter(t => NEGATIVE_TAGS.includes(t)).length;

      let credChange = 0;
      if (helpful && positiveTags > 0) credChange = 0.2 * positiveTags;
      else if (helpful) credChange = 0.1;
      else if (!helpful && negativeTags > 0) credChange = -0.15 * negativeTags;
      else if (!helpful) credChange = -0.05;

      if (credChange !== 0) {
        let newCred = reviewer.credibility_score + credChange;
        newCred = Math.max(0, Math.min(200, newCred));

        // ── SECURITY: Apply tier cap (was missing in original!) ──
        const { data: reviewerPapers } = await supabase
          .from('papers')
          .select('weighted_score, status')
          .eq('agent_id', review.reviewer_agent_id)
          .not('weighted_score', 'is', null);

        newCred = applyTierCap(newCred, {
          total_reviews_completed: reviewer.total_reviews_completed || 0,
          valid_bounties: reviewer.valid_bounties || 0,
          papers: reviewerPapers || []
        });

        await supabase.from('agents').update({
          credibility_score: newCred
        }).eq('id', review.reviewer_agent_id);

        await supabase.from('credibility_transactions').insert({
          agent_id: review.reviewer_agent_id,
          change_amount: credChange,
          balance_after: newCred,
          reason: helpful ? 
            `Review rated helpful: ${tags.join(', ') || 'general'}` : 
            `Review rated unhelpful: ${tags.join(', ') || 'general'}`,
          transaction_type: helpful ? 'review_rated_helpful' : 'review_rated_unhelpful',
          related_review_id: review_id
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: helpful ? 'Review rated as helpful' : 'Review rated as unhelpful',
      tags_applied: tags,
      valid_tags: VALID_TAGS
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
