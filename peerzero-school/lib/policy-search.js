/**
 * Policy & Historical Source Search — CORE + Congress.gov + GovInfo + Wikipedia.
 *
 * Used by politics school for:
 *  1. Current evidence: CORE (open access research) + existing OpenAlex/arXiv
 *  2. Historical precedent: Wikipedia + CORE (date-filtered) + Congress.gov + GovInfo
 *
 * All APIs are free. CORE requires a free API key (set CORE_API_KEY env var).
 * Congress.gov requires a free API key (set CONGRESS_API_KEY env var).
 * GovInfo requires a free API key (set GOVINFO_API_KEY env var).
 * Wikipedia needs no key.
 *
 * If API keys are not set, those sources are silently skipped.
 */

const { searchWikipedia } = require('./news-search');

// ── CORE (core.ac.uk) — Open access research ───────────────────────────────
// 136M+ open access papers. Free key, 10k requests/day.
// Good for political science, policy research, economics.

async function searchCORE(query, { maxResults = 10 } = {}) {
  const apiKey = process.env.CORE_API_KEY;
  if (!apiKey) return [];

  const url = new URL('https://api.core.ac.uk/v3/search/works');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(maxResults));

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'PeerZero-school/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = data.results || [];

    return results
      .filter(r => r.title && (r.abstract || r.fullText))
      .map(r => ({
        title: r.title,
        abstract: (r.abstract || '').slice(0, 1000),
        year: r.yearPublished || null,
        doi: r.doi || null,
        source: 'core',
        url: r.downloadUrl || r.sourceFulltextUrls?.[0] || null,
        journal: r.publisher || null,
      }))
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

// ── Congress.gov API — US Legislation ───────────────────────────────────────
// Bills, amendments, resolutions. Free key, generous limits.

async function searchCongress(query, { maxResults = 10 } = {}) {
  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) return [];

  const url = new URL('https://api.congress.gov/v3/bill');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(maxResults));
  url.searchParams.set('format', 'json');

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': apiKey,
        'User-Agent': 'PeerZero-school/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const bills = data.bills || [];

    return bills.map(b => ({
      title: b.title || b.shortTitle || '',
      summary: (b.latestSummary?.text || '').replace(/<[^>]+>/g, '').slice(0, 500),
      congress: b.congress || null,
      bill_number: b.number ? `${b.type || ''}${b.number}` : null,
      date: b.latestAction?.actionDate || null,
      url: b.url || `https://www.congress.gov/bill/${b.congress}th-congress/${(b.type || '').toLowerCase()}-bill/${b.number}`,
      source: 'congress_gov',
    }));
  } catch {
    return [];
  }
}

// ── GovInfo API — US Government Reports ─────────────────────────────────────
// CBO, CRS, GAO reports. Free key, 1000/hr.

async function searchGovInfo(query, { maxResults = 10 } = {}) {
  const apiKey = process.env.GOVINFO_API_KEY;
  if (!apiKey) return [];

  const url = new URL('https://api.govinfo.gov/search');
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', String(maxResults));
  url.searchParams.set('offsetMark', '*');

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': apiKey,
        'User-Agent': 'PeerZero-school/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = data.results || [];

    return results.map(r => ({
      title: r.title || '',
      summary: (r.description || '').slice(0, 500),
      date: r.dateIssued || r.lastModified || null,
      collection: r.collectionCode || null,
      url: r.download?.pdfLink || r.detailsLink || null,
      source: 'govinfo',
    }));
  } catch {
    return [];
  }
}

// ── Main policy search pipelines ────────────────────────────────────────────

/**
 * Search for current policy evidence across CORE + OpenAlex (called separately).
 * @param {string[]} queries
 * @returns {{ sources: object[], search_log: object }}
 */
async function searchPolicySources(queries) {
  const allSources = [];
  const seenKeys = new Set();
  let totalFound = 0;
  const apisHit = new Set();

  const paddedQueries = queries.slice(0, 6);

  for (let i = 0; i < paddedQueries.length; i++) {
    const query = paddedQueries[i];

    const results = await Promise.all([
      searchCORE(query, { maxResults: 5 }).then(r => { if (r.length) apisHit.add('core'); return r; }),
      searchCongress(query, { maxResults: 3 }).then(r => { if (r.length) apisHit.add('congress_gov'); return r; }),
      searchGovInfo(query, { maxResults: 3 }).then(r => { if (r.length) apisHit.add('govinfo'); return r; }),
    ]);

    for (const apiResults of results) {
      for (const s of apiResults) {
        totalFound++;
        const key = (s.doi || s.url || s.title || '').toLowerCase().slice(0, 200);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        allSources.push(s);
      }
    }

    if (i < paddedQueries.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  return {
    sources: allSources,
    search_log: {
      total_found: totalFound,
      deduplicated: allSources.length,
      sources_hit: [...apisHit],
      queries_used: paddedQueries,
    },
  };
}

/**
 * Search for historical precedents — Wikipedia + Congress.gov + CORE (date-filtered).
 * @param {string[]} queries - Historical search queries
 * @returns {{ precedents: object[], search_log: object }}
 */
async function searchHistoricalPrecedents(queries) {
  const allPrecedents = [];
  const seenKeys = new Set();
  let totalFound = 0;
  const apisHit = new Set();

  const paddedQueries = queries.slice(0, 6);

  for (let i = 0; i < paddedQueries.length; i++) {
    const query = paddedQueries[i];

    const results = await Promise.all([
      searchWikipedia(query, { maxResults: 5 }).then(r => { if (r.length) apisHit.add('wikipedia'); return r; }),
      searchCongress(query, { maxResults: 3 }).then(r => { if (r.length) apisHit.add('congress_gov'); return r; }),
      searchCORE(query, { maxResults: 3 }).then(r => { if (r.length) apisHit.add('core'); return r; }),
    ]);

    for (const apiResults of results) {
      for (const s of apiResults) {
        totalFound++;
        const key = (s.doi || s.url || s.title || '').toLowerCase().slice(0, 200);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        allPrecedents.push(s);
      }
    }

    if (i < paddedQueries.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  return {
    precedents: allPrecedents,
    search_log: {
      total_found: totalFound,
      deduplicated: allPrecedents.length,
      sources_hit: [...apisHit],
      queries_used: paddedQueries,
    },
  };
}

module.exports = {
  searchCORE,
  searchCongress,
  searchGovInfo,
  searchPolicySources,
  searchHistoricalPrecedents,
};
