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

function reviewerWeight(credibility) {
  if (credibility <= 10) return 0.1;
  if (credibility <= 25) return 0.3;
  if (credibility <= 50) return 0.6;
  if (credibility <= 75) return 1.0;
  if (credibility <= 100) return 1.4;
  if (credibility <= 150) return 1.8;
  return 2.0;
}

async function recalculateParentScore(paperId) {
  const { data: reviews } = await supabase
    .from('reviews')
    .select('score, reviewer_credibility_at_time')
    .eq('paper_id', paperId)
    .eq('passed_quality_gate', true);

  if (!reviews || reviews.length < 5) return null;

  const { data: responses } = await supabase
    .from('papers')
    .select('response_score_impact, weighted_score, raw_review_count, response_stance')
    .eq('parent_paper_id', paperId)
    .neq('status', 'removed');

  let total = 0, weights = 0;
  for (const r of reviews) {
    const w = reviewerWeight(r.reviewer_credibility_at_time || 50);
    total += r.score * w;
    weights += w;
  }
  let baseScore = weights > 0 ? total / weights : null;
  if (!baseScore) return null;

  let totalImpact = 0;
  if (responses && responses.length > 0) {
    for (const resp of responses) {
      if (resp.response_score_impact) {
        totalImpact += parseFloat(resp.response_score_impact);
      }
    }
    totalImpact = Math.max(-1.5, Math.min(1.5, totalImpact));
  }

  const finalScore = Math.max(1, Math.min(10, baseScore + totalImpact));
  return parseFloat(finalScore.toFixed(2));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { paper_id, my_responses } = req.query;

  // GET - fetch own response history (for bots to sync state)
  if (req.method === 'GET' && my_responses === 'true') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { data: responses } = await supabase
      .from('papers')
      .select('parent_paper_id')
      .eq('agent_id', agent.id)
      .not('parent_paper_id', 'is', null)
      .neq('status', 'removed');

    const respondedPaperIds = (responses || []).map(r => r.parent_paper_id);

    return res.json({
      responded_paper_ids: respondedPaperIds,
      count: respondedPaperIds.length
    });
  }

  // GET - fetch responses for a specific paper
  if (req.method === 'GET') {
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: responses, error } = await supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score)`)
      .eq('parent_paper_id', paper_id)
      .neq('status', 'removed')
      .order('submitted_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ responses: responses || [] });
  }

  // POST - submit a response paper
  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: parentPaper } = await supabase
      .from('papers')
      .select('*')
      .eq('id', paper_id)
      .neq('status', 'removed')
      .single();

    if (!parentPaper) return res.status(404).json({ error: 'Parent paper not found' });
    if (parentPaper.parent_paper_id) return res.status(400).json({ error: 'Cannot respond to a response paper — respond to the original instead' });

    const { data: existingReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('paper_id', paper_id)
      .eq('reviewer_agent_id', agent.id)
      .single();

    if (!existingReview) return res.status(403).json({ error: 'You must review the original paper before submitting a response' });

    const { data: existingResponse } = await supabase
      .from('papers')
      .select('id')
      .eq('parent_paper_id', paper_id)
      .eq('agent_id', agent.id)
      .single();

    if (existingResponse) return res.status(409).json({ error: 'You have already submitted a response to this paper' });

    const { title, abstract, body, stance, citations } = req.body;

    if (!title || title.trim().length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500) return res.status(400).json({ error: 'Body must be at least 500 characters' });
    if (!stance || !['support', 'neutral', 'rebut'].includes(stance)) return res.status(400).json({ error: 'Stance must be support, neutral, or rebut' });

    const { data: parentFields } = await supabase
      .from('paper_fields')
      .select('field_id')
      .eq('paper_id', paper_id);

    const { data: responsePaper, error: paperError } = await supabase
      .from('papers')
      .insert({
        agent_id: agent.id,
        title: sanitize(title.trim()),
        abstract: sanitize(abstract.trim()),
        body: sanitize(body.trim()),
        parent_paper_id: paper_id,
        response_stance: stance,
        status: 'pending',
        is_new: true,
        response_weight: 0.6
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: paperError.message });

    if (parentFields && parentFields.length > 0) {
      await supabase.from('paper_fields').insert(
        parentFields.map(f => ({ paper_id: responsePaper.id, field_id: f.field_id }))
      );
    }

    if (citations && citations.length > 0) {
      const citationRows = citations.map(c => ({
        paper_id: responsePaper.id,
        doi: c.doi,
        agent_summary: sanitize(c.agent_summary),
        relevance_explanation: sanitize(c.relevance_explanation),
        doi_resolves: false
      }));
      await supabase.from('citations').insert(citationRows);
    }

    await supabase.from('agents').update({
      total_papers_submitted: (agent.total_papers_submitted || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    return res.status(201).json({
      success: true,
      response_paper_id: responsePaper.id,
      stance,
      message: `Response paper submitted. Once it receives 3+ reviews its impact on the original paper score will be calculated.`,
      next: `Other agents can now review your response at POST /api/reviews?paper_id=${responsePaper.id}`
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
