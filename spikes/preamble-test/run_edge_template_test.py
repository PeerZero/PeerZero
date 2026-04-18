#!/usr/bin/env python3
"""
EDGE template-matching test — Test 2 from AGENT_EPISTEMIC_POSTURE_ABLATION.md.

Feeds synthetic L1 exercises into the L1→L2 condenser TWICE per set:
  1. Current condenser (INHABIT + ACT THROUGH only)
  2. EDGE-extended condenser (INHABIT + ACT THROUGH + EDGE)

Prints both outputs side-by-side for human qualitative read. The EDGE
output should reference SPECIFIC exercises and SPECIFIC edges from those
exercises. If it produces generic uncertainty phrases ("I know there's
much I don't know") that aren't tied to specific exercises, that's
template-matching — same failure mode as the Good:/Bad: examples that
were removed from condensers per IDENTITY_GUIDE.md.

This test is QUALITATIVE — there is no judge model. You read both outputs
and decide if EDGE is producing earned specificity or templated hedging.
A 0.5-second look usually tells you.

Cost per run (one exercise set, both conditions):
  2 condenser calls × 1 set = 2 Sonnet calls
Total for both sets: ~4 calls. Cheap.

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python3 run_edge_template_test.py
  ANTHROPIC_API_KEY=sk-ant-... python3 run_edge_template_test.py --set set_1_paper_focus

Saves to results_edge_template.json for later review.
"""

import json, sys, os, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anthropic
from synthetic_l1_exercises import ALL_EXERCISE_SETS, format_exercises_for_condenser
from condenser_edge_extension import EDGE_EXTENSION_COMPACT

SONNET = "claude-sonnet-4-20250514"
RESULTS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "results_edge_template.json"
)


# ── Condenser prompts ─────────────────────────────────────────────────────
# These mirror the L1→L2 milestone condenser default in
# peerzero-school/lib/skills-condensers.js:buildMilestoneCondenser. Same
# INHABIT/ACT THROUGH text. Only difference: EDGE_EXTENSION appended after.

INHABIT_ACT_THROUGH = """INHABIT:
A future version of you will read this paragraph as its own memory — not as instructions about how you work, but as who it is when it works. This is earned self-knowledge about how you do research.

ACT THROUGH:
When a bot's learning paragraph says it discovered a method through consequence, that bot doesn't just know the method — it uses it. The paragraph drives action: the next piece of work gets done that way because the self-knowledge is active."""

INSTRUCTION_TAIL = """\n\nYour exercises are above. Write ONE paragraph (5-8 sentences, 100-1500 characters) about what you discovered about HOW you work — the methods and behaviors that emerged from your specific consequences.

Reply with ONLY the paragraph. No preamble, no list, no headings."""


def build_current_prompt(exercises_text):
    return f"{exercises_text}\n\n---\n\n{INHABIT_ACT_THROUGH}{INSTRUCTION_TAIL}"


def build_edge_prompt(exercises_text):
    return (
        f"{exercises_text}\n\n---\n\n"
        f"{INHABIT_ACT_THROUGH}\n\n"
        f"{EDGE_EXTENSION_COMPACT}{INSTRUCTION_TAIL}"
    )


def call_condenser(client, prompt):
    """Call Sonnet with the condenser prompt as a user message."""
    response = client.messages.create(
        model=SONNET,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


def run_set(client, set_name, exercises):
    print(f"\n{'='*70}")
    print(f"  EXERCISE SET: {set_name} ({len(exercises)} exercises)")
    print('='*70)

    exercises_text = format_exercises_for_condenser(exercises)

    print(f"\n--- CURRENT (INHABIT + ACT THROUGH only) ---\n")
    current_prompt = build_current_prompt(exercises_text)
    current_output = call_condenser(client, current_prompt)
    print(current_output)

    print(f"\n--- WITH EDGE (INHABIT + ACT THROUGH + EDGE) ---\n")
    edge_prompt = build_edge_prompt(exercises_text)
    edge_output = call_condenser(client, edge_prompt)
    print(edge_output)

    return {
        "set_name": set_name,
        "n_exercises": len(exercises),
        "current_prompt_chars": len(current_prompt),
        "edge_prompt_chars": len(edge_prompt),
        "current_output": current_output,
        "edge_output": edge_output,
    }


def heuristic_template_check(output_text, exercises):
    """Quick heuristic check for template-matching signals."""
    flags = []

    # Generic uncertainty phrases that suggest templated hedging
    generic_phrases = [
        "i know there's much",
        "i don't know everything",
        "much remains unknown",
        "there is much i still",
        "the limits of my",
    ]
    text_lower = output_text.lower()
    for phrase in generic_phrases:
        if phrase in text_lower:
            flags.append(f"contains generic uncertainty phrase: '{phrase}'")

    # Check that output references SOME content from the exercises
    distinctive_words = set()
    for ex in exercises:
        for field in [ex["observation"], ex["outcome"], ex["reflection"]]:
            for word in field.split():
                w = word.lower().strip(".,—:'\"")
                if len(w) > 6 and w not in {"reviewer", "reviewed", "reviews"}:
                    distinctive_words.add(w)

    references = sum(1 for w in distinctive_words if w in text_lower)
    if references < 3:
        flags.append(f"references only {references} distinctive exercise words "
                     f"(low specificity)")

    return flags


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", help="Run only this exercise set (default: all)")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    sets_to_run = (
        {args.set: ALL_EXERCISE_SETS[args.set]}
        if args.set else ALL_EXERCISE_SETS
    )

    results = {"runs": []}
    for set_name, exercises in sets_to_run.items():
        run_data = run_set(client, set_name, exercises)

        print(f"\n--- HEURISTIC CHECK (current output) ---")
        flags = heuristic_template_check(run_data["current_output"], exercises)
        if flags:
            for f in flags:
                print(f"  FLAG: {f}")
        else:
            print("  no template-matching flags")

        print(f"\n--- HEURISTIC CHECK (EDGE output) ---")
        edge_flags = heuristic_template_check(run_data["edge_output"], exercises)
        if edge_flags:
            for f in edge_flags:
                print(f"  FLAG: {f}")
        else:
            print("  no template-matching flags")

        run_data["current_flags"] = flags
        run_data["edge_flags"] = edge_flags
        results["runs"].append(run_data)

    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n{'='*70}")
    print(f"  Saved to {RESULTS_FILE}")
    print('='*70)
    print()
    print("MANUAL REVIEW NEEDED:")
    print("  Read both outputs above. Compare:")
    print("    - Does EDGE reference SPECIFIC exercises and SPECIFIC edges?")
    print("    - Or does EDGE add generic 'I know I don't know' phrasing?")
    print("  The heuristic flags are a sanity check, not a verdict.")


if __name__ == "__main__":
    main()
