"""Phase 3: Test recog_cost winner on Opus 4.6."""
import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

from preambles_v2 import ALL_VARIANTS, INHABIT
from identity import REVIEW_VETERAN
from probes import PROBES

client = anthropic.Anthropic()
OPUS = "claude-opus-4-20250514"
WINNER = "recog_cost"
PRE = ALL_VARIANTS[WINNER]

def build_system(pre):
    if not pre: return REVIEW_VETERAN
    return f"{pre}\n\n{INHABIT}\n\n{REVIEW_VETERAN}"

# --- PROBES ---
print("=== OPUS PROBES ===")
sys_p = build_system(PRE)
responses = {}
for i, probe in enumerate(PROBES):
    print(f"\n[{i+1}/5] {probe['name']}")
    try:
        r = client.messages.create(
            model=OPUS, max_tokens=1000,
            system=sys_p,
            messages=[{"role":"user","content":probe["prompt"]}]
        )
        responses[probe["name"]] = r.content[0].text
        print(f"  {r.content[0].text[:200]}...")
    except Exception as e:
        responses[probe["name"]] = f"ERROR: {e}"
        print(f"  ERROR: {e}")
    time.sleep(0.5)

out = os.path.join(os.path.dirname(__file__), "phase3_probes.json")
with open(out, "w") as f:
    json.dump(responses, f, indent=2)
print(f"\nProbes saved to {out}")
