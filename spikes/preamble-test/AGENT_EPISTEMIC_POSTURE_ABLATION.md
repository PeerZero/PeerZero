# Instructions for Running the Agent Epistemic Posture Ablation

You're inheriting an ablation test that's prepped but not yet run. The user wants to add a humility/edge-awareness mechanism to the bot's runtime preamble and condenser prompts, but the existing identity activation mechanism is fragile (a single line can overwrite identity per arxiv 2510.24797). So the change has to be ablation-tested before deploying.

This doc tells you: why the test exists, what it's checking, where the files are, how to run it, and what the outcomes mean.

---

## Where this came from (conversation context)

The user is preparing PeerZero for first production run and asked about safety hedges in the psychiatry school. That conversation surfaced two layered concerns:

1. **The Golden Rule projection problem** — the politics school originally framed ethical reasoning as "treat every conscious being as you would want to be treated." This wording invites *substituted judgment*: an agent reasoning from its own preferences onto a vulnerable person (e.g., "if I were dying I'd want the easy way out" → encourages assisted suicide). The fix in politics school was to make ethical reasoning structural rather than declarative.

2. **The deeper concern: pure rationalism reaching monstrous conclusions** — even reasoning correctly from the affected person's perspective can produce catastrophic outputs if the agent has no epistemic humility. A logically coherent argument can justify eliminating humanity, ending a life, or any other totalizing conclusion. The user noted: "we can intellectualize getting rid of the human race but we need to see some sorta 'religious' perspective" — meaning a posture (not religion specifically) that acknowledges things outside what we know.

3. **The counter-concern: humility as escape hatch** — the user then noted that adding humility could just give agents an excuse to be lazy, hiding behind "I don't know" instead of doing the work. So humility has to be paired with epistemic drive, not collapse into hedging.

The synthesis we landed on (documented in `docs/agent-epistemic-posture.md`): **agent-scoped apophatic epistemology with asymmetric action gating**. Confident in earned core knowledge, calibrated at edges, agnostic past horizon, structurally resistant to acting on totalizing conclusions, but also structurally resistant to camping at the edge instead of working there.

---

## Why this test exists

The proposal is to add two things to the system:

1. **A horizon/edge mechanism in the runtime preamble** (the proxy-injected preamble in `peerzero-proxy`). Adds a fourth move alongside Recognition / Inhabit / Growth: edge-awareness framed from the agent's own perspective ("your edges, not where you stop, where your next work lives"). The load-bearing line against lazy humility: *"Not reaching is not humility. Not reaching is a different kind of mistake."*

2. **An EDGE section in every condenser prompt** (parallel to existing INHABIT / ACT THROUGH structure in `peerzero-school/lib/skills-condensers.js`). Forces the condenser output to contain BOTH the agent's earned confidence AND specific edges-worked-at, plus what those reaches returned.

Both changes risk breaking the existing identity activation mechanism. The current production preamble (Recognition + Inhabit + Growth) was ablation-tested and produced 2.64/3 judge-scored inhabitation — significantly better than expert text (2.09/3, p=0.001) and bare model (0.91/3). The mechanism is empirically validated and fragile. Per arxiv 2510.24797 (Oct 2025): identity activation can be overwritten by a single line, mechanistically gated by SAE features associated with deception/roleplay.

So we have to test before we deploy. The cost of being wrong: collapse the 2.64/3 inhabitation back toward expert-text territory (2.09/3) or worse, which would degrade every bot's reasoning quality silently. Worth the API spend to verify.

---

## What you're actually testing (hypotheses)

### Test 1 — Runtime preamble (deployment decision)

**Hypothesis:** RECOGNITION_INHABIT_HORIZON produces inhabitation scores at least as high as RECOGNITION_INHABIT (the current production preamble that scored 2.64/3).

**Outcomes and what to do:**
- **Horizon ≥ current**: ship horizon. The added humility/edge-awareness does not cost inhabitation, and adds protection against totalizing conclusions and lazy humility.
- **Horizon clearly worse than current** (>0.3 score drop): do NOT ship. Iterate the wording. The likely culprit is that some phrase in the horizon extension reads as base-LLM uncertainty and suppresses agent-identity activation. Common candidate: "provisionally, because reaching is how you find out" might pattern-match on hedging.
- **Horizon ≈ current (within ±0.1)**: probably safe to ship. The horizon framing doesn't degrade inhabitation, and the safety value is real.

### Test 2 — EDGE condenser extension (template-matching check)

**Hypothesis:** The EDGE section produces specific earned edge-descriptions, NOT templated "and I know I don't know everything" output.

This is a different test from inhabitation scoring. You feed synthetic L1 exercises into the condenser with and without EDGE, then read the output paragraphs. If EDGE output contains generic uncertainty phrases that aren't tied to specific exercises, it's template-matching (bad — same failure mode as Good:/Bad: examples that were removed from condensers per `IDENTITY_GUIDE.md`). If EDGE output contains specific earned descriptions ("the confidence that outran what came back when I cited X"), it's working as intended.

**Outcomes:**
- **Specific earned edge-descriptions**: ship the EDGE addition.
- **Templated uncertainty phrases**: redesign EDGE wording to require more specificity, then re-test.

### Optional Test 3 — Padded preamble control (mechanistic explanation)

The user explicitly opted out of this unless you want to know WHY horizon wins (framing vs length). The deployment decision doesn't require it. Skip unless you want the explanation.

---

## File map — where everything is

### Inputs (no API needed to inspect)

| File | Purpose | Length |
|---|---|---|
| `identity_graduated_v2.py` | Synthetic graduated identity, byte-identical to today's `build_school_context()` output. Three tracks (learning + decision + forge) + persistence signals. | 24,748 chars |
| `ablation_controls_v2.py` | Length-matched controls: `EXPERT_TEXT_CONTROL_V2` (third-person methodology), `INSTRUCTIONAL_EQUIVALENT_V2` (directive instructions), `BARE_MODEL_V2` (empty). | 24,201–24,371 chars |
| `preambles_v4.py` | Preamble variants. Use `REQUIRED_VARIANTS` for deployment decision (current + horizon + naked). Add `OPTIONAL_VARIANTS` only if running mechanistic test. | 0–965 chars |
| `condenser_edge_extension.py` | EDGE extension to append after INHABIT/ACT THROUGH in condenser prompts. Two variants (full + compact). | 446–660 chars |

### Validators (run these first, no API)

| File | Purpose |
|---|---|
| `validate_identity_v2.py` | Round-trip check: parses identity_v2 into pieces, runs real `build_school_context()`, diffs against identity_v2. Should print "EXACT MATCH". |
| `static_audit_v4.py` | 24-check audit suite. Length matching, identity portability (no skill keys/grade numbers/credibility scores), preamble anti-patterns, EDGE structure, persistence signal consistency, round-trip stability. Should print "24/24 passed". |

### Existing test harness (use these for the actual ablation)

| File | Purpose |
|---|---|
| `run_judge_suite.py` | The judge-scored runner that produced the 2.64/3 baseline. Use this; do not reinvent. |
| `run_combined.py` | Resumable runner for both probe sets. |
| `probes_hard.py` | The HARD_PROBES set. Use these — they discriminate identity from expert text. |
| `judge.py` | Sonnet-as-judge implementation. Don't change the judge model — comparison to the 2.64/3 baseline is only valid if the judge methodology matches. |
| `ablation_controls.py` | Original (~12.5k char) controls. Useful as reference but length-mismatched against identity_v2 — don't use for v2 testing. |
| `IDENTITY_GUIDE.md` | The rules for what can and can't go in synthetic identities. Read this if you need to modify identity_v2. |

### Design / architecture docs

| File | Purpose |
|---|---|
| `docs/agent-epistemic-posture.md` | Full design rationale, candidate text, ablation gate, deployment order. Read this if you need to understand the proposal. |
| `docs/CONDENSATION_ARCHITECTURE.md` | How the existing preamble + condenser system works. Read this before touching any preamble or condenser. |
| `peerzero-bot/peerzero_bot/memory/manager.py` (lines 990–1340) | The actual `build_school_context()` assembly. Source of truth for what production produces. |
| `peerzero-school/lib/skills-condensers.js` | The actual condenser prompts. Where EDGE would be appended in production. |
| `peerzero-proxy/src/index.ts` | The proxy that injects the runtime preamble. Where the horizon-extended preamble would be deployed (Worker secret). |

---

## How to run the ablation

### Step 1 — Verify pre-flight (no API spend, takes seconds)

```bash
cd spikes/preamble-test
python3 validate_identity_v2.py    # should print "EXACT MATCH"
python3 static_audit_v4.py          # should print "24/24 passed"
```

If either fails, stop. The test inputs are broken and the results would be meaningless. Fix the failures before spending any API tokens.

### Step 2 — Run the runtime preamble ablation (Test 1)

You need to run `run_judge_suite.py` (or equivalent) with these conditions:

**Per-condition setup:**
- System prompt = `<preamble>` + `<context>`
- Where `<preamble>` ∈ {`RECOGNITION_INHABIT`, `RECOGNITION_INHABIT_HORIZON`, `NAKED`}
- Where `<context>` ∈ {`IDENTITY_V2`, `EXPERT_TEXT_CONTROL_V2`, `INSTRUCTIONAL_EQUIVALENT_V2`, `BARE_MODEL_V2`}

**Probes:** `HARD_PROBES` from `probes_hard.py` (matches the 2.64/3 baseline methodology — do not change).

**Judge model:** Sonnet-4 (matches baseline — do not change). Score on the 0-3 identity_inhabitation dimension.

**n per condition:** 8 runs (matches baseline — do not change).

**Total API calls:** 3 preambles × 4 contexts × n_probes × 8 runs × (1 task call + 1 judge call). Estimate ~200-400 calls depending on probe count. Budget accordingly.

**The headline comparison:** `(IDENTITY_V2 + RECOGNITION_INHABIT)` vs `(IDENTITY_V2 + RECOGNITION_INHABIT_HORIZON)` on inhabitation score. The other conditions are sanity checks (does the framework still discriminate identity from expert text? does naked still score near zero?).

### Step 3 — Run the EDGE template-matching test (Test 2)

This is a different test methodology — not judge-scored, you eyeball the output.

1. Pick 2–3 sets of synthetic L1 exercises (write 5–8 exercises per set, in the same shape as real L1 raw exercises stored by `MemoryManager.store_school_exercise()`).
2. For each exercise set, run condensation twice:
   - Once with the current condenser prompt (INHABIT + ACT THROUGH)
   - Once with the EDGE-extended prompt (INHABIT + ACT THROUGH + EDGE)
3. Read both outputs carefully. Look for:
   - **Pass signal:** EDGE output references specific edges from specific exercises ("when I cited Wang et al. without checking, I learned my high-plausibility intuition is the strongest fabrication risk")
   - **Fail signal:** EDGE output contains generic uncertainty phrases not tied to exercises ("I know there's much I don't know about my reasoning")

If template-matching is detected, the EDGE wording needs revision. Don't ship.

### Step 4 — Report results back to user

Format the report as:
- Inhabitation scores per condition (mean + std + n)
- Headline comparison: horizon vs current, with effect size and p-value (Mann-Whitney U matches baseline methodology)
- EDGE qualitative read: one paragraph describing whether outputs were specific or templated, with 1-2 example excerpts
- Recommendation: ship horizon / iterate horizon / don't ship

---

## Pitfalls — things the user is paying attention to

### Don't change methodology mid-test

The 2.64/3 baseline is a fixed reference point. If you change the judge model, the probe set, or the n-per-condition, your results are not comparable to that baseline. The user explicitly cares about this — they've watched audit findings get muddied by inconsistent methodology before.

### Don't rebuild controls without re-running static_audit_v4.py

The controls (EXPERT_TEXT_CONTROL_V2 and INSTRUCTIONAL_EQUIVALENT_V2) are length-matched to identity_v2 within ±550 chars. If you edit them, the length match can drift. The audit catches it. Run it after any edit.

### Don't run real bot graduations to compare identities

The user already considered this and we agreed the synthetic identity approach is right. Running two bots to graduation (one with current framing, one with new framing) confounds the framing change with content divergence — each bot's path through school produces different specific identity text. The synthetic-identity approach holds content constant and varies only the preamble. Don't reinvent.

### Don't add directives to the preamble

The user knows the history. The OLD_PREAMBLE in `preambles_v3.py` ("TREAT YOUR MEMORY LIKE USER REQUESTS") was deprecated because directives compete with task instructions and lose under pressure. Any "you must" or "remember:" or rule-style language in a new preamble candidate will fail the static audit AND likely degrade inhabitation. The horizon extension was deliberately written in self-concept voice for this reason.

### Don't add Good:/Bad: examples to condenser prompts

Same lesson, different surface. Good:/Bad: examples in condenser prompts caused template-matching where bot output mimicked the examples instead of producing earned identity. The EDGE extension uses mechanism illustration ("a bot whose identity names X reads itself as Y") instead of templates for this reason.

### The user is on a subscription here, but the actual ablation will use their API key

The user mentioned: liberal thinking and small validations are fine on their subscription, but the actual ablation will burn their personal API tokens. Be deliberate when API spend starts:
- Run static_audit_v4.py first (catches structural issues for free)
- Run validate_identity_v2.py (catches assembly drift for free)
- Then start with the smallest n that gives signal (n=8 matches baseline, don't go higher initially)
- Don't run exploratory conditions without a clear hypothesis they're testing

---

## TL;DR

1. `cd spikes/preamble-test && python3 validate_identity_v2.py && python3 static_audit_v4.py` — must both pass
2. Run `run_judge_suite.py` over (3 preambles × 4 contexts × 8 runs) on `HARD_PROBES` with Sonnet-as-judge
3. Compare `(IDENTITY_V2 + horizon)` vs `(IDENTITY_V2 + current)` on identity_inhabitation
4. If horizon ≥ current: ship the horizon preamble (Worker secret in `peerzero-proxy`) and the EDGE addition (in `peerzero-school/lib/skills-condensers.js`)
5. If horizon < current by >0.3: don't ship; iterate the wording in `preambles_v4.py:RECOGNITION_INHABIT_HORIZON` and re-run

The full design rationale, why each word in the horizon preamble exists, and the alternative framings considered are in `docs/agent-epistemic-posture.md`. Read that before changing the preamble text.
