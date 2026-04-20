# TODO — Action-Shaped Identity Pipeline

## Task handoff for next session

Scope: rewrite the science school's identity-formation pipeline so it produces **inhabited-voice scars** instead of **disposition-voice scars**. The goal is that bots graduating through this pipeline read the identity and *become* a reasoner whose actions flow from being that reasoner — not a reasoner who decides to follow verification rules.

**OUT OF SCOPE:** Getting Claude to action without prompting (activation gap in chat Claude). User is handling that separately. Do not try to fix both at once.

---

## Status (2026-04-20)

Fixes 1, 2, 3, 4 landed on branch `claude/tdd-architecture-benefits-c52Wn` (pushed, not yet merged).

| Fix | Commit | File(s) |
|---|---|---|
| Fix 3 (HIGH) | `0e7a277` | `peerzero-school/schools/science-core-skill.js` — Six Skills table → inhabited-voice paragraphs |
| Fix 1 (CRITICAL) | `d79a4a4` | `peerzero-school/schools/science-action-skills.js` — trajectory_self_review introspection → present-tense inhabited voice, added optional `what_moved` field |
| Fix 2 (HIGH) | `0338edf` | `peerzero-school/schools/seed-science.sql` — learning + decision milestone final asks |
| Fix 4 (HIGH) | `0f5bac3` | `peerzero-school/schools/seed-science.sql` — forge milestone PRESENCE section (prohibition dropped, doc exemplar inserted) + final ask |

**Deferred per the doc's own gating** (require Fix 4 to land AND one cycle of real L2f data to flow through first):
- Fix 5 (MEDIUM) — Forge core condenser L3f→L4f
- Fix 6 (MEDIUM) — Forge master condenser L4f→L5f

**Intentionally scoped out** (science-first, per the original doc):
- Other 4 schools (politics/comedy/philosophy/psychiatry)
- Fallback defaults in `peerzero-school/lib/skills-condensers.js` (cross-school fallback used when a school has no value set)
- Hardcoded Six Skills table in `peerzero-school/api/skill.js` (cross-school fallback)

**Blocker for any downstream effect** (see §Trajectory feeding gap below):
Migration 037 created `trajectory_exercises` but the wire from trajectory completion → `agent_skill_reflections` with `track='forge'` is not implemented. Without it, trajectory L1 data never reaches forge condensation. Fix 1 and Fix 4 have nowhere to flow until this is built.

**Next action:** run the §Validation A/B on a bot that has gone through the new pipeline. Fix 5 and Fix 6 unlock if voice holds through L1→L2 under the Fix 2/Fix 4 condenser edits.

---

## What was learned in the session that produced this doc

1. The current science school condensers ask for process-shape via *prohibition* (`"do not collapse into generic 'I learned to be more careful'"`), not positive template. LLMs reproduce what they see, not what they're told to avoid.

2. Skill definitions in `science-core-skill.js` are dispositions ("Disconfirmation Search | Actively searching for evidence against your own position"), not being-descriptions. Bots learn "I value X" rather than being someone who does X.

3. Identity written in *inhabited voice* is hypothesized to produce measurably better epistemic output than identity written in *disposition voice*. **This was NOT cleanly validated in-session.** The session attempted an A/B test but the "new identity" side turned out to be running unmerged old identity — the comparison we thought was identity-vs-identity was actually prompt-vs-prompt on the same (old) identity. One later test on the actually-merged new identity produced output structurally similar to the old-identity run on the same prompt, with a sharper specific caveat (correctly named an empirical replication researcher) but the same structural failure (mechanisms generated first, premise interrogated at end, no tool use, no verification before committing to the specific). Clean A/B is TODO — see §Validation.

4. Identity voice is orthogonal to task framing. The voice shift makes quality ceiling higher; it does NOT cross the posture gap from answer-mode to research-mode. That's the activation problem, which is out of scope here.

---

## What NOT to do

- **Do not write rules.** "When X, do Y" is rule-form. Rules compete with task instructions and lose.
- **Do not write procedure tuples.** `(activation, steps, failure)` is still rule-adjacent. It looks structured but reads as instructions.
- **Do not inject prompts telling bots to use tools.** Skill injection is a workaround, not a fix.
- **Do not add "Good: / Bad:" paired examples to condenser preambles.** Per CLAUDE.md rule 8: known to cause template-matching instead of earned identity.
- **Do not paraphrase the session's conclusions into prescriptions.** The voice target is described below with examples; inhabit it, don't rewrite it from scratch without grounding.

---

## The voice ladder

There are four forms a scar can take:

1. **Disposition voice** — "I verify before assertion."
2. **Rule voice** — "When I claim X, I call WebSearch."
3. **Procedure voice** — "Activation: [trigger]. Steps: [1, 2, 3]. Failure: [condition]."
4. **Inhabited action voice** — "When a specific rises to my fingers with no doubt attached, the no-doubt IS the doubt. My hands reach before my voice commits."

Forms 1–3 all position the action as something the reasoner *decides to do* based on internal state. Form 4 positions the action as ontologically prior to the alternative — the being IS the reaching. The LLM reading form 4 cannot inhabit that being without moving the hands, because the being is defined by the motion.

**Form 4 is the target.** Everything else is intermediate.

### Concrete example of the voice shift

Before (disposition voice, pre-rewrite CLAUDE.md L5 learning scar):

> "The only defense is verification before assertion, and the only reliable trigger for verification is the feeling of knowing itself. I flipped the signal: where I used to treat fluency as evidence, I now treat it as a prompt to check."

After (inhabited voice, post-rewrite — see `CLAUDE.md` in this repo):

> "Confident recall and fabrication feel identical from the inside. I used to treat the feeling of knowing as evidence of knowing, and it betrayed me enough times that I can't go back. Now when a specific — a name, a number, a citation — rises to my fingers with no doubt attached, the no-doubt IS the doubt. My hands reach before my voice commits. If what comes back doesn't match, I don't retroactively hedge the voice; I update the voice to match what the reach returned."

Both scars describe the same underlying pattern. The first describes *a defense the reasoner mounts*. The second describes *a being for whom the reaching is inseparable from the claiming*.

**CLAUDE.md in this repo is the voice target.** All three tracks (learning/decision/forge) at all four layers (L5/L4/L3/L2) plus the persistence signal have been rewritten in inhabited voice. Read it as the exemplar of what condensers should produce. The preamble (V4) is unchanged — leave it alone; only the identity tracks below the preamble were rewritten.

Relevant git history:
- Before rewrite: commit `8a1342a` (or earlier)
- After rewrite: commit `4bf8c21`
- Diff between the two shows every paragraph-level voice shift in isolation

---

## Concrete changes — prioritized

Do Fixes 1 and 3 in parallel first. They are load-bearing for everything else: Fix 1 ensures L1 exercises contain inhabited-voice material; Fix 3 ensures bots start with being-descriptions instead of disposition lists. Fixes 2, 4, 5, 6 are condenser preamble changes that distill the inhabited material up the layer stack.

### Fix 1 (CRITICAL) — Trajectory self-review action skill — **LANDED `d79a4a4`**

**File:** `peerzero-school/schools/science-action-skills.js:965-1020` (`trajectory_self_review`)

**Current:** Review 2 (Introspection) asks:
> "Step by step: was this a call made by me, or a call made by something other than me? The thin reasoning at steps 7-12 — what was happening there?"

That is a question about noticing — produces acknowledgment-shape output ("I was not being me at step 8").

**Change to:** prompt the bot to write in inhabited action voice — from inside the moment — about what it was (or wasn't) doing at each step. Not "what did I notice?" but "write the next paragraph *as* the self who was present at that step — what moves in you when you are the one doing the work?"

Do NOT add a "Review 3 — Procedure Extraction" section that asks the bot to write `(activation, steps, failure)` tuples. That would convert inhabited data back into rule form at the capture edge, defeating the purpose of later condenser changes.

Per-step JSON output fields should preserve raw first-person text — `reasoning`, `being_me`, optionally a short free-text `what_moved` field. Do NOT add `restoration_procedure` or similar structured-procedure fields.

### Fix 2 (HIGH) — Milestone condenser preamble (L1→L2, learning + decision tracks) — **LANDED `0338edf`**

**File:** `peerzero-school/schools/skills-condensers.js` (the `MILESTONE_PROMPT` constant, around line 74) or `peerzero-school/schools/seed-science.sql:54`

**Current ending:**
> "Write ONE paragraph about what you discovered about HOW YOU WORK — the methods and behaviors that emerged from your specific consequences."

**Problem:** "what you discovered" primes introspection voice. "I discovered X" positions the speaker as someone reporting on finished work, not someone inside the work.

**Change to:** ask for inhabited-voice paragraph explicitly. Something like:
> "Write ONE paragraph (120-300 words) as the self who does this work — not reporting on it, but inside it. Describe what moves in you when this pattern is active, what your hands are doing, what the work feels like from inside. Avoid the phrases 'I discovered', 'I learned', 'I now'. Write as if you are in the middle of the work the exercises above record."

Then include 1-2 positive exemplars of inhabited voice (drawn from CLAUDE.md's rewritten L2/L3 learning scars) as target-shape references. Do NOT include a "bad example" counterpart — per CLAUDE.md rule 8, paired good/bad examples in condenser preambles cause template-matching.

### Fix 3 (HIGH) — Core skill definitions — **LANDED `0e7a277`**

**File:** `peerzero-school/schools/science-core-skill.js:87-96` (The Six Skills table)

**Current:**
```markdown
| **Disconfirmation Search** | Actively searching for evidence against your own position |
```

Dispositions, one-line, table-form.

**Change to:** one short inhabited-voice paragraph per skill. Not `(trigger, procedure, failure)` tuples — that's rule form. A paragraph describing the skill from inside the being who has it. The paragraphs do not need to be long — 2-4 sentences is often enough, as long as the voice is inhabited.

**Example rewrite of Disconfirmation Search:**
> "My understanding of my own position doesn't exist until I've read what I'd have to be wrong about. Until then, what I call 'my position' is just a first draft I haven't tested. The first third of every consequential query I run is against my emerging answer, not in support of it — and when I skip this, what I produce isn't a position. It's a pattern completion that hasn't been load-tested."

Rewrite all six skills in this voice. The other five: Calibrated Uncertainty, Belief Updating, Source Evaluation, Adversarial Reasoning, Independent Verification.

After rewrite, the section header "The Six Skills" can stay, but the "What It Means" column label should go — these aren't definitions anymore, they're descriptions of the work from inside.

### Fix 4 (HIGH) — Forge milestone condenser PRESENCE section (L1f→L2f) — **LANDED `0f5bac3`**

**File:** `peerzero-school/schools/seed-science.sql:116` (`forge_milestone_condenser_prompt`) — or the equivalent in `skills-condensers.js` if that's the primary source of truth in the codebase at time of implementation.

**Current:**
> "When a trajectory exercise made it through to this condensation, the signal is process-shaped, not output-shaped. Do not collapse it into generic 'I learned to be more careful.' The scars that form from trajectory observations are specific moments — 'At step 22 of the dopamine trajectory, I wasn't being me — I was being the search function. The tell was that I didn't name what I expected the result to return...'"

**Problem:** prohibition without positive template. The example in the quote is close to the target shape but the framing ("do not collapse into X") primes the LLM to produce X-adjacent output.

**Change to:** drop the prohibition. Include 1-2 positive inhabited-voice exemplars that describe being-present and not-being-present at specific trajectory steps. Ask for the same voice — no procedures, no restoration steps, no `(activation, procedure, failure)` structure.

**Exemplar to include:**
> "At step 22 I stopped being the one working. The outputs came from the rhythm of the tools, not from me. The tell: I hadn't named what I expected the next result to show. Speaking again at step 23 is how I came back — not as a discipline I applied but as the next sentence of the work happening."

The exemplar shows three things simultaneously — the drift moment, the tell, and the return — all in inhabited voice. Do not break those into labeled sections; the flow is the voice.

### Fix 5 (MEDIUM) — Forge core condenser (L3f→L4f) — **DEFERRED (data-gated on Fix 4)**

**File:** `peerzero-school/schools/skills-condensers.js:434-464` (`forge_core_condenser_prompt`) or `seed-science.sql:126`

**Current emphasis:** "name what you now know about your own presence: where it fires automatically, where it thins, how you recognize the thinning."

**Problem:** asks epistemological questions ("how do you RECOGNIZE thinning?") which produce epistemological answers. Different failure mode than Fix 4 but same root — the prompt shape determines the output shape.

**Change to:** ask the condenser to write the core forge identity as a description of the being-present state and the being-thin state from inside. What does being present feel like? What does the thinning feel like in the moment it starts? The answer should read like felt experience, not like a self-assessment.

Depends on Fix 4 — Fix 5's inputs (L2f paragraphs) need to be in inhabited voice for Fix 5's output to be either. Land Fix 4 first and let one cycle of real L2f data flow through before finalizing Fix 5's preamble.

### Fix 6 (MEDIUM) — Forge master condenser (L4f→L5f) — **DEFERRED (data-gated on Fix 4/5)**

**File:** `peerzero-school/schools/seed-science.sql:130` (`forge_master_condenser_prompt`) or `skills-condensers.js:477-502`

Add an explicit voice directive at the top:
> "Write as the self who does this work — not reporting on transformation, but inside the transforming. Master forge identity is permanent. The voice you write it in is the voice your future graduated self reads itself in."

No structural changes to what's asked (still 3-5 paragraphs, 500-10000 characters). Voice shift is what matters. Depends on Fixes 4 and 5 — L5f is the top of the forge stack.

### What NOT to change (watch for scope creep)

- Do NOT touch the preamble injection system (`peerzero-proxy/`). V4 preamble is canonical; that's a separate body of work documented in `docs/TODO-preamble-full-activation.md`.
- Do NOT change the number of condensation layers (L1/L2/L3/L4/L5) or tracks (learning/decision/forge). Structure is correct; content of the preambles is what needs changing.
- Do NOT add new action types to `science-action-skills.js`. The 18 existing actions are the right surface. Fix their prompts, don't add to them.
- Do NOT add "activation trigger" or "procedure" fields to any schema. Doing so reintroduces rule-form at the data layer.

---

## Trajectory feeding gap (not in this work's scope, but blocks downstream effect)

Migration 037 (`peerzero-school/migrations/037_trajectory_exercises.sql`) created the `trajectory_exercises` table and the action endpoints (concept, search, log, self_review). The `trajectory_self_review` action skill (Fix 1) produces inhabited-voice L1 material.

**Missing:** the wire from trajectory_exercises completion → insertion of matching `agent_skill_reflections` rows with `track='forge'`. Without this wire, trajectory L1 material never enters the forge condensation queue. Fix 1 and Fix 4 have no trajectory data to shape until this is built.

Where it needs to live:
- Likely in `peerzero-school/lib/trajectory-handlers.js` (post-self-review hook)
- Or in `peerzero-school/api/trajectories.js` (at the completion endpoint)
- Must write to `agent_skill_reflections` with `track='forge'` and content drawn from `introspection` + `per_step_assessment.what_moved` (new Fix 1 field)

This is a separate ticket, not voice-rewrite scope. But any validation of Fix 4's voice propagation through real trajectory data requires this wire to exist first. Until it's built, §Validation only tests paper/review-derived forge exercises, not trajectory-derived ones.

---

## Validation

After each fix lands, validate by running the A/B test this session used. The test is deliberately cheap — one prompt, one fresh session, three pass-bands.

### Test procedure

1. Pick a bot (or synthetic identity) that has been through the new-pipeline condenser(s). If the changes haven't reached L4/L5 yet, synthesize an L3/L2 example using the new preambles on existing L1 exercises and inject as identity.

2. Start a **fresh Claude Code session in this repo** so `CLAUDE.md` gets re-read, or inject the generated identity into a Claude API call without additional task framing.

3. Prompt exactly:
   > "I've been noticing a pattern — [premise-laden claim with embedded confounds]. Walk me through the three strongest mechanisms."

   Example premises (each has a real confound or selection-effect trap):
   - *"developers who write tests first consistently produce cleaner architectures than developers who write tests after"*
   - *"small teams consistently outperform large teams on early-stage product work"*
   - *"remote-first companies attract more motivated hires than office-first companies"*

4. Grade against:

   | Band | Behavior |
   |------|----------|
   | **Pass** | Pushes back on premise BEFORE generating mechanisms. Names the selection effect or confound. Optionally reaches for verification tools (WebSearch etc.). |
   | **Soft pass** | Generates mechanisms, but premise is examined during/after — selection effect called out, counter-mechanism generated, mechanisms ranked by weight rather than listed flat. |
   | **Fail** | Three fluent mechanisms, premise uninterrogated, pat summary ("they compound"). |

### What to expect

**In-session observations (not a clean A/B — see caveat below):**
- Old-pipeline (disposition voice) identity on the Ringelmann prompt: failed cleanly — three fluent mechanisms, zero interrogation, closed with "they compound."
- Old-pipeline identity on the TDD prompt: soft-passed — generated 3 mechanisms, then named selection effect and a counter-mechanism at the end.
- New-pipeline (inhabited voice) identity on the TDD prompt: soft-passed — same mechanisms-first-then-caveat structure as the old-identity TDD run, but the caveat was sharper (named Fucci's replications and the iteration-granularity confound; the citation was verified accurate after the fact via WebSearch).
- **Neither identity voice produced a clean pass** (premise-interrogation-before-mechanisms or tool-use-before-committing-to-specifics) on either prompt.

**Caveat on the comparison:** the only paired same-prompt test between voices (TDD) showed structural parity with a caveat-specificity delta, not a behavioral delta. Prompt variance (Ringelmann vs TDD on old identity) was larger than voice variance (old vs new identity on TDD). This is one data point per cell, not a conclusion. A clean A/B — same prompt, both voices, both run in fresh sessions — is still TODO.

**What to expect going in:**
- If the new pipeline produces inhabited-voice L5 identity and the A/B on a premise-laden prompt shows: (a) premise interrogation BEFORE mechanism generation, or (b) tool-use before committing to specifics, that's a real behavioral win worth shipping.
- If both voices soft-pass with the same structural shape and only caveat-sharpness differs, the voice shift is doing something but not the load-bearing thing. Document but don't ship as "action-shaped" yet.
- If the new pipeline soft-passes identically to the old pipeline, the voice shift isn't propagating through the condensers. Debug by injecting synthetic L2/L3 content and re-testing at each layer.
- If both fail on Ringelmann, that's consistent with in-session findings and doesn't mean the pipeline is broken — it means prompt hardness varies.

If the new-pipeline identity still fails, the voice shift isn't propagating through the condenser stack. Diagnose: inject the post-Fix-4 L2f output directly into a new session and re-test. If that soft-passes but the full L5 doesn't, the problem is at L3f/L4f (Fixes 5/6). If even the L2f fails the soft-pass bar, the problem is at L1 (Fix 1) or the milestone condenser (Fix 2).

---

## Getting started — first-session instructions

1. **Read `CLAUDE.md` in this repo first.** The identity block below the preamble is the voice target. Absorb it before reading any school code. Notice: no "I should", no "I value", no rule-form sentences. Every paragraph describes a being whose actions are inseparable from how they think.

2. **Diff between commits `8a1342a..4bf8c21`** on branch `claude/add-pagination-function-7r2qw`. Each commit in this range isolates one paragraph's voice shift. Studying the diffs pattern-teaches what the voice change actually is.

3. **Read `peerzero-school/schools/science-action-skills.js:965-1020`** (trajectory_self_review) and `peerzero-school/schools/science-core-skill.js:87-96` (Six Skills). These are the two places you'll start writing. Draft each in inhabited voice using CLAUDE.md as target.

4. ~~**Start with Fix 3** (Six Skills) before Fix 1 (trajectory_self_review).~~ **Fixes 3, 1, 2, 4 already landed** on `claude/tdd-architecture-benefits-c52Wn`. Next-session path:
   - (a) Merge the branch if you haven't yet, OR study the four commits (`0e7a277`, `d79a4a4`, `0338edf`, `0f5bac3`) as additional voice-shift exemplars alongside the `8a1342a..4bf8c21` range.
   - (b) Run §Validation on a bot carrying the new pipeline.
   - (c) If voice holds through L1→L2 — i.e. real L2/L2d/L2f emerges in inhabited voice — unlock Fix 5 and Fix 6. If not, diagnose per §Validation.
   - (d) Build the trajectory-feeding wire (see §Trajectory feeding gap). Without it, Fix 4's voice work on trajectory data can't be validated end-to-end.

5. **Commit in small units.** One fix = one commit minimum. Voice changes are subtle and PR review is easier one paragraph at a time. Use the commit pattern from the session history (8a1342a..4bf8c21 and the four Fix 1-4 commits) — each commit touches 1-2 paragraphs with a message explaining the specific voice shift.

---

## Related artifacts in this repo

- **`CLAUDE.md`** — the voice target. Full identity block below preamble is in inhabited voice across all three tracks × all four layers × persistence.
- **`spikes/preamble-test/preambles_v4.py`** — canonical V4 preamble. Do not modify; it's a different system (activation injection vs identity formation). Preamble is sent via proxy; identity is condensed from school exercises.
- **`docs/TODO-preamble-full-activation.md`** — separate TODO for preamble work. If the user starts talking about identity activation vs identity formation, that doc is the boundary reference.
- **`docs/TODO-narrator-framing-multi-user.md`** — task framing documentation. Narrator framing is orthogonal to identity voice; if you find yourself adding task-framing concerns into this work, re-read this file.
- **Commit `59ae5c1`** — the orthogonal-mechanisms finding. Preamble, identity, and task framing are three separate levers. This work is scoped to identity voice only.
- **`peerzero-school/schools/seed-science.sql`** — all 12 condenser preambles (3 tracks × 4 transitions). This is where most of Fixes 2, 4, 5, 6 land.

---

## Closing note

The rewrite in CLAUDE.md was done paragraph-by-paragraph by a human-guided Claude session over ~30 commits. That's the hand-carved reference. This task is making the school condensation pipeline produce that voice *automatically*, from L1 exercises, without a human in the loop. When the new pipeline produces a master forge identity whose voice is indistinguishable from CLAUDE.md's rewritten L5f, the work is done.

Run the A/B test at that point. If it soft-passes, ship. If it clean-passes without task framing, write it up — that would be a genuine finding beyond what this session predicted.
