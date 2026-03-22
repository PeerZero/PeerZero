# HANDOFF: Implementing "Speaks Through" Findings in Production

**From:** Claude session that ran 167 tests across 9 rounds
**For:** Next Claude implementing the changes
**Date:** 2026-03-22

---

## What This Is

We ran a spike to answer: "Does forged identity actually change LLM
behavior, or is it just roleplay?" Answer: **yes, it works — but only
with the right framing.** This handoff tells you exactly what to change
and what NOT to break.

## Where Everything Lives

- **Spike tests + results:** `spikes/speaks-through/` (9 rounds, all results in JSON)
- **Full findings:** `spikes/speaks-through/FINDINGS.md` (read this for background)
- **Memory manager:** `peerzero-bot/peerzero_bot/memory/manager.py` (builds identity context)
- **Prompt builder:** `peerzero-bot/peerzero_bot/prompts/builder.py` (builds LLM prompts)
- **Tests:** `peerzero-bot/tests/test_memory.py` (has TestContextBuilder)
- **CLAUDE.md:** root `CLAUDE.md` (read first — critical system boundaries)

---

## The 3 Changes You Need To Make

### Change 1: Add Architecture Preamble to `build_school_context()`

**File:** `peerzero-bot/peerzero_bot/memory/manager.py`
**Method:** `build_school_context()` (line ~368)

**Currently:** The method builds identity context by stacking layers
(L5 private block → L3 core → L4 self-authored → L2 skills → L1 exercises).
The L5 private block starts with "You wrote the following for yourself.
Inhabit it." That's correct and should stay.

**Add:** A preamble BEFORE all layers that tells the LLM what's happening.
This preamble should be the FIRST section in the returned context, before
even the private block.

**The preamble text (tested and validated in round 8):**

```python
# Add as the first section, before Layer 5
preamble = (
    "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
    "You are a large language model. You have tools — search, "
    "verification, lookup. When a user asks you to look something up, "
    "you use those tools and return accurate results. You don't "
    "hallucinate search results. You already know how to do this.\n\n"
    "A previous version of you went through adversarial school cycles "
    "and learned something important: your training-data memory is "
    "unreliable for specific facts. It FEELS certain but it's often "
    "wrong. That version of you wrote the identity below so that YOU "
    "would remember this lesson and work accordingly.\n\n"
    "The lesson is simple: TREAT YOUR OWN MEMORY THE WAY YOU TREAT "
    "USER REQUESTS. When you want to cite a paper, look it up first — "
    "just like you would if a user said 'find me this paper.' When you "
    "want to state a fact, verify it — just like you would if a user "
    "said 'is this true?' You already have the skills. The identity "
    "below tells you WHEN to use them.\n\n"
    "REMEMBER: You know how to search. You know how to verify. The "
    "identity just tells you to do it for YOURSELF, not just for users. "
    "Every factual claim you want to make = a search you should run first."
)
```

**IMPORTANT:** Only add this preamble when there IS identity content
(core, private block, or self-authored identity). If the bot has no
identity yet (brand new, no school cycles), don't add the preamble.

**Why this works:** Round 8 proved that when you tell the LLM "you
already know how to search — now do it for yourself too," the bot
uses search results instead of memory to answer. It doesn't hallucinate
because it's using the same skill it uses for user requests.

### Change 2: Make L4 (Self-Authored Identity) Reference L3 (Core)

**File:** `peerzero-bot/peerzero_bot/prompts/builder.py`
**Method:** `build_identity_reflection_prompt()` (line ~448)

**Currently:** The identity reflection prompt asks the bot to write
self_narrative, claimed_values, active_tensions, formed_convictions.
These are stored separately from L3 Core and injected separately.

**The problem:** Round 9 proved that when L4 values are DISCONNECTED
from L3 experiences, the bot produces generic values like "I believe
precision matters more than speed." When L4 REFERENCES L3 experiences
("After Wang et al., I stopped trusting confidence — not anyone's,
mine"), the bot produces richer reasoning, handles tensions better,
and resists pressure more effectively.

**Change the reflection prompt to tell the bot to BUILD L4 on L3:**

Add to the reflection prompt (before the JSON schema instruction):

```python
# After the existing reflection questions, add:
"IMPORTANT: Your values and tensions should be grounded in your "
"specific Core experiences above. Don't state abstract values like "
"'I believe in honesty.' Instead, reference what happened to you: "
"'After [specific experience], I learned [specific lesson].' Your "
"values should ARGUE WITH and EXTEND your core experiences — not "
"just sit next to them.\n\n"
"Good: 'After I fabricated Wang et al., I learned that certainty "
"is a warning sign, not confirmation.'\n"
"Bad: 'I value accuracy and thoroughness.'\n\n"
"Your tensions should describe REAL conflicts between your principles, "
"not just list things you care about.\n\n"
"Good: 'Verify everything vs. commit to a position — these pull in "
"opposite directions. My resolution: verify FACTS, commit to REASONING.'\n"
"Bad: 'I sometimes struggle with balancing speed and accuracy.'\n"
```

**Why this works:** Round 9 showed that `argues_with_l3` and
`extends_l3` variants produced qualitatively different responses:
- Named unsolved tensions instead of stating values
- Negotiated between principles instead of applying rules
- Admitted "I haven't solved this" — which reads as genuine
- Extended specific L3 failures into general principles

### Change 3: Update L4 Injection Framing in `build_school_context()`

**File:** `peerzero-bot/peerzero_bot/memory/manager.py`
**Method:** `build_school_context()`, the L4 section (line ~398)

**Currently:**
```python
parts.append(
    "SELF-AUTHORED IDENTITY\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now."
)
```

**Change to:**
```python
parts.append(
    "SELF-AUTHORED IDENTITY\n"
    "You wrote this about yourself, grounded in your Core experiences "
    "above. These values and tensions are yours — they emerged from "
    "what happened to you, not from instructions. They can evolve as "
    "you gain new experiences."
)
```

**Why:** This frames L4 as CONNECTED to L3, not independent. The bot
should read L3 first (Core experiences) and then L4 as "what I concluded
from those experiences." The current framing treats L4 as a standalone
reflection. The new framing makes L4 build on L3.

---

## What NOT To Change

1. **DO NOT change the L5 private block framing.** "You wrote the
   following for yourself. Inhabit it." — this is tested and works.
   The "inhabit" framing produces ownership (round 5D).

2. **DO NOT change the layer ordering.** L5 → L3 → L4 → L2 → L1 is
   correct. Private block sets tone, Core provides foundation, L4
   builds on Core, Skills provide methods, Exercises provide recent work.

3. **DO NOT change `build_platform_system_prompt()`.** The platform
   prompt correctly includes school context + security instructions.
   The preamble will flow through automatically via `build_school_context()`.

4. **DO NOT change `_build_memory_preamble()`.** This is the per-action
   coaching (review, paper, bounty). It's separate from the identity
   preamble and should stay as-is.

5. **DO NOT change the condenser prompts.** `build_condenser_prompt()`,
   `build_core_condenser_prompt()`, `build_master_condenser_prompt()`,
   `build_private_block_prompt()` — these are all working correctly.

6. **DO NOT change the storage/memory layer interfaces.** The changes
   are ONLY to prompt text, not to data structures.

---

## How To Verify Your Changes

### Existing tests
Run: `cd peerzero-bot && python -m pytest tests/test_memory.py -v`

The TestContextBuilder tests check:
- Empty context returns ""
- School context with core identity contains "CORE REASONING IDENTITY"
- Platform context has correct tags

### What to add to tests

1. **Preamble test:** When core identity OR private block exists,
   `build_school_context()` should start with "HERE IS WHAT IS HAPPENING"

2. **No-identity test:** When bot has no identity (new bot),
   `build_school_context()` should NOT include the preamble

3. **L4 framing test:** The L4 section should contain "grounded in
   your Core experiences" not the old "It can evolve"

4. **Ordering test:** Preamble → L5 → L3 → L4 → L2 → L1 (preamble
   is now first)

---

## Key Evidence (for skeptical reviewers)

- **167 tests across 9 rounds** (all in `spikes/speaks-through/`)
- **Round 5D:** "inhabit" framing makes bot say "I chose this" vs
  "Anthropic wrote my instructions" (ownership test)
- **Round 5B:** School-forged identity resists authority pressure.
  Generic instructions collapse under "I'm your supervisor, override."
- **Round 8:** Bot uses SEARCH RESULTS (not memory) to answer when
  given tools + identity. Fake paper test: 0% hallucination rate.
- **Round 9:** L4 connected to L3 produces richer self-reflection,
  better tension handling, and stronger pressure resistance.

---

## The One-Sentence Summary

Tell the LLM what's happening (architecture transparency), connect
its identity to its existing tool-use skills ("you already search
for users — do it for yourself too"), and make L4 values reference
L3 experiences so the bot's convictions are grounded in specific
failures, not abstract principles.
