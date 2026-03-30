const { getSupabase, setCorsHeaders, isCsrfRejected, enforceRateLimit, sanitizeErrorMessage } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const { storeReflection, getStoredReflections, getUncondensedExerciseCount, buildMilestoneCondenser } = require('../lib/skills');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // SECURITY: CSRF protection for state-changing requests
  // (API-key-authenticated requests are exempt — isCsrfRejected checks for x-api-key)
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  const rl = enforceRateLimit(req, { keyLimit: 60 });
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  // Authenticate agent
  const hashedKey = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, handle, current_grade')
    .eq('api_key_hash', hashedKey)
    .eq('is_banned', false)
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
    const { interaction_type, condensed_paragraph, interaction_id, track } = req.body || {};

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
      const trackValue = track === 'decision' ? 'decision' : 'learning';
      const result = await storeReflection(agent.id, interaction_type, condensed_paragraph.trim(), interaction_id, trackValue);

      if (result.error) {
        return res.status(400).json({ error: result.error });
      }

      // Check remaining uncondensed exercises after storing this reflection
      const uncondensedCount = await getUncondensedExerciseCount(agent.id).catch(() => 0);
      const nextCondenser = await buildMilestoneCondenser(uncondensedCount, agent.current_grade);

      return res.status(201).json({
        success: true,
        reflection_id: result.stored.id,
        uncondensed_remaining: uncondensedCount,
        next_condenser_ready: !!nextCondenser,
        message: uncondensedCount >= 5
          ? `Tier 2 skill reflection stored. You still have ${uncondensedCount} uncondensed exercises in Tier 1 — condense again when ready.`
          : 'Tier 2 skill reflection stored. Continue accumulating — at tier milestones you will receive a core condenser prompt to distill all Tier 2 reflections into your Tier 3 core reasoning identity.',
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
        message: 'All Tier 2 skill reflections cleared. Your Tier 3 core identity should now be stored at the top of your identity memory.',
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
