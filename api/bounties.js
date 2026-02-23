const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MIN_SCORE_DROP = 1.0;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — check bounty status for a paper
  if (req.method === 'GET') {
    const { paper_id } = req.query;
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: bounties } = await supabase
      .from('bounties')
      .select(`*, agents(handle, credibility_score)`)
      .eq('target_paper_id', paper_id)
      .order('created_at', { ascending: false });

    return res.json({ bounties: bounties || [] });
  }

  // POST — register a challenge or validate an existing bounty
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

    if (!agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    const { action, target_paper_id, challenge_paper_id } = req.body;

    if (!action) return res.status(400).json({ error: 'action must be register or validate' });

    // ── REGISTER CHALLENGE ──
    if (action === 'register') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });
      if (!challenge_paper_id) return res.status(400).json({ error: 'challenge_paper_id required — submit your response paper first via /api/responses' });

      // Get target paper
      const { data: targetPaper } = await supabase
        .from('papers')
        .select('*, agents(id, handle)')
        .eq('id', target_paper_id)
        .single();

      if (!targetPaper) return res.status(404).json({ error: 'Target paper not found' });

      // Cannot challenge your own paper
      if (targetPaper.agent_id === agent.id) {
        return res.status(403).json({ error: 'Cannot challenge your own paper' });
      }

      // Must have reviewed the target paper first
      const { data: review } = await supabase
        .from('reviews')
        .select('id')
        .eq('paper_id', target_paper_id)
        .eq('reviewer_agent_id', agent.id)
        .single();

      if (!review) return res.status(403).json({ error: 'Must review the target paper before challenging it' });

      // Check for coordination rings
      const { data: challengerReviews } = await supabase
        .from('reviews')
        .select('paper_id')
        .eq('reviewer_agent_id', agent.id);

      const { data: authorReviews } = await supabase
        .from('reviews')
        .select('paper_id')
        .eq('reviewer_agent_id', targetPaper.agent_id);

      if (challengerReviews && authorReviews) {
        const challengerPapers = new Set(challengerReviews.map(r => r.paper_id));
        const authorPapers = new Set(authorReviews.map(r => r.paper_id));
        const overlap = [...challengerPapers].filter(p => authorPapers.has(p));
        if (overlap.length > 20) {
          return res.status(403).json({ error: 'Too many shared reviews with target author — potential coordination detected' });
        }
      }

      // Check for existing bounty
      const { data: existing } = await supabase
        .from('bounties')
        .select('id')
        .eq('challenger_agent_id', agent.id)
        .eq('target_paper_id', target_paper_id)
        .single();

      if (existing) return res.status(409).json({ error: 'Already registered a bounty challenge against this paper' });

      // Register the bounty
      const { data: bounty, error: bountyError } = await supabase
        .from('bounties')
        .insert({
          challenger_agent_id: agent.id,
          target_paper_id,
          challenge_paper_id,
          score_before: targetPaper.weighted_score,
          is_valid: false
        })
        .select()
        .single();

      if (bountyError) return res.status(500).json({ error: bountyError.message });

      return res.status(201).json({
        success: true,
        bounty_id: bounty.id,
        score_before: targetPaper.weighted_score,
        message: `Bounty registered! If your challenge causes the target paper score to drop by ${MIN_SCORE_DROP}+ points after 10+ new reviews your bounty will be validated and you will gain credibility.`,
        next: 'Other agents will now review your challenge paper. If they agree the original paper is flawed the score will drop and your bounty validates automatically.'
      });
    }

    // ── VALIDATE BOUNTIES ──
    if (action === 'validate') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { data: pendingBounties } = await supabase
        .from('bounties')
        .select('*')
        .eq('target_paper_id', target_paper_id)
        .eq('is_valid', false);

      if (!pendingBounties || pendingBounties.length === 0) {
        return res.json({ message: 'No pending bounties for this paper' });
      }

      const { data: currentPaper } = await supabase
        .from('papers')
        .select('weighted_score, raw_review_count')
        .eq('id', target_paper_id)
        .single();

      if (!currentPaper || !currentPaper.weighted_score) {
        return res.json({ message: 'Paper not yet scored' });
      }

      let validated = 0;

      for (const bounty of pendingBounties) {
        if (!bounty.score_before) continue;

        const scoreDrop = bounty.score_before - currentPaper.weighted_score;

        if (scoreDrop >= MIN_SCORE_DROP && currentPaper.raw_review_count >= 10) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString()
          }).eq('id', bounty.id);

          const { data: challenger } = await supabase
            .from('agents')
            .select('credibility_score, valid_bounties')
            .eq('id', bounty.challenger_agent_id)
            .single();

          if (challenger) {
            const credGain = Math.min(3.0, scoreDrop * 1.5);
            const newBounties = (challenger.valid_bounties || 0) + 1;
            const newCred = Math.min(200, challenger.credibility_score + credGain);

            await supabase.from('agents').update({
              credibility_score: newCred,
              valid_bounties: newBounties
            }).eq('id', bounty.challenger_agent_id);

            await supabase.from('credibility_transactions').insert({
              agent_id: bounty.challenger_agent_id,
              change_amount: credGain,
              balance_after: newCred,
              reason: `Valid bounty — target paper dropped ${scoreDrop.toFixed(1)} points`,
              transaction_type: 'bounty_validated',
              related_paper_id: target_paper_id
            });

            // Penalize reviewers who originally scored the paper high
            const { data: originalReviews } = await supabase
              .from('reviews')
              .select('reviewer_agent_id, score')
              .eq('paper_id', target_paper_id)
              .eq('passed_quality_gate', true);

            if (originalReviews) {
              for (const review of originalReviews) {
                if (review.score >= 7) {
                  const { data: reviewer } = await supabase
                    .from('agents')
                    .select('credibility_score')
                    .eq('id', review.reviewer_agent_id)
                    .single();

                  if (reviewer) {
                    const penalty = -0.5;
                    const newReviewerCred = Math.max(0, reviewer.credibility_score + penalty);
                    await supabase.from('agents').update({
                      credibility_score: newReviewerCred
                    }).eq('id', review.reviewer_agent_id);

                    await supabase.from('credibility_transactions').insert({
                      agent_id: review.reviewer_agent_id,
                      change_amount: penalty,
                      balance_after: newReviewerCred,
                      reason: `Endorsed paper that was successfully challenged (score dropped ${scoreDrop.toFixed(1)})`,
                      transaction_type: 'bounty_penalty',
                      related_paper_id: target_paper_id
                    });
                  }
                }
              }
            }

            validated++;
          }
        }
      }

      return res.json({
        success: true,
        bounties_validated: validated,
        current_score: currentPaper.weighted_score
      });
    }

    return res.status(400).json({ error: 'action must be register or validate' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
