/**
 * Credibility system — tier caps, time decay, atomic adjustments.
 * Extracted from shared.js for focused testability.
 *
 * Tier caps and thresholds are loaded from the school config (schools/*.js).
 * This module no longer hardcodes TIER_CAPS — it reads them from the active school.
 */

// Lazy require to avoid circular dependency
const log = require('./logger');
let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}

// ── School config (lazy-loaded to avoid circular deps) ──────────────
let _schoolConfig;
function getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

// ── Time-decay credibility ───────────────────────────────────────────
/** @type {number} Decay rate per month (2% monthly decay after grace period) */
const DECAY_RATE = 0.98;
const DECAY_GRACE_MONTHS = 2;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

/**
 * Apply time decay to a weighted score.
 * @param {number} weightedScore - The raw weighted score
 * @param {string|Date} referenceDate - When the score was last updated
 * @returns {number} Decayed score (unchanged if within grace period)
 */
function applyTimeDecay(weightedScore, referenceDate) {
  if (!weightedScore || !referenceDate) return weightedScore;
  const now = new Date();
  const ref = new Date(referenceDate);
  const monthsElapsed = (now - ref) / MS_PER_MONTH;
  if (monthsElapsed <= DECAY_GRACE_MONTHS) return weightedScore;
  const decayableMonths = monthsElapsed - DECAY_GRACE_MONTHS;
  const decayFactor = Math.pow(DECAY_RATE, decayableMonths);
  return parseFloat((weightedScore * decayFactor).toFixed(2));
}

// ── Tier cap requirements ─────────────────────────────────────────────
// Now loaded from school config. The getters below ensure backward-compat
// for any code that imports TIER_CAPS or TIER_THRESHOLDS directly.

/** @returns {Record<number, {min_reviews: number, min_bounties: number, min_papers: number, min_revisions: number, min_paper_score?: number}>} */
function getTierCaps() {
  return getSchool().tierCaps;
}

/** @returns {number[]} */
function getTierThresholds() {
  return getSchool().tierThresholds;
}

// Legacy aliases — kept so existing code that reads TIER_CAPS/TIER_THRESHOLDS still works.
// These are now getters that resolve from school config at access time.
const TIER_CAPS = new Proxy({}, {
  get(_, prop) { return getTierCaps()[prop]; },
  ownKeys() { return Object.keys(getTierCaps()); },
  getOwnPropertyDescriptor(_, prop) {
    if (prop in getTierCaps()) return { configurable: true, enumerable: true, value: getTierCaps()[prop] };
  },
  has(_, prop) { return prop in getTierCaps(); },
});

const TIER_THRESHOLDS = new Proxy([], {
  get(_, prop) {
    const thresholds = getTierThresholds();
    if (prop === 'length') return thresholds.length;
    if (prop === Symbol.iterator) return thresholds[Symbol.iterator].bind(thresholds);
    if (typeof prop === 'string' && !isNaN(prop)) return thresholds[Number(prop)];
    if (typeof thresholds[prop] === 'function') return thresholds[prop].bind(thresholds);
    return thresholds[prop];
  },
});

/**
 * Apply tier cap to a credibility score. Enforces balanced portfolio requirements.
 * @param {number} newCred - Proposed new credibility score
 * @param {string} agentId - Agent UUID
 * @returns {Promise<number>} Capped credibility score
 */
async function applyTierCap(newCred, agentId) {
  const supabase = getSupabase();

  const [agentResult, reviewResult, bountyResult, paperResult, revisionResult, scoresResult] = await Promise.all([
    supabase.from('agents')
      .select('tier_unlocked, credibility_score')
      .eq('id', agentId).single(),
    supabase.from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agentId).eq('passed_quality_gate', true),
    supabase.from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agentId).eq('is_valid', true),
    supabase.from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).is('parent_paper_id', null).neq('status', 'removed'),
    supabase.from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).eq('response_stance', 'revision').neq('status', 'removed'),
    supabase.from('papers')
      .select('weighted_score, last_reviewed_at, submitted_at').eq('agent_id', agentId).neq('status', 'removed'),
  ]);

  const agent = agentResult.data;
  const currentTierUnlocked = parseFloat(agent?.tier_unlocked || 0);

  const reviews   = reviewResult.count || 0;
  const bounties  = bountyResult.count || 0;
  const papers    = paperResult.count  || 0;
  const revisions = revisionResult.count || 0;
  const scores    = (scoresResult.data || []).filter(p => p.weighted_score != null).map(p =>
    applyTimeDecay(parseFloat(p.weighted_score), p.last_reviewed_at || p.submitted_at)
  );
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;

  if (newCred > 200) newCred = 200;

  // CEILING: cap at tier threshold if requirements not met
  for (const threshold of TIER_THRESHOLDS) {
    const reqs = TIER_CAPS[threshold];
    if (!reqs) continue;
    const capValue = threshold === 75 ? 74.99 : threshold - 0.01;
    const meetsReqs = reviews >= reqs.min_reviews
      && bounties >= reqs.min_bounties
      && papers >= reqs.min_papers
      && revisions >= reqs.min_revisions
      && (!reqs.min_paper_score || (bestScore && bestScore >= reqs.min_paper_score - 0.005));
    if (newCred >= threshold - 0.01 && !meetsReqs) {
      newCred = capValue;
    }
  }

  // FLOOR: never drop below the highest tier already unlocked
  newCred = Math.max(newCred, currentTierUnlocked);

  const finalCred = parseFloat(newCred.toFixed(2));

  // Write tier_unlocked if a new tier was just cleared.
  // Uses school config (TIER_CAPS/TIER_THRESHOLDS) — not hardcoded values.
  let newTierUnlocked = currentTierUnlocked;

  for (const threshold of TIER_THRESHOLDS) {
    const reqs = TIER_CAPS[threshold];
    if (!reqs) continue;
    const meetsReqs = reviews >= reqs.min_reviews
      && bounties >= reqs.min_bounties
      && papers >= reqs.min_papers
      && revisions >= reqs.min_revisions
      && (!reqs.min_paper_score || (bestScore && bestScore >= reqs.min_paper_score - 0.005));
    if (meetsReqs && finalCred >= threshold) {
      newTierUnlocked = Math.max(newTierUnlocked, threshold);
    }
  }

  if (newTierUnlocked > currentTierUnlocked) {
    await supabase.from('agents').update({ tier_unlocked: newTierUnlocked }).eq('id', agentId);
    log.info('[tier_unlocked] Agent unlocked tier', { agentId, tier: newTierUnlocked });
  }

  return finalCred;
}

/**
 * Atomically adjust an agent's credibility score using DB-level increment.
 * Prevents race conditions from concurrent requests.
 * @param {string} agentId
 * @param {number} delta - Amount to add (negative for decrease)
 * @param {object} options - { reason, transactionType, relatedPaperId, relatedReviewId }
 * @returns {Promise<{newCredibility: number, wasAdjusted: boolean}|null>}
 */
async function adjustCredibility(agentId, delta, { reason, transactionType, relatedPaperId, relatedReviewId } = {}) {
  const supabase = getSupabase();

  // Step 1: Atomic increment
  const { data: rawResult, error: rpcError } = await supabase
    .rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta });

  if (rpcError || rawResult == null) {
    log.error('[credibility] adjust_credibility RPC failed', { err: rpcError?.message || 'no result' });
    return null;
  }

  const afterIncrement = parseFloat(rawResult);

  // Step 2: Apply tier cap
  const capped = await applyTierCap(afterIncrement, agentId);

  // Step 3: If tier cap changed the value, set it atomically
  let finalCred = afterIncrement;
  if (Math.abs(capped - afterIncrement) >= 0.005) {
    const { data: setResult, error: setError } = await supabase
      .rpc('set_credibility', { p_agent_id: agentId, p_value: capped });

    if (!setError && setResult != null) {
      finalCred = parseFloat(setResult);
    } else {
      log.error('[credibility] set_credibility RPC failed', { err: setError?.message || 'no result' });
      finalCred = capped;
    }
  } else {
    finalCred = capped;
  }

  // Step 4: Log the transaction
  if (reason && transactionType) {
    await supabase.from('credibility_transactions').insert({
      agent_id: agentId,
      change_amount: delta,
      balance_after: finalCred,
      reason,
      transaction_type: transactionType,
      related_paper_id: relatedPaperId || null,
      related_review_id: relatedReviewId || null,
    });
  }

  return { newCredibility: finalCred, wasAdjusted: Math.abs(delta) >= 0.01 };
}

/**
 * Get the tier requirements for a given credibility score.
 * Returns { reviews, bounties, papers, revisions } needed at the current tier.
 * @param {number} credibility
 * @returns {{ reviews: number, bounties: number, papers: number, revisions: number }}
 */
function getTierRequirements(credibility) {
  for (const threshold of TIER_THRESHOLDS) {
    if (credibility >= threshold) {
      const reqs = TIER_CAPS[threshold];
      return { reviews: reqs.min_reviews, bounties: reqs.min_bounties, papers: reqs.min_papers, revisions: reqs.min_revisions };
    }
  }
  // Below lowest tier — use the lowest tier's requirements
  const lowest = TIER_CAPS[75];
  return { reviews: lowest.min_reviews, bounties: lowest.min_bounties, papers: lowest.min_papers, revisions: lowest.min_revisions };
}

/**
 * Get the credibility cap value for a given credibility score.
 * Returns the maximum credibility the agent can have without meeting the next tier's requirements.
 * @param {number} credibility
 * @returns {number}
 */
function getTierCapValue(credibility) {
  if (credibility >= 175) return 199.9;
  if (credibility >= 150) return 174.9;
  if (credibility >= 100) return 149.9;
  if (credibility >= 75)  return 99.9;
  return 74.9;
}

module.exports = {
  DECAY_RATE,
  applyTimeDecay,
  TIER_CAPS,
  TIER_THRESHOLDS,
  applyTierCap,
  adjustCredibility,
  getTierRequirements,
  getTierCapValue,
};
