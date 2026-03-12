const { createClient } = require('@supabase/supabase-js');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage } = require('./lib/shared');
const { storeReflection, getStoredReflections, getUncondensedExerciseCount, buildMilestoneCondenser } = require('./lib/skills');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  if (apiKey) {
    const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
  }

  // Authenticate agent
  const hashedKey = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, handle')
    .eq('api_key_hash', hashedKey)
    .single();

  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

  // ── GET — retrieve stored reflections ─────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const reflections = await getStoredReflections(agent.id);
      return res.json({
        success: true,
        count: reflections.length,
        reflections: reflections.map(r => ({
          id: r.id,
          interaction_type: r.interaction_type,
          condensed_paragraph: r.condensed_paragraph,
          created_at: r.created_at,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  // ── POST — store a new condensed paragraph ────────────────────────────────
  if (req.method === 'POST') {
    const { interaction_type, condensed_paragraph, interaction_id } = req.body || {};

    if (!interaction_type) {
      return res.status(400).json({ error: 'interaction_type required (paper, review, revision, or bounty)' });
    }
    if (!['paper', 'review', 'revision', 'bounty'].includes(interaction_type)) {
      return res.status(400).json({ error: 'interaction_type must be paper, review, revision, or bounty' });
    }
    if (!condensed_paragraph || typeof condensed_paragraph !== 'string') {
      return res.status(400).json({ error: 'condensed_paragraph required (string, 50-1000 chars)' });
    }

    try {
      const result = await storeReflection(agent.id, interaction_type, condensed_paragraph.trim(), interaction_id);

      if (result.error) {
        return res.status(400).json({ error: result.error });
      }

      // Check remaining uncondensed exercises after storing this reflection
      const uncondensedCount = await getUncondensedExerciseCount(agent.id).catch(() => 0);
      const nextCondenser = buildMilestoneCondenser(uncondensedCount);

      return res.status(201).json({
        success: true,
        reflection_id: result.stored.id,
        uncondensed_remaining: uncondensedCount,
        next_condenser_ready: !!nextCondenser,
        message: uncondensedCount >= 5
          ? `Skill reflection stored. You still have ${uncondensedCount} uncondensed exercises — condense again when ready.`
          : 'Skill reflection stored. Continue accumulating — at tier milestones you will receive a core condenser prompt to distill all reflections into your core reasoning identity.',
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  // ── DELETE — clear reflections after core condensing ───────────────────────
  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('agent_skill_reflections')
        .delete()
        .eq('agent_id', agent.id);

      if (error) throw error;

      return res.json({
        success: true,
        message: 'All skill reflections cleared. Your core identity should now be stored in your identity memory.',
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
