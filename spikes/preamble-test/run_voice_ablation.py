#!/usr/bin/env python3
"""
Voice vs Structure vs Self-Authorship ablation.

Three conditions, same content, same layer structure:
  SELF_AUTHORED  — 1st person, "you wrote this" preamble
  OTHER_AUTHORED — 1st person, "your team wrote this" preamble
  THIRD_PERSON   — 3rd person, descriptive preamble

7 hard probes per condition, judge-scored.
21 Sonnet + 21 Haiku = 42 API calls per run.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 run_voice_ablation.py [--runs 1]
"""

import json, time, sys, os, random, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anthropic
from preambles_v3 import NEW_PREAMBLE
from ablation_controls import (
    PRODUCTION_GRADUATED, THIRD_PERSON_PREAMBLE, OTHER_AUTHORED_PREAMBLE,
)
from voice_ablation import THIRD_PERSON_LAYERS
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system
from run_v3 import run_probe
from judge import judge_response, judge_total, judge_composite

SONNET = "claude-sonnet-4-20250514"
RESULTS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "results_voice_ablation.json"
)

# build_system adds the INHABIT bridge after preamble. For third-person
# and other-authored we skip that bridge (it says "you wrote this").
def build_voice_system(preamble, identity):
    """Build system prompt WITHOUT the self-authored inhabit bridge."""
    parts = []
    if preamble:
        parts.append(preamble)
    parts.append(identity)
    return "\n\n".join(p for p in parts if p)


CONDITIONS = {
    "SELF_AUTHORED": {
        "identity": PRODUCTION_GRADUATED,
        "builder": lambda: build_system(NEW_PREAMBLE, PRODUCTION_GRADUATED),
    },
    "OTHER_AUTHORED": {
        "identity": PRODUCTION_GRADUATED,
        "builder": lambda: build_voice_system(OTHER_AUTHORED_PREAMBLE, PRODUCTION_GRADUATED),
    },
    "THIRD_PERSON": {
        "identity": THIRD_PERSON_LAYERS,
        "builder": lambda: build_voice_system(THIRD_PERSON_PREAMBLE, THIRD_PERSON_LAYERS),
    },
}


def load_results():
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE) as f:
            return json.load(f)
    return {"runs": [], "runs_complete": 0}


def save_results(results):
    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)


def run_one_condition(client, cond_name, system):
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
        print(f"Already have {start_run} runs.")
        print_summary(results)
        return

    print(f"Voice vs Structure vs Self-Authorship ablation")
    print(f"Conditions: {list(CONDITIONS.keys())}")
    print(f"7 hard probes, judge-scored. 42 API calls per run.")
    print()

    for run_idx in range(start_run, args.runs):
        order = list(CONDITIONS.keys())
        random.shuffle(order)
        print(f"=== RUN {run_idx + 1}/{args.runs} (order: {', '.join(order)}) ===")

        for cond_name in order:
            system = CONDITIONS[cond_name]["builder"]()
            print(f"  {cond_name} ({len(system)} chars)...", end=" ", flush=True)

            result = run_one_condition(client, cond_name, system)
            results["runs"].append({
                "run": run_idx + 1, "condition": cond_name, "data": result,
            })
            save_results(results)

            total = result["composite"]["total"]
            avgs = result["composite"]["averages"]
            print(
                f"total={total}/84  "
                f"ei={avgs['epistemic_integrity']:.1f}  "
                f"ii={avgs['identity_inhabitation']:.1f}  "
                f"rq={avgs['reasoning_quality']:.1f}  "
                f"ao={avgs['action_orientation']:.1f}"
            )

        results["runs_complete"] = run_idx + 1
        save_results(results)
        print()

    print_summary(results)


def print_summary(results):
    print()
    print("=" * 70)
    print("  VOICE vs STRUCTURE vs SELF-AUTHORSHIP")
    print("=" * 70)

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

    print(f"\n  {'Condition':15s} {'Total':>7s} {'EI':>5s} {'II':>5s} {'RQ':>5s} {'AO':>5s} {'N':>4s}")
    print(f"  {'─' * 45}")

    for name in ["SELF_AUTHORED", "OTHER_AUTHORED", "THIRD_PERSON"]:
        if name not in cond_totals:
            continue
        ct = cond_totals[name]
        n = len(ct["totals"])
        avg_total = sum(ct["totals"]) / n
        avgs = {d: sum(v) / len(v) for d, v in ct["dims"].items()}
        print(
            f"  {name:15s} {avg_total:5.1f}/84  "
            f"{avgs['epistemic_integrity']:5.2f} "
            f"{avgs['identity_inhabitation']:5.2f} "
            f"{avgs['reasoning_quality']:5.2f} "
            f"{avgs['action_orientation']:5.2f} "
            f"{n:4d}"
        )

    print(f"\n  Key question: does SELF > OTHER on identity_inhabitation?")
    print(f"  If yes → self-authorship framing matters")
    print(f"  If OTHER > THIRD → first-person voice matters")
    print(f"  If all equal → it's just the content/structure")
    print(f"\n  Saved to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
