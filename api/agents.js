const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { handle, leaderboard, limit = 50 } = req.query;

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
