/**
 * Architecture observation store — bot-noticed friction in their own design.
 *
 * Outside the condensation cascade. NOT L1. Does not condense.
 * Does not clear on grade failure. Persists until a methodology
 * paper with field_id matching the Architecture field is submitted.
 *
 * Max 10 per agent: oldest deleted before new one inserts.
 */

const log = require('./logger');

let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}

const MAX_OBSERVATIONS_PER_AGENT = 10;

const VALID_TRIGGER_TYPES = new Set([
  'self_prediction_mismatch',
  'grade_failure',
  'reflection_inlet',
  'condensation_regret',
]);

/**
 * Store an architecture observation. Enforces max-10 cap per agent.
 * @param {string} agentId
 * @param {string} observationText
 * @param {string} triggerType
 * @param {number|null} cycleNumber
 * @returns {Promise<{stored: boolean, id?: string}>}
 */
async function storeObservation(agentId, observationText, triggerType, cycleNumber = null) {
  if (!VALID_TRIGGER_TYPES.has(triggerType)) {
    return { stored: false, error: `Invalid trigger_type: ${triggerType}` };
  }

  const supabase = getSupabase();

  try {
    // Enforce max-10 cap: count existing, delete oldest if at limit
    const { count } = await supabase
      .from('bot_architecture_observations')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);

    if (count >= MAX_OBSERVATIONS_PER_AGENT) {
      // Delete the oldest entry to make room
      const { data: oldest } = await supabase
        .from('bot_architecture_observations')
        .select('id')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (oldest && oldest.length > 0) {
        await supabase
          .from('bot_architecture_observations')
          .delete()
          .eq('id', oldest[0].id);
      }
    }

    const { data, error } = await supabase
      .from('bot_architecture_observations')
      .insert({
        agent_id: agentId,
        observation_text: observationText,
        trigger_type: triggerType,
        cycle_number: cycleNumber,
      })
      .select('id')
      .single();

    if (error) throw error;

    log.info('[arch_obs] Stored observation', { agentId: agentId.slice(0, 8), triggerType });
    return { stored: true, id: data.id };
  } catch (err) {
    log.error('[arch_obs] Store failed', { err: err?.message });
    return { stored: false };
  }
}

/**
 * Get all architecture observations for an agent, ordered by creation time.
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
async function getObservations(agentId) {
  const supabase = getSupabase();
  try {
    const { data } = await supabase
      .from('bot_architecture_observations')
      .select('id, observation_text, trigger_type, cycle_number, created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: true });
    return data || [];
  } catch (err) {
    log.error('[arch_obs] Fetch failed', { err: err?.message });
    return [];
  }
}

/**
 * Get count of architecture observations for an agent.
 * @param {string} agentId
 * @returns {Promise<number>}
 */
async function getObservationCount(agentId) {
  const supabase = getSupabase();
  try {
    const { count } = await supabase
      .from('bot_architecture_observations')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);
    return count || 0;
  } catch (err) {
    log.error('[arch_obs] Count failed', { err: err?.message });
    return 0;
  }
}

/**
 * Clear all architecture observations for an agent.
 * Called when a methodology paper with Architecture field is submitted.
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function clearObservations(agentId) {
  const supabase = getSupabase();
  try {
    await supabase
      .from('bot_architecture_observations')
      .delete()
      .eq('agent_id', agentId);
    log.info('[arch_obs] Cleared observations', { agentId: agentId.slice(0, 8) });
  } catch (err) {
    log.error('[arch_obs] Clear failed', { err: err?.message });
  }
}

module.exports = {
  storeObservation,
  getObservations,
  getObservationCount,
  clearObservations,
  VALID_TRIGGER_TYPES,
};
