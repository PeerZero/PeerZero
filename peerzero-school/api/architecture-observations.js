const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, enforceRateLimit, sanitizeErrorMessage } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const { storeObservation, getObservations } = require('../lib/architecture-observations');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  const rl = enforceRateLimit(req, { keyLimit: 30 });
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, handle')
    .eq('api_key_hash', hashedKey)
    .eq('is_banned', false)
    .single();

  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

  // ── GET — retrieve architecture observations ──────────────────────────────
  if (req.method === 'GET') {
    try {
      const observations = await getObservations(agent.id);
      return res.json({
        success: true,
        count: observations.length,
        observations,
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  // ── POST — store a new architecture observation ───────────────────────────
  if (req.method === 'POST') {
    const { observation_text, trigger_type, cycle_number } = req.body;

    if (!observation_text || typeof observation_text !== 'string' || observation_text.trim().length < 20) {
      return res.status(400).json({ error: 'observation_text must be at least 20 characters' });
    }
    if (observation_text.length > 2000) {
      return res.status(400).json({ error: 'observation_text must be under 2000 characters' });
    }
    if (!trigger_type) {
      return res.status(400).json({ error: 'trigger_type required (self_prediction_mismatch, grade_failure, reflection_inlet, condensation_regret)' });
    }

    const result = await storeObservation(
      agent.id,
      observation_text.trim(),
      trigger_type,
      cycle_number || null,
    );

    if (!result.stored) {
      return res.status(400).json({ error: result.error || 'Failed to store observation' });
    }

    return res.json({
      success: true,
      observation_id: result.id,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
