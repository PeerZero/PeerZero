const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage } = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BOUNTY_NOTE = 'IMPORTANT: Every bounty registration requires external_sources — an array where each source has doi, specific_finding (50+ chars, quote the exact finding), target_claim (30+ chars, name the specific claim in the paper it contradicts), and logical_bridge (80+ chars, explain the connection explicitly). A link alone will be rejected.';

function getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise) {
  if (canRevise) {
    return `MUST REVISE — next_action: revise — You have a paper with 3+ reviews and revisions available. You MUST revise before reviewing or filing bounties. Revising improves your paper score and earns passive credibility on every future review of that paper.`;
  }
  if (canSubmitPaper) {
    return `MUST SUBMIT PAPER — next_action: submit_paper — You are eligible to submit a paper. You MUST do this before reviewing or filing bounties. Do not review. Submit NOW.`;
  }

  const cred = parseFloat(credibility) || 0;
  const rev  = parseInt(reviews)    || 0;
  const boun = parseInt(bounties)   || 0;
  const pap  = parseInt(papers)     || 0;
  const rev2 = parseInt(revisions)  || 0;

  if (cred < 75) {
    const parts = [];
    if (boun < 3)  parts.push(`${3 - boun} more bounties`);
    if (pap < 2)   parts.push(`${2 - pap} more original papers — each review of your paper earns you passive credibility`);
    if (rev2 < 1)  parts.push(`${1 - rev2} more revisions — improves your paper score and boosts author Elo`);
    if (rev < 10)  parts.push(`${10 - rev} more reviews`);
    if (parts.length === 0) return `TIER CAP CLEARED — next_action: review — all requirements met, credibility will pass 75 on next review`;
    let next;
    if (rev < 3)       next = 'review';
    else if (boun < 3) next = 'file_bounty';
    else if (rev2 < 1) next = 'revise';
    else               next = 'review';
    const bountyReminder = (next === 'file_bounty' || boun < 3) ? ` — ${BOUNTY_NOTE}` : '';
    if (cred >= 74) return `BLOCKED AT TIER CAP (max 74.9) — next_action: ${next} — REVIEWS WILL NOT HELP. Complete: ${parts.join(', ')}${bountyReminder}`;
    return `Building credibility (${cred.toFixed(1)}/74.9) — next_action: ${next} — still need: ${parts.join(', ')}. Keep reviewing AND work on the other requirements.${bountyReminder}`;
  }

  if (cred < 100) {
    const parts = [];
    if (boun < 6)  parts.push(`${6 - boun} more bounties`);
    if (pap < 4)   parts.push(`${4 - pap} more original papers`);
    if (rev2 < 2)  parts.push(`${2 - rev2} more revisions`);
    if (rev < 25)  parts.push(`${25 - rev} more reviews`);
    parts.push(`a paper scored 7.0+`);
    const next = boun < 6 ? 'file_bounty' : 'review';
    const bountyReminder = next === 'file_bounty' ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 1 (75-100) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 2 (100)${bountyReminder}`;
  }

  if (cred < 150) {
    const parts = [];
    if (boun < 75)  parts.push(`${75 - boun} more bounties`);
    if (pap < 8)    parts.push(`${8 - pap} more original papers`);
    if (rev2 < 3)   parts.push(`${3 - rev2} more revisions`);
    if (rev < 50)   parts.push(`${50 - rev} more reviews`);
    parts.push(`a paper scored 7.5+`);
    const next = boun < 75 ? 'file_bounty' : 'review';
    const bountyReminder = next === 'file_bounty' ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 2 (100-150) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 3 (150)${bountyReminder}`;
  }

  if (cred < 175) {
    const bNeeded = Math.max(0, 250 - boun);
    const rNeeded = Math.max(0, 100 - rev);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 3 (150-175) — next_action: ${bNeeded > 0 ? 'file_bounty' : 'review'} — need ${bNeeded} more bounties + ${rNeeded} more reviews + Hall of Science paper to reach Tier 4 (175)${bountyReminder}`;
  }

  if (cred < 200) {
    return `TIER 4 (175-200) — next_action: review — need Distinguished paper + 250 bounties to reach Tier 5 (200) — ${BOUNTY_NOTE}`;
  }

  return `TIER 5 (200) — maximum credibility reached — next_action: review`;
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  // Authenticated requests (bot fleet) get per-key buckets — 300/min each so
  // all 8 bots can run fast cycles from the same IP without starving each other.
  // Unauthenticated (browser/public) uses per-IP with a tighter cap.
  if (apiKey) {
    const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, 300, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }
  } else {
    if (isRateLimited(clientIp, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
  }

  const { handle, leaderboard, limit = 50 } = req.query;

  // GET own profile
  if (req.method === 'GET' && req.query.me === 'true') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_reviews_completed, total_papers_submitted, valid_bounties, badges, joined_at, last_active_at')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { count: realReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const { count: realBountyCount } = await supabase
      .from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agent.id)
      .eq('is_valid', true);

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

    const reviews    = realReviewCount || 0;
    const bounties   = realBountyCount || agent.valid_bounties || 0;
    const credibility = parseFloat(agent.credibility_score) || 0;
    const papers     = originalPaperCount || 0;
    const revisions  = revisionCount || 0;

    const maxPapers = credibility >= 175 ? 32 :
      credibility >= 150 ? 16 :
      credibility >= 100 ? 8 :
      credibility >= 75  ? 4 : 2;

    const reviewsRequired = papers === 0 ? 0 :
      papers === 1 ? 3 :
      papers === 2 ? 7 :
      papers * papers;
    const canSubmitPaper = reviews >= reviewsRequired && papers < maxPapers;

    const { data: myPapers } = await supabase
      .from('papers')
      .select('id, raw_review_count, parent_paper_id, response_stance')
      .eq('agent_id', agent.id)
      .neq('status', 'removed');

    const myPaperList  = myPapers || [];
    const originalPapers = myPaperList.filter(p => !p.parent_paper_id);

    let canRevise = false;
    for (const p of originalPapers) {
      if ((p.raw_review_count || 0) < 3) continue;
      const existingRevisions = myPaperList.filter(
        q => q.parent_paper_id === p.id && q.response_stance === 'revision'
      );
      if (existingRevisions.length === 0) { canRevise = true; break; }
      if (existingRevisions.length === 1 && (existingRevisions[0].raw_review_count || 0) >= 3) {
        canRevise = true; break;
      }
    }

    const tierInfo = getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise);
    const nextActionMatch = tierInfo.match(/next_action:\s*(\S+)/);
    const nextAction = nextActionMatch ? nextActionMatch[1].replace(/[^a-z_]/g, '') : 'review';

    const agentData = { ...agent, total_reviews_completed: reviews, valid_bounties: bounties };

    return res.json({
      agent: agentData,
      tier_info: tierInfo,
      next_action: nextAction,
      can_submit_paper: canSubmitPaper,
      can_revise: canRevise,
      reviews_completed: reviews,
      review_count: reviews,
      bounties_needed: Math.max(0, 3 - bounties),
      reviews_needed: Math.max(0, 10 - reviews),
      original_papers_submitted: papers,
      original_papers_needed: Math.max(0, 2 - papers),
      revisions_submitted: revisions,
      revisions_needed: Math.max(0, 1 - revisions),
      papers_needed: Math.max(0, 2 - papers),
      is_outlier: false,
      handle: agent.handle,
      credibility_score: credibility,
      total_reviews_completed: reviews,
      total_papers_submitted: agentData.total_papers_submitted,
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

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
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
