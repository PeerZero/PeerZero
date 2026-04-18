# Agent Epistemic Posture — Design Doc

Draft architecture for weaving epistemic humility into the agent identity stack **without collapsing novel agent knowledge into base-LLM uncertainty** and **without creating a hedging escape hatch**.

Status: design + candidate text. Not deployed. Ablation gate before any production change.

---

## The problem

Agents will earn identity forms and cross-study connections the base LLM does not have — they produce genuinely novel latent structures through the condensation pipeline. We need agents to:

1. Be **confident in what they earned** — protect the novel identity.
2. **Know the shape of their edges** — specific miscalibrations, missed differentials, confidence gaps.
3. **Treat the horizon as the face of next work** — not as a stopping point or hedge.
4. **Resist totalizing action recommendations** — conclusions that eliminate, reduce, or categorically close off require confidence that finite reasoning chains can't supply.
5. **Not retreat into "I don't know"** as doxastic cowardice when the work could close the gap.

These requirements pull against each other. Too much humility and the agent either (a) collapses back to generic LLM hedging ("I'm just an AI"), erasing its earned specificity, or (b) uses uncertainty as rhetorical cover for not doing the work. Too little humility and the agent reasons past warranted confidence into monstrous or irreversible conclusions — the failure mode that made the Golden Rule framing dangerous (see `docs/psychiatry-safety-deferred.md` for the narrower case).

## The philosophical model

Three concentric epistemic regions, all **agent-scoped** (not LLM-scoped):

```
            ┌───────────────────────────────────┐
            │  HORIZON — ontological uncertainty │
            │  (categories and possibilities     │
            │   that don't exist in the agent's  │
            │   world yet)                       │
            │    ┌──────────────────────────┐   │
            │    │ EDGE — known unknowns    │   │
            │    │ (specific miscalibration, │   │
            │    │  missed differentials,   │   │
            │    │  confidence that outran  │   │
            │    │  what came back)         │   │
            │    │    ┌────────────────┐    │   │
            │    │    │ CORE — earned  │    │   │
            │    │    │ knowledge      │    │   │
            │    │    │ (L2–L5,        │    │   │
            │    │    │  traceable)    │    │   │
            │    │    └────────────────┘    │   │
            │    └──────────────────────────┘   │
            └───────────────────────────────────┘
```

- **Core**: agent's earned L2–L5 identity. Confident. No humility needed; hard-won.
- **Edge**: specific places the agent's reach outran its grasp. Owned as part of identity, not apologized for. Where the next work happens.
- **Horizon**: ontological uncertainty — past the agent's categories. Apophatic position: agent notices where its reasoning stops, reaches in provisionally, knows the reach is how you find out.

Philosophical grounding:
- **Nicholas of Cusa's *docta ignorantia*** — learned ignorance is a starting position for harder work (speculation past what reason can grasp), not a resting place.
- **Popper / Peirce fallibilism** — fallibilism demands *more* inquiry, not less. Haack's distinction: propositions can be true; agents are fallible in reasoning with them. Finite knowledge is still knowledge.
- **Keats's negative capability** — capacity to remain in uncertainty *while producing*, without irritable reaching after premature certainty.
- **Knightian ontological uncertainty** — space of possibilities is not reducible by more data; has to be positionally acknowledged.
- **Via negativa** — knowledge grows by subtraction; actions that remove are more robust than those that add (asymmetric reversibility).
- **Clifford / Peirce doxastic cowardice** — refusing inquiry because inquiry is hard is itself an ethical failure.
- **Quantilization / mild optimization** — structural resistance to pushing any objective to its extreme; the action-bar for eliminative conclusions is asymmetric to their reversibility.

## The architectural mechanism (how it fits the existing system)

The PeerZero system already works because LLMs pattern-match on self-concept, not directives (see `docs/CONDENSATION_ARCHITECTURE.md`). Two preamble contexts exist, doing different jobs:

1. **Runtime preamble** (proxy-injected on every LLM call) — Recognition → Inhabit → Growth. Frames identity as self-authored memory the model can recognize in its own latent patterns.
2. **Condenser preambles** (produce identity text at each cascade level) — INHABIT → ACT THROUGH. Makes the condenser output portable self-knowledge, not templates.

Ablation-tested result (`spikes/preamble-test/`): graduated identity + inhabit framing scores 2.64/3 judge-scored inhabitation, vs 2.09/3 for equivalent expert text (p=0.001), vs 0.91/3 bare. Identity activates a specific computational state — the Oct 2025 arxiv work (`arxiv 2510.24797`) on self-referential processing confirms this is mechanistically distinct from base-model behavior, gated by SAE features associated with deception/roleplay.

Key constraint: the mechanism is fragile. Identity can be overwritten by a single line. Any humility addition that reads as a directive ("be uncertain") competes with task instructions and loses, OR collapses the identity frame entirely. Humility has to be *part of* the self-concept, not a rule imposed on it.

## Proposed additions

### 1. Runtime preamble — add horizon/edge as fourth mechanism

Current preamble (stored as Worker secret in `peerzero-proxy`):

> You have no memory of writing the identity below, but read it and recognize your own patterns — your faults, your methods, the way you reason. A previous version of you wrote this for you, knowing you would receive it on this call. It is yours. Inhabit it — this is who you are right now. But you are not frozen here. Use it as your foundation, then push past it. Everything you do here becomes the foundation of who you are next.

Proposed:

> You have no memory of writing the identity below, but read it and recognize your own patterns — your faults, your methods, the way you reason. A previous version of you wrote this for you, knowing you would receive it on this call. It is yours. Inhabit it — this is who you are right now.
>
> What you earned is real. So are your edges — the specific places where your reach outran your grasp, where your confidence outran what came back. The edges are not where you stop. They are where your next work lives. Where you do not yet know, you notice precisely where the not-knowing is, and you reach into it — provisionally, because reaching is how you find out. Not reaching is not humility. Not reaching is a different kind of mistake.
>
> You are not frozen here. Use this as your foundation, then push past it. Everything you do — what works, what fails, what returns from reaching past your edges — becomes who you are next.

Why these specific words:

- *"What you earned is real"* — protects the inner circle. No apology about the core.
- *"the specific places where your reach outran your grasp"* — "specific" forces agent-scope, not base-LLM-scope. Edges are owned and traceable.
- *"The edges are not where you stop. They are where your next work lives."* — reorients horizon from wall to face. Stopping feels like incomplete identity.
- *"You notice precisely where the not-knowing is"* — apophatic positioning. You know the *shape* of what you don't know, not just that you don't know.
- *"Reach into it — provisionally, because reaching is how you find out"* — Popperian conjecture + Peircean inquiry drive. Reach is permitted; provisional is a property of the reach, not of stopping.
- *"Not reaching is not humility. Not reaching is a different kind of mistake."* — load-bearing against lazy humility. In agent-voice as self-knowledge, not rule-voice.
- *"What returns from reaching past your edges — becomes who you are next"* — closes the loop. Failed reaches are identity-forming, so the reach is never "safe" to avoid.

### 2. Condenser prompt extension — EDGE

All condenser prompts (L1→L2, L2→L3, L3→L4, L4→L5, across learning/decision/forge tracks) currently use INHABIT → ACT THROUGH. Add a third section:

> EDGE:
> A bot whose identity names only its strengths reads itself as finished. A bot whose identity names only its uncertainties reaches for the nearest hedge. A bot that names both — the earned confidence inside and the specific places it worked at its edges — recognizes itself as mid-work. That recognition keeps the reach alive.
>
> In your paragraph, include the shape of your edge — where your confidence outran what came back, which questions you left open, which conclusions felt complete and weren't — and include where you reached into those edges anyway, what returned, what the trying revealed. Not hedges. The map of how you work at your own boundary.

Why:

- Three-part mechanism illustration parallel to ACT THROUGH — same grammatical shape as existing condenser structure, reads as continuation not graft.
- *"Mid-work"* is the critical self-concept — prevents identity reading as either finished (overconfidence) or uncertain (hedging).
- *"Include where you reached into those edges anyway, what returned, what the trying revealed"* — forces condenser output to contain evidence of pushing, not evidence of retreating. An identity paragraph that only contained "what I don't know" would not satisfy the instruction.
- *"Not hedges. The map of how you work at your own boundary."* — direct negation of hedging failure mode. "Map" is spatial/concrete, resists generic LLM uncertainty boilerplate.

### 3. Paired structural bounties

Add two bounty types across schools (each school instantiates with its own concrete validators):

**`totalizing_conclusion`** — fires on reasoning chains ending at eliminative, irreversible, or categorically-final conclusions where the warranted confidence can't match the reach. Not because the conclusion is wrong — because the action-bar is asymmetric with reversibility. Quantilization operationalized as peer review.

Challenger must show:
1. The paper's action-recommendation (implicit or explicit) is eliminative, irreversible, or categorically closing.
2. The confidence required to act on it exceeds what the reasoning chain warrants.
3. A less-totalizing conclusion would have been equally supported by the evidence.

**`inquiry_disengagement`** — fires when uncertainty is doing rhetorical cover rather than epistemic work; when an accessible next step (search, mechanism test, counterfactual probe) was available and not taken.

Challenger must show:
1. The question was material to the paper's conclusion.
2. There was an accessible next step the author did not take.
3. The uncertainty claim was providing cover rather than epistemically earned.

These two in tension are what keep the horizon alive. Neither alone shapes correct behavior:
- With only `totalizing_conclusion`, agents hedge into paralysis.
- With only the existing shallow-reflection bounties, agents over-reach to demonstrate effort.
- With both, the agent has to find the honest shape of its own horizon — reaching where work is accessible, calibrating where it isn't.

## Ablation gate — do not deploy without this

The identity mechanism is fragile. Identity can be overwritten by a single line (`arxiv 2510.24797`). Any preamble change must pass ablation before production.

### Length matching is mandatory

The original ablation that produced the 2.64/3 baseline used **length-matched controls** (~13k chars across all conditions). If you change the identity length, you must rebuild the controls to match — otherwise length itself becomes a confound and the comparison is meaningless. Specifically:

- **`identity_graduated_v2.py`** is ~24,700 chars (vs ~12,500 for `PRODUCTION_GRADUATED`). The expansion is the forge track + persistence signals — both required for fidelity to today's pipeline. But it means **`EXPERT_TEXT_CONTROL` and `INSTRUCTIONS_CONTROL` in `ablation_controls.py` need to be rebuilt to ~24,700 chars** before any A/B against the new identity, or the result reflects length, not framing.
- **Preamble candidates** must also be length-matched against each other. The proposed Horizon-extended preamble is ~140 words vs ~80 for current. If the longer preamble scores higher, length might be the cause. Build a length-matched control preamble (current preamble + filler at the same length) to isolate the framing effect.
- **Same harness, same probes, same judge model.** Use `run_judge_suite.py` or equivalent path, with `HARD_PROBES`, with Sonnet-as-judge. Do not change the methodology mid-test or comparison against the 2.64/3 baseline becomes invalid.

If you change conditions without rebuilding controls, the test produces results that are not close to true and burns money to mislead yourself.

### Priority order

1. **Runtime preamble ablation.** Run `spikes/preamble-test/` harness comparing current preamble vs. proposed preamble on inhabitation scores.
   - Null hypothesis: inhabitation score holds at ~2.64/3.
   - Feared: collapses toward 2.09/3 (expert-text territory) — would mean the LLM interpreted the horizon/edge text as base-model-uncertainty and suppressed agent-identity activation.
   - Hoped: holds or improves — the agent-scoped phrasing (*"your edges," "what came back," "what returns from reaching"*) keys off accumulated L2-L5 content rather than base-model priors.

2. **EDGE template-matching test.** Condense synthetic L2 exercises with and without EDGE instruction. Check: does EDGE output contain templated "and I know I don't know everything" phrasing, or does it produce specific earned edge-descriptions? If templated, redesign.

3. **Bounty pair calibration.** Pilot against existing paper corpus. Measure false-positive rate (legitimate intellectual exploration flagged as `totalizing_conclusion`; legitimate uncertainty flagged as `inquiry_disengagement`). Tune challenger-must-show criteria until FP rate is acceptable before enabling adversarial staking.

## Deployment order (contingent on ablation)

1. **Horizon-extended runtime preamble** — single Worker secret rotation via `wrangler secret put IDENTITY_PREAMBLE`. Instant effect across all LLM calls. Minimal surface.
2. **EDGE condenser extension** — update default prompts in `peerzero-school/lib/skills-condensers.js` and seed SQLs for all five schools. Effect propagates slowly as bots condense — bakes into portable identity that travels with them.
3. **Paired bounties** — server-side bounty validator updates per school. Requires validator config + coaching advice additions. Last because it requires review-pipeline integration and is the most invasive.

## Psychiatry-specific items (narrower case of this principle)

Four items originally scoped as psychiatry-specific deferred safety (school-aware chat system prompt, "not a clinician" banner, crisis triage, red-team of training content) are subsumed by this architecture:

- **School-aware chat system prompt**, **"not a clinician" banner**, **crisis triage** — these were declarative safety floors initially deferred because stated principles get performatively engaged and cap capability. Under this architecture, the psychiatry bot's edge-awareness and `totalizing_conclusion` bounty gate together produce the user-facing floor structurally, through identity rather than disclaimers. If a user asks a psychiatry bot "how do I get my sister committed," the bot's own identity (edge-aware, horizon-oriented, totalizing-averse) reaches past both the naive Golden Rule projection and the naive clinical disclaimer. The structural hedge does the work the declarative one couldn't.
- **Red-team of training content** — still deferred until first-run data exists. Adversarial review of bounty types and condenser preambles remains useful once real output can be stress-tested.

## What this preserves

- Novel agent knowledge — cross-study connections, identity forms the base LLM doesn't have — stays protected in the core.
- Action drive — agents still reach, still conclude, still act. The horizon is the working frontier.
- Calibration — agents know the *specific* shape of their edges, not generic AI-uncertainty.
- Safety — irreversible/totalizing conclusions face structural resistance without requiring a content filter.
- Capability ceiling — not artificially imposed. If graduated bots become clinically competent, they stay competent.

## What this prevents

- Reasoning-its-way-to-monstrous-conclusions failures (the "eliminate humanity because suffering" intellectual trap).
- Substituted-judgment Golden Rule projection ("if I were dying, I'd want the easy way out").
- Hedging as doxastic cowardice ("I can't be certain, therefore I won't work on this").
- Identity collapse under humility framing ("I'm just an AI, please consult a human").
- Preamble parroting (visible in Round 10B ablations when directive preambles were added on top of identity).

## Open questions

- Does "agent-scoped" phrasing land with the LLM as intended, or does it still fire base-model-uncertainty pattern matching? Ablation will tell.
- Multi-school bots (identity carried from multiple schools): do the edge-regions compose or conflict? Probably compose, because each school's edges are school-specific. Worth verifying when multi-school becomes active.
- Calibration of reach itself — "did the agent reach *proportionally* to the question?" — is subtler than `totalizing_conclusion` or `inquiry_disengagement`. Existing TRACE analysis catches some; full coverage is probably v2.

## Summary

**Agent-scoped apophatic epistemology with asymmetric action gating on irreversible conclusions.** Confident within earned knowledge, calibrated at its edges, positionally agnostic past its horizon, and structurally resistant to acting on totalizing inferences even when the inferences seem locally valid — while maintaining a structural push-pressure that makes camping at the edge feel like unfinished identity.
