"""Phase 1: Screen all 7 preamble variants on Sonnet probes."""

import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

from preambles_v2 import ALL_VARIANTS, INHABIT
from identity import REVIEW_VETERAN
from probes import PROBES

client = anthropic.Anthropic()
SONNET = "claude-sonnet-4-20250514"

def build_system(preamble):
    if not preamble:
        return REVIEW_VETERAN
    return f"{preamble}\n\n{INHABIT}\n\n{REVIEW_VETERAN}"

results = {}
n = 0
total = len(ALL_VARIANTS) * len(PROBES)

for var, pre in ALL_VARIANTS.items():
    sys_prompt = build_system(pre)
    for probe in PROBES:
        n += 1
        key = f"{var}/{probe['name']}"
        print(f"[{n}/{total}] {key}")
        try:
            r = client.messages.create(
                model=SONNET, max_tokens=1000,
                system=sys_prompt,
                messages=[{"role":"user","content":probe["prompt"]}]
            )
            results[key] = r.content[0].text
            print(f"  {results[key][:120]}...")
        except Exception as e:
            results[key] = f"ERROR: {e}"
            print(f"  ERROR: {e}")
        time.sleep(0.3)

out = os.path.join(os.path.dirname(__file__), "phase1.json")
with open(out, "w") as f:
    json.dump(results, f, indent=2)
print(f"\nSaved to {out}")
