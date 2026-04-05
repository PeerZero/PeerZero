/**
 * Unit tests for lib/news-search.js
 *
 * Tests URL construction, response parsing, date formatting, XML entity
 * decoding, deduplication, and error handling. All fetch calls are stubbed.
 *
 * Usage:
 *   node tests/test_news_search.js
 */

// Stub env vars
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ── Stub global fetch ──────────────────────────────────────────────────

const fetchResponses = {};
let fetchCalls = [];

global.fetch = async function stubbedFetch(url, opts) {
  fetchCalls.push({ url: url.toString(), opts });
  const urlStr = url.toString();

  for (const [pattern, handler] of Object.entries(fetchResponses)) {
    if (urlStr.includes(pattern)) {
      return handler(urlStr, opts);
    }
  }

  // Default: return empty/error
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

function resetFetch() {
  fetchCalls = [];
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
}

// Now require the module (after fetch is stubbed)
const {
  searchGDELT,
  searchGoogleNews,
  searchWikipediaCurrentEvents,
  searchWikipedia,
  searchCurrentEvents,
} = require('../lib/news-search');

// ═══════════════════════════════════════════════════════════════════════
// Main async test runner
// ═══════════════════════════════════════════════════════════════════════

(async () => {

  // ─── searchGDELT() ─────────────────────────────────────────────────

  section('searchGDELT() — successful response');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({
      articles: [
        {
          title: 'Climate Policy Update',
          url: 'https://example.com/article1',
          domain: 'example.com',
          seendate: '20260315T120000Z',
          language: 'English',
          tone: 2.5,
        },
        {
          title: 'Economic Report',
          url: 'https://example.com/article2',
          domain: 'reuters.com',
          seendate: '20260310T000000Z',
          language: 'English',
          tone: -1.2,
        },
      ],
    }),
  });

  {
    const results = await searchGDELT('climate policy');
    assert(results.length === 2, 'returns 2 articles');
    assert(results[0].title === 'Climate Policy Update', 'preserves title');
    assert(results[0].url === 'https://example.com/article1', 'preserves url');
    assert(results[0].source === 'example.com', 'uses domain as source');
    assert(results[0].date === '2026-03-15', 'formats GDELT date correctly');
    assert(results[0].tone === 2.5, 'preserves tone');
    assert(results[0].search_source === 'gdelt', 'tags search_source as gdelt');
    assert(results[1].tone === -1.2, 'preserves negative tone');
  }

  section('searchGDELT() — empty/error response');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({ ok: false, status: 500 });
  {
    const results = await searchGDELT('test query');
    assert(results.length === 0, 'returns empty array on HTTP error');
  }

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({ articles: [] }),
  });
  {
    const results = await searchGDELT('test query');
    assert(results.length === 0, 'returns empty array when no articles');
  }

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({}),
  });
  {
    const results = await searchGDELT('test query');
    assert(results.length === 0, 'returns empty array when articles key missing');
  }

  section('searchGDELT() — date formatting edge cases');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({
      articles: [
        { title: 'No date', url: 'https://example.com/x', domain: 'test.com' },
        { title: 'Short date', url: 'https://example.com/y', domain: 'test.com', seendate: '2026' },
      ],
    }),
  });
  {
    const results = await searchGDELT('test');
    assert(results[0].date === null, 'null date when seendate missing');
    assert(results[1].date === null, 'null date when seendate too short');
  }

  section('searchGDELT() — URL construction');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({ articles: [] }),
  });
  {
    await searchGDELT('climate change', { maxRecords: 5, timespan: '1month' });
    const url = fetchCalls[0].url;
    assert(url.includes('query=climate+change') || url.includes('query=climate%20change'), 'includes query param');
    assert(url.includes('maxrecords=5'), 'passes maxRecords');
    assert(url.includes('timespan=1month'), 'passes timespan');
    assert(url.includes('format=json'), 'requests JSON');
    assert(url.includes('sort=hybridrel'), 'sorts by hybridrel');
  }

  // ─── searchGoogleNews() ────────────────────────────────────────────

  section('searchGoogleNews() — successful RSS response');

  resetFetch();
  fetchResponses['news.google.com'] = () => ({
    ok: true,
    text: async () => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<item>
  <title>Breaking: Tax Reform Bill Passes</title>
  <link>https://example.com/news1</link>
  <pubDate>Mon, 15 Mar 2026 12:00:00 GMT</pubDate>
  <source url="https://example.com">Example News</source>
</item>
<item>
  <title>Tech &amp; Science Update</title>
  <link>https://example.com/news2</link>
  <pubDate>Sun, 14 Mar 2026 08:00:00 GMT</pubDate>
  <source url="https://reuters.com">Reuters</source>
</item>
</channel>
</rss>`,
  });
  {
    const results = await searchGoogleNews('tax reform');
    assert(results.length === 2, 'returns 2 items');
    assert(results[0].title === 'Breaking: Tax Reform Bill Passes', 'extracts title');
    assert(results[0].url === 'https://example.com/news1', 'extracts link');
    assert(results[0].source === 'Example News', 'extracts source');
    assert(results[0].date !== null, 'extracts date');
    assert(results[0].search_source === 'google_news', 'tags search_source');
    assert(results[1].title === 'Tech & Science Update', 'decodes XML entities in title');
    assert(results[1].source === 'Reuters', 'extracts source from second item');
  }

  section('searchGoogleNews() — maxResults limit');

  resetFetch();
  {
    let items = '';
    for (let i = 0; i < 20; i++) {
      items += `<item><title>Article ${i}</title><link>https://example.com/${i}</link></item>\n`;
    }
    fetchResponses['news.google.com'] = () => ({
      ok: true,
      text: async () => `<rss><channel>${items}</channel></rss>`,
    });

    const results = await searchGoogleNews('test', { maxResults: 5 });
    assert(results.length === 5, 'respects maxResults limit');
  }

  section('searchGoogleNews() — error handling');

  resetFetch();
  fetchResponses['news.google.com'] = () => ({ ok: false, status: 503 });
  {
    const results = await searchGoogleNews('test');
    assert(results.length === 0, 'returns empty array on HTTP error');
  }

  section('searchGoogleNews() — items with no title are skipped');

  resetFetch();
  fetchResponses['news.google.com'] = () => ({
    ok: true,
    text: async () => `<rss><channel>
      <item><title></title><link>https://example.com/empty</link></item>
      <item><title>Real Article</title><link>https://example.com/real</link></item>
    </channel></rss>`,
  });
  {
    const results = await searchGoogleNews('test');
    assert(results.length === 1, 'skips items with empty title');
    assert(results[0].title === 'Real Article', 'keeps valid item');
  }

  // ─── searchWikipediaCurrentEvents() ────────────────────────────────

  section('searchWikipediaCurrentEvents() — successful response');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = (url) => {
    if (url.includes('Portal%3ACurrent_events') || url.includes('Portal:Current_events')) {
      return {
        ok: true,
        json: async () => ({
          parse: {
            text: {
              '*': '<ul><li>Major earthquake strikes region causing widespread damage and rescue operations begin</li><li>International trade agreement signed between several nations around the world</li><li>Short</li><li>' + 'x'.repeat(600) + '</li></ul>',
            },
          },
        }),
      };
    }
    return { ok: false };
  };
  {
    const results = await searchWikipediaCurrentEvents();
    assert(results.length === 2, 'returns items between 20 and 500 chars only');
    assert(results[0].source === 'Wikipedia Current Events', 'source is Wikipedia Current Events');
    assert(results[0].search_source === 'wikipedia_current', 'search_source is wikipedia_current');
    assert(results[0].url.includes('Portal:Current_events'), 'url points to portal');
    assert(results[0].date !== null, 'includes today date');
  }

  section('searchWikipediaCurrentEvents() — error handling');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({ ok: false });
  {
    const results = await searchWikipediaCurrentEvents();
    assert(results.length === 0, 'returns empty array on error');
  }

  // ─── searchWikipedia() ─────────────────────────────────────────────

  section('searchWikipedia() — successful response');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({
    ok: true,
    json: async () => ({
      query: {
        search: [
          {
            title: 'Climate change',
            snippet: 'Climate change is a <span class="searchmatch">long-term</span> shift in temperatures',
            timestamp: '2026-03-10T12:00:00Z',
          },
          {
            title: 'Paris Agreement',
            snippet: 'The Paris Agreement is an international <b>treaty</b>',
            timestamp: '2026-02-20T08:00:00Z',
          },
        ],
      },
    }),
  });
  {
    const results = await searchWikipedia('climate change');
    assert(results.length === 2, 'returns 2 results');
    assert(results[0].title === 'Climate change', 'preserves title');
    assert(!results[0].snippet.includes('<span'), 'strips HTML from snippet');
    assert(results[0].snippet.includes('long-term'), 'preserves snippet text');
    assert(results[0].url.includes('Climate_change'), 'constructs Wikipedia URL');
    assert(results[0].source === 'Wikipedia', 'source is Wikipedia');
    assert(results[0].search_source === 'wikipedia', 'search_source is wikipedia');
    assert(results[0].date === '2026-03-10', 'extracts date from timestamp');
  }

  section('searchWikipedia() — URL encoding in article links');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({
    ok: true,
    json: async () => ({
      query: {
        search: [
          { title: 'United States Congress', snippet: 'The legislature', timestamp: '2026-01-01T00:00:00Z' },
        ],
      },
    }),
  });
  {
    const results = await searchWikipedia('congress');
    assert(results[0].url.includes('United_States_Congress'), 'replaces spaces with underscores in URL');
  }

  section('searchWikipedia() — error handling');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({ ok: false });
  {
    const results = await searchWikipedia('test');
    assert(results.length === 0, 'returns empty array on error');
  }

  // ─── searchCurrentEvents() — pipeline ──────────────────────────────

  section('searchCurrentEvents() — deduplication and search_log');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({
      articles: [
        { title: 'Shared Article', url: 'https://example.com/shared', domain: 'example.com', seendate: '20260315T120000Z' },
        { title: 'GDELT Only', url: 'https://example.com/gdelt-only', domain: 'example.com', seendate: '20260314T120000Z' },
      ],
    }),
  });
  fetchResponses['news.google.com'] = () => ({
    ok: true,
    text: async () => `<rss><channel>
      <item><title>Shared Article</title><link>https://example.com/shared</link></item>
      <item><title>Google Only</title><link>https://example.com/google-only</link></item>
    </channel></rss>`,
  });
  {
    const result = await searchCurrentEvents(['test query']);
    assert(result.articles.length === 3, 'deduplicates by URL (3 unique from 4 total)');
    assert(result.search_log.total_found === 4, 'total_found counts all before dedup');
    assert(result.search_log.deduplicated === 3, 'deduplicated count matches articles length');
    assert(result.search_log.sources_hit.includes('gdelt'), 'sources_hit includes gdelt');
    assert(result.search_log.sources_hit.includes('google_news'), 'sources_hit includes google_news');
    assert(result.search_log.queries_used.length === 1, 'queries_used matches input');
  }

  section('searchCurrentEvents() — query limit');

  resetFetch();
  fetchResponses['gdeltproject.org'] = () => ({
    ok: true,
    json: async () => ({ articles: [] }),
  });
  fetchResponses['news.google.com'] = () => ({
    ok: true,
    text: async () => '<rss><channel></channel></rss>',
  });
  {
    const manyQueries = Array.from({ length: 20 }, (_, i) => `query ${i}`);
    const result = await searchCurrentEvents(manyQueries);
    assert(result.search_log.queries_used.length === 6, 'caps queries at 6');
  }

  section('searchCurrentEvents() — all APIs fail gracefully');

  resetFetch();
  // Default stub returns ok: false, so all APIs fail
  {
    const result = await searchCurrentEvents(['test']);
    assert(result.articles.length === 0, 'returns empty articles when all APIs fail');
    assert(result.search_log.total_found === 0, 'total_found is 0');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
