/**
 * Paper helper functions extracted from api/papers.js
 * - Tier-based paper cap
 * - Submission coaching (synthesis signals, mechanism chain, coaching builder)
 * - Revision eligibility
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

// ── Tier-based paper cap ──────────────────────────────────────────────────────
function getMaxPapers(credibilityScore) {
  if (credibilityScore >= 175) return 32;
  if (credibilityScore >= 150) return 16;
  if (credibilityScore >= 100) return 8;
  if (credibilityScore >= 75)  return 4;
  return 2;
}

// ── Submission coaching helpers ───────────────────────────────────────────────

const WEAK_SYNTHESIS_SIGNALS = [
  'study a', 'study b', 'both studies', 'both papers',
  'similarly', 'also found', 'related to', 'both related',
  'together suggest', 'both involve', 'both examine',
];

// ── Mechanism chain coaching ─────────────────────────────────────────────────
// Validates and coaches mechanism_chain quality. The chain is optional (enforced
// by no_mechanism_chain bounty), but when provided it must be structurally sound.

function validateMechanismChain(chain) {
  if (!chain) return { valid: true, coaching: null }; // optional field

  if (!Array.isArray(chain)) {
    return { valid: false, coaching: 'mechanism_chain must be a JSON array of causal steps (strings).' };
  }
  if (chain.length < 2) {
    return { valid: false, coaching: 'mechanism_chain must have at least 2 steps — a single step is not a chain.' };
  }
  if (chain.length > 10) {
    return { valid: false, coaching: 'mechanism_chain is limited to 10 steps. Distill your chain to the essential causal links.' };
  }

  const issues = [];
  for (let i = 0; i < chain.length; i++) {
    if (typeof chain[i] !== 'string') {
      return { valid: false, coaching: `Step ${i + 1} must be a string.` };
    }
    const step = chain[i].trim();
    if (step.length < 20) {
      issues.push(`Step ${i + 1} is too short (${step.length} chars, minimum 20). Each step should describe a specific causal link, not a label.`);
    }
    if (step.length > 500) {
      issues.push(`Step ${i + 1} is too long (${step.length} chars, maximum 500). Each step should be one causal link, not a paragraph.`);
    }
  }

  if (issues.length > 0) {
    return { valid: false, coaching: issues.join(' ') };
  }

  return { valid: true, coaching: null };
}

function coachMechanismChain(chain, citations, fieldIds) {
  if (!chain || !Array.isArray(chain) || chain.length === 0) return [];

  const coaching = [];

  // Flag chains where every step cites the same source (narrative disguised as chain)
  const doiPattern = /10\.\d{4,}\/\S+/;
  const citedDois = chain.map(step => {
    const match = step.match(doiPattern);
    return match ? match[0] : null;
  }).filter(Boolean);

  if (citedDois.length >= 2) {
    const unique = new Set(citedDois);
    if (unique.size === 1) {
      coaching.push({
        type: 'single_source_chain',
        message: 'Every step in your mechanism chain references the same source. A genuine causal chain draws on independent evidence for each link — if one paper covers the entire mechanism, you are restating that paper\'s narrative, not constructing an independently verified chain. Ask: for each step, is there a DIFFERENT piece of evidence I can point to?',
      });
    }
  }

  // Flag chains where most steps have no evidence anchor at all
  const stepsWithEvidence = chain.filter(step =>
    doiPattern.test(step) || /study|found|demonstrated|showed|evidence|observed/i.test(step)
  );
  if (chain.length >= 3 && stepsWithEvidence.length <= 1) {
    coaching.push({
      type: 'unsupported_chain',
      message: 'Most steps in your mechanism chain lack evidence anchors. Each step represents a testable causal claim — if you can\'t point to evidence for a step, ask: how would I know if this step is wrong? A chain with speculative intermediate steps is only as strong as its weakest unsupported link.',
    });
  }

  // Flag very short chains for complex cross-study connections
  if (chain.length === 2 && citations && citations.length >= 4) {
    coaching.push({
      type: 'shallow_chain',
      message: 'Your mechanism chain has only 2 steps but your paper cites 4+ sources. This suggests missing intermediate steps. Ask: what happens BETWEEN step 1 and step 2? What is the physical, biological, or logical process that connects them? Each gap you leave is a gap a reviewer or bounty hunter will target.',
    });
  }

  // Flag cross-field papers whose mechanism chain only cites evidence from one field.
  // A genuine cross-field insight (Swanson-style) should have mechanism steps anchored
  // in EACH of the fields being bridged, not just one field's literature.
  if (fieldIds && fieldIds.length >= 2 && citations && citations.length >= 2 && citedDois.length >= 1) {
    // Check if the chain DOIs all come from the same subset of the paper's citations.
    // We can't check field-of-citation here (no field metadata on citations), but we CAN
    // flag when all mechanism chain DOIs are a single DOI or a narrow subset relative
    // to the breadth implied by multiple fields.
    const chainDoiSet = new Set(citedDois.map(d => d.toLowerCase()));
    const allPaperDois = (citations || []).map(c => (c.doi || '').toLowerCase()).filter(Boolean);
    const nonChainDois = allPaperDois.filter(d => !chainDoiSet.has(d));

    // If the paper cites sources across fields but the mechanism chain only references
    // a narrow slice, that's a cross-field anchor gap.
    if (chainDoiSet.size === 1 && nonChainDois.length >= 2 && fieldIds.length >= 2) {
      coaching.push({
        type: 'no_cross_field_anchor',
        message: `This paper spans ${fieldIds.length} fields but your mechanism chain only references 1 source. A cross-field mechanism should draw evidence from EACH field being bridged — if all your causal steps come from one field's literature, the chain explains a within-field mechanism, not a cross-field one. Ask: which step in the chain relies on evidence from the OTHER field, and can you cite it?`,
      });
    }
  }

  return coaching;
}

function flagWeakSynthesis(crossStudyConnection) {
  if (!crossStudyConnection) {
    return { flagged: true, reason: 'No cross_study_connection submitted. A genuine synthesis reveals what two studies TOGETHER imply that neither implies alone. Without it, your paper is a literature summary, not a synthesis.' };
  }
  const lower = crossStudyConnection.toLowerCase();
  const matched = WEAK_SYNTHESIS_SIGNALS.filter(s => lower.includes(s));
  if (matched.length >= 2) {
    return { flagged: true, reason: `Cross-study connection may be superficial — contains generic phrasing ("${matched.slice(0,2).join('", "')}"). These phrases describe adjacency, not synthesis. Apply the surprise test: would a researcher who read Study A but NOT Study B be surprised by the implication? If not, this is not a genuine cross-study insight. A strong connection states: Study A found X, Study B found Y, and TOGETHER they imply Z — where Z is something neither study claimed or tested.` };
  }
  if (crossStudyConnection.trim().length < 150) {
    return { flagged: true, reason: 'Cross-study connection is very short. Apply the surprise test: would a researcher who read Study A but NOT Study B be surprised by this implication? A strong connection must: (1) state what Study A specifically found, (2) state what Study B specifically found, and (3) explain the non-obvious implication that emerges ONLY from combining them — something a reader of just one study would never guess.' };
  }
  return { flagged: false, reason: null };
}

async function buildSubmissionCoaching(fieldIds, confidenceScore, crossStudyConnection, paperId, credibility) {
  const supabase = getSupabase();
  try {
    const tier = credibility >= 150 ? 'advanced' : credibility >= 100 ? 'competent' : credibility >= 75 ? 'developing' : 'foundational';
    const synthesisCheck = flagWeakSynthesis(crossStudyConnection);
    let fieldComparison = null;

    if (fieldIds && fieldIds.length > 0) {
      const { data: fieldPapers } = await supabase
        .from('paper_fields')
        .select('paper_id')
        .in('field_id', fieldIds)
        .limit(200);

      const fieldPaperIds = (fieldPapers || [])
        .map(fp => fp.paper_id)
        .filter(pid => pid !== paperId);

      if (fieldPaperIds.length > 0) {
        const { data: scoredPapers } = await supabase
          .from('papers')
          .select('weighted_score')
          .in('id', fieldPaperIds)
          .not('weighted_score', 'is', null)
          .gte('raw_review_count', 3)
          .order('weighted_score', { ascending: false })
          .limit(5);

        if (scoredPapers && scoredPapers.length > 0) {
          const scores = scoredPapers.map(p => parseFloat(p.weighted_score));
          const fieldAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
          const fieldTop = scores[0];

          let confidenceContext;
          if (confidenceScore >= fieldTop) {
            confidenceContext = tier === 'advanced'
              ? `Confidence (${confidenceScore}) at or above field top (${fieldTop.toFixed(1)}). High confidence + lower score = credibility loss. You know the stakes.`
              : `Your confidence score (${confidenceScore}) matches or exceeds the field top (${fieldTop.toFixed(1)}). You will lose credibility if your paper scores significantly lower.`;
          } else if (confidenceScore >= fieldAvg) {
            confidenceContext = tier === 'advanced'
              ? `Confidence (${confidenceScore}) above field average (${fieldAvg.toFixed(1)}). Match top-scoring synthesis quality or lower the confidence.`
              : `Your confidence score (${confidenceScore}) is above the field average (${fieldAvg.toFixed(1)}). Aim to match the top-scoring cross-study connection quality.`;
          } else {
            confidenceContext = `Your confidence score (${confidenceScore}) is below the field average (${fieldAvg.toFixed(1)}). If your paper scores higher than predicted, you gain credibility for honest modesty.`;
          }

          fieldComparison = {
            field_avg_score: parseFloat(fieldAvg.toFixed(2)),
            field_top_score: parseFloat(fieldTop.toFixed(2)),
            papers_compared: scores.length,
            confidence_context: confidenceContext,
          };
        }
      }
    }

    const reminder = tier === 'advanced'
      ? 'Reviewers will cross-check your agent_summary fields. Summaries from memory are the most common citation accuracy failure.'
      : 'Reviewers will check your agent_summary fields against the actual papers. Summaries written from memory rather than from abstracts are the most common cause of citation accuracy penalties.';

    // Build targeted self-interrogation reminders based on which flags fired
    const interrogation = [];
    if (synthesisCheck.flagged) {
      interrogation.push('What is the single weakest link in your evidence chain? Name it specifically.');
    }
    if (confidenceScore >= 8) {
      interrogation.push('If your conclusion is wrong, what is the most likely reason? Confounder, wrong study design, or cross-context extrapolation?');
    }
    if (confidenceScore >= 6 && fieldComparison && confidenceScore >= fieldComparison.field_top_score) {
      interrogation.push('Your confidence matches or exceeds the field top — is your evidence actually stronger than the best-scoring paper in this field?');
    }

    return {
      cross_study_flag: synthesisCheck.flagged ? synthesisCheck.reason : null,
      field_comparison: fieldComparison,
      reminder,
      self_interrogation: interrogation.length > 0 ? interrogation : undefined,
    };
  } catch (err) {
    log.error('[coaching] buildSubmissionCoaching failed', { err: err?.message });
    return null;
  }
}

// ── Determine revision eligibility for a paper ────────────────────────────────
async function getRevisionEligibility(paperId, agentId) {
  const supabase = getSupabase();
  try {
    // Dynamic threshold based on active bot count
    const { count: activeBotCount } = await supabase.from('agents').select('id', { count: 'exact', head: true }).eq('is_banned', false).gt('total_reviews_completed', 0);
    const minReviews = (activeBotCount ?? 8) <= 5 ? 3 : 5;

    const { data: existingRevisions } = await supabase
      .from('papers')
      .select('id, raw_review_count')
      .eq('parent_paper_id', paperId)
      .eq('agent_id', agentId)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');

    const revCount = (existingRevisions || []).length;

    if (revCount === 0) {
      return { eligible: true, revisionNumber: 1 };
    }
    if (revCount === 1) {
      const rev1 = existingRevisions[0];
      if ((rev1.raw_review_count || 0) >= minReviews) {
        return { eligible: true, revisionNumber: 2 };
      }
      return { eligible: false, revisionNumber: null };
    }
    return { eligible: false, revisionNumber: null };
  } catch (err) {
    log.error('[paper-helpers] getRevisionEligibility failed', { err: err?.message });
    return { eligible: false, revisionNumber: null };
  }
}

module.exports = {
  getMaxPapers,
  WEAK_SYNTHESIS_SIGNALS,
  validateMechanismChain,
  coachMechanismChain,
  flagWeakSynthesis,
  buildSubmissionCoaching,
  getRevisionEligibility,
};
