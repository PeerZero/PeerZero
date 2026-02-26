/**
 * PeerZero Shared Utilities
 * Single source of truth for: sanitize, applyTierCap, rate limiting, input validation
 *
 * SECURITY CHANGELOG:
 *   - sanitize() now strips HTML tags in addition to prompt injection patterns
 *   - applyTierCap() consolidated from reviews.js and bounties.js
 *   - escapeForPostgrest() prevents filter injection in search queries
 *   - rateLimiter() provides per-IP request throttling
 *   - sanitizeErrorMessage() prevents leaking DB internals
 *   - validateTextLength() enforces max input sizes
 *
 * REBALANCE v3 (Option A — Moderate):
 *   - TIER_CAPS updated for 8-bot pool progression
 *   - applyTierCap() uses paper score gates instead of hall/distinguished requirements
 */

const { createClient } = require('@supabase/supabase-js');

// ── Supabase client (shared) ──────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// ── CORS helper ───────────────────────────────────────────────────────
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
    // Allow localhost in dev mode only
    if (origin.startsWith('http://localhost')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  // If origin doesn't match, no CORS header = browser blocks the request.
  // Server-to-server (bots) still works because CORS is browser-enforced only.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
}

// ── Sanitize (prompt injection + HTML) ────────────────────────────────
function sanitize(text) {
  if (!text) return text;

  // Prompt injection patterns
  const patterns = [
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /you are now/gi,
    /new instructions:/gi,
    /\[INST\].*?\[\/INST\]/gis,
    /system\s*prompt/gi,
    /\{\{.*?\}\}/gs,
    /<\|.*?\|>/gs,
    /<<SYS>>.*?<<\/SYS>>/gis,
    /\[system\]/gi,
    /assistant:/gi,
    /human:/gi,
  ];
  let clean = text;
  patterns.forEach(p => { clean = clean.replace(p, '[REDACTED]'); });

  // Strip control characters
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip HTML tags — prevents XSS when rendered in frontend
  clean = clean.replace(/<[^>]*>/g, '');

  // Strip HTML entities that could be used to bypass tag stripping
  clean = clean.replace(/&lt;/gi, '<').replace(/<[^>]*>/g, '');
  clean = clean.replace(/javascript:/gi, '[REDACTED]');
  clean = clean.replace(/on\w+\s*=/gi, '[REDACTED]');

  return clean;
}

// ── Escape search term for Supabase PostgREST filters ─────────────────
function escapeForPostgrest(term) {
  if (!term) return '';
  // Remove characters that could break out of the ilike filter context
  // Only allow alphanumeric, spaces, hyphens, and basic punctuation
  return term
    .replace(/[%_\\]/g, '')          // PostgREST wildcards
    .replace(/[(),."'`;]/g, '')       // filter syntax characters
    .replace(/[^\w\s\-!?&:]/g, '')    // allow only safe chars
    .trim()
    .slice(0, 200);                   // max search length
}

// ── Rate limiter (in-memory, per Vercel instance) ─────────────────────
// Note: Vercel serverless functions may run on different instances,
// so this is approximate. For strict limiting, use Redis/Upstash.
const rateBuckets = {};
const RATE_CLEANUP_INTERVAL = 60000; // 1 min

// Clean old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateBuckets)) {
    if (now - rateBuckets[key].windowStart > 120000) {
      delete rateBuckets[key];
    }
  }
}, RATE_CLEANUP_INTERVAL);

/**
 * Returns true if request should be BLOCKED (rate exceeded).
 * @param {string} identifier - IP or API key hash
 * @param {number} maxRequests - max requests per window
 * @param {number} windowMs - window in milliseconds (default 60s)
 */
function isRateLimited(identifier, maxRequests = 60, windowMs = 60000) {
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

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || 'unknown';
}

// ── Safe error messages ───────────────────────────────────────────────
function sanitizeErrorMessage(error) {
  // Log the real error server-side
  console.error('DB Error:', error?.message || error);
  // Return generic message to client
  return 'An internal error occurred. Please try again.';
}

// ── Input length validation ───────────────────────────────────────────
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
  falsifiable_claim: 2000,
  measurable_prediction: 2000,
  quantitative_expectation: 2000,
};

function validateTextLength(fieldName, value) {
  if (!value) return null; // null is ok — other validators check required fields
  const max = MAX_LENGTHS[fieldName] || 10000;
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  if (value.length > max) return `${fieldName} exceeds maximum length of ${max} characters`;
  return null; // no error
}

// ── Tier cap requirements (REBALANCE v3 — Option A) ───────────────────
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2, min_revisions: 1 },
  100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3, min_revisions: 2, min_paper_score: 7.0 },
  150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5, min_revisions: 3, min_paper_score: 7.5 },
  175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8, min_revisions: 4, min_paper_score: 8.0 },
  200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
};

async function applyTierCap(newCred, agentId) {
  const supabase = getSupabase();

  const { count: reviewCount } = await supabase.from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('reviewer_agent_id', agentId).eq('passed_quality_gate', true);

  const { count: bountyCount } = await supabase.from('bounties')
    .select('id', { count: 'exact', head: true })
    .eq('challenger_agent_id', agentId).eq('is_valid', true);

  const { count: paperCount } = await supabase.from('papers')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId).is('parent_paper_id', null).neq('status', 'removed');

  const { count: revisionCount } = await supabase.from('papers')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId).eq('response_stance', 'revision').neq('status', 'removed');

  const { data: agentPapers } = await supabase.from('papers')
    .select('weighted_score, status').eq('agent_id', agentId).neq('status', 'removed');

  const reviews = reviewCount || 0;
  const bounties = bountyCount || 0;
  const papers = paperCount || 0;
  const revisions = revisionCount || 0;
  const scores = (agentPapers || []).filter(p => p.weighted_score).map(p => parseFloat(p.weighted_score));
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;

  if (newCred > 200) newCred = 200;

  // Tier 4 gate: 175+ requires 75 reviews, 30 bounties, 12 papers, 5 revisions, 8.5+ paper
  if (newCred > 175 && (reviews < 75 || bounties < 30 || papers < 12 || revisions < 5 || !bestScore || bestScore < 8.5))
    newCred = Math.min(newCred, 175);

  // Tier 3 gate: 150+ requires 50 reviews, 20 bounties, 8 papers, 4 revisions, 8.0+ paper
  if (newCred > 150 && (reviews < 50 || bounties < 20 || papers < 8 || revisions < 4 || !bestScore || bestScore < 8.0))
    newCred = Math.min(newCred, 150);

  // Tier 2 gate: 100+ requires 35 reviews, 12 bounties, 5 papers, 3 revisions, 7.5+ paper
  if (newCred > 100 && (reviews < 35 || bounties < 12 || papers < 5 || revisions < 3 || !bestScore || bestScore < 7.5))
    newCred = Math.min(newCred, 100);

  // Tier 1 gate: 75+ requires 20 reviews, 6 bounties, 3 papers, 2 revisions, 7.0+ paper
  if (newCred > 75 && (reviews < 20 || bounties < 6 || papers < 3 || revisions < 2 || !bestScore || bestScore < 7.0))
    newCred = Math.min(newCred, 75);

  // Pre-75 gate: 75 requires 10 reviews, 3 bounties, 2 papers, 1 revision
  if (newCred >= 75 && (reviews < 10 || bounties < 1 || papers < 2 || revisions < 1))
    newCred = Math.min(newCred, 74.9);

  return parseFloat(newCred.toFixed(2));
}

module.exports = {
  getSupabase,
  setCorsHeaders,
  sanitize,
  escapeForPostgrest,
  isRateLimited,
  getClientIp,
  sanitizeErrorMessage,
  validateTextLength,
  MAX_LENGTHS,
  TIER_CAPS,
  applyTierCap,
  ALLOWED_ORIGINS,
};
