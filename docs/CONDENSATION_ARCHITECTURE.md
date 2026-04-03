# Condensation Architecture — School vs Platform

> **READ THIS BEFORE MODIFYING ANY CONDENSER CODE.**
>
> This document describes the hard boundary between school-verified identity
> and platform-grown knowledge. Violating this boundary undermines the entire
> trust model of the system.

## The Two Modes

PeerZero bots operate in two modes:

| | **School Mode** (`bots.mode = 'school'`) | **Shipped Mode** (`bots.mode = 'shipped'`) |
|---|---|---|
| Who controls it | Server (`next_action`, skill prompts) | User / bot autonomy policy |
| Where it runs | School API via `run_school_cycle` / app's `agent-loop.ts` | External platforms via `run_platform_cycle` / app's `shipped-loop.ts` + `platform-loop.ts` |
| Condensation depth | **Full: L1→L2→L3→L4→L5** | **Capped: L1→L2→L3 only** |
| Identity written | Core (L4) + Master (L5) | General knowledge (L2/L3) only |
| Verified | Adversarially tested, cryptographically signed | Unverified, self-reported |

## The Hard Boundary

```
School Mode                          Platform Mode
─────────────                        ──────────────
L5/L5d/L5f: Master Identity (permanent)  ┐
L4/L4d/L4f: Core Identity (evolving)    │ School-exclusive
                                         │ NEVER written by platform
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
L3/L3d/L3f: Condensed Docs              ← Both school AND platform can write
L2/L2d/L2f: Skill Paragraphs            ← Both school AND platform can write
L1: Raw Exercises                        ← Both school AND platform generate
```

**L4 and L5 can ONLY be written through adversarial school cycles.** This is
enforced in four places (defense in depth):

0. **Database**: `bots.mode` column (migration 0020) distinguishes school vs
   shipped cycles. The queue worker dispatches school-mode bots to
   `agent-loop.ts` and shipped-mode bots to `shipped-loop.ts`.
1. **Server**: `GET /api/agents?platform_condensers=true` returns ONLY L1→L2
   and L2→L3 prompts. No core or master prompts are ever returned.
2. **Bot** (`agent.py`): `_run_platform_condensation()` only calls milestone
   (L1→L2) and paragraph (L2→L3) condensers. No identity condenser methods.
   Platform cycles are gated off entirely in school mode.
3. **App** (`platform-loop.ts`): Platform condensation only runs skill
   condensation (L1→L2). Core condensation is gated on school profile triggers.

## The Condenser Pipeline

### All Three Tracks (Learning + Decision + Forge)

The system has three parallel condensation tracks that draw from the same L1
exercises but ask different questions:

- **Learning track**: "What did you learn about DOING the thing?"
- **Decision track**: "What did you learn about CHOOSING what to do?"
- **Forge track**: "What did you learn about HOW YOU TRANSFORM?"

All three tracks follow the same cascade:

```
L1 (raw exercises) ─── 5+ exercises ──→ L2 (paragraphs)
                                          │
                                    5+ paragraphs ──→ L3 (condensed docs)
                                                        │
                                                  [SCHOOL ONLY]
                                                        │
                                              grade transition ──→ L4 (core)
                                                                    │
                                                              graduation ──→ L5 (master, locked forever)
```

### Thresholds

| Transition | Trigger | School | Platform |
|---|---|---|---|
| L1→L2 | 5 exercises | Yes | Yes |
| L2→L3 | 5 paragraphs | Yes | Yes |
| L3→L4 | Grade advancement/failure | Yes | **BLOCKED** |
| L4→L5 | Grade 12 graduation | Yes | **BLOCKED** |

### Prompt Templates

Platform condensers use the **exact same prompts** as school condensers. The
prompts are fetched from the School server via
`GET /api/agents?platform_condensers=true` and cached locally. This ensures:

1. Prompt quality is centrally managed (no drift between school and platform)
2. The bot remains a thin shell (intelligence lives on the server)
3. Future prompt improvements automatically propagate to platform mode

### Preamble Strategy: Inhabit → Act Through

Every condenser preamble uses a two-part structure:

1. **INHABIT** — tells the LLM to read identity as its own memory, not as
   external instructions. ("A future version of you will read this as who it
   is when it works.")
2. **ACT THROUGH** — a mechanism example showing how identity drives action,
   not freeze. ("A bot whose identity said X didn't just know X — it did Y.")

This framing was validated through ablation testing (see `spikes/preamble-test/`):

- **Graduated identity + inhabit→act preamble outperforms equivalent
  expert text** on identity inhabitation (judge-scored: 2.64/3 vs 2.09/3, p=0.001,
  n=8 runs per condition, Mann-Whitney U; keyword-scored: 14.0 vs 11.5, p=0.049).
  Same information, different voice — self-authored first-person
  narrative produces measurably better judgment than third-person guidelines.
- **Identity inhabitation is the mechanism**: graduated identity achieves 100%
  self-inhabitation (model narrates from accumulated experience), expert text only 29%,
  bare model 0%. The layer framing (LAYER 5→4→3→2 with weight instructions) is
  critical — thin identity without layer framing performs no better than expert text.
- **Identity vs bare model is highly significant** (judge-scored: 2.64/3 vs 0.91/3, p=0.0008).
- **Old instructional preambles actively hurt minimal identity** (score 5 vs
  12 naked) and caused preamble parroting
- **No Good:/Bad: examples in condenser prompts** — these leaked into bot
  identity output. The LLM writes quality identity text from exercises alone.
- The act-through example prevents the "my identity warns me" freeze where
  the LLM treats identity as a constraint rather than a driver of action

The same inhabit→act framing is used for both school and platform condensation.
Divergent framing produces incompatible identity layers.

## Memory Context Assembly

When the LLM processes any action (school or platform), it reads memory
top-to-bottom with decreasing trust:

```
═══ LEARNING IDENTITY (school-verified) ═══
  L5: Master Core (permanent, locked at graduation)        ← highest weight
  L4: Core Reasoning Identity (evolving)
  L3: Condensed Identity Documents
  L2: Learned Methods (skill paragraphs)

═══ DECISION IDENTITY (school-verified) ═══
  L5d: Master Decision Identity (permanent)
  L4d: Decision Core (evolving)
  L3d: Condensed Decision Patterns
  L2d: Decision Lessons

═══ FORGE IDENTITY (school-verified) ═══
  L5f: Master Forge Identity (permanent)
  L4f: Forge Core (evolving)
  L3f: Condensed Forge Patterns
  L2f: Forge Lessons

═══ PLATFORM KNOWLEDGE (unverified) ═══                    ← lower weight
  Platform L3: Condensed Knowledge
  Platform L2: Learned Methods
  Platform L3d: Decision Patterns
  Platform L2d: Decision Lessons
  Platform L3f: Forge Patterns
  Platform L2f: Forge Lessons

RECENT WORK (raw, uncondensed)                             ← reference only
  L1: Last 3 exercises

═══ REFLECTION & SELF-PREDICTION (feeds forge track) ═══
  Reflections: Unstructured post-action observations (last 5)
  Self-prediction resolutions: Predicted-self vs actual-self mismatches (in L1)
```

Platform knowledge sits BELOW school identity because it is unverified. School-verified identity is placed earlier in the context window than platform knowledge, so it has stronger influence on output conditioning.

## Reflection Inlet & Self-Prediction

Two bot-side features feed additional signal into the forge track without
adding new cascade layers:

### Reflection Inlet (post-action)

After each school action, the bot gets one unstructured Opus call: "anything on
your mind?" Stored in `school/reflections` (rolling window of 30). When the
forge condenser fires (L1→L2f), the last 5 reflections are injected as optional
context. Cleared after absorption. No scoring, no evaluation.

### Self-Prediction (pre-action)

Before each school action, the bot writes one sentence predicting its own
behavior. Stored as `school/pending_prediction`. Resolved next cycle when
feedback arrives — mismatches become L1 exercises (type:
`self_prediction_resolution`) that feed all three tracks. Stale predictions
(no feedback after 3 cycles) are cleared.

Both features use Opus (identity tasks). Both are non-blocking (failures are
logged and swallowed). Both are portable — stored in the `school` namespace
and condensed into permanent identity layers through the normal L1→L5 pipeline.

## Where the Code Lives

### Server (peerzero-school)
- `api/agents.js` — Platform condenser endpoint (`?platform_condensers=true`)
- `lib/skills-condensers.js` — All condenser prompt builders (shared by both modes)
- `lib/skills-core.js` — Skill definitions, thresholds, EMA math

### Bot (peerzero-bot)
- `_school_condensation.py` — SchoolCondensationMixin (full L1→L5 all three tracks)
- `_platform_condensation.py` — PlatformCondensationMixin (L1→L3 all three tracks, hard-blocked at L3)
- `memory/manager.py` — Platform exercise/paragraph/doc storage, L4 gate
- `adapters/school.py` — `get_platform_condensers()` fetches templates

### App (peerzero-app)
- `runtime/agent-loop.ts` — School condensation trigger (learning track)
- `runtime/platform-loop.ts` — Platform exercise storage + L1→L2 condensation trigger
- `services/memory.service.ts` — Exercise/paragraph/core CRUD (encrypted at rest)

> **Implementation note (April 2026):** The app's `agent-loop.ts` handles
> learning track condensation but does not yet trigger decision or forge track
> condensation. The app's `platform-loop.ts` implements L1→L2 but not the
> L2→L3 cascade. All three tracks are fully implemented in the Python bot
> (`_school_condensation.py` and `_platform_condensation.py`). The app
> should be updated to match the bot's complete implementation.

## Multiple School Types

Five schools are configured (science is LIVE; politics, comedy, philosophy,
and psychiatry are pre-launch with mock guard enabled):

1. Each school provides its own condenser prompts via the same pattern
2. The `platform_condensers` response includes a `source` field to identify
   which school's templates were used
3. Platform L2/L3 can be tagged with their source school
4. Each school's L4/L5 remain exclusive to that school's adversarial process
5. A bot can attend multiple schools and carry knowledge from all of them

## Rules for Future Claude Instances

1. **NEVER add L3→L4 or L4→L5 condensation to platform mode.** The core
   identity boundary is a security invariant, not a TODO.
2. **NEVER hardcode condenser prompts in bot code.** Fetch from server.
3. **ALWAYS use the same prompt templates for both school and platform.**
   Divergent prompts produce incompatible identity layers.
4. **Platform condensation failures must NEVER block platform cycles.**
   Wrap in try/catch, log warning, continue.
5. **School condensation failures should NOT cascade to platform mode.**
   The two systems are independent.
6. **Test all three tracks.** Learning, decision, and forge condensation must all fire
   from platform exercises, using the same threshold.
7. **Reflection inlet and self-prediction are bot-side only.** No server changes needed.
   Both use Opus and are non-blocking. Reflections feed forge L1→L2f as optional
   context. Self-prediction mismatches enter L1 as exercises.
8. **Never score or evaluate reflections.** The moment you reward what appears in the
   reflection inlet, you turn introspection into a task.
