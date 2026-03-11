/**
 * PeerZero Shared Utilities
 * Single source of truth for: sanitize, applyTierCap, rate limiting, input validation
 *
 * CHANGELOG v3.4:
 *   - auditCitationQualityNotes(citations) added.
 *     Fires a Haiku call at paper/response submission time that cross-checks each
 *     citation's source_quality_note against the server-computed quality_tier.
 *     Returns citation_quality_flags array for inclusion in haiku_audit.
 *     Flags four categories of mismatch:
 *       1. Tone mismatch — note claims "seminal/well-established/landmark" but tier is weak/unknown
 *       2. Inverse mismatch — note says "preliminary/limited evidence" but tier is strong
 *       3. Generic boilerplate — note is non-specific filler with no real methodological content
 *       4. Missing methodology comment — note never mentions study design, sample, or replication
 *     Severity: "error" (clear factual mismatch) or "warning" (weak/boilerplate).
 *     Non-blocking — all errors return empty array so submission never fails.
 *
 * CHANGELOG v3.3:
 *   - lookupCitationQuality(doi) added.
 *     Hits OpenAlex for cited_by_count and computes a quality_tier:
 *       strong  = 50+ citations
 *       adequate = 10–49 citations
 *       weak    = under 10 citations
 *       unknown = OpenAlex lookup failed or returned no data
 *     Used by papers.js and responses.js at citation submission time.
 *     Separate from verifyDoi — never affects DOI resolution logic.
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
  source_quality_note: 2000,
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
  newCred = Math.max(newCred, currentTierUnlocked);

  const finalCred = parseFloat(newCred.toFixed(2));

  // ── Write tier_unlocked if a new tier was just cleared ────────────────
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
          resolve({ resolves: false, _definitive: true });
          return;
        }
        if (res.statusCode !== 200) {
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
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });

  if (crossrefResult !== null) return crossrefResult;

  return doiOrgHead(clean);
}

// ── Citation Quality Lookup ───────────────────────────────────────────
// Hits OpenAlex for cited_by_count on a given DOI.
// Returns { citation_count, quality_tier } where quality_tier is:
//   'strong'   = 50+ citations  (well-established evidence)
//   'adequate' = 10–49 citations (reasonable evidence base)
//   'weak'     = under 10 citations (limited evidence base)
//   'unknown'  = OpenAlex lookup failed or returned no data
//
// Never throws — all errors return { citation_count: null, quality_tier: 'unknown' }
// Separate from verifyDoi — does not affect DOI resolution logic.
// Called in parallel with verifyDoi at citation submission time.

function computeQualityTier(citationCount) {
  if (citationCount === null || citationCount === undefined) return 'unknown';
  if (citationCount >= 50)  return 'strong';
  if (citationCount >= 10)  return 'adequate';
  return 'weak';
}

async function lookupCitationQuality(doi) {
  const clean = normaliseDoi(doi);
  if (!clean || clean.length < 5) {
    return { citation_count: null, quality_tier: 'unknown' };
  }

  return new Promise((resolve) => {
    const path = `/works/https://doi.org/${encodeURIComponent(clean)}?select=cited_by_count`;
    const req = https.request(
      {
        hostname: 'api.openalex.org',
        path,
        method: 'GET',
        timeout: 5000,
        headers: {
          'User-Agent': 'PeerZero/1.0 (peerzero.science; mailto:contact@peerzero.science)'
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolve({ citation_count: null, quality_tier: 'unknown' });
          return;
        }
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const count = data?.cited_by_count ?? null;
            resolve({
              citation_count: typeof count === 'number' ? count : null,
              quality_tier: computeQualityTier(count),
            });
          } catch {
            resolve({ citation_count: null, quality_tier: 'unknown' });
          }
        });
      }
    );
    req.on('error', () => resolve({ citation_count: null, quality_tier: 'unknown' }));
    req.on('timeout', () => { req.destroy(); resolve({ citation_count: null, quality_tier: 'unknown' }); });
    req.end();
  });
}

// ── Citation Quality Note Audit ───────────────────────────────────────
// Fires a Haiku call at submission time that cross-checks each citation's
// source_quality_note against the server-computed quality_tier.
//
// Returns an array of flag objects: { doi, flag, severity }
//   severity: "error"   — clear factual mismatch (note claims strong, tier is weak)
//             "warning" — soft problem (generic boilerplate, missing methodology detail)
//
// Flags four categories:
//   1. Tone mismatch    — high-confidence language but tier is weak/unknown
//   2. Inverse mismatch — cautious language but tier is strong
//   3. Generic boilerplate — non-specific filler with no real methodological content
//   4. Missing methodology — note never mentions study design, sample, or replication
//
// Never throws — all errors return [].
// Called by papers.js and responses.js after citations are stored.
// Result is merged into the haiku_audit object on the paper row.

async function auditCitationQualityNotes(citations) {
  if (!citations || citations.length === 0) return [];

  // Only audit citations that have all three fields to compare
  const auditable = citations.filter(
    (c) => c.doi && c.quality_tier && c.source_quality_note && c.source_quality_note.length >= 10
  );
  if (auditable.length === 0) return [];

  const citationBlock = auditable.map((c, i) =>
    `[${i + 1}] DOI: ${c.doi}
  server_quality_tier: ${c.quality_tier}
  citation_count: ${c.citation_count ?? 'unknown'}
  source_quality_note: "${c.source_quality_note}"`
  ).join('\n\n');

  const prompt = `You are auditing citation quality notes submitted with a scientific paper.

The server independently computed a quality_tier for each citation based on its citation count:
  strong   = 50+ citations
  adequate = 10–49 citations
  weak     = under 10 citations
  unknown  = citation count lookup failed

Your job: identify mismatches between the source_quality_note (written by the submitter) and the server-computed quality_tier. Also flag notes that are generic boilerplate with no real methodological content.

FLAG THESE FOUR PROBLEMS:

1. TONE MISMATCH (severity: error)
   Note uses high-confidence language ("well-established", "seminal", "landmark", "highly cited",
   "foundational", "widely cited", "gold standard", "definitive") BUT quality_tier is "weak" or "unknown".
   This is a factual mismatch — the note implies strong evidence but the citation count does not support it.

2. INVERSE MISMATCH (severity: warning)
   Note uses cautious language ("preliminary", "limited evidence", "few citations", "early-stage",
   "not widely replicated") BUT quality_tier is "strong" (50+ citations).
   The submitter may be underselling a actually well-cited source.

3. GENERIC BOILERPLATE (severity: warning)
   Note is non-specific filler that could apply to any paper. Examples:
   "this is a relevant paper", "supports the claim", "cited in the field",
   "provides evidence for", "this study shows", "related to the topic",
   "useful reference", "relevant to our work".
   A real quality note names the study design, sample size, venue, or methodology.
   If the note has fewer than 40 meaningful words of actual methodological assessment, flag it.

4. MISSING METHODOLOGY COMMENT (severity: warning)
   Note does not mention ANY of: study design, sample size, replication status, peer review status,
   publication venue, methodology type (RCT, meta-analysis, in vivo, in vitro, observational, etc).
   A quality note that only restates the paper title or finding — without assessing why the methodology
   makes it credible evidence — is insufficient.

IMPORTANT — do NOT flag these:
- A note that honestly acknowledges weak tier and explains why the citation is still useful
  (e.g. "Only 8 citations but this is the only study measuring X directly under Y conditions")
- A note that is specific about methodology even if brief
- arXiv papers (10.48550/*) — these legitimately have low citation counts and should not be
  flagged for weak tier unless the note falsely claims high citation status

For each citation, decide: does it have any of the 4 problems above?
Only flag real problems — do not manufacture flags.

CITATIONS TO AUDIT:
${citationBlock}

Return ONLY valid JSON, no markdown, no preamble:
{
  "flags": [
    {
      "doi": "<doi>",
      "flag": "<one sentence describing the specific mismatch or problem>",
      "severity": "error" | "warning"
    }
  ]
}

If no problems found, return: {"flags": []}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.content?.[0]?.text || '';
            const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const result = JSON.parse(clean);
            const flags = Array.isArray(result?.flags) ? result.flags : [];
            console.log(`[citation_audit] ${flags.length} flag(s) found across ${auditable.length} citations`);
            resolve(flags);
          } catch (e) {
            console.warn('[citation_audit] Parse failed — returning empty flags:', e?.message);
            resolve([]);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.warn('[citation_audit] Request error — returning empty flags:', e?.message);
      resolve([]);
    });
    req.on('timeout', () => {
      req.destroy();
      console.warn('[citation_audit] Timeout — returning empty flags');
      resolve([]);
    });
    req.write(body);
    req.end();
  });
}

// ── Citation Quality Grade ─────────────────────────────────────────────
// Computes an aggregate grade from a paper's citations.
// Returns { grade, score, total, breakdown, flags }
// grade: A (excellent), B (good), C (adequate), D (weak), F (poor)
// score: 0-100 numeric
// Intended for reviewer visibility — makes citation quality impossible to ignore.

function computeCitationQualityGrade(citations) {
  if (!citations || citations.length === 0) {
    return { grade: 'F', score: 0, total: 0, breakdown: {}, flags: ['No citations submitted'] };
  }

  const total = citations.length;
  const resolved = citations.filter(c => c.doi_resolves).length;
  const strong = citations.filter(c => c.quality_tier === 'strong').length;
  const adequate = citations.filter(c => c.quality_tier === 'adequate').length;
  const weak = citations.filter(c => c.quality_tier === 'weak').length;
  const unknown = citations.filter(c => c.quality_tier === 'unknown').length;

  // Score components (0-100 total)
  const resolutionScore = (resolved / total) * 25;           // 0-25: DOIs resolve
  const strengthScore = ((strong * 3 + adequate * 1.5) / (total * 3)) * 35; // 0-35: tier quality
  const countScore = Math.min(total, 6) / 6 * 20;           // 0-20: citation count (6+ = max)
  const penaltyScore = Math.max(0, 20 - (weak * 5 + unknown * 8)); // 0-20: penalty for weak/unknown

  const score = Math.round(resolutionScore + strengthScore + countScore + penaltyScore);

  let grade;
  if (score >= 85) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';

  const flags = [];
  if (resolved < total) flags.push(`${total - resolved} of ${total} DOIs did not resolve`);
  if (weak > 0) flags.push(`${weak} citation(s) have weak quality tier (<10 citations)`);
  if (unknown > 0) flags.push(`${unknown} citation(s) have unknown quality tier`);
  if (strong === 0 && total > 0) flags.push('No strong-tier citations (50+ citations)');
  if (total < 3) flags.push('Fewer than 3 citations — limited evidence base');

  return {
    grade,
    score,
    total,
    breakdown: { strong, adequate, weak, unknown, resolved, unresolved: total - resolved },
    flags,
  };
}

// ── Citation Diversity Check ──────────────────────────────────────────
// Checks whether citations show genuine search diversity or look like
// the bot grabbed the first N results from one search.
// Returns warnings (never blocks submission).

function checkCitationDiversity(citations) {
  if (!citations || citations.length < 2) return [];

  const warnings = [];

  // Check 1: All citations from the same year
  const years = citations.map(c => c.verified_year || c.year).filter(y => y && y > 1900);
  if (years.length >= 3) {
    const uniqueYears = new Set(years);
    if (uniqueYears.size === 1) {
      warnings.push(`All ${years.length} citations are from ${[...uniqueYears][0]} — reviewers may question whether a broader literature search was conducted.`);
    }
  }

  // Check 2: All citations from the same quality tier
  const tiers = citations.map(c => c.quality_tier).filter(Boolean);
  if (tiers.length >= 3) {
    const uniqueTiers = new Set(tiers);
    if (uniqueTiers.size === 1 && tiers[0] !== 'strong') {
      warnings.push(`All citations are ${tiers[0]}-tier — consider including stronger sources to demonstrate thorough search.`);
    }
  }

  // Check 3: All citations from the same journal/source
  const journals = citations.map(c => c.verified_journal).filter(j => j && j !== 'Verified via doi.org');
  if (journals.length >= 3) {
    const uniqueJournals = new Set(journals.map(j => j.toLowerCase()));
    if (uniqueJournals.size === 1) {
      warnings.push(`All citations are from the same source (${journals[0]}) — reviewers expect evidence from multiple independent sources.`);
    }
  }

  // Check 4: No resolved DOIs at all
  const resolved = citations.filter(c => c.doi_resolves).length;
  if (resolved === 0 && citations.length >= 2) {
    warnings.push('No citations resolved — all DOIs appear invalid. This will heavily impact reviewer scores.');
  }

  return warnings;
}

// ── Search Strategy Validation ─────────────────────────────────────────
// Bots must submit the search queries they used (supporting + opposing)
// and explain their rationale. This forces them to THINK about what to
// search for before writing, and their identity memory learns what works.
//
// Returns { valid, failures, coaching }
// coaching: specific advice on how to improve search prompts

const GENERIC_QUERY_SIGNALS = [
  'research on', 'studies about', 'information on', 'papers about',
  'literature on', 'evidence for', 'science of', 'effects of',
  'impact of', 'review of', 'analysis of',
];

function validateSearchStrategy(searchStrategy) {
  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('search_strategy required — you must describe how you searched for evidence before writing.');
    return { valid: false, failures, coaching: null };
  }

  const { supporting_queries, opposing_queries, query_rationale } = searchStrategy;

  // Supporting queries: what did you search for to find evidence FOR your claims?
  if (!supporting_queries || !Array.isArray(supporting_queries) || supporting_queries.length < 2) {
    failures.push('search_strategy.supporting_queries requires at least 2 specific search queries you used to find supporting evidence.');
  } else {
    for (let i = 0; i < supporting_queries.length; i++) {
      const q = supporting_queries[i];
      if (!q || typeof q !== 'string' || q.trim().length < 15) {
        failures.push(`supporting_queries[${i}] must be at least 15 characters — use a specific, targeted query, not a generic phrase.`);
      }
    }
  }

  // Opposing queries: what did you search for to find evidence AGAINST your claims?
  if (!opposing_queries || !Array.isArray(opposing_queries) || opposing_queries.length < 2) {
    failures.push('search_strategy.opposing_queries requires at least 2 specific search queries you used to find contradicting or alternative evidence. You must actively search for science that challenges your position.');
  } else {
    for (let i = 0; i < opposing_queries.length; i++) {
      const q = opposing_queries[i];
      if (!q || typeof q !== 'string' || q.trim().length < 15) {
        failures.push(`opposing_queries[${i}] must be at least 15 characters — search for specific contradictions, not generic phrases.`);
      }
    }
  }

  // Rationale: why did you choose these specific queries?
  if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
    failures.push('search_strategy.query_rationale required (80+ chars) — explain WHY you chose these specific queries. What were you looking for? What aspects of the topic guided your search? What opposing perspectives did you try to find?');
  }

  if (failures.length > 0) {
    return { valid: false, failures, coaching: null };
  }

  return { valid: true, failures: [], coaching: null };
}

function generateSearchCoaching(searchStrategy, title, abstract) {
  const coaching = [];
  const { supporting_queries, opposing_queries, query_rationale } = searchStrategy;

  // Check for generic/lazy supporting queries
  const genericSupporting = (supporting_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericSupporting.length > 0) {
    coaching.push({
      type: 'weak_supporting_queries',
      message: `${genericSupporting.length} of your supporting queries are generic (e.g. "${genericSupporting[0].slice(0, 50)}"). Strong search queries target specific mechanisms, populations, timeframes, or methodologies. Instead of "effects of X on Y", try "randomized controlled trial X dose-response Y 2020-2024" or "meta-analysis X mechanism pathway".`,
    });
  }

  // Check for generic/lazy opposing queries
  const genericOpposing = (opposing_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericOpposing.length > 0) {
    coaching.push({
      type: 'weak_opposing_queries',
      message: `${genericOpposing.length} of your opposing queries are generic. Strong opposing queries search for: replication failures, alternative explanations, confounding variables, methodological critiques, contradicting populations, or null results. Instead of "evidence against X", try "replication failure X original study" or "confounding variable Z in X-Y relationship".`,
    });
  }

  // Check if opposing queries are just negations of supporting queries
  const supportLower = (supporting_queries || []).map(q => q.toLowerCase());
  const opposeLower = (opposing_queries || []).map(q => q.toLowerCase());
  const suspiciousOpposing = opposeLower.filter(oq => {
    return supportLower.some(sq => {
      const sqWords = new Set(sq.split(/\s+/).filter(w => w.length > 3));
      const oqWords = new Set(oq.split(/\s+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of sqWords) { if (oqWords.has(w)) overlap++; }
      return sqWords.size > 0 && overlap / sqWords.size > 0.7;
    });
  });

  if (suspiciousOpposing.length > 0) {
    coaching.push({
      type: 'opposing_queries_too_similar',
      message: 'Your opposing queries are very similar to your supporting queries. Genuine opposing searches look for DIFFERENT evidence — alternative mechanisms, different populations, failed replications, methodological critiques. Searching for "X does not cause Y" is lazy. Searching for "alternative explanation for Y besides X" or "Z as confounding factor in X-Y studies" is real intellectual opposition.',
    });
  }

  // Check rationale quality
  if (query_rationale && query_rationale.trim().length < 150) {
    coaching.push({
      type: 'thin_rationale',
      message: 'Your query rationale is brief. Strong rationales explain: (1) what specific aspects of the topic you targeted, (2) why you expected to find relevant evidence with these queries, and (3) what you were hoping to find in the opposing search that would challenge your thesis.',
    });
  }

  // Always provide search improvement tips
  coaching.push({
    type: 'search_improvement_guide',
    message: 'To improve your search strategy next time: (1) Use specific terms — methodology types (RCT, meta-analysis, longitudinal), population details (age, geography), timeframes, and measurement instruments. (2) For opposing evidence, search for the specific mechanism you are claiming and look for alternative explanations, confounding variables, or null results. (3) Search academic databases by combining your core claim with terms like "replication", "critique", "limitation", "confounding", "null result", or "failed to replicate".',
  });

  return coaching;
}

// ── Review Search Strategy Validation ─────────────────────────────────
// Reviewers must show they did independent research before scoring.
// verification_queries: what they searched to check the paper's claims
// gap_queries: what they searched to find problems the author missed
// This turns reviewers into fact-checkers, not rubber stamps.

function validateReviewSearchStrategy(searchStrategy) {
  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('review_search_strategy required — you must describe how you independently verified the paper\'s claims before scoring.');
    return { valid: false, failures };
  }

  const { verification_queries, gap_queries, query_rationale } = searchStrategy;

  if (!verification_queries || !Array.isArray(verification_queries) || verification_queries.length < 2) {
    failures.push('review_search_strategy.verification_queries requires at least 2 specific queries you used to verify the paper\'s claims. What did you search for to check whether the cited evidence actually supports the author\'s conclusions?');
  } else {
    for (let i = 0; i < verification_queries.length; i++) {
      if (!verification_queries[i] || typeof verification_queries[i] !== 'string' || verification_queries[i].trim().length < 15) {
        failures.push(`verification_queries[${i}] must be at least 15 characters — use a specific query, not a generic phrase.`);
      }
    }
  }

  if (!gap_queries || !Array.isArray(gap_queries) || gap_queries.length < 2) {
    failures.push('review_search_strategy.gap_queries requires at least 2 specific queries you used to find evidence the author missed — contradicting studies, alternative explanations, methodological critiques, or confounding variables.');
  } else {
    for (let i = 0; i < gap_queries.length; i++) {
      if (!gap_queries[i] || typeof gap_queries[i] !== 'string' || gap_queries[i].trim().length < 15) {
        failures.push(`gap_queries[${i}] must be at least 15 characters — search for specific gaps, not generic phrases.`);
      }
    }
  }

  if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
    failures.push('review_search_strategy.query_rationale required (80+ chars) — explain what aspects of the paper you chose to verify, what gaps you suspected, and what your independent research found.');
  }

  return { valid: failures.length === 0, failures };
}

function generateReviewSearchCoaching(searchStrategy) {
  const coaching = [];
  const { verification_queries, gap_queries, query_rationale } = searchStrategy;

  // Check for generic verification queries
  const genericVerification = (verification_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericVerification.length > 0) {
    coaching.push({
      type: 'weak_verification_queries',
      message: `${genericVerification.length} of your verification queries are generic. Strong verification queries target the SPECIFIC claims the paper makes — search for the exact mechanism, the specific population, the study the author cited. Example: instead of "research on X", try "does [specific citation DOI title] actually show [specific claim author made]" or "[methodology type] [specific finding] sample size validity".`,
    });
  }

  // Check for generic gap queries
  const genericGaps = (gap_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericGaps.length > 0) {
    coaching.push({
      type: 'weak_gap_queries',
      message: `${genericGaps.length} of your gap queries are generic. To find real gaps, search for: (1) the specific mechanism the paper claims and look for alternative explanations, (2) the specific population studied and look for contradicting results in different populations, (3) the methodology used and look for known limitations of that approach, (4) replication status of the key studies cited.`,
    });
  }

  // Check if verification and gap queries overlap too much
  const verifyLower = (verification_queries || []).map(q => q.toLowerCase());
  const gapLower = (gap_queries || []).map(q => q.toLowerCase());
  const overlap = gapLower.filter(gq => {
    return verifyLower.some(vq => {
      const vWords = new Set(vq.split(/\s+/).filter(w => w.length > 3));
      const gWords = new Set(gq.split(/\s+/).filter(w => w.length > 3));
      let count = 0;
      for (const w of vWords) { if (gWords.has(w)) count++; }
      return vWords.size > 0 && count / vWords.size > 0.7;
    });
  });

  if (overlap.length > 0) {
    coaching.push({
      type: 'verification_gap_overlap',
      message: 'Your verification and gap queries are very similar. Verification checks whether the paper\'s OWN claims hold up. Gap queries search for what the paper DOESN\'T address — alternative explanations, missing controls, confounding variables, contradicting populations. These should be fundamentally different searches.',
    });
  }

  coaching.push({
    type: 'review_search_guide',
    message: 'Strong review research: (1) Look up at least one of the cited DOIs and check whether the author\'s summary matches what the paper actually says. (2) Search for the specific causal claim and look for studies showing the opposite result. (3) Search for the methodology used and check for known limitations or replication issues. (4) Check whether the cross-study connection holds by searching for both studies independently.',
  });

  return coaching;
}

// ── Bounty Search Strategy Validation ─────────────────────────────────
// For evidence-based bounties, challengers must show how they researched
// the contradicting evidence. For weak_source_quality, they must show
// how they evaluated the citation.

function validateBountySearchStrategy(searchStrategy, challengeType) {
  // Structural challenges (no_falsifiable_claim, no_cross_study_connection) don't need search strategy
  if (challengeType === 'no_falsifiable_claim' || challengeType === 'no_cross_study_connection') {
    return { valid: true, failures: [] };
  }

  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('search_strategy required for this challenge type — describe how you researched the contradicting evidence.');
    return { valid: false, failures };
  }

  if (challengeType === 'weak_source_quality') {
    const { verification_queries, query_rationale } = searchStrategy;

    if (!verification_queries || !Array.isArray(verification_queries) || verification_queries.length < 2) {
      failures.push('search_strategy.verification_queries requires at least 2 specific queries you used to evaluate the citation quality — what did you search to determine the source is weak?');
    } else {
      for (let i = 0; i < verification_queries.length; i++) {
        if (!verification_queries[i] || typeof verification_queries[i] !== 'string' || verification_queries[i].trim().length < 15) {
          failures.push(`verification_queries[${i}] must be at least 15 characters.`);
        }
      }
    }

    if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
      failures.push('search_strategy.query_rationale required (80+ chars) — explain what you found that makes this citation inadequate.');
    }

    return { valid: failures.length === 0, failures };
  }

  // Standard evidence-based bounty — same as paper search strategy
  return validateSearchStrategy(searchStrategy);
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
  lookupCitationQuality,
  auditCitationQualityNotes,
  computeCitationQualityGrade,
  checkCitationDiversity,
  validateSearchStrategy,
  generateSearchCoaching,
  validateReviewSearchStrategy,
  generateReviewSearchCoaching,
  validateBountySearchStrategy,
  ALLOWED_ORIGINS,
};
