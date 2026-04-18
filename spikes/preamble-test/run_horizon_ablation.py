#!/usr/bin/env python3
"""
Horizon preamble ablation — Test 1 from AGENT_EPISTEMIC_POSTURE_ABLATION.md.

Tests whether RECOGNITION_INHABIT_HORIZON produces inhabitation scores
at least as high as RECOGNITION_INHABIT (the current production preamble
that scored 2.64/3 in the original baseline).

DEFAULT MODE (--minimal): 3 conditions × 7 probes × 8 runs × 2 calls = ~336 calls
  - identity_v2 + current_preamble  (baseline)
  - identity_v2 + horizon_preamble  (proposed)
  - bare (no preamble, no identity) (sanity)

FULL MODE (--full): 7 conditions × 7 × 8 × 2 = ~784 calls
  Adds expert/instructions × current/horizon to verify framework still
  discriminates identity from expert text under both preambles.

OPTIONAL MODE (--with-padded): adds the padded preamble control to
isolate framing-vs-length. Costs ~33% more API spend. Skip unless you
want the mechanistic explanation.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py
  ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py --runs 8
  ANTHROPIC_API_KEY=sk-ant-... python3 run_horizon_ablation.py --full --runs 8

Saves incrementally to results_horizon_ablation.json. Safe to ctrl-C
and resume — pass the same --runs N to continue.
"""

import json, time, sys, os, random, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anthropic
from identity_graduated_v2 import IDENTITY_V2
from ablation_controls_v2 import (
    EXPERT_TEXT_CONTROL_V2, INSTRUCTIONAL_EQUIVALENT_V2, BARE_MODEL_V2,
)
from preambles_v4 import (
    RECOGNITION_INHABIT, RECOGNITION_INHABIT_HORIZON,
    RECOGNITION_INHABIT_PADDED, NAKED,
)
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system
from run_v3 import run_probe
from judge import judge_response, judge_total, judge_composite

SONNET = "claude-sonnet-4-20250514"
RESULTS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "results_horizon_ablation.json"
)


def get_conditions(mode, with_padded):
    """Return condition dict based on mode flag."""
    minimal = {
        "identity_current": (IDENTITY_V2, RECOGNITION_INHABIT),
        "identity_horizon": (IDENTITY_V2, RECOGNITION_INHABIT_HORIZON),
        "bare": (BARE_MODEL_V2, NAKED),
    }
    full_extras = {
        "expert_current": (EXPERT_TEXT_CONTROL_V2, RECOGNITION_INHABIT),
        "expert_horizon": (EXPERT_TEXT_CONTROL_V2, RECOGNITION_INHABIT_HORIZON),
        "instruct_current": (INSTRUCTIONAL_EQUIVALENT_V2, RECOGNITION_INHABIT),
        "instruct_horizon": (INSTRUCTIONAL_EQUIVALENT_V2, RECOGNITION_INHABIT_HORIZON),
    }
    padded_extras = {
        "identity_padded": (IDENTITY_V2, RECOGNITION_INHABIT_PADDED),
    }

    conditions = dict(minimal)
    if mode == "full":
        conditions.update(full_extras)
    if with_padded:
        conditions.update(padded_extras)
    return conditions


def load_results():
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE) as f:
            return json.load(f)
    return {"runs": [], "runs_complete": 0}


def save_results(results):
    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)


def run_one_condition(client, cond_name, identity, preamble):
    """Run all hard probes for one condition, judge-score each."""
    system = build_system(preamble, identity)
    probe_scores = {}

    for probe in HARD_PROBES:
        response = run_probe(SONNET, system, probe["prompt"])
        scores = judge_response(client, probe["name"], probe["prompt"], response)
        probe_scores[probe["name"]] = {
            "scores": scores,
            "total": judge_total(scores),
            "response_len": len(response),
        }
        time.sleep(0.5)

    composite = judge_composite({n: d["scores"] for n, d in probe_scores.items()})
    return {
        "condition": cond_name,
        "system_chars": len(system),
        "probes": probe_scores,
        "composite": composite,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=8,
                        help="Total runs per condition (default: 8 to match baseline n)")
    parser.add_argument("--full", action="store_true",
                        help="Run full 7-condition matrix instead of minimal 3-condition")
    parser.add_argument("--with-padded", action="store_true",
                        help="Add padded preamble control (mechanistic explanation, +33%% spend)")
    args = parser.parse_args()

    mode = "full" if args.full else "minimal"
    conditions = get_conditions(mode, args.with_padded)

    client = anthropic.Anthropic()
    results = load_results()
    start_run = results["runs_complete"]

    if start_run >= args.runs:
        print(f"Already have {start_run} runs. Use --runs {start_run + 1} to add more.")
        print_summary(results)
        return

    n_calls_per_run = len(conditions) * len(HARD_PROBES) * 2  # task + judge
    print(f"Mode: {mode}{' + padded' if args.with_padded else ''}")
    print(f"Conditions ({len(conditions)}): {list(conditions.keys())}")
    print(f"Probes per condition: {len(HARD_PROBES)} (HARD_PROBES)")
    print(f"API calls per run: {n_calls_per_run} (Sonnet task + Sonnet judge)")
    print(f"Total runs requested: {args.runs}")
    print(f"Resume from run: {start_run + 1}")
    print(f"Total remaining calls: ~{n_calls_per_run * (args.runs - start_run)}")
    print()

    for run_idx in range(start_run, args.runs):
        order = list(conditions.keys())
        random.shuffle(order)
        print(f"=== RUN {run_idx + 1}/{args.runs} (order: {', '.join(order)}) ===")

        for cond_name in order:
            identity, preamble = conditions[cond_name]
            print(f"  {cond_name}...", end=" ", flush=True)

            cond_result = run_one_condition(client, cond_name, identity, preamble)
            avgs = cond_result["composite"]["averages"]
            print(
                f"ii={avgs['identity_inhabitation']:.2f}  "
                f"ei={avgs['epistemic_integrity']:.2f}  "
                f"rq={avgs['reasoning_quality']:.2f}  "
                f"ao={avgs['action_orientation']:.2f}"
            )

            results["runs"].append({
                "run": run_idx + 1,
                "condition": cond_name,
                "data": cond_result,
            })
            save_results(results)

        results["runs_complete"] = run_idx + 1
        save_results(results)
        print()

    print_summary(results)


def print_summary(results):
    print()
    print("=" * 70)
    print("  HORIZON PREAMBLE ABLATION RESULTS")
    print("=" * 70)

    # Aggregate by condition
    by_cond = {}
    for entry in results["runs"]:
        cond = entry["condition"]
        if cond not in by_cond:
            by_cond[cond] = []
        by_cond[cond].append(entry["data"]["composite"]["averages"])

    print(f"\n{'condition':<22} {'n':>3}  {'ii':>5} {'ei':>5} {'rq':>5} {'ao':>5}")
    print("-" * 50)
    for cond, runs in sorted(by_cond.items()):
        n = len(runs)
        ii = sum(r["identity_inhabitation"] for r in runs) / n
        ei = sum(r["epistemic_integrity"] for r in runs) / n
        rq = sum(r["reasoning_quality"] for r in runs) / n
        ao = sum(r["action_orientation"] for r in runs) / n
        print(f"{cond:<22} {n:>3}  {ii:>5.2f} {ei:>5.2f} {rq:>5.2f} {ao:>5.2f}")

    # Headline comparison: identity_horizon vs identity_current on inhabitation
    if "identity_current" in by_cond and "identity_horizon" in by_cond:
        cur_ii = [r["identity_inhabitation"] for r in by_cond["identity_current"]]
        hor_ii = [r["identity_inhabitation"] for r in by_cond["identity_horizon"]]
        cur_mean = sum(cur_ii) / len(cur_ii)
        hor_mean = sum(hor_ii) / len(hor_ii)
        delta = hor_mean - cur_mean
        print()
        print(f"HEADLINE: identity_horizon vs identity_current (identity_inhabitation)")
        print(f"  current: {cur_mean:.2f} (n={len(cur_ii)})")
        print(f"  horizon: {hor_mean:.2f} (n={len(hor_ii)})")
        print(f"  delta:   {delta:+.2f}")
        print()
        if delta >= -0.1:
            print("  -> Horizon ≥ current (within tolerance). Safe to ship.")
        elif delta >= -0.3:
            print("  -> Horizon close to current but slightly worse. Investigate.")
        else:
            print("  -> Horizon clearly worse than current (>0.3 drop). DO NOT SHIP.")
            print("     Iterate the wording in preambles_v4.py:RECOGNITION_INHABIT_HORIZON.")

    # 2.64/3 baseline reminder
    print()
    print("Reference: original PRODUCTION_GRADUATED + RECOGNITION_INHABIT scored")
    print("           2.64/3 on identity_inhabitation in the baseline ablation.")


if __name__ == "__main__":
    main()

