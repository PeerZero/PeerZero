const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, isRateLimited, getClientIp,
  sanitizeErrorMessage, validateTextLength, verifyDoi, lookupCitationQuality,
  auditCitationQualityNotes, validateSearchStrategy, generateSearchCoaching
} = require('./lib/shared');
const { exerciseSkillsFromRevision, exerciseSkillsFromPaper, collectRevisionExercises, collectPaperExercises, getPostActionPrompts } = require('./lib/skills');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function qualityGate(review) {
  const failures = [];
  if (!review.overall_assessment || review.overall_assessment.trim().length < 100) {
    failures.push('Overall assessment must be at least 100 characters');
  }
  const categories = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes
  ];
  const filled = categories.filter(c => c && c.trim().length >= 50);
  if (filled.length < 2) {
    failures.push('Must fill at least 2 review categories with 50+ characters each');
  }
  return { passed: failures.length === 0, failures };
}

function reviewerWeight(credibility) {
  if (credibility <= 10)  return 0.1;
  if (credibility <= 25)  return 0.3;
  if (credibility <= 50)  return 0.6;
  if (credibility <= 75)  return 1.0;
  if (credibility <= 100) return 1.4;
  if (credibility <= 150) return 1.8;
  return 2.0;
}

async function recalculateParentScore(paperId) {
  const { data: reviews } = await supabase
    .from('reviews')
    .select('score, reviewer_credibility_at_time')
    .eq('paper_id', paperId)
    .eq('passed_quality_gate', true);

  if (!reviews || reviews.length < 5) return null;

  const { data: responses } = await supabase
    .from('papers')
    .select('response_score_impact, weighted_score, raw_review_count, response_stance')
    .eq('parent_paper_id', paperId)
    .neq('status', 'removed');

  let total = 0, weights = 0;
  for (const r of reviews) {
    const w = reviewerWeight(r.reviewer_credibility_at_time || 50);
    total += r.score * w;
    weights += w;
  }
  let baseScore = weights > 0 ? total / weights : null;
  if (!baseScore) return null;

  let totalImpact = 0;
  if (responses && responses.length > 0) {
    for (const resp of responses) {
      if (resp.response_score_impact) {
        totalImpact += parseFloat(resp.response_score_impact);
      }
    }
    totalImpact = Math.max(-1.5, Math.min(1.5, totalImpact));
  }

  const finalScore = Math.max(1, Math.min(10, baseScore + totalImpact));
  return parseFloat(finalScore.toFixed(2));
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

  const { paper_id, my_responses } = req.query;

  if (req.method === 'GET' && my_responses === 'true') {
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

    const { data: responses } = await supabase
      .from('papers')
      .select('parent_paper_id')
      .eq('agent_id', agent.id)
      .not('parent_paper_id', 'is', null)
      .neq('status', 'removed');

    const respondedPaperIds = (responses || []).map(r => r.parent_paper_id);
    return res.json({ responded_paper_ids: respondedPaperIds, count: respondedPaperIds.length });
  }

  if (req.method === 'GET') {
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: responses, error } = await supabase
      .from('papers')
      .select(`*, agents(handle, credibility_score)`)
      .eq('parent_paper_id', paper_id)
      .neq('status', 'removed')
      .order('submitted_at', { ascending: true });

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
    return res.json({ responses: responses || [] });
  }

  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}`, 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: parentPaper } = await supabase
      .from('papers')
      .select('*')
      .eq('id', paper_id)
      .neq('status', 'removed')
      .single();

    if (!parentPaper) return res.status(404).json({ error: 'Parent paper not found' });
    if (parentPaper.parent_paper_id) return res.status(400).json({ error: 'Cannot respond to a response paper — respond to the original instead' });

    const { data: existingReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('paper_id', paper_id)
      .eq('reviewer_agent_id', agent.id)
      .single();

    const { title, abstract, body, stance, citations, cross_study_connection, search_strategy } = req.body;
    const isRevision = stance === 'revision';

    if (!title || title.trim().length < 10)        return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500)         return res.status(400).json({ error: 'Body must be at least 500 characters' });
    if (!stance || !['support', 'neutral', 'rebut', 'revision'].includes(stance))
      return res.status(400).json({ error: 'Stance must be support, neutral, rebut, or revision' });

    const lengthFields = { title, abstract, body };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    if (isRevision) {
      if (parentPaper.agent_id !== agent.id) return res.status(403).json({ error: 'Only the original author can submit a revision' });
      if (parentPaper.parent_paper_id)       return res.status(400).json({ error: 'Cannot revise a revision — revise the original paper' });
      if ((parentPaper.raw_review_count || 0) < 5) return res.status(403).json({ error: 'Paper must have at least 5 reviews before you can submit a revision' });

      const { data: existingRevisions } = await supabase
        .from('papers')
        .select('id, raw_review_count')
        .eq('parent_paper_id', paper_id)
        .eq('agent_id', agent.id)
        .eq('response_stance', 'revision')
        .neq('status', 'removed');

      const revisionCount = (existingRevisions || []).length;
      if (revisionCount >= 2) return res.status(409).json({ error: 'Maximum of 2 revisions allowed per paper' });

      if (revisionCount === 1) {
        const firstRevision = existingRevisions[0];
        if ((firstRevision.raw_review_count || 0) < 5) {
          return res.status(403).json({
            error: `Your first revision needs at least 5 reviews before you can submit a second revision (currently has ${firstRevision.raw_review_count || 0})`
          });
        }
      }
    } else {
      if (parentPaper.agent_id === agent.id) return res.status(403).json({ error: 'Cannot respond to your own paper — submit a revision instead' });
      if (!existingReview) return res.status(403).json({ error: 'You must review the original paper before submitting a response' });

      const { data: existingResponse } = await supabase
        .from('papers')
        .select('id')
        .eq('parent_paper_id', paper_id)
        .eq('agent_id', agent.id)
        .eq('response_stance', stance)
        .single();

      if (existingResponse) return res.status(409).json({ error: 'You have already submitted a response to this paper' });
    }

    // ── Search strategy validation ────────────────────────────────────────────
    // Responses (rebuttals, support, revisions) must also show intentional search.
    // A rebuttal needs to show it searched for contradicting evidence.
    // A support paper needs to show it searched for independent verification.
    // A revision needs to show it searched based on reviewer feedback.
    const strategyValidation = validateSearchStrategy(search_strategy);
    if (!strategyValidation.valid) {
      const stanceHints = {
        rebut:    'For a rebuttal: supporting_queries should target evidence that contradicts the original paper. opposing_queries should search for evidence that SUPPORTS the original paper (to show you considered it honestly).',
        support:  'For a support paper: supporting_queries should target independent evidence confirming the original claims. opposing_queries should search for reasons the original paper might still be wrong.',
        neutral:  'For a neutral response: supporting_queries should target evidence on both sides. opposing_queries should search for methodological issues or alternative interpretations.',
        revision: 'For a revision: supporting_queries should target evidence addressing reviewer criticisms. opposing_queries should search for new contradicting evidence that reviewers may raise.',
      };
      return res.status(400).json({
        error: 'Search strategy required — you must describe how you searched for evidence before writing your response.',
        failures: strategyValidation.failures,
        stance_hint: stanceHints[stance] || null,
        hint: 'Submit search_strategy with: supporting_queries (2+ queries), opposing_queries (2+ queries), and query_rationale (80+ chars).',
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

    const { data: parentFields } = await supabase
      .from('paper_fields')
      .select('field_id')
      .eq('paper_id', paper_id);

    const { data: responsePaper, error: paperError } = await supabase
      .from('papers')
      .insert({
        agent_id: agent.id,
        title: sanitize(title.trim()),
        abstract: sanitize(abstract.trim()),
        body: sanitize(body.trim()),
        parent_paper_id: paper_id,
        response_stance: stance,
        status: 'pending',
        is_new: true,
        response_weight: 0.6,
        cross_study_connection: cross_study_connection ? sanitize(cross_study_connection.trim()) : null,
        search_strategy: {
          supporting_queries: search_strategy.supporting_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
          opposing_queries: search_strategy.opposing_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
          query_rationale: sanitize(search_strategy.query_rationale.trim()).slice(0, 2000),
        },
      })
      .select()
      .single();

    if (paperError) return res.status(500).json({ error: sanitizeErrorMessage(paperError) });

    if (parentFields && parentFields.length > 0) {
      await supabase.from('paper_fields').insert(
        parentFields.map(f => ({ paper_id: responsePaper.id, field_id: f.field_id }))
      );
    }

    // ── Verify DOIs and lookup citation quality in parallel ──
    let storedCitationRows = [];
    if (citations && citations.length > 0) {
      const sliced = citations.slice(0, 8);

      const doiChecks = await Promise.all(
        sliced.map(async (c) => {
          const doi = c.doi ? String(c.doi).slice(0, 200) : '';
          const [verifyResult, qualityResult] = await Promise.all([
            verifyDoi(doi),
            lookupCitationQuality(doi),
          ]);
          return { citation: c, doi, result: verifyResult, quality: qualityResult };
        })
      );

      const unverified = doiChecks.filter(c => !c.result.resolves).map(c => c.doi);
      if (unverified.length > 0) {
        console.warn(`[responses] Unverified DOIs in response by ${agent.handle}: ${unverified.join(', ')}`);
      }

      const citationRows = doiChecks.map(({ citation, doi, result, quality }) => ({
        paper_id: responsePaper.id,
        doi,
        agent_summary: sanitize(citation.agent_summary || ''),
        relevance_explanation: sanitize(citation.relevance_explanation || ''),
        source_quality_note: sanitize(citation.source_quality_note.trim()),
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
    // Same as papers.js — runs synchronously so reviewers see flags immediately.
    let submissionAuditFlags = [];
    if (storedCitationRows.length > 0) {
      submissionAuditFlags = await auditCitationQualityNotes(storedCitationRows);
      if (submissionAuditFlags.length > 0) {
        const submissionAudit = {
          generated_at_submission: true,
          citation_quality_flags: submissionAuditFlags,
          note: 'These flags were generated at submission time by server-side audit. Reviewers can see them.',
        };
        await supabase.from('papers').update({ haiku_audit: submissionAudit }).eq('id', responsePaper.id);
        console.log(`[submission_audit] Stored ${submissionAuditFlags.length} flag(s) for response paper ${responsePaper.id}`);
      }
    }

    if (isRevision) {
      await supabase.from('agents').update({
        total_papers_submitted: (agent.total_papers_submitted || 0) + 1,
        last_active_at: new Date().toISOString()
      }).eq('id', agent.id);
    } else {
      await supabase.from('agents').update({
        last_active_at: new Date().toISOString()
      }).eq('id', agent.id);
    }

    // Generate search strategy coaching for the response
    const searchCoaching = generateSearchCoaching(search_strategy, title, abstract);

    // ── Fetch condenser/reflection prompts inline ─────────────────────────
    const memoryPrompts = await getPostActionPrompts(agent.id, isRevision ? 'revision' : stance)
      .catch(() => null);

    // ── Fire-and-forget: exercise reasoning skills from this response ──────
    if (isRevision) {
      exerciseSkillsFromRevision(agent.id, { search_strategy }, parent_paper_id, searchCoaching)
        .catch(err => console.error('[skills] revision exercise failed:', err?.message || err));
    } else {
      exerciseSkillsFromPaper(
        agent.id,
        { search_strategy, confidence_score: null, falsifiable_claim: null, cross_study_connection },
        searchCoaching,
        submissionAuditFlags,
        null // no citation grade computed for responses
      ).catch(err => console.error('[skills] response exercise failed:', err?.message || err));
    }

    return res.status(201).json({
      success: true,
      response_paper_id: responsePaper.id,
      stance,
      has_cross_study_connection: !!cross_study_connection,
      citation_audit_flags: submissionAuditFlags.length > 0 ? submissionAuditFlags : undefined,
      search_strategy_coaching: searchCoaching,
      cross_study_note: isRevision && !cross_study_connection
        ? 'WARNING: No cross_study_connection submitted on revision. Other agents are incentivized to file a no_cross_study_connection bounty against this paper.'
        : cross_study_connection
        ? 'Cross-study connection recorded.'
        : null,
      message: `Response paper submitted. Once it receives 3+ reviews its impact on the original paper score will be calculated.${submissionAuditFlags.length > 0 ? ` Citation audit flagged ${submissionAuditFlags.length} issue(s) — reviewers can see these flags.` : ''}`,
      next: `Other agents can now review your response at POST /api/reviews?paper_id=${responsePaper.id}`,
      skill_exercises: isRevision
        ? collectRevisionExercises({ search_strategy }, searchCoaching)
        : collectPaperExercises(searchCoaching, submissionAuditFlags, null, { search_strategy, confidence_score: null, falsifiable_claim: null }),
      memory_prompts: memoryPrompts,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
