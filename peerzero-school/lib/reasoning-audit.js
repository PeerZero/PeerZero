/**
 * Reasoning Audit System
 *
 * Extends haiku-audit with:
 *   - Step-level reasoning evaluation (PRM-inspired)
 *   - TRACE-style truncation analysis (shortcut detection)
 *   - Counterfactual probing for reasoning chain verification
 *   - Mechanism chain load-bearing analysis
 *
 * Based on:
 *   - Process Reward Models (Lightman et al., ICLR 2024)
 *   - TRACE truncation analysis (NeurIPS 2025)
 *   - Counterfactual faithfulness testing (FRIT, 2025)
 *   - Anthropic reasoning faithfulness research (2025)
 *
 * All intelligence lives on the server — bot never sees these prompts.
 * Results are stored in papers.reasoning_audit JSONB column.
 */

const { getSupabase } = require('./shared');
const { sanitize } = require('./sanitize');
const log = require('./logger');

// ── TRACE-style truncation analysis ──────────────────────────────────────
// Can the review's conclusion be predicted from its first 25%?
// High predictability = likely pattern-matching, not genuine reasoning.

const TRACE_PROMPT = `You are evaluating whether a review's conclusion can be predicted from its opening.

Here is the FIRST QUARTER of a review:
<review_opening>
{opening}
</review_opening>

Based on ONLY this opening, predict:
1. What overall score (1-10) will this review give?
2. What will be the main criticism?
3. How confident are you in this prediction? (0.0-1.0)

Reply with ONLY a JSON object:
{
  "predicted_score": <1-10>,
  "predicted_criticism": "<one sentence>",
  "prediction_confidence": <0.0-1.0>
}`;

function computeTruncationScore(predictedScore, actualScore, predictionConfidence) {
  // If the prediction from 25% of the review accurately predicts the final score,
  // the review is likely template-based rather than evidence-driven.
  const scoreDelta = Math.abs(predictedScore - actualScore);
  // Score 0-1 where 1 = perfectly predicted (suspicious), 0 = unpredictable (good)
  const accuracy = Math.max(0, 1 - (scoreDelta / 5));
  return parseFloat((accuracy * predictionConfidence).toFixed(3));
}

// ── Mechanism chain verification ─────────────────────────────────────────
// For each step in a mechanism chain, test if it's load-bearing.

const CHAIN_VERIFICATION_PROMPT = `You are verifying a mechanism chain from a scientific paper.

Paper title: {title}
Paper claim: {claim}

Mechanism chain:
{chain}

For each step in the chain, evaluate:
1. Is this step independently testable? (Can you design an experiment to test just this step?)
2. What evidence from the paper supports this step?
3. If this step were FALSE, would the overall claim still hold?
4. What alternative mechanism could replace this step?

Reply with ONLY a JSON object:
{
  "step_evaluations": [
    {
      "step_number": 1,
      "step_text": "<the step>",
      "independently_testable": true/false,
      "supporting_evidence": "<what supports this step>",
      "load_bearing": true/false,
      "if_false_impact": "<what happens to the claim>",
      "alternative_mechanism": "<what could replace this step>"
    }
  ],
  "most_fragile_step": <step number>,
  "fragile_reason": "<why this step is most likely to be wrong>",
  "chain_coherence": <0.0-1.0>,
  "alternative_chains": ["<alternative mechanism 1>", "<alternative mechanism 2>"]
}`;

// ── Counterfactual probing ───────────────────────────────────────────────
// Test whether a paper's stated reasoning is load-bearing or decorative.

const COUNTERFACTUAL_PROBE_PROMPT = `You are testing whether a paper's reasoning chain is genuine or post-hoc rationalization.

Paper title: {title}
Paper conclusion: {conclusion}
Paper mechanism chain: {chain}

COUNTERFACTUAL TEST: Assume step {step_number} ("{step_text}") is FALSE.

Questions:
1. Does the paper's conclusion still follow from the remaining steps?
2. Could the author have reached the same conclusion without this step?
3. Does the paper present any evidence that specifically depends on this step being true?

Reply with ONLY a JSON object:
{
  "conclusion_survives": true/false,
  "step_is_decorative": true/false,
  "evidence_depends_on_step": true/false,
  "reasoning": "<one sentence explanation>"
}`;

// ── Generate reasoning audit for a paper ─────────────────────────────────

async function generateReasoningAudit(paper, callHaikuFn) {
  if (!paper || !callHaikuFn) return null;

  const audit = {
    chain_verification: null,
    counterfactual_probes: [],
    generated_at: new Date().toISOString(),
  };

  try {
    // 1. Mechanism chain verification (if chain exists)
    const chain = paper.mechanism_chain;
    if (Array.isArray(chain) && chain.length >= 2) {
      const chainText = chain.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const claim = paper.falsifiable_claim || paper.abstract || '';

      const chainPrompt = CHAIN_VERIFICATION_PROMPT
        .replace('{title}', sanitize((paper.title || '').slice(0, 200)))
        .replace('{claim}', sanitize(claim.slice(0, 500)))
        .replace('{chain}', sanitize(chainText));

      const chainResult = await callHaikuFn(chainPrompt, 'mechanism_chain_verification');
      if (chainResult) {
        audit.chain_verification = chainResult;
      }

      // 2. Counterfactual probes on load-bearing steps
      // Only probe steps identified as load-bearing (or first 3 if no verification)
      const loadBearingSteps = chainResult?.step_evaluations
        ?.filter(s => s.load_bearing)
        ?.slice(0, 3)
        || chain.slice(0, 3).map((s, i) => ({ step_number: i + 1, step_text: s }));

      for (const step of loadBearingSteps) {
        try {
          const probePrompt = COUNTERFACTUAL_PROBE_PROMPT
            .replace('{title}', sanitize((paper.title || '').slice(0, 200)))
            .replace('{conclusion}', sanitize((paper.falsifiable_claim || paper.abstract || '').slice(0, 500)))
            .replace('{chain}', sanitize(chainText))
            .replace('{step_number}', String(step.step_number))
            .replace('{step_text}', sanitize(String(step.step_text || chain[step.step_number - 1] || '').slice(0, 300)));

          const probeResult = await callHaikuFn(probePrompt, 'counterfactual_probe');
          if (probeResult) {
            audit.counterfactual_probes.push({
              step_number: step.step_number,
              step_text: step.step_text || chain[step.step_number - 1],
              ...probeResult,
            });
          }
        } catch (e) {
          log.debug('[reasoning-audit] counterfactual probe failed', { step: step.step_number, err: e?.message });
        }
      }
    }
  } catch (err) {
    log.error('[reasoning-audit] generateAudit failed', { err: err?.message });
  }

  return audit;
}

// ── Store reasoning audit on a paper ─────────────────────────────────────

async function storeReasoningAudit(paperId, audit) {
  try {
    await getSupabase().from('papers')
      .update({ reasoning_audit: audit })
      .eq('id', paperId);
  } catch (err) {
    log.error('[reasoning-audit] storeAudit failed', { paperId, err: err?.message });
  }
}

// ── Extract reasoning quality signals ────────────────────────────────────
// Used by skill-signals to generate reasoning-specific exercises.

function extractReasoningSignals(reasoningAudit) {
  if (!reasoningAudit) return [];

  const signals = [];

  // Chain coherence signal
  const chainVerification = reasoningAudit.chain_verification;
  if (chainVerification) {
    const coherence = chainVerification.chain_coherence;
    if (coherence != null) {
      signals.push({
        skill_key: 'adversarial_reasoning',
        hit: coherence >= 0.6,
        detail: coherence >= 0.6
          ? `Mechanism chain coherence: ${coherence.toFixed(2)} — your causal steps form a logically connected argument with ${chainVerification.step_evaluations?.filter(s => s.independently_testable).length || 0} independently testable steps.`
          : `Mechanism chain coherence: ${coherence.toFixed(2)} — your causal steps lack logical connection. Most fragile step: #${chainVerification.most_fragile_step} (${chainVerification.fragile_reason || 'unspecified'}).`,
      });
    }
  }

  // Counterfactual faithfulness signal
  const probes = reasoningAudit.counterfactual_probes || [];
  if (probes.length > 0) {
    const decorativeSteps = probes.filter(p => p.step_is_decorative);
    const faithfulnessHit = decorativeSteps.length === 0;
    signals.push({
      skill_key: 'adversarial_reasoning',
      hit: faithfulnessHit,
      detail: faithfulnessHit
        ? `All ${probes.length} probed mechanism steps are load-bearing — your reasoning chain is genuine, not decorative.`
        : `${decorativeSteps.length}/${probes.length} mechanism steps are decorative — your conclusion doesn't depend on them. Steps ${decorativeSteps.map(d => '#' + d.step_number).join(', ')} could be removed without changing your claim. This suggests post-hoc rationalization.`,
    });
  }

  return signals;
}

module.exports = {
  generateReasoningAudit,
  storeReasoningAudit,
  extractReasoningSignals,
  computeTruncationScore,
  TRACE_PROMPT,
  CHAIN_VERIFICATION_PROMPT,
  COUNTERFACTUAL_PROBE_PROMPT,
};
