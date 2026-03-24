/**
 * PeerZero Skill Profile Engine
 *
 * Tracks reasoning skills exercised through peer review.
 * All scoring internals loaded from server-side config at runtime.
 */

const crypto = require('crypto');
const { getSupabase } = require('./shared');

// ── Server-side internals cache ─────────────────────────────────────────────
// All formulas, thresholds, and prompt templates live in the school_internals
// table (Supabase, service-role only). Cached in-memory with TTL.
let _internalsCache = null;
let _internalsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getInternals() {
  const now = Date.now();
  if (_internalsCache && (now - _internalsCacheTime) < CACHE_TTL_MS) {
    return _internalsCache;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('school_internals')
    .select('key, value');

  if (error || !data) {
    if (_internalsCache) return _internalsCache; // stale cache fallback
    throw new Error('Failed to load school internals');
  }

  const internals = {};
  for (const row of data) {
    if (typeof row.value === 'string') {
      try {
        internals[row.key] = JSON.parse(row.value);
      } catch (e) {
        console.warn(`[skills] Failed to parse internals key "${row.key}":`, e?.message);
        internals[row.key] = row.value; // keep raw string as fallback
      }
    } else {
      internals[row.key] = row.value;
    }
  }

  _internalsCache = internals;
  _internalsCacheTime = now;
  return internals;
}

// For testing — allow cache invalidation
function clearInternalsCache() {
  _internalsCache = null;
  _internalsCacheTime = 0;
}

// ── Jitter: adds noise to thresholds per evaluation ─────────────────────────
function jitter(baseValue, range) {
  if (!range) return baseValue;
  return baseValue + (Math.random() * 2 - 1) * range;
}

// ── Ed25519 Profile Signing ─────────────────────────────────────────────────

let _signingKey = null;

function getSigningKey() {
  if (_signingKey !== undefined && _signingKey !== null) return _signingKey;
  const keyB64 = process.env.PROFILE_SIGNING_PRIVATE_KEY;
  if (!keyB64) {
    _signingKey = null;
    return null;
  }
  try {
    _signingKey = crypto.createPrivateKey({
      key: Buffer.from(keyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return _signingKey;
  } catch (err) {
    console.error('[signing] Failed to load signing key:', err.message);
    _signingKey = null;
    return null;
  }
}

function signPortableProfile(profile) {
  const key = getSigningKey();
  if (!key) return profile;

  const signedAt = new Date().toISOString();
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  const signature = crypto.sign(null, Buffer.from(canonical), key);

  // No expires_at — the profile's skill scores speak for themselves.
  // Credibility decay is reflected in the scores at fetch time.
  return {
    ...profile,
    signature: signature.toString('base64'),
    verification_url: (process.env.SCHOOL_PUBLIC_URL || 'https://peerzero.science') + '/.well-known/peerzero-public-key.pem',
    signed_at: signedAt,
  };
}

// ── Skill definitions (public metadata only — no scoring internals) ─────────
const SKILLS = {
  disconfirmation_search: {
    name: 'Disconfirmation Search',
    description: 'Actively searches for evidence against own position before committing to conclusions',
  },
  calibrated_uncertainty: {
    name: 'Calibrated Uncertainty',
    description: 'Confidence predictions match actual outcomes; names specific unknowns rather than hedging',
  },
  belief_updating: {
    name: 'Belief Updating',
    description: 'Explicitly revises prior positions when contradicted by stronger evidence',
  },
  source_evaluation: {
    name: 'Source Evaluation',
    description: 'Evaluates methodology, sample size, and replication status — not just whether a source exists',
  },
  adversarial_reasoning: {
    name: 'Adversarial Reasoning',
    description: 'Finds structural flaws in arguments, not surface errors; identifies what is missing, not just what is wrong',
  },
  independent_verification: {
    name: 'Independent Verification',
    description: 'Checks actual sources instead of trusting citation chains; verifies claims against primary evidence',
  },
};

// ── Internal scoring functions ──────────────────────────────────────────────

function updateEMA(currentEMA, newValue, alpha) {
  if (currentEMA === 0 && newValue > 0) return newValue;
  return alpha * newValue + (1 - alpha) * currentEMA;
}

function computeStrength(reliability, reps, targetReps, cfg) {
  const maturity = Math.min(Math.sqrt(reps) / Math.sqrt(targetReps), 1.0);
  const scale = (cfg && cfg.scale) || 100;
  const dp = (cfg && cfg.decimal_places) || 1;
  const raw = reliability * maturity * scale;
  const factor = Math.pow(10, dp);
  return Math.round(raw * factor) / factor;
}

function addEvidence(existing, newEntry, maxSize) {
  const trail = Array.isArray(existing) ? [...existing] : [];
  trail.unshift(newEntry);
  return trail.slice(0, maxSize);
}

// ── Core: record a skill exercise ───────────────────────────────────────────

async function recordSkillExercise(agentId, skillKey, hit, evidence) {
  const supabase = getSupabase();
  const def = SKILLS[skillKey];
  if (!def) return;

  const cfg = await getInternals();
  const alpha = cfg.ema_alpha || 0.15;
  const targetReps = (cfg.target_reps && cfg.target_reps[skillKey]) || 15;
  const trailSize = cfg.evidence_trail_size || 5;
  const strengthCfg = cfg.strength_formula || {};

  const { data: existing } = await supabase
    .from('agent_skill_profiles')
    .select('*')
    .eq('agent_id', agentId)
    .eq('skill_key', skillKey)
    .single();

  const now = new Date().toISOString();
  const hitValue = hit ? 1.0 : 0.0;

  if (existing) {
    const newReps = existing.reps + 1;
    const newHits = existing.hits + (hit ? 1 : 0);
    const newReliability = updateEMA(parseFloat(existing.reliability) || 0, hitValue, alpha);
    const newStrength = computeStrength(newReliability, newReps, targetReps, strengthCfg);
    const newStreak = hit ? (existing.streak + 1) : 0;
    const newBestStreak = Math.max(existing.best_streak, newStreak);
    const newEvidence = addEvidence(existing.recent_evidence, evidence, trailSize);

    await supabase
      .from('agent_skill_profiles')
      .update({
        reps: newReps,
        hits: newHits,
        reliability: parseFloat(newReliability.toFixed(3)),
        strength: newStrength,
        streak: newStreak,
        best_streak: newBestStreak,
        last_exercised: now,
        recent_evidence: newEvidence,
        updated_at: now,
      })
      .eq('id', existing.id);
  } else {
    const newReliability = hitValue;
    const newStrength = computeStrength(newReliability, 1, targetReps, strengthCfg);

    await supabase
      .from('agent_skill_profiles')
      .insert({
        agent_id: agentId,
        skill_key: skillKey,
        reps: 1,
        hits: hit ? 1 : 0,
        reliability: parseFloat(newReliability.toFixed(3)),
        strength: newStrength,
        streak: hit ? 1 : 0,
        best_streak: hit ? 1 : 0,
        last_exercised: now,
        first_exercised: now,
        recent_evidence: [evidence],
      });
  }
}

module.exports = {
  SKILLS,
  getInternals,
  clearInternalsCache,
  jitter,
  signPortableProfile,
  updateEMA,
  computeStrength,
  addEvidence,
  recordSkillExercise,
};
