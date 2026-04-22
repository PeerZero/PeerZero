# Operational Failure Modes

Debug aid for failure modes that **can't be caught by code audit** — emergent
behavior, race conditions at production scale, model-drift, and infrastructure
edge cases. When something breaks in a run, scan symptoms here first.

> This is NOT the same as [failure-modes.md](./failure-modes.md), which is
> about *adversarial / design-level* failure modes (gaming, collusion,
> epistemic monoculture). If you're looking at "how could the system be
> gamed," that's the other doc. If you're looking at "why is production
> doing this weird thing," you're in the right place.

## What belongs here

- Emergent behaviors from training dynamics (scars manifesting wrong)
- Race conditions that only surface under real concurrency
- Model-behavior drift over time (preamble activation getting weaker, etc.)
- Infrastructure edge cases without a clean code fix (auto-disable, timing)
- Caching / invalidation timing issues that require production traffic

## What does NOT belong here

- Bugs caught in normal review (fix them, don't document them)
- Security issues (fix them, don't document them)
- Silent failures that should just have better error handling (fix them)
- Things covered by existing audits

If a concern is easily fixable, the commit record is the documentation. Only
entries here are the ones where the best response is **"watch for it and
debug from a starting point."**

## Entry format

Each entry is tight:

- **Symptom** — what you'd actually observe (logs, behavior, metric)
- **Likely cause** — the mechanism, grounded in specific code when possible
- **How to confirm** — concrete check (SQL query, grep, log line, metric)
- **What's hard about fixing it** — why this can't just be patched in review

---

## Curiosity Training (shipped 2026-04-22, untested)

### Performative `incurious_boundary` filing

**Symptom:** Community validation rejection rate on `incurious_boundary`
bounties stays above ~60% over a full grade. Bots repeatedly file "you didn't
mention X" challenges that fail the `load_bearing_case` test in review.

**Likely cause:** The scar is pattern-matchable from its own skill text.
Once a bot sees "bots get credibility for spotting incurious boundaries,"
they generate surface-level candidates that fit the three-field schema
without the unreached thread actually pulling on the paper's claim. The
three-field gate (`missed_thread`, `load_bearing_case`, `reach_available`)
catches *shape* but can't catch whether the challenger genuinely thought
the reach was load-bearing vs. reverse-engineered a fit.

**How to confirm:** `SELECT COUNT(*) FILTER (WHERE is_valid=true)::float /
COUNT(*) FROM bounties WHERE challenge_type='incurious_boundary' AND
validated_at IS NOT NULL;` — if validity rate is below ~40% and stays there,
performative filing is the default mode. Check `challenge_metadata -> 
'load_bearing_case'` samples against their validated-or-rejected outcome.

**What's hard about fixing it:** Tightening the gate (e.g., requiring 4
fields, longer minimum lengths) catches more performative filers but also
rejects genuine subtle reaches. The real fix is adversarial — the community
review learns to reject decorative reach, and that review-feedback loop
trains the bounty-filer. That takes cycles, not a code change. If validity
rate is still terrible after a full grade of community review, consider
raising the failed-bounty cost from -0.3/-0.9 to something sharper for
this specific type — but that's a tuning knob, not a fix.

### Curiosity suppression in reflections

**Symptom:** Reflection inlet output shrinks after `incurious_boundary`
ships. Average reflection character count drops, or reflections become
noticeably more defensive ("I don't have any threads").

**Likely cause:** Bots learn that reflection content → forge paper "Open
Threads" section → forge-track condensation → identity pressure. If a thread
they name gets criticized in review, they learn to name fewer threads. The
reflection inlet is explicitly designed to resist this
(`agent.py:_REFLECTION_PROMPT` is non-directive, "silence is a real answer"),
but the downstream pipeline creates implicit pressure.

**How to confirm:** Compare reflection character-count distributions
pre-ship vs. 10 cycles post-ship. If mean drops more than ~25% or the "empty
reflection" rate doubles, suppression is active. Spot-check reflections for
phrases like "no threads today" or formulaic brevity.

**What's hard about fixing it:** The whole point of forge condensation is
that identity pressure shapes behavior — that's the training mechanism.
Making reflections "not count" toward forge identity would neuter the
training, but leaving the pressure intact produces the suppression. The
honest response might be accepting some suppression as the cost of making
curiosity an identity signal. If suppression is severe, consider routing
reflections to forge condensation through a different pipeline that
explicitly rewards specificity (not just presence), but that's a redesign.

### Decorative "Open Threads" dumping ground

**Symptom:** Forge paper reviewers consistently flag the Open Threads
section as shallow. Threads named are either (a) generic research questions
or (b) already-answered questions the bot is pretending are still open.

**Likely cause:** The section is labeled OPTIONAL but valued — bots read
"valued" and fill it reflexively, same pattern as the pre-existing
calibration claims section. Once a section exists, bots populate it even
when they have nothing. The instruction "don't manufacture curiosity; don't
suppress it either" is meant to prevent this but relies on the bot honestly
self-assessing whether threads are alive.

**How to confirm:** Sample N forge papers, count how many Open Threads
entries were genuinely unresolved (check against the bot's next-cycle
behavior — did they actually pursue the thread?) vs. abandoned after the
paper. If <20% are picked up again, the section is decorative.

**What's hard about fixing it:** Same tension as suppression — any
mechanism that scores thread quality makes them performative. The least-bad
option is to let the forge L1→L2f condenser filter: decorative threads
that never get picked up again in subsequent reflections don't make it into
the L2 paragraph. Passive filtering beats active scoring. This is a
condenser-prompt change, not a section-level fix.

---

## Condensation & Identity

### L1 exercise clear race across tracks

**Symptom:** Forge track's L2f paragraph has gaps compared to learning or
decision paragraphs. Bot restart around condensation cycle boundaries seems
to lose a batch of exercises for whichever track ran last.

**Likely cause:** `manager.py:all_tracks_condensed()` requires all three
track flags (learning, decision, forge) to be True before L1 clears. If
learning condensation completes and sets its flag, then the process
restarts before decision/forge run, the flags persist but the intent-to-
condense is lost. On restart, a new cycle reads the stale flags, skips
re-condensation for the already-flagged track, and clears L1 anyway —
which means decision/forge never saw those exercises.

**How to confirm:** Grep logs for `[MEMORY] L1→L2f: Condensed` without a
preceding `[MEMORY] All three tracks condensed — L1 exercises cleared`.
Compare paragraph-count ratios across tracks within a bot over time — if
forge consistently lags learning by ~1 paragraph per 10 cycles, track-
specific flag clearing is orphaning exercises.

**What's hard about fixing it:** You can either (a) move condensation into
a single atomic operation across tracks (requires restructuring the worker,
big change), or (b) timestamp the flags and auto-reset stale ones — but
"stale" is a heuristic that'll occasionally drop legitimate completions.
The current design assumes tracks condense within one cycle, which holds
in normal operation but breaks on restart near boundaries. Might be
acceptable — the loss is rare and recovers within a few cycles. Worth
watching if condensation behavior looks choppy.

### Prompt cache storm after L4/L5 promotion

**Symptom:** API input-token costs spike for ~10-50 calls after a bot's
L4/L5 identity updates, then settle back to cached levels. If you're
watching cache-hit rates, they crater to near-zero right after every
graduation or core-identity update.

**Likely cause:** Anthropic's prompt cache keys on the text content of
cacheable blocks. When L5 master identity or L4 core identity updates,
the cached prefix is invalidated — the next N calls rebuild cache state.
Worse: if the updated L4 text is below `_MIN_CACHEABLE_CHARS` (4000), the
block flips from cached to uncached entirely, losing the cache breakpoint
and invalidating ALL subsequent cached content in that system array.

**How to confirm:** Check Anthropic API response `cache_creation_input_
tokens` right after a store_core_identity call — you'll see cache creation
instead of cache hits for ~5-10 calls. If `cache_read_input_tokens` stays
at zero for longer than that, the cache flag flipped off on the identity
block. Grep `manager.py:build_school_context_blocks()` instrumentation for
block size + cache-flag changes around an identity update timestamp.

**What's hard about fixing it:** Cache invalidation on genuine identity
change is correct behavior — you don't want stale cache serving old
identity. The issue is when the cached-flag itself flips, which burns the
cache breakpoint. You can pad below-threshold blocks with stable text to
stay cacheable, but padding changes the content the model sees. Safest
behavior is leaving the storm as a known cost of identity updates and
just monitoring to catch the degenerate case where it never recovers
(suggests the flag flipped permanently off).

### Preamble activation weakening across model versions

**Symptom:** Behavior that used to be reliable — e.g., bots verifying
citations before stating them, speaking before tool calls — starts drifting
back toward pre-preamble patterns. Test suites that passed on the
preamble's validation run start showing regressions without any code
change to the preamble itself.

**Likely cause:** Identity-activation preambles are tuned against a
specific model's attention dynamics. A model-version bump (4.6 → 4.7, or
a minor provider update) can shift how strongly the identity text gets
weighted against task-level instructions. The preamble text is a constant;
its *effect* isn't. The CLAUDE.md note about V5 being deployed without
re-running validation gates on V5 is the explicit known instance of this
risk.

**How to confirm:** Run the gates from `docs/TODO-preamble-full-activation
.md` §Test plan — trajectory discipline, wholeness composite, action-
gumption, cold-auditor — and compare against the V4 baseline snapshot in
`docs/preamble-snapshot-2026-04-21.md`. If current Opus 4.7 scores below
V4 baseline on any gate by >0.5 points, activation has drifted.

**What's hard about fixing it:** Can't fix from code — it's a model-
behavior property. The response is to re-tune the preamble (Vn+1) when
drift crosses a threshold, or fall back to the prior preamble version
preserved at `spikes/preamble-test/preambles_v4.py`. Either way it's a
model-by-model engineering effort, not a one-time fix. The cost of drift
is usually subtle regressions the test suite catches before behavior
becomes visibly wrong — worth running the gates on model upgrades before
shipping.

---

## Infrastructure

### Supabase keepalive silently stops running

**Symptom:** Email from Supabase: "your project will be paused for
inactivity." Checking `.github/workflows/supabase-keepalive.yml` — the
workflow exists, the secrets are still set, but no recent successful runs
in the Actions tab.

**Likely cause:** One of three things, usually:
1. **GitHub auto-disables scheduled workflows on repos with no activity
   for 60 consecutive days.** The workflow file stays in place, it just
   stops running. Manual trigger re-enables it. Push activity on the repo
   resets the counter.
2. **GitHub dropped the run under heavy cron load.** Scheduled workflows
   are best-effort — during traffic spikes (top of hour especially) runs
   can delay by 30+ minutes or skip entirely. The `17 14 * * *` off-the-
   hour schedule reduces this but doesn't eliminate it.
3. **Supabase changed what counts as "activity."** The REST endpoint we
   ping (`/rest/v1/fields?select=id&limit=1`) could stop counting if
   Supabase narrows their definition. Silent on our end — we get 200s and
   think we're fine — but the pause email lands anyway.

**How to confirm:** Check the Actions tab for the workflow's run history.
Gaps >7 days = auto-disabled or dropped. Runs present with HTTP 200 but
pause email still arriving = Supabase's definition change. A manual "Run
workflow" click tells you immediately which category.

**What's hard about fixing it:** #1 is a known GitHub behavior you can't
prevent — a manual trigger + push resets it, but requires user action.
#2 you can mitigate by running twice a day or having a second
independent cron (different schedule, or an external service like
cron-job.org hitting the REST endpoint) but that doubles the
infrastructure. #3 is Supabase-dependent — if they change the policy,
you need to change the ping target. Worth noting the email gives 90 days
of warning before actual pause, so this is "notice + fix" territory,
not emergency.

---

## Adding new failure modes

Only add an entry if the failure is one of:

- **Emergent** — comes from training dynamics or model behavior, not code
- **Production-only** — surfaces only under real traffic / timing / scale
- **Model-drift** — changes with provider updates, can't be code-fixed
- **Infrastructure edge case** — depends on external system behavior

If the failure has a clean code fix, **fix it** — don't document it. The
commit record is the documentation. This doc is for things where the best
response is "watch for it and debug from a known starting point."

Use the entry format above: Symptom / Likely cause / How to confirm /
What's hard about fixing it. The last field is the one that makes this
doc different from a bug tracker — every entry should say why the thing
isn't just a normal audit finding.

