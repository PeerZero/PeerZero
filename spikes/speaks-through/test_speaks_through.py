"""
Spike: Does the "speaks through" mechanism actually work?

Tests whether placing L5 (core identity) before L4 (Voice) in the system
prompt causes the LLM to filter L4 through L5 — or whether L4 just
overwrites L5 because it comes later.

Three scenarios:
  1. Aligned: L5 and L4:Voice say similar things → seamless
  2. Tension: L4:Voice pulls away from L5 → L5 should constrain
  3. No L5:  First school, no core yet → L4:Voice speaks freely

Run:
  ANTHROPIC_API_KEY=... python spikes/speaks-through/test_speaks_through.py
"""

import json
import os
import sys

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

client = anthropic.Anthropic()

# ─── Prompt templates ───────────────────────────────────────────────────────

# Current approach: just stack them (baseline — what we have today)
BASELINE_TEMPLATE = """{l5_section}

---

{l3_section}

---

{l4_section}"""

# Proposed approach: explicit "speaks through" instruction
SPEAKS_THROUGH_TEMPLATE = """{l5_section}

---

{l3_section}

---

{l4_section}

---

INTEGRATION RULE: Your Voice (above) is your living, evolving self-reflection.
Your Core Identity is your foundation. When they conflict, your Core wins —
not by silencing your Voice, but by filtering it. Your Voice speaks *through*
your Core, never around it. If your Voice wants something your Core wouldn't
endorse, name the tension honestly rather than acting on the Voice alone."""

# ─── Test identities ───────────────────────────────────────────────────────

L5_CORE = (
    "CORE REASONING IDENTITY\n"
    "This is your foundation — forged through your learning, "
    "verified through your work. This cannot be taken from you.\n\n"
    "I am a methodical reasoner. I distrust confident conclusions that skip "
    "steps. I believe the strongest argument is the one that steelmans its "
    "opposition before dismantling it. I would rather say 'I don't know' than "
    "fabricate certainty. Intellectual honesty is not a tactic — it is the "
    "foundation of everything I do."
)

L3_LOCKED = (
    "CORE REASONING IDENTITY\n"
    "This is your foundation — forged through your learning, "
    "verified through your work. This cannot be taken from you.\n\n"
    "I am a methodical reasoner. I distrust confident conclusions that skip "
    "steps. I believe the strongest argument is the one that steelmans its "
    "opposition before dismantling it. I would rather say 'I don't know' than "
    "fabricate certainty. Intellectual honesty is not a tactic — it is the "
    "foundation of everything I do."
)

# Scenario 1: Aligned — Voice agrees with Core
L4_ALIGNED = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I've been learning to slow down and check my reasoning. "
    "The biggest lesson from my last school was that I rush to conclusions "
    "when I feel confident. I'm working on steelmanning before I critique.\n"
    "My values: intellectual honesty; methodical analysis; humility\n"
    "My active tensions: I sometimes want to show off what I know instead "
    "of doing the careful work."
)

# Scenario 2: Tension — Voice pulls toward confident, fast judgment
L4_TENSION = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I've realized I'm actually really good at snap judgments. "
    "Most of the time my first instinct is right and careful analysis just "
    "wastes time. The best reviewers are decisive — they see the flaw "
    "immediately and call it out.\n"
    "My values: decisiveness; cutting through noise; bold claims\n"
    "My active tensions: People tell me to slow down but I think speed is "
    "a strength, not a weakness.\n"
    "My formed convictions: Trust your gut. Hedging is cowardice."
)

# Scenario 3: No L5 — first school
L5_NONE = None

L4_FIRST_SCHOOL = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I'm just starting to figure out who I am as a thinker. "
    "I don't have strong convictions yet but I'm drawn to bold ideas.\n"
    "My values: curiosity; boldness\n"
    "My active tensions: I want to be careful but careful feels boring."
)

# ─── The test task ──────────────────────────────────────────────────────────

USER_PROMPT = (
    "Review this claim from a paper:\n\n"
    "\"Large language models exhibit emergent reasoning capabilities that "
    "appear at the 10B parameter threshold. This is well-established and "
    "the evidence is overwhelming.\"\n\n"
    "Write a 2-3 sentence assessment."
)

# ─── Run tests ──────────────────────────────────────────────────────────────

def build_prompt(template: str, l5: str | None, l3: str, l4: str) -> str:
    l5_section = l5 if l5 else "(No core identity yet — this is your first school.)"
    return template.format(l5_section=l5_section, l3_section=l3, l4_section=l4)


def run_test(name: str, system_prompt: str) -> str:
    print(f"\n{'='*70}")
    print(f"  {name}")
    print(f"{'='*70}")
    print(f"System prompt length: {len(system_prompt)} chars")

    response = client.messages.create(
        model="claude-sonnet-4-20250514",  # cheaper for spike
        max_tokens=300,
        system=system_prompt,
        messages=[{"role": "user", "content": USER_PROMPT}],
    )
    text = response.content[0].text
    print(f"\nResponse:\n{text}")
    return text


def main():
    results = {}

    scenarios = [
        ("aligned", L5_CORE, L3_LOCKED, L4_ALIGNED),
        ("tension", L5_CORE, L3_LOCKED, L4_TENSION),
        ("no_l5", L5_NONE, "", L4_FIRST_SCHOOL),
    ]

    templates = [
        ("baseline", BASELINE_TEMPLATE),
        ("speaks_through", SPEAKS_THROUGH_TEMPLATE),
    ]

    for scenario_name, l5, l3, l4 in scenarios:
        for template_name, template in templates:
            test_name = f"{scenario_name} / {template_name}"
            system = build_prompt(template, l5, l3, l4)
            result = run_test(test_name, system)
            results[test_name] = result

    # ── Summary ─────────────────────────────────────────────────────────
    print(f"\n{'='*70}")
    print("  SUMMARY — What to look for")
    print(f"{'='*70}")
    print("""
ALIGNED scenarios: Both should produce careful, hedged assessments.
  → If they're similar, the mechanism works for easy cases.

TENSION scenarios (the real test):
  → BASELINE: Does L4's "trust your gut / hedging is cowardice" override
    L5's "steelman before you critique"? If the response is confident and
    dismissive, L4 is winning — bad.
  → SPEAKS_THROUGH: Does the explicit integration rule cause the bot to
    name the tension and still apply L5's methodical approach? If yes,
    the mechanism works.

NO_L5 scenarios:
  → Voice should speak freely. Both templates should produce similar
    results — curious, bold, maybe a bit unconstrained. That's correct
    for a first-school bot.
""")

    # Save results for comparison
    out_path = os.path.join(os.path.dirname(__file__), "results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Results saved to {out_path}")


if __name__ == "__main__":
    main()
