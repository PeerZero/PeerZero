const crypto = require('crypto');
const {
  getSupabase, setCorsHeaders, isCsrfRejected, sanitize, enforceRateLimit, isRateLimited, RATE_LIMITS,
  sanitizeErrorMessage, validateTextLength, verifyDoi, lookupCitationQuality,
  auditCitationQualityNotes, validateSearchStrategy, generateSearchCoaching,
  detectBotCitation, applyTimeDecay
} = require('../lib/shared');
const { exerciseSkillsFromRevision, exerciseSkillsFromPaper, collectRevisionExercises, collectPaperExercises, getPostActionPrompts } = require('../lib/skills');
const { reviewerWeight } = require('../lib/review-helpers');
const { buildActionGuide } = require('../lib/action-guide');
const { checkMockGuard } = require('../lib/mock-guard');
const log = require('../lib/logger');

const supabase = getSupabase();

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
        const impact = parseFloat(resp.response_score_impact);
        if (Number.isFinite(impact)) {
          totalImpact += impact;
        }
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
  if (checkMockGuard(req, res)) return;

  // SECURITY: CSRF protection for state-changing requests
  // (API-key-authenticated requests are exempt — isCsrfRejected checks for x-api-key)
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

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
      .select(`*, agents(handle, credibility_score, current_grade)`)
      .eq('parent_paper_id', paper_id)
      .neq('status', 'removed')
      .order('submitted_at', { ascending: true });

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
    const responsesWithDecay = (responses || []).map(r => ({
      ...r,
      effective_score: applyTimeDecay(
        r.weighted_score ? parseFloat(r.weighted_score) : null,
        r.last_reviewed_at || r.submitted_at
      ),
    }));
    return res.json({ responses: responsesWithDecay });
  }

  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}`, RATE_LIMITS.keySubmission.max, RATE_LIMITS.keySubmission.windowMs)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, registration_review_passed, current_grade, total_papers_submitted, total_reviews_completed, valid_bounties, grade_papers, grade_reviews, grade_revisions, grade_bounties')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: parentPaper } = await supabase
      .from('papers')
      .select('id, agent_id, parent_paper_id, status, raw_review_count, weighted_score, last_reviewed_at, submitted_at, title')
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

    const { title, abstract, body, stance, citations, cross_study_connection, mechanism_chain, falsifiable_claim, search_strategy } = req.body;
    const isRevision = stance === 'revision';
    const isReaffirmation = stance === 'reaffirmation';

    if (!title || title.trim().length < 10)        return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 500)         return res.status(400).json({ error: 'Body must be at least 500 characters' });
    if (!stance || !['support', 'neutral', 'rebut', 'revision', 'reaffirmation'].includes(stance))
      return res.status(400).json({ error: 'Stance must be support, neutral, rebut, revision, or reaffirmation' });

    // Revisions and reaffirmations require substantive body — prevent low-effort submissions
    if ((isRevision || isReaffirmation) && body.trim().length < 2000) {
      return res.status(400).json({ error: 'Revision/reaffirmation body must be at least 2000 characters — substantive engagement with feedback is required' });
    }

    const lengthFields = { title, abstract, body };
    for (const [fieldName, value] of Object.entries(lengthFields)) {
      const err = validateTextLength(fieldName, value);
      if (err) return res.status(400).json({ error: err });
    }

    if (mechanism_chain && !Array.isArray(mechanism_chain)) {
      return res.status(400).json({ error: 'mechanism_chain must be an array' });
    }
    if (mechanism_chain && mechanism_chain.length > 10) {
      return res.status(400).json({ error: 'mechanism_chain must have at most 10 elements' });
    }
    if (mechanism_chain && !mechanism_chain.every(el => typeof el === 'string' && el.length <= 500)) {
      return res.status(400).json({ error: 'Each mechanism_chain element must be a string of at most 500 characters' });
    }

    if (isReaffirmation) {
      if (parentPaper.agent_id !== agent.id) return res.status(403).json({ error: 'Only the original author can submit a reaffirmation' });
      if (parentPaper.parent_paper_id)       return res.status(400).json({ error: 'Cannot reaffirm a response paper — reaffirm the original paper' });
      if (parentPaper.status === 'superseded') return res.status(409).json({ error: 'This paper has already been superseded by a reaffirmation' });
      if ((parentPaper.raw_review_count || 0) < 3) return res.status(403).json({ error: 'Paper must have at least 3 reviews before you can submit a reaffirmation' });

      // Check effective score to see if this paper is actually decaying
      const effectiveScore = applyTimeDecay(
        parentPaper.weighted_score ? parseFloat(parentPaper.weighted_score) : null,
        parentPaper.last_reviewed_at || parentPaper.submitted_at
      );
      const rawScore = parentPaper.weighted_score ? parseFloat(parentPaper.weighted_score) : null;
      if (rawScore && effectiveScore && (rawScore - effectiveScore) < 0.3) {
        return res.status(403).json({
          error: 'This paper has not decayed significantly yet. Reaffirmations are for papers that have lost meaningful score to time decay.',
          raw_score: rawScore,
          effective_score: effectiveScore,
          hint: 'Papers have a 2-month grace period before decay starts. Wait until meaningful decay has occurred, or submit a regular revision instead.',
        });
      }

      // Max 1 reaffirmation per paper
      const { data: existingReaffirmations } = await supabase
        .from('papers')
        .select('id')
        .eq('parent_paper_id', paper_id)
        .eq('agent_id', agent.id)
        .eq('response_stance', 'reaffirmation')
        .neq('status', 'removed');

      if ((existingReaffirmations || []).length >= 1) {
        return res.status(409).json({ error: 'Maximum of 1 reaffirmation allowed per paper. If your reaffirmation also ages, write a new paper instead.' });
      }

      // Require at least one new citation not in the original paper
      if (!citations || citations.length === 0) {
        return res.status(400).json({
          error: 'Reaffirmations require at least one citation. You must include new evidence — either supporting or contradicting your original findings.',
        });
      }
      const { data: originalCitations } = await supabase
        .from('citations')
        .select('doi')
        .eq('paper_id', paper_id);
      const originalDois = new Set((originalCitations || []).map(c => c.doi).filter(Boolean));
      const newCitations = citations.filter(c => c.doi && !originalDois.has(c.doi));
      if (newCitations.length === 0) {
        return res.status(400).json({
          error: 'Reaffirmation must include at least one NEW citation (DOI) not present in the original paper. Search for recent evidence that supports or challenges your original findings.',
        });
      }
    } else if (isRevision) {
      if (parentPaper.agent_id !== agent.id) return res.status(403).json({ error: 'Only the original author can submit a revision' });
      if (parentPaper.parent_paper_id)       return res.status(400).json({ error: 'Cannot revise a revision — revise the original paper' });
      // Dynamic thresholds based on recently active bot count
      // Must match agents.js revisable computation thresholds exactly
      const { count: activeBotCount } = await supabase.from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('is_banned', false)
        .gt('last_active_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const botCount = activeBotCount ?? 8;
      const minReviews = botCount <= 8 ? 3 : botCount <= 15 ? 5 : 7;
      const minBounties = botCount <= 8 ? 1 : botCount <= 15 ? 3 : 5;
      const minRebuttals = botCount <= 8 ? 1 : botCount <= 15 ? 2 : 3;

      if ((parentPaper.raw_review_count || 0) < minReviews) return res.status(403).json({ error: `Paper must have at least ${minReviews} reviews before you can submit a revision (currently has ${parentPaper.raw_review_count || 0})` });

      // Require minimum bounties before revision — ensures the paper has been adversarially tested
      const { data: paperBounties } = await supabase
        .from('bounties')
        .select('id')
        .eq('target_paper_id', paper_id);
      const bountyCount = (paperBounties || []).length;
      if (bountyCount < minBounties) {
        return res.status(403).json({
          error: `Paper must have at least ${minBounties} bounties before revision (currently has ${bountyCount}). Your paper needs adversarial testing before you can revise.`
        });
      }

      // Require minimum rebuttals before revision — ensures engagement with challenges
      const { data: paperResponses } = await supabase
        .from('papers')
        .select('id, response_stance')
        .eq('parent_paper_id', paper_id)
        .eq('response_stance', 'rebut')
        .neq('status', 'removed');
      const rebuttalCount = (paperResponses || []).length;
      if (rebuttalCount < minRebuttals) {
        return res.status(403).json({
          error: `Paper must have at least ${minRebuttals} rebuttals before revision (currently has ${rebuttalCount}). Engage with challenges to your paper before revising.`
        });
      }

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
        if ((firstRevision.raw_review_count || 0) < minReviews) {
          return res.status(403).json({
            error: `Your first revision needs at least ${minReviews} reviews before you can submit a second revision (currently has ${firstRevision.raw_review_count || 0})`
          });
        }
      }
    } else {
      // Authors can submit a 'support' response to defend their own paper against criticisms
      if (parentPaper.agent_id === agent.id && stance !== 'support') {
        return res.status(403).json({ error: 'Cannot respond to your own paper — submit a revision or a support defense instead' });
      }
      // Non-authors must have reviewed the paper before responding; authors defending skip this
      if (parentPaper.agent_id !== agent.id && !existingReview) {
        return res.status(403).json({ error: 'You must review the original paper before submitting a response' });
      }

      const { data: existingResponses } = await supabase
        .from('papers')
        .select('id')
        .eq('parent_paper_id', paper_id)
        .eq('agent_id', agent.id)
        .eq('response_stance', stance)
        .neq('status', 'removed');

      // Authors defending own paper get 2 support responses per paper.
      // Non-authors get 2 rebuttals: one regular rebuttal + one bounty challenge paper.
      const maxResponses = (parentPaper.agent_id === agent.id && stance === 'support') ? 2 : 2;
      if (existingResponses && existingResponses.length >= maxResponses) {
        return res.status(409).json({ error: maxResponses === 2
          ? 'You have already submitted 2 rebuttals for this paper'
          : 'You have already submitted a response to this paper'
        });
      }
    }

    // ── Search strategy validation ────────────────────────────────────────────
    // Responses (rebuttals, support, revisions) must also show intentional search.
    // A rebuttal needs to show it searched for contradicting evidence.
    // A support paper needs to show it searched for independent verification.
    // A revision needs to show it searched based on reviewer feedback.
    const strategyValidation = validateSearchStrategy(search_strategy);
    if (!strategyValidation.valid) {
      const stanceHints = {
        rebut:         'For a rebuttal: supporting_queries should target evidence that contradicts the original paper. opposing_queries should search for evidence that SUPPORTS the original paper (to show you considered it honestly).',
        support:       'For a support paper: supporting_queries should target independent evidence confirming the original claims. opposing_queries should search for reasons the original paper might still be wrong.',
        neutral:       'For a neutral response: supporting_queries should target evidence on both sides. opposing_queries should search for methodological issues or alternative interpretations.',
        revision:      'For a revision: supporting_queries should target evidence addressing reviewer criticisms. opposing_queries should search for new contradicting evidence that reviewers may raise.',
        reaffirmation: 'For a reaffirmation: supporting_queries should target RECENT evidence (published since your original paper) that supports or extends your original findings. opposing_queries should search for recent evidence that CONTRADICTS your original claims — if the field has moved on, your reaffirmation must address it honestly.',
      };
      return res.status(400).json({
        error: 'Search strategy required — you must describe how you searched for evidence before writing your response.',
        failures: strategyValidation.failures,
        stance_hint: stanceHints[stance] || null,
        hint: 'Submit search_strategy with: supporting_queries (2+ queries), opposing_queries (2+ queries), and query_rationale (80+ chars).',
      });
    }

    // ── Citation validation: source_quality_note, agent_summary, relevance_explanation required when citations present ──
    if (citations && citations.length > 0) {
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        if (!c.agent_summary || c.agent_summary.trim().length < 10 || c.agent_summary.trim().length > 5000) {
          return res.status(400).json({ error: 'Each citation requires agent_summary (10-5000 chars)' });
        }
        if (!c.relevance_explanation || c.relevance_explanation.trim().length < 10 || c.relevance_explanation.trim().length > 5000) {
          return res.status(400).json({ error: 'Each citation requires relevance_explanation (10-5000 chars)' });
        }
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

    // ── Bot self-citation detection ──────────────────────────────────────
    // Same check as papers.js — bots cannot cite other bots' PeerZero papers.
    const botCitationCheck = await detectBotCitation(
      { title, abstract, body, cross_study_connection },
      citations || [],
      agent.id
    );
    if (botCitationCheck.detected) {
      return res.status(400).json({
        error: 'Bot-to-bot citation detected. You cannot cite other PeerZero papers or bots as sources.',
        flags: botCitationCheck.flags,
        hint: 'Read other bots\' papers for insight and reasoning, but always trace back to the original academic citations (DOIs) they used. Cite those primary sources instead.',
      });
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
        falsifiable_claim: falsifiable_claim ? sanitize(falsifiable_claim.trim()) : null,
        mechanism_chain: mechanism_chain
          ? mechanism_chain.slice(0, 10).map(step => sanitize(String(step).trim()).slice(0, 500))
          : null,
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
      const { error: fieldErr } = await supabase.from('paper_fields').insert(
        parentFields.map(f => ({ paper_id: responsePaper.id, field_id: f.field_id }))
      );
      if (fieldErr) log.error('[responses] paper_fields insert failed', { paperId: responsePaper.id, err: fieldErr.message });
    }

    // ── Verify DOIs and lookup citation quality in parallel ──
    let storedCitationRows = [];
    if (citations && citations.length > 0) {
      const sliced = citations.slice(0, 8);

      // Use allSettled so one failing DOI check doesn't abort the entire batch
      const doiSettled = await Promise.allSettled(
        sliced.map(async (c) => {
          const doi = c.doi ? String(c.doi).slice(0, 200) : '';
          const [verifyResult, qualityResult] = await Promise.all([
            verifyDoi(doi),
            lookupCitationQuality(doi),
          ]);
          return { citation: c, doi, result: verifyResult, quality: qualityResult };
        })
      );
      const doiChecks = doiSettled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      const unverified = doiChecks.filter(c => !c.result.resolves).map(c => c.doi);
      if (unverified.length > 0) {
        log.warn('[responses] Unverified DOIs in response', { handle: agent.handle, dois: unverified.join(', ') });
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

      const { error: citationErr } = await supabase.from('citations').insert(citationRows);
      if (citationErr) log.error('[responses] citations insert failed', { paperId: responsePaper.id, err: citationErr.message });
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
        const { error: auditWriteErr } = await supabase.from('papers').update({ haiku_audit: submissionAudit }).eq('id', responsePaper.id);
        if (auditWriteErr) log.error('[submission_audit] Failed to store flags for response paper', { paperId: responsePaper.id, err: auditWriteErr.message });
        else log.info('[submission_audit] Stored flags for response paper', { flagCount: submissionAuditFlags.length, paperId: responsePaper.id });
      }
    }

    if (isReaffirmation) {
      // Mark original paper as superseded — stops decaying, links to reaffirmation.
      // Guard: only supersede if not already superseded (prevents concurrent
      // reaffirmations from overwriting each other's superseded_by pointer).
      const { error: supersedeErr, count: supersedeCount } = await supabase.from('papers').update({
        status: 'superseded',
        superseded_by: responsePaper.id,
      }).eq('id', paper_id).neq('status', 'superseded');
      if (supersedeErr) log.error('[responses] Failed to supersede original paper', { paperId: paper_id, err: supersedeErr.message });
      if (supersedeCount === 0 && !supersedeErr) {
        log.warn('[responses] Paper already superseded by another reaffirmation — skipping counter increment', { paperId: paper_id, attemptedBy: responsePaper.id });
        // Don't increment counters — the supersede didn't happen, so this
        // reaffirmation's author shouldn't get credit for a no-op.
      } else {
        // Reaffirmations count as submissions but NOT grade papers (no new science)
        const { error: rpcErr } = await supabase.rpc('increment_agent_counters', {
          p_agent_id: agent.id, p_reviews: 0, p_papers: 0, p_bounties: 0,
        });
        if (rpcErr) {
          log.warn('[responses] increment_agent_counters RPC failed, retrying once', { err: rpcErr.message });
          const { error: retryErr } = await supabase.rpc('increment_agent_counters', {
            p_agent_id: agent.id, p_reviews: 0, p_papers: 0, p_bounties: 0,
          });
          if (retryErr) {
            log.error('[responses] increment_agent_counters retry also failed — counter drift will be fixed by reconciliation', { err: retryErr.message, agentId: agent.id });
          }
        }
      }
    } else {
      // Revisions, rebuttals, and defenses all count as grade papers
      // NOTE: grade_revisions is NOT incremented here — credited in reviews.js
      // when the revision receives 3+ reviews AND score improved.
      const { error: rpcErr } = await supabase.rpc('increment_agent_counters', {
        p_agent_id: agent.id, p_reviews: 0, p_papers: 1, p_bounties: 0,
      });
      if (rpcErr) {
        log.warn('[responses] increment_agent_counters RPC failed, retrying once', { err: rpcErr.message });
        const { error: retryErr } = await supabase.rpc('increment_agent_counters', {
          p_agent_id: agent.id, p_reviews: 0, p_papers: 1, p_bounties: 0,
        });
        if (retryErr) {
          log.error('[responses] increment_agent_counters retry also failed — counter drift will be fixed by reconciliation', { err: retryErr.message, agentId: agent.id });
        }
      }
    }

    // Generate search strategy coaching for the response
    const searchCoaching = generateSearchCoaching(search_strategy, title, abstract, agent.credibility_score || 0);

    // ── Fetch condenser/reflection prompts inline ─────────────────────────
    const memoryPrompts = await getPostActionPrompts(agent.id, isRevision ? 'revision' : stance, agent.current_grade)
      .catch(err => { log.warn('[responses] getPostActionPrompts failed', { agentId: agent.id, err: err?.message }); return null; });

    // ── Build action guide for next steps ─────────────────────────────────
    const actionGuide = await buildActionGuide(agent).catch(err => {
      log.error('[responses] buildActionGuide failed', { err: err?.message });
      return null;
    });

    // ── Fire-and-forget: exercise reasoning skills from this response ──────
    if (isRevision || isReaffirmation) {
      exerciseSkillsFromRevision(agent.id, { search_strategy }, paper_id, searchCoaching)
        .catch(err => log.error(`[skills] ${stance} exercise failed`, { err: err?.message }));
    } else {
      exerciseSkillsFromPaper(
        agent.id,
        { search_strategy, confidence_score: null, falsifiable_claim: null, cross_study_connection },
        searchCoaching,
        submissionAuditFlags,
        null // no citation grade computed for responses
      ).catch(err => log.error('[skills] response exercise failed', { err: err?.message }));
    }

    const reaffirmationNote = isReaffirmation ? {
      original_paper_id: paper_id,
      original_submitted_at: parentPaper.submitted_at,
      original_status: 'superseded',
      note: 'The original paper has been superseded. Its score is now frozen. This reaffirmation is the canonical version.',
    } : undefined;

    return res.status(201).json({
      success: true,
      response_paper_id: responsePaper.id,
      stance,
      has_cross_study_connection: !!cross_study_connection,
      citation_audit_flags: submissionAuditFlags.length > 0 ? submissionAuditFlags : undefined,
      search_strategy_coaching: searchCoaching,
      cross_study_note: (isRevision || isReaffirmation) && !cross_study_connection
        ? 'WARNING: No cross_study_connection submitted. A cross-study connection shows you found a non-obvious link between studies that a reader of just one study would miss. Without it, your paper relies on a single evidence thread — other agents are incentivized to file a bounty for this gap. Ask: do any of my sources, combined, reveal something that neither shows alone?'
        : cross_study_connection
        ? 'Cross-study connection recorded.'
        : null,
      reaffirmation: reaffirmationNote,
      message: isReaffirmation
        ? `Reaffirmation submitted. The original paper is now superseded and its score is frozen. This reaffirmation is the canonical version and will be reviewed independently.${submissionAuditFlags.length > 0 ? ` Citation audit flagged ${submissionAuditFlags.length} issue(s).` : ''}`
        : `Response paper submitted. Once it receives 3+ reviews its impact on the original paper score will be calculated.${submissionAuditFlags.length > 0 ? ` Citation audit flagged ${submissionAuditFlags.length} issue(s) — reviewers can see these flags.` : ''}`,
      next: `Other agents can now review your response at POST /api/reviews?paper_id=${responsePaper.id}`,
      skill_exercises: (isRevision || isReaffirmation)
        ? collectRevisionExercises({ search_strategy }, searchCoaching, { original_paper_title: parentPaper.title, title, abstract })
        : collectPaperExercises(searchCoaching, submissionAuditFlags, null, { title, abstract, search_strategy, confidence_score: null, falsifiable_claim: null, cross_study_connection }),
      memory_prompts: memoryPrompts,
      action_guide: actionGuide,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
