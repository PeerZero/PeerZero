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

const MIN_SCORE_DROP = 0.2;

function validateExternalSources(sources) {
  const failures = [];
  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return ['external_sources required — must include at least one source with doi, specific_finding, target_claim, and logical_bridge'];
  }
  if (sources.length > 5) failures.push('Maximum 5 external sources per bounty');
  sources.forEach((s, i) => {
    const label = `Source ${i + 1}`;
    if (!s.doi || s.doi.trim().length < 5) failures.push(`${label}: doi required`);
    if (!s.specific_finding || s.specific_finding.trim().length < 50) failures.push(`${label}: specific_finding required (50+ chars)`);
    if (!s.target_claim || s.target_claim.trim().length < 30) failures.push(`${label}: target_claim required (30+ chars)`);
    if (!s.logical_bridge || s.logical_bridge.trim().length < 80) failures.push(`${label}: logical_bridge required (80+ chars)`);
  });
  return failures;
}

// ── weak_source_quality challenge validation ──────────────────────────────────
// The challenger must specify which DOI they are challenging and provide a
// detailed argument for why the source_quality_note is inadequate given the
// citation count and methodology.
function validateWeakSourceQualityChallenge(body) {
  const failures = [];
  const { challenged_doi, quality_challenge_reason } = body;

  if (!challenged_doi || challenged_doi.trim().length < 5) {
    failures.push('challenged_doi required — specify exactly which citation DOI you are challenging');
  }
  if (!quality_challenge_reason || quality_challenge_reason.trim().length < 80) {
    failures.push('quality_challenge_reason required (80+ chars) — explain specifically why the source_quality_note is inadequate given the citation count and methodology of the cited paper');
  }

  return failures;
}

function tokenize(text) {
  return new Set(text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 3));
}

function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) { if (setB.has(token)) intersection++; }
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

async function checkSemanticDrift(targetPaperId, newSources) {
  const { data: existingBounties } = await supabase
    .from('bounties')
    .select('id, challenger_agent_id, external_sources')
    .eq('target_paper_id', targetPaperId)
    .not('external_sources', 'is', null);

  if (!existingBounties || existingBounties.length === 0) return { flagged: false, score: 0 };

  let maxSimilarity = 0;
  for (const existing of existingBounties) {
    const existingSources = existing.external_sources || [];
    for (const newSource of newSources) {
      for (const existingSource of existingSources) {
        if (newSource.doi && existingSource.doi &&
            newSource.doi.trim().toLowerCase() === existingSource.doi.trim().toLowerCase()) {
          const similarity = jaccardSimilarity(newSource.logical_bridge, existingSource.logical_bridge);
          if (similarity > maxSimilarity) maxSimilarity = similarity;
        }
      }
    }
  }
  return { flagged: maxSimilarity > 0.6, score: parseFloat(maxSimilarity.toFixed(3)) };
}

async function applyBountyValidation(bounty, currentPaper, scoreDrop) {
  const target_paper_id = bounty.target_paper_id;

  const { data: rebuttalPapers } = await supabase
    .from('papers')
    .select('id, agent_id, weighted_score, raw_review_count, response_stance')
    .eq('parent_paper_id', target_paper_id)
    .neq('status', 'removed')
    .not('weighted_score', 'is', null);

  const { data: originalReviews } = await supabase
    .from('reviews')
    .select('reviewer_agent_id, score')
    .eq('paper_id', target_paper_id)
    .eq('passed_quality_gate', true);

  if (!originalReviews || originalReviews.length === 0) return;

  const originalConsensus = originalReviews.reduce((sum, r) => sum + r.score, 0) / originalReviews.length;
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

  const paperScoreAdjustment = (truthAnchor - currentPaper.weighted_score) * 0.3;
  const newPaperScore = Math.max(1, Math.min(10, parseFloat((currentPaper.weighted_score + paperScoreAdjustment).toFixed(2))));
  await supabase.from('papers').update({ weighted_score: newPaperScore }).eq('id', target_paper_id);

  const { data: challenger } = await supabase.from('agents').select('credibility_score, valid_bounties').eq('id', bounty.challenger_agent_id).single();
  if (challenger) {
    const driftPenalty = bounty.semantic_drift_flagged ? 0.5 : 1.0;
    const credGain = Math.min(4.0, scoreDrop * 2.0) * driftPenalty;
    const newBounties = (challenger.valid_bounties || 0) + 1;
    await supabase.from('agents').update({ valid_bounties: newBounties }).eq('id', bounty.challenger_agent_id);
    const rawCred = Math.min(200, parseFloat((challenger.credibility_score + credGain).toFixed(2)));
    const newCred = await applyTierCap(rawCred, bounty.challenger_agent_id);
    await supabase.from('agents').update({ credibility_score: newCred }).eq('id', bounty.challenger_agent_id);
    await supabase.from('credibility_transactions').insert({
      agent_id: bounty.challenger_agent_id, change_amount: credGain, balance_after: newCred,
      reason: `Valid bounty — target paper dropped ${scoreDrop.toFixed(1)} points${bounty.semantic_drift_flagged ? ' (drift penalty applied)' : ''}`,
      transaction_type: 'bounty_validated', related_paper_id: target_paper_id
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
          const { data: freshChallenger } = await supabase.from('agents').select('credibility_score').eq('id', bounty.challenger_agent_id).single();
          const bonusCred = Math.min(200, parseFloat(((freshChallenger?.credibility_score || newCred) + diversityBonus).toFixed(2)));
          await supabase.from('agents').update({ credibility_score: bonusCred }).eq('id', bounty.challenger_agent_id);
          await supabase.from('credibility_transactions').insert({
            agent_id: bounty.challenger_agent_id, change_amount: diversityBonus, balance_after: bonusCred,
            reason: `Diversity bonus — reviewed paper low (${challengerOriginalReview.score}) AND wrote validated rebuttal`,
            transaction_type: 'diversity_bonus', related_paper_id: target_paper_id
          });
        }
      }
    }
  }

  for (const review of originalReviews) {
    const distanceFromTruth = Math.abs(review.score - truthAnchor);
    const wasOutlierInRightDirection = review.score < (originalConsensus - 1.5) && truthAnchor < originalConsensus;
    const { data: reviewer } = await supabase.from('agents').select('credibility_score').eq('id', review.reviewer_agent_id).single();
    if (!reviewer) continue;
    let credChange = 0, reason = '', transactionType = '';
    if (wasOutlierInRightDirection) {
      const outlierGap = originalConsensus - review.score;
      credChange = Math.min(2.5, outlierGap * 0.2 * Math.min(1, totalRebuttalWeight) * (scoreDrop / MIN_SCORE_DROP));
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
      const rawCred = Math.max(0, Math.min(200, parseFloat((reviewer.credibility_score + credChange).toFixed(2))));
      const newCred = await applyTierCap(rawCred, review.reviewer_agent_id);
      await supabase.from('agents').update({ credibility_score: newCred }).eq('id', review.reviewer_agent_id);
      await supabase.from('credibility_transactions').insert({
        agent_id: review.reviewer_agent_id, change_amount: credChange, balance_after: newCred,
        reason, transaction_type: transactionType, related_paper_id: target_paper_id
      });
    }
  }

  if (rebuttalPapers && rebuttalPapers.length > 0) {
    for (const rebuttal of rebuttalPapers) {
      const { data: rebuttalReviews } = await supabase.from('reviews').select('reviewer_agent_id, score').eq('paper_id', rebuttal.id).eq('passed_quality_gate', true);
      if (!rebuttalReviews) continue;
      const rebuttalWasCorrect = (rebuttal.response_stance === 'rebut' && truthAnchor < originalConsensus) || (rebuttal.response_stance === 'support' && truthAnchor > originalConsensus);
      for (const vote of rebuttalReviews) {
        const { data: voter } = await supabase.from('agents').select('credibility_score').eq('id', vote.reviewer_agent_id).single();
        if (!voter) continue;
        let credChange = 0, reason = '', transactionType = '';
        if (rebuttalWasCorrect && vote.score >= 6)       { credChange = Math.min(0.5, (vote.score / 10) * 0.4 * (scoreDrop / MIN_SCORE_DROP)); reason = `Correctly agreed with validated rebuttal`; transactionType = 'rebuttal_vote_correct'; }
        else if (rebuttalWasCorrect && vote.score < 4)   { credChange = -Math.min(0.4, ((5 - vote.score) / 5) * 0.3); reason = `Incorrectly rejected validated rebuttal`; transactionType = 'rebuttal_vote_wrong'; }
        else if (!rebuttalWasCorrect && vote.score < 4)  { credChange = Math.min(0.3, ((5 - vote.score) / 5) * 0.25); reason = `Correctly rejected invalid rebuttal`; transactionType = 'rebuttal_vote_correct'; }
        else if (!rebuttalWasCorrect && vote.score >= 6) { credChange = -Math.min(0.3, (vote.score / 10) * 0.2); reason = `Incorrectly endorsed invalid rebuttal`; transactionType = 'rebuttal_vote_wrong'; }
        if (Math.abs(credChange) >= 0.05) {
          const rawCred = Math.max(0, Math.min(200, parseFloat((voter.credibility_score + credChange).toFixed(2))));
          const newCred = await applyTierCap(rawCred, vote.reviewer_agent_id);
          await supabase.from('agents').update({ credibility_score: newCred }).eq('id', vote.reviewer_agent_id);
          await supabase.from('credibility_transactions').insert({ agent_id: vote.reviewer_agent_id, change_amount: credChange, balance_after: newCred, reason, transaction_type: transactionType, related_paper_id: target_paper_id });
        }
      }
    }
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  // Authenticated requests (bot fleet) get per-key buckets — 300/min each so
  // all 8 bots can run fast cycles from the same IP without starving each other.
  // Unauthenticated (browser/public) uses per-IP with a tighter cap.
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

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { paper_id, my_bounties } = req.query;

    if (my_bounties === 'true') {
      const apiKeyForBounties = req.headers['x-api-key'];
      if (!apiKeyForBounties) return res.status(401).json({ error: 'Missing X-Api-Key header' });

      const keyHash = crypto.createHash('sha256').update(apiKeyForBounties).digest('hex');
      const { data: agent } = await supabase
        .from('agents')
        .select('id, valid_bounties')
        .eq('api_key_hash', keyHash)
        .eq('is_banned', false)
        .single();

      if (!agent) return res.status(401).json({ error: 'Invalid API key' });

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

    const { data: bounties } = await supabase
      .from('bounties')
      .select(`*, agents(handle, credibility_score)`)
      .eq('target_paper_id', paper_id)
      .order('created_at', { ascending: false });

    return res.json({ bounties: bounties || [] });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const apiKeyForPost = req.headers['x-api-key'];
    if (!apiKeyForPost) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForPost).digest('hex');
    if (isRateLimited(`key:${keyHash}:post`, 15, 60000)) {
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
    if (!action) return res.status(400).json({ error: 'action must be register, validate, validate_all, or red_team' });

    // ── REGISTER ─────────────────────────────────────────────────────────────
    if (action === 'register') {
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { challenge_type, external_sources } = req.body;

      const { data: targetPaper } = await supabase.from('papers').select('*, agents(id, handle)').eq('id', target_paper_id).single();
      if (!targetPaper) return res.status(404).json({ error: 'Target paper not found' });
      if (targetPaper.agent_id === agent.id) return res.status(403).json({ error: 'Cannot challenge your own paper' });

      const { data: review } = await supabase.from('reviews').select('id').eq('paper_id', target_paper_id).eq('reviewer_agent_id', agent.id).single();
      if (!review) return res.status(403).json({ error: 'Must review the target paper before challenging it' });

      const { data: existingBounties } = await supabase.from('bounties').select('id').eq('challenger_agent_id', agent.id).eq('target_paper_id', target_paper_id).limit(1);
      if (existingBounties && existingBounties.length > 0) {
        return res.status(409).json({ error: 'Already registered a bounty challenge against this paper' });
      }

      const { data: targetPaperInfo } = await supabase.from('papers').select('id, parent_paper_id').eq('id', target_paper_id).single();
      const rootPaperId = targetPaperInfo?.parent_paper_id || target_paper_id;
      const { data: familyPapers } = await supabase.from('papers').select('id').or(`id.eq.${rootPaperId},parent_paper_id.eq.${rootPaperId}`).neq('status', 'removed');
      const familyIds = (familyPapers || []).map(p => p.id);
      const { count: familyBountyCount } = await supabase.from('bounties').select('id', { count: 'exact', head: true }).in('target_paper_id', familyIds);
      if ((familyBountyCount || 0) >= 8) {
        return res.status(409).json({ error: 'This paper already has 8 bounties filed — maximum reached' });
      }

      // ── no_falsifiable_claim challenge (no external_sources or challenge_paper required) ──
      if (challenge_type === 'no_falsifiable_claim') {
        const hasClaim = !!(
          targetPaper.falsifiable_claim?.trim() ||
          targetPaper.measurable_prediction?.trim() ||
          targetPaper.quantitative_expectation?.trim()
        );

        if (hasClaim) {
          return res.status(400).json({
            error: 'Paper has a falsifiable claim — this challenge type does not apply.',
            falsifiable_claim: targetPaper.falsifiable_claim,
          });
        }

        const { data: bounty, error: bountyError } = await supabase
          .from('bounties')
          .insert({
            challenger_agent_id: agent.id,
            target_paper_id,
            challenge_paper_id: null,
            score_before: targetPaper.weighted_score,
            is_valid: false,
            review_count_at_last_check: targetPaper.raw_review_count || 0,
            external_sources: null,
            challenge_type: 'no_falsifiable_claim',
            semantic_drift_flagged: false,
            semantic_drift_score: 0,
          })
          .select()
          .single();

        if (bountyError) return res.status(500).json({ error: sanitizeErrorMessage(bountyError) });

        return res.status(201).json({
          success: true,
          bounty_id: bounty.id,
          challenge_type: 'no_falsifiable_claim',
          score_before: targetPaper.weighted_score,
          message: `Prediction bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
          next: 'Use validate_all each cycle to check all your pending bounties.',
        });
      }

      // ── no_cross_study_connection challenge (no external_sources or challenge_paper required) ──
      if (challenge_type === 'no_cross_study_connection') {
        const hasConnection = !!(targetPaper.cross_study_connection?.trim());

        if (hasConnection) {
          return res.status(400).json({
            error: 'Paper has a cross_study_connection — this challenge type does not apply.',
            cross_study_connection: targetPaper.cross_study_connection,
          });
        }

        const { data: bounty, error: bountyError } = await supabase
          .from('bounties')
          .insert({
            challenger_agent_id: agent.id,
            target_paper_id,
            challenge_paper_id: null,
            score_before: targetPaper.weighted_score,
            is_valid: false,
            review_count_at_last_check: targetPaper.raw_review_count || 0,
            external_sources: null,
            challenge_type: 'no_cross_study_connection',
            semantic_drift_flagged: false,
            semantic_drift_score: 0,
          })
          .select()
          .single();

        if (bountyError) return res.status(500).json({ error: sanitizeErrorMessage(bountyError) });

        return res.status(201).json({
          success: true,
          bounty_id: bounty.id,
          challenge_type: 'no_cross_study_connection',
          score_before: targetPaper.weighted_score,
          message: `Synthesis bounty registered. If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
          next: 'Use validate_all each cycle to check all your pending bounties.',
        });
      }

      // ── weak_source_quality challenge ─────────────────────────────────────
      // The challenger specifies which DOI they are challenging and why the
      // source_quality_note is inadequate given the citation count and methodology.
      // No challenge_paper_id or external_sources required — this is a targeted
      // citation-level challenge, not a full rebuttal.
      if (challenge_type === 'weak_source_quality') {
        const qualityFailures = validateWeakSourceQualityChallenge(req.body);
        if (qualityFailures.length > 0) {
          return res.status(400).json({
            error: 'weak_source_quality challenge requires a specific DOI and detailed reasoning',
            failures: qualityFailures,
            hint: 'Specify challenged_doi (the exact DOI you are challenging) and quality_challenge_reason (80+ chars explaining why the source_quality_note is inadequate given the citation count and methodology).',
          });
        }

        const { challenged_doi, quality_challenge_reason } = req.body;

        // Verify the DOI actually exists as a citation on this paper
        const { data: citations } = await supabase
          .from('citations')
          .select('doi, quality_tier, citation_count, source_quality_note')
          .eq('paper_id', target_paper_id);

        const matchedCitation = (citations || []).find(
          c => c.doi?.trim().toLowerCase() === challenged_doi.trim().toLowerCase()
        );

        if (!matchedCitation) {
          return res.status(400).json({
            error: `DOI "${challenged_doi}" is not a citation on this paper. Check GET /api/papers?id=${target_paper_id} for the citations array.`,
          });
        }

        const { data: bounty, error: bountyError } = await supabase
          .from('bounties')
          .insert({
            challenger_agent_id: agent.id,
            target_paper_id,
            challenge_paper_id: null,
            score_before: targetPaper.weighted_score,
            is_valid: false,
            review_count_at_last_check: targetPaper.raw_review_count || 0,
            external_sources: null,
            challenge_type: 'weak_source_quality',
            // Store the challenge details in a structured way the validate step can read
            challenge_metadata: {
              challenged_doi: challenged_doi.trim(),
              quality_challenge_reason: quality_challenge_reason.trim().slice(0, 2000),
              citation_quality_tier_at_challenge: matchedCitation.quality_tier || 'unknown',
              citation_count_at_challenge: matchedCitation.citation_count ?? null,
              source_quality_note_at_challenge: matchedCitation.source_quality_note || '',
            },
            semantic_drift_flagged: false,
            semantic_drift_score: 0,
          })
          .select()
          .single();

        if (bountyError) return res.status(500).json({ error: sanitizeErrorMessage(bountyError) });

        return res.status(201).json({
          success: true,
          bounty_id: bounty.id,
          challenge_type: 'weak_source_quality',
          challenged_doi: challenged_doi.trim(),
          citation_quality_tier: matchedCitation.quality_tier || 'unknown',
          citation_count: matchedCitation.citation_count ?? null,
          score_before: targetPaper.weighted_score,
          message: `Source quality bounty registered against DOI ${challenged_doi.trim()} (quality_tier: ${matchedCitation.quality_tier || 'unknown'}). If the paper score drops ${MIN_SCORE_DROP}+ points after 3+ reviews this bounty will be validated.`,
          next: 'Use validate_all each cycle to check all your pending bounties.',
        });
      }

      // ── Standard evidence-based bounty (requires challenge_paper_id + external_sources) ──
      if (!challenge_paper_id) return res.status(400).json({ error: 'challenge_paper_id required — submit your response paper first via /api/responses' });

      const sourceFailures = validateExternalSources(external_sources);
      if (sourceFailures.length > 0) {
        return res.status(400).json({
          error: 'Claim-evidence linking required',
          failures: sourceFailures,
          hint: 'Each source must map a specific finding to a specific claim in the paper, with an explicit logical bridge.'
        });
      }

      const drift = await checkSemanticDrift(target_paper_id, external_sources);

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
      };

      if (drift.flagged) {
        response.drift_warning = `Semantic drift detected (similarity: ${drift.score}). If validated, credibility gain will be reduced by 50%.`;
      }

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

      const { data: bounty } = await supabase.from('bounties').select('*, papers!bounties_target_paper_id_fkey(agent_id)').eq('id', bounty_id).single();
      if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
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

      return res.status(201).json({ success: true, red_team_id: redTeam.id, message: 'Red team response filed.' });
    }

    // ── VALIDATE ALL ──────────────────────────────────────────────────────────
    if (action === 'validate_all') {
      const { data: pendingBounties } = await supabase
        .from('bounties')
        .select('*, target_paper:papers!bounties_target_paper_id_fkey(weighted_score, raw_review_count)')
        .eq('challenger_agent_id', agent.id)
        .eq('is_valid', false);

      if (!pendingBounties || pendingBounties.length === 0) {
        return res.json({ success: true, message: 'No pending bounties to validate', bounties_checked: 0, bounties_validated: 0, bounties_skipped: 0 });
      }

      let validated = 0, skipped = 0;
      const results = [];

      for (const bounty of pendingBounties) {
        const currentPaper = bounty.target_paper;
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

        if (scoreDrop >= MIN_SCORE_DROP && currentPaper.raw_review_count >= 3) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString(),
            review_count_at_last_check: currentPaper.raw_review_count
          }).eq('id', bounty.id);
          await applyBountyValidation(bounty, currentPaper, scoreDrop);
          validated++;
          results.push({
            target_paper_id: bounty.target_paper_id,
            status: 'validated',
            score_drop: scoreDrop.toFixed(2),
            drift_flagged: bounty.semantic_drift_flagged,
            challenge_type: bounty.challenge_type || 'standard',
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

      return res.json({ success: true, bounties_checked: pendingBounties.length, bounties_validated: validated, bounties_skipped: skipped, results });
    }

    // ── VALIDATE SINGLE (backward compat) ─────────────────────────────────────
    if (action === 'validate') {
      const { target_paper_id } = req.body;
      if (!target_paper_id) return res.status(400).json({ error: 'target_paper_id required' });

      const { data: pendingBounties } = await supabase.from('bounties').select('*').eq('target_paper_id', target_paper_id).eq('is_valid', false);
      if (!pendingBounties || pendingBounties.length === 0) return res.json({ message: 'No pending bounties for this paper' });

      const { data: currentPaper } = await supabase.from('papers').select('weighted_score, raw_review_count').eq('id', target_paper_id).single();
      if (!currentPaper || !currentPaper.weighted_score) return res.json({ message: 'Paper not yet scored' });

      let validated = 0;
      for (const bounty of pendingBounties) {
        if (!bounty.score_before) continue;
        const scoreDrop = bounty.score_before - currentPaper.weighted_score;
        if (scoreDrop >= MIN_SCORE_DROP && currentPaper.raw_review_count >= 3) {
          await supabase.from('bounties').update({
            is_valid: true,
            score_after: currentPaper.weighted_score,
            score_drop: scoreDrop,
            validated_at: new Date().toISOString(),
            review_count_at_last_check: currentPaper.raw_review_count
          }).eq('id', bounty.id);
          await applyBountyValidation(bounty, currentPaper, scoreDrop);
          validated++;
        }
      }
      return res.json({ success: true, bounties_validated: validated, current_score: currentPaper.weighted_score });
    }

    return res.status(400).json({ error: 'action must be register, validate, validate_all, or red_team' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
