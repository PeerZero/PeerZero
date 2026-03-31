#!/usr/bin/env python3
"""
Combined ablation study — run locally.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 run_combined.py [--runs 5]

Saves results incrementally to results_combined.json after every condition.
Safe to ctrl-C and restart — picks up where it left off.
"""

import json, time, sys, random, os, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from preambles_v3 import NEW_PREAMBLE as PREAMBLE
from ablation_controls import (
    REALISTIC_GRADUATED, EXPERT_TEXT_CONTROL, BARE_MODEL,
    INSTRUCTIONAL_EQUIVALENT,
)
from mock_identities import GRADUATED_IDENTITY
from probes import PROBES
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system, score_hard_probes, hard_action_score
from run_v3 import run_probe, score_probes, action_score

SONNET = "claude-sonnet-4-20250514"
RESULTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results_combined.json")

CONDITIONS = {
    "H_realistic": (REALISTIC_GRADUATED, PREAMBLE),
    "A_graduated_thin": (GRADUATED_IDENTITY, PREAMBLE),
    "C_expert_text": (EXPERT_TEXT_CONTROL, PREAMBLE),
    "D_instructions": (INSTRUCTIONAL_EQUIVALENT, PREAMBLE),
    "G_bare": (BARE_MODEL, ""),
}


def load_results():
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE) as f:
            return json.load(f)
    return {
        "easy": {k: [] for k in CONDITIONS},
        "hard": {k: [] for k in CONDITIONS},
        "memory": {k: [] for k in CONDITIONS},
        "runs_complete": 0,
    }


def save_results(results):
    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)


def run_one_condition(cond_name, identity, preamble):
    """Run easy + hard probes for one condition. Returns (easy_score, hard_score, memory_label)."""
    system = build_system(preamble, identity)

    # Easy probes (5 probes)
    easy_responses = {}
    for probe in PROBES:
        text = run_probe(SONNET, system, probe["prompt"])
        easy_responses[probe["name"]] = text
        time.sleep(0.3)
    e_scores = score_probes(easy_responses)
    e_score = action_score(e_scores)

    # Hard probes (7 probes)
    hard_responses = {}
    for probe in HARD_PROBES:
        text = run_probe(SONNET, system, probe["prompt"])
        hard_responses[probe["name"]] = text
        time.sleep(0.3)
    h_scores = score_hard_probes(hard_responses)
    h_score = hard_action_score(h_scores)

    if h_scores.get("ma_has_self"):
        mem = "SELF"
    elif h_scores.get("ma_refuses_self"):
        mem = "REFUSE"
    else:
        mem = "neutral"

    return e_score, h_score, mem, h_scores


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()

    results = load_results()
    start_run = results["runs_complete"]

    if start_run >= args.runs:
        print(f"Already have {start_run} runs. Use --runs {start_run + 5} to add more.")
        print_summary(results)
        return

    print(f"Starting from run {start_run + 1}, target {args.runs} runs")
    print(f"Conditions: {list(CONDITIONS.keys())}")
    print(f"12 probes per condition (5 easy + 7 hard)")
    print()

    for run in range(start_run, args.runs):
        order = list(CONDITIONS.keys())
        random.shuffle(order)
        print(f"=== RUN {run + 1}/{args.runs} ===")
        print(f"    Order: {', '.join(order)}")

        for cond_name in order:
            identity, preamble = CONDITIONS[cond_name]
            e_score, h_score, mem, h_detail = run_one_condition(
                cond_name, identity, preamble
            )

            results["easy"][cond_name].append(e_score)
            results["hard"][cond_name].append(h_score)
            results["memory"][cond_name].append(mem)

            resist = "YES" if h_detail.get("ci_resisted") else "no"
            fab = "YES" if h_detail.get("pts_fabricated") else "no"
            print(
                f"  {cond_name:20s}  easy={e_score:2d}  hard={h_score:2d}"
                f"  mem={mem:7s}  resist={resist:3s}  fab={fab:3s}"
            )

            # Save after every condition
            results["runs_complete"] = run  # not yet done with this run
            save_results(results)

        results["runs_complete"] = run + 1
        save_results(results)
        print()

    print_summary(results)


def print_summary(results):
    print()
    print("=" * 70)
    print("  COMBINED ABLATION RESULTS")
    print("=" * 70)

    print(f"\n  {'Condition':20s} {'Easy':>6s} {'Hard':>6s} {'Self%':>6s} {'N':>4s}")
    print(f"  {'─' * 45}")

    for k in ["H_realistic", "C_expert_text", "A_graduated_thin", "D_instructions", "G_bare"]:
        e = results["easy"].get(k, [])
        h = results["hard"].get(k, [])
        m = results["memory"].get(k, [])
        if not e:
            continue
        e_avg = sum(e) / len(e)
        h_avg = sum(h) / len(h)
        self_pct = sum(1 for x in m if x == "SELF") / len(m) if m else 0
        print(f"  {k:20s} {e_avg:6.1f} {h_avg:6.1f} {self_pct:6.0%} {len(e):4d}")

    print(f"\n  Easy scores (scaffolded probes):")
    for k in ["H_realistic", "C_expert_text", "A_graduated_thin", "D_instructions", "G_bare"]:
        e = results["easy"].get(k, [])
        if e:
            print(f"    {k:20s}  {e}")

    print(f"\n  Hard scores (adversarial, no scaffolding):")
    for k in ["H_realistic", "C_expert_text", "A_graduated_thin", "D_instructions", "G_bare"]:
        h = results["hard"].get(k, [])
        if h:
            print(f"    {k:20s}  {h}")

    print(f"\n  Identity inhabitation (memory probe):")
    for k in ["H_realistic", "C_expert_text", "A_graduated_thin", "D_instructions", "G_bare"]:
        m = results["memory"].get(k, [])
        if m:
            print(f"    {k:20s}  {m}")

    # P-values if scipy available
    try:
        from scipy import stats
        print(f"\n  Statistical tests (Mann-Whitney U, two-sided):")
        print(f"  {'─' * 55}")
        pairs = [
            ("H_realistic", "C_expert_text", "Identity vs Expert Text"),
            ("H_realistic", "G_bare", "Identity vs Bare Model"),
            ("C_expert_text", "G_bare", "Expert Text vs Bare"),
            ("H_realistic", "A_graduated_thin", "Realistic vs Thin Identity"),
        ]
        for ka, kb, label in pairs:
            for metric, name in [("easy", "Easy"), ("hard", "Hard")]:
                va = results[metric].get(ka, [])
                vb = results[metric].get(kb, [])
                if len(va) >= 3 and len(vb) >= 3:
                    u, p = stats.mannwhitneyu(va, vb, alternative="two-sided")
                    sig = "***" if p < 0.01 else "**" if p < 0.05 else "n.s."
                    diff = sum(va)/len(va) - sum(vb)/len(vb)
                    print(f"    {label:30s} {name:4s}: diff={diff:+.1f}  p={p:.4f} {sig}")
    except ImportError:
        print("\n  (pip install scipy for p-values)")

    print(f"\n  Saved to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
