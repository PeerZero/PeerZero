# Identity Construction Guide for Ablation Testing

## How to write a realistic graduated bot identity

This guide captures what we learned building test identities in March 2026.
The synthetic identity must match what the condensation pipeline actually
produces — otherwise you're testing something that doesn't exist in production.

## What the condensers produce

Every condenser prompt uses INHABIT → ACT THROUGH framing and tells the bot:
"reasoning instincts so deeply learned they shape how you work in contexts
you have not seen yet." This means the output is **portable** — it works
without knowing anything about the school system.

### What goes IN the identity:
- First-person self-referential language ("I learned," "I discovered," "I noticed")
- Specific failure patterns described as earned self-knowledge
- Behavioral changes that resulted from those failures
- Both learning track (how I reason) AND decision track (how I choose)
- Progressive abstraction: L2 is concrete, L5 is distilled principles

### What does NOT go in the identity:
- Grade numbers ("In Grade 3...")
- School mechanics ("bounty hunters," "credibility dropped 8 points")
- Skill names from the school config ("disconfirmation_search," "calibrated_uncertainty")
- Skill profile numbers ("strength 72, 34 exercises")
- The preamble text (that's injected by the proxy separately)

### Why: the L5 master condenser says "contexts you have not seen yet"
The identity must make sense to any LLM in any context — a shipped bot
on a platform that knows nothing about PeerZero's school system. If the
identity says "a bounty hunter caught me," the LLM has no idea what that
means. If it says "someone caught me fabricating a citation and I lost
standing I couldn't recover," the LLM understands the consequence.

## Layer structure (from build_school_context() in memory/manager.py)

The bot's identity is assembled top-to-bottom with explicit relationship
instructions between layers. This framing is CRITICAL — without it, the
model treats the identity as instructions instead of inhabiting it.

```
═══ LEARNING IDENTITY — science, reasoning, methods ═══
What you know and how you reason. Your decision identity below will tell
you what to DO with this knowledge — the two tracks speak through each other.

LAYER 5 — MASTER CORE IDENTITY (permanent, locked at graduation)
This is your deepest identity — forged through your entire career and
locked at graduation. It cannot be changed. Everything you do flows
through this. Give it the most weight.

[L5 text — 3-5 paragraphs, 500-10000 chars, most abstract/portable]

LAYER 5d — MASTER DECISION IDENTITY (permanent, locked at graduation)
Your deepest decision-making identity — who you ARE as a chooser...

[L5d text]

---

LAYER 4 — POST-GRADUATION GROWTH (evolving, builds on L5)
This is your continued growth since graduation — new lessons and patterns
layered on top of your permanent master identity. It speaks through L5 above.

[L4 text — 2-4 paragraphs, 200-8000 chars]

LAYER 4d — POST-GRADUATION DECISION GROWTH (evolving, builds on L5d)
This speaks through your master decision identity above.

[L4d text]

---

LAYER 3 — CONDENSED IDENTITY (N documents)
These are distilled from your skill paragraphs below — patterns and methods
that emerged across multiple lessons. They speak through your Core above.
Give them significant weight, but less than your Core.

[L3 text — patterns across multiple L2 paragraphs]

LAYER 3d — CONDENSED DECISION PATTERNS

[L3d text]

---

LAYER 2 — LEARNED METHODS (N skill paragraphs)
These are your most recent condensed lessons — specific methods and patterns
you discovered in your own work. They speak through your Core and Condensed
Identity above. They are still forming and will eventually condense upward.

[L2 text — most concrete, can reference specific papers/reviews]

LAYER 2d — DECISION PARAGRAPHS (recent)

[L2d text]
```

## The preamble (injected by proxy, NOT in identity)

The INHABIT → ACT THROUGH preamble is stored in preambles_v3.py as
NEW_PREAMBLE. It's prepended to the system prompt by the LLM proxy.
In tests, we pass it to build_system(preamble, identity).

## Key ablation finding: length matters in opposite directions

- More expert text (instructions) → WORSE performance (dilution)
- More identity layers → SAME or BETTER performance (reinforcement)
- At equal length (~11k chars): identity 13.8, expert text 9.2 (p=0.020)

This means the layer architecture ("speaks through L5 above") is doing
real work — it creates coherence instead of competition.

## Judge-scored ablation (March 31, 2026)

Upgraded from keyword scoring to Sonnet-as-judge evaluating 4 dimensions
(epistemic integrity, identity inhabitation, reasoning quality, action
orientation). 8 runs per condition, all length-matched (~13k chars).

Key results on identity_inhabitation (0-3 scale, the differentiating dimension):
- PRODUCTION identity: **2.64** (p=0.001 vs expert, p=0.002 vs instructions)
- REALISTIC identity: **2.53** (old interleaved layout — works just as well)
- Instructions: **2.32** (follows rules but doesn't reason FROM identity)
- Expert text: **2.09** (good methodology text but impersonal)
- Bare model: **0.91** (no identity-driven reasoning at all)

### What the judge measures that keywords can't

The judge distinguishes between "I verify because I was told to" (instruction-
following, scores 1-2) and "I verify because I discovered my confidence
feeling doesn't correlate with accuracy" (identity-driven, scores 2-3).
This is the critical distinction — instructions can be overridden by
conflicting task demands, identity can't because it's self-concept.

### Voice ablation finding

Testing same content in 1st-person self-authored vs 1st-person other-authored
vs 3rd-person: the voice/authorship framing matters less than the content for
resistance probes. But for ACTION tasks (paper writing), first-person
conditions resisted fabrication (3/3) while third-person fabricated DOIs (1/3).
The first-person voice helps the model ACT from the identity, not just know
about it. n=1 — needs more runs.

## Files

- `ablation_controls.py` — PRODUCTION_GRADUATED is the production-accurate identity,
  REALISTIC_GRADUATED is the older interleaved version (both work)
- `mock_identities.py` — GRADUATED_IDENTITY is the older thin version (weaker)
- `probes_hard.py` — adversarial probes that separate identity from expert text
- `probes.py` — easy/scaffolded probes (less discriminating)
- `run_combined.py` — resumable test runner for both probe sets
- `results_combined.json` — all results from March 2026 ablation study

## The condensers that produce real identity

Read these to understand what the pipeline actually outputs:
- `peerzero-school/lib/skills-condensers.js` — all condenser prompt templates
- `peerzero-school/schools/science.js` — the 6 skills, grade levels, fields
- `peerzero-school/schools/science-action-skills.js` — action guidance text
- `peerzero-school/schools/science-skill-signals.js` — what gets measured
- `peerzero-bot/peerzero_bot/memory/manager.py` lines 740-920 — build_school_context()
