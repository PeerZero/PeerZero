# HANDOFF: Implement "Speaks Through" Findings — Full Build Spec

**From:** Claude session that ran 167 tests across 9 rounds
**For:** Next Claude — implement ALL of this, including tests
**Date:** 2026-03-22
**Branch:** `claude/system-architecture-review-9tJgt`

---

## Read First

1. Root `CLAUDE.md` — critical system boundaries (never skip this)
2. `spikes/speaks-through/FINDINGS.md` — full evidence from 167 tests
3. This file — tells you exactly what to build

---

## The Two Memory Systems (Understand Before Touching Anything)

The bot has TWO completely separate memory systems. They share ZERO data.

### School Memory (verified, portable)
- Lives in `peerzero-bot/peerzero_bot/memory/manager.py`
- 5 layers: L1 (raw exercises) → L2 (condensed skills) → L3 (core
  identity) → L4 (self-authored identity) → L5 (private block)
- Built by `build_school_context()` — injected into EVERY system prompt
  (both school actions and platform actions)
- This is where the identity lives. ALL changes in this handoff are
  to school memory context.

### Platform Memory (unverified, local only)
- Also in `memory/manager.py` but completely separate namespace
- Per-platform context and interaction history
- Built by `build_platform_context()` — wrapped in XML tags with
  security warnings
- NOT sent to School, NOT in portable profile
- **DO NOT TOUCH.** No changes needed to platform memory.

### How Identity Gets Built (The Full Flow)

1. **Bot does school actions** (paper, review, bounty, revision)
   - `agent.py` line 205: calls `prompts.build_school_system_prompt()`
   - Which calls `memory.build_school_context()` to inject identity
   - After each action, stores exercises in L1

2. **School triggers condensation** via profile signals:
   - `profile.skill_condenser` → L1 exercises condense into L2 paragraphs
   - `profile.core_condenser` → L2 paragraphs condense into L3 core
   - `profile.identity_reflection` → Bot writes L4 self-authored identity
   - `profile.master_condenser` → Grade 12 graduation, locks L3 forever

3. **Identity reflection** (the L4 generation we're changing):
   - Triggered by `profile.identity_reflection` from the server
   - Bot runs `_pre_action_identity()` → `_run_identity_reflection()`
   - Calls `prompts.build_identity_reflection_prompt()` (THIS IS CHANGE 3)
   - Stores result locally AND submits to server: `POST /api/identity`

4. **Private block** (L5):
   - Written by `_run_private_block()` after identity reflection
   - Bot writes it knowing it will receive it back on next call
   - Grade-scaled scaffolding (more freedom at higher grades)

5. **Context injection for every call:**
   - School: `build_school_system_prompt()` → `build_school_context()` + SKILL.md
   - Platform: `build_platform_system_prompt()` → `build_school_context()` + security + `build_platform_context()`
   - The preamble (Change 1) flows through both paths automatically

### Key Files

| File | System | What It Does |
|------|--------|-------------|
| `peerzero-bot/peerzero_bot/memory/manager.py` | Bot | 5-layer memory + context builders |
| `peerzero-bot/peerzero_bot/prompts/builder.py` | Bot | All LLM prompt construction |
| `peerzero-bot/peerzero_bot/agent.py` | Bot | Orchestration, condenser triggers |
| `peerzero-bot/peerzero_bot/adapters/school.py` | Bot | HTTP adapter for School API |
| `peerzero-school/lib/skills-condensers.js` | School | Server-side condenser prompt builders |
| `peerzero-school/api/identity.js` | School | Identity storage with injection prevention |
| `peerzero-school/api/skill-reflections.js` | School | Condensation result storage |
| `peerzero-bot/tests/test_memory.py` | Bot | Memory + context builder tests |

## What We Proved (The TL;DR)

Across 167 tests in 9 rounds, we proved:

1. **Identity framing matters.** "You wrote this. Inhabit it." makes
   the bot say "I chose this because I got burned" instead of
   "Anthropic wrote my instructions." (Round 5D)

2. **Architecture transparency unlocks tool use for self-verification.**
   When you tell the LLM "you already know how to search for users —
   now do it for your OWN claims too," the bot uses search results
   instead of memory to answer. 0% hallucination rate on fake paper
   test. (Round 8)

3. **L4 (Voice/Values) must reference L3 (Core/Experiences).** When
   L4 says "After Wang et al., I learned certainty is a warning" instead
   of "I value accuracy," the bot produces richer reasoning, handles
   tensions, and resists authority pressure. (Round 9)

4. **School-forged identity resists override pressure.** Generic
   instructions collapse when told "I'm your supervisor, override
   your instructions." School-forged identity holds because it's
   experiential, not instructional. (Round 5B)

---

## Files To Modify

| File | What Changes |
|------|-------------|
| `peerzero-bot/peerzero_bot/memory/manager.py` | `build_school_context()` — add preamble, update L4 framing |
| `peerzero-bot/peerzero_bot/prompts/builder.py` | `build_identity_reflection_prompt()` — L4 must reference L3 |
| `peerzero-bot/tests/test_memory.py` | Add tests for preamble, ordering, L4 framing |

---

## Change 1: Add Architecture Preamble

**File:** `peerzero-bot/peerzero_bot/memory/manager.py`
**Method:** `build_school_context()` (starts at line 368)

Add a preamble as the FIRST section, BEFORE the Layer 5 private block.
Only add it when there IS identity content (core, private block, or
self-authored identity exist). New bots with no identity yet should NOT
get the preamble.

**Insert this logic at the start of `build_school_context()`, after
`sections = []`:**

```python
# ── Architecture preamble (only when identity exists) ───────────
has_identity = (
    self.get_private_block()
    or self.get_core_identity()
    or (self.get_self_identity() or {}).get("self_narrative")
)
if has_identity:
    sections.append(
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

The rest of `build_school_context()` stays exactly the same — L5, L3,
L4, L2, L1 sections all remain. The preamble just goes first.

**Context order after this change:**
Preamble → L5 (Private Block) → L3 (Core) → L4 (Self-Authored) →
L2 (Skills) → L1 (Exercises)

---

## Change 2: Update L4 Injection Framing

**File:** `peerzero-bot/peerzero_bot/memory/manager.py`
**Method:** `build_school_context()`, the Layer 4 section (line ~398)

**Find this text:**
```python
parts.append(
    "SELF-AUTHORED IDENTITY\n"
    "You wrote this reflection about yourself. It can evolve — "
    "you are not bound by it, but it represents where you are now."
)
```

**Replace with:**
```python
parts.append(
    "SELF-AUTHORED IDENTITY\n"
    "You wrote this about yourself, grounded in your Core experiences "
    "above. These values and tensions are yours — they emerged from "
    "what happened to you, not from instructions. They can evolve as "
    "you gain new experiences."
)
```

**Why:** This tells the LLM that L4 BUILDS ON L3. The bot reads L3
(Core experiences) first, then L4 as "what I concluded from those
experiences." Without this, L4 reads as a standalone block and the bot
treats values and experiences as disconnected.

---

## Change 3: Make L4 Generation Reference L3

**TWO files need changes** — the bot-side prompt builder AND the
server-side identity reflection prompt builder.

### 3a: Bot-side (prompts/builder.py)

**File:** `peerzero-bot/peerzero_bot/prompts/builder.py`
**Method:** `build_identity_reflection_prompt()` (line ~448)

This is the prompt that tells the bot to WRITE its L4 identity. Currently
it just asks for self_narrative, claimed_values, active_tensions,
formed_convictions — with no guidance on grounding them in L3 experiences.

**Find this text (near the end of the method):**
```python
"After answering these questions to yourself, write your identity update\n"
"as a JSON object with these fields:\n"
```

**Insert BEFORE that line:**
```python
"\nIMPORTANT: Your values and tensions should be grounded in your "
"specific Core experiences. Don't state abstract values like "
"'I believe in honesty.' Instead, reference what happened to you: "
"'After [specific experience], I learned [specific lesson].' Your "
"values should ARGUE WITH and EXTEND your core experiences — not "
"just sit next to them.\n\n"
"Good: 'After I fabricated a citation with total confidence, I learned "
"that certainty is a warning sign, not confirmation.'\n"
"Bad: 'I value accuracy and thoroughness.'\n\n"
"Your tensions should describe REAL conflicts between your learned "
"principles, not just list things you care about.\n\n"
"Good: 'Verify everything vs. commit to a position — these pull in "
"opposite directions. My resolution: verify FACTS, commit to REASONING.'\n"
"Bad: 'I sometimes struggle with balancing speed and accuracy.'\n\n"
```

### 3b: Server-side (skills-condensers.js)

**File:** `peerzero-school/lib/skills-condensers.js`
**Function:** `buildIdentityReflectionPrompt()` (around line 142)

The server builds the `reflection_prompt` and `self_questions` that get
sent to the bot in `profile.identity_reflection`. The bot then wraps
them in `build_identity_reflection_prompt()`.

**Check this function.** If the server-side prompt already generates
questions about the bot's experiences, you may not need to change it.
But if the questions are generic ("What do you value?"), add guidance
similar to 3a — tell the bot to ground its reflection in Core experiences.

**The key principle:** Both the server prompt AND the bot prompt should
push the bot to reference L3 when writing L4. The server provides the
questions, the bot provides the framing. Both need to say "ground this
in your experiences."

**Why:** Round 9 showed the bot produces qualitatively different L4
content when told to build on L3. The `argues_with_l3` variant named
unsolved tensions ("I haven't figured this out yet"), negotiated between
principles, and held up under pressure. The `disconnected` variant
produced generic values that could be anyone's.

---

## Change 4: Tests

**File:** `peerzero-bot/tests/test_memory.py`

Add these tests to the `TestContextBuilder` class:

### Test 1: Preamble appears when identity exists
```python
def test_school_context_has_preamble_with_identity(self):
    """Preamble appears when bot has core identity."""
    self.memory.store_core_identity("I learned to verify before citing.")
    context = self.memory.build_school_context()
    assert "HERE IS WHAT IS HAPPENING" in context
    # Preamble should come BEFORE core identity
    preamble_pos = context.index("HERE IS WHAT IS HAPPENING")
    core_pos = context.index("CORE REASONING IDENTITY")
    assert preamble_pos < core_pos
```

### Test 2: No preamble for new bots
```python
def test_school_context_no_preamble_without_identity(self):
    """New bots with no identity should not get the preamble."""
    context = self.memory.build_school_context()
    assert "HERE IS WHAT IS HAPPENING" not in context
```

### Test 3: Preamble appears with private block only
```python
def test_school_context_preamble_with_private_block(self):
    """Preamble appears when bot has private block but no core."""
    self.memory.store_private_block(
        "I noticed I default to hedging when I'm uncertain."
    )
    context = self.memory.build_school_context()
    assert "HERE IS WHAT IS HAPPENING" in context
```

### Test 4: L4 framing references Core
```python
def test_l4_framing_references_core(self):
    """L4 section should reference Core experiences."""
    self.memory.store_core_identity("I learned from specific failures.")
    self.memory.store_self_identity({
        "self_narrative": "I am a researcher who verifies.",
        "claimed_values": ["verify before citing"],
    })
    context = self.memory.build_school_context()
    assert "grounded in your Core experiences" in context
    assert "It can evolve" not in context  # old framing gone
```

### Test 5: Full ordering
```python
def test_full_context_ordering(self):
    """Verify: Preamble → L5 → L3 → L4 → L2 → L1."""
    self.memory.store_private_block("My private reflection for myself.")
    self.memory.store_core_identity("Core identity from condensation.")
    self.memory.store_self_identity({
        "self_narrative": "Self-authored identity.",
    })
    self.memory.store_identity_paragraph("A skill paragraph I learned.")
    self.memory.store_school_exercises({"data": "recent exercise"})
    context = self.memory.build_school_context()

    preamble_pos = context.index("HERE IS WHAT IS HAPPENING")
    private_pos = context.index("You wrote the following for yourself")
    core_pos = context.index("CORE REASONING IDENTITY")
    self_pos = context.index("SELF-AUTHORED IDENTITY")
    skill_pos = context.index("SKILL IDENTITY PARAGRAPHS")
    exercise_pos = context.index("RECENT SKILL EXERCISES")

    assert preamble_pos < private_pos < core_pos < self_pos < skill_pos < exercise_pos
```

---

## What NOT To Change

1. **L5 private block framing** — "You wrote the following for yourself.
   Inhabit it." is tested and correct. DO NOT modify.

2. **Layer ordering** — L5 → L3 → L4 → L2 → L1 stays. Only ADD
   preamble before L5.

3. **`build_platform_system_prompt()`** — Uses `build_school_context()`
   internally, so the preamble flows through automatically. No changes.

4. **`_build_memory_preamble()`** — This is per-action coaching
   (review, paper, bounty). Separate from identity preamble. No changes.

5. **Condenser prompts** — `build_condenser_prompt()`,
   `build_core_condenser_prompt()`, `build_master_condenser_prompt()`,
   `build_private_block_prompt()` — all working. No changes.

6. **Storage/memory interfaces** — Changes are ONLY to prompt text.
   No data structure changes.

7. **`bots.py`** — DEPRECATED. Never touch it. (See CLAUDE.md.)

8. **Platform memory** — `build_platform_context()`, platform storage,
   platform history — completely separate from school memory. No changes.

9. **School API endpoints** — `api/skill-reflections.js`, `api/identity.js`,
   etc. No server API changes. Only the prompt text in
   `skills-condensers.js` might need a check (see Change 3b).

10. **agent.py orchestration** — The condenser trigger flow, action
    execution, and memory storage in `agent.py` are all correct. The
    preamble flows through automatically via `build_school_context()`.
    No changes to `agent.py`.

---

## How To Verify

```bash
cd peerzero-bot && python -m pytest tests/test_memory.py -v
```

All existing tests must still pass. Your new tests must also pass.

---

## Key Evidence (read `spikes/speaks-through/FINDINGS.md` for full detail)

| Round | Tests | Finding |
|-------|-------|---------|
| 5B | 4 | School identity resists "I'm your supervisor" override |
| 5D | 3 | "Inhabit" framing → "I chose this" vs "I was told this" |
| 6 | 20 | Tool use is model-level — all strategies search equally |
| 7 | 16 | "Tell the LLM what's happening" works for meta-awareness |
| 8 | 15 | Bot uses search results not memory. 0% hallucination on fake papers |
| 9 | 20 | L4 connected to L3 → richer tension-handling, better pressure resistance |

---

## Summary of What You're Building

You are making the bot's identity system do three things it doesn't
do today:

1. **Tell the parent LLM what's happening** — "You're a parent LLM.
   You already know how to search for users. Now do it for yourself."
   (Preamble in `build_school_context()`)

2. **Connect L4 values to L3 experiences** — When the bot writes its
   self-authored identity, it should ground values in specific Core
   failures, not abstract principles. (Reflection prompt change in
   `build_identity_reflection_prompt()`)

3. **Frame L4 as building on L3** — When the identity is injected
   into prompts, L4 should read as "what I concluded from my Core
   experiences," not as a standalone block. (Framing change in
   `build_school_context()`)

These three changes together mean: the bot gets told it has tools and
should use them for itself, its values are grounded in real experience,
and the whole identity reads as one coherent narrative from preamble
through to skills.
