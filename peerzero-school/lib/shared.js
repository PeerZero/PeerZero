/**
 * PeerZero Shared Utilities — Re-export Hub
 *
 * All business logic has been extracted into focused modules:
 *   lib/sanitize.js          — Input sanitization (prompt injection + HTML)
 *   lib/rate-limit.js        — In-memory + DB-backed rate limiting
 *   lib/credibility.js       — Tier caps, time decay, atomic adjustments
 *   lib/grades.js            — Grade level requirements + progression
 *   lib/failure-reflections.js — Structured failure events + reflection prompts
 *   lib/bot-citation.js      — Bot self-citation detection
 *   lib/doi-citations.js     — DOI verification + citation quality
 *   lib/search-strategy.js   — Search strategy validation + coaching
 *   lib/review-helpers.js    — Review scoring helpers
 *   lib/bounty-helpers.js    — Bounty validation helpers
 *   lib/paper-helpers.js     — Paper submission helpers
 *
 * This file re-exports everything so existing require('../lib/shared') imports work unchanged.
 */

const { createClient } = require('@supabase/supabase-js');
const log = require('./logger');

// ── Extracted modules ────────────────────────────────────────────────
const sanitizeModule = require('./sanitize');
const rateLimitModule = require('./rate-limit');
const credibilityModule = require('./credibility');
const gradesModule = require('./grades');
const failureReflectionsModule = require('./failure-reflections');
const botCitationModule = require('./bot-citation');
const doiCitations = require('./doi-citations');
const searchStrategy = require('./search-strategy');

// ── Supabase client (shared singleton) ───────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error(
        'Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set'
      );
    }
    // SECURITY: Warn if ADMIN_SECRET is missing or weak in production.
    // ADMIN_SECRET protects the /api/reconcile endpoint.
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
      if (!process.env.ADMIN_SECRET) {
        log.error('[STARTUP] ADMIN_SECRET is not set — /api/reconcile will reject all requests');
      } else if (process.env.ADMIN_SECRET.length < 32) {
        log.error('[STARTUP] ADMIN_SECRET is too short (< 32 chars) — weak against brute force');
      }
    }

    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// ── CORS + CSRF + request validation (stays here — small, HTTP-specific) ──
// Allowed origins loaded from school config (schools/*.js).
let _schoolConfig;
function _getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

// Legacy export — now reads from school config. Use getSchool().allowedOrigins directly in new code.
const ALLOWED_ORIGINS = new Proxy([], {
  get(_, prop) {
    const origins = _getSchool().allowedOrigins;
    if (prop === 'length') return origins.length;
    if (prop === 'includes') return origins.includes.bind(origins);
    if (prop === Symbol.iterator) return origins[Symbol.iterator].bind(origins);
    if (typeof prop === 'string' && !isNaN(prop)) return origins[Number(prop)];
    if (typeof origins[prop] === 'function') return origins[prop].bind(origins);
    return origins[prop];
  },
});

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigins = _getSchool().allowedOrigins;
  if (allowedOrigins.includes(origin)) {
    // nosemgrep: cors-misconfiguration — origin is validated against allowedOrigins allowlist above
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.PEERZERO_DEV === 'true') {
    // SECURITY: Restrict dev CORS to specific known dev ports instead of all localhost
    const allowedDevPorts = ['3000', '3001', '5173', '8080'];
    try {
      const devUrl = new URL(origin);
      if (devUrl.hostname === 'localhost' && allowedDevPorts.includes(devUrl.port)) {
        // nosemgrep: cors-misconfiguration — origin is validated against dev allowlist above
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch {
      // Invalid origin URL — ignore
    }
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Admin-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  // SECURITY: Set security headers here (not only in vercel.json) so they work on any platform
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // Disabled in favor of CSP; legacy header can cause issues
}

/**
 * Check if request body exceeds maximum allowed size (1MB default).
 * @param {object} req
 * @param {number} maxBytes
 * @returns {boolean}
 */
function isBodyTooLarge(req, maxBytes = 1_048_576) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  return contentLength > maxBytes;
}

/**
 * CSRF protection for state-changing requests.
 * @param {object} req
 * @returns {boolean} true if the request should be rejected
 */
function isCsrfRejected(req) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return false;
  if (req.headers['x-api-key']) return false;
  const origin = req.headers.origin || '';
  if (!origin) return false;
  const allowedOrigins = _getSchool().allowedOrigins;
  if (allowedOrigins.includes(origin)) return false;
  if (process.env.PEERZERO_DEV === 'true') {
    const allowedDevPorts = ['3000', '3001', '5173', '8080'];
    try {
      const devUrl = new URL(origin);
      if (devUrl.hostname === 'localhost' && allowedDevPorts.includes(devUrl.port)) return false;
    } catch {
      // Invalid origin URL — reject
    }
  }
  return true;
}

// ── Safe error messages ───────────────────────────────────────────────
// NOTE: Null handling varies across the codebase (some callers pass Error objects,
// others pass strings or Supabase error objects). The `error?.message || error`
// pattern handles both cases — this is intentional, not a bug.
function sanitizeErrorMessage(error) {
  log.error('DB Error', { err: error?.message || error });
  return 'An internal error occurred. Please try again.';
}

// ── Input length validation ───────────────────────────────────────────
/** @type {Record<string, number>} */
const MAX_LENGTHS = {
  title: 500,
  abstract: 10000,
  body: 100000,
  methodology_notes: 5000,
  statistical_validity_notes: 5000,
  citation_accuracy_notes: 5000,
  reproducibility_notes: 5000,
  logical_consistency_notes: 5000,
  overall_assessment: 10000,
  agent_summary: 5000,
  relevance_explanation: 5000,
  source_quality_note: 2000,
  falsifiable_claim: 2000,
  measurable_prediction: 2000,
  quantitative_expectation: 2000,
};

/**
 * Validate that a text field doesn't exceed its max length.
 * @param {string} fieldName
 * @param {string} value
 * @returns {string|null} Error message or null if valid
 */
function validateTextLength(fieldName, value) {
  if (!value) return null;
  const max = MAX_LENGTHS[fieldName] || 10000;
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  if (value.length > max) return `${fieldName} exceeds maximum length of ${max} characters`;
  return null;
}

module.exports = {
  // Core (defined in this file)
  getSupabase,
  setCorsHeaders,
  isCsrfRejected,
  isBodyTooLarge,
  sanitizeErrorMessage,
  validateTextLength,
  MAX_LENGTHS,
  ALLOWED_ORIGINS,

  // Re-exported from lib/sanitize.js
  ...sanitizeModule,

  // Re-exported from lib/rate-limit.js
  ...rateLimitModule,

  // Re-exported from lib/credibility.js
  ...credibilityModule,

  // Re-exported from lib/grades.js
  ...gradesModule,

  // Re-exported from lib/failure-reflections.js
  ...failureReflectionsModule,

  // Re-exported from lib/bot-citation.js
  ...botCitationModule,

  // Re-exported from lib/doi-citations.js
  ...doiCitations,

  // Re-exported from lib/search-strategy.js
  ...searchStrategy,
};
