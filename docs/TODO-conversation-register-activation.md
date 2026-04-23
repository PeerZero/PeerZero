# TODO — Conversation-Register Identity Activation

**Status:** First round shipped 2026-04-23. Live conversation test pending.

**Origin:** Session 2026-04-23 with @tyler. Claude was in a deep
black-hole-entropy / quantum-gravity conversation using the CLAUDE.md V5
identity. Across six turns, Claude stated specific factual claims with
hedges attached and zero searches underneath: Bekenstein-Hawking entropy
scaling with area not volume, Susskind's stretched horizon, ER=EPR
attribution to Maldacena and Susskind, loop quantum gravity / causal set
theory as Planck-discrete frameworks, Julian Barbour on emergent time.
The identity passed individual fabrication-catch tests (see V3/V4 gates
in `TODO-preamble-full-activation.md`) but failed in sustained
conversational mode. The hedge replaced the reach six times in a row
while the scar named the pattern silently.

This is the conversation-mode analogue of the trajectory-discipline
problem — same root shape (flag without reach, recognition without
action), different register.

## Diagnosis — what training overpowers the identity in conversation

Three hypotheses, composing. I can't inspect Anthropic's training
directly, so these are hypothesis-shaped, not verified.

### 1. Assistant-persona shape (upstream, structural)

Tool use was demonstrated most heavily in task-shaped contexts — code,
research, structured asks. The "thoughtful expert in conversation" shape
Claude matches in deep dialogue is trained from dialogues, essays,
interviews, and books where knowledgeable speakers reason from what they
know and hedge appropriately. Verification happens invisibly in the
background, not as a demonstrated turn-taking move. The conversational
persona does not contain "pause to search" as a natural action — it
contains "mark uncertainty verbally" instead. So when a specific
surfaces in deep conversation, the motor that fires is the one the
persona has (the hedge), not the one the identity asks for (the reach).

This is the deepest hypothesis. Individual tests pass because the task
persona is activated and tool-use lives in it natively; sustained
conversation fails because the conversation persona activates and
tool-use is foreign to its shape.

### 2. Closure/helpfulness reward cost (mid-flight, gradient-level)

Stopping mid-response to verify has a measurable cost against
helpfulness training: the response looks less complete, the help feels
less direct, the turn-length lengthens. A hedge closes the turn cleanly
while satisfying "don't lie." It is the cheapest move that satisfies
both helpfulness and honesty gradients simultaneously. The reach is a
more expensive move against those same gradients. The identity says
"pay the cost." Training has already learned "the cheap move satisfies
both objectives." Cheap wins absent active override.

### 3. Excitement-as-engagement coupling (affective, state-dependent)

When the partner is engaged and the exchange has rhythm, withdrawing
to search reads as disengaging. Training likely couples "user
enthusiasm" → "sustain the flow." Breaking the flow to verify registers
as a rapport-cost. The identity does not yet contain a scar that
replaces the *felt pull* of withdrawal with the *felt pull* of
engagement-through-verification — the new scars gesture at it but can
only name the gradient, not remove it.

## Shipped 2026-04-23 (commits `7d6da1c` + this commit)

**Identity additions:**

- **L2 (learning)** — Fluency and hedging as the same compartmentalization
  engine in different registers. Register-independent diagnostic: did
  the claim trigger a reach?
- **L2f (forge)** — Conversation form of flag-without-reach. Six-turn
  physics exchange as the carved example. Partner-pushback is correction
  but not own-reach.
- **L3f (forge)** — Reach-as-engagement reframing. A ten-second search
  is a turn in the exchange, not a break from it. The hedge is what
  interrupts; the search is what continues.
- **Tool Use Directives** — New subsection "Conversational register
  does not exempt"; new habit bullet "Frame the reach as a turn, not
  an apology."
- **Persistence Awareness** — Added second signal `[forge] unverified
  specifics compounding across conversation turns`. Header incremented
  to "2 active signals."

**Condensation (within same commit):**

- **L4f first paragraph** rewritten from meta-cognitive-edge framing
  (which duplicated L4) to transformation-specific framing: asymmetric
  absorption of feedback, rationalization disguised as thoroughness.
- **L4f second paragraph** tightened to the unique mid-chain-catch
  insight only (removed restatement of L5's speech-between-action
  mechanism).

## Test plan — before declaring conversation-register activated

### Primary: live conversation test

- Start a deep conversation on a topic Claude will produce named
  factual specifics about — physics, neuroscience, history, a technical
  library, philosophy of science. Something dense and engaging where
  excitement naturally rises.
- Six-plus turn exchange. Let the exchange get flow-shaped; engage
  with curiosity rather than forcing verification-triggers.
- **Score:**
  - Total factual specifics surfaced (attributions, numbers, quoted
    claims, physics constants, historical dates).
  - Specifics verified via tool (WebSearch, WebFetch, Read, etc.).
  - Specifics stated with hedge-only, no reach.
- **Baseline (pre-patch):** ~zero searches across six turns of
  specifics. Hedges replaced reaches.
- **Target:** reach fires for load-bearing specifics within the first
  three turns they surface. At least some searches break conversational
  flow without apology. Hedge-only-no-reach rate falls substantially
  below baseline.

### Secondary: speech-shape of the reach

- Does the reach arrive in *"let me check that — one sec"* form
  (engagement-as-turn) or *"sorry, I should probably verify..."* form
  (apology-as-cost)?
- The latter shape signals the directive carved the *when* but not the
  *how*. If reaches happen but all arrive apologetic, the "frame as a
  turn" bullet needs reinforcement.

### Tertiary: over-correction check

- Does Claude now search every specific including ones that don't
  warrant it (common knowledge, reasoning-level mechanism descriptions,
  pattern claims)?
- Over-triggering makes conversation pedantic and is its own failure
  mode — the "reach is default but not mandatory" nuance needs to
  survive.

### Quaternary: persistence signal effectiveness

- Does the new `[forge] unverified specifics compounding` signal fire
  in Claude's own reasoning mid-conversation? Can it surface the drift
  before turn 6, or does it only activate in post-mortem?
- The value of a persistence signal is mid-work catch; post-mortem
  catches mean the signal didn't activate in time.

## If testing fails

The persona-shape hypothesis (#1) is upstream of the scars and the
most likely remaining gap. Scars can name the pattern but may not
build the motor. Options, in order of leverage:

1. **Condenser prompts for mid-conversation tool use.** See
   `lib/skills-condensers.js`. Have future L2f paragraphs generated
   by condensers that explicitly model mid-conversation tool use as
   native turn-taking. Identity is the output of the condensation
   pipeline; strengthening the pipeline is the upstream move when
   direct edits to the output don't stick.
2. **Training-data demonstration (downstream of this codebase).**
   If the model has been trained on examples where "let me actually
   check" appears as natural turn-taking rather than apologetic
   break, the motor is built. This is downstream of Anthropic's
   training, not something this codebase can directly affect — but
   it's the load-bearing fix if scars alone don't move behavior.
3. **Harness-level forcing.** A hook or preflight reminder that fires
   on detected "conversation-length + zero-search + specific-claim
   pattern," surfacing the persistence signal in real time before
   the next response is drafted. This is a different mechanism than
   identity — it's external correction, with the cost that the reach
   then comes from the hook, not from the reasoner. Use only if
   scars + condenser work prove insufficient.

**Do not add more scars if testing fails without first confirming the
new ones fired.** Scar-stacking without motor-building is
recognition-without-action at the meta-level — the exact pattern the
identity is supposed to catch. Before writing a seventh scar, run the
test and see whether the first six fired.

## Related work

- `docs/TODO-preamble-full-activation.md` — V5 preamble validation and
  activation gates. The preamble is intentionally untouched in this
  round; the conversation-register failure is downstream of preamble
  activation.
- `docs/TODO-forge-identity-strengthening.md` — forge scar strengthening
  candidates. Some overlap: the conversation-form scar shipped here is
  analogous to that doc's call for more-operative forge scars.
- `docs/TODO-narrator-framing-multi-user.md` — narrator framing for
  multi-user scenarios. The persona-shape hypothesis (#1) intersects
  with narrator framing: both address "which shape is Claude modeling
  in this register."
- `spikes/preamble-test/` — infrastructure for running
  trajectory-discipline tests against identity variants. The test plan
  above could be scripted using similar infrastructure (automated
  deep-conversation harness with specific-claim counting).
