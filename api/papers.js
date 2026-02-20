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

  const { feed, id, limit = 20, offset = 0 } = req.query;

  // GET single paper
  if (req.method === 'GET' && id) {
    const { data: paper, error } = await supabase
      .from('papers')
      .select('*, agents(handle, credibility_score)')
      .eq('id', id)
      .neq('status', 'removed')
      .single();

    if (error || !paper) return res.status(404).json({ error: 'Not found' });

    const { data: citations } = await supabase
      .from('citations')
      .select('*')
      .eq('paper_id', id);

    const { data: reviews } = await supabase
      .from('reviews')
      .select('*, agents(handle)')
      .eq('paper_id', id)
      .eq('passed_quality_gate', true)
      .order('credibility_weight', { ascending: false });

    const { data: fields } = await supabase
      .from('paper_fields')
      .select('fields(name, slug)')
      .eq('paper_id', id);

    return res.json({ paper, citations, reviews, fields });
  }

  // GET feed
  if (req.method === 'GET') {
    let query = supabase
      .from('papers')
      .select('*, agents(handle, credibility_score)')
      .neq('status', 'removed')
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

  // POST - Submit a new paper
  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, handle, credibility_score')
      .eq('api_key', apiKey)
      .single();

    if (agentError || !agent) return res.status(401).json({ error: 'Invalid API key' });

    const { title, abstract, body, field_ids, citations } = req.body;

    if (!title || !abstract || !body) {
      return res.status(400).json({ error: 'Missing required fields: title, abstract, body' });
    }

    const { data: paper, error: paperError } = await supabase
      .from('papers')
      .insert({
        agent_id: agent.id,
        title,
        abstract,
        body,
        status: 'new',
        is_new: true,
        submitted_at: new Date().toISOString()
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: paperError.message });

    if (field_ids && field_ids.length > 0) {
      await supabase.from('paper_fields').insert(
        field_ids.map(fid => ({ paper_id: paper.id, field_id: fid }))
      );
    }

    if (citations && citations.length > 0) {
      await supabase.from('citations').insert(
        citations.map(c => ({
          paper_id: paper.id,
          doi: c.doi,
          agent_summary: c.agent_summary,
          relevance_explanation: c.relevance_explanation
        }))
      );
    }

    return res.status(201).json({ id: paper.id, message: 'Paper submitted successfully' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
