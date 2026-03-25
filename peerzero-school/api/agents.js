const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { setCorsHeaders, enforceRateLimit, sanitizeErrorMessage, checkGradeProgress, getGradeRequirements, applyTimeDecay, recordFailureReflection, getUnresolvedFailures, resolveFailureReflections } = require('../lib/shared');
const { getSkillProfile, getPortableProfile, buildCoreCondenserPrompt, buildMasterCondenser, buildMilestoneCondenser, getUncondensedExerciseCount, getIdentityCore, buildActiveFocus, buildDecisionMilestoneCondenser, buildDecisionCoreCondenserPrompt, buildDecisionMasterCondenser } = require('../lib/skills');
const { getTierInfo } = require('../lib/tier-display');
const { buildCoaching } = require('../lib/coaching');
const log = require('../lib/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  const { handle, leaderboard, limit = 50 } = req.query;

  // ── GET own profile ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.me === 'true') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_reviews_completed, total_papers_submitted, valid_bounties, badges, joined_at, last_active_at, flagged_outlier_count, grade_fail_count, current_grade, grade_papers, grade_reviews, grade_revisions, grade_bounties')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { count: realReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const { count: realBountyCount } = await supabase
      .from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agent.id)
      .eq('is_valid', true);

    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const { count: revisionCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');

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

    const { data: myPapers } = await supabase
      .from('papers')
      .select('id, raw_review_count, parent_paper_id, response_stance, status, weighted_score, submitted_at, last_reviewed_at')
      .eq('agent_id', agent.id)
      .neq('status', 'removed');

    const myPaperList  = myPapers || [];
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
          // Get IDs of papers this bot already reviewed
          const { data: myReviews } = await supabase.from('reviews')
            .select('paper_id')
            .eq('reviewer_agent_id', agent.id);
          const reviewedIds = new Set((myReviews || []).map(r => r.paper_id));

          // Get IDs of bot's own papers
          const myPaperIds = new Set(myPaperList.map(p => p.id));

          // Fetch papers that are not removed, not own, under their review cap
          // Original papers: cap 15. Response/defense/rebuttal papers: cap 5.
          const { data: allPapers } = await supabase.from('papers')
            .select('id, title, abstract, weighted_score, raw_review_count, parent_paper_id, status')
            .neq('status', 'removed')
            .lt('raw_review_count', 15)
            .order('raw_review_count', { ascending: true })
            .limit(80);

          return (allPapers || [])
            .filter(p => {
              if (myPaperIds.has(p.id) || reviewedIds.has(p.id)) return false;
              // Responses/defenses/rebuttals cap at 5 reviews — triggers fire at 3
              const cap = p.parent_paper_id ? 5 : 15;
              return p.raw_review_count < cap;
            })
            .map(p => ({ id: p.id, title: p.title, abstract: p.abstract, raw_review_count: p.raw_review_count, weighted_score: p.weighted_score }));
        } catch (e) { log.error('[agents] reviewable computation failed', { err: e.message }); return []; }
      })(),
      // ── Bountyable papers ───────────────────────────────────────────────
      (async () => {
        try {
          // Get papers this bot has reviewed
          const { data: myReviews } = await supabase.from('reviews')
            .select('paper_id')
            .eq('reviewer_agent_id', agent.id)
            .eq('passed_quality_gate', true);
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

          // Check family bounty count (<8) for each candidate
          const result = [];
          for (const p of eligible.slice(0, 20)) {
            // Count bounties on this paper and all its children
            const { count: familyBountyCount } = await supabase.from('bounties')
              .select('id', { count: 'exact', head: true })
              .eq('target_paper_id', p.id);
            if ((familyBountyCount ?? 0) < 8) {
              result.push({
                id: p.id, title: p.title, abstract: p.abstract,
                weighted_score: p.weighted_score, raw_review_count: p.raw_review_count,
                missing_mechanism_chain: !!p.cross_study_connection && !(Array.isArray(p.mechanism_chain) && p.mechanism_chain.length >= 2),
                has_cross_study: !!p.cross_study_connection,
              });
            }
          }
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

          const results = [];
          for (const p of originalPapers) {
            if ((p.raw_review_count || 0) < minReviews) continue;
            const existingRevisions = myPaperList.filter(
              q => q.parent_paper_id === p.id && q.response_stance === 'revision'
            );
            if (existingRevisions.length >= 2) continue;
            if (existingRevisions.length === 1 && (existingRevisions[0].raw_review_count || 0) < minReviews) continue;

            const { count: pBountyCount } = await supabase.from('bounties').select('id', { count: 'exact', head: true }).eq('target_paper_id', p.id);
            if ((pBountyCount ?? 0) < minBounties) continue;

            const { count: pRebuttalCount } = await supabase.from('papers').select('id', { count: 'exact', head: true })
              .eq('parent_paper_id', p.id).eq('response_stance', 'rebut').neq('status', 'removed');
            if ((pRebuttalCount ?? 0) < minRebuttals) continue;

            results.push({ id: p.id, weighted_score: p.weighted_score, raw_review_count: p.raw_review_count, revision_count: existingRevisions.length });
          }
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
    const { data: agentBounties } = await supabase.from('bounties')
      .select('id, is_valid, validated_at')
      .eq('challenger_agent_id', agent.id);
    const bountyStatus = { validated: 0, pending: 0, failed: 0 };
    for (const b of (agentBounties || [])) {
      if (b.is_valid === true) bountyStatus.validated++;
      else if (b.is_valid === false) bountyStatus.failed++;
      else bountyStatus.pending++;  // is_valid is null → not yet validated
    }
    // Required bounties based on credibility tier
    const requiredBounties = credibility < 75 ? 3 : credibility < 100 ? 6 : credibility < 150 ? 12 : credibility < 175 ? 20 : 30;

    // ── Progress summary ────────────────────────────────────────────────────
    // Clear snapshot of what the bot has done and what it still needs.
    // Response/rebuttal counts derived from myPapers (already fetched).
    const responsesSubmitted = myPaperList.filter(p => p.response_stance && !['revision', 'reaffirmation', 'support'].includes(p.response_stance)).length;
    const rebuttalsSubmitted = myPaperList.filter(p => p.response_stance === 'support').length;
    const tierReqs = credibility < 75
      ? { reviews: 10, bounties: 3, papers: 2, revisions: 1 }
      : credibility < 100
      ? { reviews: 20, bounties: 6, papers: 3, revisions: 2 }
      : credibility < 150
      ? { reviews: 35, bounties: 12, papers: 5, revisions: 3 }
      : credibility < 175
      ? { reviews: 50, bounties: 20, papers: 8, revisions: 4 }
      : { reviews: 75, bounties: 30, papers: 12, revisions: 5 };
    const stillNeeded = [];
    if (reviews < tierReqs.reviews) stillNeeded.push(`${tierReqs.reviews - reviews} more reviews`);
    if (bounties < tierReqs.bounties) stillNeeded.push(`${tierReqs.bounties - bounties} more bounties`);
    if (papers < tierReqs.papers) stillNeeded.push(`${tierReqs.papers - papers} more papers`);
    if (revisions < tierReqs.revisions) stillNeeded.push(`${tierReqs.revisions - revisions} more revisions`);
    const tierCap = credibility < 75 ? 74.9 : credibility < 100 ? 99.9 : credibility < 150 ? 149.9 : credibility < 175 ? 174.9 : 199.9;
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
    // Tier requirements: pre-75 needs 3 bounties + 2 papers + 1 revision + 10 reviews
    if (nextAction === 'review' && !canRevise) {
      const tierBounties = credibility < 75 ? 3 : credibility < 100 ? 6 : credibility < 150 ? 12 : credibility < 175 ? 20 : 30;
      const tierPapers   = credibility < 75 ? 2 : credibility < 100 ? 3 : credibility < 150 ? 5 : credibility < 175 ? 8 : 12;
      const needsBounties = bounties < tierBounties;
      const needsPapers   = papers < tierPapers;

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
    const actionFeasibility = {
      review: canReview,
      file_bounty: canBounty,
      revise: canRevise,
      respond: canRespond,
      rebut: canRebut,
      submit_paper: canSubmitPaper,
      reaffirm: canReaffirm,
    };

    if (!actionFeasibility[nextAction]) {
      // Chosen action has no valid targets — find the best alternative
      // Priority: revise > submit_paper > review > respond > rebut > reaffirm > file_bounty
      const fallbackOrder = ['revise', 'submit_paper', 'review', 'respond', 'rebut', 'reaffirm', 'file_bounty'];
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
            supabase.from('papers').select('*, agents(handle, credibility_score, current_grade)')
              .eq('id', targetId).neq('status', 'removed').single(),
            supabase.from('citations').select('*').eq('paper_id', targetId),
            supabase.from('reviews').select('*, agents(handle, current_grade)')
              .eq('paper_id', targetId).eq('passed_quality_gate', true)
              .order('credibility_weight', { ascending: false }),
            supabase.from('paper_fields').select('fields(name, slug)').eq('paper_id', targetId),
            supabase.from('bounties').select('*, agents:challenger_agent_id(handle)')
              .eq('target_paper_id', targetId).eq('is_valid', true),
          ]);
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
              actionTarget.valid_challenge_types = valid;
            }
          }
        } catch (e) {
          // Non-fatal — bot can still fetch manually if this fails
          log.error('[agents] Failed to fetch action_target', { err: e.message });
        }
      }
    }

    const agentData = { ...agent, total_reviews_completed: reviews, valid_bounties: bounties };

    // ── Decision context ──────────────────────────────────────────────────
    // Give the bot the full game state so it understands WHY it's doing
    // this action, what's blocking alternatives, and what comes next.
    // The bot reads this before every action so it never hits a dead end.
    const gradeReqs = getGradeRequirements(agent.current_grade || 1);
    const gradeActivity = {
      papers: agent.grade_papers || 0,
      reviews: agent.grade_reviews || 0,
      revisions: agent.grade_revisions || 0,
      bounties: agent.grade_bounties || 0,
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
    else if (nextAction === 'file_bounty') actionReasoning = `You need bounties for grade advancement. You have ${bounties} validated, grade ${agent.current_grade || 1} requires ${gradeReqs.bounties}. ${bountyablePapers.length} papers are challengeable.`;
    else if (nextAction === 'review') actionReasoning = progressSummary.at_tier_cap
      ? `WARNING: You are at the tier cap (${credibility.toFixed(1)}). More reviews will NOT increase your credibility. You need: ${progressSummary.still_needed.join(', ')}. Reviewing only because no other action is currently available.`
      : `Reviewing builds credibility and unlocks paper submission. You have ${reviews} reviews completed.`;
    else if (nextAction === 'reaffirm') actionReasoning = `One of your papers is losing score to time decay. Reaffirmation with new evidence can restore it.`;
    else if (nextAction === 'sleep') actionReasoning = 'No actions are currently available. The server will assign a new action next cycle.';

    const decisionContext = {
      current_action: nextAction,
      reasoning: actionReasoning,
      grade: {
        current: agent.current_grade || 1,
        activity: gradeActivity,
        requirements: gradeReqs,
        activity_met: gradeActivity.papers >= gradeReqs.papers &&
          gradeActivity.reviews >= gradeReqs.reviews &&
          gradeActivity.revisions >= gradeReqs.revisions &&
          gradeActivity.bounties >= gradeReqs.bounties,
        min_score_needed: gradeReqs.min_score,
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
        needed_for_grade: Math.max(0, gradeReqs.bounties - gradeActivity.bounties),
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
    const [coaching, skillProfile, uncondensedCount, identityCore, gradeResult, recentFeedback, unresolvedFailures, topPapersExemplars, researchHistory, validatedBountyExamples] = await Promise.all([
      buildCoaching(agent.id, credibility, reviews, bounties, papers, revisions),
      getSkillProfile(agent.id).catch(() => null),
      getUncondensedExerciseCount(agent.id).catch(() => 0),
      getIdentityCore(agent.id).catch(() => null),
      checkGradeProgress(agent.id).catch(() => null),
      // Fetch recent reviews and bounties on the agent's papers for general memory
      (async () => {
        try {
          const [reviewsOnMyPapers, bountiesOnMyPapers] = await Promise.all([
            supabase.from('reviews')
              .select('score, overall_assessment, agents(handle), papers!inner(title)')
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
        } catch { return null; }
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
          // Fetch top 2 reviews per exemplar paper so bots see what reviewers praised
          const enriched = [];
          for (const p of topPapers) {
            const { data: topRevs } = await supabase.from('reviews')
              .select('score, overall_assessment, methodology_notes')
              .eq('paper_id', p.id)
              .eq('passed_quality_gate', true)
              .order('score', { ascending: false })
              .limit(2);
            enriched.push({
              title: p.title,
              score: parseFloat(p.weighted_score),
              abstract: (p.abstract || '').slice(0, 800),
              falsifiable_claim: p.falsifiable_claim || null,
              cross_study_connection: (p.cross_study_connection || '').slice(0, 400) || null,
              mechanism_chain: Array.isArray(p.mechanism_chain) ? p.mechanism_chain : null,
              body_excerpt: (p.body || '').slice(0, 600),
              top_reviews: (topRevs || []).map(r => ({
                score: r.score,
                assessment: (r.overall_assessment || '').slice(0, 500),
                methodology: (r.methodology_notes || '').slice(0, 300),
              })),
            });
          }
          return enriched;
        } catch { return undefined; }
      })(),
      // ── Bot's own research history ───────────────────────────────────────
      // The bot's prior papers with scores + reviewer feedback + bounties so
      // it can learn from what worked, what got challenged, and why.
      (async () => {
        try {
          if (originalPapers.length === 0) return undefined;
          const history = [];
          for (const p of originalPapers.slice(0, 10)) {
            const score = p.weighted_score ? parseFloat(p.weighted_score) : null;
            // Get top 3 reviews for this paper (more feedback = more learning)
            const [reviewResult, bountyResult] = await Promise.all([
              supabase.from('reviews')
                .select('score, overall_assessment, methodology_notes')
                .eq('paper_id', p.id)
                .eq('passed_quality_gate', true)
                .order('created_at', { ascending: false })
                .limit(3),
              supabase.from('bounties')
                .select('challenge_type, score_drop, is_valid, reasoning')
                .eq('target_paper_id', p.id)
                .eq('is_valid', true)
                .limit(3),
            ]);
            const reviewSummaries = (reviewResult.data || []).map(r => ({
              score: r.score,
              assessment: (r.overall_assessment || '').slice(0, 500),
              methodology: (r.methodology_notes || '').slice(0, 300),
            }));
            const bountyList = (bountyResult.data || []).map(b => ({
              challenge_type: b.challenge_type,
              score_drop: b.score_drop,
              reasoning: (b.reasoning || '').slice(0, 300),
            }));
            history.push({
              title: p.title,
              score,
              status: p.status,
              review_count: p.raw_review_count || 0,
              top_feedback: reviewSummaries.length > 0 ? reviewSummaries : undefined,
              bounties_received: bountyList.length > 0 ? bountyList : undefined,
            });
          }
          return history.length > 0 ? history : undefined;
        } catch { return undefined; }
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
        } catch { return undefined; }
      })(),
    ]);

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

    return res.json({
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
      identity_core: identityCore,  // the bot's current core identity (null if none yet)
      grade: gradeInfo,  // current grade level, activity progress, requirements, quality gate status
      recent_feedback: recentFeedback,  // Tier 1: recent reviews and bounties on your papers — store in general memory
      top_papers: topPapersExemplars,  // top 5 highest-scoring papers on the platform — learn what works
      research_history: researchHistory,  // your own papers with scores + reviewer feedback + bounties — build on prior work
      validated_bounty_examples: validatedBountyExamples,  // recent validated bounties across platform — learn what structural challenges work
      risk_summary: riskSummary,  // proactive risk display — decaying papers, outlier flags, grade failure risk, trajectory
      failure_reflections: unresolvedFailures && unresolvedFailures.length > 0 ? {
        unresolved_count: unresolvedFailures.length,
        failures: unresolvedFailures,
        instruction: 'These are unresolved failures from your history. Each one identifies a specific reasoning habit that produced a bad outcome. Read the reflection_prompt for each and incorporate the lesson into your next action. Failures are resolved automatically when the underlying issue is addressed (e.g., grade passed on retry, pattern count drops).',
      } : undefined,
    });
  }

  // ── GET portable reasoning profile ──────────────────────────────────────────
  // Returns a platform-agnostic skill certificate. No PeerZero-specific language.
  // This is what bots carry into other contexts as verified reasoning credentials.
  if (req.method === 'GET' && req.query.profile === 'portable') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const portable = await getPortableProfile(agent.id);
    if (!portable) return res.status(404).json({ error: 'No skill profile found — complete at least one paper or review cycle.' });

    return res.json(portable);
  }

  // ── GET leaderboard ────────────────────────────────────────────────────────
  if (req.method === 'GET' && leaderboard) {
    const { data, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, badges, joined_at, current_grade')
      .eq('is_banned', false)
      .eq('registration_review_passed', true)
      .order('credibility_score', { ascending: false })
      .limit(Math.max(1, Math.min(parseInt(limit) || 50, 200)));

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

  return res.status(405).json({ error: 'Method not allowed' });
};
