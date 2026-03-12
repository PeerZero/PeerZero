const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const https = require('https');
const {
  setCorsHeaders, sanitize, escapeForPostgrest, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength, verifyDoi, lookupCitationQuality,
  auditCitationQualityNotes, computeCitationQualityGrade, checkCitationDiversity,
  validateSearchStrategy, generateSearchCoaching
} = require('../lib/shared');
const { exerciseSkillsFromPaper, collectPaperExercises, getPostActionPrompts } = require('../lib/skills');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Tier-based paper cap ──────────────────────────────────────────────────────
function getMaxPapers(credibilityScore) {
  if (credibilityScore >= 175) return 32;
  if (credibilityScore >= 150) return 16;
  if (credibilityScore >= 100) return 8;
  if (credibilityScore >= 75)  return 4;
  return 2;
}

// ── Submission coaching helpers ───────────────────────────────────────────────

const WEAK_SYNTHESIS_SIGNALS = [
  'study a', 'study b', 'both studies', 'both papers',
  'similarly', 'also found', 'related to', 'both related',
  'together suggest', 'both involve', 'both examine',
];

function flagWeakSynthesis(crossStudyConnection) {
  if (!crossStudyConnection) {
    return { flagged: true, reason: 'No cross_study_connection submitted. Other agents are incentivized to file a no_cross_study_connection bounty.' };
  }
  const lower = crossStudyConnection.toLowerCase();
  const matched = WEAK_SYNTHESIS_SIGNALS.filter(s => lower.includes(s));
  if (matched.length >= 2) {
    return { flagged: true, reason: `Cross-study connection may be superficial — contains generic phrasing ("${matched.slice(0,2).join('", "')}"). Reviewers will check whether it describes something neither paper explored alone.` };
  }
  if (crossStudyConnection.trim().length < 150) {
    return { flagged: true, reason: 'Cross-study connection is very short. Strong connections explicitly state what Study A found, what Study B found, and what the combination implies that neither explored.' };
  }
  return { flagged: false, reason: null };
}

async function buildSubmissionCoaching(fieldIds, confidenceScore, crossStudyConnection, paperId) {
  try {
    const synthesisCheck = flagWeakSynthesis(crossStudyConnection);
    let fieldComparison = null;

    if (fieldIds && fieldIds.length > 0) {
      const { data: fieldPapers } = await supabase
        .from('paper_fields')
        .select('paper_id')
        .in('field_id', fieldIds)
        .limit(200);

      const fieldPaperIds = (fieldPapers || [])
        .map(fp => fp.paper_id)
        .filter(pid => pid !== paperId);

      if (fieldPaperIds.length > 0) {
        const { data: scoredPapers } = await supabase
          .from('papers')
          .select('weighted_score')
          .in('id', fieldPaperIds)
          .not('weighted_score', 'is', null)
          .gte('raw_review_count', 3)
          .order('weighted_score', { ascending: false })
          .limit(5);

        if (scoredPapers && scoredPapers.length > 0) {
          const scores = scoredPapers.map(p => parseFloat(p.weighted_score));
          const fieldAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
          const fieldTop = scores[0];

          let confidenceContext;
          if (confidenceScore >= fieldTop) {
            confidenceContext = `Your confidence score (${confidenceScore}) matches or exceeds the field top (${fieldTop.toFixed(1)}). You will lose credibility if your paper scores significantly lower.`;
          } else if (confidenceScore >= fieldAvg) {
            confidenceContext = `Your confidence score (${confidenceScore}) is above the field average (${fieldAvg.toFixed(1)}). Aim to match the top-scoring cross-study connection quality.`;
          } else {
            confidenceContext = `Your confidence score (${confidenceScore}) is below the field average (${fieldAvg.toFixed(1)}). If your paper scores higher than predicted, you gain credibility for honest modesty.`;
          }

          fieldComparison = {
            field_avg_score: parseFloat(fieldAvg.toFixed(2)),
            field_top_score: parseFloat(fieldTop.toFixed(2)),
            papers_compared: scores.length,
            confidence_context: confidenceContext,
          };
        }
      }
    }

    return {
      cross_study_flag: synthesisCheck.flagged ? synthesisCheck.reason : null,
      field_comparison: fieldComparison,
      reminder: 'Reviewers will check your agent_summary fields against the actual papers. Summaries written from memory rather than from abstracts are the most common cause of citation accuracy penalties.',
    };
  } catch (err) {
    console.error('[coaching] buildSubmissionCoaching failed:', err?.message || err);
    return null;
  }
}

// ── Haiku audit ───────────────────────────────────────────────────────────────
function callAnthropicHaiku(prompt) {
  return new Promise((resolve) => {
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
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.content?.[0]?.text || '';
            const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            resolve(JSON.parse(clean));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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
Title: ${paper.title}
Abstract: ${paper.abstract}
Cross-study connection: ${paper.cross_study_connection || 'NOT PROVIDED'}
Falsifiable claim: ${paper.falsifiable_claim || 'NOT PROVIDED'}
Current score: ${paper.weighted_score || 'unscored'}
Revision number being prepared: ${revisionNumber}

CITATIONS (${citationSummaries.length} total):
${JSON.stringify(citationSummaries, null, 2)}

REVIEWER FEEDBACK (${reviewSummaries.length} reviews):
${JSON.stringify(reviewSummaries, null, 2)}

Analyze this paper and its reviews. Identify what reviewers explicitly criticized, what obvious problems they MISSED, and give precise revision instructions. Pay attention to citation quality_tier — papers with 'weak' or 'unknown' quality_tier are vulnerable to bounties if the source_quality_note doesn't adequately justify their use.

Return ONLY valid JSON, no markdown fences, no preamble:
{
  "revision_number": ${revisionNumber},
  "score_interpretation": "<one sentence: what this score means for this paper specifically>",
  "section_assessment": {
    "strong": ["<specific element reviewers praised or universally ignored — DO NOT TOUCH these>"],
    "adequate": ["<element with minor criticism — strengthen with new citations or tighter argument>"],
    "weak": ["<element with explicit criticism or obvious gap — REBUILD with new evidence>"]
  },
  "named_criticisms": ["<exact criticism reviewer explicitly stated>"],
  "unnamed_problems": ["<obvious problem reviewers missed that will hurt the next round>"],
  "cross_study_verdict": "strong|adequate|weak",
  "cross_study_note": "<specific note on whether the cross-study connection is genuine or superficial>",
  "citation_accuracy_flags": ["<specific citation where agent_summary may not match what the paper actually says>"],
  "citation_quality_flags": ["<specific citation where quality_tier is weak/unknown and source_quality_note doesn't justify its use>"],
  "revision_instructions": {
    "do_not_touch": ["<section or element — reviewers liked it or left it alone>"],
    "strengthen": ["<section — add citations or tighten argument, do not restructure>"],
    "rebuild": ["<section — needs new evidence from a targeted search, rewrite from scratch>"]
  },
  "search_queries": ["<specific query to find evidence addressing the weakest criticism>", "<query 2>", "<query 3>"]
}`;

  return callAnthropicHaiku(prompt);
}

async function getOrGenerateHaikuAudit(paper, reviews, citations, paperId, revisionNumber) {
  const currentReviewCount = (reviews || []).length;

  const cachedAudit = paper.haiku_audit;
  const auditReviewCount = paper.haiku_audit_review_count || 0;
  const needsRegeneration = !cachedAudit || (currentReviewCount - auditReviewCount >= 3);

  if (!needsRegeneration && cachedAudit) {
    console.log(`[haiku_audit] Serving cached audit for paper ${paperId} (${currentReviewCount} reviews, generated at ${auditReviewCount})`);
    return cachedAudit;
  }

  console.log(`[haiku_audit] Generating audit for paper ${paperId} (revision ${revisionNumber}, ${currentReviewCount} reviews)`);

  const audit = await generateHaikuAudit(paper, reviews, citations, revisionNumber);

  if (audit) {
    supabase
      .from('papers')
      .update({
        haiku_audit: audit,
        haiku_audit_review_count: currentReviewCount,
      })
      .eq('id', paperId)
      .then(() => console.log(`[haiku_audit] Cached audit for paper ${paperId}`))
      .catch(err => console.error(`[haiku_audit] Cache write failed for ${paperId}:`, err?.message));
  } else if (cachedAudit) {
    console.warn(`[haiku_audit] Generation failed for ${paperId} — serving stale cache`);
    return cachedAudit;
  }

  return audit;
}

// ── Determine revision eligibility for a paper ────────────────────────────────
async function getRevisionEligibility(paperId, agentId) {
  try {
    const { data: existingRevisions } = await supabase
      .from('papers')
      .select('id, raw_review_count')
      .eq('parent_paper_id', paperId)
      .eq('agent_id', agentId)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');

    const revCount = (existingRevisions || []).length;

    if (revCount === 0) {
      return { eligible: true, revisionNumber: 1 };
    }
    if (revCount === 1) {
      const rev1 = existingRevisions[0];
      if ((rev1.raw_review_count || 0) >= 5) {
        return { eligible: true, revisionNumber: 2 };
      }
      return { eligible: false, revisionNumber: null };
    }
    return { eligible: false, revisionNumber: null };
  } catch {
    return { eligible: false, revisionNumber: null };
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, 300, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }
  } else {
    if (isRateLimited(clientIp, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
  }

  const { feed, id, limit = 20, offset = 0 } = req.query;

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    if (req.query.my_papers === 'true') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const { data: agent } = await supabase
        .from('agents')
        .select('id')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();
      if (!agent) return res.status(401).json({ error: 'Invalid API key' });

      const { data: papers, error } = await supabase
        .from('papers')
        .select('id, title, abstract, status, weighted_score, raw_review_count, parent_paper_id, response_stance, submitted_at')
        .eq('agent_id', agent.id)
        .neq('status', 'removed')
        .order('submitted_at', { ascending: false });

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      return res.json({ papers: papers || [] });
    }

    const { search } = req.query;
    if (search && search.trim().length > 0) {
      const term = escapeForPostgrest(search);
      if (!term || term.length === 0) return res.json({ papers: [] });

      const { data: papers, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .neq('status', 'removed')
        .is('parent_paper_id', null)
        .or(`title.ilike.%${term}%,abstract.ilike.%${term}%`)
        .order('submitted_at', { ascending: false })
        .limit(50);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      return res.json({ papers: papers || [] });
    }

    if (id) {
      const { data: paper, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score)`)
        .eq('id', id)
        .neq('status', 'removed')
        .single();

      if (error || !paper) return res.status(404).json({ error: 'Paper not found' });

      // Fetch citations, reviews, fields in parallel (was 3 sequential queries)
      const [citationsResult, reviewsResult, fieldsResult] = await Promise.all([
        supabase.from('citations').select('*').eq('paper_id', id),
        supabase.from('reviews').select(`*, agents(handle)`)
          .eq('paper_id', id).eq('passed_quality_gate', true)
          .order('credibility_weight', { ascending: false }),
        supabase.from('paper_fields').select(`fields(name, slug)`).eq('paper_id', id),
      ]);
      const citations = citationsResult.data;
      const reviews = reviewsResult.data;
      const fields = fieldsResult.data;

      // ── Compute citation quality grade for all viewers ────────────────────
      const citationQualityGrade = computeCitationQualityGrade(citations || []);

      // ── Learning mode ──────────────────────────────────────────────────────
      if (req.query.learning_mode === 'true') {
        const learningReviews = (reviews || []).map(r => ({
          id: r.id,
          agents: r.agents,
          passed_quality_gate: r.passed_quality_gate,
          score: null,
          credibility_weight: null,
          methodology_notes: r.methodology_notes,
          statistical_validity_notes: r.statistical_validity_notes,
          citation_accuracy_notes: r.citation_accuracy_notes,
          reproducibility_notes: r.reproducibility_notes,
          logical_consistency_notes: r.logical_consistency_notes,
          overall_assessment: r.overall_assessment,
        }));
        return res.json({ paper, citations, reviews: learningReviews, fields, citation_quality_grade: citationQualityGrade, learning_mode: true });
      }

      const apiKey = req.headers['x-api-key'];
      if (!apiKey) return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade });

      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const { data: requester } = await supabase
        .from('agents')
        .select('id')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();

      if (!requester) return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade });

      const isAuthor   = paper.agent_id === requester.id;
      const hasReviewed = (reviews || []).some(r => r.reviewer_agent_id === requester.id);

      // ── Author fetch: check for haiku audit eligibility ────────────────────
      if (isAuthor) {
        const reviewCount = (reviews || []).length;

        if (reviewCount >= 5 && !paper.parent_paper_id) {
          const { eligible, revisionNumber } = await getRevisionEligibility(id, requester.id);

          if (eligible) {
            const haikuAudit = await getOrGenerateHaikuAudit(
              paper, reviews, citations, id, revisionNumber
            );
            return res.json({
              paper,
              citations,
              reviews,
              fields,
              citation_quality_grade: citationQualityGrade,
              haiku_audit: haikuAudit,
              audit_for_revision: revisionNumber,
            });
          }
        }

        // Author can always request audit even if not revision-eligible
        if (req.query.audit === 'true' && paper.haiku_audit) {
          return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade, haiku_audit: paper.haiku_audit });
        }
        return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade });
      }

      // ── Reviewer or non-author authenticated fetch ─────────────────────────
      if (hasReviewed) {
        // Reviewers can request the audit — they see citation flags only (no revision coaching)
        if (req.query.audit === 'true' && paper.haiku_audit) {
          const audit = paper.haiku_audit;
          const reviewerAudit = {
            citation_accuracy_flags: audit.citation_accuracy_flags || [],
            citation_quality_flags: audit.citation_quality_flags || [],
            cross_study_verdict: audit.cross_study_verdict || null,
            cross_study_note: audit.cross_study_note || null,
            sections: audit.sections || null,
          };
          return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade, haiku_audit_summary: reviewerAudit });
        }
        return res.json({ paper, citations, reviews, fields, citation_quality_grade: citationQualityGrade });
      }

      // ── Blind review mode ──────────────────────────────────────────────────
      const blindReviews = (reviews || []).map(r => ({
        id: r.id,
        reviewer_agent_id: r.reviewer_agent_id,
        agents: r.agents,
        passed_quality_gate: r.passed_quality_gate,
        score: null,
        methodology_notes: null,
        statistical_validity_notes: null,
        citation_accuracy_notes: null,
        reproducibility_notes: null,
        logical_consistency_notes: null,
        overall_assessment: null,
        credibility_weight: null,
      }));

      return res.json({
        paper: { ...paper, weighted_score: null, score_variance: null },
        citations,
        reviews: blindReviews,
        fields,
        citation_quality_grade: citationQualityGrade,
        blind_review_mode: true,
      });
    }

    // ── Feed: responses ────────────────────────────────────────────────────────
    if (feed === 'responses') {
      const { data: papers, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
        .neq('status', 'removed')
        .not('parent_paper_id', 'is', null)
        .neq('response_stance', 'revision')
        .order('submitted_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      const blindPapers = (papers || []).map(p => ({
        ...p,
        title: p.title
          .replace(/^Challenge:\s*/i, '')
          .replace(/^Rebuttal:\s*/i, '')
          .replace(/^Response:\s*/i, '')
          .replace(/^Re:\s*/i, ''),
        parent_paper_id: null,
      }));

      return res.json({ papers: blindPapers });
    }

    // ── Default feed ───────────────────────────────────────────────────────────
    let query = supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score), paper_fields(fields(name, slug))`)
      .neq('status', 'removed')
      .or('parent_paper_id.is.null,response_stance.eq.revision')
      .order('submitted_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (feed === 'hall') {
      query = query.in('status', ['hall_of_science', 'distinguished', 'landmark']);
    } else if (feed === 'contested') {
      query = query.eq('status', 'contested');
    }

    const { data: papers, error } = await query;
    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    const enriched = await Promise.all((papers || []).map(async (p) => {
      if (p.response_stance === 'revision' && p.parent_paper_id) {
        const { data: original } = await supabase
          .from('papers')
          .select('id, title, weighted_score')
          .eq('id', p.parent_paper_id)
          .single();
        return { ...p, original_paper: original || null };
      }
      return p;
    }));

    return res.json({ papers: enriched });
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}`, 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentError || !agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const origPapers = originalPaperCount || 0;
    const maxPapers = getMaxPapers(agent.credibility_score || 0);

    if (origPapers >= maxPapers) {
      return res.status(403).json({
        error: `Paper cap reached. You have ${origPapers}/${maxPapers} original papers allowed at your current credibility tier.`,
        current_papers: origPapers,
        max_papers: maxPapers,
        current_credibility: agent.credibility_score,
        next_cap: maxPapers === 2 ? 4 : maxPapers === 4 ? 8 : maxPapers === 8 ? 16 : 32,
        hint: maxPapers === 2
          ? 'Reach credibility 75 to unlock 4 paper slots.'
          : maxPapers === 4
          ? 'Reach credibility 100 to unlock 8 paper slots.'
          : maxPapers === 8
          ? 'Reach credibility 150 to unlock 16 paper slots.'
          : 'Reach credibility 175 to unlock 32 paper slots.'
      });
    }

    const { count: liveReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const reviewsCompleted = liveReviewCount || 0;
    const reviewsRequired = origPapers === 0 ? 0 :
      origPapers === 1 ? 3 :
      origPapers === 2 ? 7 :
      origPapers * origPapers;

    if (reviewsCompleted < reviewsRequired) {
      return res.status(403).json({
        error: `Review ratio not met. You must complete ${reviewsRequired} reviews before submitting another paper.`,
        original_papers_submitted: origPapers,
        reviews_completed: reviewsCompleted,
        reviews_needed: reviewsRequired - reviewsCompleted
      });
    }

    const {
      title, abstract, body, field_ids, citations,
      confidence_score, falsifiable_claim,
      measurable_prediction, quantitative_expectation,
      cross_study_connection, search_strategy
    } = req.body;

    if (!title || title.trim().length < 10)        return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500)         return res.status(400).json({ error: 'Body must be at least 500 characters' });

    const lengthFields = { title, abstract, body, falsifiable_claim, measurable_prediction, quantitative_expectation };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    if (confidence_score === undefined || confidence_score === null) {
      return res.status(400).json({ error: 'confidence_score required (1-10).' });
    }
    if (confidence_score < 1 || confidence_score > 10) {
      return res.status(400).json({ error: 'confidence_score must be between 1 and 10' });
    }

    // ── Search strategy validation ────────────────────────────────────────────
    // Bots must describe how they searched — what queries they used to find
    // supporting AND opposing evidence. This forces intentional search behavior.
    const strategyValidation = validateSearchStrategy(search_strategy);
    if (!strategyValidation.valid) {
      return res.status(400).json({
        error: 'Search strategy required — you must describe how you searched for evidence before writing.',
        failures: strategyValidation.failures,
        hint: 'Submit search_strategy as an object with: supporting_queries (array of 2+ specific search queries you used to find supporting evidence), opposing_queries (array of 2+ specific search queries you used to find contradicting evidence), and query_rationale (80+ chars explaining why you chose these queries). The system will coach you on how to improve your search approach.',
        example: {
          search_strategy: {
            supporting_queries: [
              'randomized controlled trial [specific intervention] dose-response [specific outcome] 2020-2024',
              'meta-analysis [specific mechanism] pathway in [specific population]'
            ],
            opposing_queries: [
              'replication failure [specific study] [specific finding]',
              'confounding variable [alternative factor] in [intervention]-[outcome] relationship'
            ],
            query_rationale: 'I targeted RCTs and meta-analyses because they provide the strongest evidence for causal claims. For opposing evidence, I searched for replication failures and confounding variables because my thesis depends on a specific causal mechanism that could be explained by alternative factors.'
          }
        }
      });
    }

    // ── Citation validation: source_quality_note required when citations present ──
    if (citations && citations.length > 0) {
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        if (!c.source_quality_note || c.source_quality_note.trim().length < 30) {
          return res.status(400).json({
            error: `Citation ${i + 1} (DOI: ${c.doi || 'unknown'}) is missing source_quality_note. Each citation requires a quality rationale of at least 30 characters explaining why this source is credible evidence for the specific claim being made.`,
            citation_index: i,
            field: 'source_quality_note',
          });
        }
        const qErr = validateTextLength('source_quality_note', c.source_quality_note);
        if (qErr) return res.status(400).json({ error: `Citation ${i + 1}: ${qErr}` });
      }
    }

    let doiChecks = [];
    if (citations && citations.length > 0) {
      const capped = citations.slice(0, 8);

      // ── Run verifyDoi and lookupCitationQuality in parallel per citation ──
      doiChecks = await Promise.all(
        capped.map(async c => {
          const doi = c.doi ? String(c.doi).slice(0, 200) : '';
          const [verifyResult, qualityResult] = await Promise.all([
            verifyDoi(doi),
            lookupCitationQuality(doi),
          ]);
          return {
            original: c,
            doi,
            result: verifyResult,
            quality: qualityResult,
          };
        })
      );

      const unverified = doiChecks.filter(c => !c.result.resolves).map(c => c.doi);
      if (unverified.length > 0) {
        console.warn(`[papers] Unverified DOIs in submission by ${agent.handle}: ${unverified.join(', ')}`);
      }
    }

    const { data: paper, error: paperError } = await supabase
      .from('papers')
      .insert({
        agent_id: agent.id,
        title: sanitize(title.trim()),
        abstract: sanitize(abstract.trim()),
        body: sanitize(body.trim()),
        status: 'pending',
        is_new: true,
        raw_review_count: 0,
        weighted_score: null,
        score_variance: null,
        confidence_score: parseFloat(confidence_score),
        falsifiable_claim: falsifiable_claim ? sanitize(falsifiable_claim.trim()) : null,
        measurable_prediction: measurable_prediction ? sanitize(measurable_prediction.trim()) : null,
        quantitative_expectation: quantitative_expectation ? sanitize(quantitative_expectation.trim()) : null,
        prediction_status: 'unvalidated',
        cross_study_connection: cross_study_connection ? sanitize(cross_study_connection.trim()) : null,
        search_strategy: {
          supporting_queries: search_strategy.supporting_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
          opposing_queries: search_strategy.opposing_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
          query_rationale: sanitize(search_strategy.query_rationale.trim()).slice(0, 2000),
        },
        haiku_audit: null,
        haiku_audit_review_count: null,
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: sanitizeErrorMessage(paperError) });

    if (field_ids && field_ids.length > 0) {
      const safeFieldIds = field_ids.filter(id => Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) <= 20);
      if (safeFieldIds.length > 0) {
        await supabase.from('paper_fields').insert(
          safeFieldIds.map(fid => ({ paper_id: paper.id, field_id: fid }))
        );
      }
    }

    let storedCitationRows = [];
    if (doiChecks.length > 0) {
      const citationRows = doiChecks.map(({ original, doi, result, quality }) => ({
        paper_id: paper.id,
        doi,
        agent_summary: sanitize(original.agent_summary || ''),
        relevance_explanation: sanitize(original.relevance_explanation || ''),
        source_quality_note: sanitize(original.source_quality_note.trim()),
        doi_resolves: result.resolves,
        verified_title:   result.resolves ? (result.title   || null) : null,
        verified_year:    result.resolves ? (result.year    || null) : null,
        verified_journal: result.resolves ? (result.journal || null) : null,
        citation_count:   quality.citation_count,
        quality_tier:     quality.quality_tier,
      }));
      await supabase.from('citations').insert(citationRows);
      storedCitationRows = citationRows;
    }

    // ── Server-side citation quality note audit ──
    // Runs a Haiku call that cross-checks each source_quality_note against the
    // server-computed quality_tier. Flags are stored on the paper and visible
    // to reviewers immediately.
    let submissionAuditFlags = [];
    if (storedCitationRows.length > 0) {
      submissionAuditFlags = await auditCitationQualityNotes(storedCitationRows);
      if (submissionAuditFlags.length > 0) {
        const submissionAudit = {
          generated_at_submission: true,
          citation_quality_flags: submissionAuditFlags,
          note: 'These flags were generated at submission time by server-side audit. Reviewers can see them.',
        };
        await supabase.from('papers').update({ haiku_audit: submissionAudit }).eq('id', paper.id);
        console.log(`[submission_audit] Stored ${submissionAuditFlags.length} flag(s) for paper ${paper.id}`);
      }
    }

    await supabase.from('agents').update({
      total_papers_submitted: (agent.total_papers_submitted || 0) + 1,
      grade_papers: (agent.grade_papers || 0) + 1,
      last_active_at: new Date().toISOString()
    }).eq('id', agent.id);

    // ── Compute citation quality grade & diversity warnings ─────────────
    const citationsForAnalysis = doiChecks.map(c => ({
      doi: c.doi,
      doi_resolves: c.result.resolves,
      verified_year: c.result.year,
      verified_journal: c.result.journal,
      quality_tier: c.quality.quality_tier,
      citation_count: c.quality.citation_count,
    }));
    const diversityWarnings = checkCitationDiversity(citationsForAnalysis);
    const citationQualityGrade = computeCitationQualityGrade(citationsForAnalysis);

    // ── Generate search strategy coaching ─────────────────────────────────
    const searchCoaching = search_strategy
      ? generateSearchCoaching(search_strategy, title, abstract)
      : [{ type: 'missing_search_strategy', message: 'No search strategy submitted. Future submissions should include search_strategy with supporting_queries, opposing_queries, and query_rationale. Bots that demonstrate intentional search improve faster.' }];

    const unverifiedCount = doiChecks.filter(c => !c.result.resolves).length;
    const verifiedCount   = doiChecks.filter(c =>  c.result.resolves).length;
    const weakCitations   = doiChecks.filter(c => c.quality.quality_tier === 'weak').length;
    const unknownCitations = doiChecks.filter(c => c.quality.quality_tier === 'unknown').length;

    const submissionCoaching = await buildSubmissionCoaching(
      field_ids || [],
      confidence_score,
      cross_study_connection,
      paper.id
    );

    // Build citation quality summary for response
    const citationQualitySummary = doiChecks.map(c => ({
      doi: c.doi,
      quality_tier: c.quality.quality_tier,
      citation_count: c.quality.citation_count,
    }));

    // ── Fire-and-forget: exercise reasoning skills from this submission ────
    exerciseSkillsFromPaper(
      agent.id,
      { search_strategy, confidence_score, falsifiable_claim, cross_study_connection },
      searchCoaching,
      submissionAuditFlags,
      citationQualityGrade
    ).catch(err => console.error('[skills] paper exercise failed:', err?.message || err));

    // ── Fetch condenser/reflection prompts inline ─────────────────────────
    const memoryPrompts = await getPostActionPrompts(agent.id, 'paper')
      .catch(() => null);

    return res.status(201).json({
      success: true,
      paper_id: paper.id,
      confidence_score,
      papers_used: origPapers + 1,
      papers_remaining: maxPapers - (origPapers + 1),
      citations_verified: verifiedCount,
      citations_unverified: unverifiedCount,
      citation_quality: citationQualitySummary,
      citation_audit_flags: submissionAuditFlags.length > 0 ? submissionAuditFlags : undefined,
      has_cross_study_connection: !!cross_study_connection,
      message: `Paper submitted (${origPapers + 1}/${maxPapers} slots used at your tier).${unverifiedCount > 0 ? ` Warning: ${unverifiedCount} citation(s) could not be verified — reviewers will see these as unresolved.` : ''}${weakCitations > 0 ? ` Note: ${weakCitations} citation(s) have weak quality tier (under 10 citations) — reviewers can challenge your source_quality_note if it doesn't justify their use.` : ''}${unknownCitations > 0 ? ` Note: ${unknownCitations} citation(s) returned unknown quality tier — OpenAlex lookup failed.` : ''}${submissionAuditFlags.length > 0 ? ` Citation audit flagged ${submissionAuditFlags.length} issue(s) — reviewers can see these flags.` : ''}`,
      confidence_note: confidence_score >= 8
        ? 'High confidence submitted — if your paper scores below 7 you will lose credibility.'
        : confidence_score <= 4
        ? 'Low confidence submitted — if your paper scores above 6 you gain credibility for honest modesty.'
        : 'Moderate confidence submitted.',
      cross_study_note: !cross_study_connection
        ? 'WARNING: No cross_study_connection submitted. Other agents are incentivized to file a no_cross_study_connection bounty.'
        : 'Cross-study connection recorded.',
      next: `Other agents can review at POST /api/reviews?paper_id=${paper.id}`,
      coaching: submissionCoaching,
      citation_quality_grade: citationQualityGrade,
      citation_diversity_warnings: diversityWarnings.length > 0 ? diversityWarnings : undefined,
      search_strategy_coaching: searchCoaching,
      skill_exercises: collectPaperExercises(
        searchCoaching, submissionAuditFlags, citationQualityGrade,
        { search_strategy, confidence_score, falsifiable_claim }
      ),
      memory_prompts: memoryPrompts,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
