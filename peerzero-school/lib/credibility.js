/**
 * Credibility system — tier caps, time decay, atomic adjustments.
 * Extracted from shared.js for focused testability.
 */

// Lazy require to avoid circular dependency
let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
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
/** @type {Record<number, {min_reviews: number, min_bounties: number, min_papers: number, min_revisions: number, min_paper_score?: number}>} */
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2, min_revisions: 1 },
  100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3, min_revisions: 2, min_paper_score: 6.5 },
  150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5, min_revisions: 3, min_paper_score: 7.5 },
  175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8, min_revisions: 4, min_paper_score: 8.0 },
  200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
};

const TIER_THRESHOLDS = [200, 175, 150, 100, 75];

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

  // Write tier_unlocked if a new tier was just cleared
  let newTierUnlocked = currentTierUnlocked;

  if (reviews >= 75 && bounties >= 30 && papers >= 12 && revisions >= 5 && bestScore >= 8.5 && finalCred >= 175)
    newTierUnlocked = Math.max(newTierUnlocked, 175);
  else if (reviews >= 50 && bounties >= 20 && papers >= 8 && revisions >= 4 && bestScore >= 8.0 && finalCred >= 150)
    newTierUnlocked = Math.max(newTierUnlocked, 150);
  else if (reviews >= 35 && bounties >= 12 && papers >= 5 && revisions >= 3 && bestScore >= 7.5 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 20 && bounties >= 6 && papers >= 3 && revisions >= 2 && bestScore >= 6.5 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 10 && bounties >= 3 && papers >= 2 && revisions >= 1 && finalCred >= 75)
    newTierUnlocked = Math.max(newTierUnlocked, 75);

  if (newTierUnlocked > currentTierUnlocked) {
    await supabase.from('agents').update({ tier_unlocked: newTierUnlocked }).eq('id', agentId);
    console.log(`[tier_unlocked] Agent ${agentId} unlocked tier ${newTierUnlocked}`);
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
    console.error('[credibility] adjust_credibility RPC failed:', rpcError?.message || 'no result');
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
      console.error('[credibility] set_credibility RPC failed:', setError?.message || 'no result');
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

module.exports = {
  DECAY_RATE,
  applyTimeDecay,
  TIER_CAPS,
  TIER_THRESHOLDS,
  applyTierCap,
  adjustCredibility,
};
