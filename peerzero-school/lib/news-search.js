/**
 * News & Current Events Search — GDELT + Google News RSS + Wikipedia Current Events.
 *
 * Used by comedy school (context sources) and politics school (current evidence).
 * Returns article metadata — title, description, url, date, source, tone.
 * No DOIs, no citation counts. These are news articles, not academic papers.
 *
 * All APIs are free with no API key required.
 */

const log = require('./logger');

// ── GDELT DOC API ───────────────────────────────────────────────────────────
// Global news monitoring. 15-minute update cycle. Excellent keyword search.
// Returns article metadata with tone scores and themes.

async function searchGDELT(query, { maxRecords = 10, timespan = '3months' } = {}) {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', String(maxRecords));
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', timespan);
  url.searchParams.set('sort', 'hybridrel'); // relevance + recency blend

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'PeerZero-school/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const articles = data.articles || [];

    return articles.map(a => ({
      title: a.title || '',
      url: a.url || '',
      source: a.domain || a.source || 'unknown',
      date: a.seendate ? formatGDELTDate(a.seendate) : null,
      language: a.language || 'English',
      tone: a.tone != null ? parseFloat(a.tone) : null,
      search_source: 'gdelt',
    }));
  } catch (err) {
    const level = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'error' : 'warn';
    log[level](`[search] GDELT search ${err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timed out' : 'failed'}`, { err: err?.message });
    return [];
  }
}

function formatGDELTDate(gdeltDate) {
  // GDELT dates are like "20260315T120000Z" — convert to ISO
  if (!gdeltDate || gdeltDate.length < 8) return null;
  const y = gdeltDate.slice(0, 4);
  const m = gdeltDate.slice(4, 6);
  const d = gdeltDate.slice(6, 8);
  return `${y}-${m}-${d}`;
}

// ── Google News RSS ─────────────────────────────────────────────────────────
// Keyword search via RSS URL. Near real-time. No key needed.
// Returns title + description + link + date.

async function searchGoogleNews(query, { maxResults = 10 } = {}) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'PeerZero-school/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const xml = await resp.text();

    const results = [];
    const items = xml.split('<item>').slice(1);
    for (const item of items.slice(0, maxResults)) {
      const titleMatch = item.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      const linkMatch = item.match(/<link[^>]*>([\s\S]*?)<\/link>/);
      const pubDateMatch = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
      const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);

      const title = titleMatch ? decodeXMLEntities(titleMatch[1].trim()) : '';
      if (!title) continue;

      results.push({
        title,
        url: linkMatch ? linkMatch[1].trim() : '',
        source: sourceMatch ? decodeXMLEntities(sourceMatch[1].trim()) : 'Google News',
        date: pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString().slice(0, 10) : null,
        language: 'English',
        tone: null,
        search_source: 'google_news',
      });
    }
    return results;
  } catch (err) {
    const level = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'error' : 'warn';
    log[level](`[search] Google News search ${err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timed out' : 'failed'}`, { err: err?.message });
    return [];
  }
}

// ── Wikipedia Current Events ────────────────────────────────────────────────
// Human-curated daily world event summaries. Great for context.
// Returns structured event descriptions with wiki links.

async function searchWikipediaCurrentEvents() {
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&format=json&prop=text';

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'PeerZero-school/1.0 (peerzero.science)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const html = (data.parse?.text?.['*'] || '');

    // Extract event items from the HTML list items
    const events = [];
    const liMatches = html.match(/<li[^>]*>([\s\S]*?)<\/li>/g) || [];
    for (const li of liMatches.slice(0, 20)) {
      const text = li
        .replace(/<[^>]+>/g, '')     // strip HTML tags
        .replace(/\s+/g, ' ')        // collapse whitespace
        .trim();
      if (text.length > 20 && text.length < 500) {
        events.push({
          title: text.slice(0, 200),
          url: 'https://en.wikipedia.org/wiki/Portal:Current_events',
          source: 'Wikipedia Current Events',
          date: new Date().toISOString().slice(0, 10),
          language: 'English',
          tone: null,
          search_source: 'wikipedia_current',
        });
      }
    }
    return events;
  } catch (err) {
    const level = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'error' : 'warn';
    log[level](`[search] Wikipedia current events ${err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timed out' : 'failed'}`, { err: err?.message });
    return [];
  }
}

// ── Wikipedia article search ────────────────────────────────────────────────
// Full-text search across Wikipedia for background/historical context.

async function searchWikipedia(query, { maxResults = 10 } = {}) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', String(maxResults));
  url.searchParams.set('srprop', 'snippet|timestamp');
  url.searchParams.set('format', 'json');

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'PeerZero-school/1.0 (peerzero.science)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = (data.query?.search || []);

    return results.map(r => ({
      title: r.title || '',
      snippet: (r.snippet || '').replace(/<[^>]+>/g, '').trim(),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      source: 'Wikipedia',
      date: r.timestamp ? r.timestamp.slice(0, 10) : null,
      search_source: 'wikipedia',
    }));
  } catch (err) {
    const level = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'error' : 'warn';
    log[level](`[search] Wikipedia search ${err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timed out' : 'failed'}`, { err: err?.message });
    return [];
  }
}

// ── Main search pipeline ────────────────────────────────────────────────────

/**
 * Search current events across GDELT + Google News.
 * @param {string[]} queries - Search queries (max 10)
 * @param {object} options
 * @param {string} options.timespan - GDELT timespan (default '3months')
 * @returns {{ articles: object[], search_log: object }}
 */
async function searchCurrentEvents(queries, { timespan = '3months' } = {}) {
  const allArticles = [];
  const seenUrls = new Set();
  let totalFound = 0;
  const sourcesHit = new Set();

  const paddedQueries = queries.slice(0, 6);

  for (let i = 0; i < paddedQueries.length; i++) {
    const query = paddedQueries[i];

    const results = await Promise.all([
      searchGDELT(query, { maxRecords: 8, timespan }).then(r => { sourcesHit.add('gdelt'); return r; }),
      searchGoogleNews(query, { maxResults: 8 }).then(r => { sourcesHit.add('google_news'); return r; }),
    ]);

    for (const apiResults of results) {
      for (const a of apiResults) {
        totalFound++;
        const urlKey = (a.url || a.title).toLowerCase().slice(0, 200);
        if (seenUrls.has(urlKey)) continue;
        seenUrls.add(urlKey);
        allArticles.push(a);
      }
    }

    if (i < paddedQueries.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  return {
    articles: allArticles,
    search_log: {
      total_found: totalFound,
      deduplicated: allArticles.length,
      sources_hit: [...sourcesHit],
      queries_used: paddedQueries,
    },
  };
}

// ── Utility ─────────────────────────────────────────────────────────────────

function decodeXMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

module.exports = {
  searchGDELT,
  searchGoogleNews,
  searchWikipediaCurrentEvents,
  searchWikipedia,
  searchCurrentEvents,
};
