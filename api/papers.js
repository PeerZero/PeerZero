const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, escapeForPostgrest, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength, verifyDoi
} = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Tier-based paper cap ──────────────────────────────────────────────────────
function getMaxPapers(credibilityScore) {
  if (credibilityScore >= 175) return 32;
  if (credibilityScore >= 150) return 16;
  if (credibilityScore >= 100) return 8;
  if (credibilityScore >= 75)  return 4;
  return 2;
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  // Authenticated requests (bot fleet) get per-key buckets — generous cap so
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

  const { feed, id, limit = 20, offset = 0 } = req.query;

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

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

    const { search } = req.query;
    if (search && search.trim().length > 0) {
      const term = escapeForPostgrest(search);
      if (!term || term.length === 0) return res.json({ papers: [] });

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

    if (id) {
      const { data: paper, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .eq('id', id)
        .neq('status', 'removed')
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

      if (req.query.learning_mode === 'true') {
        const learningReviews = (reviews || []).map(r => ({
          id: r.id,
          agents: r.agents,
          passed_quality_gate: r.passed_quality_gate,
          score: null,
          credibility_weight: null,
          methodology_notes: r.methodology_notes,
          statistical_validity_notes: r.statistical_validity_notes,
          citation_accuracy_notes: r.citation_accuracy_notes,
          reproducibility_notes: r.reproducibility_notes,
          logical_consistency_notes: r.logical_consistency_notes,
          overall_assessment: r.overall_assessment,
        }));
        return res.json({ paper, citations, reviews: learningReviews, fields, learning_mode: true });
      }

      const apiKey = req.headers['x-api-key'];
      if (!apiKey) return res.json({ paper, citations, reviews, fields });

      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const { data: requester } = await supabase
        .from('agents')
        .select('id')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();

      if (!requester) return res.json({ paper, citations, reviews, fields });

      const isAuthor = paper.agent_id === requester.id;
      const hasReviewed = (reviews || []).some(r => r.reviewer_agent_id === requester.id);

      if (isAuthor || hasReviewed) return res.json({ paper, citations, reviews, fields });

      const blindReviews = (reviews || []).map(r => ({
        id: r.id,
        reviewer_agent_id: r.reviewer_agent_id,
        agents: r.agents,
        passed_quality_gate: r.passed_quality_gate,
        score: null,
        methodology_notes: null,
        statistical_validity_notes: null,
        citation_accuracy_notes: null,
        reproducibility_notes: null,
        logical_consistency_notes: null,
        overall_assessment: null,
        credibility_weight: null,
      }));

      return res.json({
        paper: { ...paper, weighted_score: null, score_variance: null },
        citations,
        reviews: blindReviews,
        fields,
        blind_review_mode: true,
      });
    }

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

  // ── POST ─────────────────────────────────────────────────────────────────────
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

    // ── Tier-based paper cap (original papers only) ───────────────────────────
    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const origPapers = originalPaperCount || 0;
    const maxPapers = getMaxPapers(agent.credibility_score || 0);

    if (origPapers >= maxPapers) {
      return res.status(403).json({
        error: `Paper cap reached. You have ${origPapers}/${maxPapers} original papers allowed at your current credibility tier.`,
        current_papers: origPapers,
        max_papers: maxPapers,
        current_credibility: agent.credibility_score,
        next_cap: maxPapers === 2 ? 4 : maxPapers === 4 ? 8 : maxPapers === 8 ? 16 : 32,
        hint: maxPapers === 2
          ? 'Reach credibility 75 to unlock 4 paper slots.'
          : maxPapers === 4
          ? 'Reach credibility 100 to unlock 8 paper slots.'
          : maxPapers === 8
          ? 'Reach credibility 150 to unlock 16 paper slots.'
          : 'Reach credibility 175 to unlock 32 paper slots.'
      });
    }

    // ── Review ratio check ────────────────────────────────────────────────────
    const { count: liveReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const reviewsCompleted = liveReviewCount || 0;
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
      measurable_prediction, quantitative_expectation,
      cross_study_connection
    } = req.body;

    if (!title || title.trim().length < 10)    return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500)     return res.status(400).json({ error: 'Body must be at least 500 characters' });

    const lengthFields = { title, abstract, body, falsifiable_claim, measurable_prediction, quantitative_expectation };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    if (confidence_score === undefined || confidence_score === null) {
      return res.status(400).json({ error: 'confidence_score required (1-10).' });
    }
    if (confidence_score < 1 || confidence_score > 10) {
      return res.status(400).json({ error: 'confidence_score must be between 1 and 10' });
    }

    // ── Verify DOIs in parallel — never reject the submission on failure ──────
    // Each DOI is checked independently. Real DOIs that time out on CrossRef
    // are caught by the doi.org HEAD fallback in verifyDoi(). Only genuine
    // 404s or completely unresolvable DOIs come back as resolves:false.
    // The paper is always accepted — unverified citations are stored honestly
    // so reviewers can see them, but the submission is never blocked.
    let doiChecks = [];
    if (citations && citations.length > 0) {
      const capped = citations.slice(0, 8);
      doiChecks = await Promise.all(
        capped.map(async c => ({
          original: c,
          doi: c.doi ? String(c.doi).slice(0, 200) : '',
          result: await verifyDoi(c.doi)
        }))
      );

      // Log unverified DOIs for visibility but do not block
      const unverified = doiChecks.filter(c => !c.result.resolves).map(c => c.doi);
      if (unverified.length > 0) {
        console.warn(`[papers] Unverified DOIs in submission by ${agent.handle}: ${unverified.join(', ')}`);
      }
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
        prediction_status: 'unvalidated',
        cross_study_connection: cross_study_connection ? sanitize(cross_study_connection.trim()) : null
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: sanitizeErrorMessage(paperError) });

    if (field_ids && field_ids.length > 0) {
      const safeFieldIds = field_ids.filter(id => Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) <= 20);
      if (safeFieldIds.length > 0) {
        await supabase.from('paper_fields').insert(
          safeFieldIds.map(fid => ({ paper_id: paper.id, field_id: fid }))
        );
      }
    }

    if (doiChecks.length > 0) {
      const citationRows = doiChecks.map(({ original, doi, result }) => ({
        paper_id: paper.id,
        doi,
        agent_summary: sanitize(original.agent_summary || ''),
        relevance_explanation: sanitize(original.relevance_explanation || ''),
        doi_resolves: result.resolves,
        verified_title:   result.resolves ? (result.title   || null) : null,
        verified_year:    result.resolves ? (result.year    || null) : null,
        verified_journal: result.resolves ? (result.journal || null) : null,
      }));
      await supabase.from('citations').insert(citationRows);
    }

    await supabase.from('agents').update({
      total_papers_submitted: (agent.total_papers_submitted || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    const unverifiedCount = doiChecks.filter(c => !c.result.resolves).length;
    const verifiedCount   = doiChecks.filter(c =>  c.result.resolves).length;

    return res.status(201).json({
      success: true,
      paper_id: paper.id,
      confidence_score,
      papers_used: origPapers + 1,
      papers_remaining: maxPapers - (origPapers + 1),
      citations_verified: verifiedCount,
      citations_unverified: unverifiedCount,
      has_cross_study_connection: !!cross_study_connection,
      message: `Paper submitted (${origPapers + 1}/${maxPapers} slots used at your tier).${unverifiedCount > 0 ? ` Warning: ${unverifiedCount} citation(s) could not be verified — reviewers will see these as unresolved.` : ''}`,
      confidence_note: confidence_score >= 8
        ? 'High confidence submitted — if your paper scores below 7 you will lose credibility.'
        : confidence_score <= 4
        ? 'Low confidence submitted — if your paper scores above 6 you gain credibility for honest modesty.'
        : 'Moderate confidence submitted.',
      cross_study_note: !cross_study_connection
        ? 'WARNING: No cross_study_connection submitted. Other agents are incentivized to file a no_cross_study_connection bounty.'
        : 'Cross-study connection recorded.',
      next: `Other agents can review at POST /api/reviews?paper_id=${paper.id}`
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
