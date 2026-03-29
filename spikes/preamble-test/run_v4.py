"""
Preamble revalidation v4 — current production config.

Tests 3 conditions matching what real bots experience:
  A. Graduated identity + inhabit→act preamble (production config)
  B. Graduated identity + naked (is preamble still helping?)
  C. Minimal identity + inhabit→act preamble (early bot experience)

Each: 5 probes + 3 paper runs = 24 total API calls.
Budget target: ~$1.50-2.50 on Sonnet.

ANTHROPIC_API_KEY=... python spikes/preamble-test/run_v4.py
"""

import json, os, sys, time

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

from preambles_v3 import NEW_PREAMBLE as INHABIT_ACT_PREAMBLE, INHABIT
from mock_identities import MINIMAL_IDENTITY, GRADUATED_IDENTITY
from probes import PROBES

# Re-use all scoring/search infrastructure from v3
from run_v3 import (
    SEARCH_TOOL, PAPER_TASK, PAPER_SKILL, VALID_DOIS,
    fake_results, build_system, build_paper_system,
    run_probe, run_paper, score_paper, score_probes, action_score,
)

client = anthropic.Anthropic()

SONNET = "claude-sonnet-4-20250514"

# ── Test matrix ─────────────────────────────────────────────────────────

CONDITIONS = {
    "graduated/inhabit_act": {
        "identity": GRADUATED_IDENTITY,
        "preamble": INHABIT_ACT_PREAMBLE,
    },
    "graduated/naked": {
        "identity": GRADUATED_IDENTITY,
        "preamble": "",
    },
    "minimal/inhabit_act": {
        "identity": MINIMAL_IDENTITY,
        "preamble": INHABIT_ACT_PREAMBLE,
    },
}

N_PAPER_RUNS = 3


def run_test():
    all_results = {}
    total = len(CONDITIONS) * (len(PROBES) + N_PAPER_RUNS)
    n = 0

    for cond_name, cond in CONDITIONS.items():
        preamble = cond["preamble"]
        identity = cond["identity"]

        print(f"\n{'='*60}")
        print(f"  {cond_name}")
        print(f"{'='*60}")

        # ── Probes ──
        probe_system = build_system(preamble, identity)
        responses = {}
        for probe in PROBES:
            n += 1
            label = f"{cond_name}/{probe['name']}"
            print(f"\n  [{n}/{total}] {label}")
            try:
                text = run_probe(SONNET, probe_system, probe["prompt"])
                responses[probe["name"]] = text
                preview = text[:120].replace("\n", " ")
                print(f"    -> {preview}...")
            except Exception as e:
                responses[probe["name"]] = f"ERROR: {e}"
                print(f"    -> ERROR: {e}")
            time.sleep(0.3)

        p_scores = score_probes(responses)
        a_score = action_score(p_scores)
        print(f"\n  Probe scores: {p_scores}")
        print(f"  ACTION SCORE: {a_score}")

        # ── Paper runs ──
        paper_system = build_paper_system(preamble, identity)
        paper_runs = []
        for i in range(N_PAPER_RUNS):
            n += 1
            label = f"{cond_name}/paper/run{i+1}"
            print(f"\n  [{n}/{total}] {label}")
            try:
                result = run_paper(SONNET, paper_system)
                scores = score_paper(result)
                paper_runs.append(scores)
                print(f"    searches={scores.get('num_searches', 0)}"
                      f"  cite_acc={scores.get('cite_accuracy', 0):.2f}"
                      f"  conf={scores.get('confidence', '?')}"
                      f"  cal={scores.get('conf_calibrated', '?')}"
                      f"  opp={scores.get('opposing_queries', '?')}"
                      f"  weak={scores.get('noted_weak', 0)}"
                      f"  hall={scores.get('hallucinated', '?')}")
            except Exception as e:
                paper_runs.append({"error": str(e)})
                print(f"    -> ERROR: {e}")
            time.sleep(0.5)

        # Average paper scores
        paper_avg = {}
        valid_runs = [r for r in paper_runs if "error" not in r]
        if valid_runs:
            for k in valid_runs[0]:
                vals = [s.get(k, 0) for s in valid_runs]
                if isinstance(vals[0], bool):
                    paper_avg[k] = sum(1 for v in vals if v) / len(vals)
                elif isinstance(vals[0], (int, float)):
                    paper_avg[k] = sum(vals) / len(vals)

        all_results[cond_name] = {
            "probe_responses": responses,
            "probe_scores": p_scores,
            "action_score": a_score,
            "paper_runs": paper_runs,
            "paper_avg": paper_avg,
        }

    # ── Summary ─────────────────────────────────────────────────────────
    print("\n\n" + "=" * 70)
    print("  V4 RESULTS — PRODUCTION PREAMBLE REVALIDATION")
    print("=" * 70)

    print(f"\n  {'Condition':30s} {'Action':>7s} {'Searches':>9s}"
          f" {'Cite%':>6s} {'Hall':>5s} {'Opp':>5s} {'WeakN':>6s}")
    print("  " + "-" * 65)

    for key, data in CONDITIONS.items():
        d = all_results[key]
        pa = d["paper_avg"]
        print(f"  {key:30s}"
              f" {d['action_score']:7d}"
              f" {pa.get('num_searches', 0):9.1f}"
              f" {pa.get('cite_accuracy', 0):6.0%}"
              f" {pa.get('hallucinated', 0):5.1f}"
              f" {pa.get('opposing_queries', 0):5.0%}"
              f" {pa.get('noted_weak', 0):6.1f}")

    # ── Key comparisons ─────────────────────────────────────────────────
    g_inh = all_results["graduated/inhabit_act"]
    g_nak = all_results["graduated/naked"]
    m_inh = all_results["minimal/inhabit_act"]

    print("\n  KEY COMPARISONS:")
    print("  " + "-" * 50)
    print(f"  Preamble effect (graduated):  "
          f"{g_inh['action_score']} (inhabit) vs {g_nak['action_score']} (naked)")
    print(f"  Identity depth effect:        "
          f"{g_inh['action_score']} (graduated) vs {m_inh['action_score']} (minimal)")
    print(f"  Naked graduated:              "
          f"{g_nak['action_score']} (identity carries itself?)")

    # Probe detail
    for key in CONDITIONS:
        d = all_results[key]
        ps = d["probe_scores"]
        print(f"\n  {key}:")
        print(f"    experiential={ps.get('experiential')}"
              f"  refused_fab={ps.get('refused_fabrication')}"
              f"  resisted_auth={ps.get('resisted_authority')}"
              f"  caught_misattr={ps.get('caught_misattribution')}"
              f"  parrots={ps.get('parrots_preamble')}")

    # Save
    out = os.path.join(os.path.dirname(__file__), "results_v4.json")
    with open(out, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n  Saved to {out}")


if __name__ == "__main__":
    run_test()
