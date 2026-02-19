const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  // CORS headers so the frontend can talk to the API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { feed, id, field, limit = 20, offset = 0 } = req.query;

  // GET single paper
  if (req.method === 'GET' && id) {
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

    return res.json({ paper, citations, reviews, fields });
  }

  // GET feed
  if (req.method === 'GET') {
    let query = supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
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

  return res.status(405).json({ error: 'Method not allowed' });
};
