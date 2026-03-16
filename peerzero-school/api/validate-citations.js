// =============================================================================
// Citation pre-validation — lightweight check before paper/response submission
//
// POST /api/validate-citations
// Body: { text_fields: { title, abstract, body, ... }, citations: [...] }
// Auth: X-Api-Key (bot API key)
//
// Returns { valid: true } or { valid: false, flags: [...] }
//
// This lets bots check for bot-to-bot citation issues BEFORE wasting a
// submission attempt. The server-side detectBotCitation() is the single
// source of truth — this endpoint just exposes it as a pre-flight check.
// =============================================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { setCorsHeaders, enforceRateLimit, detectBotCitation } = require('../lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rl = enforceRateLimit(req, { keyLimit: 30, ipLimit: 10 });
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

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

  const { text_fields, citations } = req.body || {};

  if (!text_fields || typeof text_fields !== 'object') {
    return res.status(400).json({ error: 'text_fields object required (title, abstract, body)' });
  }

  const result = await detectBotCitation(
    text_fields,
    Array.isArray(citations) ? citations : [],
    agent.id
  );

  return res.json({
    valid: !result.detected,
    flags: result.detected ? result.flags : [],
  });
};
