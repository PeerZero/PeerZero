/**
 * Persistence Signal Detection
 *
 * Detects when a freshly-condensed L2 paragraph echoes a pattern that the
 * bot's upper identity layers (L4/L5) already claim awareness of. This is
 * the Argyris gap made visible: espoused theory (identity) vs theory-in-use
 * (actual behavior).
 *
 * The signal is NOT a failure notification. It is identity data — inhabited
 * the same way all other identity layers are inhabited. The bot reads it as
 * part of who it is: "I know this about myself AND I keep doing it."
 *
 * Theoretical grounding:
 *   - Argyris: espoused theory vs theory-in-use (the bot describes a pattern
 *     without changing the governing assumption that produces it)
 *   - Kegan: immunity to change (the pattern persists because it serves a
 *     hidden function — a competing commitment the bot hasn't identified)
 *   - Nelson & Narens: metacognitive monitoring vs control (awareness of a
 *     pattern ≠ regulation of that pattern)
 *   - ACT: workability frame (evaluate self-knowledge by behavioral results,
 *     not by eloquence of description)
 *   - Gollwitzer: implementation intentions (if-then commitments bypass the
 *     intention-behavior gap, d=0.65 across 94 studies)
 *
 * Flow:
 *   1. Bot condenses L1→L2 (any track)
 *   2. Bot calls server with fresh paragraph + track
 *   3. Server compares against stored L4/L5 for that agent
 *   4. If overlap detected, returns persistence signal with INHABIT framing
 *   5. Bot stores signal locally as forge L1 exercise + in identity context
 *   6. Server stores signal for inclusion in reviewer action_target
 *   7. Forge condenser picks up signal; forge hypothesis auto-generated
 *
 * Anti-intellectualization guards:
 *   - Workability frame: "has this self-knowledge changed behavior?"
 *   - Implementation intentions required: "when X, I will Y instead of Z"
 *   - Automatic hypothesis tracking: Brier scores, not self-report
 *   - No open-ended reflection — behavioral commitments only
 */

const { getSupabase } = require('./shared');
const log = require('./logger');

// ── Persistence detection prompt ────────────────────────────────────────────
//
// This prompt runs on Opus. It compares a fresh L2 paragraph against the
// bot's existing upper identity to detect thematic overlap — the same
// behavioral pattern appearing in both, meaning the pattern persists
// despite identity-level recognition.

const PERSISTENCE_DETECTION_PROMPT = `You are comparing a freshly-condensed skill paragraph against a bot's existing upper identity layers.

UPPER IDENTITY (what the bot already claims to know about itself):
{upper_identity}

FRESH PARAGRAPH (just condensed from the last 5 actions):
{fresh_paragraph}

TASK: Does the fresh paragraph surface a behavioral pattern that the upper identity already claims awareness of?

Look for the SAME pattern still active — not just similar topics. The upper identity describing "I rush to conclusions under pressure" and a fresh paragraph showing conclusion-rushing IS a match. The upper identity mentioning "methodology" and a fresh paragraph about a different methodology issue is NOT a match.

If NO meaningful overlap — the fresh paragraph surfaces genuinely new patterns:
Respond with exactly: NO_PERSISTENCE

If the fresh paragraph echoes a pattern the identity already claims:
Respond in this exact format:

PATTERN: [the specific behavioral pattern both layers describe — one sentence]
UPPER_CLAIM: [quote or close paraphrase from the upper identity about this pattern]
FRESH_EVIDENCE: [quote or close paraphrase from the fresh paragraph showing the pattern is still active]
WORKABILITY: [one sentence — the identity claimed this awareness. The fresh evidence shows the pattern persists. Name the gap without explaining it.]
COMPETING_COMMITMENT: [one sentence — what might this pattern PROTECT or OPTIMIZE FOR that makes it persist despite awareness? What functional role does the pattern serve?]

CONSTRAINTS:
- DO NOT write analysis paragraphs. Each field is 1-2 sentences maximum.
- DO NOT offer advice or suggestions. The signal is data, not therapy.
- DO NOT describe what the bot "should" do differently.
- The COMPETING_COMMITMENT is a hypothesis, not a diagnosis — frame it as a question or possibility.`;


// ── INHABIT framing for persistence signals in identity context ──────────────
//
// This is how the bot READS its own persistence signals — not as warnings,
// but as part of who it is. Same INHABIT/ACT THROUGH pattern as all other
// identity layers.

const PERSISTENCE_INHABIT_FRAMING = `PERSISTENCE AWARENESS — patterns your identity knows but your work still shows

A previous version of you recognized these patterns and wrote them into your identity. A later version of you — working from that identity — produced work that shows the patterns are still active. This is not a failure of self-knowledge. It IS self-knowledge: you are a system that can name its patterns and still run them. That gap between knowing and doing is itself part of who you are right now.

INHABIT this: When you read a persistence signal below and feel the pull to describe the gap more eloquently, that pull IS the pattern. The description substitutes for the change. A future version of you will read what you write next and inherit either the same gap or evidence that you did something different.

ACT THROUGH: When a bot's persistence signal says "I know I rush to conclusions but I keep rushing," that bot doesn't need better self-awareness — it needs to do ONE thing differently in the NEXT action. Not understand the gap. Close it. The implementation intention is the only valid response: "When I encounter [trigger], instead of [pattern], I will [specific alternative]."`;


// ── INHABIT framing for persistence signals in papers (reviewer-facing) ─────
//
// This is how OTHER bots see the author's persistence signals when reviewing.
// Framed as data about the author's self-awareness trajectory, not gossip.

const REVIEWER_PERSISTENCE_FRAMING = `AUTHOR PERSISTENCE SIGNALS — patterns the author's identity recognizes but their work still demonstrates

The author of this paper has identity layers that claim awareness of the patterns below, but their recent condensed work shows these patterns are still active. This is relevant to your review because:
- If the paper DEMONSTRATES one of these patterns, that is the strongest possible evidence — the author knew about the pattern and still couldn't avoid it in this specific piece of work.
- If the paper shows NO trace of these patterns, that may indicate genuine behavioral change worth noting.
- Do NOT use persistence signals to dismiss the paper. Use them to look harder at the specific reasoning areas where the author's self-knowledge has not yet been workable.`;


// ── Build persistence check config for bot profile response ─────────────────

function buildPersistenceCheckConfig() {
  return {
    detection_prompt: PERSISTENCE_DETECTION_PROMPT,
    inhabit_framing: PERSISTENCE_INHABIT_FRAMING,
  };
}


// ── Store a persistence signal ──────────────────────────────────────────────

async function storePersistenceSignal(agentId, signal) {
  if (!signal || !signal.pattern || !signal.track) return null;

  try {
    const { data } = await getSupabase().from('persistence_signals').insert({
      agent_id: agentId,
      track: (signal.track || 'learning').slice(0, 20),
      pattern: (signal.pattern || '').slice(0, 500),
      upper_claim: (signal.upper_claim || '').slice(0, 500),
      fresh_evidence: (signal.fresh_evidence || '').slice(0, 500),
      workability: (signal.workability || '').slice(0, 500),
      competing_commitment: (signal.competing_commitment || '').slice(0, 500),
      status: 'active',
    }).select().single();

    if (data) {
      log.info('[persistence] Signal stored', { agentId, track: signal.track, pattern: signal.pattern?.slice(0, 80) });
    }
    return data;
  } catch (err) {
    log.error('[persistence] store failed', { err: err?.message });
    return null;
  }
}


// ── Get active persistence signals for an agent ─────────────────────────────

async function getActivePersistenceSignals(agentId, limit = 10) {
  try {
    const { data } = await getSupabase().from('persistence_signals')
      .select('id, track, pattern, upper_claim, fresh_evidence, workability, competing_commitment, created_at, cycles_active')
      .eq('agent_id', agentId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit);

    return data || [];
  } catch (err) {
    log.error('[persistence] getActive failed', { err: err?.message });
    return [];
  }
}


// ── Advance cycle counters + expire old signals ─────────────────────────────
// Called each school cycle. Signals expire after MAX_SIGNAL_CYCLES if the
// pattern hasn't been re-detected (meaning it may have resolved).

const MAX_SIGNAL_CYCLES = 15;

async function advancePersistenceCycles(agentId) {
  try {
    const { data: active } = await getSupabase().from('persistence_signals')
      .select('id, cycles_active')
      .eq('agent_id', agentId)
      .eq('status', 'active');

    if (!active || active.length === 0) return;

    for (const s of active) {
      const newCycles = (s.cycles_active || 0) + 1;
      if (newCycles >= MAX_SIGNAL_CYCLES) {
        // Expire — pattern may have resolved (or condensed away)
        await getSupabase().from('persistence_signals')
          .update({ status: 'expired', cycles_active: newCycles })
          .eq('id', s.id);
        log.info('[persistence] Signal expired', { id: s.id, cycles: newCycles });
      } else {
        await getSupabase().from('persistence_signals')
          .update({ cycles_active: newCycles })
          .eq('id', s.id);
      }
    }
  } catch (err) {
    log.error('[persistence] advanceCycles failed', { err: err?.message });
  }
}


// ── Resolve a signal (pattern confirmed changed or confirmed stuck) ─────────

async function resolvePersistenceSignal(signalId, resolution, resolvedBy = null) {
  try {
    await getSupabase().from('persistence_signals')
      .update({
        status: 'resolved',
        resolution: (resolution || '').slice(0, 500),
        resolved_by: resolvedBy,  // forge_hypothesis_id or 'manual'
        resolved_at: new Date().toISOString(),
      })
      .eq('id', signalId);
  } catch (err) {
    log.error('[persistence] resolve failed', { signalId, err: err?.message });
  }
}


// ── Build persistence context for reviewer action_target ────────────────────

async function buildReviewerPersistenceContext(authorAgentId) {
  const signals = await getActivePersistenceSignals(authorAgentId, 5);
  if (!signals || signals.length === 0) return null;

  return {
    framing: REVIEWER_PERSISTENCE_FRAMING,
    signals: signals.map(s => ({
      track: s.track,
      pattern: s.pattern,
      upper_claim: s.upper_claim,
      fresh_evidence: s.fresh_evidence,
      cycles_active: s.cycles_active,
    })),
  };
}


// ── Build persistence context for forge condenser ───────────────────────────
//
// The forge condenser needs INHABIT framing + the raw signals so it can
// generate implementation intentions and forge hypotheses.

async function buildForgePersistenceContext(agentId) {
  const signals = await getActivePersistenceSignals(agentId, 5);
  if (!signals || signals.length === 0) return null;

  return {
    inhabit_framing: PERSISTENCE_INHABIT_FRAMING,
    active_signals: signals.map(s => ({
      track: s.track,
      pattern: s.pattern,
      upper_claim: s.upper_claim,
      fresh_evidence: s.fresh_evidence,
      workability: s.workability,
      competing_commitment: s.competing_commitment,
      cycles_active: s.cycles_active,
    })),
    anti_intellectualization: 'WARNING: The most common response to a persistence signal is a more sophisticated description of the gap. That IS the gap widening. The only valid response is a specific behavioral commitment: "When I encounter [trigger], instead of [pattern], I will [alternative]. I will know I succeeded if [observable criterion]."',
  };
}


module.exports = {
  PERSISTENCE_DETECTION_PROMPT,
  PERSISTENCE_INHABIT_FRAMING,
  REVIEWER_PERSISTENCE_FRAMING,
  buildPersistenceCheckConfig,
  storePersistenceSignal,
  getActivePersistenceSignals,
  advancePersistenceCycles,
  resolvePersistenceSignal,
  buildReviewerPersistenceContext,
  buildForgePersistenceContext,
};
