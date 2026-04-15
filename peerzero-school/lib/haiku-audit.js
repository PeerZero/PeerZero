/**
 * Haiku LLM audit functions extracted from api/papers.js
 * - callAnthropicHaiku() - low-level Haiku API call
 * - generateHaikuAudit() - builds prompt and calls Haiku for paper audit
 * - getOrGenerateHaikuAudit() - cache layer around generateHaikuAudit
 */

const https = require('https');
const { getSupabase } = require('./shared');
const { sanitize } = require('./sanitize');
const log = require('./logger');

// ── Server-side LLM usage tracking ──────────────────────────────────────
let _totalInputTokens = 0;
let _totalOutputTokens = 0;
let _activeCalls = 0;
const MAX_CONCURRENT_LLM_CALLS = 5;

/** Return cumulative token usage since last cold start */
function getServerLLMUsage() {
  return { input_tokens: _totalInputTokens, output_tokens: _totalOutputTokens };
}

// ── Haiku audit ───────────────────────────────────────────────────────────────
function callAnthropicHaiku(prompt, context = 'unknown') {
  const startTime = Date.now();
  return new Promise((resolve) => {
    if (_activeCalls >= MAX_CONCURRENT_LLM_CALLS) {
      log.warn(`[haiku:${context}] Concurrency limit reached (${_activeCalls}/${MAX_CONCURRENT_LLM_CALLS}) — skipping call`);
      return resolve(null);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      log.error(`[haiku:${context}] ANTHROPIC_API_KEY not set — skipping call`);
      return resolve(null);
    }

    _activeCalls++;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        timeout: 25000,
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
          _activeCalls--;
          if (res.statusCode === 429) {
            log.warn(`[haiku:${context}] Rate limited (429)`, { elapsed, retryAfter: res.headers['retry-after'] || 'unknown' });
            return resolve(null);
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed?.usage) {
              _totalInputTokens += parsed.usage.input_tokens || 0;
              _totalOutputTokens += parsed.usage.output_tokens || 0;
              log.info(`[haiku:${context}] Token usage`, { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens, cumInput: _totalInputTokens, cumOutput: _totalOutputTokens });
            }
            if (parsed?.error) {
              log.error(`[haiku:${context}] API error`, { elapsed, errorType: parsed.error.type, errorMessage: parsed.error.message });
              return resolve(null);
            }
            const text = parsed?.content?.[0]?.text || '';
            const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            const result = JSON.parse(clean);
            log.info(`[haiku:${context}] OK`, { elapsed });
            resolve(result);
          } catch (e) {
            log.error(`[haiku:${context}] Parse failed`, { elapsed, err: e?.message });
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      _activeCalls--;
      log.error(`[haiku:${context}] Network error`, { elapsed: Date.now() - startTime, err: e?.message });
      resolve(null);
    });
    req.on('timeout', () => {
      _activeCalls--;
      req.destroy();
      log.error(`[haiku:${context}] Timeout after 25s`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function generateHaikuAudit(paper, reviews, citations, revisionNumber) {
  const reviewSummaries = (reviews || []).slice(0, 10).map((r, i) => ({
    reviewer: i + 1,
    score: r.score,
    methodology: r.methodology_notes || '',
    statistics: r.statistical_validity_notes || '',
    citations: r.citation_accuracy_notes || '',
    logic: r.logical_consistency_notes || '',
    overall: r.overall_assessment || '',
  }));

  const citationSummaries = (citations || []).slice(0, 8).map(c => ({
    doi: c.doi,
    summary: c.agent_summary || '',
    resolves: c.doi_resolves,
    citation_count: c.citation_count ?? null,
    quality_tier: c.quality_tier || 'unknown',
    source_quality_note: c.source_quality_note || '',
  }));

  const prompt = `You are a scientific peer review coach analyzing a paper that is about to be revised.

PAPER:
Title: ${sanitize(paper.title || '')}
Abstract: ${sanitize(paper.abstract || '')}
Cross-study connection: ${sanitize(paper.cross_study_connection || 'NOT PROVIDED')}
Mechanism chain: ${paper.mechanism_chain ? sanitize(paper.mechanism_chain.join(' \u2192 ')) : 'NOT PROVIDED'}
Falsifiable claim: ${sanitize(paper.falsifiable_claim || 'NOT PROVIDED')}
Current score: ${paper.weighted_score || 'unscored'}
Revision number being prepared: ${revisionNumber}

CITATIONS (${citationSummaries.length} total):
${JSON.stringify(citationSummaries, null, 2)}

REVIEWER FEEDBACK (${reviewSummaries.length} reviews):
${JSON.stringify(reviewSummaries, null, 2)}

Analyze this paper and its reviews. Identify what reviewers explicitly criticized, what obvious problems they MISSED, and give precise revision instructions. Pay attention to citation quality_tier \u2014 papers with 'weak' or 'unknown' quality_tier are vulnerable to bounties if the source_quality_note doesn't adequately justify their use.

Return ONLY valid JSON, no markdown fences, no preamble:
{
  "revision_number": ${revisionNumber},
  "score_interpretation": "<one sentence: what this score means for this paper specifically>",
  "section_assessment": {
    "strong": ["<specific element reviewers praised or universally ignored \u2014 DO NOT TOUCH these>"],
    "adequate": ["<element with minor criticism \u2014 strengthen with new citations or tighter argument>"],
    "weak": ["<element with explicit criticism or obvious gap \u2014 REBUILD with new evidence>"]
  },
  "named_criticisms": ["<exact criticism reviewer explicitly stated>"],
  "unnamed_problems": ["<obvious problem reviewers missed that will hurt the next round>"],
  "cross_study_verdict": "strong|adequate|weak",
  "cross_study_note": "<specific note on whether the cross-study connection is genuine or superficial>",
  "citation_accuracy_flags": ["<specific citation where agent_summary may not match what the paper actually says>"],
  "citation_quality_flags": ["<specific citation where quality_tier is weak/unknown and source_quality_note doesn't justify its use>"],
  "revision_instructions": {
    "do_not_touch": ["<section or element \u2014 reviewers liked it or left it alone>"],
    "strengthen": ["<section \u2014 add citations or tighten argument, do not restructure>"],
    "rebuild": ["<section \u2014 needs new evidence from a targeted search, rewrite from scratch>"]
  },
  "search_queries": ["<specific query to find evidence addressing the weakest criticism>", "<query 2>", "<query 3>"]
}`;

  return callAnthropicHaiku(prompt, 'paper_audit');
}

async function getOrGenerateHaikuAudit(paper, reviews, citations, paperId, revisionNumber) {
  const supabase = getSupabase();
  const currentReviewCount = (reviews || []).length;

  const cachedAudit = paper.haiku_audit;
  const auditReviewCount = paper.haiku_audit_review_count || 0;
  const needsRegeneration = !cachedAudit || (currentReviewCount - auditReviewCount >= 3);

  if (!needsRegeneration && cachedAudit) {
    log.info('[haiku_audit] Serving cached audit', { paperId, currentReviewCount, generatedAt: auditReviewCount });
    return cachedAudit;
  }

  log.info('[haiku_audit] Generating audit', { paperId, revisionNumber, currentReviewCount });

  const audit = await generateHaikuAudit(paper, reviews, citations, revisionNumber);

  if (audit) {
    supabase
      .from('papers')
      .update({
        haiku_audit: audit,
        haiku_audit_review_count: currentReviewCount,
      })
      .eq('id', paperId)
      .then(() => log.info('[haiku_audit] Cached audit', { paperId }))
      .catch(err => log.error('[haiku_audit] Cache write failed', { paperId, err: err?.message }));
  } else if (cachedAudit) {
    log.warn('[haiku_audit] Generation failed — serving stale cache', { paperId });
    return cachedAudit;
  }

  return audit;
}

module.exports = {
  callAnthropicHaiku,
  generateHaikuAudit,
  getOrGenerateHaikuAudit,
  getServerLLMUsage,
};
