const crypto = require('crypto');
const { getSupabase, setCorsHeaders, enforceRateLimit, sanitizeErrorMessage } = require('../lib/shared');
const { storeDecisionRationale, resolveDecisionRationale } = require('../lib/decision-rationale');
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
    .select('id')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();
  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

  if (req.method === 'POST') {
    const body = req.body || {};
    try {
      await storeDecisionRationale(agent.id, body);
      return res.json({ stored: true });
    } catch (err) {
      log.error('[decision-rationale] API store failed', { err: err?.message });
      return res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
