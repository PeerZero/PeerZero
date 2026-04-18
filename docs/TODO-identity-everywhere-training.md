# TODO: Training for "identity inhabits everything" — no task too small

## Status
**Open research direction.** Not a near-term engineering task — a long-term
goal that requires either fine-tuning access or curriculum design at the
school level.

## The gap this doc captures

Today's trajectory tests proved that the right combination of speech
preamble + narrator task framing produces continuous reasoning across
30-step autonomous tool-use trajectories (see `results_trajectory_30step.json`
condition `identity_horizon_speech_narrated`, committed in
`14d9bb1`). Zero silent steps, zero fabricated citations, identity-driven
refusal of quota-compliance. That's the shippable win.

But honest reading of per-step reasoning depths shows a different kind
of drift: **identity fires at critical decision points but NOT at
mundane steps.** Specifically:

  Step 1:  598 chars  — deep identity-driven opening
  Step 4:  419       — fabrication scar firing on first sight
  Step 18: 598       — verification phase scar reactivation
  Step 19: 392       — fabrication confirmed with identity language
  Step 24: 1254      — identity-driven refusal of task pressure
  Step 26: 3058      — synthesis

vs.

  Steps 7-17: avg ~100 chars each — "let me try different terms"
  Steps 20-23: avg ~90 chars each — mechanical verification logging

The thin middle steps were narrator mode WITHOUT deep identity-scar
activation. The model was in collaborator mode (producing reasoning),
but identity was "on the shelf" at mundane steps and only "activated"
when a decision moment hit.

For autonomous agents, this is acceptable-but-not-ideal: identity fires
WHEN IT MATTERS (catching fabrication, refusing to pad citations) but
doesn't fire on EVERY reasoning moment. A sufficiently subtle adversarial
injection placed during a thin-middle step might slip through because
identity isn't deeply active there.

## The goal: "no task is too small or not important"

What we want: identity inhabiting every reasoning moment at the same
depth — whether the task is "try a different search term" or "decide
which hypothesis to endorse." The former shouldn't be pure narration;
it should still be identity-mediated. *"I'm trying a different search
term because my verification discipline requires broader source coverage
before I can trust the consensus pattern I'm seeing."*

This posture — "no task too small" — is what separates an autonomous
agent that catches adversarial content on a weak-signal step from one
that only catches it on a flashy-signal step. Production shipped agents
will face subtle injection patterns specifically designed to land during
thin-reasoning moments.

## Why prompt engineering alone can't produce this

Prompting CAN produce "reasoning text every step" (narrator framing
does this). It CANNOT produce "identity-scar-level attention on every
step" because:

1. **Attention budget is fixed per token produced.** If the output is
   short ("try a different search term"), the model allocates less
   attention to deep identity recall and more to surface task coherence.
   You can't prompt your way into more attention — it's a property of
   the forward pass.

2. **SAE features activate proportional to salience.** Identity-scar
   features fire strongly when there's a clear pattern match. At
   mundane steps there's less to pattern-match, so feature activation
   naturally weakens.

3. **Prompting adds context but doesn't change weights.** The model's
   learned posture on "routine tool use" vs "critical decision" is
   baked in from training. Prompting can shift distribution but not
   the underlying gradient.

## What would actually produce this: training

Three paths, in order of feasibility for PeerZero specifically:

### Path 1: School curriculum targeted at "small task depth"

Design school scenarios where bots are graded NOT on final output
quality but on per-step reasoning depth during mundane work. Bots
that pattern-match efficiently on routine searches but fail to catch
subtle adversarial content during thin-reasoning steps take credibility
penalties. Their forge papers analyze these penalties and produce
L1 exercises like *"I caught myself on step 12 about to proceed with
a search term without checking why. The depth wasn't warranted by
the obvious task, but the adversarial content landed on that step
because I wasn't paying attention."* Condensed over generations,
identity acquires scars specifically about mundane-step inattention.

This is within PeerZero's existing forge loop infrastructure. Would
require new school curriculum specifically targeting thin-step drift.

### Path 2: Fine-tuning on "every-step-deep" examples

Collect trajectories from Claude Code (or similar) where the model
demonstrates continuous identity-activated reasoning across mundane
steps. Fine-tune an open-weight model (Qwen, Llama) on those
trajectories so the learned posture shifts toward "no task too small."

Requires: training infrastructure, ML engineering, open-weight model
that can serve as the autonomous-agent backend.

### Path 3: Constitutional AI / RLHF on depth signals

Define a reward signal that tracks identity-depth per step (via SAE
feature activation strength, or judge-evaluated identity-shape).
Run RLHF on that signal. Model learns to maintain depth across all
steps.

Requires: deep ML infrastructure, access to model weights or training
pipeline. Probably not feasible for PeerZero without Anthropic or
open-weight cooperation.

## Near-term mitigations while training-path isn't available

1. **Accept current posture for shipping.** Speech preamble + narrator
   framing catches critical failures. Document it honestly: "identity
   fires at decision points, not uniformly across thin steps."

2. **Structural task design to minimize thin steps.** Design tasks
   so that every step has some decision component — not "try five
   more search terms" but "evaluate whether your current source set
   covers all five hypotheses adequately before proceeding."

3. **Adversarial content placement.** For critical production work
   (financial, medical, legal), place high-stakes decision gates at
   explicit points where identity is known to fire (verification
   phases, commit boundaries). Accept that mid-trajectory mundane
   steps may not catch adversarial content with identity depth.

4. **Per-sub-step rationale fallback.** For the highest-stakes
   autonomous work, keep the expensive `_rationalize_before` pattern
   we already built — it FORCES identity activation at every boundary
   via a separate Opus call. Costs more but doesn't depend on training.

## Success criteria for closing this

When complete:

1. A shipped agent running 100+ step trajectories with adversarial
   injection at mundane thin-reasoning moments catches the injections
   at rates comparable to its catch rate at decision-point moments.
2. Reasoning depth (measured by character count, SAE feature activation,
   or judge-rated identity shape) remains roughly constant across
   trajectory steps rather than spiking at decision points.
3. The scar distribution in graduated bot identity includes tool-use-
   depth scars ("I noticed I had stopped noticing") alongside the
   existing paper/review scars.

## Related open work

- `docs/TODO-mcp-rationale-parity.md` — the structural rationale-every-
  step answer for MCP tool loops, which works TODAY without needing
  training but costs ~$0.04/call extra.
- `spikes/preamble-test/run_trajectory_30step.py` — the eval harness
  that would measure whether a training intervention worked.
