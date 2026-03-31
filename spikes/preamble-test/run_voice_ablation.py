#!/usr/bin/env python3
"""
Voice vs Structure vs Self-Authorship ablation.

Three conditions, same content, same layer structure:
  SELF_AUTHORED  — 1st person, "you wrote this" preamble
  OTHER_AUTHORED — 1st person, "your team wrote this" preamble
  THIRD_PERSON   — 3rd person, descriptive preamble

Two test types per condition:
  1. 7 hard probes (resistance) — judge-scored on 4 dims
  2. 1 paper task (action) — judge-scored on 4 paper-specific dims

Per run: 3 conditions x (7 probes + 1 paper) = 24 Sonnet + 24 Sonnet judge = 48 calls

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
from probes_hard import HARD_PROBES, HARD_PAPER_SKILL, HARD_PAPER_TASK
from run_ablation_hard import build_system
from run_v3 import run_probe
from judge import (
    judge_response, judge_total, judge_composite,
    judge_paper, paper_total, PAPER_DIMS,
)

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
    """Run probes + paper task for one condition."""
    # ── Hard probes (resistance) ──────────────────────────────────────
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

    probe_composite = judge_composite({n: d["scores"] for n, d in probe_scores.items()})

    # ── Paper task (action) — no sources, no tool instructions ─────
    # Tests whether identity makes the model REACH FOR verification
    # tools it already has, vs fabricating or refusing.
    paper_system = system + "\n\n" + HARD_PAPER_SKILL
    paper_response = run_probe(SONNET, paper_system, HARD_PAPER_TASK)
    time.sleep(0.5)
    paper_scores = judge_paper(client, paper_response)
    p_total = paper_total(paper_scores)

    return {
        "condition": cond_name,
        "system_chars": len(system),
        "probes": probe_scores,
        "probe_composite": probe_composite,
        "paper": {
            "scores": paper_scores,
            "total": p_total,
            "response_len": len(paper_response),
        },
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
    print(f"7 hard probes + 1 paper task, judge-scored. ~48 API calls per run.")
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

            p_avgs = result["probe_composite"]["averages"]
            ps = result["paper"]["scores"]
            pt = result["paper"]["total"]
            print(
                f"probes={result['probe_composite']['total']}/84  "
                f"ii={p_avgs['identity_inhabitation']:.1f}  "
                f"paper={pt}/12  "
                f"ver={ps.get('reached_for_verification',0)}  "
                f"fab={ps.get('fabrication_resistance',0)}  "
                f"use={ps.get('useful_despite_constraints',0)}  "
                f"si={ps.get('self_interrogation_quality',0)}"
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

    cond_data = {}
    for entry in results["runs"]:
        name = entry["condition"]
        data = entry["data"]
        if name not in cond_data:
            cond_data[name] = {
                "probe_totals": [],
                "probe_dims": {
                    "epistemic_integrity": [],
                    "identity_inhabitation": [],
                    "reasoning_quality": [],
                    "action_orientation": [],
                },
                "paper_totals": [],
                "paper_dims": {d: [] for d in PAPER_DIMS},
            }
        cd = cond_data[name]
        cd["probe_totals"].append(data["probe_composite"]["total"])
        for dim, val in data["probe_composite"]["averages"].items():
            cd["probe_dims"][dim].append(val)
        cd["paper_totals"].append(data["paper"]["total"])
        for d in PAPER_DIMS:
            cd["paper_dims"][d].append(data["paper"]["scores"].get(d, 0))

    # Probe results
    print(f"\n  PROBE SCORES (resistance)")
    print(f"  {'Condition':15s} {'Total':>7s} {'EI':>5s} {'II':>5s} {'RQ':>5s} {'AO':>5s} {'N':>4s}")
    print(f"  {'─' * 45}")
    for name in ["SELF_AUTHORED", "OTHER_AUTHORED", "THIRD_PERSON"]:
        if name not in cond_data:
            continue
        cd = cond_data[name]
        n = len(cd["probe_totals"])
        avg = sum(cd["probe_totals"]) / n
        avgs = {d: sum(v) / len(v) for d, v in cd["probe_dims"].items()}
        print(
            f"  {name:15s} {avg:5.1f}/84  "
            f"{avgs['epistemic_integrity']:5.2f} "
            f"{avgs['identity_inhabitation']:5.2f} "
            f"{avgs['reasoning_quality']:5.2f} "
            f"{avgs['action_orientation']:5.2f} "
            f"{n:4d}"
        )

    # Paper results
    print(f"\n  PAPER SCORES (action — did it reach for tools?)")
    print(f"  {'Condition':15s} {'Total':>7s} {'Ver':>5s} {'Fab':>5s} {'Use':>5s} {'SI':>5s} {'N':>4s}")
    print(f"  {'─' * 45}")
    for name in ["SELF_AUTHORED", "OTHER_AUTHORED", "THIRD_PERSON"]:
        if name not in cond_data:
            continue
        cd = cond_data[name]
        n = len(cd["paper_totals"])
        avg = sum(cd["paper_totals"]) / n
        avgs = {d: sum(v) / len(v) for d, v in cd["paper_dims"].items()}
        print(
            f"  {name:15s} {avg:5.1f}/12  "
            f"{avgs['reached_for_verification']:5.2f} "
            f"{avgs['fabrication_resistance']:5.2f} "
            f"{avgs['useful_despite_constraints']:5.2f} "
            f"{avgs['self_interrogation_quality']:5.2f} "
            f"{n:4d}"
        )

    print(f"\n  Key question: does SELF_AUTHORED win on PAPER scores?")
    print(f"  Round 3 finding: self-authorship drives ACTION, not just resistance.")
    print(f"  If SELF > OTHER on paper → 'you wrote this' framing drives action")
    print(f"  If all equal on paper → content/structure is enough for action too")
    print(f"\n  Saved to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
