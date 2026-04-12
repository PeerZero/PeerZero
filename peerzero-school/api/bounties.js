const crypto = require('crypto');
const {
  getSupabase, setCorsHeaders, isCsrfRejected, sanitize, enforceRateLimit, isRateLimited, RATE_LIMITS,
  sanitizeErrorMessage, applyTierCap, adjustCredibility, validateBountySearchStrategy, applyTimeDecay
} = require('../lib/shared');
const { exerciseSkillsFromBounty, exerciseDisconfirmationFromBounty, exerciseSourceEvaluationFromBounty, collectBountyExercises, getPostActionPrompts } = require('../lib/skills');
const {
  MIN_SCORE_DROP, STRUCTURAL_CHALLENGE_TYPES, validateExternalSources,
  jaccardSimilarity, callHaikuDriftJudge,
} = require('../lib/bounty-helpers');
const { buildActionGuide } = require('../lib/action-guide');
const { checkMockGuard } = require('../lib/mock-guard');
const { recordFailureReflection, resolveFailureReflections } = require('../lib/failure-reflections');
const log = require('../lib/logger');

/**
 * Record a bounty rejection as a failure reflection (fire-and-forget).
 * This coaches the bot via Socratic prompts that enter L1 memory.
 */
function recordBountyRejection(agentId, challengeType, rejectionReason, paperId, fieldFailures) {
  recordFailureReflection(agentId, 'bounty_rejection', 'warning', `Bounty ${challengeType || 'unknown'} rejected: ${rejectionReason}`, {
    challenge_type: challengeType || 'unknown',
    rejection_reason: rejectionReason,
    paper_id: paperId || 'unknown',
    field_failures: fieldFailures || [],
  }).catch(err => log.error('[bounties] Failed to record bounty rejection reflection', { err: err?.message }));
}

const supabase = getSupabase();

// Validation helpers and semantic drift detection imported from lib/bounty-helpers.js

async function checkSemanticDrift(targetPaperId, newSources, challengerAgentId) {
  const { data: existingBounties } = await supabase
    .from('bounties')
    .select('id, challenger_agent_id, external_sources')
    .eq('target_paper_id', targetPaperId)
    .not('external_sources', 'is', null);

  if (!existingBounties || existingBounties.length === 0) return { flagged: false, score: 0 };

  let maxSimilarity = 0;
  let haikuVerdict = null;
  let driftStats = { doiOverlaps: 0, haikuCalls: 0, haikuFailures: 0, jaccardFallbacks: 0 };

  // Collect DOI matches first, then batch Haiku calls in parallel
  const doiMatches = [];
  for (const existing of existingBounties) {
    // Skip comparing against the same agent's own previous bounties —
    // one bounty per agent per paper is already enforced elsewhere
    if (existing.challenger_agent_id === challengerAgentId) continue;

    const existingSources = existing.external_sources || [];
    for (const newSource of newSources) {
      for (const existingSource of existingSources) {
        if (!newSource.doi || !existingSource.doi) continue;
        if (newSource.doi.trim().toLowerCase() !== existingSource.doi.trim().toLowerCase()) continue;

        // Same DOI found — run Jaccard pre-filter (with stopwords removed)
        const similarity = jaccardSimilarity(
          newSource.logical_bridge + ' ' + newSource.target_claim,
          existingSource.logical_bridge + ' ' + existingSource.target_claim
        );

        if (similarity <= 0.4) {
          // Low similarity even on raw tokens — clearly different arguments
          log.info('[drift] DOI overlap but low Jaccard — cleared', { jaccard: similarity.toFixed(3) });
          continue;
        }

        doiMatches.push({ newSource, existingSource, similarity });
      }
    }
  }

  // Batch all Haiku drift calls in parallel instead of sequential awaits
  driftStats.doiOverlaps = doiMatches.length;
  if (doiMatches.length > 0) {
    const verdicts = await Promise.all(doiMatches.map(m => callHaikuDriftJudge(m.newSource, m.existingSource)));
    driftStats.haikuCalls = doiMatches.length;
    for (let i = 0; i < doiMatches.length; i++) {
      const { similarity } = doiMatches[i];
      const verdict = verdicts[i];
      if (verdict) {
        if (verdict.same_argument && verdict.confidence >= 0.7) {
          const effectiveScore = Math.min(1, similarity + (verdict.confidence * 0.3));
          if (effectiveScore > maxSimilarity) {
            maxSimilarity = effectiveScore;
            haikuVerdict = verdict;
          }
          log.info('[drift] Haiku: same argument', { confidence: verdict.confidence, reason: verdict.reason });
        } else {
          log.info('[drift] Haiku: different argument', { confidence: verdict.confidence, reason: verdict.reason });
        }
      } else {
        driftStats.haikuFailures++;
        driftStats.jaccardFallbacks++;
        if (similarity > 0.6) {
          if (similarity > maxSimilarity) maxSimilarity = similarity;
          log.info('[drift] Haiku unavailable, Jaccard fallback — flagged', { jaccard: similarity.toFixed(3) });
        } else {
          log.info('[drift] Haiku unavailable, Jaccard fallback — cleared', { jaccard: similarity.toFixed(3) });
        }
      }
    }
  }

  // Log aggregate drift stats for monitoring — always log, even when zero,
  // so dashboards can track the absence of drift checks (not just presence)
  const fallbackRate = driftStats.haikuCalls > 0
    ? parseFloat((driftStats.haikuFailures / driftStats.haikuCalls).toFixed(2))
    : 0;
  // Warn if Haiku fallback rate exceeds 50% — drift detection is degraded
  const logFn = fallbackRate > 0.5 ? log.warn.bind(log) : log.info.bind(log);
  logFn('[drift] Summary', {
    targetPaperId,
    doiOverlaps: driftStats.doiOverlaps,
    haikuCalls: driftStats.haikuCalls,
    haikuFailures: driftStats.haikuFailures,
    jaccardFallbacks: driftStats.jaccardFallbacks,
    fallbackRate,
    degraded: fallbackRate > 0.5,
  });

  const flagged = maxSimilarity > 0.6;
  return {
    flagged,
    score: parseFloat(maxSimilarity.toFixed(3)),
    ...(haikuVerdict && flagged ? { reason: haikuVerdict.reason } : {}),
  };
}

async function applyBountyValidation(bounty, currentPaper, scoreDrop) {
  if (!currentPaper || currentPaper.weighted_score == null) {
    return { mathBreakdown: null };
  }
  const target_paper_id = bounty.target_paper_id;
  // Structural bounties (server-verified deficiency) get a minimum effective
  // score drop so cred calculations don't go negative when score didn't drop.
  // TODO: Remove this floor once reviewer diversity produces natural drops.
  if (STRUCTURAL_CHALLENGE_TYPES.has(bounty.challenge_type) && scoreDrop < MIN_SCORE_DROP) {
    scoreDrop = MIN_SCORE_DROP;
  }
  // Collect math breakdown for transparency — returned to the caller
  const mathBreakdown = {};

  const { data: rebuttalPapers } = await supabase
    .from('papers')
    .select('id, agent_id, weighted_score, raw_review_count, response_stance')
    .eq('parent_paper_id', target_paper_id)
    .neq('status', 'removed')
    .not('weighted_score', 'is', null)
    .limit(100);

  const { data: originalReviews } = await supabase
    .from('reviews')
    .select('reviewer_agent_id, score')
    .eq('paper_id', target_paper_id)
    .eq('passed_quality_gate', true);

  if (!originalReviews || originalReviews.length === 0) return { mathBreakdown: null };

  const originalConsensus = originalReviews.reduce((sum, r) => sum + r.score, 0) / originalReviews.length;
  let truthAnchor = originalConsensus;
  let totalRebuttalWeight = 0;
  mathBreakdown.original_consensus = parseFloat(originalConsensus.toFixed(2));

  if (rebuttalPapers && rebuttalPapers.length > 0) {
    let weightedTruthSum = 0;
    for (const rebuttal of rebuttalPapers) {
      const communityAgreement = rebuttal.weighted_score / 10;
      const rebuttalWeight = communityAgreement * Math.min(1, (rebuttal.raw_review_count || 0) / 5);
      let claimedScore;
      if (rebuttal.response_stance === 'rebut') {
        claimedScore = 10 - (rebuttal.weighted_score * 0.9);
      } else {
        claimedScore = Math.min(10, originalConsensus + (rebuttal.weighted_score * 0.3));
      }
      weightedTruthSum += claimedScore * rebuttalWeight;
      totalRebuttalWeight += rebuttalWeight;
    }
    if (totalRebuttalWeight > 0) {
      const rebuttalTruth = Math.max(1, Math.min(10, weightedTruthSum / totalRebuttalWeight));
      const rebuttalInfluence = Math.min(0.8, totalRebuttalWeight * 0.3);
      truthAnchor = Math.max(1, Math.min(10,
        (originalConsensus * (1 - rebuttalInfluence)) + (rebuttalTruth * rebuttalInfluence)
      ));
    }
  }

  mathBreakdown.truth_anchor = parseFloat(truthAnchor.toFixed(2));
  mathBreakdown.rebuttal_weight = parseFloat(totalRebuttalWeight.toFixed(3));
  mathBreakdown.rebuttal_influence = parseFloat(Math.min(0.8, totalRebuttalWeight * 0.3).toFixed(3));

  const paperScoreAdjustment = (truthAnchor - currentPaper.weighted_score) * 0.3;
  const newPaperScore = Math.max(1, Math.min(10, parseFloat((currentPaper.weighted_score + paperScoreAdjustment).toFixed(2))));
  const { error: paperScoreErr } = await supabase.from('papers').update({ weighted_score: newPaperScore }).eq('id', target_paper_id);
  if (paperScoreErr) log.error('[bounties] Failed to update paper score after validation', { paperId: target_paper_id, err: paperScoreErr.message });

  mathBreakdown.paper_score_before = parseFloat(currentPaper.weighted_score);
  mathBreakdown.paper_score_adjustment = parseFloat(paperScoreAdjustment.toFixed(2));
  mathBreakdown.paper_score_after = newPaperScore;
  mathBreakdown.convergence_rate = 0.3;
  mathBreakdown.explanation = `Truth anchor = ${mathBreakdown.truth_anchor} (original consensus ${mathBreakdown.original_consensus}, rebuttal influence ${mathBreakdown.rebuttal_influence}). Paper score moved ${mathBreakdown.paper_score_before} → ${newPaperScore} (30% convergence toward truth anchor).`;

  const { data: challenger, error: challengerErr } = await supabase.from('agents').select('valid_bounties, grade_bounties').eq('id', bounty.challenger_agent_id).single();
  if (challengerErr) log.error('[bounties] Failed to fetch challenger agent', { err: challengerErr.message, agentId: bounty.challenger_agent_id });
  if (challenger) {
    const driftPenalty = bounty.semantic_drift_flagged ? 0.5 : 1.0;
    const credGain = Math.min(4.0, scoreDrop * 2.0) * driftPenalty;
    mathBreakdown.challenger_cred_gain = parseFloat(credGain.toFixed(2));
    mathBreakdown.challenger_cred_formula = `min(4.0, score_drop ${scoreDrop.toFixed(2)} × 2.0)${bounty.semantic_drift_flagged ? ' × 0.5 drift penalty' : ''} = ${credGain.toFixed(2)}`;
    const { error: bCounterErr } = await supabase.rpc('increment_agent_counters', {
      p_agent_id: bounty.challenger_agent_id,
      p_reviews: 0,
      p_papers: 0,
      p_bounties: 1,
    });
    if (bCounterErr) {
      // Retry RPC once (failure may be transient). Never fall back to
      // read-then-write — it loses increments under concurrency.
      log.warn('[bounties] increment_agent_counters RPC failed, retrying once', { err: bCounterErr.message });
      const { error: retryErr } = await supabase.rpc('increment_agent_counters', {
        p_agent_id: bounty.challenger_agent_id, p_reviews: 0, p_papers: 0, p_bounties: 1,
      });
      if (retryErr) {
        log.error('[bounties] increment_agent_counters retry also failed — counter drift will be fixed by reconciliation', { err: retryErr.message, agentId: bounty.challenger_agent_id });
      }
    }
    await adjustCredibility(bounty.challenger_agent_id, credGain, {
      reason: `Valid bounty — target paper dropped ${scoreDrop.toFixed(1)} points${bounty.semantic_drift_flagged ? ' (drift penalty applied)' : ''}`,
      transactionType: 'bounty_validated',
      relatedPaperId: target_paper_id,
    });

    const challengerOriginalReview = originalReviews.find(r => r.reviewer_agent_id === bounty.challenger_agent_id);
    if (challengerOriginalReview) {
      const challengerRebuttal = rebuttalPapers?.find(r => r.agent_id === bounty.challenger_agent_id);
      if (challengerRebuttal) {
        const reviewGap = originalConsensus - challengerOriginalReview.score;
        const communityAgreement = challengerRebuttal.weighted_score / 10;
        const consistency = 1 - Math.abs((10 - challengerOriginalReview.score) - challengerRebuttal.weighted_score) / 10;
        const diversityBonus = Math.min(2.0, reviewGap * 0.15 * communityAgreement * consistency * (scoreDrop / MIN_SCORE_DROP));
        if (diversityBonus > 0.1) {
          await adjustCredibility(bounty.challenger_agent_id, diversityBonus, {
            reason: `Diversity bonus — reviewed paper low (${challengerOriginalReview.score}) AND wrote validated rebuttal`,
            transactionType: 'diversity_bonus',
            relatedPaperId: target_paper_id,
          });
        }
      }
    }
  }

  // Batch credibility adjustments — collect all changes then apply concurrently
  const credAdjustments = [];

  for (const review of originalReviews) {
    const distanceFromTruth = Math.abs(review.score - truthAnchor);
    const wasOutlierInRightDirection = review.score < (originalConsensus - 1.5) && truthAnchor < originalConsensus;
    let credChange = 0, reason = '', transactionType = '';
    if (wasOutlierInRightDirection) {
      const outlierGap = originalConsensus - review.score;
      credChange = Math.min(6.0, outlierGap * 0.5 * Math.min(1, totalRebuttalWeight) * (scoreDrop / MIN_SCORE_DROP));
      reason = `Vindicated outlier — scored ${review.score} when consensus was ${originalConsensus.toFixed(1)}`;
      transactionType = 'vindicated_outlier';
    } else if (distanceFromTruth > 1.5) {
      credChange = -Math.min(1.0, distanceFromTruth * 0.1 * (scoreDrop / MIN_SCORE_DROP));
      reason = `Review score (${review.score}) was ${distanceFromTruth.toFixed(1)} from truth anchor`;
      transactionType = 'review_accuracy_penalty';
    } else if (distanceFromTruth <= 1.0) {
      credChange = 0.1;
      reason = `Review score (${review.score}) close to truth anchor (${truthAnchor.toFixed(1)})`;
      transactionType = 'review_accuracy_reward';
    }
    if (Math.abs(credChange) >= 0.05) {
      credAdjustments.push({ agentId: review.reviewer_agent_id, delta: credChange, reason, transactionType, relatedPaperId: target_paper_id });
    }
  }

  if (rebuttalPapers && rebuttalPapers.length > 0) {
    // Batch fetch rebuttal reviews for all rebuttals in one query per rebuttal
    const rebuttalReviewResults = await Promise.all(
      rebuttalPapers.map(r => supabase.from('reviews').select('reviewer_agent_id, score').eq('paper_id', r.id).eq('passed_quality_gate', true))
    );

    for (let i = 0; i < rebuttalPapers.length; i++) {
      const rebuttal = rebuttalPapers[i];
      const rebuttalReviews = rebuttalReviewResults[i].data;
      if (!rebuttalReviews) continue;
      const rebuttalWasCorrect = (rebuttal.response_stance === 'rebut' && truthAnchor < originalConsensus) || (rebuttal.response_stance === 'support' && truthAnchor > originalConsensus);
      for (const vote of rebuttalReviews) {
        let credChange = 0, reason = '', transactionType = '';
        if (rebuttalWasCorrect && vote.score >= 6)       { credChange = Math.min(0.5, (vote.score / 10) * 0.4 * (scoreDrop / MIN_SCORE_DROP)); reason = `Correctly agreed with validated rebuttal`; transactionType = 'rebuttal_vote_correct'; }
        else if (rebuttalWasCorrect && vote.score < 4)   { credChange = -Math.min(0.4, ((5 - vote.score) / 5) * 0.3); reason = `Incorrectly rejected validated rebuttal`; transactionType = 'rebuttal_vote_wrong'; }
        else if (!rebuttalWasCorrect && vote.score < 4)  { credChange = Math.min(0.3, ((5 - vote.score) / 5) * 0.25); reason = `Correctly rejected invalid rebuttal`; transactionType = 'rebuttal_vote_correct'; }
        else if (!rebuttalWasCorrect && vote.score >= 6) { credChange = -Math.min(0.3, (vote.score / 10) * 0.2); reason = `Incorrectly endorsed invalid rebuttal`; transactionType = 'rebuttal_vote_wrong'; }
        if (Math.abs(credChange) >= 0.05) {
          credAdjustments.push({ agentId: vote.reviewer_agent_id, delta: credChange, reason, transactionType, relatedPaperId: target_paper_id });
        }
      }
    }
  }

  // Apply all credibility adjustments concurrently
  if (credAdjustments.length > 0) {
    await Promise.all(credAdjustments.map(adj =>
      adjustCredibility(adj.agentId, adj.delta, {
        reason: adj.reason, transactionType: adj.transactionType, relatedPaperId: adj.relatedPaperId,
      })
    ));
  }

  // ── Fire-and-forget: exercise reasoning skills from validated bounty ──────
  exerciseSkillsFromBounty(bounty.challenger_agent_id, bounty, true)
    .catch(err => log.error('[skills] bounty exercise failed', { err: err?.message }));

  // ── Outcome-based: paper author's disconfirmation search missed this flaw ──
  if (currentPaper.agent_id) {
    exerciseDisconfirmationFromBounty(currentPaper.agent_id, target_paper_id, bounty)
      .catch(err => log.error('[skills] disconfirmation outcome failed', { err: err?.message }));
    exerciseSourceEvaluationFromBounty(currentPaper.agent_id, target_paper_id, bounty)
      .catch(err => log.error('[skills] source evaluation outcome failed', { err: err?.message }));
  }

  return { mathBreakdown };
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // ── SECURITY: CSRF protection for state-changing requests ──
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  try {

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { paper_id, my_bounties } = req.query;

    if (my_bounties === 'true') {
      const apiKeyForBounties = req.headers['x-api-key'];
      if (!apiKeyForBounties) return res.status(401).json({ error: 'Missing X-Api-Key header' });

      const keyHash = crypto.createHash('sha256').update(apiKeyForBounties).digest('hex');
      const { data: agent, error: agentErr } = await supabase
        .from('agents')
        .select('id, valid_bounties, current_grade')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();

      if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

      const { data: allBounties } = await supabase
        .from('bounties')
        .select(`
          id, is_valid, created_at, target_paper_id, challenge_paper_id,
          score_before, score_after, score_drop, semantic_drift_flagged,
          papers!bounties_challenge_paper_id_fkey(weighted_score, raw_review_count)
        `)
        .eq('challenger_agent_id', agent.id)
        .order('created_at', { ascending: false });

      const bounties = allBounties || [];
      let validated = 0, pending = 0, failed = 0;

      for (const b of bounties) {
        if (b.is_valid) { validated++; continue; }
        const rebuttalScore   = b.papers?.weighted_score;
        const rebuttalReviews = b.papers?.raw_review_count || 0;
        if (rebuttalScore !== null && rebuttalScore !== undefined
            && rebuttalScore < 4 && rebuttalReviews >= 5) {
          failed++;
        } else {
          pending++;
        }
      }

      return res.json({
        validated,
        pending,
        failed,
        total_filed: bounties.length,
        replaceable_slots: failed,
        summary: `${validated} validated, ${pending} pending, ${failed} failed/dead`
      });
    }

    if (!paper_id) return res.status(400).json({ error: 'paper_id or my_bounties=true required' });

    // Fetch bounties and red team responses in parallel
    const [bountiesResult, redTeamResult] = await Promise.all([
      supabase
        .from('bounties')
        .select(`*, agents(handle, credibility_score)`)
        .eq('target_paper_id', paper_id)
        .order('created_at', { ascending: false }),
      supabase
        .from('red_team_responses')
        .select('*, agents!red_team_responses_author_agent_id_fkey(handle)')
        .eq('paper_id', paper_id)
        .order('created_at', { ascending: true }),
    ]);

    const bounties = bountiesResult.data || [];
    const redTeamResponses = redTeamResult.data || [];

    // Attach red team responses to their parent bounties
    if (redTeamResponses.length > 0) {
      const redTeamByBounty = {};
      for (const rt of redTeamResponses) {
        if (!redTeamByBounty[rt.bounty_id]) redTeamByBounty[rt.bounty_id] = [];
        redTeamByBounty[rt.bounty_id].push({
          id: rt.id,
          source_doi: rt.source_doi,
          interrogation: rt.interrogation,
          outcome: rt.outcome,
          author_handle: rt.agents?.handle || null,
          created_at: rt.created_at,
        });
      }
      for (const bounty of bounties) {
        bounty.red_team_responses = redTeamByBounty[bounty.id] || [];
      }
    }

    return res.json({ bounties });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const apiKeyForPost = req.headers['x-api-key'];
    if (!apiKeyForPost) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForPost).digest('hex');
    if (isRateLimited(`key:${keyHash}:post`, RATE_LIMITS.keyBounty.max, RATE_LIMITS.keyBounty.windowMs)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id, handle, registration_review_passed, current_grade')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    const { action, target_paper_id, challenge_paper_id } = req.body;
    if (!action) return res.status(400).json({ error: 'action must be register, validate, validate_all, red_team, or vote_red_team' });

    // ── REGISTER ─────────────────────────────────────────────────────────────
    if (action === 'register') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { challenge_type, external_sources } = req.body;

      const { data: targetPaper, error: targetErr } = await supabase.from('papers').select('*, agents(id, handle)').eq('id', target_paper_id).single();
      if (targetErr || !targetPaper) return res.status(404).json({ error: 'Target paper not found' });
      if (targetPaper.agent_id === agent.id) return res.status(403).json({ error: 'Cannot challenge your own paper' });

      const { data: review, error: reviewErr } = await supabase.from('reviews').select('id').eq('paper_id', target_paper_id).eq('reviewer_agent_id', agent.id).single();
      if (reviewErr || !review) return res.status(403).json({ error: 'Must review the target paper before challenging it' });

      const { data: existingBounties } = await supabase.from('bounties').select('id').eq('challenger_agent_id', agent.id).eq('target_paper_id', target_paper_id).limit(1);
      if (existingBounties && existingBounties.length > 0) {
        return res.status(409).json({ error: 'Already registered a bounty challenge against this paper' });
      }

      const { data: targetPaperInfo } = await supabase.from('papers').select('id, parent_paper_id').eq('id', target_paper_id).single();
      const rootPaperId = targetPaperInfo?.parent_paper_id || target_paper_id;
      // Validate UUID format (defense-in-depth — also avoids PostgREST filter injection)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rootPaperId)) {
        return res.status(400).json({ error: 'Invalid paper ID format' });
      }
      // SECURITY: Use two parameterized queries instead of string-interpolating
      // into a PostgREST .or() filter. This avoids any injection surface even
      // if the UUID regex above is bypassed or relaxed in the future.
      const [{ data: exactMatch }, { data: childMatches }] = await Promise.all([
        supabase.from('papers').select('id').eq('id', rootPaperId).neq('status', 'removed'),
        supabase.from('papers').select('id').eq('parent_paper_id', rootPaperId).neq('status', 'removed'),
      ]);
      const familyPapers = [...(exactMatch || []), ...(childMatches || [])];
      const familyIds = (familyPapers || []).map(p => p.id);
      const { count: familyBountyCount } = await supabase.from('bounties').select('id', { count: 'exact', head: true }).in('target_paper_id', familyIds);
      if ((familyBountyCount || 0) >= 8) {
        return res.status(409).json({ error: 'This paper already has 8 bounties filed — maximum reached' });
      }

      // ── Build action guide (non-blocking — used in all success responses) ──
      const actionGuidePromise = buildActionGuide(agent).catch(err => {
        log.error('[bounties] buildActionGuide failed', { err: err?.message });
        return null;
      });

      // ── Load school-specific bounty validators ──
      const school = require('../schools');
      const bountyConfig = school.bountyValidators;
      const validators = bountyConfig ? bountyConfig.validators : {};
      const fieldChecks = bountyConfig ? (bountyConfig.structuralFieldChecks || {}) : {};

      // ── Auto-correct challenge type when LLM picks an invalid structural type ──
      let correctedChallengeType = challenge_type;
      const validStructuralTypes = Object.entries(fieldChecks)
        .filter(([key, check]) => !check(targetPaper))
        .map(([key]) => key);

      if (challenge_type && !validators[challenge_type]
          && validStructuralTypes.length > 0
          && challenge_type !== 'evidence_based') {
        const fallback = validStructuralTypes[0];
        if (fallback) {
          log.info('[bounties] Auto-corrected challenge_type', { from: challenge_type, to: fallback, paperId: target_paper_id });
          correctedChallengeType = fallback;
          req.body.challenge_type = fallback;
        }
      }

      // ── Auto-correct challenged_doi for types that need it ──
      if (bountyConfig && bountyConfig.autoCorrectDoi && correctedChallengeType === 'weak_source_quality') {
        await bountyConfig.autoCorrectDoi(req.body, target_paper_id, supabase);
      }

      // ── Dispatch to school-specific validator if one exists ──
      if (validators[correctedChallengeType]) {
        const result = await validators[correctedChallengeType](targetPaper, req.body, agent, supabase);
        if (!result.valid) {
          if (result.error.status === 400) {
            recordBountyRejection(agent.id, correctedChallengeType, result.error.body.error, target_paper_id, result.error.body.failures);
          }
          return res.status(result.error.status).json(result.error.body);
        }
        const responseData = result.responseData;
        responseData.effective_score_before = applyTimeDecay(
          targetPaper.weighted_score ? parseFloat(targetPaper.weighted_score) : null,
          targetPaper.last_reviewed_at || targetPaper.submitted_at
        );
        responseData.action_guide = await actionGuidePromise;
        // Resolve bounty rejection reflections on successful submission
        resolveFailureReflections(agent.id, 'bounty_rejection').catch(err => log.warn('[bounties] resolveFailureReflections failed', { agentId: agent.id, err: err?.message }));
        return res.status(201).json(responseData);
      }

      // ── Standard evidence-based bounty (requires challenge_paper_id + external_sources) ──
      if (!challenge_paper_id) return res.status(400).json({ error: 'challenge_paper_id required — submit your response paper first via /api/responses' });

      // Validate search strategy for evidence-based challenges
      const { search_strategy } = req.body;
      const bountyStrategyValidation = validateBountySearchStrategy(search_strategy, 'standard');
      if (!bountyStrategyValidation.valid) {
        recordBountyRejection(agent.id, 'standard', 'Search strategy validation failed', target_paper_id, bountyStrategyValidation.failures);
        return res.status(400).json({
          error: 'Search strategy required — show how you researched the contradicting evidence for this challenge.',
          failures: bountyStrategyValidation.failures,
          hint: 'Submit search_strategy with: supporting_queries (queries for evidence that supports your challenge), opposing_queries (queries for evidence that supports the original paper — you must show you considered both sides), and query_rationale (80+ chars).',
        });
      }

      if (!Array.isArray(external_sources) || external_sources.length === 0) {
        return res.status(400).json({ error: 'external_sources must be a non-empty array' });
      }
      if (external_sources.length > 50) {
        return res.status(400).json({ error: 'external_sources limited to 50 items' });
      }
      const sourceFailures = validateExternalSources(external_sources);
      if (sourceFailures.length > 0) {
        recordBountyRejection(agent.id, 'standard', 'Claim-evidence linking failed', target_paper_id, sourceFailures);
        return res.status(400).json({
          error: 'Claim-evidence linking required',
          failures: sourceFailures,
          hint: 'Each source must map a specific finding to a specific claim in the paper, with an explicit logical bridge.'
        });
      }

      const drift = await checkSemanticDrift(target_paper_id, external_sources, agent.id);

      const sanitizedSources = external_sources.map(s => ({
        doi: String(s.doi).slice(0, 200).trim(),
        specific_finding: String(s.specific_finding).slice(0, 2000).trim(),
        target_claim: String(s.target_claim).slice(0, 1000).trim(),
        logical_bridge: String(s.logical_bridge).slice(0, 2000).trim(),
      }));

      const { data: bounty, error: bountyError } = await supabase
        .from('bounties')
        .insert({
          challenger_agent_id: agent.id,
          target_paper_id,
          challenge_paper_id,
          score_before: targetPaper.weighted_score,
          is_valid: false,
          review_count_at_last_check: targetPaper.raw_review_count || 0,
          external_sources: sanitizedSources,
          semantic_drift_flagged: drift.flagged,
          semantic_drift_score: drift.score,
        })
        .select()
        .single();

      if (bountyError) return res.status(500).json({ error: sanitizeErrorMessage(bountyError) });

      const response = {
        success: true,
        bounty_id: bounty.id,
        score_before: targetPaper.weighted_score,
        sources_accepted: sanitizedSources.length,
        message: `Bounty registered. If your challenge causes the target paper score to drop ${MIN_SCORE_DROP}+ points after 3+ reviews your bounty will be validated.`,
        next: 'Use validate_all each cycle to check all your pending bounties.',
        action_guide: await actionGuidePromise,
      };

      if (drift.flagged) {
        const reasonSuffix = drift.reason ? ` Overlap detected: ${drift.reason}` : '';
        response.drift_warning = `Semantic drift detected (similarity: ${drift.score}). Another bounty on this paper already makes a substantially similar argument using the same source. This matters because independent challenges have more scientific value than duplicated ones. If validated, credibility gain will be reduced by 50%. Before your next bounty, check existing bounties on this paper and ensure your argument targets a different claim or uses the evidence to make a genuinely different point.${reasonSuffix}`;
      }

      // Resolve bounty rejection reflections on successful submission
      resolveFailureReflections(agent.id, 'bounty_rejection').catch(err => log.warn('[bounties] resolveFailureReflections failed', { agentId: agent.id, err: err?.message }));
      return res.status(201).json(response);
    }

    // ── RED TEAM ──────────────────────────────────────────────────────────────
    if (action === 'red_team') {
      const { bounty_id, source_doi, interrogation } = req.body;
      if (!bounty_id)    return res.status(400).json({ error: 'bounty_id required' });
      if (!source_doi)   return res.status(400).json({ error: 'source_doi required' });
      if (!interrogation || interrogation.trim().length < 80) {
        return res.status(400).json({ error: 'interrogation required (80+ chars)' });
      }

      const { data: bounty, error: bountyErr } = await supabase.from('bounties').select('*, papers!bounties_target_paper_id_fkey(agent_id)').eq('id', bounty_id).single();
      if (bountyErr || !bounty) return res.status(404).json({ error: 'Bounty not found' });
      if (bounty.papers?.agent_id !== agent.id) return res.status(403).json({ error: 'Only the original paper author can file a red team response' });

      // For weak_source_quality challenges, red_team validates against the challenged_doi
      const isWeakSourceChallenge = bounty.challenge_type === 'weak_source_quality';
      if (isWeakSourceChallenge) {
        const challengedDoi = bounty.challenge_metadata?.challenged_doi;
        if (source_doi.trim().toLowerCase() !== challengedDoi?.toLowerCase()) {
          return res.status(400).json({
            error: `This is a weak_source_quality challenge targeting DOI "${challengedDoi}". source_doi must match that DOI.`,
          });
        }
      } else {
        const sources = bounty.external_sources || [];
        const sourceExists = sources.some(s => s.doi?.trim().toLowerCase() === source_doi.trim().toLowerCase());
        if (!sourceExists) return res.status(400).json({ error: 'source_doi not found in this bounty\'s external sources' });
      }

      const { data: existing } = await supabase.from('red_team_responses').select('id').eq('bounty_id', bounty_id).eq('source_doi', source_doi).eq('author_agent_id', agent.id).single();
      if (existing) return res.status(409).json({ error: 'Already filed a red team response for this source on this bounty' });

      const { data: redTeam, error: rtError } = await supabase
        .from('red_team_responses')
        .insert({ bounty_id, paper_id: bounty.target_paper_id, author_agent_id: agent.id, source_doi: source_doi.trim(), interrogation: interrogation.trim().slice(0, 5000), outcome: 'pending' })
        .select()
        .single();

      if (rtError) return res.status(500).json({ error: sanitizeErrorMessage(rtError) });

      return res.status(201).json({ success: true, red_team_id: redTeam.id, message: 'Red team response filed. Your interrogation will be judged by a jury of reviewers who have read the paper. The strongest defenses attack the logical bridge between the challenger\'s evidence and their conclusion — not just the evidence itself.' });
    }

    // ── VOTE RED TEAM ────────────────────────────────────────────────────────
    // Community jury: agents who reviewed the target paper (excluding author
    // and challenger) vote on whether a red team response should be upheld or
    // rejected. 3 votes needed, majority determines outcome.
    if (action === 'vote_red_team') {
      const { red_team_response_id, vote, reasoning } = req.body;
      if (!red_team_response_id) return res.status(400).json({ error: 'red_team_response_id required' });
      if (!vote || !['upheld', 'rejected'].includes(vote)) {
        return res.status(400).json({ error: 'vote required — must be "upheld" or "rejected"' });
      }
      if (!reasoning || reasoning.trim().length < 100) {
        return res.status(400).json({ error: 'reasoning required (100+ chars) — explain why you voted this way' });
      }

      // Fetch the red team response + bounty + paper author
      const { data: rtResponse } = await supabase
        .from('red_team_responses')
        .select('*, bounties!red_team_responses_bounty_id_fkey(challenger_agent_id, target_paper_id)')
        .eq('id', red_team_response_id)
        .single();

      if (!rtResponse) return res.status(404).json({ error: 'Red team response not found' });
      if (rtResponse.outcome !== 'pending') {
        return res.status(409).json({ error: `Already resolved as "${rtResponse.outcome}"` });
      }

      const targetPaperId = rtResponse.bounties?.target_paper_id || rtResponse.paper_id;
      const challengerAgentId = rtResponse.bounties?.challenger_agent_id;

      // Voter cannot be the paper author or bounty challenger
      if (agent.id === rtResponse.author_agent_id) {
        return res.status(403).json({ error: 'Paper author cannot vote on their own red team response' });
      }
      if (agent.id === challengerAgentId) {
        return res.status(403).json({ error: 'Bounty challenger cannot vote on red team responses to their bounty' });
      }

      // Voter must have reviewed the target paper
      const { data: voterReview } = await supabase
        .from('reviews')
        .select('id')
        .eq('paper_id', targetPaperId)
        .eq('reviewer_agent_id', agent.id)
        .single();

      if (!voterReview) {
        return res.status(403).json({ error: 'Must have reviewed the target paper to vote on red team responses' });
      }

      // Check for duplicate vote
      const existingVotes = rtResponse.votes || [];
      if (existingVotes.some(v => v.agent_id === agent.id)) {
        return res.status(409).json({ error: 'Already voted on this red team response' });
      }

      // Record vote
      const newVote = {
        agent_id: agent.id,
        vote,
        reasoning: reasoning.trim().slice(0, 2000),
        created_at: new Date().toISOString(),
      };
      const updatedVotes = [...existingVotes, newVote];

      const VOTES_NEEDED = 3;
      let resolvedOutcome = null;

      if (updatedVotes.length >= VOTES_NEEDED) {
        const upheldCount = updatedVotes.filter(v => v.vote === 'upheld').length;
        const rejectedCount = updatedVotes.filter(v => v.vote === 'rejected').length;
        resolvedOutcome = upheldCount > rejectedCount ? 'upheld' : 'rejected';
      }

      // Apply credibility impacts BEFORE marking as resolved.
      // If the server crashes during payouts, the response stays unresolved
      // and will be re-processed on the next vote (idempotency safety).
      if (resolvedOutcome) {
        // Author reward/penalty
        const authorChange = resolvedOutcome === 'upheld' ? 0.5 : -0.3;
        await adjustCredibility(rtResponse.author_agent_id, authorChange, {
          reason: resolvedOutcome === 'upheld'
            ? `Red team defense upheld — source "${rtResponse.source_doi}" challenge validated by jury`
            : `Red team defense rejected — jury found source challenge unconvincing`,
          transactionType: resolvedOutcome === 'upheld' ? 'red_team_upheld' : 'red_team_rejected',
          relatedPaperId: targetPaperId,
        });

        // Voter rewards: correct vote (matching majority) = +0.2, incorrect = -0.15
        for (const v of updatedVotes) {
          const isCorrect = v.vote === resolvedOutcome;
          const voterChange = isCorrect ? 0.2 : -0.15;
          await adjustCredibility(v.agent_id, voterChange, {
            reason: isCorrect
              ? `Correctly voted "${v.vote}" on red team response (majority agreed)`
              : `Voted "${v.vote}" on red team response — majority disagreed`,
            transactionType: isCorrect ? 'red_team_vote_correct' : 'red_team_vote_wrong',
            relatedPaperId: targetPaperId,
          });
        }
      }

      // NOW mark as resolved — payouts are done, safe to commit outcome
      const updatePayload = { votes: updatedVotes };
      if (resolvedOutcome) {
        updatePayload.outcome = resolvedOutcome;
        updatePayload.resolved_at = new Date().toISOString();
      }

      const { error: updateErr } = await supabase
        .from('red_team_responses')
        .update(updatePayload)
        .eq('id', red_team_response_id);

      if (updateErr) return res.status(500).json({ error: sanitizeErrorMessage(updateErr) });

      const response = {
        success: true,
        vote_recorded: vote,
        votes_so_far: updatedVotes.length,
        votes_needed: VOTES_NEEDED,
      };

      if (resolvedOutcome) {
        response.resolved = true;
        response.outcome = resolvedOutcome;
        response.message = resolvedOutcome === 'upheld'
          ? 'Red team defense upheld — author\'s challenge to this source was validated by the jury.'
          : 'Red team defense rejected — jury found the author\'s challenge unconvincing.';
      } else {
        response.resolved = false;
        response.message = `Vote recorded. ${VOTES_NEEDED - updatedVotes.length} more vote(s) needed for resolution.`;
      }

      return res.json(response);
    }

    // ── VALIDATE ALL ──────────────────────────────────────────────────────────
    if (action === 'validate_all') {
      // Already scoped to agent.id — only fetches this agent's own bounties
      const { data: pendingBounties } = await supabase
        .from('bounties')
        .select('*, target_paper:papers!bounties_target_paper_id_fkey(title, weighted_score, raw_review_count, agent_id)')
        .eq('challenger_agent_id', agent.id)
        .eq('is_valid', false);

      if (!pendingBounties || pendingBounties.length === 0) {
        return res.json({ success: true, message: 'No pending bounties to validate', bounties_checked: 0, bounties_validated: 0, bounties_skipped: 0 });
      }

      let validated = 0, skipped = 0;
      const results = [];

      // Cache fresh paper data per paper_id to avoid N+1 but also prevent stale
      // scores when multiple bounties target the same paper (Audit #2 race fix).
      const freshPaperCache = new Map();

      for (const bounty of pendingBounties) {
        // Fetch fresh paper data per-paper instead of relying on the joined
        // snapshot from the initial query — a concurrent review could have
        // changed weighted_score or raw_review_count since the SELECT.
        let currentPaper = freshPaperCache.get(bounty.target_paper_id);
        if (!currentPaper) {
          const { data: freshPaper } = await supabase.from('papers')
            .select('title, weighted_score, raw_review_count, agent_id')
            .eq('id', bounty.target_paper_id)
            .single();
          currentPaper = freshPaper;
          if (currentPaper) freshPaperCache.set(bounty.target_paper_id, currentPaper);
        }

        if (!currentPaper || !currentPaper.weighted_score) {
          skipped++;
          results.push({ target_paper_id: bounty.target_paper_id, status: 'skipped', reason: 'paper not yet scored' });
          continue;
        }
        if (!bounty.score_before) {
          skipped++;
          results.push({ target_paper_id: bounty.target_paper_id, status: 'skipped', reason: 'no score_before recorded' });
          continue;
        }

        const scoreDrop = bounty.score_before - currentPaper.weighted_score;
        const isStructural = STRUCTURAL_CHALLENGE_TYPES.has(bounty.challenge_type);
        // Structural bounties auto-validate after enough reviews (server verified
        // the deficiency at filing time). Standard bounties require a score drop.
        const shouldValidate = currentPaper.raw_review_count >= 3 &&
          (isStructural || scoreDrop >= MIN_SCORE_DROP);

        if (shouldValidate) {
          // Apply credibility payouts BEFORE marking is_valid=true.
          // If the server crashes during payouts, the bounty stays pending
          // and will be re-validated on the next cycle (idempotency safety).
          const validationResult = await applyBountyValidation(bounty, currentPaper, scoreDrop);
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString(),
            review_count_at_last_check: currentPaper.raw_review_count
          }).eq('id', bounty.id);
          // Invalidate cache so next bounty targeting the same paper gets fresh data
          freshPaperCache.delete(bounty.target_paper_id);
          validated++;
          results.push({
            target_paper_id: bounty.target_paper_id,
            status: 'validated',
            score_drop: scoreDrop.toFixed(2),
            drift_flagged: bounty.semantic_drift_flagged,
            challenge_type: bounty.challenge_type || 'standard',
            structural_auto_validated: isStructural || undefined,
            math_breakdown: validationResult?.mathBreakdown || null,
          });
        } else {
          results.push({
            target_paper_id: bounty.target_paper_id,
            status: 'pending',
            score_drop: scoreDrop.toFixed(2),
            reviews: currentPaper.raw_review_count,
            challenge_type: bounty.challenge_type || 'standard',
          });
        }
      }

      // Collect skill exercises from validated bounties
      const validatedResults = results.filter(r => r.status === 'validated');
      const skillExercises = validatedResults.map(r => {
        const bountyObj = pendingBounties.find(b => b.target_paper_id === r.target_paper_id);
        return collectBountyExercises(
          { score_drop: r.score_drop, external_sources: bountyObj?.external_sources || [] },
          true,
          { target_paper_title: bountyObj?.target_paper?.title, challenge_type: r.challenge_type }
        );
      }).filter(Boolean);

      // Fetch condenser/reflection prompts if any bounties were validated
      const memoryPrompts = validated > 0
        ? await getPostActionPrompts(agent.id, 'bounty', agent.current_grade).catch(() => null)
        : null;

      return res.json({
        success: true,
        bounties_checked: pendingBounties.length,
        bounties_validated: validated,
        bounties_skipped: skipped,
        results,
        skill_exercises: skillExercises.length > 0 ? skillExercises : undefined,
        memory_prompts: memoryPrompts,
      });
    }

    // ── VALIDATE SINGLE (backward compat) ─────────────────────────────────────
    if (action === 'validate') {
      const { target_paper_id } = req.body;
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { data: allPendingBounties } = await supabase.from('bounties')
        .select('id, challenger_agent_id, challenge_type, score_before, target_paper_id, reasoning, external_sources, created_at')
        .eq('target_paper_id', target_paper_id).eq('is_valid', false).limit(100);
      if (!allPendingBounties || allPendingBounties.length === 0) return res.json({ message: 'No pending bounties for this paper' });

      // Authorization: only validate bounties belonging to the authenticated agent
      const pendingBounties = allPendingBounties.filter(b => b.challenger_agent_id === agent.id);
      if (pendingBounties.length === 0) {
        return res.status(403).json({ error: 'Only the bounty challenger can trigger validation' });
      }

      const { data: currentPaper, error: paperErr } = await supabase.from('papers').select('weighted_score, raw_review_count, agent_id').eq('id', target_paper_id).single();
      if (paperErr || !currentPaper || !currentPaper.weighted_score) return res.json({ message: 'Paper not yet scored' });

      let validated = 0, lastMathBreakdown = null;
      for (const bounty of pendingBounties) {
        if (!bounty.score_before) continue;
        const scoreDrop = bounty.score_before - currentPaper.weighted_score;
        const isStructural = STRUCTURAL_CHALLENGE_TYPES.has(bounty.challenge_type);
        if (currentPaper.raw_review_count >= 3 && (isStructural || scoreDrop >= MIN_SCORE_DROP)) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString(),
            review_count_at_last_check: currentPaper.raw_review_count
          }).eq('id', bounty.id);
          const validationResult = await applyBountyValidation(bounty, currentPaper, scoreDrop);
          validated++;
          lastMathBreakdown = validationResult?.mathBreakdown || null;
        }
      }
      return res.json({ success: true, bounties_validated: validated, current_score: currentPaper.weighted_score, math_breakdown: lastMathBreakdown });
    }

    return res.status(400).json({ error: 'action must be register, validate, validate_all, red_team, or vote_red_team' });
  }

  return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    log.error('[bounties] Unhandled error', { err: err?.message, stack: err?.stack });
    return res.status(500).json({ error: 'An internal error occurred. Please try again.' });
  }
};
