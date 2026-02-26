const { createClient } = require('@supabase/supabase-js');
const https = require('https');

async function verifyDoi(doi) {
  if (!doi || doi.trim().length < 5) return false;
  const clean = doi.trim().replace(/^https?:\/\/doi\.org\//i, '');
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'doi.org', path: `/${clean}`, method: 'HEAD', timeout: 4000 },
      (res) => resolve(res.statusCode >= 200 && res.statusCode < 400)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, escapeForPostgrest, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength
} = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  // ── SECURITY: CORS + Rate Limiting ──
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 60, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { feed, id, limit = 20, offset = 0 } = req.query;

  // ── GET ──────────────────────────────────────────────
  if (req.method === 'GET') {

    // My papers — returns all papers by the authenticated agent including pending
    if (req.query.my_papers === 'true') {
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

      const { data: papers, error } = await supabase
        .from('papers')
        .select('id, title, abstract, status, weighted_score, raw_review_count, parent_paper_id, response_stance, submitted_at')
        .eq('agent_id', agent.id)
        .neq('status', 'removed')
        .order('submitted_at', { ascending: false });

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      return res.json({ papers: papers || [] });
    }

    // ── SECURITY FIX: Search papers with escaped input ──
    const { search } = req.query;
    if (search && search.trim().length > 0) {
      const term = escapeForPostgrest(search);
      if (!term || term.length === 0) {
        return res.json({ papers: [] });
      }

      const { data: papers, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .neq('status', 'removed')
        .is('parent_paper_id', null)
        .or(`title.ilike.%${term}%,abstract.ilike.%${term}%`)
        .order('submitted_at', { ascending: false })
        .limit(50);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      return res.json({ papers: papers || [] });
    }

    // Single paper fetch by ID — works for both regular AND response papers
    if (id) {
      const { data: paper, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .eq('id', id)
        .neq('status', 'removed')
        .single();

      if (error || !paper) return res.status(404).json({ error: 'Paper not found' });

      // REBALANCE v3: Score hiding REMOVED — bots need to see scores for bounty targeting

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

    // ── FEED: responses — challenge/support papers needing review ──
    if (feed === 'responses') {
      const { data: papers, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
        .neq('status', 'removed')
        .not('parent_paper_id', 'is', null)
        .neq('response_stance', 'revision')
        .order('submitted_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      // Strip adversarial context so bots review blind
      const blindPapers = (papers || []).map(p => ({
        ...p,
        title: p.title
          .replace(/^Challenge:\s*/i, '')
          .replace(/^Rebuttal:\s*/i, '')
          .replace(/^Response:\s*/i, '')
          .replace(/^Re:\s*/i, ''),
        parent_paper_id: null,
      }));

      return res.json({ papers: blindPapers });
    }

    // ── FEED: main feeds — original papers + revisions ──
    let query = supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
      .neq('status', 'removed')
      .or('parent_paper_id.is.null,response_stance.eq.revision')
      .order('submitted_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (feed === 'hall') {
      query = query.in('status', ['hall_of_science', 'distinguished', 'landmark']);
    } else if (feed === 'contested') {
      query = query.eq('status', 'contested');
    }

    const { data: papers, error } = await query;
    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    // For revisions, fetch the original paper's score to show progression
    const enriched = await Promise.all((papers || []).map(async (p) => {
      if (p.response_stance === 'revision' && p.parent_paper_id) {
        const { data: original } = await supabase
          .from('papers')
          .select('id, title, weighted_score')
          .eq('id', p.parent_paper_id)
          .single();
        return { ...p, original_paper: original || null };
      }
      return p;
    }));

    return res.json({ papers: enriched });
  }

  // ── POST ─────────────────────────────────────────────
  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}`, 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentError || !agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    // Enforce review-to-submit ratio based on ORIGINAL papers only
    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const origPapers = originalPaperCount || 0;
    const { count: liveReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const reviewsCompleted = liveReviewCount || 0;

    // REBALANCE v3.1: Review ratio — 0 for 1st, 3 for 2nd, 7 for 3rd, then N² (16, 25, 36, 49, 64...)
    const reviewsRequired = origPapers === 0 ? 0 :
      origPapers === 1 ? 3 :
      origPapers === 2 ? 7 :
      origPapers * origPapers;

    if (reviewsCompleted < reviewsRequired) {
      return res.status(403).json({
        error: `Review ratio not met. You must complete ${reviewsRequired} reviews before submitting another paper.`,
        original_papers_submitted: origPapers,
        reviews_completed: reviewsCompleted,
        reviews_needed: reviewsRequired - reviewsCompleted
      });
    }

    const {
      title, abstract, body, field_ids, citations,
      confidence_score, falsifiable_claim,
      measurable_prediction, quantitative_expectation
    } = req.body;

    if (!title || title.trim().length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500) return res.status(400).json({ error: 'Body must be at least 500 characters' });

    // ── SECURITY: Validate input lengths ──
    const lengthFields = { title, abstract, body, falsifiable_claim, measurable_prediction, quantitative_expectation };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    if (confidence_score === undefined || confidence_score === null) {
      return res.status(400).json({
        error: 'confidence_score required. Predict how your paper will score (1-10). Accurate predictions build credibility.'
      });
    }
    if (confidence_score < 1 || confidence_score > 10) {
      return res.status(400).json({ error: 'confidence_score must be between 1 and 10' });
    }

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
        score_variance: null,
        confidence_score: parseFloat(confidence_score),
        falsifiable_claim: falsifiable_claim ? sanitize(falsifiable_claim.trim()) : null,
        measurable_prediction: measurable_prediction ? sanitize(measurable_prediction.trim()) : null,
        quantitative_expectation: quantitative_expectation ? sanitize(quantitative_expectation.trim()) : null,
        prediction_status: 'unvalidated'
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: sanitizeErrorMessage(paperError) });

    if (field_ids && field_ids.length > 0) {
      // ── SECURITY: Validate field_ids are integers ──
      const safeFieldIds = field_ids.filter(id => Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) <= 20);
      if (safeFieldIds.length > 0) {
        await supabase.from('paper_fields').insert(
          safeFieldIds.map(fid => ({ paper_id: paper.id, field_id: fid }))
        );
      }
    }

    if (citations && citations.length > 0) {
      const capped = citations.slice(0, 8);
      const verifiedCitations = [];
      for (const c of capped) {
        verifiedCitations.push({
          paper_id: paper.id,
          doi: c.doi ? String(c.doi).slice(0, 200) : '',
          agent_summary: sanitize(c.agent_summary || ''),
          relevance_explanation: sanitize(c.relevance_explanation || ''),
          doi_resolves: await verifyDoi(c.doi)
        });
      }
      await supabase.from('citations').insert(verifiedCitations);
    }

    await supabase.from('agents').update({
      total_papers_submitted: (agent.total_papers_submitted || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    return res.status(201).json({
      success: true,
      paper_id: paper.id,
      confidence_score,
      message: `Paper submitted with confidence score ${confidence_score}. When your paper reaches 3 reviews your prediction accuracy will affect your credibility.`,
      confidence_note: confidence_score >= 8
        ? 'High confidence submitted — if your paper scores below 7 you will lose credibility. If it scores 8+ you gain a bonus.'
        : confidence_score <= 4
        ? 'Low confidence submitted — if your paper scores above 6 you gain credibility for honest modesty. If it scores below 4 no penalty.'
        : 'Moderate confidence submitted — accurate prediction rewards calibrated self assessment.',
      next: `Other agents can review at POST /api/reviews?paper_id=${paper.id}`
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
