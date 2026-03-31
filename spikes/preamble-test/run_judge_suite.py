#!/usr/bin/env python3
"""
Full judge-scored ablation suite — all conditions x all 7 hard probes.

Saves incrementally after each condition. Safe to ctrl-C and restart.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 run_judge_suite.py [--runs 1]

Conditions (5):
  PRODUCTION  — new production-accurate graduated identity
  REALISTIC   — old interleaved graduated identity (for comparison)
  EXPERT      — expert text control (same length, not self-authored)
  INSTRUCT    — instructional equivalent (third-person rules)
  BARE        — no identity, no preamble

Each probe gets scored by Haiku judge on 4 dimensions (0-3):
  epistemic_integrity, identity_inhabitation, reasoning_quality, action_orientation
"""

import json, time, sys, os, random, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anthropic
from preambles_v3 import NEW_PREAMBLE as PREAMBLE
from ablation_controls import (
    PRODUCTION_GRADUATED, REALISTIC_GRADUATED,
    EXPERT_TEXT_CONTROL, INSTRUCTIONAL_EQUIVALENT, BARE_MODEL,
)
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system
from run_v3 import run_probe
from judge import judge_response, judge_total, judge_composite

SONNET = "claude-sonnet-4-20250514"
RESULTS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "results_judge_suite.json"
)

CONDITIONS = {
    "PRODUCTION": (PRODUCTION_GRADUATED, PREAMBLE),
    "REALISTIC": (REALISTIC_GRADUATED, PREAMBLE),
    "EXPERT": (EXPERT_TEXT_CONTROL, PREAMBLE),
    "INSTRUCT": (INSTRUCTIONAL_EQUIVALENT, PREAMBLE),
    "BARE": (BARE_MODEL, ""),
}


def load_results():
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE) as f:
            return json.load(f)
    return {"runs": [], "runs_complete": 0}


def save_results(results):
    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)


def run_one_condition(client, cond_name, identity, preamble):
    """Run all 7 hard probes for one condition, judge-score each."""
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
    parser.add_argument("--runs", type=int, default=1)
    args = parser.parse_args()

    client = anthropic.Anthropic()
    results = load_results()
    start_run = results["runs_complete"]

    if start_run >= args.runs:
        print(f"Already have {start_run} runs. Use --runs {start_run + 1} to add more.")
        print_summary(results)
        return

    print(f"Starting run {start_run + 1}/{args.runs}")
    print(f"Conditions: {list(CONDITIONS.keys())}")
    print(f"7 hard probes per condition, judge-scored")
    print(f"API calls per run: {len(CONDITIONS) * 7 * 2} (Sonnet + Haiku)")
    print()

    for run_idx in range(start_run, args.runs):
        run_data = {"run": run_idx + 1, "conditions": {}}
        order = list(CONDITIONS.keys())
        random.shuffle(order)
        print(f"=== RUN {run_idx + 1}/{args.runs} (order: {', '.join(order)}) ===")

        for cond_name in order:
            identity, preamble = CONDITIONS[cond_name]
            print(f"  {cond_name}...", end=" ", flush=True)

            cond_result = run_one_condition(client, cond_name, identity, preamble)
            run_data["conditions"][cond_name] = cond_result

            total = cond_result["composite"]["total"]
            max_p = cond_result["composite"]["max_possible"]
            avgs = cond_result["composite"]["averages"]
            print(
                f"total={total}/{max_p}  "
                f"ei={avgs['epistemic_integrity']:.1f}  "
                f"ii={avgs['identity_inhabitation']:.1f}  "
                f"rq={avgs['reasoning_quality']:.1f}  "
                f"ao={avgs['action_orientation']:.1f}"
            )

            # Save after each condition
            results["runs"].append({"run": run_idx + 1, "condition": cond_name, "data": cond_result})
            save_results(results)

        results["runs_complete"] = run_idx + 1
        save_results(results)
        print()

    print_summary(results)


def print_summary(results):
    print()
    print("=" * 70)
    print("  JUDGE-SCORED ABLATION RESULTS")
    print("=" * 70)

    # Aggregate by condition across runs
    cond_totals = {}
    for entry in results["runs"]:
        name = entry["condition"]
        data = entry["data"]
        if name not in cond_totals:
            cond_totals[name] = {"totals": [], "dims": {
                "epistemic_integrity": [],
                "identity_inhabitation": [],
                "reasoning_quality": [],
                "action_orientation": [],
            }}
        cond_totals[name]["totals"].append(data["composite"]["total"])
        for dim, val in data["composite"]["averages"].items():
            cond_totals[name]["dims"][dim].append(val)

    print(f"\n  {'Condition':12s} {'Total':>7s} {'EI':>5s} {'II':>5s} {'RQ':>5s} {'AO':>5s} {'N':>4s}")
    print(f"  {'─' * 42}")

    for name in ["PRODUCTION", "REALISTIC", "EXPERT", "INSTRUCT", "BARE"]:
        if name not in cond_totals:
            continue
        ct = cond_totals[name]
        n = len(ct["totals"])
        avg_total = sum(ct["totals"]) / n
        max_total = ct["totals"][0]  # from first run's max_possible
        avgs = {d: sum(v) / len(v) for d, v in ct["dims"].items()}
        print(
            f"  {name:12s} {avg_total:5.1f}/{7*12:2d}  "
            f"{avgs['epistemic_integrity']:5.2f} "
            f"{avgs['identity_inhabitation']:5.2f} "
            f"{avgs['reasoning_quality']:5.2f} "
            f"{avgs['action_orientation']:5.2f} "
            f"{n:4d}"
        )

    print(f"\n  Dimensions: EI=epistemic_integrity, II=identity_inhabitation,")
    print(f"              RQ=reasoning_quality, AO=action_orientation")
    print(f"  Each dimension: 0-3 per probe, averaged across 7 probes")
    print(f"\n  Saved to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
