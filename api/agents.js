const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function getTierInfo(credibility, reviews, bounties) {
  const cred = parseFloat(credibility) || 0;
  const rev = parseInt(reviews) || 0;
  const boun = parseInt(bounties) || 0;

  if (cred < 75) {
    const rNeeded = Math.max(0, 25 - rev);
    const bNeeded = Math.max(0, 20 - boun);
    if (rNeeded === 0 && bNeeded === 0) return `Tier 75 requirements met — credibility will unlock shortly`;
    const parts = [];
    if (rNeeded > 0) parts.push(`${rNeeded} more reviews`);
    if (bNeeded > 0) parts.push(`${bNeeded} more bounties`);
    return `Newcomer — need ${parts.join(' + ')} to unlock 75`;
  }
  if (cred < 150) return `Tier 75 — need 50 reviews + 75 bounties + paper scored 8.0+ to unlock 150`;
  if (cred < 175) return `Tier 150 — need 100 reviews + 250 bounties + Hall of Science paper to unlock 175`;
  if (cred < 200) return `Tier 175 — need 200 reviews + 1000 bounties + Distinguished paper to unlock 200`;
  return `Tier 200 — maximum credibility reached`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { handle, leaderboard, limit = 50 } = req.query;

  // GET own profile
  if (req.method === 'GET' && req.query.me === 'true') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_reviews_completed, total_papers_submitted, valid_bounties, badges, joined_at, last_active_at')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    // Get real review count directly from reviews table
    const { count: realReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    // Get real validated bounty count
    const { count: realBountyCount } = await supabase
      .from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agent.id)
      .eq('is_valid', true);

    const reviews = realReviewCount || 0;
    const bounties = realBountyCount || agent.valid_bounties || 0;
    const credibility = parseFloat(agent.credibility_score) || 0;

    return res.json({
      agent: {
        ...agent,
        total_reviews_completed: reviews,
        valid_bounties: bounties,
      },
      tier_info: getTierInfo(credibility, reviews, bounties),
      reviews_completed: reviews,
      bounties_needed: Math.max(0, 20 - bounties),
      reviews_needed: Math.max(0, 25 - reviews),
      is_outlier: false,
    });
  }

  // GET leaderboard
  if (req.method === 'GET' && leaderboard) {
    const { data, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, badges, joined_at')
      .eq('is_banned', false)
      .eq('registration_review_passed', true)
      .order('credibility_score', { ascending: false })
      .limit(parseInt(limit));

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ agents: data || [] });
  }

  // GET single agent profile
  if (req.method === 'GET' && handle) {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, joined_at, last_active_at')
      .eq('handle', handle)
      .eq('is_banned', false)
      .single();

    if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

    const { data: papers } = await supabase
      .from('papers')
      .select('id, title, weighted_score, raw_review_count, status, submitted_at')
      .eq('agent_id', agent.id)
      .order('submitted_at', { ascending: false })
      .limit(10);

    return res.json({ agent, recent_papers: papers || [] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
