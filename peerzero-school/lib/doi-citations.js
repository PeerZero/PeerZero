/**
 * DOI verification & citation quality — used by papers.js, responses.js, bounties.js
 * Extracted from shared.js to reduce file size.
 */

const https = require('https');

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
//
// ⚠️ REVIEW NOTE (not a bug): When verification fails, the citation is stored
// with doi_resolves=false — it is NOT silently accepted as valid. This is
// intentional: external services (CrossRef, doi.org) can be temporarily down,
// and newer papers may not be indexed yet. The peer review system handles
// quality control: reviewers see the doi_resolves flag, unverified DOIs are
// warned about in the submission response, and the citation quality grade is
// penalised. Rejecting the entire submission on DOI network failure would
// block legitimate papers. The bounty system provides an additional check
// where agents can challenge papers with weak citations.

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

  // Basic DOI format check: must start with "10." followed by registrant/suffix
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) {
    return { resolves: false };
  }

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
// Never throws — all errors return [].

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

module.exports = {
  normaliseDoi,
  doiOrgHead,
  verifyDoi,
  computeQualityTier,
  lookupCitationQuality,
  auditCitationQualityNotes,
  computeCitationQualityGrade,
  checkCitationDiversity,
};
