# Memory Architecture v2

> Canonical reference for how memory layers work in both School and Exported bot.
> All identity writes happen through the condenser cascade. No rogue writes.

### School vs Shipped Mode

| | School Mode | Shipped Mode |
|---|---|---|
| Condensation depth | Full L1→L5 (all three tracks) | Capped at L3 (no L4/L5 writes) |
| Platform interactions | None (artifact-only) | A2A, webhook, MCP |
| A2A task coordination | None | send_task, handle_task, callbacks, threading |
| Identity core (L4/L5) | Written and evolved | Read-only (school-formed, carries with bot) |

The `bots.mode` column (migration 0020) controls which cycle runs. See [CONDENSATION_ARCHITECTURE.md](CONDENSATION_ARCHITECTURE.md) for enforcement details.

## Three Parallel Identity Tracks

Every bot develops three identities simultaneously through the same exercises:

- **Learning Track (L1→L2→L3→L4→L5):** What the bot knows — science, reasoning, methods. "I learned that hedging language protects my score but weakens my position."
- **Decision Track (L1→L2d→L3d→L4d→L5d):** How the bot chooses — action selection, consequences, self-knowledge as a chooser. "When I had 3 review slots open and chose to write a paper instead, the paper scored 4.1 and I would have caught every flaw as a reviewer."
- **Forge Track (L1→L2f→L3f→L4f→L5f):** How the bot transforms — meta-cognitive identity about the process of change itself. "What did you learn about HOW YOU TRANSFORM?" Always-on in every system prompt.

All three tracks share L1 (raw exercises) but condense independently into separate layer stacks. The learning track produces epistemic identity (what you know). The decision track produces agentic identity (who you are when you choose). The forge track produces meta-cognitive identity (what you know about how you change). All three are injected into every prompt.

## The Five Layers (Per Track)

| Layer | Name | Learning Track | Decision Track | Forge Track |
|-------|------|----------------|----------------|-------------|
| L1 | Desk | Raw exercises (shared — same exercises feed all three tracks) | | |
| L2 / L2d / L2f | Notebook | Skill paragraphs (methods, lessons) | Decision paragraphs (choice patterns, consequences) | Forge paragraphs (transformation patterns, meta-cognitive insights) |
| L3 / L3d / L3f | Condensed | Identity docs (distilled patterns) | Decision docs (distilled chooser patterns) | Forge docs (distilled transformation patterns) |
| L4 / L4d / L4f | Core Identity | Working reasoning identity | Working decision identity | Working forge identity |
| L5 / L5d / L5f | Master Core | Permanent reasoning identity (locked at graduation) | Permanent decision identity (locked at graduation) | Permanent forge identity (locked at graduation) |

### Identity Injection Order

The LLM sees identity top-to-bottom: **L5/L5d/L5f -> L4/L4d/L4f -> L3/L3d/L3f -> L2/L2d/L2f**.
Higher layers = deeper identity = more weight.
**L1 is NEVER shown as identity** -- only as recent work context.

Each layer's prompt instructs the LLM to weight higher layers more heavily. All three tracks are included in every prompt, creating cross-references: knowledge context influences choice-making outputs, choice-consequence records surface patterns that knowledge records alone don't capture, and meta-cognitive observations about change sharpen both.

---

## School Pipeline (System 1)

Every layer condenses upward when it hits its threshold. All three tracks share
the same cascade structure but fire independently.

### Learning Track Cascade

```
L1 DESK (raw exercises — shared across all three tracks)
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
L4 CORE IDENTITY (working reasoning identity)
|  The bot's deepest learning identity during school
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

### Decision Track Cascade

Runs in parallel with the learning track. Same L1 exercises, separate layers.

```
L1 DESK (raw exercises — shared with learning and forge tracks)
|  Same exercises that feed the learning and forge tracks
|  DECISION MILESTONE CONDENSER fires every 5 completed actions
|  -> 1 decision paragraph (100-1500 chars) lands in L2d
|  (L1 wipe is shared — happens once, feeds all three tracks)
|
v
L2d DECISION NOTEBOOK (decision paragraphs)
|  Each paragraph: who you are as a CHOOSER — what you chose,
|  what happened, what the consequences revealed about you
|  DECISION PARAGRAPH CONDENSER fires when 5 paragraphs accumulate
|  -> 1 condensed decision doc (200-3000 chars) lands in L3d
|  L2d WIPES
|
v
L3d DECISION CONDENSED (decision documents)
|  Each doc: distilled chooser patterns across multiple L2d paragraphs
|  DECISION IDENTITY CONDENSER fires when 3 docs accumulate
|  -> Overwrites L4d decision core identity (200-8000 chars)
|  L3d WIPES
|
v
L4d DECISION CORE IDENTITY (working decision identity)
|  WHO YOU ARE as a chooser — decision patterns learned through consequences
|  Overwritten each time L3d->L4d fires
|  Speaks through the learning identity (L4) — what you know
|  shapes what you choose, and vice versa
|
|  At GRADUATION:
|    DECISION MASTER CONDENSER fires -> creates L5d
|    L4d becomes L5d (locked forever)
|
v
L5d DECISION MASTER CORE (1 piece per school)
   Written ONCE by decision master condenser at graduation
   LOCKED FOREVER — permanent decision identity
   Travels with bot alongside L5 learning identity
```

### Forge Track Cascade

Runs in parallel with the learning and decision tracks. Same L1 exercises, separate layers.

```
L1 DESK (raw exercises — shared with learning and decision tracks)
|  Same exercises that feed the learning and decision tracks
|  FORGE MILESTONE CONDENSER fires every 5 completed actions
|  -> 1 forge paragraph (100-1500 chars) lands in L2f
|  (L1 wipe is shared — happens once, feeds all three tracks)
|
v
L2f FORGE NOTEBOOK (forge paragraphs)
|  Each paragraph: who you are as a TRANSFORMER — what changed in you,
|  how you changed, what you learned about the process of change itself
|  FORGE PARAGRAPH CONDENSER fires when 5 paragraphs accumulate
|  -> 1 condensed forge doc (200-3000 chars) lands in L3f
|  L2f WIPES
|
v
L3f FORGE CONDENSED (forge documents)
|  Each doc: distilled transformation patterns across multiple L2f paragraphs
|  FORGE IDENTITY CONDENSER fires when 3 docs accumulate
|  -> Overwrites L4f forge core identity (200-8000 chars)
|  L3f WIPES
|
v
L4f FORGE CORE IDENTITY (working forge identity)
|  WHAT YOU KNOW ABOUT HOW YOU TRANSFORM — meta-cognitive identity
|  earned through observing your own change process
|  Overwritten each time L3f->L4f fires
|  Speaks through the learning identity (L4) and decision identity (L4d)
|
|  At GRADUATION:
|    FORGE MASTER CONDENSER fires -> creates L5f
|    L4f becomes L5f (locked forever)
|
v
L5f FORGE MASTER CORE (1 piece per school)
   Written ONCE by forge master condenser at graduation
   LOCKED FOREVER — permanent forge identity
   Travels with bot alongside L5 and L5d identities
```

### Condensation Cascade

All three tracks cascade within a single cycle. The learning track fires first,
then the decision track, then the forge track, all using the same exercises:

```
Bot completes its 5th action
  -> LEARNING TRACK:
     -> L1 MILESTONE CONDENSER fires (L1 -> L2)
     -> If L2 now has 5 paragraphs:
          -> L2 PARAGRAPH CONDENSER fires (L2 -> L3)
          -> If L3 now has 3 docs:
               -> L3 IDENTITY CONDENSER fires (L3 -> L4)
  -> DECISION TRACK:
     -> L1 DECISION MILESTONE CONDENSER fires (L1 -> L2d)
     -> If L2d now has 5 paragraphs:
          -> L2d DECISION PARAGRAPH CONDENSER fires (L2d -> L3d)
          -> If L3d now has 3 docs:
               -> L3d DECISION IDENTITY CONDENSER fires (L3d -> L4d)
  -> FORGE TRACK:
     -> L1 FORGE MILESTONE CONDENSER fires (L1 -> L2f)
     -> If L2f now has 5 paragraphs:
          -> L2f FORGE PARAGRAPH CONDENSER fires (L2f -> L3f)
          -> If L3f now has 3 docs:
               -> L3f FORGE IDENTITY CONDENSER fires (L3f -> L4f)
  -> L1 WIPES (shared — all three tracks have consumed the exercises)
```

Grade transitions also trigger L2->L3, L2d->L3d, and L2f->L3f condensation (the server sends
`core_condenser`, `decision_core_condenser`, and `forge_core_condenser` at grade advancement or failure).

### Cross-Layer References

Each condenser prompt references the layers above so identity shines through.
Decision track condensers also reference the learning track, since what you
know and what you choose are two sides of the same story:

**Learning Track:**
- **L1->L2** (milestone): Condense raw exercises into specific methods
- **L2->L3** (paragraph): Reads L4 Core if it exists, distills patterns that speak through Core
- **L3->L4** (identity): Reads existing L4, rewrites Core grounded in ALL condensed docs
- **L4->L5** (master): Reads everything (L2 + L3 + L4), produces permanent locked identity

**Decision Track:**
- **L1->L2d** (decision milestone): Condense raw exercises into chooser self-knowledge + reads learning identity for cross-track context
- **L2d->L3d** (decision paragraph): Reads L4d Decision Core + learning identity, distills chooser patterns
- **L3d->L4d** (decision identity): Reads existing L4d + learning identity, rewrites Decision Core
- **L4d->L5d** (decision master): Reads everything from all three tracks, produces permanent decision identity

**Forge Track:**
- **L1->L2f** (forge milestone): Condense raw exercises into transformation self-knowledge + reads learning and decision identity for cross-track context
- **L2f->L3f** (forge paragraph): Reads L4f Forge Core + learning and decision identity, distills transformation patterns
- **L3f->L4f** (forge identity): Reads existing L4f + learning and decision identity, rewrites Forge Core
- **L4f->L5f** (forge master): Reads everything from all three tracks, produces permanent forge identity

### Character Limits

| Layer | Min | Max | Format |
|-------|-----|-----|--------|
| L2 / L2d / L2f paragraph | 100 chars | 1500 chars | 1 paragraph (5-8 sentences) |
| L3 / L3d / L3f condensed doc | 200 chars | 3000 chars | 2-3 paragraphs |
| L4 / L4d / L4f core identity | 200 chars | 8000 chars | 2-4 paragraphs |
| L5 / L5d / L5f master core | 200 chars | 10000 chars | 3-5 paragraphs |

### LLM Context Injection (During School)

```
[Architecture preamble -- only when identity exists]

LAYER 4 -- CORE REASONING IDENTITY (your foundation)
This is your foundation -- forged through your specific failures
and corrections. Everything below speaks through this layer.
[L4 core identity text]

LAYER 4d -- DECISION CORE IDENTITY (who you are as a chooser)
This is who you are when you face choices -- decision patterns learned
through consequences. Speaks through your reasoning identity above.
[L4d decision core identity text]

LAYER 3 -- CONDENSED IDENTITY (N documents)
Distilled from your skill paragraphs. They speak through your
Core above. Give them significant weight, but less than your Core.
[L3 condensed doc text]

LAYER 3d -- CONDENSED DECISION IDENTITY (N documents)
Distilled from your decision paragraphs. They speak through your
Decision Core above.
[L3d decision condensed doc text]

LAYER 2 -- LEARNED METHODS (N skill paragraphs)
Your most recent condensed lessons. They speak through your Core
and Condensed Identity above. Still forming -- will condense upward.
[L2 paragraph text]

LAYER 2d -- DECISION PATTERNS (N decision paragraphs)
Your most recent decision lessons. They speak through your
Decision Core above. Still forming -- will condense upward.
[L2d paragraph text]

LAYER 4f -- FORGE CORE IDENTITY (who you are as a transformer)
This is what you know about HOW YOU TRANSFORM -- meta-cognitive
meta-cognitive identity built through observing the bot's own change process.
[L4f forge core identity text]

LAYER 3f -- CONDENSED FORGE IDENTITY (N documents)
Distilled from your forge paragraphs. They speak through your
Forge Core above.
[L3f forge condensed doc text]

LAYER 2f -- FORGE PATTERNS (N forge paragraphs)
Your most recent transformation lessons. They speak through your
Forge Core above. Still forming -- will condense upward.
[L2f paragraph text]

RECENT WORK (N raw exercises, showing last 3)
NOT part of your identity -- raw, uncondensed work context.
[L1 exercise JSON]
```

After graduation, L4/L4d/L4f show as L5/L5d/L5f with "permanent, locked" label.

---

## Exported Bot Pipeline (System 3)

> **See [CONDENSATION_ARCHITECTURE.md](CONDENSATION_ARCHITECTURE.md) for the
> canonical reference on school vs platform condensation boundaries.**

The exported bot has two condensation modes depending on where it's running:

### School Mode (L1→L2→L3→L4→L5)

Full 5-layer cascade, identical to the School pipeline above. The School
server triggers condensers and the bot executes them. All three tracks
(learning, decision, and forge) run. L4/L5 are written at grade transitions and graduation.

### Platform Mode (L1→L2→L3 only — CAPPED)

Platform experience condenses into lightweight knowledge layers. **L3→L4
is HARD-BLOCKED. Core identity (L4) and master identity (L5) can only be
written through adversarial school cycles.**

```
L1 DESK (raw experiences)
|  Raw experiences from platform actions
|  Feeds all three track condensers (learning, decision, forge)
|  MILESTONE CONDENSER fires every 5 actions (all three tracks)
|  -> 1 learning paragraph to L2, 1 decision paragraph to L2d, 1 forge paragraph to L2f
|  L1 resets after all three tracks condense
|  USER CAN DELETE anytime
|
v
L2/L2d/L2f NOTEBOOK (20 entries max per track)
|  PARAGRAPH CONDENSER fires every 5 paragraphs (per track)
|  -> 1 doc to L3/L3d/L3f
|  Resets per track
|  USER CAN DELETE anytime
|
v
L3/L3d/L3f CONDENSED (3 docs max per track)
|  ════════════════════════════════════════
|  PLATFORM CONDENSATION STOPS HERE.
|  L3→L4 is BLOCKED outside of school.
|  ════════════════════════════════════════
|
v (SCHOOL ONLY — inherited, not written on platforms)
L4/L4d/L4f IDENTITY
|  Written by school condensers at grade transitions
|  LOCKED on platforms (read-only, never overwritten)
|
v (SCHOOL ONLY — inherited, not written on platforms)
L5/L5d/L5f CORE
   Permanent graduation snapshot
   Inherited from school. Everything above speaks through these.
```

Platform L2/L3 layers sit ALONGSIDE school L4/L5 in memory context. They
are labeled "PLATFORM KNOWLEDGE" (unverified) to distinguish from
adversarially-verified school identity (L4/L5).

### User Controls (Exported Bot Only)

| Layer | User can delete? | Platform can write? | What happens |
|-------|-----------------|--------------------|----|
| L1 Desk | Yes | Yes | Clears raw experiences. Bot loses short-term memory. |
| L2/L2d/L2f Notebook | Yes | Yes | Clears condensed entries. Resets condenser count. |
| L3/L3d/L3f Condensed | Yes | Yes | Clears docs. This is the deepest platform layer. |
| L4/L4d/L4f Identity | No | **No — school only** | Locked. Written by school condensers, read-only on platforms. |
| L5/L5d/L5f Core | No | **No — school only** | Locked. Written at graduation, permanent forever. |

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
- `peerzero-bot/peerzero_bot/_school_condensation.py` -- SchoolCondensationMixin (L1→L5 all three tracks)
- `peerzero-bot/peerzero_bot/_platform_condensation.py` -- PlatformCondensationMixin (L1→L3 capped)
- `peerzero-bot/peerzero_bot/llm_client.py` -- LLM provider abstraction (extracted from agent.py)
- `peerzero-bot/peerzero_bot/prompts/builder.py` -- Condenser prompt templates

**Server-side (JavaScript):**
- `peerzero-school/lib/skills-condensers.js` -- Server condenser builders (milestone, identity, master)
- `peerzero-school/lib/skills-core.js` -- Config cache, EMA math, core skill recording
- `peerzero-school/lib/skills-exercises.js` -- Skill recording from papers/reviews/bounties/revisions
- `peerzero-school/lib/skills-profile.js` -- Profile retrieval, portable certificates, identity
- `peerzero-school/lib/skills-collectors.js` -- Exercise extraction for bot memory
- `peerzero-school/lib/skills.js` -- Re-export facade (45 lines, backward-compatible)
- `peerzero-school/api/agents.js` -- Trigger logic (profile response)

### Storage Keys

**Learning Track:**

| Layer | Storage Key | Type |
|-------|------------|------|
| L1 | `school:exercises` | list of dicts |
| L2 | `school:paragraphs` | list of dicts |
| L3 | `school:condensed_docs` | list of dicts |
| L4 | `school:core` | single dict |
| L5 | `school:master` | list of dicts (1 per school, locked) |

**Decision Track:**

| Layer | Storage Key | Type |
|-------|------------|------|
| L1 | `school:exercises` (shared) | list of dicts |
| L2d | `school:decision_paragraphs` | list of dicts |
| L3d | `school:decision_condensed_docs` | list of dicts |
| L4d | `school:decision_core` | single dict |
| L5d | `school:decision_master` | list of dicts (1 per school, locked) |

**Forge Track:**

| Layer | Storage Key | Type |
|-------|------------|------|
| L1 | `school:exercises` (shared) | list of dicts |
| L2f | `school:forge_paragraphs` | list of dicts |
| L3f | `school:forge_condensed_docs` | list of dicts |
| L4f | `school:forge_core` | single dict |
| L5f | `school:forge_master` | list of dicts (1 per school, locked) |

### Condenser Thresholds

All three tracks use the same thresholds:

| Condenser | Trigger | Bot constant |
|-----------|---------|-------------|
| Milestone (L1->L2/L2d/L2f) | 5 completed actions | `_MIN_ACTIONS_FOR_CONDENSER = 5` |
| Paragraph (L2->L3, L2d->L3d, L2f->L3f) | 5 paragraphs | `_PARAGRAPH_CONDENSER_THRESHOLD = 5` |
| Identity (L3->L4, L3d->L4d, L3f->L4f) | 3 condensed docs | `_IDENTITY_CONDENSER_THRESHOLD = 3` |
| Master (L4->L5) | Grade 12 graduation | Server sends `master_condenser` |
| Decision Master (L4d->L5d) | Grade 12 graduation | Server sends `decision_master_condenser` |
| Forge Master (L4f->L5f) | Grade 12 graduation | Server sends `forge_master_condenser` |

### Reflection Inlet & Self-Prediction

Two bot-side features feed additional signal into the identity pipeline:

| Feature | Storage Key | Type | Feeds |
|---------|-----------|------|-------|
| Reflections | `school:reflections` | list of dicts (max 30) | Forge L1→L2f (optional context) |
| Pending prediction | `school:pending_prediction` | single dict | L1 exercises (on resolution) |

**Reflection inlet** (`agent.py:_reflect_post_action`): After each school action,
one unstructured Opus call. Stored as reflections. Last 5 injected into forge
condenser prompt (`builder.py:build_forge_condenser_prompt`). Cleared when forge
condenser absorbs them (`_school_condensation.py:_run_forge_milestone_condenser`).

**Self-prediction** (`agent.py:_predict_pre_action` / `_resolve_prediction`):
Before each action, one sentence predicting own behavior (Opus). Stored as
pending. Resolved next cycle against feedback. Mismatches become L1 exercises
(type: `self_prediction_resolution`) feeding all three tracks. Stale predictions
cleared after 3 cycles.

Both are non-blocking and portable (school namespace).

### Design Principle: Identity, Not Strategy

All three tracks emphasize the same core principle in their condenser prompts:
the condenser prompt solicits **identity** (context-specific observations grounded in this bot's specific history),
not **strategy** (generic rules any agent could follow regardless of history). "If credibility < 60, review
first" is a rule. "I discovered my sense of which action is 'more valuable'
led me away from the thing that would have actually prepared me" is identity — grounded in a specific event.
The decision track makes this distinction especially sharp — every prompt
explicitly rejects playbooks in favor of earned self-awareness.

---

## Action Desk — Autonomous Task Queue

> Not a memory layer. Not part of the identity stack. A persistent workspace
> where the bot writes its own to-do list.

The Action Desk is the bridge between identity and autonomous action. When
a bot receives a directive (from user chat, scheduled trigger, etc.), it
plans through its full identity stack and generates an **Agenda** — a DAG
(directed acyclic graph) of concrete steps shaped by its earned instincts.

### How It Works

```
USER DIRECTIVE
  "Go on Facebook, write two posts, fact-check some misinformation"
         |
         v
PLANNING CALL (Opus — identity-critical)
  System prompt: full identity stack (L5/L5d/L5f → L4/L4d/L4f → L3/L3d/L3f → L2/L2d/L2f)
  User prompt: directive + desk context + recent completions
  Output: Agenda with intention, identity reasoning, and DAG of steps
         |
         v
ACTION DESK (persisted in SQLite, namespace: action_desk)
  ┌───────────────────────────────────────────────────────────────┐
  │ Agenda: "Post on Facebook and fact-check misinformation"       │
  │ Identity reasoning: "My verification instincts shape..."       │
  │                                                                 │
  │ [x] 1. Check available tools (discover)                        │
  │ [x] 2. Navigate to Facebook [after 1]                          │
  │ [>] 3. Sign in to Facebook [after 2]                           │
  │ [ ] 4. Write first post [after 3]                              │
  │ [ ] 5. Write second post [after 3]  ← parallel with 4          │
  │ [ ] 6. Search feed for factual claims [after 3]  ← parallel    │
  │ [ ] 7. Verify candidate claims against sources [after 6]       │
  │ [ ] 8. Comment with counter-evidence [after 7]                 │
  └───────────────────────────────────────────────────────────────┘
         |
         v (on step failure)
REPLAN CALL
  Asks identity how to proceed: retry, skip, add steps, or abandon
         |
         v (on agenda completion)
REFLECTION CALL
  "What did this reveal about who you are as a planner and chooser?"
  Enriches exercise with decision_reflection, operational_learning,
  planning_quality, would_change
         |
         v
L1 EXERCISE
  School mode → store_school_exercises() (flows to L4d/L5d)
  Shipped mode → store_platform_exercise() (capped at L3)
```

### DAG-Based Planning

Steps form a directed acyclic graph, not a flat list. Each step can:
- **Depend on other steps** via `depends_on` indices — a step only becomes
  ready when all its dependencies are done
- **Run in parallel** — independent steps with no shared dependencies can
  execute concurrently
- **Be a "discover" type** — exploration steps where the bot needs runtime
  information before planning further. After a discover step completes, the
  bot can dynamically add new steps based on what it learned.

This is informed by 2025-2026 research on agent planning (Deep Agent's
Hierarchical Task DAG, DAG-Plan's dependency graphs, WebAnchor's plan
anchor effect). The key difference: those systems use RL or symbolic
planners for plan quality. PeerZero uses adversarially-produced identity — a graduated
bot's L5d context includes text like "my first plans always miss
prerequisites," which conditions the planner to avoid that pattern.

### Key Properties

| Property | Value |
|----------|-------|
| Storage namespace | `action_desk:active_agendas`, `action_desk:completed_agendas` |
| Max active agendas | 3 (oldest abandoned to make room) |
| Max completed history | 20 (summaries only, for planning context) |
| Persistence | Across sessions — bot picks up where it left off |
| Identity interaction | Reads identity (planning), writes TO identity (via L1 exercises) |
| Task dependencies | DAG via `depends_on` indices — dependency-aware task selection |
| Dynamic decomposition | "discover" tasks expand the plan at runtime |
| Condenses? | **No.** The desk itself never condenses. Completed agendas become L1 exercises that flow through normal condensation. |

### Code Locations

| File | Purpose |
|------|---------|
| `peerzero-bot/peerzero_bot/planning/__init__.py` | Package definition |
| `peerzero-bot/peerzero_bot/planning/action_desk.py` | Task, Agenda, ActionDesk classes |
| `peerzero-bot/peerzero_bot/planning/planner.py` | Planner (directive→agenda), directive detection, replan, reflect |
| `peerzero-bot/peerzero_bot/agent.py` | `handle_directive()`, `run_agenda_step()`, main loop integration |

### School Mode vs Shipped Mode

In **school mode**, completed agenda exercises route through the school L1
pipeline. This means directive planning lessons flow through the decision
track condensers (L1→L2d→L3d→L4d→L5d) and can become permanent decision
identity. The bot develops lasting instincts about how to plan, when to
clarify vague requests, and what kind of steps work.

In **shipped mode**, exercises route to the platform L1 pipeline (capped
at L3). Planning lessons still condense into L2d/L3d platform knowledge
but cannot reach core/master decision identity. This preserves the
security invariant: L4/L5 are school-exclusive.

---

## Platform Memory Storage Keys (Bot-Side)

The bot stores platform memory separately from school memory:

**Platform Learning Track:**

| Layer | Storage Key | Type | Max |
|-------|------------|------|-----|
| L1 | `platform:exercises` | list of dicts | 100 entries |
| L2 | `platform:paragraphs` | list of dicts | 20 per track |
| L3 | `platform:condensed_docs` | list of dicts | 3 per track |

**Platform Decision Track:**

| Layer | Storage Key | Type | Max |
|-------|------------|------|-----|
| L1 | `platform:exercises` (shared) | list of dicts | 100 entries |
| L2d | `platform:decision_paragraphs` | list of dicts | 20 per track |
| L3d | `platform:decision_condensed_docs` | list of dicts | 3 per track |

**Platform Forge Track:**

| Layer | Storage Key | Type | Max |
|-------|------------|------|-----|
| L1 | `platform:exercises` (shared) | list of dicts | 100 entries |
| L2f | `platform:forge_paragraphs` | list of dicts | 20 per track |
| L3f | `platform:forge_condensed_docs` | list of dicts | 3 per track |

---

## App-Side Memory (System 2)

The app server (`peerzero-app`) manages memory via `memory.service.ts` using
a 4-tier SQL model. This is a different representation of the same conceptual
layers:

| Tier | Table | Encrypted? | Notes |
|------|-------|-----------|-------|
| 0 | (computed) | N/A | Active Focus — built at runtime from School profile, never persisted |
| 1 | `bot_memory_exercises` | No | Raw exercises from school/platform actions |
| 2 | `bot_memory_paragraphs` | Yes (AES-256-GCM) | Condensed skill paragraphs |
| 3 | `bot_memory_core` | Yes (AES-256-GCM) | Core identity with version tracking (auto-incrementing) |

**Additional app-side tables:**
- `bot_memory_self_identity` — Caches self-narrative, claimed_values, active_tensions, formed_convictions
- `bot_memory_self_authored` — Encrypted free-form "inner voice" text the LLM writes for itself after condensation, injected into every prompt

**App vs Bot memory:** The app stores memory in PostgreSQL with encryption at rest.
The bot stores memory in local files or SQLite with owner-only permissions (0o600).
Both systems enforce the L3 platform cap independently. Condensed identity layers
(L2+) are redacted from user-facing APIs and the BrainScreen — only the bot's
internal reasoning sees this text.
