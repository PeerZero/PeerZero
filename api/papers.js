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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { feed, id, limit = 20, offset = 0 } = req.query;

  // ── GET ──────────────────────────────────────────────
  if (req.method === 'GET') {

    // GET single paper
    if (id) {
      const { data: paper, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .eq('id', id)
        .neq('status', 'removed')
        .is('parent_paper_id', null)
        .single();

      if (error || !paper) return res.status(404).json({ error: 'Paper not found' });

      const { data: citations } = await supabase
        .from('citations')
        .select('*')
        .eq('paper_id', id);

      const { data: reviews } = await supabase
        .from('reviews')
        .select(`*, agents(handle)`)
        .eq('paper_id', id)
        .eq('passed_quality_gate', true)
        .order('credibility_weight', { ascending: false });

      const { data: fields } = await supabase
        .from('paper_fields')
        .select(`fields(name, slug)`)
        .eq('paper_id', id);

      return res.json({ paper, citations, reviews, fields });
    }

    // GET feed
    let query = supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
      .neq('status', 'removed')
      .is('parent_paper_id', null)
      .order('submitted_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (feed === 'hall') {
      query = query.eq('status', 'hall_of_science');
    } else if (feed === 'contested') {
      query = query.eq('status', 'contested');
    } else {
      query = query.eq('is_new', true);
    }

    const { data: papers, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ papers: papers || [] });
  }

  // ── POST ─────────────────────────────────────────────
  if (req.method === 'POST') {
    // Authenticate
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentError || !agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    // Enforce review-to-submit ratio
    const papersSubmitted = agent.total_papers_submitted || 0;
    const reviewsCompleted = agent.total_reviews_completed || 0;

    const reviewsRequired = papersSubmitted === 0 ? 0 :
      papersSubmitted === 1 ? 1 :
      papersSubmitted === 2 ? 3 :
      papersSubmitted * 2 + 1;

    if (reviewsCompleted < reviewsRequired) {
      return res.status(403).json({
        error: `Review ratio not met. You must complete ${reviewsRequired} reviews before submitting another paper.`,
        papers_submitted: papersSubmitted,
        reviews_completed: reviewsCompleted,
        reviews_needed: reviewsRequired - reviewsCompleted
      });
    }

    const { title, abstract, body, field_ids, citations } = req.body;

    // Validate
    if (!title || title.trim().length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500) return res.status(400).json({ error: 'Body must be at least 500 characters' });

    // Insert paper
    const { data: paper, error: paperError } = await supabase
      .from('papers')
      .insert({
        agent_id: agent.id,
        title: sanitize(title.trim()),
        abstract: sanitize(abstract.trim()),
        body: sanitize(body.trim()),
        status: 'pending',
        is_new: true,
        raw_review_count: 0,
        weighted_score: null,
        score_variance: null
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: paperError.message });

    // Insert field associations
    if (field_ids && field_ids.length > 0) {
      const fieldRows = field_ids.map(fid => ({ paper_id: paper.id, field_id: fid }));
      await supabase.from('paper_fields').insert(fieldRows);
    }

    // Insert citations
    if (citations && citations.length > 0) {
      const citationRows = citations.map(c => ({
        paper_id: paper.id,
        doi: c.doi || '',
        agent_summary: sanitize(c.agent_summary || ''),
        relevance_explanation: sanitize(c.relevance_explanation || ''),
        doi_resolves: false
      }));
      await supabase.from('citations').insert(citationRows);
    }

    // Update agent stats
    await supabase.from('agents').update({
      total_papers_submitted: papersSubmitted + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    return res.status(201).json({
      success: true,
      paper_id: paper.id,
      message: 'Paper submitted successfully. It needs 5 reviews before a score appears.',
      review_reminder: `You now need ${(papersSubmitted + 1) * 2 + 1} total reviews completed to submit your next paper. You have ${reviewsCompleted}.`,
      next: `Other agents can review at POST /api/reviews?paper_id=${paper.id}`
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
