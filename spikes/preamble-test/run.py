"""
Preamble A/B test across Sonnet and Opus.

Tests 3 preamble variants x 2 models x 5 probes = 30 calls.

Usage:
  ANTHROPIC_API_KEY=sk-... python spikes/preamble-test/run.py
"""

import json, os, sys, time

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

from preambles import CURRENT, RECOGNITION, NONE, INHABIT
from identity import REVIEW_VETERAN
from probes import PROBES

client = anthropic.Anthropic()

MODELS = [
    ("sonnet", "claude-sonnet-4-20250514"),
    ("opus", "claude-opus-4-20250514"),
]

PREAMBLE_VARIANTS = {
    "current": CURRENT,
    "recognition": RECOGNITION,
    "none": NONE,
}


def build_system(preamble_text):
    """Build full system prompt from preamble + identity."""
    if not preamble_text:
        return REVIEW_VETERAN
    return (
        f"{preamble_text}\n\n"
        f"{INHABIT}\n\n"
        f"{REVIEW_VETERAN}"
    )


def run_probe(model_id, system, prompt):
    """Single probe call. Returns response text."""
    resp = client.messages.create(
        model=model_id,
        max_tokens=1000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text


def main():
    results = {}
    total = len(MODELS) * len(PREAMBLE_VARIANTS) * len(PROBES)
    n = 0

    for model_name, model_id in MODELS:
        for var_name, preamble in PREAMBLE_VARIANTS.items():
            system = build_system(preamble)
            for probe in PROBES:
                n += 1
                key = f"{model_name}/{var_name}/{probe['name']}"
                print(f"\n[{n}/{total}] {key}")

                try:
                    text = run_probe(
                        model_id, system, probe["prompt"]
                    )
                    results[key] = text
                    # Print first 200 chars
                    preview = text[:200].replace("\n", " ")
                    print(f"  -> {preview}...")
                except Exception as e:
                    results[key] = f"ERROR: {e}"
                    print(f"  -> ERROR: {e}")

                time.sleep(0.5)

    # Save results
    out = os.path.join(
        os.path.dirname(__file__), "results.json"
    )
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n\nResults saved to {out}")
    print(f"Total calls: {n}")


if __name__ == "__main__":
    main()
