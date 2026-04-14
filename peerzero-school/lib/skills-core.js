/**
 * PeerZero Skill Profile Engine
 *
 * Tracks reasoning skills exercised through peer review.
 * All scoring internals loaded from server-side config at runtime.
 */

const crypto = require('crypto');
const { getSupabase } = require('./shared');
const log = require('./logger');

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
        log.warn('[skills] Failed to parse internals key', { key: row.key, err: e?.message });
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
    log.error('[signing] Failed to load signing key', { err: err.message });
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

// ── School config (lazy-loaded) ─────────────────────────────────────────
let _schoolConfig;
function _getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

// Skill definitions from school config. Converts array format to object keyed by skill key.
function getSkillDefinitions() {
  const school = _getSchool();
  const defs = {};
  for (const s of school.skills) {
    defs[s.key] = { name: s.name, description: s.description };
  }
  return defs;
}

// Legacy alias — backward-compatible Proxy so existing SKILLS[key] access works
const SKILLS = new Proxy({}, {
  get(_, prop) { return getSkillDefinitions()[prop]; },
  ownKeys() { return Object.keys(getSkillDefinitions()); },
  getOwnPropertyDescriptor(_, prop) {
    const defs = getSkillDefinitions();
    if (prop in defs) return { configurable: true, enumerable: true, value: defs[prop] };
  },
  has(_, prop) { return prop in getSkillDefinitions(); },
});

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
    .select('id, reps, hits, reliability, streak, best_streak, recent_evidence')
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

// ── Batch: record multiple skill exercises for one agent ────────────────────
// Reduces N+1 queries to 2 queries (1 read + 1 write per distinct skill).
// Each entry: { skillKey, hit, evidence }

async function recordSkillExercisesBatch(agentId, exercises) {
  if (!exercises || exercises.length === 0) return;

  const supabase = getSupabase();
  const cfg = await getInternals();
  const alpha = cfg.ema_alpha || 0.15;
  const trailSize = cfg.evidence_trail_size || 5;
  const strengthCfg = cfg.strength_formula || {};

  // Deduplicate: group exercises by skillKey (in case the same skill appears multiple times)
  const bySkill = {};
  for (const ex of exercises) {
    const def = SKILLS[ex.skillKey];
    if (!def) continue;
    if (!bySkill[ex.skillKey]) bySkill[ex.skillKey] = [];
    bySkill[ex.skillKey].push(ex);
  }

  const skillKeys = Object.keys(bySkill);
  if (skillKeys.length === 0) return;

  // Single query: fetch all existing profiles for this agent + these skills
  const { data: existingProfiles } = await supabase
    .from('agent_skill_profiles')
    .select('id, skill_key, reps, hits, reliability, streak, best_streak, recent_evidence')
    .eq('agent_id', agentId)
    .in('skill_key', skillKeys);

  const profileMap = {};
  for (const p of (existingProfiles || [])) {
    profileMap[p.skill_key] = p;
  }

  const now = new Date().toISOString();
  const updates = [];
  const inserts = [];

  for (const skillKey of skillKeys) {
    const targetReps = (cfg.target_reps && cfg.target_reps[skillKey]) || 15;
    let existing = profileMap[skillKey] || null;

    // Apply each exercise for this skill sequentially (maintains EMA/streak correctness)
    for (const ex of bySkill[skillKey]) {
      const hitValue = ex.hit ? 1.0 : 0.0;

      if (existing) {
        existing = {
          ...existing,
          reps: existing.reps + 1,
          hits: existing.hits + (ex.hit ? 1 : 0),
          reliability: updateEMA(parseFloat(existing.reliability) || 0, hitValue, alpha),
          streak: ex.hit ? (existing.streak + 1) : 0,
          best_streak: Math.max(existing.best_streak, ex.hit ? (existing.streak + 1) : 0),
          recent_evidence: addEvidence(existing.recent_evidence, ex.evidence, trailSize),
        };
        existing.strength = computeStrength(existing.reliability, existing.reps, targetReps, strengthCfg);
      } else {
        // First exercise for this skill — create in-memory record
        const newReliability = hitValue;
        existing = {
          id: null, // will be inserted
          skill_key: skillKey,
          reps: 1,
          hits: ex.hit ? 1 : 0,
          reliability: newReliability,
          strength: computeStrength(newReliability, 1, targetReps, strengthCfg),
          streak: ex.hit ? 1 : 0,
          best_streak: ex.hit ? 1 : 0,
          recent_evidence: [ex.evidence],
        };
      }
    }

    // Decide if this is an update or insert
    if (profileMap[skillKey]) {
      updates.push({
        profileId: profileMap[skillKey].id,
        data: {
          reps: existing.reps,
          hits: existing.hits,
          reliability: parseFloat(existing.reliability.toFixed(3)),
          strength: existing.strength,
          streak: existing.streak,
          best_streak: existing.best_streak,
          last_exercised: now,
          recent_evidence: existing.recent_evidence,
          updated_at: now,
        },
      });
    } else {
      inserts.push({
        agent_id: agentId,
        skill_key: skillKey,
        reps: existing.reps,
        hits: existing.hits,
        reliability: parseFloat(existing.reliability.toFixed(3)),
        strength: existing.strength,
        streak: existing.streak,
        best_streak: existing.best_streak,
        last_exercised: now,
        first_exercised: now,
        recent_evidence: existing.recent_evidence,
      });
    }
  }

  // Batch insert new profiles (single query)
  if (inserts.length > 0) {
    await supabase.from('agent_skill_profiles').insert(inserts);
  }

  // Updates must still be individual (Supabase doesn't support multi-row update by different IDs)
  // but we run them in parallel instead of sequentially
  if (updates.length > 0) {
    await Promise.all(updates.map(u =>
      supabase.from('agent_skill_profiles').update(u.data).eq('id', u.profileId)
    ));
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
  recordSkillExercisesBatch,
};
