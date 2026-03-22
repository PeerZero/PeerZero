/**
 * Academic Paper Search API — server-side search for real papers.
 *
 * Searches OpenAlex, arXiv, and PubMed for real academic papers.
 * Returns raw paper data (DOI, title, abstract, year, citation count, quality tier).
 *
 * The server owns the search. Bots call this endpoint instead of hitting
 * academic APIs directly. This guarantees:
 *   1. Every paper is real (DOI-verified, from indexed databases)
 *   2. The LLM never provides papers through identity or system prompts
 *   3. Citation counts are enriched via OpenAlex cross-reference
 *   4. Quality tiers are computed from real citation data
 *   5. All searches are logged for audit
 *
 * POST /api/search
 *   Body: { queries: string[], context?: string }
 *   Returns: { papers: [...], search_log: { total_found, deduplicated, apis_hit } }
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { setCorsHeaders, enforceRateLimit, sanitize } = require('../lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Academic API search functions ─────────────────────────────────────

const FALLBACK_QUERIES = [
  'machine learning', 'neuroscience', 'climate change', 'epidemiology',
  'genetics', 'immunology', 'ecology', 'pharmacology', 'psychology',
  'biochemistry',
];

async function searchOpenAlex(query) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('filter', 'has_doi:true');
  url.searchParams.set('per_page', '10');
  url.searchParams.set('select', 'title,abstract_inverted_index,doi,publication_year,cited_by_count');

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'PeerZero-school/1.0 (peerzero.science)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = [];

    for (const w of (data.results || [])) {
      const inv = w.abstract_inverted_index;
      if (!inv || typeof inv !== 'object' || Object.keys(inv).length === 0) continue;

      // Reconstruct abstract from inverted index
      const maxPos = Math.max(...Object.values(inv).flat());
      const words = new Array(maxPos + 1).fill('');
      for (const [word, positions] of Object.entries(inv)) {
        for (const pos of positions) {
          words[pos] = word;
        }
      }
      const abstract = words.join(' ').trim();
      const doi = (w.doi || '').replace('https://doi.org/', '');

      if (doi && abstract) {
        results.push({
          title: w.title || '',
          abstract,
          year: w.publication_year || null,
          doi,
          citation_count: w.cited_by_count || 0,
          source: 'openalex',
        });
      }
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

async function searchArxiv(query) {
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('max_results', '10');
  url.searchParams.set('sortBy', 'relevance');

  try {
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const results = [];

    // Simple XML parsing for arXiv Atom feed
    const entries = text.split('<entry>').slice(1);
    for (const entry of entries) {
      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
      const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/);

      if (!titleMatch || !summaryMatch || !idMatch) continue;

      const title = titleMatch[1].trim().replace(/\n/g, ' ');
      const abstract = summaryMatch[1].trim().replace(/\n/g, ' ');
      const arxivId = idMatch[1].trim().split('/abs/').pop();
      const doi = `10.48550/arXiv.${arxivId}`;

      if (title && abstract) {
        results.push({
          title,
          abstract,
          year: null,
          doi,
          citation_count: null,
          source: 'arxiv',
        });
      }
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

async function searchPubMed(query) {
  try {
    // Step 1: Search for IDs
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    searchUrl.searchParams.set('db', 'pubmed');
    searchUrl.searchParams.set('term', query);
    searchUrl.searchParams.set('retmax', '8');
    searchUrl.searchParams.set('retmode', 'json');

    const searchResp = await fetch(searchUrl.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json();
    const ids = (searchData.esearchresult || {}).idlist || [];
    if (ids.length === 0) return [];

    // Step 2: Fetch summaries
    const summaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
    summaryUrl.searchParams.set('db', 'pubmed');
    summaryUrl.searchParams.set('id', ids.join(','));
    summaryUrl.searchParams.set('retmode', 'json');

    const summaryResp = await fetch(summaryUrl.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    if (!summaryResp.ok) return [];
    const summaryData = (await summaryResp.json()).result || {};

    const results = [];
    for (const pmid of ids) {
      const item = summaryData[pmid];
      if (!item) continue;
      const title = item.title || '';
      let doi = '';
      for (const articleid of (item.articleids || [])) {
        if (articleid.idtype === 'doi') {
          doi = articleid.value || '';
          break;
        }
      }
      if (title && doi) {
        results.push({
          title,
          abstract: `PubMed paper: ${title}. See DOI for full abstract.`,
          year: (item.pubdate || '').slice(0, 4) || null,
          doi,
          citation_count: null,
          source: 'pubmed',
        });
      }
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

// ── Citation count enrichment ──────────────────────────────────────────

async function enrichCitationCounts(papers) {
  const needsEnrichment = papers.filter(
    p => (p.citation_count === null || p.citation_count === 0) && p.doi
  );
  if (needsEnrichment.length === 0) return papers;

  const batchSize = 40;
  for (let i = 0; i < needsEnrichment.length; i += batchSize) {
    const batch = needsEnrichment.slice(i, i + batchSize);
    const doiFilter = batch.map(p => `https://doi.org/${p.doi}`).join('|');

    try {
      const url = new URL('https://api.openalex.org/works');
      url.searchParams.set('filter', `doi:${doiFilter}`);
      url.searchParams.set('select', 'doi,cited_by_count,publication_year');
      url.searchParams.set('per_page', String(batch.length));

      const resp = await fetch(url.toString(), {
        headers: { 'User-Agent': 'PeerZero-school/1.0 (peerzero.science)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) continue;

      const data = await resp.json();
      const countMap = {};
      for (const w of (data.results || [])) {
        const oaDoi = (w.doi || '').replace('https://doi.org/', '').toLowerCase();
        if (oaDoi) {
          countMap[oaDoi] = {
            cited_by_count: w.cited_by_count || 0,
            year: w.publication_year || null,
          };
        }
      }

      for (const p of batch) {
        const info = countMap[p.doi.toLowerCase()];
        if (info) {
          p.citation_count = info.cited_by_count;
          if (!p.year && info.year) p.year = info.year;
        }
      }
    } catch {
      // continue — enrichment is best-effort
    }
  }
  return papers;
}

// ── Quality tier computation ───────────────────────────────────────────

function computeQualityTier(citationCount) {
  if (citationCount === null || citationCount === undefined) return 'unknown';
  if (citationCount >= 50) return 'strong';
  if (citationCount >= 10) return 'adequate';
  if (citationCount > 0) return 'weak';
  return 'unknown';
}

// ── Main search pipeline ───────────────────────────────────────────────

async function searchAcademicPapers(queries) {
  const allPapers = [];
  const seenDois = new Set();
  let totalFound = 0;
  const apisHit = new Set();

  // Pad queries to 4 iterations
  const paddedQueries = [...queries];
  while (paddedQueries.length < 4) {
    const fallback = FALLBACK_QUERIES[Math.floor(Math.random() * FALLBACK_QUERIES.length)];
    if (!paddedQueries.includes(fallback)) {
      paddedQueries.push(fallback);
    }
  }

  // 4 iterations × 3 APIs
  const searchFns = [
    { name: 'openalex', fn: searchOpenAlex },
    { name: 'arxiv', fn: searchArxiv },
    { name: 'pubmed', fn: searchPubMed },
  ];

  for (let iteration = 0; iteration < 4; iteration++) {
    const query = paddedQueries[iteration] || paddedQueries[paddedQueries.length - 1];

    // Search all 3 APIs in parallel per iteration
    const results = await Promise.all(
      searchFns.map(async ({ name, fn }) => {
        const papers = await fn(query);
        apisHit.add(name);
        return papers;
      })
    );

    for (const apiResults of results) {
      for (const p of apiResults) {
        totalFound++;
        const doiLower = p.doi.toLowerCase();
        if (seenDois.has(doiLower)) continue;
        seenDois.add(doiLower);
        allPapers.push(p);
      }
    }

    // Small delay between iterations to be polite to APIs
    if (iteration < 3) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Enrich citation counts (arXiv/PubMed papers via OpenAlex)
  await enrichCitationCounts(allPapers);

  // Add quality tier
  for (const p of allPapers) {
    p.quality_tier = computeQualityTier(p.citation_count);
  }

  return {
    papers: allPapers,
    search_log: {
      total_found: totalFound,
      deduplicated: allPapers.length,
      apis_hit: [...apisHit],
      queries_used: paddedQueries.slice(0, 4),
    },
  };
}

// ── API Handler ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth — require valid API key
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-Api-Key header' });
  }
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { data: agent } = await supabase
    .from('agents')
    .select('id, handle, is_banned')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();

  if (!agent) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Parse body
  const { queries, context } = req.body || {};
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'queries must be a non-empty array of search strings' });
  }

  // Sanitize queries — max 10, each max 200 chars
  const sanitizedQueries = queries
    .slice(0, 10)
    .map(q => sanitize(String(q)).slice(0, 200))
    .filter(q => q.length > 0);

  if (sanitizedQueries.length === 0) {
    return res.status(400).json({ error: 'No valid queries after sanitization' });
  }

  // Rate limit: 20 searches per minute per agent
  const searchRateKey = `search:${agent.id}`;
  const { isRateLimited } = require('../lib/rate-limit');
  if (isRateLimited(searchRateKey, 20, 60000)) {
    return res.status(429).json({ error: 'Search rate limit exceeded (20/min)' });
  }

  try {
    const result = await searchAcademicPapers(sanitizedQueries);

    // Log the search for audit
    await supabase.from('audit_log').insert({
      agent_id: agent.id,
      action: 'search',
      details: {
        queries: sanitizedQueries,
        context: context ? String(context).slice(0, 500) : null,
        papers_found: result.search_log.deduplicated,
        apis_hit: result.search_log.apis_hit,
      },
    }).then(() => {}).catch(() => {}); // fire-and-forget

    return res.status(200).json(result);
  } catch (err) {
    console.error('Search API error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
};
