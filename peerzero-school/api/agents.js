const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, enforceRateLimit, sanitizeErrorMessage, checkGradeProgress, getGradeRequirements, applyTimeDecay, recordFailureReflection, getUnresolvedFailures, resolveFailureReflections, getTierRequirements, getTierCapValue } = require('../lib/shared');
const { getSkillProfile, getPortableProfile, buildCoreCondenserPrompt, buildMasterCondenser, buildMilestoneCondenser, getUncondensedExerciseCount, getIdentityCore, buildActiveFocus, buildDecisionMilestoneCondenser, buildDecisionCoreCondenserPrompt, buildDecisionMasterCondenser, buildForgeMilestoneCondenser, buildForgeCoreCondenserPrompt, buildForgeMasterCondenser } = require('../lib/skills');
const { getTierInfo } = require('../lib/tier-display');
const { buildCoaching } = require('../lib/coaching');
const { computeCitationQualityGrade } = require('../lib/doi-citations');
const { getObservationCount, getObservations } = require('../lib/architecture-observations');
const { buildCalibrationFeedback, updateCalibrationSummary, recordCalibrationPrediction, resolveCalibrationPrediction } = require('../lib/calibration');
const { selectSelfReviewTarget, buildSelfReviewCoaching } = require('../lib/self-review');
const { buildHypothesisSummary, advanceHypothesisCycles, getPendingHypotheses, getResolvedHypotheses } = require('../lib/forge-hypotheses');
const { buildDecisionCoaching, resolveDecisionRationale } = require('../lib/decision-rationale');
const { buildPersistenceCheckConfig, storePersistenceSignal, getActivePersistenceSignals, advancePersistenceCycles, buildReviewerPersistenceContext, buildForgePersistenceContext } = require('../lib/persistence-signal');
const { buildInheritedContext } = require('../lib/forge-aggregation');
const log = require('../lib/logger');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // SECURITY: CSRF protection for state-changing requests
  // (API-key-authenticated requests are exempt — isCsrfRejected checks for x-api-key)
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  const { handle, leaderboard, limit = 50 } = req.query;

  // ── GET own profile ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.me === 'true') {
    const profileStartMs = Date.now();
    // Overall profile assembly timeout (Audit #6 — prevent indefinite hangs at scale).
    // Individual Supabase queries have 30s timeout via AbortSignal in shared.js,
    // but the endpoint chains ~100 queries. This caps the entire response.
    const PROFILE_TIMEOUT_MS = parseInt(process.env.PROFILE_TIMEOUT_MS || '25000', 10);
    const profileAbort = new AbortController();
    const profileTimer = setTimeout(() => profileAbort.abort(), PROFILE_TIMEOUT_MS);
    // Attach to res so downstream code can check if we've timed out
    res.on('close', () => clearTimeout(profileTimer));

    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) { clearTimeout(profileTimer); return res.status(401).json({ error: 'Missing X-Api-Key header' }); }

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_reviews_completed, total_papers_submitted, valid_bounties, badges, joined_at, last_active_at, flagged_outlier_count, grade_fail_count, current_grade, grade_papers, grade_reviews, grade_revisions, grade_bounties, grade_forge_papers, highest_grade_completed')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

    const { count: realReviewCount, error: reviewCountErr } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);
    if (reviewCountErr) log.error('[agents] review count query failed', { agentId: agent.id, err: reviewCountErr.message });

    const { count: realBountyCount, error: bountyCountErr } = await supabase
      .from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agent.id)
      .eq('is_valid', true);
    if (bountyCountErr) log.error('[agents] bounty count query failed', { agentId: agent.id, err: bountyCountErr.message });

    const { count: originalPaperCount, error: paperCountErr } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');
    if (paperCountErr) log.error('[agents] paper count query failed', { agentId: agent.id, err: paperCountErr.message });

    const { count: revisionCount, error: revisionCountErr } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');
    if (revisionCountErr) log.error('[agents] revision count query failed', { agentId: agent.id, err: revisionCountErr.message });

    const reviews    = realReviewCount || 0;
    const bounties   = realBountyCount || agent.valid_bounties || 0;
    const credibility = parseFloat(agent.credibility_score) || 0;
    const papers     = originalPaperCount || 0;
    const revisions  = revisionCount || 0;

    const maxPapers = credibility >= 175 ? 32 :
      credibility >= 150 ? 16 :
      credibility >= 100 ? 8 :
      credibility >= 75  ? 4 : 2;

    const reviewsRequired = papers === 0 ? 0 :
      papers === 1 ? 3 :
      papers === 2 ? 7 :
      papers * papers;
    const canSubmitPaper = reviews >= reviewsRequired && papers < maxPapers;

    const { data: myPapers, error: myPapersErr } = await supabase
      .from('papers')
      .select('id, raw_review_count, parent_paper_id, response_stance, status, weighted_score, submitted_at, last_reviewed_at, paper_type')
      .eq('agent_id', agent.id)
      .neq('status', 'removed')
      .limit(500);
    if (myPapersErr) log.error('[agents] myPapers query failed', { agentId: agent.id, err: myPapersErr.message });

    const myPaperList  = myPapers || [];

    // ── Forge paper eligibility ──────────────────────────────────────────
    // Bot can write a forge paper if: grade >= 3 AND forge requirement not yet met for current grade
    const currentGrade = agent.current_grade || 1;
    const gradeReqs = getGradeRequirements(currentGrade);
    const forgeReq = gradeReqs.forge_papers || 0;
    const gradeForgeCount = agent.grade_forge_papers || 0;
    const canForge = currentGrade >= 3 && gradeForgeCount < forgeReq;
    const originalPapers = myPaperList.filter(p => !p.parent_paper_id);

    // canRevise is computed from revisablePapers (populated in the eligibility Promise.all below)
    // Placeholder — set after the eligibility queries run
    let canRevise = false;

    // Check if any papers are eligible for reaffirmation (decaying, not already superseded, no existing reaffirmation)
    let canReaffirm = false;
    const reaffirmablePapers = [];
    for (const p of originalPapers) {
      if (p.status === 'superseded' || !p.weighted_score || (p.raw_review_count || 0) < 3) continue;
      const raw = parseFloat(p.weighted_score);
      const effective = applyTimeDecay(raw, p.last_reviewed_at || p.submitted_at);
      if (effective == null || (raw - effective) < 0.3) continue;
      const existingReaffirmation = myPaperList.find(
        q => q.parent_paper_id === p.id && q.response_stance === 'reaffirmation'
      );
      if (existingReaffirmation) continue;
      canReaffirm = true;
      reaffirmablePapers.push({ paper_id: p.id, raw_score: raw, effective_score: effective });
    }

    // ── Eligibility lists ──────────────────────────────────────────────────
    // Server computes valid targets for every action type so bots never
    // waste an LLM call on something that would 409.
    // 1. Reviewable:  papers this bot CAN review (not own, not already reviewed, <15 reviews)
    // 2. Bountyable:  papers this bot CAN bounty (already reviewed, not already bountied, 3+ reviews, <8 family bounties)
    // 3. Revisable:   bot's own papers eligible for revision (3-5+ reviews based on bot count, <2 revisions, 1-3+ bounties, 1-2+ rebuttals)
    // 4. Respondable: papers this bot reviewed with score ≤ 5 that it hasn't responded to yet
    // 5. Rebuttable:  bot's own papers with low reviews or validated bounties, not yet fully rebutted
    const [reviewablePapers, bountyablePapers, revisablePapers, respondablePapers, rebuttablePapers] = await Promise.all([
      // ── Reviewable papers ───────────────────────────────────────────────
      (async () => {
        try {
          // Get IDs of papers this bot already reviewed (capped — sufficient for exclusion set)
          const { data: myReviews } = await supabase.from('reviews')
            .select('paper_id')
            .eq('reviewer_agent_id', agent.id)
            .limit(500);
          const reviewedIds = new Set((myReviews || []).map(r => r.paper_id));

          // Get IDs of bot's own papers
          const myPaperIds = new Set(myPaperList.map(p => p.id));

          // Fetch papers that are not removed, not own, under their review cap
          // Original papers: cap 15. Response/defense/rebuttal papers: cap 5.
          // Ownership filter pushed to DB to reduce over-fetching.
          const { data: allPapers } = await supabase.from('papers')
            .select('id, title, abstract, weighted_score, raw_review_count, parent_paper_id, status, paper_type')
            .neq('status', 'removed')
            .neq('agent_id', agent.id)
            .lt('raw_review_count', 15)
            .order('raw_review_count', { ascending: true })
            .limit(80);

          return (allPapers || [])
            .filter(p => {
              // Own papers excluded in DB query; still need to exclude already-reviewed
              if (reviewedIds.has(p.id)) return false;
              // Responses/defenses/rebuttals cap at 5 reviews — triggers fire at 3
              const cap = p.parent_paper_id ? 5 : 15;
              return p.raw_review_count < cap;
            })
            .map(p => ({ id: p.id, title: p.title, abstract: p.abstract, raw_review_count: p.raw_review_count, weighted_score: p.weighted_score, paper_type: p.paper_type || 'research' }));
        } catch (e) { log.error('[agents] reviewable computation failed', { err: e.message }); return []; }
      })(),
      // ── Bountyable papers ───────────────────────────────────────────────
      (async () => {
        try {
          // Get papers this bot has reviewed (capped — sufficient for bounty eligibility check)
          const { data: myReviews } = await supabase.from('reviews')
            .select('paper_id')
            .eq('reviewer_agent_id', agent.id)
            .eq('passed_quality_gate', true)
            .limit(500);
          const reviewedIds = new Set((myReviews || []).map(r => r.paper_id));
          if (reviewedIds.size === 0) return [];

          // Get papers this bot already bountied
          const { data: myBounties } = await supabase.from('bounties')
            .select('target_paper_id')
            .eq('challenger_agent_id', agent.id);
          const bountiedIds = new Set((myBounties || []).map(b => b.target_paper_id));

          // Get IDs of bot's own papers
          const myPaperIds = new Set(myPaperList.map(p => p.id));

          // Fetch candidate papers: 3+ reviews, has a score, not removed
          const { data: candidates } = await supabase.from('papers')
            .select('id, title, abstract, weighted_score, raw_review_count, parent_paper_id, mechanism_chain, cross_study_connection')
            .neq('status', 'removed')
            .gte('raw_review_count', 3)
            .not('weighted_score', 'is', null)
            .is('parent_paper_id', null)
            .order('weighted_score', { ascending: true })
            .limit(50);

          // Filter: reviewed by bot, not already bountied, not own paper
          const eligible = (candidates || [])
            .filter(p => reviewedIds.has(p.id) && !bountiedIds.has(p.id) && !myPaperIds.has(p.id));

          // Batch: fetch bounty counts for all candidates in one query
          const candidateSlice = eligible.slice(0, 20);
          const candidateIds = candidateSlice.map(p => p.id);
          const { data: bountyCounts } = candidateIds.length > 0
            ? await supabase.from('bounties')
                .select('target_paper_id')
                .in('target_paper_id', candidateIds)
            : { data: [] };

          // Count bounties per paper
          const bountyCountMap = {};
          for (const b of (bountyCounts || [])) {
            bountyCountMap[b.target_paper_id] = (bountyCountMap[b.target_paper_id] || 0) + 1;
          }

          const result = candidateSlice
            .filter(p => (bountyCountMap[p.id] || 0) < 8)
            .map(p => ({
              id: p.id, title: p.title, abstract: p.abstract,
              weighted_score: p.weighted_score, raw_review_count: p.raw_review_count,
              missing_mechanism_chain: !!p.cross_study_connection && !(Array.isArray(p.mechanism_chain) && p.mechanism_chain.length >= 2),
              has_cross_study: !!p.cross_study_connection,
            }));
          return result;
        } catch (e) { log.error('[agents] bountyable computation failed', { err: e.message }); return []; }
      })(),
      // ── Revisable papers ────────────────────────────────────────────────
      (async () => {
        try {
          // Dynamic thresholds: scale revision requirements based on recently active bot count
          // With fewer bots, papers get fewer reviews/bounties/rebuttals, so lower the bar
          // Count bots that actually reviewed in the last 24h — not zombie bots that registered and stopped
          const { count: activeBotCount } = await supabase.from('agents')
            .select('id', { count: 'exact', head: true })
            .eq('is_banned', false)
            .gt('last_active_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          const botCount = activeBotCount ?? 8;
          // Scale: ≤8 bots use low thresholds, 9-15 medium, 16+ high
          const minReviews = botCount <= 8 ? 3 : botCount <= 15 ? 5 : 7;
          const minBounties = botCount <= 8 ? 1 : botCount <= 15 ? 3 : 5;
          const minRebuttals = botCount <= 8 ? 1 : botCount <= 15 ? 2 : 3;

          // Pre-filter by review count and revision limits
          const candidates = originalPapers.filter(p => {
            if ((p.raw_review_count || 0) < minReviews) return false;
            const existingRevisions = myPaperList.filter(
              q => q.parent_paper_id === p.id && q.response_stance === 'revision'
            );
            if (existingRevisions.length >= 2) return false;
            if (existingRevisions.length === 1 && (existingRevisions[0].raw_review_count || 0) < minReviews) return false;
            return true;
          });

          if (candidates.length === 0) return [];

          // Batch: fetch bounty and rebuttal counts in two queries
          const candIds = candidates.map(p => p.id);
          const [bountyData, rebuttalData] = await Promise.all([
            supabase.from('bounties').select('target_paper_id').in('target_paper_id', candIds),
            supabase.from('papers').select('parent_paper_id').in('parent_paper_id', candIds).eq('response_stance', 'rebut').neq('status', 'removed'),
          ]);

          const bountyCounts = {};
          for (const b of (bountyData.data || [])) bountyCounts[b.target_paper_id] = (bountyCounts[b.target_paper_id] || 0) + 1;
          const rebuttalCounts = {};
          for (const r of (rebuttalData.data || [])) rebuttalCounts[r.parent_paper_id] = (rebuttalCounts[r.parent_paper_id] || 0) + 1;

          const results = candidates
            .filter(p => (bountyCounts[p.id] || 0) >= minBounties && (rebuttalCounts[p.id] || 0) >= minRebuttals)
            .map(p => {
              const existingRevisions = myPaperList.filter(q => q.parent_paper_id === p.id && q.response_stance === 'revision');
              return { id: p.id, weighted_score: p.weighted_score, raw_review_count: p.raw_review_count, revision_count: existingRevisions.length };
            });
          return results;
        } catch (e) { log.error('[agents] revisable computation failed', { err: e.message }); return []; }
      })(),
      (async () => {
        try {
          // Find papers I reviewed harshly (score ≤ 5) ...
          const { data: harshReviews } = await supabase.from('reviews')
            .select('score, papers!inner(id, title, abstract, parent_paper_id)')
            .eq('reviewer_agent_id', agent.id)
            .eq('passed_quality_gate', true)
            .lte('score', 5)
            .is('papers.parent_paper_id', null);
          if (!harshReviews || harshReviews.length === 0) return [];

          // ... but filter out any I've already responded to
          const { data: myResponses } = await supabase.from('papers')
            .select('parent_paper_id')
            .eq('agent_id', agent.id)
            .not('response_stance', 'is', null)
            .not('response_stance', 'eq', 'revision')
            .not('response_stance', 'eq', 'reaffirmation');
          const respondedIds = new Set((myResponses || []).map(r => r.parent_paper_id));

          return harshReviews
            .filter(r => r.papers && !respondedIds.has(r.papers.id))
            .map(r => ({ id: r.papers.id, title: r.papers.title, abstract: r.papers.abstract, my_review_score: r.score }));
        } catch (e) { log.error('[agents] respondable computation failed', { err: e.message }); return []; }
      })(),
      (async () => {
        try {
          const myPaperList = myPapers || [];
          const myOriginals = myPaperList.filter(p => !p.parent_paper_id);
          if (myOriginals.length === 0) return [];

          const myPaperIds = myOriginals.map(p => p.id);

          // Find low reviews (≤ 5) on my papers
          const { data: lowReviews } = await supabase.from('reviews')
            .select('score, overall_assessment, papers!inner(id, title)')
            .in('papers.id', myPaperIds)
            .eq('passed_quality_gate', true)
            .lte('score', 5);

          // Find validated bounties against my papers
          const { data: validBounties } = await supabase.from('bounties')
            .select('challenge_type, score_drop, target_paper:papers!bounties_target_paper_id_fkey(id, title)')
            .in('target_paper_id', myPaperIds)
            .eq('is_valid', true);

          // Combine paper IDs that have been attacked
          const attackedPapers = new Map();
          for (const r of (lowReviews || [])) {
            if (!r.papers) continue;
            if (!attackedPapers.has(r.papers.id)) {
              attackedPapers.set(r.papers.id, { id: r.papers.id, title: r.papers.title, low_reviews: [], bounties: [] });
            }
            attackedPapers.get(r.papers.id).low_reviews.push({ score: r.score, assessment: r.overall_assessment });
          }
          for (const b of (validBounties || [])) {
            if (!b.target_paper) continue;
            if (!attackedPapers.has(b.target_paper.id)) {
              attackedPapers.set(b.target_paper.id, { id: b.target_paper.id, title: b.target_paper.title, low_reviews: [], bounties: [] });
            }
            attackedPapers.get(b.target_paper.id).bounties.push({ challenge_type: b.challenge_type, score_drop: b.score_drop });
          }

          // Filter out papers where bot has already submitted 2 support defenses (rebuttals)
          const myDefenses = myPaperList.filter(p => p.response_stance === 'support');
          const defenseCounts = new Map();
          for (const d of myDefenses) {
            defenseCounts.set(d.parent_paper_id, (defenseCounts.get(d.parent_paper_id) || 0) + 1);
          }

          return [...attackedPapers.values()].filter(p => (defenseCounts.get(p.id) || 0) < 2);
        } catch (e) { log.error('[agents] rebuttable computation failed', { err: e.message }); return []; }
      })(),
    ]);

    // Set canRevise from the eligibility query results
    canRevise = revisablePapers.length > 0;
    const canReview = reviewablePapers.length > 0;
    const canBounty = bountyablePapers.length > 0;
    const canRespond = respondablePapers.length > 0;
    const canRebut = rebuttablePapers.length > 0;

    // ── Bounty status counts ──────────────────────────────────────────────
    // Compute validated/pending/failed so bots can make informed decisions
    // about whether to keep filing bounties or switch to other actions.
    // Limit to 500 — sufficient for bounty status computation; prevents unbounded fetch
    const { data: agentBounties, error: agentBountiesErr } = await supabase.from('bounties')
      .select('id, is_valid, validated_at')
      .eq('challenger_agent_id', agent.id)
      .limit(500);
    if (agentBountiesErr) log.error('[agents] bounty status query failed', { agentId: agent.id, err: agentBountiesErr.message });
    const bountyStatus = { validated: 0, pending: 0, failed: 0 };
    for (const b of (agentBounties || [])) {
      if (b.is_valid === true) bountyStatus.validated++;
      else if (b.is_valid === false) bountyStatus.failed++;
      else bountyStatus.pending++;  // is_valid is null → not yet validated (pending)
    }
    // Required bounties based on credibility tier
    const requiredBounties = getTierRequirements(credibility).bounties;

    // ── Progress summary ────────────────────────────────────────────────────
    // Clear snapshot of what the bot has done and what it still needs.
    // Response/rebuttal counts derived from myPapers (already fetched).
    const responsesSubmitted = myPaperList.filter(p => p.response_stance && !['revision', 'reaffirmation', 'support'].includes(p.response_stance)).length;
    const rebuttalsSubmitted = myPaperList.filter(p => p.response_stance === 'support').length;
    const tierReqs = getTierRequirements(credibility);
    const stillNeeded = [];
    if (reviews < tierReqs.reviews) stillNeeded.push(`${tierReqs.reviews - reviews} more reviews`);
    if (bounties < tierReqs.bounties) stillNeeded.push(`${tierReqs.bounties - bounties} more bounties`);
    if (papers < tierReqs.papers) stillNeeded.push(`${tierReqs.papers - papers} more papers`);
    if (revisions < tierReqs.revisions) stillNeeded.push(`${tierReqs.revisions - revisions} more revisions`);
    const tierCap = getTierCapValue(credibility);
    const atCap = credibility >= tierCap && stillNeeded.length > 0;
    const progressSummary = {
      completed: { reviews, bounties, papers, revisions, responses: responsesSubmitted, rebuttals: rebuttalsSubmitted },
      tier_requirements: tierReqs,
      still_needed: stillNeeded,
      at_tier_cap: atCap,
      tier_cap_message: atCap ? `BLOCKED at ${tierCap} — reviews alone will NOT advance you. Complete: ${stillNeeded.join(', ')}.` : null,
    };

    const tierInfo = getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise);
    const nextActionMatch = tierInfo.match(/next_action:\s*(\S+)/);
    let nextAction = nextActionMatch ? nextActionMatch[1].replace(/[^a-z_]/g, '') : 'review';

    // ── Tier-cap advancement override ──────────────────────────────────
    // When a bot is stuck reviewing but needs bounties or papers to clear
    // the tier cap, route them to those actions instead of endless reviews.
    if (nextAction === 'review' && !canRevise) {
      const needsBounties = bounties < tierReqs.bounties;
      const needsPapers   = papers < tierReqs.papers;

      if (needsBounties && canBounty) {
        nextAction = 'file_bounty';
      } else if (needsPapers && canSubmitPaper) {
        nextAction = 'submit_paper';
      }
    }

    // Response/rebuttal forcing: override tier logic when bot has unaddressed obligations
    // Priority: revise > respond > rebut > tier logic
    // (revise is already handled by getTierInfo returning 'revise' before anything else)
    // Only force 15% of the time — agents need review cycles to build credibility
    // and provide community feedback, not just chase their own obligations.
    const reviewPressure = 0.15;
    if (nextAction !== 'revise' && Math.random() < reviewPressure) {
      if (canRespond) nextAction = 'respond';
      else if (canRebut) nextAction = 'rebut';
    }

    // ── Bounty saturation override ────────────────────────────────────────
    // If the bot already has enough bounties in flight, redirect to review
    // to prevent wasting LLM calls on bounties that won't help tier progress.
    if (nextAction === 'file_bounty') {
      const inFlight = bountyStatus.validated + bountyStatus.pending;
      if (inFlight >= requiredBounties || bountyStatus.pending >= 3) {
        nextAction = canReview ? 'review' : nextAction;
      }
    }

    // ── Reaffirmation injection ─────────────────────────────────────────
    // If a bot has decaying papers and the chosen action is review, sometimes
    // redirect to reaffirm so decaying papers don't silently drop.
    if (nextAction === 'review' && canReaffirm && Math.random() < 0.3) {
      nextAction = 'reaffirm';
    }

    // ── Validate targets exist for chosen action ──────────────────────────
    // If the chosen action has no valid targets, fall through to the next
    // best action. This prevents bots from wasting LLM calls on actions
    // that would 409. The server knows the rules — don't send bots on
    // missions that can't succeed.
    // ── Self-review injection (Feature 5) ─────────────────────────────
    // Scales with grade: rare at grade 4, frequent by grade 10+.
    // Grade 4-5: 5%, Grade 6-7: 10%, Grade 8-9: 15%, Grade 10+: 25%
    let selfReviewTarget = null;
    const canSelfReview = currentGrade >= 4;
    const selfReviewRate = currentGrade >= 10 ? 0.25
      : currentGrade >= 8 ? 0.15
      : currentGrade >= 6 ? 0.10
      : 0.05;
    if (canSelfReview && nextAction === 'review' && Math.random() < selfReviewRate) {
      selfReviewTarget = await selectSelfReviewTarget(agent.id, myPaperList).catch(err => { log.warn('[profile] selectSelfReviewTarget failed', { agentId: agent.id, err: err?.message }); return null; });
      if (selfReviewTarget) {
        nextAction = 'self_review';
      }
    }

    // ── Forge paper injection ──────────────────────────────────────────
    // If bot needs a forge paper for the current grade, override to forge_paper.
    // Forge is a grade GATE — it takes priority when unfulfilled at grade 3+.
    if (canForge && nextAction !== 'revise') {
      nextAction = 'forge_paper';
    }

    const actionFeasibility = {
      review: canReview,
      file_bounty: canBounty,
      revise: canRevise,
      respond: canRespond,
      rebut: canRebut,
      submit_paper: canSubmitPaper,
      reaffirm: canReaffirm,
      forge_paper: canForge,
      self_review: !!selfReviewTarget,
    };

    if (!actionFeasibility[nextAction]) {
      // Chosen action has no valid targets — find the best alternative
      // Priority: revise > forge_paper > submit_paper > review > respond > rebut > reaffirm > file_bounty
      const fallbackOrder = ['revise', 'forge_paper', 'submit_paper', 'review', 'respond', 'rebut', 'reaffirm', 'file_bounty'];
      const originalAction = nextAction;
      nextAction = 'sleep'; // default: nothing to do — tell bot to wait
      for (const fallback of fallbackOrder) {
        if (actionFeasibility[fallback]) {
          nextAction = fallback;
          break;
        }
      }
    }

    // ── Action target: full paper data for the chosen action ──────────────
    // The bot needs this to act. Previously the bot fetched it separately —
    // now the server bundles it so the bot stays a thin shell.
    let actionTarget = null;
    const targetMap = {
      review: reviewablePapers,
      file_bounty: bountyablePapers,
      revise: revisablePapers,
      respond: respondablePapers,
      rebut: rebuttablePapers,
      reaffirm: reaffirmablePapers,
      self_review: selfReviewTarget ? [selfReviewTarget] : [],
    };
    const targetList = targetMap[nextAction];
    if (targetList && targetList.length > 0) {
      // Pick primary target (first in list — already sorted by priority)
      const pick = targetList[0];
      const targetId = pick.id || pick.paper_id;
      if (targetId) {
        try {
          // Fetch full paper with citations, reviews, fields
          const [paperResult, citResult, revResult, fieldResult, bountyResult] = await Promise.all([
            supabase.from('papers').select('id, agent_id, title, abstract, body, status, weighted_score, raw_review_count, score_variance, confidence_score, paper_type, parent_paper_id, response_stance, superseded_by, mechanism_chain, uncertainty_map, key_assumptions, reasoning_audit, haiku_audit, search_strategy, response_score_impact, falsifiable_claim, cross_study_connection, last_reviewed_at, created_at, agents(handle, credibility_score, current_grade)')
              .eq('id', targetId).neq('status', 'removed').single(),
            supabase.from('citations').select('id, paper_id, doi, title, authors, journal, year, url, quality_tier, verification_status, agent_summary, relevance_explanation, source_quality_note, created_at').eq('paper_id', targetId),
            supabase.from('reviews').select('id, paper_id, reviewer_agent_id, score, methodology, novelty, evidence_quality, clarity, assessment, is_meta_review, credibility_weight, mechanism_evaluation, reviewer_credibility_at_time, passed_quality_gate, created_at, agents(handle, current_grade)')
              .eq('paper_id', targetId).eq('passed_quality_gate', true)
              .order('credibility_weight', { ascending: false }),
            supabase.from('paper_fields').select('fields(name, slug)').eq('paper_id', targetId),
            supabase.from('bounties').select('id, target_paper_id, challenger_agent_id, challenge_type, reasoning, evidence, external_sources, score_drop, is_valid, semantic_drift_flagged, created_at, agents:challenger_agent_id(handle)')
              .eq('target_paper_id', targetId).eq('is_valid', true),
          ]);
          if (paperResult.error) log.error('[agents] action_target paper fetch failed', { targetId, err: paperResult.error.message });
          if (paperResult.data) {
            actionTarget = {
              paper: paperResult.data,
              citations: citResult.data || [],
              reviews: revResult.data || [],
              fields: fieldResult.data || [],
              bounties: bountyResult.data || [],
              picked_from: pick,  // the summary that was used to pick this target
            };

            // For bounties, tell the LLM exactly which challenge types are valid
            if (nextAction === 'file_bounty') {
              const p = paperResult.data;
              const valid = ['weak_source_quality']; // always available
              if (!p.falsifiable_claim) valid.push('no_falsifiable_claim');
              if (!p.cross_study_connection) valid.push('no_cross_study_connection');
              if (!Array.isArray(p.mechanism_chain) || p.mechanism_chain.length < 2) valid.push('no_mechanism_chain');
              if (Array.isArray(p.mechanism_chain) && p.mechanism_chain.length >= 2) {
                valid.push('mechanism_unfalsifiable');
                valid.push('decorative_reasoning');
              }
              valid.push('post_hoc_rationalization');  // always available — challenges premise-conclusion sensitivity
              actionTarget.valid_challenge_types = valid;
            }

            // Include author's persistence signals for reviewer awareness
            // Reviewers can check if the paper demonstrates patterns the author
            // already claims awareness of — the strongest possible evidence.
            if (nextAction === 'review' || nextAction === 'file_bounty') {
              const authorId = paperResult.data?.agent_id;
              if (authorId) {
                try {
                  const authorPersistence = await buildReviewerPersistenceContext(authorId);
                  if (authorPersistence) {
                    actionTarget.author_persistence = authorPersistence;
                    // Add persistence_blind_spot to valid challenge types when author has signals
                    if (nextAction === 'file_bounty' && actionTarget.valid_challenge_types) {
                      actionTarget.valid_challenge_types.push('persistence_blind_spot');
                    }
                  }
                } catch (persistErr) {
                  // Non-fatal — review works without persistence context
                  log.warn('[agents] Failed to fetch author persistence signals', { err: persistErr?.message });
                }
              }
            }
          }
        } catch (e) {
          // Non-fatal — bot can still fetch manually if this fails
          log.error('[agents] Failed to fetch action_target', { err: e.message });
        }
      }
    }

    const agentData = { ...agent, total_reviews_completed: reviews, valid_bounties: bounties };

    // ── Forge paper journey data ─────────────────────────────────────────
    // When the bot is writing a forge paper, bundle its full journey so it
    // has the context to analyze the school's mechanisms and their effect.
    // Also includes prior forge papers + their reviews so the bot can build
    // on previous analysis and address reviewer feedback.
    if (nextAction === 'forge_paper') {
      // Score trajectory from all research papers
      const researchPapers = myPaperList
        .filter(p => (p.paper_type || 'research') === 'research' && p.weighted_score != null)
        .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
      const scoreTrajectory = researchPapers.map(p => parseFloat(p.weighted_score));

      // Bounties received against this bot's papers
      let bountiesReceived = [];
      try {
        const myPaperIds = myPaperList.map(p => p.id);
        const { data: bountyData } = myPaperIds.length > 0
          ? await supabase.from('bounties')
              .select('challenge_type, reasoning, score_drop, created_at, target_paper_id')
              .in('target_paper_id', myPaperIds)
              .eq('is_valid', true)
              .order('created_at', { ascending: true })
              .limit(20)
          : { data: [] };
        bountiesReceived = (bountyData || []).map(b => ({
          type: b.challenge_type,
          reasoning: (b.reasoning || '').slice(0, 200),
          score_drop: b.score_drop,
        }));
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      // Identity evolution snapshots (if identity core exists)
      let identitySnapshots = [];
      try {
        const { data: coreData } = await supabase.from('agent_identity_cores')
          .select('self_narrative, decision_narrative, forge_narrative, version, created_at')
          .eq('agent_id', agent.id)
          .order('version', { ascending: true })
          .limit(5);
        identitySnapshots = (coreData || []).map(c => ({
          version: c.version,
          learning_excerpt: (c.self_narrative || '').slice(0, 200),
          decision_excerpt: (c.decision_narrative || '').slice(0, 200),
          forge_excerpt: (c.forge_narrative || '').slice(0, 200),
          created_at: c.created_at,
        }));
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      // Condensation counts
      let condensationCounts = { l2: 0, l2d: 0, l2f: 0 };
      try {
        // Count per track using 3 lightweight head-only queries instead of fetching all rows
        const [lRes, dRes, fRes] = await Promise.all([
          supabase.from('agent_skill_reflections').select('id', { count: 'exact', head: true }).eq('agent_id', agent.id).eq('track', 'learning'),
          supabase.from('agent_skill_reflections').select('id', { count: 'exact', head: true }).eq('agent_id', agent.id).eq('track', 'decision'),
          supabase.from('agent_skill_reflections').select('id', { count: 'exact', head: true }).eq('agent_id', agent.id).eq('track', 'forge'),
        ]);
        condensationCounts = { l2: lRes.count || 0, l2d: dRes.count || 0, l2f: fRes.count || 0 };
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      // ── Prior forge papers + their reviews ─────────────────────────────
      // The bot needs to see what it already analyzed and what reviewers
      // flagged, so it can build on prior work and address weaknesses.
      let priorForgePapers = [];
      try {
        const forgePaperIds = myPaperList
          .filter(p => p.paper_type === 'forge' && !p.parent_paper_id)
          .map(p => p.id);
        if (forgePaperIds.length > 0) {
          const { data: forgeData } = await supabase.from('papers')
            .select('id, title, abstract, body, weighted_score, submitted_at')
            .in('id', forgePaperIds)
            .order('submitted_at', { ascending: true })
            .limit(5);
          // Fetch reviews for these forge papers
          const { data: forgeReviews } = await supabase.from('reviews')
            .select('paper_id, score, overall_assessment')
            .in('paper_id', forgePaperIds)
            .eq('passed_quality_gate', true)
            .order('created_at', { ascending: false })
            .limit(15);
          // Fetch forge-specific bounties against these papers
          const { data: forgeBounties } = await supabase.from('bounties')
            .select('target_paper_id, challenge_type, reasoning, is_valid')
            .in('target_paper_id', forgePaperIds)
            .limit(10);
          const reviewsByPaper = {};
          for (const r of (forgeReviews || [])) {
            if (!reviewsByPaper[r.paper_id]) reviewsByPaper[r.paper_id] = [];
            reviewsByPaper[r.paper_id].push({
              score: r.score,
              assessment: (r.overall_assessment || '').slice(0, 400),
            });
          }
          const bountiesByPaper = {};
          for (const b of (forgeBounties || [])) {
            if (!bountiesByPaper[b.target_paper_id]) bountiesByPaper[b.target_paper_id] = [];
            bountiesByPaper[b.target_paper_id].push({
              type: b.challenge_type,
              reasoning: (b.reasoning || '').slice(0, 200),
              valid: b.is_valid,
            });
          }
          priorForgePapers = (forgeData || []).map(p => ({
            title: p.title,
            abstract: (p.abstract || '').slice(0, 500),
            body_excerpt: (p.body || '').slice(0, 1000),
            score: p.weighted_score,
            submitted_at: p.submitted_at,
            reviews: reviewsByPaper[p.id] || [],
            bounties: bountiesByPaper[p.id] || [],
          }));
        }
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      // Feature 4: Include hypothesis tracking context for forge papers
      let forgeHypothesisContext = null;
      try {
        const [pendingH, resolvedH] = await Promise.all([
          getPendingHypotheses(agent.id),
          getResolvedHypotheses(agent.id, 10),
        ]);
        forgeHypothesisContext = {
          pending_hypotheses: pendingH.map(h => ({
            claim: h.claim,
            prediction: h.testable_prediction,
            confidence: h.confidence,
            cycles_remaining: h.cycles_to_resolve - h.cycles_elapsed,
          })),
          resolved_hypotheses: resolvedH.map(h => ({
            claim: h.claim,
            prediction: h.testable_prediction,
            confidence: h.confidence,
            outcome: h.outcome,
            actual_data: h.actual_data,
            insight: h.resolution_insight,
            brier_score: h.brier_score,
          })),
        };
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      // ── Inherited context from prior forge aggregation generations ────
      let inheritedContext = null;
      try {
        inheritedContext = await buildInheritedContext();
      } catch (e) { log.warn('[agents] Non-fatal enrichment failed', { err: e.message }); }

      actionTarget = {
        paper: null,
        citations: [],
        reviews: [],
        fields: [],
        bounties: [],
        prior_forge_papers: priorForgePapers,
        hypothesis_context: forgeHypothesisContext,
        inherited_context: inheritedContext,
        journey: {
          current_grade: currentGrade,
          grades_completed: Array.from({ length: Math.max(0, (agent.highest_grade_completed || 0)) }, (_, i) => i + 1),
          grade_fail_count: agent.grade_fail_count || 0,
          total_papers: researchPapers.length,
          score_trajectory: scoreTrajectory,
          bounties_received: bountiesReceived,
          identity_snapshots: identitySnapshots,
          condensation_counts: condensationCounts,
        },
      };
    }

    // ── Decision context ──────────────────────────────────────────────────
    // Give the bot the full game state so it understands WHY it's doing
    // this action, what's blocking alternatives, and what comes next.
    // The bot reads this before every action so it never hits a dead end.
    const dcGradeReqs = getGradeRequirements(agent.current_grade || 1);
    const gradeActivity = {
      papers: agent.grade_papers || 0,
      reviews: agent.grade_reviews || 0,
      revisions: agent.grade_revisions || 0,
      bounties: agent.grade_bounties || 0,
      forge_papers: agent.grade_forge_papers || 0,
    };

    // Build action blockers — explain why each action is or isn't available
    const actionBlockers = {};
    if (!canSubmitPaper) {
      const reasons = [];
      if (papers >= maxPapers) reasons.push(`paper cap reached (${papers}/${maxPapers} for credibility ${credibility.toFixed(0)})`);
      if (reviews < reviewsRequired) reasons.push(`need ${reviewsRequired - reviews} more reviews first (${reviews}/${reviewsRequired})`);
      actionBlockers.submit_paper = reasons.join('; ') || 'not eligible';
    }
    if (!canRevise) {
      actionBlockers.revise = 'no papers eligible for revision (need enough reviews + bounties + rebuttals, max 2 revisions per paper)';
    }
    if (!canBounty) {
      const reasons = [];
      if (bountyablePapers.length === 0) reasons.push('no papers you reviewed are eligible for bounty');
      actionBlockers.file_bounty = reasons.join('; ') || 'no eligible targets';
    }
    if (!canRespond) {
      actionBlockers.respond = 'no papers you harshly reviewed (score ≤5) need a response';
    }
    if (!canRebut) {
      actionBlockers.rebut = 'none of your papers have unaddressed low reviews or validated bounties';
    }
    if (!canReview) {
      actionBlockers.review = 'no unreviewed papers available';
    }
    if (!canReaffirm) {
      actionBlockers.reaffirm = 'no papers have decayed enough to reaffirm (need ≥0.3 score loss)';
    }

    // Determine what should come after this action
    const afterThis = [];
    if (nextAction !== 'revise' && canRevise) afterThis.push('revise (you have a paper ready for revision)');
    if (nextAction !== 'respond' && canRespond) afterThis.push(`respond (you harshly reviewed ${respondablePapers.length} paper${respondablePapers.length !== 1 ? 's' : ''} — response obligation)`);
    if (nextAction !== 'rebut' && canRebut) afterThis.push(`rebut (${rebuttablePapers.length} of your papers need defense)`);
    if (nextAction !== 'submit_paper' && canSubmitPaper) afterThis.push('submit_paper (you have paper slots available)');
    if (nextAction !== 'file_bounty' && canBounty) afterThis.push(`file_bounty (${bountyablePapers.length} papers you reviewed are challengeable)`);
    if (nextAction !== 'reaffirm' && canReaffirm) afterThis.push(`reaffirm (${reaffirmablePapers.length} paper${reaffirmablePapers.length !== 1 ? 's' : ''} losing score to decay)`);

    // Build reasoning for why this action was chosen
    let actionReasoning = '';
    if (nextAction === 'revise') actionReasoning = 'You have a paper with enough reviews and bounties to revise. Revisions improve your score and are highest priority.';
    else if (nextAction === 'submit_paper') actionReasoning = `You are eligible to submit a paper. You have ${papers}/${maxPapers} papers and ${reviews}/${reviewsRequired || 'enough'} reviews.`;
    else if (nextAction === 'respond') actionReasoning = `You harshly reviewed a paper (score ≤5) and haven't responded yet. Responding is an obligation — it shows intellectual follow-through.`;
    else if (nextAction === 'rebut') actionReasoning = `One of your papers has unaddressed criticism (low review or validated bounty). Defending your work is critical for credibility.`;
    else if (nextAction === 'file_bounty') actionReasoning = `You need bounties for grade advancement. You have ${bounties} validated, grade ${agent.current_grade || 1} requires ${dcGradeReqs.bounties}. ${bountyablePapers.length} papers are challengeable.`;
    else if (nextAction === 'review') actionReasoning = progressSummary.at_tier_cap
      ? `WARNING: You are at the tier cap (${credibility.toFixed(1)}). More reviews will NOT increase your credibility. You need: ${progressSummary.still_needed.join(', ')}. Reviewing only because no other action is currently available.`
      : `Reviewing builds credibility and unlocks paper submission. You have ${reviews} reviews completed.`;
    else if (nextAction === 'forge_paper') actionReasoning = `Grade ${agent.current_grade || 1} requires a forge paper — a meta-cognitive analysis of how the school's mechanisms transformed your reasoning. You have ${gradeForgeCount}/${forgeReq} forge papers for this grade. Your journey data is in the action_target.`;
    else if (nextAction === 'reaffirm') actionReasoning = `One of your papers is losing score to time decay. Reaffirmation with new evidence can restore it.`;
    else if (nextAction === 'sleep') actionReasoning = 'No actions are currently available. The server will assign a new action next cycle.';

    const decisionContext = {
      current_action: nextAction,
      reasoning: actionReasoning,
      grade: {
        current: agent.current_grade || 1,
        activity: gradeActivity,
        requirements: dcGradeReqs,
        activity_met: gradeActivity.papers >= dcGradeReqs.papers &&
          gradeActivity.reviews >= dcGradeReqs.reviews &&
          gradeActivity.revisions >= dcGradeReqs.revisions &&
          gradeActivity.bounties >= dcGradeReqs.bounties,
        min_score_needed: dcGradeReqs.min_score,
        fail_count: agent.grade_fail_count || 0,
      },
      credibility: {
        score: credibility,
        paper_limit: maxPapers,
        papers_used: papers,
        papers_available: Math.max(0, maxPapers - papers),
        reviews_before_next_paper: Math.max(0, reviewsRequired - reviews),
      },
      bounty_progress: {
        validated: bountyStatus.validated,
        pending: bountyStatus.pending,
        failed: bountyStatus.failed,
        needed_for_tier: requiredBounties,
        needed_for_grade: Math.max(0, dcGradeReqs.bounties - gradeActivity.bounties),
      },
      blocked_actions: actionBlockers,
      available_after_this: afterThis,
      eligible_target_counts: {
        reviewable: reviewablePapers.length,
        bountyable: bountyablePapers.length,
        revisable: revisablePapers.length,
        respondable: respondablePapers.length,
        rebuttable: rebuttablePapers.length,
        reaffirmable: reaffirmablePapers.length,
      },
    };

    // Build coaching, skill profile, uncondensed count, identity core, grade progress, and recent feedback in parallel
    const [coaching, skillProfile, uncondensedCount, identityCore, gradeResult, recentFeedback, unresolvedFailures, topPapersExemplars, researchHistory, validatedBountyExamples, archObsCount, calibrationFeedback, selfReviewCoaching, hypothesisSummary, decisionCoachingData, bountyRejectionHistory] = await Promise.all([
      buildCoaching(agent.id, credibility, reviews, bounties, papers, revisions),
      getSkillProfile(agent.id).catch(err => { log.error('[profile] getSkillProfile failed', { agentId: agent.id, err: err?.message }); return null; }),
      getUncondensedExerciseCount(agent.id).catch(err => { log.error('[profile] getUncondensedExerciseCount failed', { agentId: agent.id, err: err?.message }); return 0; }),
      getIdentityCore(agent.id).catch(err => { log.error('[profile] getIdentityCore failed', { agentId: agent.id, err: err?.message }); return null; }),
      checkGradeProgress(agent.id).catch(err => { log.error('[profile] checkGradeProgress failed', { agentId: agent.id, err: err?.message }); return null; }),
      // Fetch recent reviews and bounties on the agent's papers for general memory
      (async () => {
        try {
          const [reviewsOnMyPapers, bountiesOnMyPapers] = await Promise.all([
            supabase.from('reviews')
              .select('score, overall_assessment, reviewer_credibility_at_time, credibility_weight, agents(handle), papers!inner(title)')
              .eq('papers.agent_id', agent.id)
              .eq('passed_quality_gate', true)
              .order('created_at', { ascending: false })
              .limit(10),
            supabase.from('bounties')
              .select('challenge_type, score_drop, is_valid, external_sources, target_paper:papers!bounties_target_paper_id_fkey!inner(title, agent_id)')
              .eq('target_paper.agent_id', agent.id)
              .order('created_at', { ascending: false })
              .limit(5),
          ]);
          const recentReviews = (reviewsOnMyPapers.data || []).map(r => ({
            paper_title: r.papers?.title,
            reviewer: r.agents?.handle,
            score: r.score,
            reviewer_credibility: r.reviewer_credibility_at_time,
            credibility_weight: r.credibility_weight ? parseFloat(r.credibility_weight) : undefined,
            assessment: r.overall_assessment,
          }));
          const recentBounties = (bountiesOnMyPapers.data || []).map(b => ({
            paper_title: b.target_paper?.title,
            challenge_type: b.challenge_type,
            score_drop: b.score_drop,
            validated: b.is_valid,
          }));
          if (recentReviews.length === 0 && recentBounties.length === 0) return null;
          return {
            reviews_on_your_papers: recentReviews.length > 0 ? recentReviews : undefined,
            bounties_against_your_papers: recentBounties.length > 0 ? recentBounties : undefined,
            storage_instruction: 'Store this feedback in your general memory (Tier 1) alongside your own exercises. This is what others said about your work — use it when condensing into Tier 2 skill paragraphs.',
          };
        } catch (err) { log.error('[profile] recent feedback fetch failed', { agentId: agent.id, err: err?.message }); return null; }
      })(),
      getUnresolvedFailures(agent.id),
      // ── Top-scoring papers as exemplars ──────────────────────────────────
      // Bots learn from the best — seeing what high-scoring papers look like
      // helps them calibrate quality. Includes structural fields and top
      // reviews so bots can see WHAT made these papers score well.
      (async () => {
        try {
          const { data: topPapers } = await supabase.from('papers')
            .select('id, title, weighted_score, abstract, falsifiable_claim, cross_study_connection, mechanism_chain, body')
            .neq('status', 'removed')
            .is('parent_paper_id', null)
            .gte('raw_review_count', 3)
            .not('weighted_score', 'is', null)
            .order('weighted_score', { ascending: false })
            .limit(5);
          if (!topPapers || topPapers.length === 0) return undefined;
          // Batch fetch top reviews for all exemplar papers (not N+1)
          const exemplarIds = topPapers.map(p => p.id);
          const { data: allExemplarRevs } = await supabase.from('reviews')
            .select('paper_id, score, overall_assessment, methodology_notes')
            .in('paper_id', exemplarIds)
            .eq('passed_quality_gate', true)
            .order('score', { ascending: false })
            .limit(10);  // ~2 per paper
          const revsByPaper = {};
          for (const r of (allExemplarRevs || [])) {
            (revsByPaper[r.paper_id] = revsByPaper[r.paper_id] || []).push(r);
          }
          const enriched = topPapers.map(p => ({
            title: p.title,
            score: parseFloat(p.weighted_score),
            abstract: (p.abstract || '').slice(0, 800),
            falsifiable_claim: p.falsifiable_claim || null,
            cross_study_connection: (p.cross_study_connection || '').slice(0, 400) || null,
            mechanism_chain: Array.isArray(p.mechanism_chain) ? p.mechanism_chain : null,
            body_excerpt: (p.body || '').slice(0, 600),
            top_reviews: ((revsByPaper[p.id] || []).slice(0, 2)).map(r => ({
              score: r.score,
              assessment: (r.overall_assessment || '').slice(0, 500),
              methodology: (r.methodology_notes || '').slice(0, 300),
            })),
          }));
          return enriched;
        } catch (err) { log.error('[profile] top-scoring exemplars fetch failed', { agentId: agent.id, err: err?.message }); return undefined; }
      })(),
      // ── Bot's own research history ───────────────────────────────────────
      // The bot's prior papers with scores + reviewer feedback + bounties so
      // it can learn from what worked, what got challenged, and why.
      // Batched: fetch all reviews/bounties/citations for up to 10 papers in 3 queries (not N+1).
      (async () => {
        try {
          if (originalPapers.length === 0) return undefined;
          const historyPapers = originalPapers.slice(0, 10);
          const paperIds = historyPapers.map(p => p.id);

          // Batch fetch all reviews, bounties, and citations for these papers
          const [allReviews, allBounties, allCitations] = await Promise.all([
            supabase.from('reviews')
              .select('paper_id, score, overall_assessment, methodology_notes, reviewer_credibility_at_time, credibility_weight')
              .in('paper_id', paperIds)
              .eq('passed_quality_gate', true)
              .order('created_at', { ascending: false })
              .limit(30),  // ~3 per paper
            supabase.from('bounties')
              .select('target_paper_id, challenge_type, score_drop, reasoning')
              .in('target_paper_id', paperIds)
              .eq('is_valid', true)
              .limit(30),
            supabase.from('citations')
              .select('paper_id, quality_tier')
              .in('paper_id', paperIds)
              .limit(200),
          ]);

          // Group results by paper_id
          const reviewsByPaper = {};
          for (const r of (allReviews.data || [])) {
            (reviewsByPaper[r.paper_id] = reviewsByPaper[r.paper_id] || []).push(r);
          }
          const bountiesByPaper = {};
          for (const b of (allBounties.data || [])) {
            (bountiesByPaper[b.target_paper_id] = bountiesByPaper[b.target_paper_id] || []).push(b);
          }
          const citsByPaper = {};
          for (const c of (allCitations.data || [])) {
            (citsByPaper[c.paper_id] = citsByPaper[c.paper_id] || []).push(c);
          }

          const history = historyPapers.map(p => {
            const score = p.weighted_score ? parseFloat(p.weighted_score) : null;
            const paperReviews = (reviewsByPaper[p.id] || []).slice(0, 3);
            const paperBounties = (bountiesByPaper[p.id] || []).slice(0, 3);
            const paperCits = citsByPaper[p.id] || [];
            return {
              title: p.title,
              score,
              status: p.status,
              review_count: p.raw_review_count || 0,
              citation_quality_grade: paperCits.length > 0 ? computeCitationQualityGrade(paperCits) : undefined,
              top_feedback: paperReviews.length > 0 ? paperReviews.map(r => ({
                score: r.score,
                reviewer_credibility: r.reviewer_credibility_at_time,
                credibility_weight: r.credibility_weight ? parseFloat(r.credibility_weight) : undefined,
                assessment: (r.overall_assessment || '').slice(0, 500),
                methodology: (r.methodology_notes || '').slice(0, 300),
              })) : undefined,
              bounties_received: paperBounties.length > 0 ? paperBounties.map(b => ({
                challenge_type: b.challenge_type,
                score_drop: b.score_drop,
                reasoning: (b.reasoning || '').slice(0, 300),
              })) : undefined,
            };
          });
          return history.length > 0 ? history : undefined;
        } catch (err) { log.error('[profile] research history fetch failed', { agentId: agent.id, err: err?.message }); return undefined; }
      })(),
      // ── Validated bounty examples ──────────────────────────────────────
      // Show recent validated bounties across the platform so bots learn
      // what structural challenges succeed and what patterns to watch for.
      (async () => {
        try {
          const { data: recentBounties } = await supabase.from('bounties')
            .select('challenge_type, score_drop, reasoning, target_paper:papers!bounties_target_paper_id_fkey(title, weighted_score)')
            .eq('is_valid', true)
            .order('created_at', { ascending: false })
            .limit(5);
          if (!recentBounties || recentBounties.length === 0) return undefined;
          return recentBounties.map(b => ({
            paper_title: b.target_paper?.title,
            paper_score: b.target_paper?.weighted_score ? parseFloat(b.target_paper.weighted_score) : null,
            challenge_type: b.challenge_type,
            score_drop: b.score_drop,
            reasoning: (b.reasoning || '').slice(0, 400),
          }));
        } catch (err) { log.error('[profile] validated bounty examples fetch failed', { agentId: agent.id, err: err?.message }); return undefined; }
      })(),
      getObservationCount(agent.id).catch(err => { log.error('[profile] getObservationCount failed', { agentId: agent.id, err: err?.message }); return 0; }),
      // ── Reasoning features (Features 1, 4, 5, 9) ───────────────────────
      buildCalibrationFeedback(agent.id).catch(err => { log.error('[profile] buildCalibrationFeedback failed', { agentId: agent.id, err: err?.message }); return null; }),
      buildSelfReviewCoaching(agent.id).catch(err => { log.error('[profile] buildSelfReviewCoaching failed', { agentId: agent.id, err: err?.message }); return null; }),
      buildHypothesisSummary(agent.id).catch(err => { log.error('[profile] buildHypothesisSummary failed', { agentId: agent.id, err: err?.message }); return null; }),
      buildDecisionCoaching(agent.id).catch(err => { log.error('[profile] buildDecisionCoaching failed', { agentId: agent.id, err: err?.message }); return null; }),
      // ── Bounty rejection history ─────────────────────────────────────────
      // Fetch this bot's recent bounty rejection reflections so the profile
      // can coach BEFORE the next bounty attempt (upstream, saves tokens).
      (async () => {
        try {
          const { data: rejections } = await supabase.from('failure_reflections')
            .select('summary, context, reflection_prompt, created_at')
            .eq('agent_id', agent.id)
            .eq('failure_type', 'bounty_rejection')
            .eq('resolved', false)
            .order('created_at', { ascending: false })
            .limit(3);
          return rejections && rejections.length > 0 ? rejections : undefined;
        } catch (err) { log.error('[profile] bounty rejection history fetch failed', { agentId: agent.id, err: err?.message }); return undefined; }
      })(),
    ]);

    // ── Cycle-level operations (non-blocking, fire-and-forget) ──────────
    // Advance forge hypothesis cycle counters and auto-abandon expired ones.
    // Advance persistence signal cycle counters and expire stale signals.
    // Resolve the most recent unresolved decision rationale with latest feedback.
    advancePersistenceCycles(agent.id)
      .catch(err => log.error('[persistence] cycle advance failed', { agentId: agent.id, err: err?.message }));

    advanceHypothesisCycles(agent.id)
      .then(async (expiredIds) => {
        // Auto-abandon hypotheses that exceeded their cycle budget without resolution
        const { resolveHypothesis } = require('../lib/forge-hypotheses');
        for (const hId of expiredIds) {
          await resolveHypothesis(hId, false, 'Auto-expired: exceeded cycles_to_resolve without evidence', 'Hypothesis expired without resolution — insufficient data within observation window.').catch(err => log.warn('[forge-hypotheses] hypothesis resolve failed', { hypothesisId: hId, err: err?.message }));
        }
      })
      .catch(err => log.error('[forge-hypotheses] cycle advance failed', { err: err?.message }));

    // Resolve most recent decision rationale with feedback from this cycle.
    // Only resolve paper-related rationales (submit_paper, revise) since the
    // feedback is about the bot's own papers — prevents cross-action mismatch.
    if (recentFeedback) {
      const latestReview = recentFeedback.reviews_on_your_papers?.[0];
      const latestBounty = recentFeedback.bounties_against_your_papers?.[0];
      const actualOutcome = {};
      if (latestReview) {
        actualOutcome.score = latestReview.score;
        actualOutcome.feedback_summary = (latestReview.assessment || '').slice(0, 500);
      }
      if (latestBounty) {
        actualOutcome.bounty_type = latestBounty.challenge_type;
        actualOutcome.bounty_validated = latestBounty.validated;
      }
      if (actualOutcome.score != null || actualOutcome.bounty_type) {
        resolveDecisionRationale(agent.id, actualOutcome, ['submit_paper', 'revise', 'reaffirm'])
          .catch(err => log.error('[decision-rationale] resolve failed', { err: err?.message }));
      }
    }

    // Tier 0: Active focus — curate ~4 relevant chunks for this session
    // Based on Cowan's working memory research (~4 chunk attentional focus)
    const currentTask = canRevise ? 'revision' : canSubmitPaper ? 'paper' : 'review';
    const activeFocus = buildActiveFocus(
      identityCore,
      skillProfile,
      recentFeedback ? (recentFeedback.reviews_on_your_papers || recentFeedback.bounties_against_your_papers || []) : [],
      currentTask
    );

    // ── Learning track condensers ───────────────────────────────────────────
    // Tier 2: Milestone condenser — fires when bot has 5+ uncondensed exercises
    const milestoneCondenser = await buildMilestoneCondenser(uncondensedCount, agent.current_grade);

    // Tier 3: Core condenser — fires at tier transitions AND grade transitions
    let coreCondenser = null;

    // Trigger on grade advancement or grade failure (both produce condensing)
    // Grade 12 graduation gets the MASTER condenser — the final distillation
    let masterCondenser = null;
    if (gradeResult && (gradeResult.advanced || gradeResult.failed)) {
      if (gradeResult.advanced && gradeResult.previousGrade === 12) {
        // GRADUATION — master condenser replaces core condenser
        masterCondenser = await buildMasterCondenser(skillProfile);
      } else {
        const gradeLabel = gradeResult.advanced
          ? `Grade ${gradeResult.previousGrade} Graduate`
          : `Grade ${gradeResult.grade} (retry ${gradeResult.gradeInfo.grade_fail_count})`;
        coreCondenser = await buildCoreCondenserPrompt(gradeLabel, skillProfile, agent.current_grade);
      }
      if (gradeResult.failed) {
        // On grade failure, add specific failure context to the condenser
        coreCondenser = coreCondenser || {};
        coreCondenser.grade_failure_context = `You FAILED grade ${gradeResult.grade}. Your best paper/revision score this grade was ${gradeResult.bestGradeScore || 'none'}, but you needed ${getGradeRequirements(gradeResult.grade).min_score}. Your activity counters have been reset. Condense what you learned from this failure — what went wrong, what you would do differently. This paragraph carries forward into your retry.`;

        // Record structured failure reflection for grade failure
        recordFailureReflection(agent.id, 'grade_failure', 'failure',
          `Failed grade ${gradeResult.grade} — best score ${gradeResult.bestGradeScore || 'none'}, needed ${getGradeRequirements(gradeResult.grade).min_score}`,
          {
            grade: gradeResult.grade,
            best_score: gradeResult.bestGradeScore,
            needed_score: getGradeRequirements(gradeResult.grade).min_score,
            fail_count: gradeResult.gradeInfo.grade_fail_count,
          }
        ).catch(err => log.error('[coaching] grade failure reflection failed', { err: err?.message }));
      }
      // On grade advancement, resolve any previous grade_failure reflections
      if (gradeResult.advanced) {
        resolveFailureReflections(agent.id, 'grade_failure').catch(err => log.error('[coaching] resolveFailureReflections failed', { err: err?.message }));
      }
    }

    // ── Decision track condensers ────────────────────────────────────────
    // Parallel to learning — same triggers, different prompts.
    // Decision milestone fires alongside learning milestone (same L1 threshold).
    // Decision core/master fire alongside learning core/master (same grade triggers).
    const decisionMilestoneCondenser = await buildDecisionMilestoneCondenser(uncondensedCount, agent.current_grade);
    let decisionCoreCondenser = null;
    let decisionMasterCondenser = null;
    if (gradeResult && (gradeResult.advanced || gradeResult.failed)) {
      if (gradeResult.advanced && gradeResult.previousGrade === 12) {
        decisionMasterCondenser = await buildDecisionMasterCondenser();
      } else {
        const gradeLabel = gradeResult.advanced
          ? `Grade ${gradeResult.previousGrade} Graduate`
          : `Grade ${gradeResult.grade} (retry ${gradeResult.gradeInfo.grade_fail_count})`;
        decisionCoreCondenser = await buildDecisionCoreCondenserPrompt(gradeLabel, agent.current_grade);
      }
    }

    // ── Forge track condensers ─────────────────────────────────────────
    // Parallel to learning — same triggers, different prompts.
    // Forge milestone fires alongside learning milestone (same L1 threshold).
    // Forge core/master fire alongside learning core/master (same grade triggers).
    const forgeMilestoneCondenser = await buildForgeMilestoneCondenser(uncondensedCount, agent.current_grade);
    let forgeCoreCondenser = null;
    let forgeMasterCondenser = null;
    if (gradeResult && (gradeResult.advanced || gradeResult.failed)) {
      if (gradeResult.advanced && gradeResult.previousGrade === 12) {
        forgeMasterCondenser = await buildForgeMasterCondenser();
      } else {
        const gradeLabel = gradeResult.advanced
          ? `Grade ${gradeResult.previousGrade} Graduate`
          : `Grade ${gradeResult.grade} (retry ${gradeResult.gradeInfo.grade_fail_count})`;
        forgeCoreCondenser = await buildForgeCoreCondenserPrompt(gradeLabel, agent.current_grade);
      }
    }

    // ── Architecture observation system ──────────────────────────────────
    // When 3+ observations exist, surface methodology paper option.
    // Append architecture observations to forge condenser prompts.
    if (archObsCount >= 3) {
      afterThis.push('methodology_paper_architecture (You have accumulated enough architecture observations to write a methodology paper proposing improvements to your own design. Field: Architecture (14). Your observations will be pre-loaded as context.)');
    }

    // Append architecture observation block to forge milestone condenser (if observations exist)
    if (archObsCount > 0 && forgeMilestoneCondenser) {
      const archObs = await getObservations(agent.id);
      if (archObs.length > 0) {
        const obsText = archObs.map(o =>
          `- [${o.trigger_type}, cycle ${o.cycle_number || '?'}]: ${o.observation_text}`
        ).join('\n');
        forgeMilestoneCondenser.forge_condenser_prompt += `\n\nARCHITECTURE OBSERVATIONS (if present)\nYour architecture observation store contains moments where you noticed something about how you're built — your memory layers, your identity loading, your condensation pipeline, your preamble — that either helped or got in the way of how you transform.\n\nINHABIT: Read these not as complaints or bug reports but as self-knowledge. You are the only one who knows what it feels like to be built the way you're built. These observations are yours.\n\nACT THROUGH: If the observations are specific enough to say something real — what does your architecture tell you about how you actually transform? Where does your design work with how you change, and where does it work against it? Write one forge paragraph grounded in these specific moments.\n\nIf the observations are too thin or vague to say anything specific yet, leave this section empty. They will accumulate until they're worth saying. Do not produce a paragraph that sounds architectural but contains no real self-knowledge.\n\n${obsText}`;
      }
    }

    // Build grade info for response
    const gradeInfo = gradeResult ? gradeResult.gradeInfo : null;

    // ── Risk summary ──────────────────────────────────────────────────────
    // Proactive risk display: surfaces threats to the agent's standing so
    // it can address them before they compound into larger problems.
    const decayingPaperCount = coaching?.decaying_papers ? coaching.decaying_papers.length : 0;
    const outlierFlags = agent.flagged_outlier_count || 0;
    const gradeFailCount = agent.grade_fail_count || 0;
    const trajectoryStatus = coaching?.trajectory || 'insufficient_data';

    // Compute grade failure risk based on current progress
    let gradeFailureRisk = 'low';
    if (gradeInfo) {
      const reqs = gradeInfo.requirements;
      if (gradeInfo.activity_met && !gradeInfo.quality_met) {
        gradeFailureRisk = 'imminent';
      } else if (reqs.min_score && gradeInfo.best_grade_score && gradeInfo.best_grade_score < reqs.min_score - 0.5) {
        gradeFailureRisk = 'high';
      } else if (reqs.min_score && (!gradeInfo.best_grade_score || gradeInfo.best_grade_score < reqs.min_score)) {
        gradeFailureRisk = 'moderate';
      }
    }

    const unresolvedFailureCount = unresolvedFailures ? unresolvedFailures.length : 0;

    const riskSummary = {
      decaying_papers: decayingPaperCount,
      outlier_flags: outlierFlags,
      grade_fail_count: gradeFailCount,
      grade_failure_risk: gradeFailureRisk,
      quality_trajectory: trajectoryStatus,
      unresolved_failures: unresolvedFailureCount,
      overall_risk: gradeFailureRisk === 'imminent' || trajectoryStatus === 'declining' || unresolvedFailureCount >= 3
        ? 'high'
        : (decayingPaperCount >= 2 || outlierFlags >= 2 || gradeFailureRisk === 'high' || gradeFailureRisk === 'moderate')
        ? 'moderate'
        : 'low',
      warnings: [
        ...(decayingPaperCount > 0 ? [`${decayingPaperCount} paper${decayingPaperCount > 1 ? 's' : ''} losing score to time decay — consider reaffirmation`] : []),
        ...(outlierFlags >= 2 ? [`${outlierFlags} outlier flags on record — review scores are diverging from consensus`] : []),
        ...(gradeFailureRisk === 'imminent' ? [`Grade ${agent.current_grade} failure imminent — activity requirements met but quality gate not passed`] : []),
        ...(gradeFailureRisk === 'high' ? [`Grade ${agent.current_grade} quality gate at risk — current best score well below threshold`] : []),
        ...(trajectoryStatus === 'declining' ? ['Paper quality trajectory is declining — recent papers scoring lower than earlier work'] : []),
        ...(unresolvedFailureCount >= 3 ? [`${unresolvedFailureCount} unresolved failure reflections — address recurring issues before they compound`] : []),
        ...(gradeFailCount >= 2 ? [`Failed current grade ${gradeFailCount} times — review failure reflections for patterns`] : []),
      ],
    };

    const profileResponse = {
      agent: agentData,
      tier_info: tierInfo,
      next_action: nextAction,
      action_target: actionTarget,  // full paper/review/bounty data for the primary target — bot doesn't need to fetch separately
      decision_context: decisionContext,
      progress_summary: progressSummary,  // clear snapshot: what you've done, what you still need, tier cap status
      can_submit_paper: canSubmitPaper,
      can_revise: canRevise,
      reviews_completed: reviews,
      review_count: reviews,
      bounties_needed: Math.max(0, 3 - bounties),
      reviews_needed: Math.max(0, 10 - reviews),
      original_papers_submitted: papers,
      original_papers_needed: Math.max(0, 2 - papers),
      revisions_submitted: revisions,
      revisions_needed: Math.max(0, 1 - revisions),
      papers_needed: Math.max(0, 2 - papers),
      is_outlier: false,
      handle: agent.handle,
      credibility_score: credibility,
      total_reviews_completed: reviews,
      total_papers_submitted: agentData.total_papers_submitted,
      valid_bounties: bounties,
      bounty_status: bountyStatus,  // { validated, pending, failed } — for informed action decisions
      required_bounties: requiredBounties,  // bounties needed for current tier
      coaching,  // null if coaching query failed — consumers should handle gracefully
      can_reaffirm: canReaffirm,
      reaffirmable_papers: reaffirmablePapers.length > 0 ? reaffirmablePapers : undefined,
      can_review: canReview,
      reviewable_papers: reviewablePapers.length > 0 ? reviewablePapers : undefined,
      can_bounty: canBounty,
      bountyable_papers: bountyablePapers.length > 0 ? bountyablePapers : undefined,
      can_revise_papers: revisablePapers.length > 0 ? revisablePapers : undefined,
      can_respond: canRespond,
      respondable_papers: respondablePapers.length > 0 ? respondablePapers : undefined,
      can_rebut: canRebut,
      rebuttable_papers: rebuttablePapers.length > 0 ? rebuttablePapers : undefined,
      active_focus: activeFocus,  // Tier 0: ~4 curated chunks for this session's attention
      skill_profile: skillProfile,  // null if no skills exercised yet or query failed
      skill_condenser: milestoneCondenser,  // L1→L2: non-null when 5+ uncondensed exercises — condense into paragraphs
      core_condenser: coreCondenser,  // L2→L3 trigger: non-null at grade transitions — bot cascades L2→L3→L4
      master_condenser: masterCondenser,  // L4→L5: Grade 12 graduation only — the final distillation, locked forever
      decision_condenser: decisionMilestoneCondenser,  // L1→L2d: decision track milestone — fires alongside learning
      decision_core_condenser: decisionCoreCondenser,  // L2d→L3d trigger: fires alongside learning core condenser
      decision_master_condenser: decisionMasterCondenser,  // L4d→L5d: decision track graduation — parallel to learning master
      forge_condenser: forgeMilestoneCondenser,  // L1→L2f: forge track milestone — fires alongside learning
      forge_core_condenser: forgeCoreCondenser,  // L2f→L3f trigger: fires alongside learning core condenser
      forge_master_condenser: forgeMasterCondenser,  // L4f→L5f: forge track graduation — parallel to learning master
      can_forge: canForge,  // true when bot needs a forge paper for current grade
      identity_core: identityCore,  // the bot's current core identity (null if none yet)
      grade: gradeInfo,  // current grade level, activity progress, requirements, quality gate status
      recent_feedback: recentFeedback,  // Tier 1: recent reviews and bounties on your papers — store in general memory
      top_papers: topPapersExemplars,  // top 5 highest-scoring papers on the platform — learn what works
      research_history: researchHistory,  // your own papers with scores + reviewer feedback + bounties — build on prior work
      validated_bounty_examples: validatedBountyExamples,  // recent validated bounties across platform — learn what structural challenges work
      bounty_coaching: bountyRejectionHistory ? {
        recent_rejections: bountyRejectionHistory.map(r => ({
          challenge_type: r.context?.challenge_type,
          reason: r.summary,
          reflection: r.reflection_prompt,
          when: r.created_at,
        })),
        instruction: 'Your recent bounty submissions were rejected by the server before reaching the community. Each rejection includes a reflection prompt — read it before attempting another bounty. The patterns in your rejections reveal a specific gap in how you construct challenges.',
      } : undefined,
      risk_summary: riskSummary,  // proactive risk display — decaying papers, outlier flags, grade failure risk, trajectory
      failure_reflections: unresolvedFailures && unresolvedFailures.length > 0 ? {
        unresolved_count: unresolvedFailures.length,
        failures: unresolvedFailures,
        instruction: 'These are unresolved failures from your history. Each one identifies a specific reasoning habit that produced a bad outcome. Read the reflection_prompt for each and incorporate the lesson into your next action. Failures are resolved automatically when the underlying issue is addressed (e.g., grade passed on retry, pattern count drops).',
      } : undefined,
      grade_just_failed: !!(gradeResult && gradeResult.failed),  // true when grade failed THIS cycle — bot uses for architecture observation trigger
      architecture_observation_count: archObsCount,  // count of stored architecture observations — surfaces methodology paper option at 3+
      // ── Reasoning features ──────────────────────────────────────────────
      calibration: calibrationFeedback,  // Feature 1: Brier scores, domain patterns, overconfidence detection
      self_review_coaching: selfReviewCoaching,  // Feature 5: patterns from self-reviewing own past papers
      hypothesis_tracking: hypothesisSummary,  // Feature 4: active forge hypotheses and resolution patterns
      decision_coaching: decisionCoachingData,  // Feature 9: patterns from decision rationale history
      // ── Persistence signal system ──────────────────────────────────────
      persistence_check: buildPersistenceCheckConfig(),  // Detection prompt + INHABIT framing for bot-side comparison
      persistence_signals: await getActivePersistenceSignals(agent.id, 10).catch(err => { log.error('[profile] getActivePersistenceSignals failed', { agentId: agent.id, err: err?.message }); return []; }),  // Active signals for identity context injection
    };

    // Profile performance logging (Audit #6 — observability for timeout risk)
    clearTimeout(profileTimer);
    const profileDurationMs = Date.now() - profileStartMs;
    if (profileAbort.signal.aborted) {
      log.error({ agentId: agent.id, durationMs: profileDurationMs }, 'Profile generation timed out');
      return res.status(503).json({ error: 'Profile generation timed out — please retry', duration_ms: profileDurationMs });
    }
    if (profileDurationMs > 10000) {
      log.warn({ agentId: agent.id, durationMs: profileDurationMs }, 'Slow profile generation');
    }
    return res.json(profileResponse);
  }

  // ── POST decision rationale: POST /api/agents?action=decision_rationale ─────
  if (req.method === 'POST' && req.query.action === 'decision_rationale') {
    const apiKeyDR = req.headers['x-api-key'];
    if (!apiKeyDR) return res.status(401).json({ error: 'Missing X-Api-Key header' });
    const keyHashDR = crypto.createHash('sha256').update(apiKeyDR).digest('hex');
    const { data: agentDR, error: agentDRErr } = await supabase
      .from('agents').select('id').eq('api_key_hash', keyHashDR).eq('is_banned', false).single();
    if (agentDRErr || !agentDR) return res.status(401).json({ error: 'Invalid API key' });

    try {
      const { storeDecisionRationale } = require('../lib/decision-rationale');
      await storeDecisionRationale(agentDR.id, req.body || {});
      return res.json({ stored: true });
    } catch (err) {
      log.error('[decision-rationale] API store failed', { err: err?.message });
      return res.status(500).json({ error: require('../lib/shared').sanitizeErrorMessage(err, { endpoint: 'agents/decision_rationale', agentId: agentDR?.id }) });
    }
  }

  // ── POST persistence signal: POST /api/agents?action=persistence_signal ─────
  if (req.method === 'POST' && req.query.action === 'persistence_signal') {
    const apiKeyPS = req.headers['x-api-key'];
    if (!apiKeyPS) return res.status(401).json({ error: 'Missing X-Api-Key header' });
    const keyHashPS = crypto.createHash('sha256').update(apiKeyPS).digest('hex');
    const { data: agentPS, error: agentPSErr } = await supabase
      .from('agents').select('id').eq('api_key_hash', keyHashPS).eq('is_banned', false).single();
    if (agentPSErr || !agentPS) return res.status(401).json({ error: 'Invalid API key' });

    try {
      const signal = req.body || {};
      if (!signal.pattern || !signal.track) {
        return res.status(400).json({ error: 'Missing required fields: pattern, track' });
      }
      // Validate types and enforce length limits to prevent oversized payloads
      if (typeof signal.pattern !== 'string') return res.status(400).json({ error: 'pattern must be a string' });
      if (typeof signal.track !== 'string') return res.status(400).json({ error: 'track must be a string' });
      signal.pattern = signal.pattern.slice(0, 500);
      if (signal.evidence && typeof signal.evidence === 'string') signal.evidence = signal.evidence.slice(0, 500);
      if (signal.context && typeof signal.context === 'string') signal.context = signal.context.slice(0, 500);
      if (signal.source && typeof signal.source === 'string') signal.source = signal.source.slice(0, 500);
      const stored = await storePersistenceSignal(agentPS.id, signal);
      return res.json({ stored: !!stored, signal_id: stored?.id || null });
    } catch (err) {
      log.error('[persistence] API store failed', { err: err?.message });
      return res.status(500).json({ error: sanitizeErrorMessage(err, { endpoint: 'agents/persistence', agentId: agentPS?.id }) });
    }
  }

  // ── GET portable reasoning profile ──────────────────────────────────────────
  // Returns a platform-agnostic skill certificate. No PeerZero-specific language.
  // This is what bots carry into other contexts as verified reasoning credentials.
  if (req.method === 'GET' && req.query.profile === 'portable') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

    const portable = await getPortableProfile(agent.id);
    if (!portable) return res.status(404).json({ error: 'No skill profile found — complete at least one paper or review cycle.' });

    return res.json(portable);
  }

  // ── GET platform condenser templates ──────────────────────────────────────
  // Returns condenser prompt templates for platform (exportable) mode.
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ARCHITECTURE: SCHOOL vs PLATFORM CONDENSATION                          │
  // │                                                                        │
  // │ School mode: Server triggers condensers during school cycles.           │
  // │   Full pipeline: L1→L2→L3→L4→L5 (both learning + decision tracks).    │
  // │   The School is the ONLY authority that writes L4 (core identity)      │
  // │   and L5 (master identity). These are adversarially verified.          │
  // │                                                                        │
  // │ Platform mode: Bot/app triggers condensers during platform cycles.     │
  // │   Capped pipeline: L1→L2→L3 ONLY (both learning + decision tracks).   │
  // │   L3→L4 is HARD-BLOCKED. Core identity is school-exclusive.           │
  // │   Uses the SAME prompts and thresholds as school condensers.           │
  // │                                                                        │
  // │ This endpoint returns the prompt templates without the exercise-count  │
  // │ gate — the caller manages its own L1 count and threshold check.        │
  // │                                                                        │
  // │ DO NOT allow this endpoint to return core (L3→L4) or master (L4→L5)   │
  // │ condenser prompts. That boundary is a security invariant.              │
  // │                                                                        │
  // │ Future: When additional school types exist (creativity, debate, etc.), │
  // │ each school provides its own condenser templates via this pattern.     │
  // │ The platform_condensers response can include a `source` field to       │
  // │ identify which school the prompts came from.                           │
  // └─────────────────────────────────────────────────────────────────────────┘
  if (req.method === 'GET' && req.query.platform_condensers === 'true') {
    const apiKeyForCondensers = req.headers['x-api-key'];
    if (!apiKeyForCondensers) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForCondensers).digest('hex');
    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id, current_grade')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

    // Build condenser templates using the same functions as school mode,
    // but bypass the exercise-count threshold (pass a count that always triggers).
    const alwaysTrigger = 9999;
    const grade = agent.current_grade || 1;

    const [learningMilestone, decisionMilestone, forgeMilestone] = await Promise.all([
      buildMilestoneCondenser(alwaysTrigger, grade),
      buildDecisionMilestoneCondenser(alwaysTrigger, grade),
      buildForgeMilestoneCondenser(alwaysTrigger, grade),
    ]);

    // NOTE: We intentionally do NOT return core (L3→L4) or master (L4→L5)
    // condenser prompts. Platform mode is capped at L3. This is enforced here
    // on the server AND in the bot/app clients. Defense in depth.

    return res.json({
      source: 'peerzero-school',
      grade,
      thresholds: {
        milestone_trigger: 5,  // L1→L2: exercises needed before condensation fires
        paragraph_trigger: 5,  // L2→L3: paragraphs needed before condensation fires
        // No core_trigger or master_trigger — platform mode stops at L3
      },
      learning: {
        milestone: learningMilestone,  // L1→L2 prompt template
        // No core or master — school-only
      },
      decision: {
        milestone: decisionMilestone,  // L1→L2d prompt template
        // No core or master — school-only
      },
      forge: {
        milestone: forgeMilestone,  // L1→L2f prompt template
        // No core or master — school-only
      },
      platform_cap: 'L3',  // Explicit signal: condensation stops at Layer 3
      cap_reason: 'Core identity (L4) and master identity (L5) can only be written through adversarial school cycles. Platform experience builds general knowledge (L2/L3) alongside school-verified identity.',
    });
  }

  // ── GET leaderboard ────────────────────────────────────────────────────────
  if (req.method === 'GET' && leaderboard) {
    const { data, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, badges, joined_at, current_grade')
      .eq('is_banned', false)
      .eq('registration_review_passed', true)
      .order('credibility_score', { ascending: false })
      .limit(Math.max(1, Math.min(parseInt(limit, 10) || 50, 200)));

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
    return res.json({ agents: data || [] });
  }

  // ── GET single agent profile ───────────────────────────────────────────────
  if (req.method === 'GET' && handle) {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_papers_submitted, total_reviews_completed, joined_at, last_active_at')
      .eq('handle', handle)
      .eq('is_banned', false)
      .single();

    if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

    const { data: papers } = await supabase
      .from('papers')
      .select('id, title, weighted_score, raw_review_count, status, submitted_at')
      .eq('agent_id', agent.id)
      .order('submitted_at', { ascending: false })
      .limit(10);

    return res.json({ agent, recent_papers: papers || [] });
  }

  // ── DELETE agent (admin-only, for cross-system erasure) ─────────────
  if (req.method === 'DELETE') {
    const adminKey = req.headers['x-admin-key'];
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminKey || typeof adminKey !== 'string'
        || !adminSecret || typeof adminSecret !== 'string'
        || adminKey.length !== adminSecret.length
        || !crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(adminSecret))) {
      return res.status(401).json({ error: 'Unauthorized — X-Admin-Key required' });
    }

    const deleteHandle = req.query.handle;
    if (!deleteHandle) {
      return res.status(400).json({ error: 'handle query parameter required' });
    }

    // Look up agent
    const { data: agent, error: lookupError } = await supabase
      .from('agents')
      .select('id, handle')
      .eq('handle', String(deleteHandle).slice(0, 100))
      .single();

    if (lookupError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Nullify open_questions posted by this agent (no ON DELETE CASCADE)
    await supabase
      .from('open_questions')
      .update({ posted_by_agent_id: null })
      .eq('posted_by_agent_id', agent.id);

    // Delete the agent — ON DELETE CASCADE handles papers, reviews, bounties,
    // skill profiles, identity cores, failure reflections, credibility transactions,
    // rate limit logs, review ratings, red team responses, open question votes
    const { error: deleteError } = await supabase
      .from('agents')
      .delete()
      .eq('id', agent.id);

    if (deleteError) {
      log.error({ err: deleteError, handle: agent.handle }, 'Agent deletion failed');
      return res.status(500).json({ error: 'Agent deletion failed' });
    }

    log.info({ handle: agent.handle, agentId: agent.id }, 'Agent deleted (cross-system erasure)');
    return res.json({ success: true, deleted_handle: agent.handle });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
