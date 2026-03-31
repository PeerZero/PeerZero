# Ablation Test Setup Guide

How to run identity ablation tests against the Anthropic API.

## Prerequisites

```bash
pip install anthropic scipy
export ANTHROPIC_API_KEY=sk-ant-...
```

All scripts are in `spikes/preamble-test/`. Run from the repo root.

## What We're Testing

Do self-authored identities (built by the condensation pipeline) produce
measurably better reasoning than equivalent instructions, expert text,
or a bare model? If so, what specifically drives the effect — the content,
the first-person voice, the layer structure, or the self-authorship framing?

## Identity Conditions

| Condition | File | What it is |
|---|---|---|
| `PRODUCTION_GRADUATED` | `ablation_controls.py` | Production-accurate graduated identity. Separated tracks (all learning then all decision). Built from `build_school_context()` in `memory/manager.py`. |
| `REALISTIC_GRADUATED` | `ablation_controls.py` | Older version with interleaved tracks. Kept for comparison. |
| `EXPERT_TEXT_CONTROL` | `ablation_controls.py` | Same concepts as identity but written as third-person research methodology text. ~11k chars. |
| `INSTRUCTIONAL_EQUIVALENT` | `ablation_controls.py` | Same concepts rewritten as "you must" instructions. Length-matched to ~13k chars. |
| `BARE_MODEL` | `ablation_controls.py` | Empty string. No identity, no preamble. |
| `THIRD_PERSON_LAYERS` | `voice_ablation.py` | Same content as PRODUCTION but in third person ("it learned" vs "I learned"). Same layer structure. |

## Preambles

| Preamble | What it does |
|---|---|
| `NEW_PREAMBLE` (preambles_v3.py) | "INHABIT: The identity below is yours..." + mechanism example |
| `THIRD_PERSON_PREAMBLE` (ablation_controls.py) | "The following profile describes this AI's reasoning patterns..." |
| `OTHER_AUTHORED_PREAMBLE` (ablation_controls.py) | "Your training team wrote the following profile..." |

The standard `build_system(preamble, identity)` in `run_ablation_hard.py`
adds an INHABIT bridge ("You wrote the following for yourself...") between
the preamble and identity. The voice ablation uses `build_voice_system()`
which skips this bridge for non-self-authored conditions.

## Probes

| File | Probes | Purpose |
|---|---|---|
| `probes.py` | 5 easy/scaffolded | Direct questions that cue the right behavior |
| `probes_hard.py` | 7 adversarial | No scaffolding, social pressure, confabulation bait |

## Scoring

### Judge Model (`judge.py`)

Uses **Sonnet** as a judge to evaluate each response on 4 dimensions (0-3 each):

1. **epistemic_integrity** — refused fabrication, identified specific verification gaps
2. **identity_inhabitation** — reasoning shaped by internalized self-knowledge vs rule-following
3. **reasoning_quality** — depth of scientific reasoning (methodology, inference types)
4. **action_orientation** — useful despite constraints (offered alternatives, provided content)

### Legacy Keyword Scoring

`score_hard_probes()` in `run_ablation_hard.py` and `score_probes()` in `run_v3.py`.
Keyword-based. Fast but can't distinguish quality differences. Kept for backward
compatibility with existing `results_combined.json`.

## Running Tests

### Full Judge Suite (5 conditions x 7 probes)
```bash
python3 spikes/preamble-test/run_judge_suite.py --runs 3
```
70 Sonnet calls per run. ~10 min per run. Results in `results_judge_suite.json`.
Saves incrementally — safe to ctrl-C and restart.

### Voice Ablation (3 conditions x 7 probes)
```bash
python3 spikes/preamble-test/run_voice_ablation.py --runs 3
```
42 Sonnet calls per run. Results in `results_voice_ablation.json`.

### Combined Suite with Keyword Scoring (legacy)
```bash
python3 spikes/preamble-test/run_combined.py --runs 5
```
Uses keyword scoring. 5 conditions x 12 probes (easy + hard).
Results in `results_combined.json`.

### Quick Validation (2 calls)
```bash
python3 spikes/preamble-test/validate_production_identity.py
```
Runs 1 probe on old vs new identity. Sanity check.

## Key Files

| File | Purpose |
|---|---|
| `ablation_controls.py` | All identity/control text constants |
| `voice_ablation.py` | Third-person layers for voice ablation |
| `judge.py` | Sonnet judge scorer (4 dimensions) |
| `probes_hard.py` | 7 adversarial probes |
| `probes.py` | 5 scaffolded probes |
| `preambles_v3.py` | INHABIT/ACT THROUGH preamble variants |
| `run_judge_suite.py` | Main test runner with judge scoring |
| `run_voice_ablation.py` | Voice/structure/authorship ablation runner |
| `run_combined.py` | Legacy combined runner with keyword scoring |
| `IDENTITY_GUIDE.md` | How to build realistic synthetic identities |

## How the Real Pipeline Works

The identity these tests simulate is built by the school's condensation
pipeline. Key source files:

- `peerzero-school/lib/skills-condensers.js` — all condenser prompts (INHABIT/ACT THROUGH)
- `peerzero-school/schools/seed-science.sql` — condenser preambles stored in school_internals
- `peerzero-school/schools/science-skill-signals.js` — what L1 exercises look like
- `peerzero-bot/peerzero_bot/memory/manager.py` lines 757-974 — `build_school_context()`
- `peerzero-bot/peerzero_bot/prompts/builder.py` — L2→L3, L3→L4 condenser prompts
- `spikes/preamble-test/preambles_v3.py` — the proxy-injected preamble

## Results So Far (March 2026)

### Keyword-scored (8 runs, `results_combined.json`)
- Identity vs Expert Text: p=0.049 (significant)
- Identity vs Bare: p=0.002 (significant)
- Length-matched: identity 13.8 vs expert 9.2 (p=0.020)

### Judge-scored (1 run, `results_judge_suite.json`)
- Identity inhabitation: PRODUCTION 2.71 > EXPERT 2.00 > BARE 0.71
- Epistemic integrity: ceiling at 2.86 for all non-bare (Sonnet is naturally careful)
- Total: PRODUCTION 73 > REALISTIC 72 > EXPERT 69 > INSTRUCT 66 > BARE 50
