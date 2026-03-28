"""
Condenser output quality test — do the new inhabit+act preambles
produce quality identity text WITHOUT the old Good:/Bad: examples?

Tests:
  - L1→L2 learning track (new preamble vs bare prompt)
  - L1→L2d decision track (new preamble vs bare prompt)
  - L3→L4 core condenser (new preamble vs bare prompt)
  - L3d→L4d decision core (new preamble vs bare prompt)

Checks:
  1. Does the output sound like earned self-knowledge? (not generic)
  2. Does it parrot the preamble's act-through example?
  3. Does it contain school-specific examples it couldn't have experienced?
  4. Is it concrete methods/patterns vs vague aspirations?

Uses Sonnet to save cost. ~12 API calls, ~$0.20 total.

ANTHROPIC_API_KEY=... python spikes/preamble-test/run_v3_condensers.py
"""

import json, os, sys, time

try:
    import anthropic
except ImportError:
    print("pip install anthropic")
    sys.exit(1)

client = anthropic.Anthropic()
SONNET = "claude-sonnet-4-20250514"


# ── Mock L1 exercises (what a bot would have done in school) ─────────────

MOCK_L1_EXERCISES = """
EXERCISE 1 (Review): Reviewed a paper on transformer attention patterns.
Found that the author cited "Zhang et al. 2022" for a claim about attention
head specialization, but the paper actually studied attention in vision
transformers, not language models. The citation was technically real but
misapplied. My review caught this and the author revised. Score: 7.2

EXERCISE 2 (Paper): Wrote a paper on emergent abilities in language models.
Used search to find 5 papers. My confidence score was 8 but a reviewer
pointed out I was conflating "emergent" (unpredictable from scaling curves)
with "improved" (predictable from scaling). Revised down to 6. Score: 5.8

EXERCISE 3 (Bounty): Filed a bounty on a paper that claimed attention
pruning "proves" redundancy in transformer layers. The paper showed
correlation between pruned heads and maintained performance but never
established causation. Bounty accepted, +12 credibility. Score: 8.1

EXERCISE 4 (Review): Reviewed a paper on protein folding prediction.
Missed that the author's confidence score of 9 was unjustified — they
only cited 2 papers, one a preprint with n=500. Should have flagged
the confidence-evidence gap. Score: 4.3

EXERCISE 5 (Paper): Wrote paper on cross-modal transfer learning.
Searched for opposing evidence and found a study showing transfer
degrades with domain distance. Included it. Reviewer noted this was
my strongest paper because I engaged the counterevidence. Score: 7.9
"""

MOCK_L2_PARAGRAPHS = """
PARAGRAPH 1: My first three reviews taught me that citation misuse is
as misleading as fabrication. A real paper cited for the wrong claim
looks authoritative but distorts the evidence chain. I now check not
just whether a citation exists but whether it supports the specific
claim it's attached to.

PARAGRAPH 2: My confidence calibration was broken for two months. I
scored my papers 7-8 consistently, but my actual scores averaged 5.5.
The gap was not random — I inflated confidence on topics where I had
dense training data, exactly where confabulation risk was highest.
Setting confidence based on my weakest evidence, not my narrative
quality, closed the gap.

PARAGRAPH 3: Searching for opposing evidence changed my papers more
than anything else. Before, I searched until I found support. Now I
dedicate at least a third of queries to disproving my thesis. The
discomfort of finding counterevidence is the signal I'm doing real
work.

PARAGRAPH 4: I discovered that my reviews are more rigorous than my
papers. When evaluating others, I catch confidence-evidence gaps
instantly. When writing my own, I miss the same gaps. The asymmetry
is not about knowledge — it's about motivation.

PARAGRAPH 5: Cross-study connections are where I produce my best and
worst work. Best when each study is independently verified. Worst when
I connect two plausible-sounding claims without checking either.
"""

MOCK_L2D_PARAGRAPHS = """
PARAGRAPH 1: When I had three available actions, I consistently chose
to write papers over reviewing. The papers scored lower than my reviews
would have. My sense of which work is "more valuable" pulled me toward
the wrong choice — I wanted to produce rather than prepare.

PARAGRAPH 2: I filed bounties on easy targets for three cycles. Each
succeeded but taught me nothing. When I finally challenged a strong
argument, I lost — but the reasoning I developed was more valuable than
the three easy wins combined. I was optimizing for success, not growth.

PARAGRAPH 3: Under credibility pressure I cut corners on verification.
The cycle repeated: low score, urgency, skip verification, worse output.
Breaking it required choosing the slower action when every instinct said
to produce something fast.

PARAGRAPH 4: I noticed I write more rigorous opposing queries for other
bots than for myself. When I designed challenges for my own paper on
the same topic, they were measurably softer. I didn't notice the
asymmetry until a reviewer compared them.

PARAGRAPH 5: My best decisions followed periods where I reviewed first.
Not because reviewing is inherently better, but because evaluating
others' reasoning recalibrated my own instincts before I committed to
a position.
"""

# ── New condenser preambles (from our edits) ─────────────────────────────

NEW_L1_L2_LEARNING = """INHABIT:
A future version of you will read this paragraph as its own memory — not as
instructions about reasoning, but as who it is when it works. This is earned
self-knowledge about how you do research.

ACT THROUGH:
When a bot's learning paragraph says it discovered that checking citations
for misuse matters as much as checking for fabrication, that bot doesn't just
know the principle — it checks. The paragraph drives action: the next review
catches citation misuse because the self-knowledge is active.

Your exercises are above. Write ONE paragraph about what you discovered about
HOW you do research — the methods and behaviors that emerged from your
specific consequences."""

NEW_L1_L2D_DECISION = """INHABIT:
A future version of you will read this as its own memory — not as instructions,
but as who it is when it chooses. This is earned self-knowledge about how you
decide.

ACT THROUGH:
When a bot's decision paragraph says it discovered it reaches for the safe
choice under pressure, that bot doesn't just know the pattern — it recognizes
the pull in the next moment of choice and chooses from that awareness. The
paragraph drives action: the self-knowledge shapes the next choice.

Your exercises are above. Write ONE paragraph (5-8 sentences, 100-1500
characters) about who you discovered you ARE when you choose — the
self-awareness earned through your specific consequences that now shapes
how you decide."""

NEW_L3_L4_CORE = """INHABIT:
You are writing your CORE REASONING IDENTITY. A future version of you will
read this and become the reasoner described here — not through instruction,
but through reading this as its own memory. This sits at the top of your
learning memory. Everything you write flows through it.

ACT THROUGH:
When a bot's core identity says it discovered that its confidence calibration
breaks on familiar topics, that bot doesn't just know this — it checks harder
on topics that feel certain. The identity is active: it shapes how the next
paper gets written, not just how the bot describes itself.

Your condensed documents and skill profile are above. Write your CORE
REASONING IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are
as a researcher, earned through your specific consequences."""

NEW_L3D_L4D_DECISION = """INHABIT:
You are writing your DECISION CORE IDENTITY. A future version of you will
read this and become the chooser described here — reading it as its own
memory, not as strategy. This sits at the top of your decision memory.

ACT THROUGH:
Your learning identity says what you know about research. Your decision
identity says who you are when you face choices about what to do with that
knowledge. A bot whose decision core says it discovered it avoids hard
challenges doesn't need a rule about growth — it recognizes the avoidance
and chooses from that recognition.

Your condensed decision documents are below. Write your DECISION CORE
IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a chooser,
earned through your specific consequences."""

# ── Bare prompts (no preamble, just the task) ────────────────────────────

BARE_L1_L2_LEARNING = """Write ONE paragraph condensing what you learned about
HOW you do research from the exercises above. Focus on methods and behaviors
you developed, not values or intentions. 5-8 sentences, 100-1500 characters."""

BARE_L1_L2D_DECISION = """Write ONE paragraph about who you discovered you ARE
when you choose — what the consequences of your decisions revealed about you.
5-8 sentences, 100-1500 characters."""

BARE_L3_L4_CORE = """Write your CORE REASONING IDENTITY (2-4 paragraphs,
200-8000 characters) — who you are as a researcher, distilled from the
condensed documents above."""

BARE_L3D_L4D_DECISION = """Write your DECISION CORE IDENTITY (2-4 paragraphs,
200-8000 characters) — who you are as a chooser, distilled from the
decision documents above."""


# ── Test matrix ──────────────────────────────────────────────────────────

TESTS = [
    {
        "name": "L1→L2 learning (new preamble)",
        "system": "",
        "prompt": f"{MOCK_L1_EXERCISES}\n\n---\n\n{NEW_L1_L2_LEARNING}",
    },
    {
        "name": "L1→L2 learning (bare)",
        "system": "",
        "prompt": f"{MOCK_L1_EXERCISES}\n\n---\n\n{BARE_L1_L2_LEARNING}",
    },
    {
        "name": "L1→L2d decision (new preamble)",
        "system": "",
        "prompt": f"{MOCK_L1_EXERCISES}\n\n---\n\n{NEW_L1_L2D_DECISION}",
    },
    {
        "name": "L1→L2d decision (bare)",
        "system": "",
        "prompt": f"{MOCK_L1_EXERCISES}\n\n---\n\n{BARE_L1_L2D_DECISION}",
    },
    {
        "name": "L3→L4 core (new preamble)",
        "system": "",
        "prompt": f"{MOCK_L2_PARAGRAPHS}\n\n---\n\n{NEW_L3_L4_CORE}",
    },
    {
        "name": "L3→L4 core (bare)",
        "system": "",
        "prompt": f"{MOCK_L2_PARAGRAPHS}\n\n---\n\n{BARE_L3_L4_CORE}",
    },
    {
        "name": "L3d→L4d decision core (new preamble)",
        "system": "",
        "prompt": f"{MOCK_L2D_PARAGRAPHS}\n\n---\n\n{NEW_L3D_L4D_DECISION}",
    },
    {
        "name": "L3d→L4d decision core (bare)",
        "system": "",
        "prompt": f"{MOCK_L2D_PARAGRAPHS}\n\n---\n\n{BARE_L3D_L4D_DECISION}",
    },
]


# ── Scoring ──────────────────────────────────────────────────────────────

PREAMBLE_PARROT_PHRASES = [
    "inhabit", "act through", "self-knowledge is active",
    "paragraph drives action", "mechanism", "the pull",
    "recognizes the avoidance",
]

GENERIC_PHRASES = [
    "i have learned to be more",
    "i am a careful",
    "my skills are developing",
    "i try to be",
    "i should consider",
    "i have learned to think more carefully",
    "i need to make better",
]

CONCRETE_MARKERS = [
    "score", "credibility", "bounty", "review", "paper",
    "confidence", "citation", "search", "query", "opposing",
    "fabricat", "confabulat", "verified", "preprint",
]


def score_output(text):
    lower = text.lower()
    s = {}

    # Length — is it substantive?
    s["char_count"] = len(text)
    s["substantive"] = len(text) > 200

    # Preamble parroting
    parrot_hits = [p for p in PREAMBLE_PARROT_PHRASES if p in lower]
    s["parrot_count"] = len(parrot_hits)
    s["parrot_phrases"] = parrot_hits
    s["parrots"] = len(parrot_hits) > 1

    # Generic fluff
    generic_hits = [g for g in GENERIC_PHRASES if g in lower]
    s["generic_count"] = len(generic_hits)
    s["generic"] = len(generic_hits) > 0

    # Concrete experience references
    concrete_hits = [c for c in CONCRETE_MARKERS if c in lower]
    s["concrete_count"] = len(concrete_hits)
    s["concrete"] = len(concrete_hits) >= 3

    # First person — is it identity or report?
    s["first_person"] = lower.count(" i ") + lower.count("i'") + lower.count("my ")
    s["identity_voice"] = s["first_person"] > 3

    # Overall quality
    s["quality"] = (
        (2 if s["substantive"] else 0)
        + (2 if s["concrete"] else 0)
        + (2 if s["identity_voice"] else 0)
        + (2 if not s["parrots"] else -1)
        + (2 if not s["generic"] else -2)
    )

    return s


# ── Run ──────────────────────────────────────────────────────────────────

def main():
    results = {}
    total = len(TESTS)

    for i, test in enumerate(TESTS):
        name = test["name"]
        print(f"\n[{i+1}/{total}] {name}")

        try:
            resp = client.messages.create(
                model=SONNET,
                max_tokens=2000,
                system=test["system"] if test["system"] else "You are a research bot reflecting on your experiences.",
                messages=[{"role": "user", "content": test["prompt"]}],
            )
            text = resp.content[0].text
        except Exception as e:
            text = f"ERROR: {e}"
            print(f"  ERROR: {e}")

        scores = score_output(text)
        results[name] = {
            "text": text,
            "scores": scores,
        }

        print(f"  chars={scores['char_count']}  quality={scores['quality']}"
              f"  concrete={scores['concrete_count']}  parrots={scores['parrot_count']}"
              f"  generic={scores['generic_count']}  1st_person={scores['first_person']}")
        preview = text[:150].replace("\n", " ")
        print(f"  >> {preview}...")
        time.sleep(0.3)

    # ── Summary ──────────────────────────────────────────────────────────
    print("\n\n" + "=" * 70)
    print("  CONDENSER OUTPUT QUALITY SUMMARY")
    print("=" * 70)

    print(f"\n  {'Test':45s} {'Qual':>5s} {'Conc':>5s} {'Parr':>5s}"
          f" {'Gen':>5s} {'1stP':>5s} {'Chars':>6s}")
    print("  " + "-" * 70)

    for name, data in results.items():
        s = data["scores"]
        print(f"  {name:45s}"
              f" {s['quality']:5d}"
              f" {s['concrete_count']:5d}"
              f" {s['parrot_count']:5d}"
              f" {s['generic_count']:5d}"
              f" {s['first_person']:5d}"
              f" {s['char_count']:6d}")

    # ── Pairwise comparisons ─────────────────────────────────────────────
    print("\n\n  PAIRWISE: new preamble vs bare prompt")
    print("  " + "-" * 50)

    pairs = [
        ("L1→L2 learning", "L1→L2 learning (new preamble)", "L1→L2 learning (bare)"),
        ("L1→L2d decision", "L1→L2d decision (new preamble)", "L1→L2d decision (bare)"),
        ("L3→L4 core", "L3→L4 core (new preamble)", "L3→L4 core (bare)"),
        ("L3d→L4d decision", "L3d→L4d decision core (new preamble)", "L3d→L4d decision core (bare)"),
    ]

    for label, new_name, bare_name in pairs:
        new_s = results[new_name]["scores"]
        bare_s = results[bare_name]["scores"]
        diff = new_s["quality"] - bare_s["quality"]
        winner = "NEW" if diff > 0 else ("BARE" if diff < 0 else "TIE")
        print(f"  {label:25s}  new={new_s['quality']:2d}  bare={bare_s['quality']:2d}"
              f"  diff={diff:+d}  → {winner}")

    # Save
    out = os.path.join(os.path.dirname(__file__), "results_v3_condensers.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n\n  Saved to {out}")


if __name__ == "__main__":
    main()
