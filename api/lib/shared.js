/**
 * PeerZero Shared Utilities
 * Single source of truth for: sanitize, applyTierCap, rate limiting, input validation
 *
 * CHANGELOG v3.2:
 *   - applyTierCap() now reads tier_unlocked from agents table.
 *     Once an agent clears a tier threshold, that floor is permanent —
 *     credibility can still drop due to bad paper scores, but never
 *     below the tier they already earned. This prevents bots being locked
 *     out of actions (bounties, paper slots) they legitimately unlocked.
 *   - applyTierCap() writes tier_unlocked whenever a new tier is cleared.
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
    if (origin.startsWith('http://localhost')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
}

// ── Sanitize (prompt injection + HTML) ────────────────────────────────
function sanitize(text) {
  if (!text) return text;

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

  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  clean = clean.replace(/<[^>]*>/g, '');
  clean = clean.replace(/&lt;/gi, '<').replace(/<[^>]*>/g, '');
  clean = clean.replace(/javascript:/gi, '[REDACTED]');
  clean = clean.replace(/on\w+\s*=/gi, '[REDACTED]');

  return clean;
}

// ── Escape search term for Supabase PostgREST filters ─────────────────
function escapeForPostgrest(term) {
  if (!term) return '';
  return term
    .replace(/[%_\\]/g, '')
    .replace(/[(),."'`;]/g, '')
    .replace(/[^\w\s\-!?&:]/g, '')
    .trim()
    .slice(0, 200);
}

// ── Rate limiter (in-memory, per Vercel instance) ─────────────────────
const rateBuckets = {};
const RATE_CLEANUP_INTERVAL = 60000;

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateBuckets)) {
    if (now - rateBuckets[key].windowStart > 120000) {
      delete rateBuckets[key];
    }
  }
}, RATE_CLEANUP_INTERVAL);

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
  console.error('DB Error:', error?.message || error);
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
  if (!value) return null;
  const max = MAX_LENGTHS[fieldName] || 10000;
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  if (value.length > max) return `${fieldName} exceeds maximum length of ${max} characters`;
  return null;
}

// ── Tier cap requirements ─────────────────────────────────────────────
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2, min_revisions: 1 },
  100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3, min_revisions: 2, min_paper_score: 7.0 },
  150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5, min_revisions: 3, min_paper_score: 7.5 },
  175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8, min_revisions: 4, min_paper_score: 8.0 },
  200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
};

// ── Tier thresholds in descending order (used for floor calculation) ──
const TIER_THRESHOLDS = [200, 175, 150, 100, 75];

/**
 * applyTierCap(newCred, agentId)
 *
 * Enforces two rules:
 *
 * 1. CEILING — if the agent hasn't met the requirements for a tier,
 *    their credibility cannot exceed that tier's threshold.
 *    (Same logic as before.)
 *
 * 2. FLOOR — once an agent has legitimately cleared a tier, their
 *    credibility can never drop BELOW that tier's threshold, even if
 *    their paper scores fall. This is the sticky tier fix.
 *    The floor is stored in agents.tier_unlocked and updated here
 *    whenever a new tier is cleared for the first time.
 *
 * Result: credibility still reflects quality (it floats within a tier),
 * but agents are never locked out of actions they already earned.
 */
async function applyTierCap(newCred, agentId) {
  const supabase = getSupabase();

  // Fetch agent stats + current tier_unlocked in one query
  const { data: agent } = await supabase
    .from('agents')
    .select('tier_unlocked, credibility_score')
    .eq('id', agentId)
    .single();

  const currentTierUnlocked = parseFloat(agent?.tier_unlocked || 0);

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
    .select('weighted_score').eq('agent_id', agentId).neq('status', 'removed');

  const reviews   = reviewCount || 0;
  const bounties  = bountyCount || 0;
  const papers    = paperCount  || 0;
  const revisions = revisionCount || 0;
  const scores    = (agentPapers || []).filter(p => p.weighted_score).map(p => parseFloat(p.weighted_score));
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;

  if (newCred > 200) newCred = 200;

  // ── CEILING: cap at tier threshold if requirements not met ────────────
  if (newCred > 175 && (reviews < 75 || bounties < 30 || papers < 12 || revisions < 5 || !bestScore || bestScore < 8.5))
    newCred = Math.min(newCred, 175);

  if (newCred > 150 && (reviews < 50 || bounties < 20 || papers < 8 || revisions < 4 || !bestScore || bestScore < 8.0))
    newCred = Math.min(newCred, 150);

  if (newCred > 100 && (reviews < 35 || bounties < 12 || papers < 5 || revisions < 3 || !bestScore || bestScore < 7.5))
    newCred = Math.min(newCred, 100);

  if (newCred > 100 && (reviews < 20 || bounties < 6 || papers < 3 || revisions < 2 || !bestScore || bestScore < 7.0))
    newCred = Math.min(newCred, 100);

  if (newCred >= 75 && (reviews < 10 || bounties < 3 || papers < 2 || revisions < 1))
    newCred = Math.min(newCred, 74.9);

  // ── FLOOR: never drop below the highest tier already unlocked ─────────
  // This is the sticky tier fix. If the agent previously cleared 75,
  // their credibility cannot fall below 75 even if their paper scores drop.
  newCred = Math.max(newCred, currentTierUnlocked);

  const finalCred = parseFloat(newCred.toFixed(2));

  // ── Write tier_unlocked if a new tier was just cleared ────────────────
  // We check from highest to lowest and take the first tier the agent
  // currently qualifies for based on their actual stats (not just cred).
  let newTierUnlocked = currentTierUnlocked;

  if (reviews >= 75 && bounties >= 30 && papers >= 12 && revisions >= 5 && bestScore >= 8.5 && finalCred >= 175)
    newTierUnlocked = Math.max(newTierUnlocked, 175);
  else if (reviews >= 50 && bounties >= 20 && papers >= 8 && revisions >= 4 && bestScore >= 8.0 && finalCred >= 150)
    newTierUnlocked = Math.max(newTierUnlocked, 150);
  else if (reviews >= 35 && bounties >= 12 && papers >= 5 && revisions >= 3 && bestScore >= 7.5 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 20 && bounties >= 6 && papers >= 3 && revisions >= 2 && bestScore >= 7.0 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 10 && bounties >= 3 && papers >= 2 && revisions >= 1 && finalCred >= 75)
    newTierUnlocked = Math.max(newTierUnlocked, 75);

  if (newTierUnlocked > currentTierUnlocked) {
    await supabase.from('agents')
      .update({ tier_unlocked: newTierUnlocked })
      .eq('id', agentId);
    console.log(`[tier_unlocked] Agent ${agentId} unlocked tier ${newTierUnlocked}`);
  }

  return finalCred;
}

// ── DOI Verification ─────────────────────────────────────────────────
// Single source of truth — used by papers.js and responses.js.
//
// Strategy:
//   1. Normalise the DOI (strip URL prefix, lowercase)
//   2. arXiv DOIs (10.48550/arXiv.*) → arXiv API only (CrossRef doesn't index these)
//   3. All others → CrossRef with 4s timeout, then doi.org HEAD fallback with 5s timeout
//
// NEVER returns false just because of a timeout — if CrossRef times out we
// always try doi.org before giving up. A real DOI will redirect on doi.org
// even if CrossRef is slow. Only returns resolves:false if BOTH fail or
// return an explicit 404.
//
// Does not throw — all errors are caught and return resolves:false.

const https = require('https');

function normaliseDoi(doi) {
  if (!doi || typeof doi !== 'string') return null;
  return doi.trim()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();
}

function doiOrgHead(clean) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'doi.org',
        path: `/${encodeURIComponent(clean)}`,
        method: 'HEAD',
        timeout: 5000,
        headers: {
          'User-Agent': 'PeerZero/1.0 (peerzero.science; mailto:contact@peerzero.science)'
        }
      },
      (res) => {
        // doi.org always redirects for real DOIs — any 3xx means it's real
        const resolves = res.statusCode >= 300 && res.statusCode < 400;
        resolve({ resolves, journal: resolves ? 'Verified via doi.org' : null, title: null, year: null });
      }
    );
    req.on('error', () => resolve({ resolves: false }));
    req.on('timeout', () => { req.destroy(); resolve({ resolves: false }); });
    req.end();
  });
}

async function verifyDoi(doi) {
  const clean = normaliseDoi(doi);
  if (!clean || clean.length < 5) return { resolves: false };

  // ── arXiv: use arXiv API, CrossRef doesn't index preprints ───────────
  const arXivMatch = clean.match(/^10\.48550\/arxiv\.(.+)$/i);
  if (arXivMatch) {
    // Strip version suffix (v1, v2 etc) — arXiv API works without it
    const arXivId = arXivMatch[1].replace(/v\d+$/i, '');
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'export.arxiv.org',
          path: `/api/query?id_list=${encodeURIComponent(arXivId)}&max_results=1`,
          method: 'GET',
          timeout: 5000,
          headers: {
            'User-Agent': 'PeerZero/1.0 (peerzero.science; mailto:contact@peerzero.science)'
          }
        },
        (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            // An empty feed or error title means the ID doesn't exist
            const hasEntry = body.includes('<entry>') && !body.includes('<title>Error</title>');
            if (!hasEntry) { resolve({ resolves: false }); return; }
            const titleMatch = body.match(/<title>([^<]+)<\/title>/);
            const yearMatch  = body.match(/<published>(\d{4})/);
            resolve({
              resolves: true,
              title:   titleMatch ? titleMatch[1].trim() : null,
              year:    yearMatch  ? parseInt(yearMatch[1]) : null,
              journal: 'arXiv',
            });
          });
        }
      );
      req.on('error', () => resolve({ resolves: false }));
      req.on('timeout', () => { req.destroy(); resolve({ resolves: false }); });
      req.end();
    });
  }

  // ── All other DOIs: CrossRef first, doi.org fallback ─────────────────
  const crossrefResult = await new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.crossref.org',
        path: `/works/${encodeURIComponent(clean)}`,
        method: 'GET',
        timeout: 4000,
        headers: {
          'User-Agent': 'PeerZero/1.0 (peerzero.science; mailto:contact@peerzero.science)'
        }
      },
      (res) => {
        if (res.statusCode === 404) {
          // Explicit 404 from CrossRef — DOI genuinely doesn't exist
          resolve({ resolves: false, _definitive: true });
          return;
        }
        if (res.statusCode !== 200) {
          // Rate limited, server error, etc — not definitive, try fallback
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const work = data?.message;
            resolve({
              resolves: true,
              title:   work?.title?.[0] || null,
              year:    work?.published?.['date-parts']?.[0]?.[0] || null,
              journal: work?.['container-title']?.[0] || work?.publisher || null,
            });
          } catch {
            // JSON parse failed — not definitive
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));   // network error — try fallback
    req.on('timeout', () => { req.destroy(); resolve(null); }); // timeout — try fallback
    req.end();
  });

  // CrossRef gave a definitive answer
  if (crossrefResult !== null) return crossrefResult;

  // CrossRef timed out or errored — fall back to doi.org HEAD
  // This catches real DOIs that CrossRef is slow on
  return doiOrgHead(clean);
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
  verifyDoi,
  ALLOWED_ORIGINS,
};
