/**
 * Rate limiting — in-memory pre-filter + DB-backed persistence.
 * Extracted from shared.js for focused testability.
 */

// Lazy require to avoid circular dependency (getSupabase is in shared.js)
const log = require('./logger');
let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}

// ── In-memory rate limiter (per Vercel instance) ─────────────────────
// NOTE: Resets on cold starts. Serves as a fast first-pass burst filter.
// For durable rate limiting, use isRateLimitedDb() or enforceRateLimitDb().
const rateBuckets = {};
const RATE_CLEANUP_INTERVAL = 60000;
const MAX_RATE_BUCKETS = 10_000;

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateBuckets)) {
    if (now - rateBuckets[key].windowStart > 120000) {
      delete rateBuckets[key];
    }
  }
  // Safety cap: if buckets exceed limit after TTL cleanup, evict oldest
  const keys = Object.keys(rateBuckets);
  if (keys.length > MAX_RATE_BUCKETS) {
    keys.sort((a, b) => rateBuckets[a].windowStart - rateBuckets[b].windowStart);
    const toRemove = keys.length - MAX_RATE_BUCKETS;
    for (let i = 0; i < toRemove; i++) delete rateBuckets[keys[i]];
  }
}, RATE_CLEANUP_INTERVAL);

/**
 * In-memory sliding window rate limiter.
 * @param {string} identifier - Unique key for the rate limit bucket
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Window size in milliseconds
 * @returns {boolean} true if rate limited
 */
function isRateLimited(identifier, maxRequests = 60, windowMs = 60000) {
  // SECURITY: Sanity-check rate limit values at call time to catch misconfigurations early
  if (!Number.isFinite(maxRequests) || maxRequests < 1 || maxRequests > 100000) {
    log.error('[rate_limit] Invalid maxRequests value, using default', { maxRequests });
    maxRequests = 60;
  }
  if (!Number.isFinite(windowMs) || windowMs < 1000 || windowMs > 86400000) {
    log.error('[rate_limit] Invalid windowMs value, using default', { windowMs });
    windowMs = 60000;
  }
  const now = Date.now();
  if (!rateBuckets[identifier]) {
    rateBuckets[identifier] = { count: 1, windowStart: now };
    return false;
  }
  const bucket = rateBuckets[identifier];
  if (now - bucket.windowStart > windowMs) {
    bucket.count = 1;
    bucket.windowStart = now;
    return false;
  }
  bucket.count++;
  return bucket.count > maxRequests;
}

/**
 * DB-backed rate limiter (survives cold starts, shared across instances).
 * Falls back to allowing the request if the DB query fails (fail-open).
 * @param {string} agentId
 * @param {string} action
 * @param {number} maxRequests
 * @param {number} windowMs
 * @returns {Promise<boolean>} true if rate limited
 */
async function isRateLimitedDb(agentId, action, maxRequests, windowMs) {
  try {
    const supabase = getSupabase();
    const since = new Date(Date.now() - windowMs).toISOString();
    const { count, error } = await supabase
      .from('rate_limit_log')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('action', action)
      .gte('created_at', since);

    if (error) {
      log.error('[rate_limit_db] Query failed, allowing request', { err: error.message });
      return false;
    }
    return (count || 0) >= maxRequests;
  } catch (err) {
    log.error('[rate_limit_db] Exception, allowing request', { err: err?.message });
    return false;
  }
}

/**
 * Log a rate-limited action to the DB (call after the action succeeds).
 * @param {string} agentId
 * @param {string} action
 */
let _lastRateLimitPurge = 0;
const RATE_LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

async function logRateLimitedAction(agentId, action) {
  try {
    const supabase = getSupabase();
    await supabase.from('rate_limit_log').insert({ agent_id: agentId, action });
    // Periodic purge: delete entries older than 90 days (at most once per day per instance)
    const now = Date.now();
    if (now - _lastRateLimitPurge > RATE_LOG_PURGE_INTERVAL_MS) {
      _lastRateLimitPurge = now;
      const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
      supabase.from('rate_limit_log').delete().lt('created_at', cutoff)
        .then(({ error }) => { if (error) log.warn('[rate_limit_db] Purge failed', { err: error.message }); })
        .catch(err => log.debug('[rate_limit_db] Purge cleanup error', { err: err?.message }));
    }
  } catch (err) {
    log.error('[rate_limit_db] Log failed', { err: err?.message });
  }
}

/**
 * Get client IP from request headers.
 * @param {object} req
 * @returns {string}
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || 'unknown';
}

/**
 * Enforce rate limiting for a request. Uses API key hash if present, falls back to IP.
 * Two-layer strategy: in-memory pre-filter + DB-backed persistence.
 * @param {object} req
 * @param {object} options
 * @returns {{ limited: boolean, response?: { status: number, body: object } }}
 */
function enforceRateLimit(req, { keyLimit = 300, keyWindowMs = 60000, ipLimit = 60, ipWindowMs = 60000 } = {}) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const crypto = require('crypto');
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, keyLimit, keyWindowMs)) {
      return { limited: true, response: { status: 429, body: { error: 'Too many requests for this API key.' } } };
    }
  } else {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp, ipLimit, ipWindowMs)) {
      return { limited: true, response: { status: 429, body: { error: 'Too many requests. Please wait a moment.' } } };
    }
  }
  return { limited: false };
}

/**
 * Enforce rate limiting with DB persistence (survives cold starts, shared across instances).
 * Use for authenticated agent requests where agentId is known.
 * @param {string} agentId
 * @param {string} action
 * @param {object} options
 * @returns {Promise<{ limited: boolean, response?: { status: number, body: object } }>}
 */
async function enforceRateLimitDb(agentId, action, { maxRequests = 60, windowMs = 60000 } = {}) {
  if (isRateLimited(`db:${agentId}:${action}`, maxRequests, windowMs)) {
    return { limited: true, response: { status: 429, body: { error: `Too many ${action} requests. Please wait.` } } };
  }
  const dbLimited = await isRateLimitedDb(agentId, action, maxRequests, windowMs);
  if (dbLimited) {
    return { limited: true, response: { status: 429, body: { error: `Too many ${action} requests. Please wait.` } } };
  }
  return { limited: false };
}

// ── Centralized rate limit presets ──────────────────────────────────
// Loaded from school config (schools/*.js). Proxy ensures backward-compat.
let _schoolConfig;
function _getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

const RATE_LIMITS = new Proxy({}, {
  get(_, prop) { return _getSchool().rateLimits[prop]; },
  ownKeys() { return Object.keys(_getSchool().rateLimits); },
  getOwnPropertyDescriptor(_, prop) {
    const limits = _getSchool().rateLimits;
    if (prop in limits) return { configurable: true, enumerable: true, value: limits[prop] };
  },
  has(_, prop) { return prop in _getSchool().rateLimits; },
});

module.exports = {
  isRateLimited,
  isRateLimitedDb,
  logRateLimitedAction,
  getClientIp,
  enforceRateLimit,
  enforceRateLimitDb,
  RATE_LIMITS,
};
