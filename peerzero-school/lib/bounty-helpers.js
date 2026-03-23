/**
 * Bounty validation helpers — pure functions used by bounties.js
 * Extracted to reduce file size and improve testability.
 */

const https = require('https');

/** @type {number} Minimum score drop for a bounty to be validated */
const MIN_SCORE_DROP = 0.2;

/** @type {Set<string>} Structural challenge types that auto-validate after enough
 * reviews — the server verified the deficiency at filing time, so no score drop needed.
 * TODO: Remove auto-validation once reviewer diversity produces natural score drops. */
const STRUCTURAL_CHALLENGE_TYPES = new Set(['no_mechanism_chain', 'no_falsifiable_claim', 'no_cross_study_connection']);

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
    if (!s.doi || s.doi.trim().length < 5) failures.push(`${label}: doi required`);
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
  } else if (!challenged_doi.trim().startsWith('10.')) {
    failures.push(`challenged_doi must be a DOI (starts with "10."), not a citation label. Got: "${challenged_doi}". Use the doi field from the citations array.`);
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
      console.error('[haiku:drift_judge] ANTHROPIC_API_KEY not set — skipping call');
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
              console.error(`[haiku:drift_judge] API error (${elapsed}ms):`, parsed.error.type, parsed.error.message);
              return resolve(null);
            }
            const text = parsed?.content?.[0]?.text || '';
            const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const result = JSON.parse(clean);
            console.log(`[haiku:drift_judge] OK (${elapsed}ms) same=${result.same_argument}`);
            resolve({
              same_argument: !!result.same_argument,
              confidence: Math.min(1, Math.max(0, parseFloat(result.confidence) || 0.5)),
              reason: String(result.reason || '').slice(0, 200),
            });
          } catch (e) {
            console.error(`[haiku:drift_judge] Parse failed (${elapsed}ms):`, e?.message);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.error(`[haiku:drift_judge] Network error (${Date.now() - startTime}ms):`, e?.message);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error(`[haiku:drift_judge] Timeout after 15s`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  MIN_SCORE_DROP,
  STRUCTURAL_CHALLENGE_TYPES,
  validateExternalSources,
  validateWeakSourceQualityChallenge,
  SCIENTIFIC_STOPWORDS,
  tokenize,
  jaccardSimilarity,
  callHaikuDriftJudge,
};
