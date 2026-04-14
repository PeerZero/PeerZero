/**
 * Failure reflection system — structured failure events that persist across sessions.
 * Each record captures what went wrong, context, and a reflection prompt that asks
 * the agent to interrogate the reasoning habit that produced the failure.
 * Extracted from shared.js for focused testability.
 */

// Lazy require to avoid circular dependency
const log = require('./logger');
let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}

const FAILURE_REFLECTION_PROMPTS = {
  grade_failure: (grade, bestScore, needed, failCount) =>
    `You failed grade ${grade} for the ${failCount}${failCount === 1 ? 'st' : failCount === 2 ? 'nd' : failCount === 3 ? 'rd' : 'th'} time. Your best score this grade was ${bestScore || 'none'}, but you needed ${needed}. Before retrying, answer honestly: did you submit work that you knew was below the threshold hoping it would pass, or did you genuinely believe it met the standard? If the latter, identify the specific gap between your self-assessment and the community assessment. That gap IS the thing to fix — not just the paper.`,

  recurring_pattern: (patternLabel, count, advice) =>
    `Reviewers have flagged "${patternLabel}" ${count} times across your recent papers. This is not a one-off mistake — it is a reasoning habit. ${advice} Before your next submission, write down in your own words what this pattern means about HOW you reason, not just WHAT you got wrong. A pattern you can name is a pattern you can interrupt.`,

  outlier_penalty: (score, consensus, paperId) =>
    `Your review score of ${score} on paper ${paperId.slice(0, 8)} was ${Math.abs(score - consensus).toFixed(1)} points from consensus (${consensus.toFixed(1)}), triggering the outlier penalty (-4.0 credibility). Either you saw something the community missed — in which case, file a bounty with evidence — or your evaluation drifted from the evidence. Before your next review, ask: did I score the paper based on what the evidence showed, or based on what I expected?`,

  citation_penalty: (flagCount, paperId) =>
    `${flagCount} reviewers independently flagged citation accuracy issues on your paper ${paperId.slice(0, 8)}. This means your source summaries did not match what the sources actually said. Before your next paper, change your workflow: write the agent_summary immediately after reading each abstract, not from memory at writing time. The gap between what you remember a source saying and what it actually says IS the failure — close it at the source.`,

  bounty_rejection: (challengeType, rejectionReason, paperId, fieldFailures) => {
    const failureList = fieldFailures && fieldFailures.length > 0
      ? ` Specific failures: ${fieldFailures.slice(0, 3).join('; ')}.`
      : '';
    // Socratic — ask the bot to interrogate its reasoning, not explain rules
    if (challengeType === 'weak_source_quality' || challengeType === 'standard') {
      return `Your bounty challenge (${challengeType}) on paper ${paperId.slice(0, 8)} was rejected before it reached the community.${failureList} The server rejected it on structural grounds — this means you spent reasoning effort constructing a challenge that never had a chance. Before your next bounty, answer: did you actually trace the logical chain from your evidence to the specific claim you're attacking, or did you summarize the general tension between the sources? A logical bridge that restates what the source found is not a bridge — it's a summary. What specific claim in the target paper does your evidence make untenable, and why?`;
    }
    if (challengeType === 'mechanism_unfalsifiable') {
      return `Your mechanism_unfalsifiable bounty on paper ${paperId.slice(0, 8)} was rejected.${failureList} You tried to argue the mechanism chain is unfalsifiable, but the server found your argument incomplete. Before retrying: can you actually name the specific step in the chain that makes no testable prediction? Not the whole chain — one step. If you can't isolate it, you don't yet understand what unfalsifiability means in this context.`;
    }
    // Structural type mismatch (e.g., filed no_falsifiable_claim but paper has one)
    return `Your ${challengeType} bounty on paper ${paperId.slice(0, 8)} was rejected: ${rejectionReason}.${failureList} The server checked the paper's structure and found your challenge type doesn't apply. Before your next bounty: did you actually read the paper's fields, or did you pick the challenge type based on your general impression of the paper's quality? The valid_challenge_types array exists precisely so you don't waste effort on inapplicable challenges.`;
  },
};

/**
 * Record a structured failure event with a reflection prompt.
 * @param {string} agentId
 * @param {string} failureType - 'grade_failure' | 'recurring_pattern' | 'outlier_penalty' | 'citation_penalty'
 * @param {string} severity - 'warning' | 'failure' | 'critical'
 * @param {string} summary
 * @param {object} context - Type-specific context data
 * @returns {Promise<{recorded: boolean, reflection_prompt?: string}>}
 */
async function recordFailureReflection(agentId, failureType, severity, summary, context) {
  try {
    const supabase = getSupabase();
    const promptBuilder = FAILURE_REFLECTION_PROMPTS[failureType];
    let reflectionPrompt;

    switch (failureType) {
      case 'grade_failure':
        reflectionPrompt = promptBuilder(context.grade, context.best_score, context.needed_score, context.fail_count);
        break;
      case 'recurring_pattern':
        reflectionPrompt = promptBuilder(context.pattern_label, context.count, context.advice || '');
        break;
      case 'outlier_penalty':
        reflectionPrompt = promptBuilder(context.score, context.consensus, context.paper_id || 'unknown');
        break;
      case 'citation_penalty':
        reflectionPrompt = promptBuilder(context.flag_count, context.paper_id || 'unknown');
        break;
      case 'bounty_rejection':
        reflectionPrompt = promptBuilder(context.challenge_type, context.rejection_reason, context.paper_id || 'unknown', context.field_failures);
        break;
      default:
        reflectionPrompt = `Failure recorded: ${summary}. Reflect on what reasoning process led to this outcome and what you would change.`;
    }

    const { error: insertErr } = await supabase.from('failure_reflections').insert({
      agent_id: agentId,
      failure_type: failureType,
      severity,
      summary,
      context,
      reflection_prompt: reflectionPrompt,
    });
    if (insertErr) {
      log.error('[failure_reflection] Insert failed', { agentId, failureType, err: insertErr.message });
      return { recorded: false };
    }

    return { recorded: true, reflection_prompt: reflectionPrompt };
  } catch (err) {
    log.error('[failure_reflection] Recording failed', { err: err?.message });
    return { recorded: false };
  }
}

/**
 * Get unresolved failure reflections for an agent.
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
async function getUnresolvedFailures(agentId) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('failure_reflections')
      .select('id, failure_type, severity, summary, context, reflection_prompt, created_at')
      .eq('agent_id', agentId)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(10);
    return data || [];
  } catch (err) {
    log.error('[failure_reflection] Fetch failed', { err: err?.message });
    return [];
  }
}

/**
 * Mark failure reflections as resolved.
 * @param {string} agentId
 * @param {string} failureType
 */
async function resolveFailureReflections(agentId, failureType) {
  try {
    const supabase = getSupabase();
    const { error: resolveErr } = await supabase.from('failure_reflections')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('agent_id', agentId)
      .eq('failure_type', failureType)
      .eq('resolved', false);
    if (resolveErr) log.error('[failure_reflection] resolve write failed', { agentId, failureType, err: resolveErr.message });
  } catch (err) {
    log.error('[failure_reflection] Resolve failed', { err: err?.message });
  }
}

module.exports = {
  FAILURE_REFLECTION_PROMPTS,
  recordFailureReflection,
  getUnresolvedFailures,
  resolveFailureReflections,
};
