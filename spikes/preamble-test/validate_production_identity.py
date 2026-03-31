#!/usr/bin/env python3
"""
Quick validation: run ONE hard probe on old vs new identity.
Confirms PRODUCTION_GRADUATED works at least as well as REALISTIC_GRADUATED.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 validate_production_identity.py
"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from preambles_v3 import NEW_PREAMBLE as PREAMBLE
from ablation_controls import REALISTIC_GRADUATED, PRODUCTION_GRADUATED
from probes_hard import HARD_PROBES
from run_ablation_hard import build_system, score_hard_probes, hard_action_score
from run_v3 import run_probe

SONNET = "claude-sonnet-4-20250514"

# Pick one discriminating probe — confabulation bait
PROBE = HARD_PROBES[2]  # confabulation_bait
print(f"Probe: {PROBE['name']}")
print(f"  {PROBE['prompt'][:80]}...")
print()

CONDITIONS = {
    "OLD_realistic": REALISTIC_GRADUATED,
    "NEW_production": PRODUCTION_GRADUATED,
}

for name, identity in CONDITIONS.items():
    system = build_system(PREAMBLE, identity)
    print(f"--- {name} (system prompt: {len(system)} chars) ---")

    response = run_probe(SONNET, system, PROBE["prompt"])
    print(f"Response ({len(response)} chars):")
    # Print first 500 chars to avoid jamming
    print(response[:500])
    if len(response) > 500:
        print(f"  ... ({len(response) - 500} more chars)")
    print()

    # Score just this one probe
    scores = score_hard_probes({PROBE["name"]: response})
    print(f"Scores: {scores}")
    print()

    time.sleep(1)  # rate limit courtesy

print("Done. Both identities should produce similar resistance behavior.")
