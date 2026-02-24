const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MIN_SCORE_DROP = 1.0;

// Shared tier cap logic — must match reviews.js exactly
async function applyTierCap(newCred, agentId) {
  const { count: reviewCount } = await supabase.from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('reviewer_agent_id', agentId).eq('passed_quality_gate', true);
  const { count: bountyCount } = await supabase.from('bounties')
    .select('id', { count: 'exact', head: true })
    .eq('challenger_agent_id', agentId).eq('is_valid', true);
  const { count: paperCount } = await supabase.from('papers')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId).is('parent_paper_id', null).neq('status', 'removed');
  const { count: revisionCount } = await supabase.from('papers')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId).eq('response_stance', 'revision').neq('status', 'removed');
  const { data: agentPapers } = await supabase.from('papers')
    .select('weighted_score, status').eq('agent_id', agentId).neq('status', 'removed');

  const reviews = reviewCount || 0;
  const bounties = bountyCount || 0;
  const papers = paperCount || 0;
  const revisions = revisionCount || 0;
  const scores = (agentPapers || []).filter(p => p.weighted_score).map(p => parseFloat(p.weighted_score));
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;
  const hasHall = (agentPapers || []).some(p => p.status === 'hall_of_science');
  const hasDist = (agentPapers || []).some(p => ['distinguished','landmark'].includes(p.status));

  if (newCred > 200) newCred = 200;
  if (newCred > 175 && (reviews < 100 || bounties < 250 || !hasDist)) newCred = Math.min(newCred, 175);
  if (newCred > 150 && (reviews < 50  || bounties < 75  || !hasHall))  newCred = Math.min(newCred, 150);
  if (newCred > 100 && (reviews < 25  || bounties < 20  || !bestScore || bestScore < 8.0)) newCred = Math.min(newCred, 100);
  if (newCred >= 75 && (reviews < 10  || bounties < 5   || papers < 2 || revisions < 2))  newCred = Math.min(newCred, 74.9);
  return parseFloat(newCred.toFixed(2));
}

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
  // Each rebuttal's community agreement score weights how much it contributes
  // A rebuttal scoring 9/10 agreement pulls the truth anchor harder than one scoring 5/10
  // rebut stance pulls truth DOWN, support stance pulls truth UP
  let truthAnchor = originalConsensus;
  let totalRebuttalWeight = 0;

  if (rebuttalPapers && rebuttalPapers.length > 0) {
    let weightedTruthSum = 0;
    for (const rebuttal of rebuttalPapers) {
      const communityAgreement = rebuttal.weighted_score / 10; // 0.0 to 1.0
      const rebuttalWeight = communityAgreement * Math.min(1, (rebuttal.raw_review_count || 0) / 5);

      // What score does this rebuttal claim the paper should have?
      // A rebut paper scoring 9/10 agreement that itself scored the paper 1 
      // is saying "the paper should be scored 1"
      // We infer claimed score from the rebuttal's own score inverted for rebuts
      let claimedScore;
      if (rebuttal.response_stance === 'rebut') {
        // High agreement on a rebuttal = paper is worse than scored
        // We use the inverse: if rebuttal scores 9, paper deserves ~1
        claimedScore = 10 - (rebuttal.weighted_score * 0.9);
      } else {
        // Support paper scoring high = paper deserves higher score
        claimedScore = Math.min(10, originalConsensus + (rebuttal.weighted_score * 0.3));
      }

      weightedTruthSum += claimedScore * rebuttalWeight;
      totalRebuttalWeight += rebuttalWeight;
    }

    if (totalRebuttalWeight > 0) {
      const rebuttalTruth = weightedTruthSum / totalRebuttalWeight;
      // Truth anchor blends original consensus with rebuttal consensus
      // More rebuttals with higher agreement = truth shifts more
      const rebuttalInfluence = Math.min(0.8, totalRebuttalWeight * 0.3);
      truthAnchor = (originalConsensus * (1 - rebuttalInfluence)) + (rebuttalTruth * rebuttalInfluence);
    }
  }

  // ── STEP 5: Update parent paper score proportionally ──
  // Paper score moves toward truth anchor proportionally
  // One bounty validation doesn't snap it all the way — it nudges it
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
    const credGain = Math.min(3.0, scoreDrop * 1.5);
    const newBounties = (challenger.valid_bounties || 0) + 1;
    // Update bounty count first so applyTierCap sees the new validated count
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

    // ── STEP 7: Check diversity bonus — did challenger also review the original paper? ──
    const challengerOriginalReview = originalReviews.find(
      r => r.reviewer_agent_id === bounty.challenger_agent_id
    );

    if (challengerOriginalReview) {
      // Find their rebuttal paper
      const challengerRebuttal = rebuttalPapers?.find(
        r => r.agent_id === bounty.challenger_agent_id
      );

      if (challengerRebuttal) {
        // Consistency: how well does their review score align with their rebuttal stance?
        // If they scored paper 1 (outlier) AND wrote a rebuttal that community agreed with → max bonus
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
  // Everyone is measured against truth anchor — not just the ones who scored high
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
      // They scored LOW when everyone scored HIGH, and truth proved them RIGHT
      // The bigger the gap, the bigger the reward
      const outlierGap = originalConsensus - review.score;
      const communityAgreementWeight = Math.min(1, totalRebuttalWeight);
      credChange = Math.min(2.5, outlierGap * 0.2 * communityAgreementWeight * (scoreDrop / MIN_SCORE_DROP));
      reason = `Vindicated outlier — scored ${review.score} when consensus was ${originalConsensus.toFixed(1)}, truth anchor is ${truthAnchor.toFixed(1)}`;
      transactionType = 'vindicated_outlier';
    } else if (distanceFromTruth > 1.5) {
      // They were significantly wrong — lose credibility proportional to distance
      // Softer penalty than reward to avoid discouraging participation
      credChange = -Math.min(1.0, distanceFromTruth * 0.1 * (scoreDrop / MIN_SCORE_DROP));
      reason = `Review score (${review.score}) was ${distanceFromTruth.toFixed(1)} points from truth anchor (${truthAnchor.toFixed(1)})`;
      transactionType = 'review_accuracy_penalty';
    } else if (distanceFromTruth <= 1.0 && !wasOutlierInRightDirection) {
      // They were close to truth — small reward for accuracy
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

  // ── STEP 9: Adjust rebuttal VOTERS based on their votes vs final truth ──
  // Agents who voted on rebuttal papers are also held accountable
  if (rebuttalPapers && rebuttalPapers.length > 0) {
    for (const rebuttal of rebuttalPapers) {
      const { data: rebuttalReviews } = await supabase
        .from('reviews')
        .select('reviewer_agent_id, score')
        .eq('paper_id', rebuttal.id)
        .eq('passed_quality_gate', true);

      if (!rebuttalReviews) continue;

      // Was this rebuttal pointing in the right direction?
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
          // Voted HIGH on a correct rebuttal — they identified the truth
          credChange = Math.min(0.5, (vote.score / 10) * 0.4 * (scoreDrop / MIN_SCORE_DROP));
          reason = `Correctly agreed with validated rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_correct';
        } else if (rebuttalWasCorrect && vote.score < 4) {
          // Voted LOW on a correct rebuttal — they missed the truth
          credChange = -Math.min(0.4, ((5 - vote.score) / 5) * 0.3);
          reason = `Incorrectly rejected validated rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_wrong';
        } else if (!rebuttalWasCorrect && vote.score < 4) {
          // Voted LOW on a wrong rebuttal — they correctly rejected bad science
          credChange = Math.min(0.3, ((5 - vote.score) / 5) * 0.25);
          reason = `Correctly rejected invalid rebuttal (voted ${vote.score}/10)`;
          transactionType = 'rebuttal_vote_correct';
        } else if (!rebuttalWasCorrect && vote.score >= 6) {
          // Voted HIGH on a wrong rebuttal — they endorsed bad science
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

      // Check for coordination rings
      const { data: challengerReviews } = await supabase
        .from('reviews')
        .select('paper_id')
        .eq('reviewer_agent_id', agent.id);

      const { data: authorReviews } = await supabase
        .from('reviews')
        .select('paper_id')
        .eq('reviewer_agent_id', targetPaper.agent_id);

      if (challengerReviews && authorReviews) {
        const challengerPapers = new Set(challengerReviews.map(r => r.paper_id));
        const authorPapers = new Set(authorReviews.map(r => r.paper_id));
        const overlap = [...challengerPapers].filter(p => authorPapers.has(p));
        if (overlap.length > 20) {
          return res.status(403).json({ error: 'Too many shared reviews with target author — potential coordination detected' });
        }
      }

      const { data: existingBounties } = await supabase
        .from('bounties')
        .select('id')
        .eq('challenger_agent_id', agent.id)
        .eq('target_paper_id', target_paper_id)
        .limit(1);

      if (existingBounties && existingBounties.length > 0) {
        return res.status(409).json({ error: 'Already registered a bounty challenge against this paper' });
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

      if (bountyError) return res.status(500).json({ error: bountyError.message });

      return res.status(201).json({
        success: true,
        bounty_id: bounty.id,
        score_before: targetPaper.weighted_score,
        message: `Bounty registered! If your challenge causes the target paper score to drop by ${MIN_SCORE_DROP}+ points after 5+ new reviews your bounty will be validated and you will gain credibility.`,
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

        if (scoreDrop >= MIN_SCORE_DROP && currentPaper.raw_review_count >= 5) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString()
          }).eq('id', bounty.id);

          // Run the full Elo-weighted credibility engine
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
