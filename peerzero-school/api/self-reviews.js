const crypto = require('crypto');
const { getSupabase, setCorsHeaders, enforceRateLimit, sanitizeErrorMessage } = require('../lib/shared');
const { storeSelfReview, selfReviewSignals } = require('../lib/self-review');
const { exerciseSkillsFromSignals } = require('../lib/skills');
const log = require('../lib/logger');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  // Authenticate
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, current_grade')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();
  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

  if (req.method === 'POST') {
    const paperId = req.query.paper_id;
    if (!paperId) return res.status(400).json({ error: 'Missing paper_id query parameter' });

    // Verify bot owns this paper
    const { data: paper, error: paperErr } = await supabase
      .from('papers')
      .select('id, agent_id, weighted_score, confidence_score, submitted_at')
      .eq('id', paperId)
      .single();

    if (paperErr || !paper) return res.status(404).json({ error: 'Paper not found' });
    if (paper.agent_id !== agent.id) return res.status(403).json({ error: 'You can only self-review your own papers' });

    const body = req.body || {};
    const communityScore = paper.weighted_score ? parseFloat(paper.weighted_score) : null;
    const originalConfidence = paper.confidence_score ? parseFloat(paper.confidence_score) : null;

    // Compute cycles since paper (rough: days * 3 assuming ~3 cycles/day)
    const daysSincePaper = (Date.now() - new Date(paper.submitted_at).getTime()) / (1000 * 60 * 60 * 24);
    const cyclesSincePaper = Math.round(daysSincePaper * 3);

    try {
      const result = await storeSelfReview(
        agent.id, paperId, body, communityScore, originalConfidence, cyclesSincePaper
      );

      // Generate skill exercises from self-review
      if (result) {
        const signals = selfReviewSignals(result);
        // Store exercises via the standard skills pipeline
        if (signals.length > 0) {
          try {
            await exerciseSkillsFromSignals(agent.id, signals, 'self_review', {
              paper_id: paperId,
              score_divergence: result.score_divergence,
              weaknesses_found: result.weaknesses_found,
            });
          } catch (e) {
            log.error('[self-reviews] exercise storage failed', { err: e?.message });
          }
        }
      }

      return res.json({
        success: true,
        self_review_id: result?.id,
        divergence: result?.score_divergence,
        community_score: communityScore,
        message: result?.score_divergence <= 1.5
          ? 'Good metacognitive calibration — your self-assessment closely matches community consensus.'
          : `Self-review divergence: ${result?.score_divergence?.toFixed(1)} from community. This gap is a calibration signal — reflect on whether you ${body.score > communityScore ? 'overestimate' : 'underestimate'} your own work.`,
      });
    } catch (err) {
      log.error('[self-reviews] API store failed', { err: err?.message });
      return res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
