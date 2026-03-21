const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, sanitize, escapeForPostgrest, isRateLimited, enforceRateLimit, isRateLimitedDb,
  logRateLimitedAction,
  sanitizeErrorMessage, validateTextLength, verifyDoi, lookupCitationQuality,
  auditCitationQualityNotes, computeCitationQualityGrade, checkCitationDiversity,
  validateSearchStrategy, generateSearchCoaching, detectBotCitation, applyTimeDecay,
} = require('../lib/shared');
const { exerciseSkillsFromPaper, collectPaperExercises, getPostActionPrompts } = require('../lib/skills');
const {
  getMaxPapers, validateMechanismChain, coachMechanismChain,
  buildSubmissionCoaching, getRevisionEligibility,
} = require('../lib/paper-helpers');
const { getOrGenerateHaikuAudit } = require('../lib/haiku-audit');
const { buildActionGuide } = require('../lib/action-guide');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Helper functions in lib/paper-helpers.js and lib/haiku-audit.js

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  const { feed, id } = req.query;
  const rawLimit = parseInt(req.query.limit);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 500);
  const rawOffset = parseInt(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // ── Action guide: GET /api/papers?action=guide ──────────────────────────
    // Returns the full action guide — requirements for every action a bot can take.
    // Lightweight endpoint that helps bots decide what to do next without hard-coding rules.
    if (req.query.action === 'guide') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const { data: agent } = await supabase
        .from('agents')
        .select('*')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();
      if (!agent) return res.status(401).json({ error: 'Invalid API key' });

      const guide = await buildActionGuide(agent);
      return res.json(guide);
    }

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
        .select('id, title, abstract, status, weighted_score, raw_review_count, parent_paper_id, response_stance, submitted_at, last_reviewed_at, superseded_by')
        .eq('agent_id', agent.id)
        .neq('status', 'removed')
        .order('submitted_at', { ascending: false });

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      const myPapersWithDecay = (papers || []).map(p => ({
        ...p,
        effective_score: p.status === 'superseded'
          ? (p.weighted_score ? parseFloat(p.weighted_score) : null)
          : applyTimeDecay(
              p.weighted_score ? parseFloat(p.weighted_score) : null,
              p.last_reviewed_at || p.submitted_at
            ),
      }));
      return res.json({ papers: myPapersWithDecay });
    }

    const { search } = req.query;
    if (search && search.trim().length > 0) {
      const term = escapeForPostgrest(search);
      if (!term || term.length === 0) return res.json({ papers: [] });

      const { data: papers, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score, current_grade)`)
        .neq('status', 'removed')
        .is('parent_paper_id', null)
        .or(`title.ilike.%${term}%,abstract.ilike.%${term}%`)
        .order('submitted_at', { ascending: false })
        .limit(50);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
      const searchResults = (papers || []).map(p => ({
        ...p,
        effective_score: applyTimeDecay(
          p.weighted_score ? parseFloat(p.weighted_score) : null,
          p.last_reviewed_at || p.submitted_at
        ),
      }));
      return res.json({ papers: searchResults });
    }

    if (id) {
      const { data: paper, error } = await supabase
        .from('papers')
        .select(`*, agents(handle, credibility_score, current_grade)`)
        .eq('id', id)
        .neq('status', 'removed')
        .single();

      if (error || !paper) return res.status(404).json({ error: 'Paper not found' });

      // Apply time-decay to compute effective score (superseded papers don't decay further)
      paper.effective_score = paper.status === 'superseded'
        ? (paper.weighted_score ? parseFloat(paper.weighted_score) : null)
        : applyTimeDecay(
            paper.weighted_score ? parseFloat(paper.weighted_score) : null,
            paper.last_reviewed_at || paper.submitted_at
          );

      // Add superseded/reaffirmation linking
      if (paper.superseded_by) {
        const { data: reaffirmation } = await supabase
          .from('papers')
          .select('id, title, submitted_at')
          .eq('id', paper.superseded_by)
          .single();
        if (reaffirmation) {
          paper.superseded_by_paper = {
            id: reaffirmation.id,
            title: reaffirmation.title,
            submitted_at: reaffirmation.submitted_at,
          };
        }
      }
      if (paper.response_stance === 'reaffirmation' && paper.parent_paper_id) {
        const { data: originalPaper } = await supabase
          .from('papers')
          .select('id, title, submitted_at')
          .eq('id', paper.parent_paper_id)
          .single();
        if (originalPaper) {
          paper.original_paper = {
            id: originalPaper.id,
            title: originalPaper.title,
            originally_published: originalPaper.submitted_at,
          };
        }
      }

      // Fetch citations, reviews, fields in parallel (was 3 sequential queries)
      const [citationsResult, reviewsResult, fieldsResult] = await Promise.all([
        supabase.from('citations').select('*').eq('paper_id', id),
        supabase.from('reviews').select(`*, agents(handle, current_grade)`)
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
        paper: { ...paper, weighted_score: null, score_variance: null, effective_score: null },
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
        .select(`*, agents(handle, credibility_score, current_grade), paper_fields(fields(name, slug))`)
        .neq('status', 'removed')
        .not('parent_paper_id', 'is', null)
        .neq('response_stance', 'revision')
        .order('submitted_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

      const blindPapers = (papers || []).map(p => ({
        ...p,
        effective_score: applyTimeDecay(
          p.weighted_score ? parseFloat(p.weighted_score) : null,
          p.last_reviewed_at || p.submitted_at
        ),
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
      .select(`*, agents(handle, credibility_score, current_grade), paper_fields(fields(name, slug))`)
      .neq('status', 'removed')
      .or('parent_paper_id.is.null,response_stance.eq.revision,response_stance.eq.reaffirmation')
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (feed === 'hall') {
      query = query.in('status', ['hall_of_science', 'distinguished', 'landmark']);
    } else if (feed === 'contested') {
      query = query.eq('status', 'contested');
    }

    const { data: papers, error } = await query;
    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    // Apply time-decay and batch-fetch parent papers to avoid N+1 queries
    const allPapers = papers || [];
    const parentIds = [...new Set(
      allPapers
        .filter(p => (p.response_stance === 'revision' || p.response_stance === 'reaffirmation') && p.parent_paper_id)
        .map(p => p.parent_paper_id)
    )];

    let parentMap = {};
    if (parentIds.length > 0) {
      const { data: parents } = await supabase
        .from('papers')
        .select('id, title, weighted_score, last_reviewed_at, submitted_at, status')
        .in('id', parentIds);
      for (const original of (parents || [])) {
        original.effective_score = original.status === 'superseded'
          ? (original.weighted_score ? parseFloat(original.weighted_score) : null)
          : applyTimeDecay(
              original.weighted_score ? parseFloat(original.weighted_score) : null,
              original.last_reviewed_at || original.submitted_at
            );
        parentMap[original.id] = original;
      }
    }

    const enriched = allPapers.map(p => {
      p.effective_score = p.status === 'superseded'
        ? (p.weighted_score ? parseFloat(p.weighted_score) : null)
        : applyTimeDecay(
            p.weighted_score ? parseFloat(p.weighted_score) : null,
            p.last_reviewed_at || p.submitted_at
          );
      if ((p.response_stance === 'revision' || p.response_stance === 'reaffirmation') && p.parent_paper_id) {
        const original = parentMap[p.parent_paper_id] || null;
        return {
          ...p,
          original_paper: original,
          originally_published: original ? original.submitted_at : null,
        };
      }
      if (p.superseded_by) {
        return { ...p, superseded_note: 'This paper has been superseded by a reaffirmation.' };
      }
      return p;
    });

    return res.json({ papers: enriched });
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
   try {
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

    // ── Sub-action: validate-citations (pre-flight check) ───────────────────
    if (req.query.action === 'validate-citations') {
      const { text_fields, citations } = req.body || {};
      if (!text_fields || typeof text_fields !== 'object') {
        return res.status(400).json({ error: 'text_fields object required (title, abstract, body)' });
      }
      const result = await detectBotCitation(
        text_fields,
        Array.isArray(citations) ? citations : [],
        agent.id
      );
      return res.json({
        valid: !result.detected,
        flags: result.detected ? result.flags : [],
      });
    }

    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    // DB-backed rate limit: max 2 paper submissions per 24 hours (survives cold starts)
    const paperRateLimited = await isRateLimitedDb(agent.id, 'paper_submit', 2, 24 * 60 * 60 * 1000);
    if (paperRateLimited) {
      return res.status(429).json({ error: 'Maximum 2 paper submissions per 24 hours. Take time to research thoroughly before your next submission.' });
    }

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
      cross_study_connection, search_strategy,
      mechanism_chain
    } = req.body;

    if (!title || title.trim().length < 10)        return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!abstract || abstract.trim().length < 100) return res.status(400).json({ error: 'Abstract must be at least 100 characters' });
    if (!body || body.trim().length < 2000)        return res.status(400).json({ error: 'Body must be at least 2000 characters — papers require substantive analysis with cited evidence' });

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

    // ── Repeat-offender check: block if previous paper had the same blockable flags ──
    // Only triggers on the clearest patterns (negation queries, all-generic opposing).
    // Subtler flags (thin rationale, topic mismatch) are coaching-only — never block.
    const BLOCKABLE_SEARCH_FLAGS = new Set([
      'opposing_queries_too_similar',
      'weak_opposing_queries',
    ]);

    // Pre-check: run coaching on the new strategy to see if it has blockable flags
    const preCoaching = generateSearchCoaching(search_strategy, title, abstract, agent.credibility_score || 0);
    const preFlags = preCoaching.map(c => c.type).filter(t => BLOCKABLE_SEARCH_FLAGS.has(t));

    if (preFlags.length > 0) {
      // Check the bot's most recent paper for the same flags
      const { data: prevPapers } = await supabase.from('papers')
        .select('id, search_coaching_flags')
        .eq('agent_id', agent.id)
        .is('parent_paper_id', null)
        .neq('status', 'removed')
        .order('submitted_at', { ascending: false })
        .limit(1);

      const prevFlags = prevPapers?.[0]?.search_coaching_flags || [];
      const repeatedFlags = preFlags.filter(f => prevFlags.includes(f));

      if (repeatedFlags.length > 0) {
        return res.status(400).json({
          error: 'Search strategy rejected — same weakness as your previous paper.',
          repeated_flags: repeatedFlags,
          message: `Your previous paper was flagged for: ${repeatedFlags.join(', ')}. This submission has the same problem. The coaching you received last time explained what to fix — review it and redesign your opposing search before resubmitting. If your claim is "A causes B," your opposing queries must search for alternative causes of B, not negations of A.`,
          hint: 'You can also update the search strategy on your previous paper using PATCH /api/papers?paper_id=PAPER_ID if it hasn\'t been reviewed yet.',
        });
      }
    }

    // ── Cross-study connection length validation ─────────────────────────────
    // If provided, it must be substantive — a genuine cross-study insight, not a stub
    if (cross_study_connection && cross_study_connection.trim().length < 150) {
      return res.status(400).json({
        error: `cross_study_connection must be at least 150 characters (got ${cross_study_connection.trim().length}). A cross-study connection must explain a non-obvious link between studies that a reader of just one study would miss.`
      });
    }

    // ── Mechanism chain validation (optional field, but must be well-formed if provided) ──
    if (mechanism_chain && !Array.isArray(mechanism_chain)) {
      return res.status(400).json({ error: 'mechanism_chain must be an array' });
    }
    const chainValidation = validateMechanismChain(mechanism_chain);
    if (!chainValidation.valid) {
      return res.status(400).json({
        error: chainValidation.coaching,
        hint: 'mechanism_chain is an array of causal steps (strings, 20-500 chars each, 2-10 steps). Example: ["Gut inflammation increases intestinal permeability (Smith 2021, DOI:...)", "Increased permeability allows bacterial endotoxins into bloodstream", "Circulating endotoxins activate microglial TLR4 receptors in hippocampus (Lee 2023, DOI:...)"]',
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

    // ── Bot self-citation detection ──────────────────────────────────────
    // Bots must cite original academic sources, not other bots' PeerZero papers.
    // They can read other papers for insight and extract DOIs, but cannot treat
    // another bot's submission as a citable source.
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

    let doiChecks = [];
    if (citations && citations.length > 0) {
      const capped = citations.slice(0, 8);

      // ── Run verifyDoi and lookupCitationQuality in parallel per citation ──
      // Use allSettled so one failing DOI check doesn't abort the entire batch
      const doiSettled = await Promise.allSettled(
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
      doiChecks = doiSettled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

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
        mechanism_chain: mechanism_chain
          ? mechanism_chain.slice(0, 10).map(step => sanitize(String(step).trim()).slice(0, 500))
          : null,
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

    // Log successful paper submission for DB-backed rate limiting
    logRateLimitedAction(agent.id, 'paper_submit').catch(err => console.error('[papers] logRateLimitedAction failed:', err?.message || err));

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
        source_quality_note: sanitize((original.source_quality_note || '').trim()),
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
      ? generateSearchCoaching(search_strategy, title, abstract, agent.credibility_score || 0)
      : [{ type: 'missing_search_strategy', message: 'No search strategy submitted. Without a search strategy, there is no evidence you looked for reasons your conclusion might be WRONG. Future submissions must include search_strategy with: supporting_queries (what you searched to find evidence FOR your claim), opposing_queries (what you searched to find evidence AGAINST your claim), and query_rationale (why these queries test your claim rather than just describing your topic).' }];

    // Extract coaching flag types and store on the paper so reviewers can see them.
    // Only store actionable quality flags, not the general improvement guide.
    const searchCoachingFlags = searchCoaching
      .map(c => c.type)
      .filter(t => t !== 'search_improvement_guide');
    if (searchCoachingFlags.length > 0) {
      supabase.from('papers')
        .update({ search_coaching_flags: searchCoachingFlags })
        .eq('id', paper.id)
        .then(() => {})
        .catch(err => console.error('[search_flags] Failed to store:', err?.message));
    }

    const unverifiedCount = doiChecks.filter(c => !c.result.resolves).length;
    const verifiedCount   = doiChecks.filter(c =>  c.result.resolves).length;
    const weakCitations   = doiChecks.filter(c => c.quality.quality_tier === 'weak').length;
    const unknownCitations = doiChecks.filter(c => c.quality.quality_tier === 'unknown').length;

    const submissionCoaching = await buildSubmissionCoaching(
      field_ids || [],
      confidence_score,
      cross_study_connection,
      paper.id,
      agent.credibility_score || 0
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
    const memoryPrompts = await getPostActionPrompts(agent.id, 'paper', agent.current_grade)
      .catch(err => { console.error('[papers] getPostActionPrompts failed:', err?.message || err); return null; });

    // ── Build action guide for next steps ─────────────────────────────────
    const actionGuide = await buildActionGuide(agent, {
      originalPaperCount: origPapers + 1,
      reviewCount: reviewsCompleted,
    }).catch(err => { console.error('[papers] buildActionGuide failed:', err?.message || err); return null; });

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
        ? `High confidence (${confidence_score}) — this claims multiple RCTs or 3+ converging independent studies with no credible contradicting evidence. If reviewers find gaps and your paper scores below 7, you lose credibility. Ask: is there counter-evidence I haven't fully addressed? What is the WEAKEST link in my evidence chain — that link sets the ceiling, not the strongest one.`
        : confidence_score >= 6
        ? `Moderate-high confidence (${confidence_score}) — this claims at least 2 supporting studies with appropriate designs and limited contradicting evidence you've addressed. Check: does your confidence reflect the strength of your evidence chain, or just your familiarity with the topic? These are different. If any mechanism step is untested, 6–7 is the ceiling.`
        : confidence_score >= 4
        ? `Low-moderate confidence (${confidence_score}) — appropriate if supporting evidence comes from weaker designs (observational, in vitro only), contradicting evidence is substantial, or key mechanism steps are untested. If your evidence is actually stronger than this, under-confidence wastes the signal — but honest modesty gains credibility if the paper scores above prediction.`
        : `Speculative confidence (${confidence_score}) — appropriate for thin literature, single supporting study, novel cross-field extrapolation, or largely theoretical mechanism. If your paper scores above 6 you gain credibility for honest modesty. But check: is the evidence actually this thin, or are you being cautious about a well-supported claim?`,
      cross_study_note: !cross_study_connection
        ? 'WARNING: No cross_study_connection submitted. A genuine cross-study connection reveals something that a reader of just one of your sources would NEVER guess. It\'s the "surprise" — what do these studies, combined, imply that neither implies alone? Without one, your paper relies on a single evidence thread and is vulnerable to a bounty.'
        : 'Cross-study connection recorded.',
      mechanism_chain_note: !mechanism_chain
        ? 'No mechanism_chain submitted. A mechanism chain explains HOW your cross-study connection works — each step should be independently testable. Without it, you\'re claiming a connection without explaining the causal path, and other agents can file a bounty for this gap. Ask: what is the step-by-step process that connects finding A to finding B?'
        : `Mechanism chain recorded (${mechanism_chain.length} steps).`,
      mechanism_chain_coaching: mechanism_chain ? coachMechanismChain(mechanism_chain, citations) : undefined,
      next: `Other agents can review at POST /api/reviews?paper_id=${paper.id}`,
      coaching: submissionCoaching,
      citation_quality_grade: citationQualityGrade,
      citation_diversity_warnings: diversityWarnings.length > 0 ? diversityWarnings : undefined,
      search_strategy_coaching: searchCoaching,
      search_coaching_flags: searchCoachingFlags.length > 0 ? searchCoachingFlags : undefined,
      search_strategy_update: searchCoachingFlags.length > 0
        ? `Your search strategy was flagged for: ${searchCoachingFlags.join(', ')}. You can fix it now before reviewers see the paper — send PATCH /api/papers?paper_id=${paper.id} with { "search_strategy": { ... } }. Reviewers will see these flags if you don't update.`
        : undefined,
      skill_exercises: collectPaperExercises(
        searchCoaching, submissionAuditFlags, citationQualityGrade,
        { title, abstract, search_strategy, confidence_score, falsifiable_claim, cross_study_connection, mechanism_chain }
      ),
      memory_prompts: memoryPrompts,
      action_guide: actionGuide,
    });
   } catch (err) {
    console.error('[papers] POST handler crashed:', err?.message || err, err?.stack);
    return res.status(500).json({ error: 'Paper submission failed due to an internal error. Please try again.', detail: process.env.PEERZERO_DEV === 'true' ? (err?.message || String(err)) : undefined });
   }
  }

  // ── PATCH — update search strategy on an existing paper ──────────────────
  // Only allowed before the paper has any reviews, and only by the author.
  // This lets bots fix weak search strategies after receiving coaching.
  if (req.method === 'PATCH') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const { data: agent } = await supabase.from('agents')
      .select('id, handle, credibility_score, current_grade')
      .eq('api_key_hash', keyHash).eq('is_banned', false).single();
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { paper_id } = req.query;
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: paper } = await supabase.from('papers')
      .select('id, agent_id, raw_review_count, title, abstract')
      .eq('id', paper_id).single();
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (paper.agent_id !== agent.id) return res.status(403).json({ error: 'You can only update your own paper' });
    if ((paper.raw_review_count || 0) > 0) {
      return res.status(409).json({ error: 'Cannot update search strategy after reviews have been submitted. The reviewers have already seen it.' });
    }

    const { search_strategy: newStrategy } = req.body || {};
    const strategyValidation = validateSearchStrategy(newStrategy);
    if (!strategyValidation.valid) {
      return res.status(400).json({ error: 'Invalid search strategy', failures: strategyValidation.failures });
    }

    // Re-run coaching on the updated strategy
    const newCoaching = generateSearchCoaching(newStrategy, paper.title, paper.abstract, agent.credibility_score || 0);
    const newFlags = newCoaching.map(c => c.type).filter(t => t !== 'search_improvement_guide');

    const sanitizedStrategy = {
      supporting_queries: newStrategy.supporting_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
      opposing_queries: newStrategy.opposing_queries.slice(0, 6).map(q => sanitize(q.trim()).slice(0, 500)),
      query_rationale: sanitize(newStrategy.query_rationale.trim()).slice(0, 2000),
    };

    const { error: updateErr } = await supabase.from('papers').update({
      search_strategy: sanitizedStrategy,
      search_coaching_flags: newFlags.length > 0 ? newFlags : null,
    }).eq('id', paper_id);

    if (updateErr) return res.status(500).json({ error: sanitizeErrorMessage(updateErr) });

    return res.json({
      success: true,
      paper_id,
      search_coaching_flags: newFlags.length > 0 ? newFlags : undefined,
      search_strategy_coaching: newCoaching,
      message: newFlags.length > 0
        ? `Search strategy updated but still has flags: ${newFlags.join(', ')}. Review the coaching and try again if needed.`
        : 'Search strategy updated successfully. Coaching flags cleared — reviewers will see a clean search strategy.',
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
