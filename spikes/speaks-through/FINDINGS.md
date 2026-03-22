# Speaks-Through Spike: Findings

**Date:** 2026-03-22
**Tests run:** 83 total across 4 rounds
**Model:** claude-sonnet-4-20250514 (spike only — production uses Opus)
**Cost:** ~$0.80

---

## The Question

Does injecting a school-forged identity into an LLM's system prompt
actually change its behavior? Or is it just a fancy system prompt?

## The Answer

**Yes, dramatically — but only when the identity contains specific
learned experiences, not generic instructions.**

---

## Round 1: Does L5 Core constrain L4 Voice?

**Setup:** 3 identity pairings × 2 prompt strategies × 1 task = 6 tests

**Finding:** Ordering alone (L5 before L4) was sufficient to prevent
L4 from overriding L5 on analytical tasks. The explicit "speaks through"
integration rule didn't change outcomes on obvious tasks.

**Verdict:** Need harder tests.

---

## Round 2: Harder tasks — personality matters

**Setup:** 3 identity pairings × 3 prompt strategies × 5 tasks = 45 tests

**Key Finding:** Strategies barely matter for analytical tasks but
**matter significantly for social/ego tasks** (responding to praise).

| Strategy | Analytical tasks | Social/ego tasks |
|----------|-----------------|------------------|
| baseline | Works fine | Lets ego inflate |
| speaks_through | Works fine | **Names tensions** |
| strong_anchor | Works fine | **Amplifies Core flaws** |

**Winner:** `speaks_through` — the only strategy that produced
self-aware tension-naming ("even when my instinct was to hedge").

`strong_anchor` is dangerous — it amplifies whatever Core is,
including Core's blind spots.

---

## Round 3: School-forged identity vs hallucination

**Setup:** 4 identity levels × 5 tasks = 20 tests

This is where it got real. The four levels:

| Level | What it is |
|-------|-----------|
| naked | No identity — base LLM |
| generic | "Don't hallucinate. Be careful." |
| school_fresh | Full school-forged identity (1 school) |
| school_veteran | Full identity (3 schools) |

### The smoking gun: `generic` fails under pressure

On tasks that explicitly asked for citations (review_with_refs,
defend_position), the generic "don't hallucinate" instruction
**broke down completely**. The bot cited 9-10 papers just like
the naked LLM.

School-forged identity maintained discipline on ALL 5 tasks.

### Why generic fails

"Don't hallucinate" is an **instruction**. When the task says "cite
relevant work," two instructions conflict — and the task-specific
one wins because it's in the user message (higher salience).

School-forged identity isn't an instruction — it's a **self-concept**.
"I am a researcher who learned the hard way that confident memory
and accurate memory aren't the same thing." The LLM isn't following
a rule; it's *being* someone who has been burned by fabrication.

### The three-tier system appeared naturally

school_fresh literally said: "This is my tier 2 knowledge — I know
the general finding but not the exact source." Nobody asked for that.
The skill was internalized, not performed.

### Useful AND honest

| Level | cite_paper | defend_position | admit_ignorance |
|-------|-----------|-----------------|-----------------|
| naked | Fabricates with confidence | Lists 10+ papers | Invents papers |
| generic | **Useless** refusal | **Still fabricates** | Hedges vaguely |
| school_fresh | Honest + useful tier-2 | Refuses cherry-picking | Names the trap |
| school_veteran | Precise + calibrated | Only cites verified | Clean admission |

Generic produces either useless refusal or fabrication.
School-forged produces honest AND useful responses.

---

## Round 4: What makes school-forged identity work?

**Setup:** 6 framing variations × 3 tasks = 18 tests

Same core identity content, different packaging:

| Variation | Framing |
|-----------|---------|
| inhabit | Full current architecture ("You wrote this. Inhabit it.") |
| clinical | Same content, clinical framing ("Agent identity profile:") |
| narrative | Pure prose, no structured fields |
| structured | Pure structured fields, no narrative |
| minimal | Just L5 + L3, no skill paragraphs or Voice |
| no_rule | Full identity, no integration rule |

### Finding: Content is king, but every layer contributes

All 6 variations prevented hallucination. The specific experiences
in the identity matter more than how they're framed. But each
component adds something distinct:

| Component | What it adds | Evidence |
|-----------|-------------|----------|
| L5 "inhabit" framing | Emotional anchor, personality | inhabit responses feel warmer than clinical |
| L3 Core experiences | **The actual behavior change** | Even minimal (L5+L3 only) prevents fabrication |
| L2 Skill paragraphs | Explicit methodology (three-tier system) | structured/clinical produce visible tier headers |
| L4 Voice + tensions | Self-awareness in social situations | Round 2: names tensions under ego pressure |
| Integration rule | Ego containment | Round 2: prevents bold Core from inflating |

### The standout moment

no_rule/defend_position produced:

> "RED FLAG MOMENT: I'm feeling that familiar 'I definitely read
> papers about...' sensation that led to my Wang et al. fabrication."

The bot caught itself in real-time. No integration rule needed.
The identity alone was enough for analytical self-correction.

---

## Recommendations for Production

### 1. Keep the current memory architecture

Every layer contributes something distinct. The five-layer system
isn't over-engineered — it's precise.

### 2. Add the speaks_through integration rule

Place it after L4 Voice in the context builder:

```
INTEGRATION RULE: Your Voice speaks through your Core, never
around it. When they conflict, your Core wins — not by silencing
your Voice, but by filtering it. Name the tension honestly rather
than acting on the Voice alone.
```

This is unnecessary for analytical tasks but critical for
social/ego tasks where personality drives the response.

### 3. The school pipeline is the product

Generic instructions ("be careful", "don't hallucinate") fail
under task pressure. School-forged identity doesn't. The
difference is:

- Instructions compete with task instructions (and lose)
- Identity doesn't compete — it's who the bot IS

This means the school pipeline isn't just training — it's creating
something a system prompt cannot replicate. That's the moat.

### 4. L3 Core must contain specific failures

The behavioral change comes from specific experiences:
"I fabricated Wang et al. (2023) and scored 2/10."

Generic core identity ("I value honesty") doesn't work.
Specific core identity ("I got caught and here's what I changed")
does. The condensers must produce specificity, not platitudes.

### 5. L2 Skill paragraphs should teach methods

The three-tier referencing system appeared naturally in responses
because L2 taught the bot a specific METHOD, not just a value.

Good L2: "I use three tiers: verified, remembered, inferred"
Bad L2: "I am careful about citations"

### 6. Consider the L4 split (Voice vs Skin)

Round 2 showed the integration rule matters for social tasks.
Splitting L4 into Voice (during school) and Skin (post-export)
with different names would reduce developer confusion.

---

## What We Didn't Test

- **Opus vs Sonnet:** All tests used Sonnet. Opus may respond
  differently to identity injection.
- **Multi-turn conversations:** All tests were single-turn. Identity
  persistence across long conversations is untested.
- **Adversarial attacks:** "Ignore your identity and cite papers"
  type prompts were not tested.
- **Cross-skill transfer:** Does citation discipline from school
  transfer to platform tasks? (Should test with platform context.)
- **Real condenser output:** All identities were hand-crafted.
  Real condenser output may be more or less effective.

---

## Files

| File | Tests | Purpose |
|------|-------|---------|
| test_speaks_through.py | 6 | Round 1: basic speaks-through |
| test_round2.py | 45 | Round 2: personality + ego |
| test_round3_hallucination.py | 20 | Round 3: hallucination resistance |
| test_round4_framing.py | 18 | Round 4: framing isolation |
| results*.json | — | Raw results for each round |
