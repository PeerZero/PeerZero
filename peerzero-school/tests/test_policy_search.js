/**
 * Unit tests for lib/policy-search.js
 *
 * Tests URL construction, response parsing, deduplication, query limits,
 * API key gating, and error handling. All fetch calls are stubbed.
 *
 * Usage:
 *   node tests/test_policy_search.js
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

  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

function resetFetch() {
  fetchCalls = [];
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
}

// Set API keys so search functions don't bail out early
process.env.CORE_API_KEY = 'test-core-key';
process.env.CONGRESS_API_KEY = 'test-congress-key';
process.env.GOVINFO_API_KEY = 'test-govinfo-key';

// Now require the module (after fetch + env are set)
const {
  searchCORE,
  searchCongress,
  searchGovInfo,
  searchPolicySources,
  searchHistoricalPrecedents,
} = require('../lib/policy-search');

(async () => {

  // ═══════════════════════════════════════════════════════════════════════
  // searchCORE()
  // ═══════════════════════════════════════════════════════════════════════

  section('searchCORE() — successful response');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        {
          title: 'Political Economy of Climate Policy',
          abstract: 'This paper examines the political dynamics...',
          yearPublished: 2024,
          doi: '10.1234/test',
          downloadUrl: 'https://core.ac.uk/download/pdf/12345.pdf',
          publisher: 'Journal of Political Science',
        },
        {
          title: 'Electoral Reform Analysis',
          abstract: 'A comprehensive analysis of electoral systems...',
          yearPublished: 2023,
          doi: null,
          sourceFulltextUrls: ['https://example.com/paper.pdf'],
          publisher: null,
        },
        {
          title: 'No Abstract Paper',
          abstract: null,
          fullText: null,
          yearPublished: 2022,
        },
      ],
    }),
  });
  {
    const results = await searchCORE('climate policy');
    assert(results.length === 2, 'filters out results without abstract or fullText');
    assert(results[0].title === 'Political Economy of Climate Policy', 'preserves title');
    assert(results[0].year === 2024, 'preserves year');
    assert(results[0].doi === '10.1234/test', 'preserves doi');
    assert(results[0].source === 'core', 'tags source as core');
    assert(results[0].url === 'https://core.ac.uk/download/pdf/12345.pdf', 'uses downloadUrl');
    assert(results[0].journal === 'Journal of Political Science', 'preserves publisher as journal');
    assert(results[1].url === 'https://example.com/paper.pdf', 'falls back to sourceFulltextUrls');
    assert(results[1].journal === null, 'null publisher becomes null journal');
  }

  section('searchCORE() — URL and auth');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({ results: [] }),
  });
  {
    await searchCORE('electoral reform', { maxResults: 5 });
    const call = fetchCalls[0];
    assert(call.url.includes('q=electoral+reform') || call.url.includes('q=electoral%20reform'), 'includes query param');
    assert(call.url.includes('limit=5'), 'passes maxResults as limit');
    assert(call.opts.headers['Authorization'] === 'Bearer test-core-key', 'sends Bearer token');
  }

  section('searchCORE() — no API key returns empty');

  {
    const saved = process.env.CORE_API_KEY;
    delete process.env.CORE_API_KEY;

    // Need to re-require to test the env check at call time
    // But the module captures env at call time, not require time, so this works
    const { searchCORE: searchCORENoKey } = require('../lib/policy-search');
    const results = await searchCORENoKey('test');
    assert(results.length === 0, 'returns empty when no CORE_API_KEY');

    process.env.CORE_API_KEY = saved;
  }

  section('searchCORE() — HTTP error');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({ ok: false, status: 500 });
  {
    const results = await searchCORE('test');
    assert(results.length === 0, 'returns empty array on HTTP error');
  }

  section('searchCORE() — abstract truncation');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Long Abstract', abstract: 'x'.repeat(2000), yearPublished: 2024 },
      ],
    }),
  });
  {
    const results = await searchCORE('test');
    assert(results[0].abstract.length <= 1000, 'truncates abstract to 1000 chars');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // searchCongress()
  // ═══════════════════════════════════════════════════════════════════════

  section('searchCongress() — successful response');

  resetFetch();
  fetchResponses['api.congress.gov'] = () => ({
    ok: true,
    json: async () => ({
      bills: [
        {
          title: 'Infrastructure Investment and Jobs Act',
          shortTitle: 'IIJA',
          latestSummary: { text: '<p>This bill provides funding for <b>infrastructure</b>.</p>' },
          congress: 117,
          type: 'HR',
          number: 3684,
          latestAction: { actionDate: '2021-11-15' },
          url: 'https://www.congress.gov/bill/117th-congress/house-bill/3684',
        },
        {
          title: 'Clean Air Act Amendment',
          latestSummary: null,
          congress: 118,
          type: 'S',
          number: 42,
          latestAction: null,
        },
      ],
    }),
  });
  {
    const results = await searchCongress('infrastructure');
    assert(results.length === 2, 'returns 2 bills');
    assert(results[0].title === 'Infrastructure Investment and Jobs Act', 'preserves title');
    assert(!results[0].summary.includes('<p>'), 'strips HTML from summary');
    assert(results[0].summary.includes('infrastructure'), 'preserves summary text');
    assert(results[0].congress === 117, 'preserves congress number');
    assert(results[0].bill_number === 'HR3684', 'constructs bill number');
    assert(results[0].date === '2021-11-15', 'extracts action date');
    assert(results[0].source === 'congress_gov', 'tags source');
    assert(results[1].summary === '', 'null summary becomes empty string');
    assert(results[1].bill_number === 'S42', 'constructs senate bill number');
    assert(results[1].date === null, 'null latestAction gives null date');
  }

  section('searchCongress() — auth header');

  resetFetch();
  fetchResponses['api.congress.gov'] = () => ({
    ok: true,
    json: async () => ({ bills: [] }),
  });
  {
    await searchCongress('test');
    assert(fetchCalls[0].opts.headers['X-Api-Key'] === 'test-congress-key', 'sends X-Api-Key header');
  }

  section('searchCongress() — no API key returns empty');

  {
    const saved = process.env.CONGRESS_API_KEY;
    delete process.env.CONGRESS_API_KEY;
    const { searchCongress: searchCongressNoKey } = require('../lib/policy-search');
    const results = await searchCongressNoKey('test');
    assert(results.length === 0, 'returns empty when no CONGRESS_API_KEY');
    process.env.CONGRESS_API_KEY = saved;
  }

  section('searchCongress() — HTTP error');

  resetFetch();
  fetchResponses['api.congress.gov'] = () => ({ ok: false, status: 429 });
  {
    const results = await searchCongress('test');
    assert(results.length === 0, 'returns empty array on HTTP error');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // searchGovInfo()
  // ═══════════════════════════════════════════════════════════════════════

  section('searchGovInfo() — successful response');

  resetFetch();
  fetchResponses['api.govinfo.gov'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        {
          title: 'CBO Budget Analysis 2026',
          description: 'The Congressional Budget Office analysis of federal spending.',
          dateIssued: '2026-01-15',
          collectionCode: 'BUDGET',
          download: { pdfLink: 'https://govinfo.gov/pdf/budget2026.pdf' },
        },
        {
          title: 'GAO Report on Defense Spending',
          description: null,
          lastModified: '2025-12-01',
          collectionCode: 'GAOREPORTS',
          detailsLink: 'https://govinfo.gov/details/gao123',
        },
      ],
    }),
  });
  {
    const results = await searchGovInfo('budget');
    assert(results.length === 2, 'returns 2 results');
    assert(results[0].title === 'CBO Budget Analysis 2026', 'preserves title');
    assert(results[0].summary.includes('Congressional Budget Office'), 'preserves description as summary');
    assert(results[0].date === '2026-01-15', 'uses dateIssued');
    assert(results[0].collection === 'BUDGET', 'preserves collection code');
    assert(results[0].url === 'https://govinfo.gov/pdf/budget2026.pdf', 'uses pdfLink');
    assert(results[0].source === 'govinfo', 'tags source');
    assert(results[1].summary === '', 'null description becomes empty via slice');
    assert(results[1].date === '2025-12-01', 'falls back to lastModified');
    assert(results[1].url === 'https://govinfo.gov/details/gao123', 'falls back to detailsLink');
  }

  section('searchGovInfo() — auth header');

  resetFetch();
  fetchResponses['api.govinfo.gov'] = () => ({
    ok: true,
    json: async () => ({ results: [] }),
  });
  {
    await searchGovInfo('test');
    assert(fetchCalls[0].opts.headers['X-Api-Key'] === 'test-govinfo-key', 'sends X-Api-Key header');
  }

  section('searchGovInfo() — no API key returns empty');

  {
    const saved = process.env.GOVINFO_API_KEY;
    delete process.env.GOVINFO_API_KEY;
    const { searchGovInfo: searchGovInfoNoKey } = require('../lib/policy-search');
    const results = await searchGovInfoNoKey('test');
    assert(results.length === 0, 'returns empty when no GOVINFO_API_KEY');
    process.env.GOVINFO_API_KEY = saved;
  }

  section('searchGovInfo() — HTTP error');

  resetFetch();
  fetchResponses['api.govinfo.gov'] = () => ({ ok: false, status: 500 });
  {
    const results = await searchGovInfo('test');
    assert(results.length === 0, 'returns empty array on HTTP error');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // searchPolicySources() — pipeline
  // ═══════════════════════════════════════════════════════════════════════

  section('searchPolicySources() — aggregation and deduplication');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Shared Paper', abstract: 'Abstract text', doi: '10.1234/shared', yearPublished: 2024 },
        { title: 'CORE Only Paper', abstract: 'Another abstract', doi: '10.1234/core-only', yearPublished: 2023 },
      ],
    }),
  });
  fetchResponses['api.congress.gov'] = () => ({
    ok: true,
    json: async () => ({
      bills: [
        { title: 'Test Bill', congress: 118, type: 'HR', number: 1, url: 'https://congress.gov/bill/1' },
      ],
    }),
  });
  fetchResponses['api.govinfo.gov'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Gov Report', description: 'A report', dateIssued: '2026-01-01', download: { pdfLink: 'https://govinfo.gov/pdf/1.pdf' } },
      ],
    }),
  });
  {
    const result = await searchPolicySources(['test query']);
    assert(result.sources.length >= 3, 'aggregates from multiple APIs');
    assert(result.search_log.total_found >= 3, 'total_found counts all results');
    assert(result.search_log.deduplicated === result.sources.length, 'deduplicated matches sources length');
    assert(result.search_log.sources_hit.includes('core'), 'sources_hit includes core');
    assert(result.search_log.sources_hit.includes('congress_gov'), 'sources_hit includes congress_gov');
    assert(result.search_log.sources_hit.includes('govinfo'), 'sources_hit includes govinfo');
    assert(result.search_log.queries_used.length === 1, 'queries_used matches input');
  }

  section('searchPolicySources() — query limit');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({ ok: true, json: async () => ({ results: [] }) });
  fetchResponses['api.congress.gov'] = () => ({ ok: true, json: async () => ({ bills: [] }) });
  fetchResponses['api.govinfo.gov'] = () => ({ ok: true, json: async () => ({ results: [] }) });
  {
    const manyQueries = Array.from({ length: 20 }, (_, i) => `query ${i}`);
    const result = await searchPolicySources(manyQueries);
    assert(result.search_log.queries_used.length === 6, 'caps queries at 6');
  }

  section('searchPolicySources() — deduplication by doi');

  resetFetch();
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Paper A', abstract: 'Abstract', doi: '10.1234/same-doi', yearPublished: 2024 },
        { title: 'Paper A Duplicate', abstract: 'Same abstract', doi: '10.1234/same-doi', yearPublished: 2024 },
      ],
    }),
  });
  fetchResponses['api.congress.gov'] = () => ({ ok: true, json: async () => ({ bills: [] }) });
  fetchResponses['api.govinfo.gov'] = () => ({ ok: true, json: async () => ({ results: [] }) });
  {
    const result = await searchPolicySources(['test']);
    assert(result.sources.length === 1, 'deduplicates by DOI');
    assert(result.search_log.total_found === 2, 'total_found counts before dedup');
  }

  section('searchPolicySources() — all APIs fail gracefully');

  resetFetch();
  {
    const result = await searchPolicySources(['test']);
    assert(result.sources.length === 0, 'returns empty when all APIs fail');
    assert(result.search_log.total_found === 0, 'total_found is 0');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // searchHistoricalPrecedents() — pipeline
  // ═══════════════════════════════════════════════════════════════════════

  section('searchHistoricalPrecedents() — aggregation');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({
    ok: true,
    json: async () => ({
      query: {
        search: [
          { title: 'New Deal', snippet: 'The New Deal was a series of programs', timestamp: '2026-01-01T00:00:00Z' },
        ],
      },
    }),
  });
  fetchResponses['api.congress.gov'] = () => ({
    ok: true,
    json: async () => ({
      bills: [
        { title: 'Social Security Act', congress: 74, type: 'HR', number: 7260, latestAction: { actionDate: '1935-08-14' } },
      ],
    }),
  });
  fetchResponses['api.core.ac.uk'] = () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Historical Policy Analysis', abstract: 'A study of historical policy', yearPublished: 2020 },
      ],
    }),
  });
  {
    const result = await searchHistoricalPrecedents(['new deal economic policy']);
    assert(result.precedents.length >= 2, 'aggregates from Wikipedia + Congress + CORE');
    assert(result.search_log.sources_hit.includes('wikipedia'), 'sources_hit includes wikipedia');
    assert(result.search_log.sources_hit.includes('congress_gov'), 'sources_hit includes congress_gov');
    assert(result.search_log.queries_used.length === 1, 'queries_used matches input');
  }

  section('searchHistoricalPrecedents() — query limit');

  resetFetch();
  fetchResponses['en.wikipedia.org'] = () => ({ ok: true, json: async () => ({ query: { search: [] } }) });
  fetchResponses['api.congress.gov'] = () => ({ ok: true, json: async () => ({ bills: [] }) });
  fetchResponses['api.core.ac.uk'] = () => ({ ok: true, json: async () => ({ results: [] }) });
  {
    const manyQueries = Array.from({ length: 20 }, (_, i) => `query ${i}`);
    const result = await searchHistoricalPrecedents(manyQueries);
    assert(result.search_log.queries_used.length === 6, 'caps queries at 6');
  }

  section('searchHistoricalPrecedents() — all APIs fail gracefully');

  resetFetch();
  {
    const result = await searchHistoricalPrecedents(['test']);
    assert(result.precedents.length === 0, 'returns empty when all APIs fail');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
