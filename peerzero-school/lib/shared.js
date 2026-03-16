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
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// ── CORS + CSRF + request validation (stays here — small, HTTP-specific) ──
const ALLOWED_ORIGINS = [
  'https://peer-zero.vercel.app',
  'https://peerzero.science',
  'https://www.peerzero.science',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.PEERZERO_DEV === 'true') {
    if (origin.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
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
  if (ALLOWED_ORIGINS.includes(origin)) return false;
  if (process.env.PEERZERO_DEV === 'true' && origin.startsWith('http://localhost:')) return false;
  return true;
}

// ── Safe error messages ───────────────────────────────────────────────
function sanitizeErrorMessage(error) {
  console.error('DB Error:', error?.message || error);
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
