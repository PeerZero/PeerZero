/**
 * Bounty validation helpers — pure functions used by bounties.js
 * Extracted to reduce file size and improve testability.
 */

const https = require('https');
const log = require('./logger');

/**
 * Validate that a string looks like a DOI (starts with "10." and has a "/" separator).
 * Does not verify the DOI exists — just checks format.
 * @param {string} doi
 * @returns {boolean}
 */
function isValidDoiFormat(doi) {
  if (!doi || typeof doi !== 'string') return false;
  const trimmed = doi.trim();
  return trimmed.startsWith('10.') && trimmed.includes('/') && trimmed.length >= 7;
}

/** @type {number} Minimum score drop for a bounty to be validated */
const MIN_SCORE_DROP = 0.2;

// ── School config (lazy-loaded) ─────────────────────────────────────────
let _schoolConfig;
function getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

/** Structural challenge types derived from school config — types that don't require sources/search */
function getStructuralChallengeTypes() {
  const school = getSchool();
  return new Set(
    school.bountyTypes
      .filter(b => !b.requiresSources && !b.requiresSearchStrategy)
      .map(b => b.key)
  );
}

// Legacy alias — backward-compatible with existing code that reads STRUCTURAL_CHALLENGE_TYPES
const STRUCTURAL_CHALLENGE_TYPES = new Proxy(new Set(), {
  get(_, prop) {
    const types = getStructuralChallengeTypes();
    if (typeof types[prop] === 'function') return types[prop].bind(types);
    return types[prop];
  },
});

/** Get all valid bounty type keys from school config */
function getValidBountyTypes() {
  return new Set(getSchool().bountyTypes.map(b => b.key));
}

/**
 * Validate the external_sources array in a bounty submission.
 * Each source must have doi, specific_finding, target_claim, and logical_bridge.
 * @param {Array<{doi?: string, specific_finding?: string, target_claim?: string, logical_bridge?: string}>} sources
 * @returns {string[]} Array of validation failure messages (empty = valid)
 */
function validateExternalSources(sources) {
  const failures = [];
  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return ['external_sources required — must include at least one source with doi, specific_finding, target_claim, and logical_bridge'];
  }
  if (sources.length > 5) failures.push('Maximum 5 external sources per bounty');
  sources.forEach((s, i) => {
    const label = `Source ${i + 1}`;
    if (!s.doi || s.doi.trim().length < 5) {
      failures.push(`${label}: doi required`);
    } else if (!isValidDoiFormat(s.doi)) {
      failures.push(`${label}: doi must be a valid DOI (starts with "10." and contains "/"). Got: "${s.doi.trim().slice(0, 40)}"`);
    }
    if (!s.specific_finding || s.specific_finding.trim().length < 50) failures.push(`${label}: specific_finding required (50+ chars)`);
    if (!s.target_claim || s.target_claim.trim().length < 30) failures.push(`${label}: target_claim required (30+ chars)`);
    if (!s.logical_bridge || s.logical_bridge.trim().length < 80) failures.push(`${label}: logical_bridge required (80+ chars)`);
  });
  return failures;
}

/**
 * Validate a weak_source_quality challenge submission.
 * @param {object} body - Request body with challenged_doi and quality_challenge_reason
 * @returns {string[]} Array of validation failure messages (empty = valid)
 */
function validateWeakSourceQualityChallenge(body) {
  const failures = [];
  const { challenged_doi, quality_challenge_reason } = body;

  if (!challenged_doi || challenged_doi.trim().length < 5) {
    failures.push('challenged_doi required — specify exactly which citation DOI you are challenging');
  } else if (!isValidDoiFormat(challenged_doi)) {
    failures.push(`challenged_doi must be a valid DOI (starts with "10." and contains "/"). Got: "${challenged_doi}". Use the doi field from the citations array.`);
  }
  if (!quality_challenge_reason || quality_challenge_reason.trim().length < 80) {
    failures.push('quality_challenge_reason required (80+ chars) — explain specifically why the source_quality_note is inadequate given the citation count and methodology of the cited paper');
  }

  return failures;
}

// ── Semantic Drift Detection ───────────────────────────────────────────────────

const SCIENTIFIC_STOPWORDS = new Set([
  'study', 'studies', 'research', 'evidence', 'finding', 'findings', 'result',
  'results', 'shows', 'shown', 'demonstrate', 'demonstrates', 'demonstrated',
  'suggest', 'suggests', 'indicated', 'indicates', 'reported', 'reports',
  'statistical', 'statistically', 'significant', 'significance', 'analysis',
  'analyses', 'method', 'methods', 'methodology', 'approach', 'sample',
  'control', 'group', 'groups', 'effect', 'effects', 'however', 'therefore',
  'whereas', 'although', 'associated', 'association', 'correlation', 'compared',
  'comparison', 'increase', 'increased', 'decrease', 'decreased', 'higher',
  'lower', 'found', 'observed', 'paper', 'papers', 'claim', 'claims',
  'contradict', 'contradicts', 'contradiction', 'support', 'supports',
  'consistent', 'inconsistent', 'conclude', 'concludes', 'conclusion',
  'conclusions', 'data', 'model', 'based', 'using', 'used', 'also', 'between',
  'within', 'across', 'through', 'specific', 'specifically', 'particular',
  'provide', 'provides', 'provided', 'author', 'authors', 'original',
]);

/**
 * Tokenize text into a set of meaningful words (length > 3, stopwords removed).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
      .filter(t => t.length > 3 && !SCIENTIFIC_STOPWORDS.has(t))
  );
}

/**
 * Compute Jaccard similarity between two text strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity score (0–1)
 */
function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) { if (setB.has(token)) intersection++; }
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Call Haiku to judge if two bounty sources make the same argument (semantic drift detection).
 * @param {{target_claim: string, logical_bridge: string}} newSource
 * @param {{target_claim: string, logical_bridge: string}} existingSource
 * @returns {Promise<{same_argument: boolean, confidence: number, reason: string}|null>}
 */
function callHaikuDriftJudge(newSource, existingSource) {
  const startTime = Date.now();
  const prompt = `You are a scientific argument comparator. Two different challengers cited the same academic paper (DOI) to challenge the same target paper. Determine whether they are making the SAME argument or DIFFERENT arguments.

EXISTING CHALLENGE:
- Target claim attacked: "${existingSource.target_claim}"
- How the DOI contradicts it: "${existingSource.logical_bridge}"

NEW CHALLENGE:
- Target claim attacked: "${newSource.target_claim}"
- How the DOI contradicts it: "${newSource.logical_bridge}"

Two challenges are the SAME argument if they:
- Attack the same claim in the target paper AND
- Use the cited paper to make essentially the same logical point (even if worded differently)

Two challenges are DIFFERENT arguments if they:
- Attack different claims in the target paper, OR
- Use the cited paper to make a genuinely different logical point (different mechanism, different flaw, different implication)

Respond with ONLY valid JSON:
{"same_argument": true/false, "confidence": 0.0-1.0, "reason": "one sentence"}`;

  return new Promise((resolve) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      log.error('[haiku:drift_judge] ANTHROPIC_API_KEY not set — skipping call');
      return resolve(null);
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        timeout: 15000,
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
          const elapsed = Date.now() - startTime;
          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) {
              log.error('[haiku:drift_judge] API error', { elapsed, errorType: parsed.error.type, errorMessage: parsed.error.message });
              return resolve(null);
            }
            const text = parsed?.content?.[0]?.text || '';
            const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const result = JSON.parse(clean);
            log.info('[haiku:drift_judge] OK', { elapsed, sameArgument: result.same_argument });
            resolve({
              same_argument: !!result.same_argument,
              confidence: Math.min(1, Math.max(0, parseFloat(result.confidence) || 0.5)),
              reason: String(result.reason || '').slice(0, 200),
            });
          } catch (e) {
            log.error('[haiku:drift_judge] Parse failed', { elapsed, err: e?.message });
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      log.error('[haiku:drift_judge] Network error', { elapsed: Date.now() - startTime, err: e?.message });
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      log.error('[haiku:drift_judge] Timeout after 15s');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  MIN_SCORE_DROP,
  STRUCTURAL_CHALLENGE_TYPES,
  isValidDoiFormat,
  validateExternalSources,
  validateWeakSourceQualityChallenge,
  SCIENTIFIC_STOPWORDS,
  tokenize,
  jaccardSimilarity,
  callHaikuDriftJudge,
  getValidBountyTypes,
};
