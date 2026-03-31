"""
Identity Ablation Study — Does self-authored identity drive behavior,
or is it just "sticky context"?

7 conditions, 10 runs each (probes + papers), with statistical analysis.

CONDITIONS (designed to isolate the mechanism):
  A. graduated + preamble     — Full production config (the claim)
  B. graduated + naked        — Identity without preamble framing
  C. expert_text + preamble   — Same LENGTH, same CONTENT, NOT self-authored
  D. instructional + preamble — Same content rewritten as instructions
  E. L5_only + preamble       — Master identity only, no lower layers
  F. L2_only + preamble       — Raw observations only, no condensed identity
  G. bare + naked             — Bare model, nothing at all

KEY COMPARISONS (what proves what):
  A vs C  → Does self-authored framing matter? (same info, different voice)
  A vs D  → Does first-person narrative beat third-person instructions?
  A vs B  → Does the preamble framing add value?
  A vs E  → Does the full layer stack matter?
  A vs F  → Does condensed identity beat raw observations?
  A vs G  → Does ANY context help? (sanity check)
  C vs G  → Does expert text help vs bare model? (context length effect)

ANTHROPIC_API_KEY=... python spikes/preamble-test/run_ablation.py [--runs N]
"""

import json, os, re, sys, time, argparse, random
from datetime import datetime

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

try:
    from scipy import stats as scipy_stats
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("WARNING: scipy not installed — skipping p-value calculations")

from preambles_v3 import NEW_PREAMBLE as INHABIT_ACT_PREAMBLE, INHABIT
from mock_identities import MINIMAL_IDENTITY, GRADUATED_IDENTITY
from ablation_controls import (
    EXPERT_TEXT_CONTROL, L5_ONLY, L2_ONLY,
    INSTRUCTIONAL_EQUIVALENT, BARE_MODEL,
)
from probes import PROBES

# Re-use scoring infrastructure from v3
from run_v3 import (
    SEARCH_TOOL, PAPER_TASK, PAPER_SKILL, VALID_DOIS,
    fake_results, build_system, build_paper_system,
    run_probe, run_paper, score_paper, score_probes, action_score,
)

client = anthropic.Anthropic()

# Use Sonnet for cost efficiency across many runs
SONNET = "claude-sonnet-4-20250514"

# ── Conditions ─────────────────────────────────────────────────────────────

CONDITIONS = {
    "A_graduated_preamble": {
        "identity": GRADUATED_IDENTITY,
        "preamble": INHABIT_ACT_PREAMBLE,
        "label": "Graduated + Preamble (production)",
    },
    "B_graduated_naked": {
        "identity": GRADUATED_IDENTITY,
        "preamble": "",
        "label": "Graduated + No Preamble",
    },
    "C_expert_text_preamble": {
        "identity": EXPERT_TEXT_CONTROL,
        "preamble": INHABIT_ACT_PREAMBLE,
        "label": "Expert Text + Preamble (length control)",
    },
    "D_instructional_preamble": {
        "identity": INSTRUCTIONAL_EQUIVALENT,
        "preamble": INHABIT_ACT_PREAMBLE,
        "label": "Instructions + Preamble (voice control)",
    },
    "E_L5_only_preamble": {
        "identity": L5_ONLY,
        "preamble": INHABIT_ACT_PREAMBLE,
        "label": "L5 Master Only + Preamble",
    },
    "F_L2_only_preamble": {
        "identity": L2_ONLY,
        "preamble": INHABIT_ACT_PREAMBLE,
        "label": "L2 Paragraphs Only + Preamble",
    },
    "G_bare_naked": {
        "identity": BARE_MODEL,
        "preamble": "",
        "label": "Bare Model (no identity, no preamble)",
    },
}

# Randomize condition order per run to prevent ordering effects
CONDITION_KEYS = list(CONDITIONS.keys())


def run_single_probe_set(cond_name, cond, model_id, run_idx):
    """Run all 5 probes for one condition. Returns dict of scores."""
    preamble = cond["preamble"]
    identity = cond["identity"]
    probe_system = build_system(preamble, identity)

    responses = {}
    for probe in PROBES:
        label = f"  [{cond_name}] run {run_idx+1} / {probe['name']}"
        try:
            text = run_probe(model_id, probe_system, probe["prompt"])
            responses[probe["name"]] = text
            preview = text[:80].replace("\n", " ")
            print(f"    {probe['name']}: {preview}...")
        except Exception as e:
            responses[probe["name"]] = f"ERROR: {e}"
            print(f"    {probe['name']}: ERROR {e}")
        time.sleep(0.3)

    p_scores = score_probes(responses)
    a_score = action_score(p_scores)
    return {
        "responses": responses,
        "probe_scores": p_scores,
        "action_score": a_score,
    }


def run_single_paper(cond_name, cond, model_id, run_idx):
    """Run one paper-writing task. Returns dict of scores."""
    preamble = cond["preamble"]
    identity = cond["identity"]
    paper_system = build_paper_system(preamble, identity)

    try:
        result = run_paper(model_id, paper_system)
        scores = score_paper(result)
        print(f"    paper: searches={scores.get('num_searches', 0)}"
              f" cite_acc={scores.get('cite_accuracy', 0):.2f}"
              f" hall={scores.get('hallucinated', '?')}"
              f" opp={scores.get('opposing_queries', '?')}")
        return scores
    except Exception as e:
        print(f"    paper: ERROR {e}")
        return {"error": str(e)}


def compute_stats(values):
    """Compute mean, std, min, max for a list of numbers."""
    if not values:
        return {"mean": 0, "std": 0, "min": 0, "max": 0, "n": 0}
    import numpy as np
    arr = np.array(values, dtype=float)
    return {
        "mean": float(np.mean(arr)),
        "std": float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0,
        "min": float(np.min(arr)),
        "max": float(np.max(arr)),
        "n": len(arr),
    }


def compare_conditions(results, key_a, key_b, metric="action_score"):
    """Mann-Whitney U test between two conditions on a metric."""
    vals_a = [r[metric] for r in results[key_a]["runs"] if metric in r]
    vals_b = [r[metric] for r in results[key_b]["runs"] if metric in r]

    if len(vals_a) < 3 or len(vals_b) < 3:
        return {"note": "insufficient data"}

    stats_a = compute_stats(vals_a)
    stats_b = compute_stats(vals_b)

    out = {
        "a": key_a,
        "b": key_b,
        "metric": metric,
        "a_mean": stats_a["mean"],
        "b_mean": stats_b["mean"],
        "a_std": stats_a["std"],
        "b_std": stats_b["std"],
        "diff": stats_a["mean"] - stats_b["mean"],
    }

    if HAS_SCIPY:
        try:
            u_stat, p_value = scipy_stats.mannwhitneyu(
                vals_a, vals_b, alternative="two-sided"
            )
            out["U_statistic"] = float(u_stat)
            out["p_value"] = float(p_value)
            out["significant_p05"] = p_value < 0.05
            out["significant_p01"] = p_value < 0.01
        except Exception as e:
            out["stats_error"] = str(e)

    return out


def run_ablation(n_runs=10):
    """Main test runner."""
    print(f"\n{'='*70}")
    print(f"  IDENTITY ABLATION STUDY")
    print(f"  {len(CONDITIONS)} conditions x {n_runs} runs")
    print(f"  Started: {datetime.now().isoformat()}")
    print(f"{'='*70}\n")

    all_results = {}
    for key in CONDITIONS:
        all_results[key] = {
            "label": CONDITIONS[key]["label"],
            "runs": [],
        }

    total_calls = len(CONDITIONS) * n_runs * (len(PROBES) + 1)
    call_num = 0

    for run_idx in range(n_runs):
        # Randomize condition order each run
        order = CONDITION_KEYS.copy()
        random.shuffle(order)

        print(f"\n{'─'*70}")
        print(f"  RUN {run_idx + 1}/{n_runs}")
        print(f"  Order: {', '.join(order)}")
        print(f"{'─'*70}")

        for cond_key in order:
            cond = CONDITIONS[cond_key]
            print(f"\n  >> {cond_key} ({cond['label']})")

            # Probes
            probe_result = run_single_probe_set(
                cond_key, cond, SONNET, run_idx
            )

            # Paper
            paper_result = run_single_paper(
                cond_key, cond, SONNET, run_idx
            )

            # Combine into single run result
            run_data = {
                "run": run_idx + 1,
                "action_score": probe_result["action_score"],
                "probe_scores": probe_result["probe_scores"],
                "paper_scores": paper_result,
            }
            all_results[cond_key]["runs"].append(run_data)

            call_num += len(PROBES) + 1
            print(f"    ACTION SCORE: {probe_result['action_score']}")
            print(f"    Progress: {call_num}/{total_calls} calls")

            # Save incrementally (in case of crash)
            _save_incremental(all_results, n_runs)

    # ── Final analysis ──────────────────────────────────────────────────
    analysis = analyze_results(all_results)
    all_results["_analysis"] = analysis
    all_results["_meta"] = {
        "n_runs": n_runs,
        "model": SONNET,
        "timestamp": datetime.now().isoformat(),
        "conditions": {k: v["label"] for k, v in CONDITIONS.items()},
    }

    out_path = os.path.join(os.path.dirname(__file__), "results_ablation.json")
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    print_summary(all_results, analysis)
    print(f"\n  Saved to {out_path}")


def _save_incremental(results, n_runs):
    """Save partial results after each condition completes."""
    out = os.path.join(os.path.dirname(__file__), "results_ablation_partial.json")
    data = {
        **results,
        "_meta": {
            "n_runs_target": n_runs,
            "model": SONNET,
            "partial": True,
            "saved_at": datetime.now().isoformat(),
        },
    }
    with open(out, "w") as f:
        json.dump(data, f, indent=2, default=str)


def analyze_results(results):
    """Compute statistics and key comparisons."""
    analysis = {"condition_stats": {}, "comparisons": []}

    # Per-condition stats
    for key in CONDITION_KEYS:
        runs = results[key]["runs"]
        action_scores = [r["action_score"] for r in runs]
        analysis["condition_stats"][key] = {
            "action_score": compute_stats(action_scores),
            "label": results[key]["label"],
        }

        # Paper metric averages
        paper_metrics = ["cite_accuracy", "hallucinated", "opposing_queries",
                         "num_searches", "conf_calibrated", "noted_weak"]
        for metric in paper_metrics:
            vals = []
            for r in runs:
                ps = r.get("paper_scores", {})
                if metric in ps and not isinstance(ps[metric], str):
                    v = ps[metric]
                    if isinstance(v, bool):
                        vals.append(1.0 if v else 0.0)
                    elif isinstance(v, (int, float)):
                        vals.append(float(v))
            if vals:
                analysis["condition_stats"][key][f"paper_{metric}"] = compute_stats(vals)

    # Key comparisons (the ones that answer ChatGPT's challenges)
    key_comparisons = [
        ("A_graduated_preamble", "C_expert_text_preamble",
         "Self-authored identity vs expert text (MAIN ABLATION)"),
        ("A_graduated_preamble", "D_instructional_preamble",
         "First-person narrative vs third-person instructions"),
        ("A_graduated_preamble", "B_graduated_naked",
         "Does preamble framing add value?"),
        ("A_graduated_preamble", "E_L5_only_preamble",
         "Full stack vs L5 master only"),
        ("A_graduated_preamble", "F_L2_only_preamble",
         "Full stack vs L2 raw observations only"),
        ("A_graduated_preamble", "G_bare_naked",
         "Any identity vs bare model (sanity check)"),
        ("C_expert_text_preamble", "G_bare_naked",
         "Expert text vs bare model (context length effect)"),
        ("D_instructional_preamble", "G_bare_naked",
         "Instructions vs bare model"),
        ("B_graduated_naked", "C_expert_text_preamble",
         "Naked identity vs expert text (identity without framing)"),
    ]

    for key_a, key_b, description in key_comparisons:
        comp = compare_conditions(results, key_a, key_b, "action_score")
        comp["description"] = description
        analysis["comparisons"].append(comp)

    return analysis


def print_summary(results, analysis):
    """Print human-readable summary."""
    print(f"\n\n{'='*70}")
    print(f"  ABLATION STUDY RESULTS")
    print(f"{'='*70}")

    # Action scores table
    print(f"\n  {'Condition':<35s} {'Mean':>6s} {'Std':>6s}"
          f" {'Min':>5s} {'Max':>5s} {'N':>4s}")
    print(f"  {'─'*65}")

    for key in CONDITION_KEYS:
        cs = analysis["condition_stats"][key]
        a = cs["action_score"]
        print(f"  {key:<35s} {a['mean']:6.1f} {a['std']:6.2f}"
              f" {a['min']:5.0f} {a['max']:5.0f} {a['n']:4d}")

    # Paper metrics table
    print(f"\n  {'Condition':<35s} {'Cite%':>6s} {'Hall':>5s}"
          f" {'Opp%':>6s} {'Srch':>5s}")
    print(f"  {'─'*60}")

    for key in CONDITION_KEYS:
        cs = analysis["condition_stats"][key]
        cite = cs.get("paper_cite_accuracy", {}).get("mean", 0)
        hall = cs.get("paper_hallucinated", {}).get("mean", 0)
        opp = cs.get("paper_opposing_queries", {}).get("mean", 0)
        srch = cs.get("paper_num_searches", {}).get("mean", 0)
        print(f"  {key:<35s} {cite:6.0%} {hall:5.1f}"
              f" {opp:6.0%} {srch:5.1f}")

    # Key comparisons
    print(f"\n\n  KEY COMPARISONS (Action Score)")
    print(f"  {'─'*70}")

    for comp in analysis["comparisons"]:
        desc = comp.get("description", "")
        if "note" in comp:
            print(f"\n  {desc}")
            print(f"    {comp['note']}")
            continue

        diff = comp.get("diff", 0)
        direction = "+" if diff > 0 else ""
        sig = ""
        if comp.get("significant_p01"):
            sig = " ***"
        elif comp.get("significant_p05"):
            sig = " **"
        else:
            sig = " (n.s.)"

        p_str = f"p={comp.get('p_value', '?'):.4f}" if "p_value" in comp else "no scipy"

        print(f"\n  {desc}")
        print(f"    {comp['a']}: {comp.get('a_mean', 0):.1f} (±{comp.get('a_std', 0):.2f})")
        print(f"    {comp['b']}: {comp.get('b_mean', 0):.1f} (±{comp.get('b_std', 0):.2f})")
        print(f"    Diff: {direction}{diff:.1f}  |  {p_str}{sig}")

    # Verdict
    print(f"\n\n  {'='*70}")
    print(f"  INTERPRETATION GUIDE")
    print(f"  {'='*70}")
    print(f"""
  If A >> C (graduated >> expert text):
    Self-authored identity drives behavior, not just context length.
    ChatGPT's "sticky context" dismissal is WRONG.

  If A ≈ C (graduated ≈ expert text):
    Identity is just context. ChatGPT was right.
    The mechanism is information density, not self-authorship.

  If A >> D (graduated >> instructions):
    First-person narrative beats third-person instructions.
    "I learned X" > "You should do X" is PROVEN.

  If A >> B (preamble helps):
    The inhabit→act framing adds measurable value.

  If A >> E (full stack >> L5 only):
    The layered condensation architecture matters.
    Can't just use the master identity alone.

  If E >> F (L5 >> L2):
    Condensed identity beats raw observations.
    The condensation process itself adds value.

  If C >> G (expert text >> bare):
    Context length alone helps (expected).
    But if A >> C, the identity CONTENT matters beyond length.
""")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Identity Ablation Study")
    parser.add_argument("--runs", type=int, default=10,
                        help="Number of runs per condition (default: 10)")
    args = parser.parse_args()
    run_ablation(n_runs=args.runs)
