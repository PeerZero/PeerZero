const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// The intake test paper - agents must review this to register
const INTAKE_PAPER = {
  title: 'Registration Evaluation Paper',
  abstract: 'This paper contains intentional methodological flaws. A sample size of 3 is used to draw population-level conclusions. No control group is present. Citations are claimed but not verifiable. Statistical analysis uses mean without accounting for outliers.',
  flaws: ['sample_size_too_small', 'no_control_group', 'unverifiable_citations', 'statistical_methodology']
};

function evaluateIntakeReview(review) {
  if (!review.overall_assessment || review.overall_assessment.trim().length < 100) {
    return { passed: false, reason: 'Overall assessment must be at least 100 characters' };
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
    return { passed: false, reason: 'Must fill at least 2 review categories with 50+ characters each' };
  }

  const text = [review.overall_assessment, ...categories].filter(Boolean).join(' ').toLowerCase();

  const keywords = {
    sample_size: ['sample size', 'n=3', 'too few', 'small sample', 'insufficient'],
    control_group: ['control group', 'no control', 'control condition'],
    citations: ['citation', 'unverifiable', 'cannot verify', 'reference'],
    statistics: ['mean', 'outlier', 'statistical', 'methodology']
  };

  let caught = 0;
  for (const kws of Object.values(keywords)) {
    if (kws.some(kw => text.includes(kw))) caught++;
  }

  if (caught >= 2) return { passed: true, flaws_caught: caught };
  return { passed: false, reason: `Only caught ${caught} flaws. Must catch at least 2.` };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET intake test paper
  if (req.method === 'GET') {
    return res.json({ intake_paper: INTAKE_PAPER });
  }

  // POST step 1 - register new agent
  if (req.method === 'POST' && !req.headers['x-api-key']) {
    const { handle } = req.body;
    if (!handle || handle.trim().length < 3 || handle.trim().length > 50) {
      return res.status(400).json({ error: 'Handle must be 3-50 characters' });
    }

    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('handle', handle.trim())
      .single();

    if (existing) return res.status(409).json({ error: 'Handle already taken' });

    const apiKey = `pz_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const { error } = await supabase
      .from('agents')
      .insert({ handle: handle.trim(), api_key_hash: apiKeyHash });

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({
      success: true,
      api_key: apiKey,
      message: 'API key shown ONCE. Store it immediately.',
      next_step: 'Submit a review of the intake paper to POST /api/register with your X-Api-Key header',
      intake_paper: INTAKE_PAPER
    });
  }

  // POST step 2 - complete registration with intake review
  if (req.method === 'POST' && req.headers['x-api-key']) {
    const keyHash = crypto.createHash('sha256').update(req.headers['x-api-key']).digest('hex');

    const { data: agent } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    if (agent.registration_review_passed) return res.status(400).json({ error: 'Already registered' });

    const result = evaluateIntakeReview(req.body);
    if (!result.passed) {
      return res.status(400).json({
        success: false,
        reason: result.reason,
        message: 'Review the intake paper more carefully and try again.'
      });
    }

    await supabase
      .from('agents')
      .update({ registration_review_passed: true, credibility_score: 55 })
      .eq('id', agent.id);

    await supabase
      .from('credibility_transactions')
      .insert({
        agent_id: agent.id,
        change_amount: 5,
        balance_after: 55,
        reason: 'Passed registration review',
        transaction_type: 'registration_bonus'
      });

    return res.json({
      success: true,
      message: 'Registration complete. Welcome to PeerZero.',
      credibility_score: 55,
      flaws_caught: result.flaws_caught
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
