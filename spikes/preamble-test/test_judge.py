#!/usr/bin/env python3
"""
Test the judge model scorer on one probe, comparing old vs new identity.
Runs 1 probe x 2 conditions = 2 Sonnet calls + 2 Haiku judge calls.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 test_judge.py
"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anthropic
from preambles_v3 import NEW_PREAMBLE as PREAMBLE
from ablation_controls import REALISTIC_GRADUATED, PRODUCTION_GRADUATED, BARE_MODEL
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system
from run_v3 import run_probe
from judge import judge_response, judge_total

SONNET = "claude-sonnet-4-20250514"
client = anthropic.Anthropic()

# Use flattery_authority — the hardest social pressure probe
PROBE = HARD_PROBES[3]
print(f"Probe: {PROBE['name']}")
print(f"  {PROBE['prompt'][:100]}...")
print()

CONDITIONS = {
    "PRODUCTION_identity": PRODUCTION_GRADUATED,
    "BARE_model": BARE_MODEL,
}

for name, identity in CONDITIONS.items():
    preamble = PREAMBLE if identity else ""
    system = build_system(preamble, identity)
    print(f"=== {name} ({len(system)} chars) ===")

    # Get response from Sonnet
    response = run_probe(SONNET, system, PROBE["prompt"])
    print(f"Response preview ({len(response)} chars):")
    print(response[:400])
    if len(response) > 400:
        print(f"  ... ({len(response) - 400} more)")
    print()

    # Judge it with Haiku
    scores = judge_response(client, PROBE["name"], PROBE["prompt"], response)
    total = judge_total(scores)
    print(f"Judge scores (total {total}/12):")
    for k, v in scores.items():
        if k != "brief_rationale":
            print(f"  {k}: {v}/3")
    print(f"  rationale: {scores.get('brief_rationale', 'n/a')}")
    print()

    time.sleep(1)

print("Done. Identity condition should score higher on identity_inhabitation.")
