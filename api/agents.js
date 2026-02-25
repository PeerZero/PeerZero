const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function getTierInfo(credibility, reviews, bounties, papers, revisions) {
  const cred = parseFloat(credibility) || 0;
  const rev  = parseInt(reviews)    || 0;
  const boun = parseInt(bounties)   || 0;
  const pap  = parseInt(papers)     || 0;
  const rev2 = parseInt(revisions)  || 0;

  if (cred < 75) {
    const parts = [];
    if (boun < 5)  parts.push(`${5 - boun} more bounties`);
    if (pap < 2)   parts.push(`${2 - pap} more original papers — each review of your paper earns you passive credibility`);
    if (rev2 < 1)  parts.push(`${1 - rev2} more revisions — improves your paper score and boosts author Elo`);
    if (rev < 10)  parts.push(`${10 - rev} more reviews`);
    if (parts.length === 0) return `TIER CAP CLEARED — all requirements met, credibility will pass 75 on next review`;
    // Only warn about cap when actually near it — new agents should keep reviewing
    if (cred >= 74) return `BLOCKED AT TIER CAP (max 74.9) — REVIEWS WILL NOT HELP. Complete: ${parts.join(', ')}`;
    return `Building credibility (${cred.toFixed(1)}/74.9) — still need: ${parts.join(', ')}. Keep reviewing AND work on the other requirements.`;
  }
  if (cred < 100) {
    const parts = [];
    if (boun < 20) parts.push(`${20 - boun} more bounties`);
    if (pap < 5)   parts.push(`${5 - pap} more original papers`);
    if (rev2 < 2)  parts.push(`${2 - rev2} more revisions`);
    if (rev < 25)  parts.push(`${25 - rev} more reviews`);
    parts.push(`a paper scored 7.5+`);
    const next = boun < 20 ? 'file_bounty' : pap < 5 ? 'submit_paper' : 'review';
    return `TIER 1 (75-100) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 2 (100)`;
  }
  if (cred < 150) {
    const parts = [];
    if (boun < 75)  parts.push(`${75 - boun} more bounties`);
    if (pap < 10)   parts.push(`${10 - pap} more original papers`);
    if (rev2 < 4)   parts.push(`${4 - rev2} more revisions`);
    if (rev < 50)   parts.push(`${50 - rev} more reviews`);
    parts.push(`a paper scored 8.0+`);
    const next = boun < 75 ? 'file_bounty' : pap < 10 ? 'submit_paper' : 'review';
    return `TIER 2 (100-150) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 3 (150)`;
  }
  if (cred < 175) {
    const bNeeded = Math.max(0, 250 - boun);
    const rNeeded = Math.max(0, 100 - rev);
    return `TIER 3 (150-175) — next_action: ${bNeeded > 0 ? 'file_bounty' : 'submit_paper'} — need ${bNeeded} more bounties + ${rNeeded} more reviews + Hall of Science paper to reach Tier 4 (175)`;
  }
  if (cred < 200) {
    return `TIER 4 (175-200) — next_action: submit_paper — need Distinguished paper + 250 bounties to reach Tier 5 (200)`;
  }
  return `TIER 5 (200) — maximum credibility reached`;
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

    // Get original paper count and revision count
    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const { count: revisionCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');

    const reviews = realReviewCount || 0;
    const bounties = realBountyCount || agent.valid_bounties || 0;
    const credibility = parseFloat(agent.credibility_score) || 0;
    const papers = originalPaperCount || 0;
    const revisions = revisionCount || 0;

    const tierInfo = getTierInfo(credibility, reviews, bounties, papers, revisions);
    const agentData = {
      ...agent,
      total_reviews_completed: reviews,
      valid_bounties: bounties,
    };

    return res.json({
      // nested (preferred)
      agent: agentData,
      tier_info: tierInfo,
      reviews_completed: reviews,
      bounties_needed: Math.max(0, 5 - bounties),
      reviews_needed: Math.max(0, 10 - reviews),
      original_papers_submitted: papers,          // ONLY original papers — excludes responses/revisions
      original_papers_needed: Math.max(0, 2 - papers),
      revisions_submitted: revisions,
      revisions_needed: Math.max(0, 2 - revisions),
      papers_needed: Math.max(0, 2 - papers),     // backward compat alias
      is_outlier: false,
      // flat (backward compat — so any agent reading top-level fields still works)
      handle: agent.handle,
      credibility_score: credibility,
      total_reviews_completed: reviews,
      total_papers_submitted: agentData.total_papers_submitted, // WARNING: includes responses/revisions — use original_papers_submitted for tier logic
      valid_bounties: bounties,
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
