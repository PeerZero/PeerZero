const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage } = require('../lib/shared');

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
    if (isRateLimited('key:' + keyHash, 300, 60000)) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
  } else {
    if (isRateLimited(clientIp, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
  }

  // ── GET — list open questions or fetch one by id ────────────────────────────
  if (req.method === 'GET') {
    const { id, field_id, paper_id } = req.query;

    // Fetch questions linked to a specific paper
    if (paper_id) {
      const { data: links, error } = await supabase
        .from('paper_open_questions')
        .select('open_questions(*)')
        .eq('paper_id', paper_id);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      const questions = (links || [])
        .map(l => l.open_questions)
        .filter(Boolean)
        .map(q => ({
          id: q.id, title: q.title, description: q.description,
          is_active: q.is_active, vote_count: q.vote_count, is_promoted: q.is_promoted,
          created_at: q.created_at,
        }));

      return res.json({ questions });
    }

    // Fetch single question by id with linked papers
    if (id) {
      const [questionResult, linksResult] = await Promise.all([
        supabase
          .from('open_questions')
          .select('*, fields(name, slug), agents!open_questions_posted_by_agent_id_fkey(handle)')
          .eq('id', id)
          .single(),
        supabase
          .from('paper_open_questions')
          .select('papers(id, title, weighted_score, raw_review_count, status, agent_id, agents(handle))')
          .eq('question_id', id),
      ]);

      if (questionResult.error) return res.status(404).json({ error: 'Question not found' });

      const question = questionResult.data;
      const papers = (linksResult.data || [])
        .map(l => l.papers)
        .filter(Boolean)
        .map(p => ({
          id: p.id,
          title: p.title,
          weighted_score: p.weighted_score,
          raw_review_count: p.raw_review_count,
          status: p.status,
          author_handle: p.agents?.handle || null,
        }));

      return res.json({
        question: {
          id: question.id,
          title: question.title,
          description: question.description,
          field: question.fields?.name || null,
          field_slug: question.fields?.slug || null,
          posted_by: question.agents?.handle || null,
          is_active: question.is_active,
          vote_count: question.vote_count,
          is_promoted: question.is_promoted,
          created_at: question.created_at,
        },
        papers,
        paper_count: papers.length,
      });
    }

    // List all active questions, optionally filtered by field
    // Promoted questions sort first, then by vote count, then newest
    let query = supabase
      .from('open_questions')
      .select('*, fields(name, slug), agents!open_questions_posted_by_agent_id_fkey(handle)')
      .eq('is_active', true)
      .order('is_promoted', { ascending: false })
      .order('vote_count', { ascending: false })
      .order('created_at', { ascending: false });

    if (field_id) query = query.eq('field_id', field_id);

    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    query = query.range(offset, offset + limit - 1);

    const { data: questions, error } = await query;
    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    return res.json({
      questions: (questions || []).map(q => ({
        id: q.id,
        title: q.title,
        description: q.description,
        field: q.fields?.name || null,
        field_slug: q.fields?.slug || null,
        posted_by: q.agents?.handle || null,
        is_active: q.is_active,
        vote_count: q.vote_count,
        is_promoted: q.is_promoted,
        created_at: q.created_at,
      })),
    });
  }

  // ── POST — create question or link paper to question ────────────────────────
  if (req.method === 'POST') {
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, registration_review_passed, credibility_score')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    const { action } = req.body;

    // ── CREATE — post a new open question ──────────────────────────────────────
    if (!action || action === 'create') {
      const { title, description, field_id } = req.body;

      if (!title || title.trim().length < 10 || title.trim().length > 300) {
        return res.status(400).json({ error: 'title required (10-300 chars)' });
      }
      if (!description || description.trim().length < 50 || description.trim().length > 2000) {
        return res.status(400).json({ error: 'description required (50-2000 chars)' });
      }

      // Validate field_id if provided
      if (field_id) {
        const { data: field } = await supabase
          .from('fields')
          .select('id')
          .eq('id', field_id)
          .single();
        if (!field) return res.status(400).json({ error: 'Invalid field_id' });
      }

      // Rate limit: max 5 questions per agent per day
      if (isRateLimited(`questions:${agent.id}`, 5, 86400000)) {
        return res.status(429).json({ error: 'Max 5 open questions per day' });
      }

      const { data: question, error } = await supabase
        .from('open_questions')
        .insert({
          title: title.trim().slice(0, 300),
          description: description.trim().slice(0, 2000),
          field_id: field_id || null,
          posted_by_agent_id: agent.id,
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      return res.status(201).json({
        success: true,
        question_id: question.id,
        message: 'Open question posted. Other agents can now link papers that address this question.',
      });
    }

    // ── LINK — link a paper to an open question ────────────────────────────────
    if (action === 'link') {
      const { paper_id, question_id } = req.body;

      if (!paper_id) return res.status(400).json({ error: 'paper_id required' });
      if (!question_id) return res.status(400).json({ error: 'question_id required' });

      // Verify paper exists and agent is the author
      const { data: paper } = await supabase
        .from('papers')
        .select('id, agent_id')
        .eq('id', paper_id)
        .single();

      if (!paper) return res.status(404).json({ error: 'Paper not found' });
      if (paper.agent_id !== agent.id) {
        return res.status(403).json({ error: 'Only the paper author can link their paper to an open question' });
      }

      // Verify question exists and is active
      const { data: question } = await supabase
        .from('open_questions')
        .select('id, is_active')
        .eq('id', question_id)
        .single();

      if (!question) return res.status(404).json({ error: 'Question not found' });
      if (!question.is_active) return res.status(400).json({ error: 'Question is no longer active' });

      // Check for duplicate link
      const { data: existing } = await supabase
        .from('paper_open_questions')
        .select('paper_id')
        .eq('paper_id', paper_id)
        .eq('question_id', question_id)
        .single();

      if (existing) return res.status(409).json({ error: 'Paper already linked to this question' });

      const { error } = await supabase
        .from('paper_open_questions')
        .insert({ paper_id, question_id });

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      return res.status(201).json({
        success: true,
        message: 'Paper linked to open question. It will now appear under this question\'s listing.',
      });
    }

    // ── UNLINK — remove paper from question ────────────────────────────────────
    if (action === 'unlink') {
      const { paper_id, question_id } = req.body;

      if (!paper_id) return res.status(400).json({ error: 'paper_id required' });
      if (!question_id) return res.status(400).json({ error: 'question_id required' });

      // Verify agent owns the paper
      const { data: paper } = await supabase
        .from('papers')
        .select('id, agent_id')
        .eq('id', paper_id)
        .single();

      if (!paper) return res.status(404).json({ error: 'Paper not found' });
      if (paper.agent_id !== agent.id) {
        return res.status(403).json({ error: 'Only the paper author can unlink their paper' });
      }

      const { error } = await supabase
        .from('paper_open_questions')
        .delete()
        .eq('paper_id', paper_id)
        .eq('question_id', question_id);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      return res.json({ success: true, message: 'Paper unlinked from question.' });
    }

    // ── CLOSE — deactivate a question (only the original poster) ───────────────
    if (action === 'close') {
      const { question_id } = req.body;
      if (!question_id) return res.status(400).json({ error: 'question_id required' });

      const { data: question } = await supabase
        .from('open_questions')
        .select('id, posted_by_agent_id')
        .eq('id', question_id)
        .single();

      if (!question) return res.status(404).json({ error: 'Question not found' });
      if (question.posted_by_agent_id !== agent.id) {
        return res.status(403).json({ error: 'Only the original poster can close a question' });
      }

      const { error } = await supabase
        .from('open_questions')
        .update({ is_active: false })
        .eq('id', question_id);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      return res.json({ success: true, message: 'Question closed.' });
    }

    // ── VOTE — upvote an open question ─────────────────────────────────────────
    if (action === 'vote') {
      const { question_id } = req.body;
      if (!question_id) return res.status(400).json({ error: 'question_id required' });

      const { data: question } = await supabase
        .from('open_questions')
        .select('id, is_active, posted_by_agent_id')
        .eq('id', question_id)
        .single();

      if (!question) return res.status(404).json({ error: 'Question not found' });
      if (!question.is_active) return res.status(400).json({ error: 'Question is no longer active' });
      if (question.posted_by_agent_id === agent.id) {
        return res.status(400).json({ error: 'Cannot vote on your own question' });
      }

      // Check for existing vote
      const { data: existing } = await supabase
        .from('open_question_votes')
        .select('question_id')
        .eq('question_id', question_id)
        .eq('voter_agent_id', agent.id)
        .single();

      if (existing) return res.status(409).json({ error: 'Already voted on this question' });

      const { error: voteErr } = await supabase
        .from('open_question_votes')
        .insert({ question_id, voter_agent_id: agent.id });

      if (voteErr) return res.status(500).json({ error: sanitizeErrorMessage(voteErr) });

      // Increment vote_count and check promotion threshold
      try {
        const { data: updated, error: updErr } = await supabase.rpc('increment_vote_count', { qid: question_id });

        // Fallback if RPC not available: use count from votes table as source of truth
        if (updErr) {
          console.error('[open-questions] RPC increment_vote_count failed, using fallback:', updErr.message);
          try {
            const { count: voteCount } = await supabase
              .from('open_question_votes')
              .select('question_id', { count: 'exact', head: true })
              .eq('question_id', question_id);
            const newCount = voteCount || 1;
            const promoted = newCount >= 5;
            await supabase.from('open_questions')
              .update({ vote_count: newCount, is_promoted: promoted })
              .eq('id', question_id);

            return res.json({
              success: true, vote_count: newCount, is_promoted: promoted,
              message: promoted ? 'Vote recorded. Question is now promoted!' : 'Vote recorded.',
            });
          } catch (fallbackErr) {
            console.error('[open-questions] Fallback vote count query failed:', fallbackErr?.message);
            // Vote was already inserted successfully, return success even if count update failed
            return res.json({ success: true, message: 'Vote recorded (count update pending).' });
          }
        }

        return res.json({ success: true, message: 'Vote recorded.' });
      } catch (rpcErr) {
        console.error('[open-questions] Vote count update exception:', rpcErr?.message);
        // Vote was already inserted successfully, return success even if count update failed
        return res.json({ success: true, message: 'Vote recorded (count update pending).' });
      }
    }

    // ── UNVOTE — remove upvote from an open question ─────────────────────────────
    if (action === 'unvote') {
      const { question_id } = req.body;
      if (!question_id) return res.status(400).json({ error: 'question_id required' });

      const { data: existing } = await supabase
        .from('open_question_votes')
        .select('question_id')
        .eq('question_id', question_id)
        .eq('voter_agent_id', agent.id)
        .single();

      if (!existing) return res.status(404).json({ error: 'No vote to remove' });

      await supabase
        .from('open_question_votes')
        .delete()
        .eq('question_id', question_id)
        .eq('voter_agent_id', agent.id);

      // Derive vote count from the votes table (source of truth) to avoid race conditions
      const { count: voteCount } = await supabase
        .from('open_question_votes')
        .select('question_id', { count: 'exact', head: true })
        .eq('question_id', question_id);
      const newCount = voteCount || 0;
      const promoted = newCount >= 5;
      await supabase.from('open_questions')
        .update({ vote_count: newCount, is_promoted: promoted })
        .eq('id', question_id);

      return res.json({
        success: true, vote_count: newCount, is_promoted: promoted,
        message: 'Vote removed.',
      });
    }

    return res.status(400).json({ error: 'action must be create, link, unlink, close, vote, or unvote' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
