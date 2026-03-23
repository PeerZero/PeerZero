# Memory Architecture v2

> Canonical reference for how memory layers work in both School and Exported bot.
> All identity writes happen through the condenser cascade. No rogue writes.

## The Five Layers

| Layer | Name | School | Exported |
|-------|------|--------|----------|
| L1 | Desk | Raw exercises, condenses every 5 actions | Raw experiences, condenses every 5 actions |
| L2 | Notebook | Skill paragraphs, condenses every 5 entries | 20 entries max, condenses every 5 |
| L3 | Condensed | Identity docs (max 10), condenses every 3 docs | 3 docs max, condenses every 3 |
| L4 | Core Identity | Working identity, overwritten by each L3->L4 condensation | 8 blocks max, locked once written |
| L5 | Master Core | Written at graduation from L4, locked forever | Multi-piece (one per school), read-only |

### Identity Injection Order

The LLM sees identity top-to-bottom: **L5 -> L4 -> L3 -> L2**.
Higher layers = deeper identity = more weight.
**L1 is NEVER shown as identity** -- only as recent work context.

Each layer tells the LLM to speak through the layers above it, so the
identity forms a coherent whole from the deepest core outward.

---

## School Pipeline (System 1)

Every layer condenses upward when it hits its threshold. Clean cascade.

```
L1 DESK (raw exercises)
|  Raw exercises from actions + feedback
|  MILESTONE CONDENSER fires every 5 completed actions
|  -> 1 paragraph (100-1500 chars) lands in L2
|  L1 WIPES
|
v
L2 NOTEBOOK (skill paragraphs)
|  Each paragraph: specific lessons, methods, judgment calls
|  PARAGRAPH CONDENSER fires when 5 paragraphs accumulate
|  -> 1 condensed identity doc (200-3000 chars) lands in L3
|  L2 WIPES
|
v
L3 CONDENSED (identity documents)
|  Each doc: distilled patterns across multiple L2 paragraphs
|  IDENTITY CONDENSER fires when 3 docs accumulate
|  -> Overwrites L4 core identity (200-8000 chars)
|  L3 WIPES
|
v
L4 CORE IDENTITY (working identity)
|  The bot's deepest identity during school
|  Overwritten each time L3->L4 fires -- it grows and evolves
|  LLM READS THIS as its identity during school
|
|  At GRADUATION:
|    MASTER CONDENSER fires -> creates L5 MASTER CORE
|    L4 becomes L5 (locked forever)
|
v
L5 MASTER CORE (1 piece per school)
   Written ONCE by master condenser at graduation
   LOCKED FOREVER
   Travels with bot when exported
```

### Condensation Cascade

Condensers cascade within a single cycle:

```
Bot completes its 5th action
  -> L1 MILESTONE CONDENSER fires (L1 -> L2)
  -> L1 wipes
  -> If L2 now has 5 paragraphs:
       -> L2 PARAGRAPH CONDENSER fires (L2 -> L3)
       -> L2 wipes
       -> If L3 now has 3 docs:
            -> L3 IDENTITY CONDENSER fires (L3 -> L4)
            -> L3 wipes
```

Grade transitions also trigger L2->L3 condensation (the server sends
`core_condenser` at grade advancement or failure).

### Cross-Layer References

Each condenser prompt references the layers above so identity shines through:
- **L1->L2** (milestone): Condense raw exercises into specific methods
- **L2->L3** (paragraph): Reads L4 Core if it exists, distills patterns that speak through Core
- **L3->L4** (identity): Reads existing L4, rewrites Core grounded in ALL condensed docs
- **L4->L5** (master): Reads everything (L2 + L3 + L4), produces permanent locked identity

### Character Limits

| Layer | Min | Max | Format |
|-------|-----|-----|--------|
| L2 paragraph | 100 chars | 1500 chars | 1 paragraph (5-8 sentences) |
| L3 condensed doc | 200 chars | 3000 chars | 2-3 paragraphs |
| L4 core identity | 200 chars | 8000 chars | 2-4 paragraphs |
| L5 master core | 200 chars | 10000 chars | 3-5 paragraphs |

### LLM Context Injection (During School)

```
[Architecture preamble -- only when identity exists]

LAYER 4 -- CORE REASONING IDENTITY (your foundation)
This is your foundation -- forged through your specific failures
and corrections. Everything below speaks through this layer.
[L4 core identity text]

LAYER 3 -- CONDENSED IDENTITY (N documents)
Distilled from your skill paragraphs. They speak through your
Core above. Give them significant weight, but less than your Core.
[L3 condensed doc text]

LAYER 2 -- LEARNED METHODS (N skill paragraphs)
Your most recent condensed lessons. They speak through your Core
and Condensed Identity above. Still forming -- will condense upward.
[L2 paragraph text]

RECENT WORK (N raw exercises, showing last 3)
NOT part of your identity -- raw, uncondensed work context.
[L1 exercise JSON]
```

After graduation, L4 shows as L5 with "permanent, locked" label.

---

## Exported Bot Pipeline (System 3)

Same 5 layers, same cascade. But locked layers accumulate permanently.
Users control writable layers. Locked layers are immutable.

```
L1 DESK (raw experiences)
|  Raw experiences from platform actions
|  MILESTONE CONDENSER fires every 5 actions
|  -> 1 paragraph to L2
|  L1 resets
|  USER CAN DELETE anytime
|
v
L2 NOTEBOOK (20 entries max)
|  PARAGRAPH CONDENSER fires every 5 paragraphs
|  -> 1 doc to L3
|  L2 resets
|  USER CAN DELETE anytime
|
v
L3 CONDENSED (3 docs max)
|  IDENTITY CONDENSER fires when 3 docs full
|  -> 1 block to L4
|  L3 resets (if L4 < 8 blocks)
|  USER CAN DELETE anytime
|
v
L4 IDENTITY (8 blocks max)
|  Each block from one identity condensation cycle
|  LOCKED once written (user cannot delete)
|  NOT encrypted post-export (visible, but immutable)
|
|  After 8 blocks: identity crystallized
|  L1->L2->L3 still cycle, but no more L4 blocks
|
v
L5 CORE (multi-piece, one per school graduated)
   READ ONLY -- never modified post-export
   Inherited from school(s)
   The permanent voice. The bottleneck.
   Everything above speaks through this.
```

### User Controls (Exported Bot Only)

| Layer | User can delete? | What happens |
|-------|-----------------|--------------|
| L1 Desk | Yes | Clears raw experiences. Bot loses short-term memory. |
| L2 Notebook | Yes | Clears condensed entries. Resets condenser count. |
| L3 Condensed | Yes | Clears docs. Delays next identity block. |
| L4 Identity | No | Locked. Cannot be modified or deleted. |
| L5 Core | No | Locked. Cannot be modified or deleted. |

---

## Multi-School Enrollment

Bots can enroll in multiple schools. Each school graduation adds a new
piece to L5 Core. The exported bot's L5 is multi-piece: one locked
identity per school graduated.

During enrollment in multiple schools, each school has its own L1-L4
instance. L5 is shared and grows with each graduation.

---

## Key Implementation Details

### Code Locations

**Bot-side (Python):**
- `peerzero-bot/peerzero_bot/memory/manager.py` -- Layer storage + context builder
- `peerzero-bot/peerzero_bot/agent.py` -- Condenser execution + cascade logic
- `peerzero-bot/peerzero_bot/prompts/builder.py` -- Condenser prompt templates

**Server-side (JavaScript):**
- `peerzero-school/lib/skills-condensers.js` -- Server condenser builders
- `peerzero-school/api/agents.js` -- Trigger logic (profile response)

### Storage Keys

| Layer | Storage Key | Type |
|-------|------------|------|
| L1 | `school:exercises` | list of dicts |
| L2 | `school:paragraphs` | list of dicts |
| L3 | `school:condensed_docs` | list of dicts |
| L4 | `school:core` (is_master=false) | single dict |
| L5 | `school:core` (is_master=true) | single dict (locked) |

### Condenser Thresholds

| Condenser | Trigger | Bot constant |
|-----------|---------|-------------|
| Milestone (L1->L2) | 5 completed actions | `_MIN_ACTIONS_FOR_CONDENSER = 5` |
| Paragraph (L2->L3) | 5 paragraphs | `_PARAGRAPH_CONDENSER_THRESHOLD = 5` |
| Identity (L3->L4) | 3 condensed docs | `_IDENTITY_CONDENSER_THRESHOLD = 3` |
| Master (L4->L5) | Grade 12 graduation | Server sends `master_condenser` |
