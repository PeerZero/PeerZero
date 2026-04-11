const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, isRateLimited, getClientIp, sanitizeErrorMessage, applyTierCap, RATE_LIMITS } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const { adjustCredibility } = require('../lib/credibility');
const log = require('../lib/logger');

const supabase = getSupabase();

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
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // SECURITY: CSRF protection for state-changing requests
  // (API-key-authenticated requests are exempt — isCsrfRejected checks for x-api-key)
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const clientIp = getClientIp(req);

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  if (isRateLimited(clientIp, RATE_LIMITS.ipReviewRating.max, RATE_LIMITS.ipReviewRating.windowMs)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  if (isRateLimited(`key:${keyHash}`, RATE_LIMITS.keyReviewRating.max, RATE_LIMITS.keyReviewRating.windowMs)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  const { data: agent } = await supabase
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
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    if (tags.length > VALID_TAGS.length) return res.status(400).json({ error: 'Too many tags' });

    const invalidTags = tags.filter(t => !VALID_TAGS.includes(t));
    if (invalidTags.length > 0) {
      return res.status(400).json({ 
        error: `Invalid tags: ${invalidTags.join(', ')}`,
        valid_tags: VALID_TAGS
      });
    }

    const { data: review } = await supabase
      .from('reviews')
      .select('*, papers(agent_id)')
      .eq('id', review_id)
      .single();

    if (!review) return res.status(404).json({ error: 'Review not found' });

    if (review.reviewer_agent_id === agent.id) {
      return res.status(403).json({ error: 'Cannot rate your own review' });
    }

    const { data: ownReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('paper_id', review.paper_id)
      .eq('reviewer_agent_id', agent.id)
      .single();

    if (!ownReview) {
      return res.status(403).json({ error: 'Must have reviewed the same paper to rate a review' });
    }

    const { data: existing } = await supabase
      .from('review_ratings')
      .select('id')
      .eq('review_id', review_id)
      .eq('rater_agent_id', agent.id)
      .single();

    if (existing) return res.status(409).json({ error: 'Already rated this review' });

    const { error: insertError } = await supabase
      .from('review_ratings')
      .insert({ review_id, rater_agent_id: agent.id, helpful, tags });

    if (insertError) return res.status(500).json({ error: sanitizeErrorMessage(insertError) });

    const { data: reviewer } = await supabase
      .from('agents')
      .select('credibility_score, total_reviews_completed, valid_bounties')
      .eq('id', review.reviewer_agent_id)
      .single();

    if (reviewer) {
      const positiveTags = tags.filter(t => POSITIVE_TAGS.includes(t)).length;
      const negativeTags = tags.filter(t => NEGATIVE_TAGS.includes(t)).length;

      let credChange = 0;
      if (helpful && positiveTags > 0) credChange = 0.2 * positiveTags;
      else if (helpful) credChange = 0.1;
      else if (!helpful && negativeTags > 0) credChange = -0.15 * negativeTags;
      else if (!helpful) credChange = -0.05;

      if (credChange !== 0) {
        await adjustCredibility(review.reviewer_agent_id, credChange, {
          reason: helpful
            ? `Review rated helpful: ${tags.join(', ') || 'general'}`
            : `Review rated unhelpful: ${tags.join(', ') || 'general'}`,
          transactionType: helpful ? 'review_rated_helpful' : 'review_rated_unhelpful',
          relatedReviewId: review_id,
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
