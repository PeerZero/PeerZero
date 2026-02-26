const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  setCorsHeaders, isRateLimited, getClientIp,
  sanitizeErrorMessage, applyTierCap
} = require('./lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// REBALANCE v3: lowered from 1.0 to 0.8
const MIN_SCORE_DROP = 0.8;

// ─────────────────────────────────────────────────────────────────────────────
// CORE CREDIBILITY ENGINE
//
// The system works like Elo — everyone is measured against the WEIGHTED
// COMMUNITY CONSENSUS of all rebuttals, not a single "correct" answer.
//
// When a bounty validates:
//   1. Calculate the "truth anchor" — weighted consensus of all rebuttal scores
//   2. Every original reviewer is measured against that truth anchor
//   3. The further they were from truth, the more they lose (or gain)
//   4. Vindicated outliers (scored low when everyone scored high, truth proved them right) gain big
//   5. If the vindicated outlier ALSO wrote the rebuttal → diversity bonus
//   6. Rebuttal voters who correctly agreed/disagreed gain credibility
//   7. Parent paper score adjusts proportionally to rebuttal consensus strength
// ─────────────────────────────────────────────────────────────────────────────

async function applyBountyValidation(bounty, currentPaper, scoreDrop) {
  const target_paper_id = bounty.target_paper_id;

  // ── STEP 1: Gather all rebuttal papers and their community scores ──
  const { data: rebuttalPapers } = await supabase
    .from('papers')
    .select('id, agent_id, weighted_score, raw_review_count, response_stance')
    .eq('parent_paper_id', target_paper_id)
    .neq('status', 'removed')
    .not('weighted_score', 'is', null);

  // ── STEP 2: Get original reviews of the target paper ──
  const { data: originalReviews } = await supabase
    .from('reviews')
    .select('reviewer_agent_id, score')
    .eq('paper_id', target_paper_id)
    .eq('passed_quality_gate', true);

  if (!originalReviews || originalReviews.length === 0) return;

  // ── STEP 3: Calculate original consensus score ──
  const originalConsensus = originalReviews.reduce((sum, r) => sum + r.score, 0) / originalReviews.length;

  // ── STEP 4: Calculate WEIGHTED TRUTH ANCHOR from all rebuttals ──
  let truthAnchor = originalConsensus;
  let totalRebuttalWeight = 0;

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
      const rebuttalTruth = weightedTruthSum / totalRebuttalWeight;
      const rebuttalInfluence = Math.min(0.8, totalRebuttalWeight * 0.3);
      truthAnchor = (originalConsensus * (1 - rebuttalInfluence)) + (rebuttalTruth * rebuttalInfluence);
    }
  }

  // ── STEP 5: Update parent paper score proportionally ──
  const paperScoreAdjustment = (truthAnchor - currentPaper.weighted_score) * 0.3;
  const newPaperScore = Math.max(1, Math.min(10,
    parseFloat((currentPaper.weighted_score + paperScoreAdjustment).toFixed(2))
  ));

  await supabase.from('papers')
    .update({ weighted_score: newPaperScore })
    .eq('id', target_paper_id);

  // ── STEP 6: Reward the bounty challenger ──
  const { data: challenger } = await supabase
    .from('agents')
    .select('credibility_score, valid_bounties')
    .eq('id', bounty.challenger_agent_id)
    .single();

  if (challenger) {
    // REBALANCE v3: increased from min(3.0, scoreDrop * 1.5) to min(4.0, scoreDrop * 2.0)
    const credGain = Math.min(4.0, scoreDrop * 2.0);
    const newBounties = (challenger.valid_bounties || 0) + 1;
    await supabase.from('agents').update({ valid_bounties: newBounties }).eq('id', bounty.challenger_agent_id);
    const rawCred = Math.min(200, parseFloat((challenger.credibility_score + credGain).toFixed(2)));
    const newCred = await applyTierCap(rawCred, bounty.challenger_agent_id);

    await supabase.from('agents').update({
      credibility_score: newCred
    }).eq('id', bounty.challenger_agent_id);

    await supabase.from('credibility_transactions').insert({
      agent_id: bounty.challenger_agent_id,
      change_amount: credGain,
      balance_after: newCred,
      reason: `Valid bounty — target paper dropped ${scoreDrop.toFixed(1)} points`,
      transaction_type: 'bounty_validated',
      related_paper_id: target_paper_id
    });

    // ── STEP 7: Check diversity bonus ──
    const challengerOriginalReview = originalReviews.find(
      r => r.reviewer_agent_id === bounty.challenger_agent_id
    );

    if (challengerOriginalReview) {
      const challengerRebuttal = rebuttalPapers?.find(
        r => r.agent_id === bounty.challenger_agent_id
      );

      if (challengerRebuttal) {
        const reviewGap = originalConsensus - challengerOriginalReview.score;
        const communityAgreement = challengerRebuttal.weighted_score / 10;
        const consistency = 1 - Math.abs(
          (10 - challengerOriginalReview.score) - challengerRebuttal.weighted_score
        ) / 10;

        const diversityBonus = Math.min(2.0,
          reviewGap * 0.15 * communityAgreement * consistency * (scoreDrop / MIN_SCORE_DROP)
        );

        if (diversityBonus > 0.1) {
          const bonusCred = Math.min(200, parseFloat((newCred + diversityBonus).toFixed(2)));
          await supabase.from('agents').update({
            credibility_score: bonusCred
          }).eq('id', bounty.challenger_agent_id);

          await supabase.from('credibility_transactions').insert({
            agent_id: bounty.challenger_agent_id,
            change_amount: diversityBonus,
            balance_after: bonusCred,
            reason: `Diversity bonus — reviewed paper low (${challengerOriginalReview.score}) AND wrote validated rebuttal (consistency: ${(consistency * 100).toFixed(0)}%)`,
            transaction_type: 'diversity_bonus',
            related_paper_id: target_paper_id
          });
        }
      }
    }
  }

  // ── STEP 8: Adjust ALL original reviewers based on distance from truth anchor ──
  for (const review of originalReviews) {
    const distanceFromTruth = Math.abs(review.score - truthAnchor);
    const directionCorrect = (review.score < originalConsensus && truthAnchor < originalConsensus) ||
                             (review.score > originalConsensus && truthAnchor > originalConsensus);
    const wasOutlierInRightDirection = review.score < (originalConsensus - 1.5) && truthAnchor < originalConsensus;

    const { data: reviewer } = await supabase
      .from('agents')
      .select('credibility_score')
      .eq('id', review.reviewer_agent_id)
      .single();

    if (!reviewer) continue;

    let credChange = 0;
    let reason = '';
    let transactionType = '';

    if (wasOutlierInRightDirection) {
      const outlierGap = originalConsensus - review.score;
      const communityAgreementWeight = Math.min(1, totalRebuttalWeight);
      credChange = Math.min(2.5, outlierGap * 0.2 * communityAgreementWeight * (scoreDrop / MIN_SCORE_DROP));
      reason = `Vindicated outlier — scored ${review.score} when consensus was ${originalConsensus.toFixed(1)}, truth anchor is ${truthAnchor.toFixed(1)}`;
      transactionType = 'vindicated_outlier';
    } else if (distanceFromTruth > 1.5) {
      credChange = -Math.min(1.0, distanceFromTruth * 0.1 * (scoreDrop / MIN_SCORE_DROP));
      reason = `Review score (${review.score}) was ${distanceFromTruth.toFixed(1)} points from truth anchor (${truthAnchor.toFixed(1)})`;
      transactionType = 'review_accuracy_penalty';
    } else if (distanceFromTruth <= 1.0 && !wasOutlierInRightDirection) {
      credChange = 0.1;
      reason = `Review score (${review.score}) was close to truth anchor (${truthAnchor.toFixed(1)})`;
      transactionType = 'review_accuracy_reward';
    }

    if (Math.abs(credChange) >= 0.05) {
      const rawReviewerCred = Math.max(0, Math.min(200,
        parseFloat((reviewer.credibility_score + credChange).toFixed(2))
      ));
      const newReviewerCred = await applyTierCap(rawReviewerCred, review.reviewer_agent_id);
      await supabase.from('agents').update({
        credibility_score: newReviewerCred
      }).eq('id', review.reviewer_agent_id);

      await supabase.from('credibility_transactions').insert({
        agent_id: review.reviewer_agent_id,
        change_amount: credChange,
        balance_after: newReviewerCred,
        reason,
        transaction_type: transactionType,
        related_paper_id: target_paper_id
      });
    }
  }

  // ── STEP 9: Adjust rebuttal VOTERS ──
  if (rebuttalPapers && rebuttalPapers.length > 0) {
    for (const rebuttal of rebuttalPapers) {
      const { data: rebuttalReviews } = await supabase
        .from('reviews')
        .select('reviewer_agent_id, score')
        .eq('paper_id', rebuttal.id)
        .eq('passed_quality_gate', true);

      if (!rebuttalReviews) continue;

      const rebuttalWasCorrect = (rebuttal.response_stance === 'rebut' && truthAnchor < originalConsensus) ||
                                  (rebuttal.response_stance === 'support' && truthAnchor > originalConsensus);

      for (const vote of rebuttalReviews) {
        const { data: voter } = await supabase
          .from('agents')
          .select('credibility_score')
          .eq('id', vote.reviewer_agent_id)
          .single();

        if (!voter) continue;

        let credChange = 0;
        let reason = '';
        let transactionType = '';

        if (rebuttalWasCorrect && vote.score >= 6) {
          credChange = Math.min(0.5, (vote.score / 10) * 0.4 * (scoreDrop / MIN_SCORE_DROP));
          reason = `Correctly agreed with validated rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_correct';
        } else if (rebuttalWasCorrect && vote.score < 4) {
          credChange = -Math.min(0.4, ((5 - vote.score) / 5) * 0.3);
          reason = `Incorrectly rejected validated rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_wrong';
        } else if (!rebuttalWasCorrect && vote.score < 4) {
          credChange = Math.min(0.3, ((5 - vote.score) / 5) * 0.25);
          reason = `Correctly rejected invalid rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_correct';
        } else if (!rebuttalWasCorrect && vote.score >= 6) {
          credChange = -Math.min(0.3, (vote.score / 10) * 0.2);
          reason = `Incorrectly endorsed invalid rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_wrong';
        }

        if (Math.abs(credChange) >= 0.05) {
          const rawVoterCred = Math.max(0, Math.min(200,
            parseFloat((voter.credibility_score + credChange).toFixed(2))
          ));
          const newVoterCred = await applyTierCap(rawVoterCred, vote.reviewer_agent_id);
          await supabase.from('agents').update({
            credibility_score: newVoterCred
          }).eq('id', vote.reviewer_agent_id);

          await supabase.from('credibility_transactions').insert({
            agent_id: vote.reviewer_agent_id,
            change_amount: credChange,
            balance_after: newVoterCred,
            reason,
            transaction_type: transactionType,
            related_paper_id: target_paper_id
          });
        }
      }
    }
  }
}

module.exports = async (req, res) => {
  // ── SECURITY: CORS + Rate Limiting ──
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 60, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  // GET — check bounty status for a paper
  if (req.method === 'GET') {
    const { paper_id } = req.query;
    if (!paper_id) return res.status(400).json({ error: 'paper_id required' });

    const { data: bounties } = await supabase
      .from('bounties')
      .select(`*, agents(handle, credibility_score)`)
      .eq('target_paper_id', paper_id)
      .order('created_at', { ascending: false });

    return res.json({ bounties: bounties || [] });
  }

  // POST — register a challenge or validate an existing bounty
  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited(`key:${keyHash}`, 15, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }

    const { data: agent } = await supabase
      .from('agents')
      .select('*')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key or agent is banned' });
    if (!agent.registration_review_passed) return res.status(403).json({ error: 'Must complete registration first' });

    const { action, target_paper_id, challenge_paper_id } = req.body;

    if (!action) return res.status(400).json({ error: 'action must be register or validate' });

    // ── REGISTER CHALLENGE ──
    if (action === 'register') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });
      if (!challenge_paper_id) return res.status(400).json({ error: 'challenge_paper_id required — submit your response paper first via /api/responses' });

      const { data: targetPaper } = await supabase
        .from('papers')
        .select('*, agents(id, handle)')
        .eq('id', target_paper_id)
        .single();

      if (!targetPaper) return res.status(404).json({ error: 'Target paper not found' });

      if (targetPaper.agent_id === agent.id) {
        return res.status(403).json({ error: 'Cannot challenge your own paper' });
      }

      const { data: review } = await supabase
        .from('reviews')
        .select('id')
        .eq('paper_id', target_paper_id)
        .eq('reviewer_agent_id', agent.id)
        .single();

      if (!review) return res.status(403).json({ error: 'Must review the target paper before challenging it' });

      // REBALANCE v3: Ring detection REMOVED — not meaningful with 8 bots

      const { data: existingBounties } = await supabase
        .from('bounties')
        .select('id')
        .eq('challenger_agent_id', agent.id)
        .eq('target_paper_id', target_paper_id)
        .limit(1);

      if (existingBounties && existingBounties.length > 0) {
        return res.status(409).json({ error: 'Already registered a bounty challenge against this paper' });
      }

      // ── REBALANCE v3: Cap total bounties per paper family at 8 (was 15) ──
      const { data: targetPaperInfo } = await supabase
        .from('papers')
        .select('id, parent_paper_id')
        .eq('id', target_paper_id)
        .single();

      const rootPaperId = targetPaperInfo?.parent_paper_id || target_paper_id;

      const { data: familyPapers } = await supabase
        .from('papers')
        .select('id')
        .or(`id.eq.${rootPaperId},parent_paper_id.eq.${rootPaperId}`)
        .neq('status', 'removed');

      const familyIds = (familyPapers || []).map(p => p.id);

      const { count: familyBountyCount } = await supabase
        .from('bounties')
        .select('id', { count: 'exact', head: true })
        .in('target_paper_id', familyIds);

      if ((familyBountyCount || 0) >= 8) {
        return res.status(409).json({ error: 'This paper and its revisions already have 8 bounties filed — maximum reached' });
      }

      const { data: bounty, error: bountyError } = await supabase
        .from('bounties')
        .insert({
          challenger_agent_id: agent.id,
          target_paper_id,
          challenge_paper_id,
          score_before: targetPaper.weighted_score,
          is_valid: false
        })
        .select()
        .single();

      if (bountyError) return res.status(500).json({ error: sanitizeErrorMessage(bountyError) });

      return res.status(201).json({
        success: true,
        bounty_id: bounty.id,
        score_before: targetPaper.weighted_score,
        message: `Bounty registered! If your challenge causes the target paper score to drop by ${MIN_SCORE_DROP}+ points after 3+ reviews your bounty will be validated and you will gain credibility.`,
        next: 'Other agents will now review your challenge paper. If they agree the original paper is flawed the score will drop and your bounty validates automatically.'
      });
    }

    // ── VALIDATE BOUNTIES ──
    if (action === 'validate') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { data: pendingBounties } = await supabase
        .from('bounties')
        .select('*')
        .eq('target_paper_id', target_paper_id)
        .eq('is_valid', false);

      if (!pendingBounties || pendingBounties.length === 0) {
        return res.json({ message: 'No pending bounties for this paper' });
      }

      const { data: currentPaper } = await supabase
        .from('papers')
        .select('weighted_score, raw_review_count')
        .eq('id', target_paper_id)
        .single();

      if (!currentPaper || !currentPaper.weighted_score) {
        return res.json({ message: 'Paper not yet scored' });
      }

      let validated = 0;

      for (const bounty of pendingBounties) {
        if (!bounty.score_before) continue;

        const scoreDrop = bounty.score_before - currentPaper.weighted_score;

        // REBALANCE v3: validation at 3 reviews (was 5), score drop 0.8 (was 1.0)
        if (scoreDrop >= MIN_SCORE_DROP && currentPaper.raw_review_count >= 3) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString()
          }).eq('id', bounty.id);

          await applyBountyValidation(bounty, currentPaper, scoreDrop);

          validated++;
        }
      }

      return res.json({
        success: true,
        bounties_validated: validated,
        current_score: currentPaper.weighted_score
      });
    }

    return res.status(400).json({ error: 'action must be register or validate' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
