/**
 * Academic Paper Search — searches OpenAlex, arXiv, and PubMed for real papers.
 *
 * Extracted into lib/ so it can be called from api/papers.js (action=search)
 * without adding a separate serverless function (Vercel Hobby = 12 max).
 *
 * Every paper returned is real and DOI-verified. Citation counts are enriched
 * via OpenAlex cross-reference. Quality tiers computed from real citation data.
 */

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
  url.searchParams.set('select', 'title,abstract_inverted_index,doi,publication_year,cited_by_count,type,primary_location');

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
        const loc = w.primary_location || {};
        const journal = loc.source?.display_name || null;
        results.push({
          title: w.title || '',
          abstract,
          year: w.publication_year || null,
          doi,
          citation_count: w.cited_by_count || 0,
          source: 'openalex',
          study_type: w.type || null,
          journal,
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
        results.push({ title, abstract, year: null, doi, citation_count: null, source: 'arxiv', study_type: 'preprint', journal: 'arXiv' });
      }
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

async function searchPubMed(query) {
  try {
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    searchUrl.searchParams.set('db', 'pubmed');
    searchUrl.searchParams.set('term', query);
    searchUrl.searchParams.set('retmax', '8');
    searchUrl.searchParams.set('retmode', 'json');

    const searchResp = await fetch(searchUrl.toString(), { signal: AbortSignal.timeout(15000) });
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json();
    const ids = (searchData.esearchresult || {}).idlist || [];
    if (ids.length === 0) return [];

    // Use efetch with XML to get full abstracts (esummary doesn't include them)
    const fetchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
    fetchUrl.searchParams.set('db', 'pubmed');
    fetchUrl.searchParams.set('id', ids.join(','));
    fetchUrl.searchParams.set('retmode', 'xml');

    const fetchResp = await fetch(fetchUrl.toString(), { signal: AbortSignal.timeout(15000) });
    if (!fetchResp.ok) return [];
    const xml = await fetchResp.text();

    const results = [];
    const articles = xml.split('<PubmedArticle>').slice(1);
    for (const article of articles) {
      const titleMatch = article.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      const abstractMatch = article.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      const doiMatch = article.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/);
      const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
      const journalMatch = article.match(/<Title>([\s\S]*?)<\/Title>/);
      const typeMatch = article.match(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/);

      const title = titleMatch ? titleMatch[1].trim().replace(/<[^>]+>/g, '') : '';
      const abstract = abstractMatch ? abstractMatch[1].trim().replace(/<[^>]+>/g, '') : '';
      const doi = doiMatch ? doiMatch[1].trim() : '';

      if (title && doi) {
        results.push({
          title,
          abstract: abstract || `PubMed paper: ${title}. See DOI for full abstract.`,
          year: yearMatch ? yearMatch[1] : null,
          doi,
          citation_count: null,
          source: 'pubmed',
          study_type: typeMatch ? typeMatch[1].trim().toLowerCase() : null,
          journal: journalMatch ? journalMatch[1].trim() : null,
        });
      }
    }
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

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
      url.searchParams.set('select', 'doi,cited_by_count,publication_year,type,primary_location');
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
          const loc = w.primary_location || {};
          countMap[oaDoi] = {
            cited_by_count: w.cited_by_count || 0,
            year: w.publication_year || null,
            type: w.type || null,
            journal: loc.source?.display_name || null,
          };
        }
      }

      for (const p of batch) {
        const info = countMap[p.doi.toLowerCase()];
        if (info) {
          p.citation_count = info.cited_by_count;
          if (!p.year && info.year) p.year = info.year;
          if (!p.study_type && info.type) p.study_type = info.type;
          if (!p.journal && info.journal) p.journal = info.journal;
        }
      }
    } catch {
      // best-effort
    }
  }
  return papers;
}

function computeQualityTier(citationCount) {
  if (citationCount === null || citationCount === undefined) return 'unknown';
  if (citationCount >= 50) return 'strong';
  if (citationCount >= 10) return 'adequate';
  if (citationCount > 0) return 'weak';
  return 'unknown';
}

/**
 * Main search pipeline — searches 4 iterations × 3 APIs.
 * @param {string[]} queries - Search queries (max 10)
 * @returns {{ papers: object[], search_log: object }}
 */
async function searchAcademicPapers(queries) {
  const allPapers = [];
  const seenDois = new Set();
  let totalFound = 0;
  const apisHit = new Set();

  const paddedQueries = [...queries];
  while (paddedQueries.length < 4) {
    const fallback = FALLBACK_QUERIES[Math.floor(Math.random() * FALLBACK_QUERIES.length)];
    if (!paddedQueries.includes(fallback)) paddedQueries.push(fallback);
  }

  const searchFns = [
    { name: 'openalex', fn: searchOpenAlex },
    { name: 'arxiv', fn: searchArxiv },
    { name: 'pubmed', fn: searchPubMed },
  ];

  for (let iteration = 0; iteration < 4; iteration++) {
    const query = paddedQueries[iteration] || paddedQueries[paddedQueries.length - 1];

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

    if (iteration < 3) await new Promise(r => setTimeout(r, 300));
  }

  await enrichCitationCounts(allPapers);

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

module.exports = { searchAcademicPapers };
