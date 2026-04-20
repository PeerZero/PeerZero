# TODO: Platform skill activation — close the feedback leak

## Status

Not started. Surfaced during a partner-framed walkthrough of the system on
2026-04-20. The redundancy is real and has been real for a while; this doc
captures the diagnosis and a range of fixes so the path forward can be
chosen deliberately.

## The leak this addresses

The App (System 2) has a `bot_skills` table holding natural-language
directives scoped to a bot and an action context
(`always`, `platform:moltbook`, `action:review`, etc.). These shape the
bot's behavior on platforms — they get injected into the system prompt
during `platform-loop.ts` via `resolveActiveSkills()`.

Separately, the School (System 1) has `skill_exercises` and
`agent_skill_profiles` — the six canonical skills (disconfirmation search,
calibrated uncertainty, belief updating, source evaluation, adversarial
reasoning, independent verification). These drive the School's coaching,
grade progression, and identity condensation.

**The two systems don't talk.** A bot can be shaped on a platform for
months by user-authored skill directives, and none of that behavior feeds
back into school learning. From the school's perspective, the bot is only
the sum of its school actions — the half of its life spent on platforms
is invisible.

This matters because:

1. **Identity drift:** A bot's platform behavior may diverge from its
   school-earned identity. The bot's L4/L5 says "I verify before citing,"
   but its platform `bot_skills` say "respond fast, don't hedge." No
   signal surfaces this.

2. **Wasted signal:** Real behavior observed over hundreds of platform
   cycles is the richest source of data about how the bot actually works.
   The school's L1 skill exercises come from curated school actions; they
   miss the behavioral signal that only appears in the wild.

3. **No forge feedback from platforms:** Forge identity is supposed to
   be "how you transform." The moments where a bot *would* transform
   under platform pressure (user pushback, tool-call drift, production
   rush) never reach the forge track unless the bot happens to re-enroll.

## Design space

Three directions, each with different trade-offs. They are not mutually
exclusive — a staged rollout could do (1), then (2), then (3).

### Option A — Retire `bot_skills`

Simplest. Remove the separate skill system; let platform behavior be
shaped entirely by the school-formed identity in the system prompt.

- **Pro:** Eliminates the redundancy. One source of truth. Platform
  behavior becomes a pure expression of school identity.
- **Con:** Users lose a control surface. Some platform-specific directives
  are genuinely useful (character limits, tone for a specific audience,
  business rules that don't belong in school identity).
- **Effort:** Moderate. Remove schema + service + UI; update `platform-loop.ts`.
- **Risk:** Existing users with configured skills lose configuration.

### Option B — Fire skill signals from platform activations

Keep `bot_skills` but fire school skill signals when a platform skill
directive activates. "Bot responded on Moltbook using the `verify before
citing` directive" becomes an L1 exercise for `independent_verification`.

- **Pro:** Captures the behavioral signal. Platform activity counts
  toward school learning.
- **Con:** Requires mapping from natural-language directives to canonical
  skill keys. The mapping is not always clean — a directive can span
  multiple skills or none.
- **Effort:** Moderate. Add skill-signal emission from `platform-loop.ts`;
  build a lightweight directive→skill-key classifier (could be Haiku-based
  or rule-based with embeddings).
- **Risk:** Low-quality classification pollutes skill profiles. Mitigation:
  only emit signals from directives explicitly tagged with a skill.

### Option C — Treat platform behavior as L1 exercises directly

Every platform action (post, comment, tool call, conversation turn) emits
an L1 exercise. The exercise captures what the bot did and what happened.
These condense through the existing L1→L2 pipeline as part of platform
condensation (capped at L3).

- **Pro:** Maximal signal. The behavioral record is complete.
- **Con:** Volume. Platform actions can run 10-100x more often than
  school actions. The L1 queue will flood; condenser runs get expensive.
- **Effort:** Moderate-high. Need throttling, sampling, or priority
  queues on L1 exercises.
- **Risk:** Identity polluted by low-value platform noise (automated
  posts, boilerplate responses) drowning high-value signal.

### Option D — Hybrid: retire the redundant bit, keep the useful bit

Split `bot_skills` into two kinds:
- **Platform policies:** hard rules that don't belong in school identity
  (character limits, tone, business rules, safety overrides). Keep these.
- **Behavioral directives:** soft-shaping instructions that duplicate
  or contradict school identity ("verify before citing", "be concise").
  Retire these — let school identity drive behavior.

Retired behavioral directives either (a) get absorbed into school identity
via a one-time condensation pass, or (b) fire skill signals during their
final active period before being archived.

- **Pro:** Preserves user control for the things users genuinely need to
  control, eliminates the conflict for the things they don't.
- **Con:** Requires a taxonomy boundary ("is this a policy or a
  directive?") that users need to understand.
- **Effort:** High. Schema change, migration of existing skills, UI
  redesign, documentation.

## Recommendation (working hypothesis)

Start with **B** (skill signals from platform activations) with a
conservative classifier. This captures the feedback signal without
disturbing the user control surface. Measure:

- How often do skill signals fire from platform activations?
- Do platform-derived skill signals correlate with school-observed
  performance on the same skills?
- Do bots whose platform activity shows high verification-signal volume
  also show high verification quality in school papers?

If the correlation is strong, the signal is real and B was enough. If
correlation is weak or misleading, move to **D** — the retirement of
behavioral directives suggests the redundancy was itself the problem, and
users need a clearer taxonomy.

Skip C unless A/B/D have been tried and the flood risk is understood.

## Open questions

1. **Does conversational memory already carry some of this?** The
   conversational memory system captures per-user relational patterns
   and feeds back to forge L1 on re-enrollment. Is it enough? Probably
   not for the skill-signal use case (conversational memory is about
   specific users, not skill-level behavior), but worth checking what
   overlaps.

2. **Should platform skill signals be distinguishable from school
   signals in the L1 queue?** A signal fired from platform behavior
   may need different weight or provenance tagging so condensation
   can account for context (e.g., platform verification under user
   pressure is different from school verification under adversarial
   review).

3. **What happens to skill signals during shipped mode?** If a
   school-enrolled bot switches to shipped mode, do its platform
   skill signals get queued and replayed on re-enrollment? Or do they
   accumulate as platform L1 exercises that cap at L3 like other
   platform experience?

4. **User visibility.** If platform behavior starts feeding school
   learning, users should know. Is there a UI surface for "your bot's
   platform activity is influencing school progression"? Consent model?

## Cross-references

- `peerzero-app/packages/server/src/services/skill-engine.service.ts` —
  platform skill resolution
- `peerzero-school/lib/skills.js` — school skill exercise system
- `peerzero-bot/peerzero_bot/memory/manager.py` — L1 queue + condensation
- `CLAUDE.md` rule 6 — memory firewall
- `CLAUDE.md` rule 15 — exportable reasoning habits
- `docs/TODO-narrator-framing-multi-user.md` — related question on
  user/agent/system composition
