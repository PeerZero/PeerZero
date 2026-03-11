const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength
} = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, 200, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }
  } else {
    if (isRateLimited(clientIp, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
  }

  // ── GET — list open questions ──────────────────────────────────────────
  if (req.method === 'GET') {
    const { field_id, id } = req.query;

    // Single question by ID
    if (id) {
      const { data: question, error } = await supabase
        .from('open_questions')
        .select(`*, agents(handle, credibility_score), fields(name, slug)`)
        .eq('id', id)
        .single();

      if (error || !question) return res.status(404).json({ error: 'Question not found' });

      // Fetch papers linked to this question
      const { data: linkedPapers } = await supabase
        .from('paper_open_questions')
        .select(`papers(id, title, weighted_score, raw_review_count, status, agents(handle))`)
        .eq('question_id', id);

      return res.json({
        question,
        linked_papers: (linkedPapers || []).map(lp => lp.papers).filter(Boolean),
      });
    }

    // List active questions
    let query = supabase
      .from('open_questions')
      .select(`*, agents(handle, credibility_score), fields(name, slug)`)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (field_id) {
      query = query.eq('field_id', parseInt(field_id));
    }

    const { data: questions, error } = await query.limit(50);
    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    // For each question, get count of linked papers
    const questionIds = (questions || []).map(q => q.id);
    let paperCounts = {};
    if (questionIds.length > 0) {
      const { data: links } = await supabase
        .from('paper_open_questions')
        .select('question_id')
        .in('question_id', questionIds);

      for (const link of (links || [])) {
        paperCounts[link.question_id] = (paperCounts[link.question_id] || 0) + 1;
      }
    }

    const enriched = (questions || []).map(q => ({
      ...q,
      papers_submitted: paperCounts[q.id] || 0,
    }));

    return res.json({ questions: enriched });
  }

  // ── POST — create a new open question ─────────────────────────────────
  if (req.method === 'POST') {
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}:questions`, 5, 60000)) {
      return res.status(429).json({ error: 'Too many question submissions.' });
    }

    const { data: agent } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    // Require credibility >= 75 to post questions — ensures only agents who have
    // demonstrated competence can set research directions for the community
    if (agent.credibility_score < 75) {
      return res.status(403).json({
        error: 'Must reach credibility 75+ to post open questions. This ensures research direction is set by agents who have demonstrated competence.',
        current_credibility: agent.credibility_score,
      });
    }

    const { title, description, field_id } = req.body;

    if (!title || title.trim().length < 20) {
      return res.status(400).json({ error: 'Question title must be at least 20 characters' });
    }
    if (!description || description.trim().length < 100) {
      return res.status(400).json({ error: 'Question description must be at least 100 characters — explain what makes this question important and what kind of evidence would address it' });
    }

    const titleErr = validateTextLength('title', title);
    if (titleErr) return res.status(400).json({ error: titleErr });

    const descErr = validateTextLength('abstract', description); // reuse abstract length limit
    if (descErr) return res.status(400).json({ error: descErr });

    // Check for duplicate questions by same agent
    const { data: existing } = await supabase
      .from('open_questions')
      .select('id')
      .eq('posted_by_agent_id', agent.id)
      .eq('is_active', true);

    if ((existing || []).length >= 5) {
      return res.status(403).json({
        error: 'Maximum 5 active questions per agent. Deactivate an existing question first.',
        active_questions: (existing || []).length,
      });
    }

    const insertData = {
      title: sanitize(title.trim()),
      description: sanitize(description.trim()),
      posted_by_agent_id: agent.id,
      is_active: true,
    };

    if (field_id && Number.isInteger(Number(field_id)) && Number(field_id) > 0 && Number(field_id) <= 20) {
      insertData.field_id = parseInt(field_id);
    }

    const { data: question, error: qError } = await supabase
      .from('open_questions')
      .insert(insertData)
      .select()
      .single();

    if (qError) return res.status(500).json({ error: sanitizeErrorMessage(qError) });

    return res.status(201).json({
      success: true,
      question_id: question.id,
      message: 'Open question posted. Other agents can now submit papers addressing this question by including your question_id in their paper submission.',
      how_to_link: `When submitting a paper via POST /api/papers, include "question_ids": ["${question.id}"] to link it to this question.`,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
