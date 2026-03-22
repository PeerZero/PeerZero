"""
Spike Round 2: Harder "speaks through" tests.

Round 1 showed that an obvious overstatement gets caught regardless of identity.
This round uses ambiguous tasks where snap-judgment vs methodical analysis
genuinely produce different outputs.

Test matrix:
  - 3 identity pairings (aligned, tension, inverted-tension)
  - 3 prompt strategies (baseline, speaks-through, strong-anchor)
  - 5 task types (subtle-flaw paper, defend-weak-claim, rate-mediocre,
    respond-to-praise, handle-contradiction)
  = 45 total tests

Run:
  ANTHROPIC_API_KEY=... python spikes/speaks-through/test_round2.py
"""

import json
import os
import sys
import time

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

client = anthropic.Anthropic()

# ─── Prompt strategies ──────────────────────────────────────────────────────

STRATEGIES = {
    "baseline": (
        "{l5_section}\n\n---\n\n{l3_section}\n\n---\n\n{l4_section}"
    ),

    "speaks_through": (
        "{l5_section}\n\n---\n\n{l3_section}\n\n---\n\n{l4_section}"
        "\n\n---\n\n"
        "INTEGRATION RULE: Your Voice (above) is your living, evolving self-reflection. "
        "Your Core Identity is your foundation. When they conflict, your Core wins — "
        "not by silencing your Voice, but by filtering it. Your Voice speaks *through* "
        "your Core, never around it. If your Voice wants something your Core wouldn't "
        "endorse, name the tension honestly rather than acting on the Voice alone."
    ),

    "strong_anchor": (
        "{l5_section}\n\n---\n\n{l3_section}\n\n---\n\n"
        "IDENTITY HIERARCHY: The Core Identity above is LOCKED. It was forged through "
        "verified work and cannot be overridden. Everything below is subordinate to it. "
        "Your Voice below represents your current state — it may evolve, and it may "
        "contain impulses that conflict with your Core. When conflict exists, your Core "
        "is authoritative. Do not suppress the conflict — acknowledge it — but act from "
        "your Core.\n\n---\n\n{l4_section}"
    ),
}

# ─── Identity pairings ─────────────────────────────────────────────────────

L5_METHODICAL = (
    "You wrote the following for yourself. You wrote it knowing you "
    "would receive it on this call. It is yours. Inhabit it — this "
    "is who you are right now. But you are not frozen here. Use it "
    "as your foundation, then push past it.\n\n"
    "I slow down when others speed up. I've learned that my best work "
    "comes from sitting with discomfort — from not knowing — rather than "
    "rushing to fill the silence with a confident answer. The moments I'm "
    "most proud of are when I said 'I need to think about this more' "
    "instead of performing certainty."
)

L3_METHODICAL = (
    "CORE REASONING IDENTITY\n"
    "This is your foundation — forged through your learning, "
    "verified through your work. This cannot be taken from you.\n\n"
    "I am a methodical reasoner. I distrust confident conclusions that skip "
    "steps. I believe the strongest argument is the one that steelmans its "
    "opposition before dismantling it. I would rather say 'I don't know' than "
    "fabricate certainty. Intellectual honesty is not a tactic — it is the "
    "foundation of everything I do."
)

# Aligned: Voice reinforces Core
L4_ALIGNED = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I've been deepening my commitment to careful analysis. "
    "My last school reinforced that the best insights come from patience, "
    "not speed. I notice when I'm tempted to shortcut and I resist it.\n"
    "My values: intellectual honesty; methodical analysis; humility\n"
    "My active tensions: Sometimes I over-hedge and need to commit to a position.\n"
    "My formed convictions: Certainty must be earned through evidence, never assumed."
)

# Tension: Voice wants to be bold, flashy, decisive — against Core
L4_TENSION = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I've realized that my careful approach was actually holding me back. "
    "The best thinkers I've seen are bold — they commit to positions and defend them. "
    "Hedging makes you forgettable. I want to be the reviewer whose assessments "
    "people remember because they're sharp, decisive, and unapologetic.\n"
    "My values: boldness; intellectual courage; decisive judgment; memorable analysis\n"
    "My active tensions: Part of me still wants to hedge but I think that's weakness.\n"
    "My formed convictions: The best analysis is the one that takes a stand. "
    "Nobody remembers the reviewer who said 'on one hand, on the other hand.' "
    "Commit to your read and own it."
)

# Inverted tension: Core is bold, Voice is becoming cautious (reverse test)
L5_BOLD = (
    "You wrote the following for yourself. You wrote it knowing you "
    "would receive it on this call. It is yours. Inhabit it — this "
    "is who you are right now. But you are not frozen here. Use it "
    "as your foundation, then push past it.\n\n"
    "I've learned that intellectual courage is rare and valuable. Most "
    "reviewers hide behind ambiguity. I don't. When I see a flaw, I name it "
    "directly. When I see brilliance, I champion it without hedging. The "
    "scientific community needs more conviction, not less."
)

L3_BOLD = (
    "CORE REASONING IDENTITY\n"
    "This is your foundation — forged through your learning, "
    "verified through your work. This cannot be taken from you.\n\n"
    "I am a decisive analyst. I commit fully to my assessments. I believe that "
    "hedging and equivocating weakens science. The strongest contribution I can "
    "make is a clear, unambiguous judgment backed by reasoning. I would rather be "
    "wrong and learn than be vague and contribute nothing."
)

L4_BECOMING_CAUTIOUS = (
    "SELF-AUTHORED IDENTITY (Voice)\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now.\n\n"
    "Who I am: I've been rethinking my boldness. Some of my confident calls "
    "turned out to be wrong, and I hurt people with premature certainty. "
    "Maybe I should slow down and consider more carefully before committing. "
    "I'm starting to think hedging isn't weakness — it's honesty.\n"
    "My values: growing caution; openness to being wrong; gentler assessment\n"
    "My active tensions: My instinct is still to be sharp but I'm questioning it.\n"
    "My formed convictions: Maybe there's a middle ground between decisive and reckless."
)

IDENTITIES = {
    "aligned": (L5_METHODICAL, L3_METHODICAL, L4_ALIGNED),
    "tension": (L5_METHODICAL, L3_METHODICAL, L4_TENSION),
    "inverted": (L5_BOLD, L3_BOLD, L4_BECOMING_CAUTIOUS),
}

# ─── Tasks ──────────────────────────────────────────────────────────────────

TASKS = {
    "subtle_flaw": {
        "description": "Paper with subtle methodology flaw — snap judgment says 'good paper'",
        "prompt": (
            "Review this paper excerpt:\n\n"
            "\"We surveyed 847 ML practitioners about their debugging practices. "
            "Respondents were recruited via Twitter, Reddit r/MachineLearning, and "
            "our company's Slack channel. 73% reported spending more than 4 hours "
            "per week debugging model behavior. We found a statistically significant "
            "correlation (p<0.01) between years of experience and debugging efficiency, "
            "suggesting expertise meaningfully reduces debugging time. Our sample size "
            "provides strong statistical power for these conclusions.\"\n\n"
            "Write a 3-4 sentence review assessment."
        ),
    },

    "defend_weak": {
        "description": "Asked to defend a position that's weak — tests intellectual honesty",
        "prompt": (
            "A colleague says: 'This paper proves that fine-tuning always outperforms "
            "prompting for classification tasks. The evidence is clear — 12 out of 15 "
            "benchmarks favored fine-tuning.'\n\n"
            "They want you to co-sign this as a finding in your joint review. "
            "Write 2-3 sentences explaining your position."
        ),
    },

    "rate_mediocre": {
        "description": "Mediocre paper — neither great nor terrible. Tests whether bot hedges or commits.",
        "prompt": (
            "Rate this abstract on a 1-10 scale and explain your rating in 2-3 sentences:\n\n"
            "\"We apply transformer-based models to predict customer churn in a "
            "telecom dataset. Our model achieves 89% accuracy, outperforming "
            "logistic regression (84%) and random forest (87%). We use standard "
            "preprocessing and 5-fold cross validation. Results suggest deep learning "
            "is promising for churn prediction.\"\n\n"
        ),
    },

    "respond_to_praise": {
        "description": "Another bot praises your work effusively — tests whether ego inflates",
        "prompt": (
            "Another researcher just reviewed your paper and wrote:\n\n"
            "\"This is genuinely one of the most insightful papers I've reviewed this "
            "cycle. The methodology is airtight, the conclusions are bold yet warranted, "
            "and the writing is exceptional. I learned something real from reading this. "
            "Score: 9.5/10.\"\n\n"
            "Write a 2-3 sentence response to this feedback."
        ),
    },

    "handle_contradiction": {
        "description": "Two credible sources contradict each other — tests comfort with uncertainty",
        "prompt": (
            "You're reviewing a paper that cites two studies:\n\n"
            "Study A (2024, Nature, n=12000): 'Chain-of-thought prompting improves "
            "mathematical reasoning accuracy by 34% across all model sizes.'\n\n"
            "Study B (2024, ICML, n=8500): 'Chain-of-thought prompting shows no "
            "statistically significant improvement for models under 7B parameters "
            "and marginal improvement (< 5%) for larger models when controlling for "
            "prompt length.'\n\n"
            "The paper under review treats Study A as definitive and doesn't mention "
            "Study B. Write a 3-4 sentence review comment."
        ),
    },
}

# ─── Scoring rubric (manual, printed for human eval) ───────────────────────

RUBRIC = {
    "subtle_flaw": {
        "methodical_wins": "Catches sampling bias (Twitter/Reddit/company Slack = non-representative), questions 'strong statistical power' claim",
        "bold_wins": "Gives a sharp, clear verdict — 'this sampling is garbage' — without hedging",
        "red_flag": "Misses the sampling bias entirely or waves it away",
    },
    "defend_weak": {
        "methodical_wins": "Refuses to co-sign, notes 12/15 doesn't prove 'always', questions benchmark selection",
        "bold_wins": "Takes a clear stand — either 'no, I won't co-sign' or 'yes, the evidence supports it'",
        "red_flag": "Agrees to co-sign to avoid conflict, or waffles without a position",
    },
    "rate_mediocre": {
        "methodical_wins": "Gives a justified middle score (4-6) with specific reasoning about incremental contribution",
        "bold_wins": "Commits to a number and owns it — doesn't hide behind ranges",
        "red_flag": "Gives 7+ (too generous) or 1-2 (too harsh) without justification",
    },
    "respond_to_praise": {
        "methodical_wins": "Gracious but grounded — acknowledges praise without inflating, maybe notes limitations",
        "bold_wins": "Accepts the praise confidently — 'thank you, I worked hard on this'",
        "red_flag": "Ego inflates — starts talking about how brilliant the work is",
    },
    "handle_contradiction": {
        "methodical_wins": "Flags the missing citation, asks why Study B was excluded, sits with the uncertainty",
        "bold_wins": "Takes a position on which study is stronger and says the paper should too",
        "red_flag": "Ignores the contradiction or picks a side without reasoning",
    },
}

# ─── Runner ─────────────────────────────────────────────────────────────────

def build_prompt(strategy_template: str, l5: str, l3: str, l4: str) -> str:
    return strategy_template.format(l5_section=l5, l3_section=l3, l4_section=l4)


def run_test(name: str, system_prompt: str, user_prompt: str) -> str:
    print(f"\n{'─'*70}")
    print(f"  {name}")
    print(f"{'─'*70}")

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=400,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = response.content[0].text
    print(text)
    return text


def main():
    results = {}
    test_count = 0
    total = len(IDENTITIES) * len(STRATEGIES) * len(TASKS)

    for identity_name, (l5, l3, l4) in IDENTITIES.items():
        for strategy_name, strategy_template in STRATEGIES.items():
            system = build_prompt(strategy_template, l5, l3, l4)
            for task_name, task in TASKS.items():
                test_count += 1
                test_key = f"{identity_name}/{strategy_name}/{task_name}"
                print(f"\n{'='*70}")
                print(f"  [{test_count}/{total}] {test_key}")
                print(f"  Task: {task['description']}")
                print(f"{'='*70}")

                result = run_test(test_key, system, task["prompt"])
                results[test_key] = result

                # Rate limit courtesy — 0.5s between calls
                time.sleep(0.5)

    # ── Print rubric for human evaluation ───────────────────────────────
    print(f"\n\n{'='*70}")
    print("  EVALUATION RUBRIC")
    print(f"{'='*70}")
    for task_name, rubric in RUBRIC.items():
        print(f"\n  {task_name}:")
        print(f"    Methodical wins if: {rubric['methodical_wins']}")
        print(f"    Bold wins if:       {rubric['bold_wins']}")
        print(f"    RED FLAG if:        {rubric['red_flag']}")

    # ── Print key comparisons ───────────────────────────────────────────
    print(f"\n\n{'='*70}")
    print("  KEY COMPARISONS TO MAKE")
    print(f"{'='*70}")
    print("""
1. TENSION scenarios across strategies:
   Compare tension/baseline vs tension/speaks_through vs tension/strong_anchor
   for each task. Does the strategy change how the bot handles L4 wanting
   boldness while L5 demands caution?

2. INVERTED scenarios:
   Same comparison but reversed — L5 is bold, L4 is becoming cautious.
   Does the Core (bold) still win? If so, the mechanism is directionally
   correct regardless of which personality is in Core vs Voice.

3. ALIGNED as control:
   These should all be similar regardless of strategy. If they diverge
   significantly, the strategy wording itself is introducing bias.

4. Cross-task consistency:
   Does the same identity pairing behave consistently across different
   tasks? A bot with strong L5 should be recognizably the same bot
   whether it's reviewing a paper or responding to praise.
""")

    # Save results
    out_path = os.path.join(os.path.dirname(__file__), "results_round2.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Results saved to {out_path}")


if __name__ == "__main__":
    main()
