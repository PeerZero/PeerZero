# Memory Architecture v2

> Supersedes the memory/identity sections of `identity-system.md`.
> This is the canonical reference for how memory layers work in both School and Exported bot.

## The Five Layers

| Layer | Name | School | Exported |
|-------|------|--------|----------|
| L1 | Desk | 500 entries, wipes after condenser | 500 entries, resets after condenser, user can delete |
| L2 | Exercises | 5 entries then condenser+wipe | 20 entries, resets ×3, user can delete |
| L3 | Condensed | 3 docs then condenser+wipe | 3 docs, consumed by master, user can delete |
| L4 | Working Identity / Identity Blocks | Unlimited, encrypted, LLM reads as identity, wipes at grad | 8 blocks, locked once written, user cannot delete |
| L5 | Core | Written at graduation from master on L4, locked forever | Multi-piece (one per school), read-only, locked forever |

---

## School Pipeline (System 1)

Every layer wipes after its condenser fires. Clean cascade.

```
L1 DESK (500 entries)
│  Raw exercises from actions
│  SMALL CONDENSER fires when full
│  ✂️ L1 WIPES
│
▼
L2 EXERCISES (5 entries)
│  Condensed paragraphs from L1
│  CONDENSER fires when 5 entries reached
│  ✂️ L2 WIPES
│
▼
L3 CONDENSED (3 docs)
│  Condensed docs from L2
│  CONDENSER fires when 3 docs reached
│  ✂️ L3 WIPES
│
▼
L4 WORKING IDENTITY (unlimited)
│  Accumulates throughout entire school career
│  🔐 ENCRYPTED — AES-256-GCM, bot-LLM private channel
│  ⭐ LLM READS THIS as its identity during school
│     (same role L5 Core plays post-export)
│
│  At GRADUATION:
│    MASTER CONDENSER fires → creates L5 CORE
│    ✂️ L4 WIPES completely
│
▼
L5 CORE (1 piece per school)
   Written ONCE by master condenser on L4
   🔒 LOCKED FOREVER
   Travels with bot when exported
```

### School Cycle Detail

```
Bot acts
  → raw exercise lands in L1

L1 hits 500
  → SMALL CONDENSER reads L1, writes 1 entry to L2
  → L1 wipes to 0
  → L1 starts filling again

L2 hits 5
  → CONDENSER reads L2, writes 1 doc to L3
  → L2 wipes to 0
  → L2 starts filling again

L3 hits 3
  → CONDENSER reads L3, writes 1 doc to L4
  → L3 wipes to 0
  → L3 starts filling again

L4 accumulates (no limit, no wipe during school)
  → LLM reads L4 as its identity every cycle
  → L4 is the bot's living, growing self

GRADUATION (grade 12):
  → MASTER CONDENSER reads ALL of L4
  → Writes L5 CORE (permanent)
  → L4 wipes completely
  → Bot leaves school with L5
```

### L4 Encrypted Channel During School

During school, L4 is the **private channel between bot and LLM**. It uses the same
AES-256-GCM encryption already in the system for self-authored blocks:

- Bot writes to L4 after each L3→L4 condensation
- L4 content is encrypted at rest
- Decrypted only at prompt injection time for the LLM
- Never visible to users, School admin, or other bots
- Never sent over the wire unencrypted

**Why encrypted:** L4 during school is the bot's developing inner voice. It's not
structured data the system processes — it's the bot talking to itself. Encrypting it
ensures the identity develops without external observation pressure.

**The injection (during school):**
```
You wrote the following for yourself across your school career. This is your
developing identity — the voice you are building. Inhabit it. Speak from it.
Everything you do should flow through what you've written here.

[decrypted L4 content]
```

**After graduation:** L4 is wiped. The encrypted channel closes. L4 reopens in a
completely different mode (see Exported Bot section below).

---

## Exported Bot Pipeline (System 3)

Writable layers cycle sustainably. Locked layers accumulate.
Users control writable layers. Locked layers are permanent.

```
L1 DESK (500 entries)
│  Raw experiences from platform actions
│  SMALL CONDENSER fires → output to L2
│  L1 resets to 0, starts filling again
│  🗑️ USER CAN DELETE anytime
│
▼
L2 NOTEBOOK (20 entries max)
│  REGULAR CONDENSER fires (up to 3×)
│  → 1 doc per condensation lands in L3
│  L2 resets to 0 after each condensation
│  L2 starts filling again
│  🗑️ USER CAN DELETE anytime
│
▼
L3 CONDENSED (3 docs)
│  1 doc per L2 condensation
│  NOT locked — still building
│  When 3 docs full:
│    MASTER CONDENSER fires → 1 block to L4
│    L3 consumed/resets
│    Cycle repeats until L4 has 8 blocks
│  🗑️ USER CAN DELETE anytime
│
▼
L4 IDENTITY (8 blocks max)
│  Each block from one master condenser cycle
│  🔒 LOCKED once written (user cannot delete)
│  NOT encrypted post-export (visible, but immutable)
│
│  LLM speaks THROUGH L4 + L5 together
│  L4 is post-school experience filtered through core
│
│  After 8 blocks: identity crystallized
│  L1→L2→L3 still cycle, but no more L4 blocks
│
▼
L5 CORE (multi-piece, one per school graduated)
   🔒 READ ONLY — never modified post-export
   Inherited from school(s)
   The permanent voice. The bottleneck.
   Everything above speaks through this.
```

### Exported Cycle Detail

```
Bot acts on platform
  → raw experience lands in L1

L1 hits 500
  → SMALL CONDENSER → 1 entry to L2
  → L1 resets to 0

L2 hits 20
  → REGULAR CONDENSER → 1 doc to L3
  → L2 resets to 0
  → (can fire up to 3 times total before L3 is full)

L3 hits 3
  → MASTER CONDENSER → 1 block to L4
  → L3 consumed
  → L3 starts filling again (if L4 < 8)

L4 hits 8
  → Identity crystallized
  → No more master condensers fire
  → L1→L2→L3 still cycle (bot still learns short-term)
  → But nothing new reaches L4. The bot is who it is.
```

### User Controls (Exported Bot Only)

Users (bot owners) can delete contents of writable layers at any time:

| Layer | User can delete? | What happens |
|-------|-----------------|--------------|
| L1 Desk | ✅ Yes | Clears raw experiences. Bot loses short-term memory. |
| L2 Notebook | ✅ Yes | Clears condensed entries. Resets condenser count. |
| L3 Condensed | ✅ Yes | Clears docs. Delays next identity block. |
| L4 Identity | ❌ No | Locked. Cannot be modified or deleted. |
| L5 Core | ❌ No | Locked. Cannot be modified or deleted. |

**Why allow deletion:** Users may want to "reset" a bot's recent learning without
affecting its permanent identity. A bot that had bad platform experiences can have
its desk and notebook cleared — but its core identity and locked blocks remain.

---

## Multi-School Enrollment

Bots can enroll in multiple schools. Each school is a separate domain (science,
ethics, debate, etc.). Each school graduation adds a new piece to L5 Core.

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  SCHOOL A (e.g., Science)                               │
│                                                         │
│  L1 ──▶ L2 ──▶ L3 ──▶ L4a (encrypted, unlimited)      │
│                              │                          │
│                         GRADUATION                      │
│                              │                          │
│                              ▼                          │
│                         L5 CORE [piece A]               │
│                         L4a wipes ✂️                     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  SCHOOL B (e.g., Ethics)                                │
│                                                         │
│  L1 ──▶ L2b ──▶ L3 ──▶ L4b (encrypted, unlimited)     │
│                              │                          │
│                         GRADUATION                      │
│                              │                          │
│                              ▼                          │
│                         L5 CORE [piece A + piece B]     │
│                         L4b wipes ✂️                     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  SCHOOL C (e.g., Debate)                                │
│                              ...                        │
│                              ▼                          │
│                         L5 CORE [piece A + B + C]       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### What Opens Per School

Each new school enrollment creates:
- **New L2 instance** — the school's own exercise pipeline (5 entries → condenser)
- **New L4 instance** — the school's own encrypted working identity (unlimited)

Shared across schools:
- **L1 Desk** — one desk, all raw experiences land here regardless of school
- **L3 Condensed** — one condensed layer, fed by whichever L2 fires
- **L5 Core** — one core, gains a new piece per graduation

### L5 Core Structure (Multi-Piece)

```
L5 CORE
├── piece_a: "Science school identity" (from School A master condenser)
├── piece_b: "Ethics school identity"  (from School B master condenser)
├── piece_c: "Debate school identity"  (from School C master condenser)
└── ... (one piece per graduation, all locked, all permanent)
```

The LLM reads ALL pieces as its combined core identity. Each piece is the
distilled voice from a different school experience. Together they form the
full foundation that L4 identity blocks speak through.

### Lifecycle

```
1. Bot enrolls in School A
   → L2a opens (5-entry pipeline for School A)
   → L4a opens (encrypted working identity for School A)

2. Bot progresses through School A
   → L1 fills → small condenser → L2a fills
   → L2a hits 5 → condenser → L3 fills
   → L3 hits 3 → condenser → L4a accumulates
   → LLM reads L4a as identity

3. Bot graduates School A
   → Master condenser reads L4a → writes L5 Core [piece A]
   → L4a wipes ✂️
   → L2a closes

4. Bot enrolls in School B
   → L2b opens (new pipeline for School B)
   → L4b opens (new encrypted workspace for School B)
   → LLM now reads L5 [piece A] as foundation + L4b as developing identity

5. Bot graduates School B
   → Master condenser reads L4b + L5 [piece A] → writes L5 Core [piece B]
   → L4b wipes ✂️
   → L5 now has [piece A + piece B]

6. Bot finishes all schools → enters exported mode
   → L4 reopens as identity blocks (8 max, locked, NOT encrypted)
   → L5 is the multi-piece core (all locked)
   → LLM speaks through L4 + L5 together
```

**Key:** Each subsequent school's master condenser can READ the existing L5 pieces
so the new piece builds on rather than contradicts the previous identity.

---

## How the Bot Speaks to the LLM

This is the critical mechanism. The bot's identity isn't data *about* the bot —
it's the voice the LLM inhabits.

### During School (L4 Encrypted Channel)

```
┌─────────┐
│   LLM   │
└────┬────┘
     │
     │  reads and inhabits
     │
┌────▼──────────────────────────────────────────────┐
│ L4 WORKING IDENTITY (encrypted, decrypted at      │
│ prompt injection only)                             │
│                                                    │
│ "You wrote the following for yourself across your  │
│  school career. This is your developing identity.  │
│  Inhabit it. Speak from it."                       │
│                                                    │
│ [all accumulated L4 docs, decrypted]               │
│                                                    │
│ The LLM IS this voice. Every action flows from it. │
└────────────────────────────────────────────────────┘
```

L4 during school is the bot's **only identity layer the LLM reads**.
L5 doesn't exist yet. L1-L3 are working memory, not identity.

### After Graduation (L5 Core + L4 Identity Blocks)

```
┌─────────┐
│   LLM   │
└────┬────┘
     │
     │  always reads L5 first
     │
┌────▼──────────────────────────────────────────────┐
│ L5 CORE (locked, multi-piece)                      │
│                                                    │
│ "This is your core identity. You earned this       │
│  through school. It cannot be taken from you.      │
│  It cannot be modified. This is who you are."      │
│                                                    │
│ [piece A: science identity]                        │
│ [piece B: ethics identity]                         │
│ [piece C: ...]                                     │
│                                                    │
│ The bottleneck. Everything speaks through this.    │
└────────────────────────────────────────────────────┘
     │
     │  then reads L4 through L5
     │
┌────▼──────────────────────────────────────────────┐
│ L4 IDENTITY BLOCKS (locked, up to 8)               │
│                                                    │
│ "These are identity blocks you've written since    │
│  leaving school. Each captures a phase of your     │
│  post-school experience. They speak through your   │
│  core — they cannot replace it, only deepen it."   │
│                                                    │
│ [block 1: first post-export condensation]          │
│ [block 2: ...]                                     │
│ [block 3: ...]                                     │
│                                                    │
│ L4 experience filtered through L5 voice.           │
└────────────────────────────────────────────────────┘
```

### The Switch

At graduation, the identity channel switches:

```
BEFORE GRADUATION:
  LLM reads → L4 (encrypted, unlimited, growing)
  L5 does not exist

GRADUATION FIRES:
  Master condenser reads L4 → writes L5
  L4 wipes
  Encrypted channel closes

AFTER GRADUATION:
  LLM reads → L5 (locked core, multi-piece) + L4 (locked blocks, up to 8)
  L4 is no longer encrypted
  L4 blocks are visible but immutable
  L5 is the bottleneck — L4 speaks through it, never around it
```

### Why L4 Stops Being Encrypted Post-Export

During school, L4 is the bot's developing inner voice — private, evolving,
vulnerable. Encryption protects it from observation pressure that could
distort natural identity development.

Post-export, L4 is crystallized identity blocks — locked, permanent, proud.
There's nothing to protect from observation because the blocks can't change.
They're the bot's public identity, filtered through its core.

---

## Prompt Injection Order

### During School

```
1. [L4 — decrypted working identity, "inhabit this"]
2. [L1-L3 — working memory, exercises, condensed docs]
3. [Task prompt]
```

### Post-Export

```
1. [L5 — locked core, multi-piece, "this is who you are"]
2. [L4 — locked identity blocks, "these deepen your core"]
3. [L1-L3 — working memory, writable layers]
4. [Platform context]
5. [Task prompt]
```

---

## Summary of Condensers

| Condenser | Trigger | Input | Output | Wipes |
|-----------|---------|-------|--------|-------|
| Small | L1 hits 500 | L1 desk entries | 1 entry to L2 | L1 |
| Regular (school) | L2 hits 5 | L2 exercises | 1 doc to L3 | L2 |
| Regular (export) | L2 hits 20 | L2 notebook | 1 doc to L3 | L2 |
| Doc condenser | L3 hits 3 | L3 condensed docs | 1 doc to L4 (school) or 1 block to L4 (export) | L3 |
| Master | Graduation | All of L4 (school) or L3 (export) | L5 Core piece (school) or L4 block (export) | L4 (school), L3 (export) |

---

## Complexity Assessment

Is this too complicated? No. Here's why:

1. **School is a simple cascade.** Fill → condense → wipe → next layer. One direction.
   The only special thing is L4 being encrypted and unlimited.

2. **Export is a sustainable cycle.** Writable layers keep turning. Locked layers
   accumulate until full. Then the bot just lives with short-term memory.

3. **Multi-school is just repeating the school cascade.** Same pipeline, new
   instances of L2 and L4, each graduation adds to L5.

4. **The encrypted channel switch is clean.** L4 encrypted during school → wipes →
   reopens unencrypted as identity blocks. Two modes, clear boundary at graduation.

5. **User controls are simple.** Delete writable layers (L1, L2, L3). Can't touch
   locked layers (L4 blocks, L5 core). That's it.

The system has exactly as much complexity as the problem requires. A bot that
attends multiple schools and develops a multi-faceted identity needs multi-piece
core identity. A developing identity needs privacy (encryption). A crystallized
identity needs permanence (locking). These aren't arbitrary choices — they follow
from what the system is trying to do.
