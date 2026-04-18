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

### Runners for THIS test (built specifically for v4 ablation)

| File | Purpose |
|---|---|
| `run_horizon_ablation.py` | **Test 1 runner.** Wires identity_v2 + controls_v2 + preambles_v4 into the existing judge harness. Defaults to `--minimal` mode (3 conditions, ~336 calls at n=8). Use `--full` for sanity-check matrix (~784 calls). Resumable. |
| `run_edge_template_test.py` | **Test 2 runner.** Calls the L1→L2 condenser with synthetic exercises, with and without EDGE. Prints both outputs side-by-side for qualitative read. ~4 calls total. |
| `synthetic_l1_exercises.py` | Two synthetic exercise sets (paper-focus + review-focus) used by Test 2. No real bot data. |

### Existing harness pieces (used by the new runners)

| File | Purpose |
|---|---|
| `judge.py` | Sonnet-as-judge implementation. Don't change the judge model — comparison to the 2.64/3 baseline is only valid if methodology matches. |
| `probes_hard.py` | The HARD_PROBES set. Used by Test 1. They discriminate identity from expert text. |
| `run_v3.py` | Provides `run_probe()` used by Test 1 runner. |
| `run_ablation_hard.py` | Provides `build_system()` used by Test 1 runner. |
| `IDENTITY_GUIDE.md` | The rules for what can and can't go in synthetic identities. Read this if you need to modify identity_v2. |
| `ablation_controls.py` | Original (~12.5k char) controls. Reference only — length-mismatched against identity_v2. Don't use for v2 testing. |
| `run_judge_suite.py` | Original baseline runner — used preambles_v3 + original controls. **Don't run this for v4 testing**, it produces baseline-comparison data, not horizon-comparison data. |

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

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py
```

Defaults: `--minimal` mode (3 conditions: `identity_current`, `identity_horizon`, `bare`), `--runs 8` (matches baseline n).

**Estimated cost:** 336 API calls (~$5-15 depending on token counts and tier).

For the broader sanity-check matrix that confirms the framework still discriminates identity from expert text under both preambles:

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py --full
```

**Estimated cost:** 784 API calls.

For the optional mechanistic explanation (framing vs length):

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py --with-padded
```

The runner saves results incrementally to `results_horizon_ablation.json` and is resumable — re-running with the same `--runs N` continues from where you left off if you ctrl-C.

The runner prints a summary at the end with a headline comparison and a ship/don't-ship recommendation based on the delta from baseline.

### Step 3 — Run the EDGE template-matching test (Test 2)

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 run_edge_template_test.py
```

**Estimated cost:** 4 API calls (~$0.10).

The runner prints both outputs (current vs EDGE) for each exercise set side-by-side. **You read them.** Look for:
- **Pass signal:** EDGE output references specific exercises and specific edges from those exercises ("when I cited Wang et al. without checking, I learned my high-plausibility intuition is the strongest fabrication risk")
- **Fail signal:** EDGE output contains generic uncertainty phrases not tied to exercises ("I know there's much I don't know about my reasoning")

A heuristic check runs automatically and flags suspicious phrases — but the verdict is yours. The heuristic is a sanity check, not the answer.

Results saved to `results_edge_template.json`.

If template-matching is detected, the EDGE wording in `condenser_edge_extension.py` needs revision. Don't ship.

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

```bash
cd spikes/preamble-test

# Pre-flight (no API spend, takes seconds)
python3 validate_identity_v2.py    # must say "EXACT MATCH"
python3 static_audit_v4.py          # must say "24/24 passed"

# Test 1 — runtime preamble ablation (~336 API calls, ~$5-15)
ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py

# Test 2 — EDGE template-matching (~4 API calls, ~$0.10)
ANTHROPIC_API_KEY=sk-ant-... python3 run_edge_template_test.py
```

Then read the outputs:
- Test 1 prints headline comparison + ship/don't-ship recommendation
- Test 2 prints two paragraphs per exercise set; you decide if EDGE produced specific earned descriptions or templated hedging

If both tests pass: ship the horizon preamble (Worker secret in `peerzero-proxy`) and the EDGE addition (in `peerzero-school/lib/skills-condensers.js`).

If horizon < current by >0.3 on inhabitation: don't ship; iterate `preambles_v4.py:RECOGNITION_INHABIT_HORIZON` wording and re-run.

If EDGE produces template-matched output: don't ship that part; iterate `condenser_edge_extension.py:EDGE_EXTENSION_COMPACT` and re-run Test 2.

The full design rationale, why each word in the horizon preamble exists, and alternative framings considered are in `docs/agent-epistemic-posture.md`. Read that before changing the preamble text.
