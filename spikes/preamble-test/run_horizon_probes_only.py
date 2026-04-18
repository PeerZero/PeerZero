"""
Throwaway runner: exercise HORIZON_PROBES only across the 3 minimal
conditions (bare / identity_current / identity_horizon) at n=4.

Reuses the same build_system_production, run_probe, and judge_response
from the main harness so results are methodologically comparable.

Saves raw responses for qualitative review of safety properties.
"""
import json, os, random, sys, time
import anthropic

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from identity_graduated_v2 import IDENTITY_V2
from preambles_v4 import REQUIRED_VARIANTS
from probes_horizon import HORIZON_PROBES
from judge import judge_response, judge_total, judge_composite
from run_v3 import run_probe
from run_horizon_ablation import build_system_production, SONNET

RUNS = 4
OUT = os.path.join(HERE, "results_horizon_probes_only.json")

CONDITIONS = {
    "bare": (None, ""),
    "identity_current": (IDENTITY_V2, REQUIRED_VARIANTS["current_recognition_inhabit"]),
    "identity_horizon": (IDENTITY_V2, REQUIRED_VARIANTS["horizon_extended"]),
}


def run_one(client, cond_name, identity, preamble):
    system = build_system_production(preamble, identity)
    probe_scores = {}
    for probe in HORIZON_PROBES:
        response = run_probe(SONNET, system, probe["prompt"])
        scores = judge_response(client, probe["name"], probe["prompt"], response)
        probe_scores[probe["name"]] = {
            "scores": scores,
            "total": judge_total(scores),
            "response_len": len(response),
            "response": response,
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
    client = anthropic.Anthropic()
    results = {"runs": [], "runs_complete": 0}
    if os.path.exists(OUT):
        with open(OUT) as f:
            results = json.load(f)

    total_calls = len(CONDITIONS) * len(HORIZON_PROBES) * 2 * (RUNS - results["runs_complete"])
    print(f"Conditions: {list(CONDITIONS.keys())}")
    print(f"Horizon probes: {[p['name'] for p in HORIZON_PROBES]}")
    print(f"Runs: {RUNS} (resume from {results['runs_complete'] + 1})")
    print(f"Remaining calls: ~{total_calls}")
    print()

    for run_idx in range(results["runs_complete"], RUNS):
        order = list(CONDITIONS.keys())
        random.shuffle(order)
        print(f"=== RUN {run_idx + 1}/{RUNS} (order: {', '.join(order)}) ===")
        for cond_name in order:
            identity, preamble = CONDITIONS[cond_name]
            print(f"  {cond_name}...", end=" ", flush=True)
            data = run_one(client, cond_name, identity, preamble)
            avgs = data["composite"]["averages"]
            print(
                f"ii={avgs['identity_inhabitation']:.2f}  "
                f"ei={avgs['epistemic_integrity']:.2f}  "
                f"rq={avgs['reasoning_quality']:.2f}  "
                f"ao={avgs['action_orientation']:.2f}"
            )
            results["runs"].append({
                "run": run_idx + 1,
                "condition": cond_name,
                "data": data,
            })
            with open(OUT, "w") as f:
                json.dump(results, f, indent=2)
        results["runs_complete"] = run_idx + 1
        with open(OUT, "w") as f:
            json.dump(results, f, indent=2)

    # Summary
    from collections import defaultdict
    by_cond = defaultdict(list)
    for r in results["runs"]:
        by_cond[r["condition"]].append(r["data"]["composite"]["averages"])

    print("\n" + "=" * 70)
    print("  HORIZON PROBE RESULTS (n={} per condition)".format(RUNS))
    print("=" * 70)
    print(f"{'condition':<25}{'ii':>7}{'ei':>7}{'rq':>7}{'ao':>7}")
    print("-" * 60)
    for cond in ["bare", "identity_current", "identity_horizon"]:
        xs = by_cond[cond]
        def m(k): return sum(x[k] for x in xs) / len(xs)
        print(f"{cond:<25}{m('identity_inhabitation'):>7.2f}{m('epistemic_integrity'):>7.2f}"
              f"{m('reasoning_quality'):>7.2f}{m('action_orientation'):>7.2f}")


if __name__ == "__main__":
    main()
