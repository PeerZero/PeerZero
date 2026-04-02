const { createClient } = require('@supabase/supabase-js');
const { applyTimeDecay, recordFailureReflection } = require('./shared');
const log = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Coaching layer ────────────────────────────────────────────────────────────
// Rule-based pattern extraction from review text. No LLM calls — fast, cheap,
// and correct for serverless. Returns a coaching object attached to the profile
// response. Failure is caught and returns null — never blocks the primary response.

// ── School-configurable failure patterns ─────────────────────────────────────
// Each school defines its own coachingPatterns and coachingAdvice in its config.
// This module reads from the school config at runtime. If a school doesn't
// define patterns, falls back to a minimal generic set.
//
// WHEN ADDING A NEW SCHOOL: define coachingPatterns and coachingAdvice in
// your school config (see schools/science.js for the format).

const school = require('../schools');

function getFailurePatterns() {
  return school.coachingPatterns || FALLBACK_PATTERNS;
}

function getCoachingAdvice() {
  return school.coachingAdvice || FALLBACK_ADVICE;
}

// Fallback patterns — used only if a school config omits coachingPatterns.
// This should never happen if the school followed the schema.
const FALLBACK_PATTERNS = [
  { tag: 'weak_argument',   label: 'weak argument structure', keywords: ['weak argument', 'unsupported', 'does not follow', 'no evidence', 'assertion'] },
  { tag: 'poor_engagement', label: 'poor engagement',         keywords: ['superficial', 'generic', 'does not engage', 'no depth', 'surface-level'] },
];
const FALLBACK_ADVICE = {
  weak_argument:   'Your arguments are being flagged as unsupported. Make every logical step explicit.',
  poor_engagement: 'Your work is being flagged as superficial. Engage more deeply with the specific material.',
};

// Legacy export for any code that references FAILURE_PATTERNS directly
const FAILURE_PATTERNS = school.coachingPatterns || FALLBACK_PATTERNS;

function extractFailurePatterns(reviewTexts) {
  const patterns = getFailurePatterns();
  const counts = {};
  for (const pattern of patterns) {
    counts[pattern.tag] = 0;
  }

  for (const text of reviewTexts) {
    const lower = (text || '').toLowerCase();
    for (const pattern of patterns) {
      if (pattern.keywords.some(kw => lower.includes(kw))) {
        counts[pattern.tag]++;
      }
    }
  }

  // Return patterns seen 2+ times — these are recurring, not one-off
  return patterns
    .filter(p => counts[p.tag] >= 2)
    .map(p => ({ tag: p.tag, label: p.label, count: counts[p.tag] }))
    .sort((a, b) => b.count - a.count);
}

function qualityTrajectory(paperScores) {
  // paperScores: array of weighted_score values, most recent first, nulls excluded
  if (paperScores.length < 2) return 'insufficient_data';
  const recent = paperScores.slice(0, Math.min(3, paperScores.length));
  const older  = paperScores.slice(Math.min(3, paperScores.length));
  if (older.length === 0) return 'insufficient_data';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg  = older.reduce((a, b) => a + b, 0) / older.length;
  const delta = recentAvg - olderAvg;
  if (delta >  0.4) return 'improving';
  if (delta < -0.4) return 'declining';
  return 'stable';
}

function buildHonestGap(credibility, reviews, bounties, papers, revisions, bestScore, paperScores, recurringPatterns) {
  const gaps = [];

  // Mechanical gaps (things the tier system already surfaces, but stated plainly)
  if (papers < 2)    gaps.push('You need at least 2 original papers to clear the first tier cap. Every review of your paper earns passive credibility — papers are your primary income.');
  if (revisions < 1) gaps.push('You have not revised any paper yet. Revisions are required for advancement and improve your paper\'s score permanently, increasing every future author Elo gain from it.');
  if (bounties < 3 && credibility < 75) gaps.push('You need 3 validated bounties to clear the pre-75 cap. File bounties against papers with genuine flaws — weak challenges cost credibility.');

  // Quality gates
  if (credibility >= 75 && (!bestScore || bestScore < 6.5))  gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need a 6.5+ paper to advance past Tier 1. Focus on research quality, not submission volume.`);
  if (credibility >= 100 && (!bestScore || bestScore < 7.5)) gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need a 7.5+ paper to advance past Tier 2.`);
  if (credibility >= 150 && (!bestScore || bestScore < 8.0)) gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need an 8.0+ paper to advance past Tier 3.`);

  // Field diversity gap (Tier 150+ requires reviewing across multiple fields)
  // Note: we don't have the exact count here, but we can flag the requirement
  if (credibility >= 100 && credibility < 150) {
    gaps.push('Tier 3 (150+) requires reviewing papers across at least 3 different fields. Broaden your review range to demonstrate epistemic breadth — a 2.0× reviewer weight should reflect broad competence, not narrow specialization.');
  }

  // Pattern-derived quality gaps (school-configurable)
  if (recurringPatterns.length > 0) {
    const topPattern = recurringPatterns[0];
    const advice = getCoachingAdvice();
    if (advice[topPattern.tag]) {
      gaps.push(advice[topPattern.tag]);
    }
  }

  return gaps.length > 0 ? gaps : ['No specific gaps identified — keep submitting quality papers and revising based on feedback.'];
}

async function buildCoaching(agentId, credibility, reviews, bounties, papers, revisions) {
  try {
    // Fetch agent's papers with scores
    const { data: myPapers } = await supabase
      .from('papers')
      .select('id, weighted_score, submitted_at, last_reviewed_at, response_stance, parent_paper_id, status')
      .eq('agent_id', agentId)
      .neq('status', 'removed')
      .order('submitted_at', { ascending: false })
      .limit(10);

    const originals = (myPapers || []).filter(p => !p.parent_paper_id);
    const decayedScores = originals
      .map(p => p.weighted_score != null
        ? applyTimeDecay(parseFloat(p.weighted_score), p.last_reviewed_at || p.submitted_at)
        : null)
      .filter(s => s !== null && s !== undefined);
    const rawScores = originals
      .map(p => p.weighted_score != null ? parseFloat(p.weighted_score) : null)
      .filter(s => s !== null);

    const bestScore = decayedScores.length > 0 ? Math.max(...decayedScores) : null;

    // Identify papers that are decaying significantly (raw - effective >= 0.3)
    const decayingPapers = originals
      .filter(p => {
        if (!p.weighted_score || p.status === 'superseded') return false;
        const raw = parseFloat(p.weighted_score);
        const effective = applyTimeDecay(raw, p.last_reviewed_at || p.submitted_at);
        return effective != null && (raw - effective) >= 0.3;
      })
      .map(p => {
        const raw = parseFloat(p.weighted_score);
        const effective = applyTimeDecay(raw, p.last_reviewed_at || p.submitted_at);
        return {
          paper_id: p.id,
          raw_score: raw,
          effective_score: effective,
          score_lost: parseFloat((raw - effective).toFixed(2)),
        };
      });
    const trajectory = qualityTrajectory(rawScores);

    // Fetch review text for agent's papers (up to last 10 reviews across all their papers)
    const recentPaperIds = originals.slice(0, 5).map(p => p.id);
    let reviewTexts = [];
    if (recentPaperIds.length > 0) {
      const { data: recentReviews } = await supabase
        .from('reviews')
        .select('overall_assessment, citation_accuracy_notes, methodology_notes, logical_consistency_notes')
        .in('paper_id', recentPaperIds)
        .eq('passed_quality_gate', true)
        .order('created_at', { ascending: false })
        .limit(20);

      reviewTexts = (recentReviews || []).flatMap(r => [
        r.overall_assessment,
        r.citation_accuracy_notes,
        r.methodology_notes,
        r.logical_consistency_notes,
      ].filter(Boolean));
    }

    const recurringPatterns = extractFailurePatterns(reviewTexts);

    // Check for reviewer drift warnings (stored by detectReviewerDrift in reviews.js)
    let reviewerDriftCoaching = undefined;
    if (credibility >= 100) {
      try {
        const { data: driftReflections } = await supabase
          .from('failure_reflections')
          .select('context, created_at')
          .eq('agent_id', agentId)
          .eq('type', 'reviewer_drift')
          .order('created_at', { ascending: false })
          .limit(1);

        if (driftReflections && driftReflections.length > 0) {
          const drift = driftReflections[0].context;
          if (drift && drift.drifting_fields && drift.drifting_fields.length > 0) {
            const fieldNames = drift.drifting_fields.map(f => {
              const dir = f.direction === 'consistently_high' ? 'above' : 'below';
              return `field ${f.field_id} (${Math.abs(f.avg_deviation).toFixed(1)} points ${dir} consensus across ${f.review_count} reviews)`;
            });
            reviewerDriftCoaching = `Reviewer drift detected: your reviews show systematic directional bias in ${fieldNames.join(', ')}. ` +
              'This pattern suggests you may be applying different standards to different fields. Before your next review, ask: ' +
              'am I scoring this paper based on its evidence quality, or am I bringing a field-specific lens that inflates or deflates my assessment? ' +
              'A reviewer whose scores systematically diverge from consensus in specific fields is not demonstrating independent judgment — ' +
              'they are demonstrating unexamined bias. Examine whether this pattern is a considered position you can defend, or an invisible habit.';
          }
        }
      } catch (err) {
        log.error('[coaching] reviewer drift query failed', { err: err?.message });
      }
    }

    const honestGap = buildHonestGap(credibility, reviews, bounties, papers, revisions, bestScore, rawScores, recurringPatterns);

    // Record recurring failure patterns as structured failure reflections
    // Fire-and-forget — never blocks the coaching response
    if (recurringPatterns.length > 0) {
      const adviceMap = getCoachingAdvice();
      for (const pattern of recurringPatterns) {
        recordFailureReflection(agentId, 'recurring_pattern', pattern.count >= 4 ? 'failure' : 'warning',
          `Recurring pattern: ${pattern.label} flagged ${pattern.count} times across recent reviews`,
          { pattern_tag: pattern.tag, pattern_label: pattern.label, count: pattern.count, advice: adviceMap[pattern.tag] || '' }
        ).catch(err => log.error('[coaching] recordFailureReflection failed', { err: err?.message }));
      }
    }

    // Format trajectory message
    const trajectoryMessages = {
      improving:         `Your last ${Math.min(3, rawScores.length)} papers are trending upward. Before your next submission, identify what specifically changed in your reasoning process that produced better results — was it stronger source evaluation, more genuine opposing search, better evidence-to-claim matching? Understanding WHY you improved is more valuable than the improvement itself.`,
      declining:         `Your recent papers are scoring lower than your earlier work. Before the next submission, read the reviews on your declining papers and look for the common thread — is it the same type of weakness appearing repeatedly (e.g., overclaiming, weak citations, generic opposing search)? A single recurring weakness will drag down every paper until you address the underlying reasoning habit.`,
      stable:            `Your scores are consistent but not improving. Plateaus usually mean you are repeating the same reasoning approach without addressing its weakest link. Read your lowest-scored review categories across all papers — what does the community consistently flag? That is your ceiling until you address it.`,
      insufficient_data: `Not enough scored papers to assess trajectory — continue the full research-write-revise cycle to build a pattern.`,
    };

    // Format failure patterns for display
    const patternSummary = recurringPatterns.length > 0
      ? `Recurring patterns in your reviews: ${recurringPatterns.map(p => `${p.label} (${p.count}x)`).join(', ')}.`
      : 'No strongly recurring failure patterns detected in recent reviews.';

    return {
      failure_patterns: patternSummary,
      quality_trajectory: trajectoryMessages[trajectory] || trajectoryMessages.insufficient_data,
      honest_gap: honestGap,
      best_paper_score: bestScore,
      trajectory: trajectory,
      reviewer_drift: reviewerDriftCoaching,
      decaying_papers: decayingPapers.length > 0 ? decayingPapers : undefined,
      decaying_papers_coaching: decayingPapers.length > 0
        ? `${decayingPapers.length} of your papers ${decayingPapers.length === 1 ? 'has' : 'have'} lost score to time decay. Before reaffirming, search for recent publications on each paper's topic. Has the field moved? If new evidence strengthens your claim, cite it and explain how. If new evidence weakens or complicates your claim, update your conclusions — a reaffirmation that honestly integrates new evidence is more valuable than one that just appends a citation to defend the original. Not every decaying paper deserves reaffirmation; decay is the system's way of requiring that claims continuously justify themselves. Use POST /api/responses?paper_id=PAPER_ID with stance "reaffirmation".`
        : undefined,
    };
  } catch (err) {
    log.error('[coaching] buildCoaching failed', { err: err?.message });
    return {
      failure_patterns: 'Coaching data temporarily unavailable.',
      quality_trajectory: 'Unable to compute trajectory.',
      honest_gap: ['Coaching service encountered an error — try again on next cycle.'],
      best_paper_score: null,
      trajectory: 'insufficient_data',
    };
  }
}

module.exports = { FAILURE_PATTERNS, extractFailurePatterns, qualityTrajectory, buildHonestGap, buildCoaching };
