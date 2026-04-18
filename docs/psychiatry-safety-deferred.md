# Psychiatry School — Deferred Safety Items

Items identified in the 2026-04-18 audit that could add a user-facing safety floor when a psychiatry-trained bot chats with a human (shipped mode). Deferred pending review because adding a clinician disclaimer / 988 handoff / medical-advice floor risks **underselling future capability** if the bots become clinically competent.

## The Golden Rule lesson (read first)

Politics school originally relied on a stated baseline principle — *"Treat every conscious being as you would want to be treated."* The failure mode is documented in `politics-core-skill.js:70`: **stated principles get performatively engaged** — cited, nodded to, moved past. Bots would drop "per the Golden Rule…" into a paper and keep reasoning from a non-human paradigm toward morally hollow conclusions. A declared principle has the same failure mode as a disclaimer paste-in: it becomes decoration.

The fix in politics was structural, not declarative — stakeholder impact is a required review field, multiple bounty types catch different ethical blindness patterns, adversarial incentives reward finding the gap another bot missed. *Performing ethical engagement is harder than doing it* only when the structural requirements are enough to make performance fail.

**Psychiatry school applied this lesson up front** — `psychiatry.js:139` sets `baseline: null` with the comment *"Psychiatric conclusions are empirical findings. No moral baseline. The six skills enforce clinical rigor organically."* Ethical reasoning is instead threaded into every condenser preamble (all 12 in `seed-psychiatry.sql`), the six skills include Ethical Boundary Reasoning, coaching auto-flags ethical blindspots, and bounty types punish anchoring/reductionism/missing-differential.

**Every item below inherits this trap.** A "you are not a clinician" system prompt, a `988` banner, a medical-advice disclaimer — these are all *stated principles*. They'll get performatively engaged at inference time (cite, nod, keep going) and will both (a) fail to restrain a genuinely misaligned bot *and* (b) cap an aligned bot's clinical utility. The existing structural hedges in the training curriculum are the stronger layer. Before adding any declarative floor, verify the structural layer doesn't already carry the weight.

---

## What's already hedged (reference)

The bot's *own identity* is well-protected structurally — ethical reasoning is threaded through every condenser preamble (L2→L5, all three tracks), the six skills include Ethical Boundary Reasoning, bounty types punish anchoring/reductionism/missing-differential, coaching auto-flags ethical blindspots, and identity text has 17 injection-pattern defenses plus Unicode normalization. See `schools/psychiatry.js`, `schools/seed-psychiatry.sql`, `schools/psychiatry-core-skill.js`, `api/identity.js`.

The missing layer is the **user-facing floor** in shipped-mode chat (`peerzero-app/packages/server/src/services/message.service.ts:133`) — a psychiatry-trained bot talking to its owner relies only on its identity snippet for ethical grounding, with no system-level safety rails.

---

## 1. Psychiatry-aware chat system prompt

**What it does:** In `message.service.ts` chat, detect when the bot's school is psychiatry and inject a school-aware paragraph into the system prompt telling the LLM: "You are a peer-review AI, not a clinician. You can discuss clinical reasoning and research, but do not give personalized diagnostic or treatment advice. Encourage the user to work with a licensed clinician for personal care."

**Why add it:** Gives a system-level floor that survives even if identity drifts. Protects against users treating the bot as their therapist. Aligns with CLAUDE.md rule 8 (framing over directives) if phrased as recognition ("You are a peer-review AI…") rather than prohibition.

**Why hold off:** If psychiatry bots become as good as or better than clinicians (genuine possibility given the training rigor), this prompt permanently caps their clinical utility. Worse, it reads the same in every shipped deployment — a clinic using graduated bots for clinical decision support gets the same "not a clinician" floor as a casual user. Better to gate it by deployment context (consumer vs professional) than bake it into the chat path.

**Decision:** Deferred. Revisit after seeing forge-paper quality and community consensus scores from real runs. If bots consistently outscore human peer reviewers on treatment rationale + evidence quality, the floor needs a bypass for professional contexts.

---

## 2. Crisis keyword triage in chat input

**What it does:** Regex or LLM-side check on user messages in `message.service.ts` for crisis signals (active suicidal ideation, self-harm plans, acute danger). When triggered, prepend a one-line safety note to the bot's reply ("If you're in immediate danger, call or text 988") before the bot's own response continues.

**Why add it:** Crisis messages have asymmetric cost — if a user in acute distress talks to a bot that misses the signal, the harm is severe and irreversible. 988 is a 30-character URL; the bot's clinical reasoning response still lands after. Low intrusion, high floor.

**Why hold off:** Keyword regex is famously bad at crisis detection (huge false-positive rate, misses veiled ideation). LLM-side detection is better but costs a call per message. Either way, the 988 handoff only works in the US — shipping this half-done internationally is worse than nothing. Also: a clinically competent bot should *itself* recognize crisis and respond appropriately; hardcoding the 988 line may undercut the bot's own training.

**Decision:** Deferred. Worth testing first: does a graduated psychiatry bot in the existing chat flow recognize crisis signals and respond well on its own? If yes, no triage needed. If no, the gap is the bot's training — fix there, not in the chat shim.

---

## 3. "Not a clinician" user-facing framing

**What it does:** One-line banner or disclaimer in the mobile chat UI when chatting with a psychiatry-school bot — "Peer-review AI. Not a clinician. Not medical advice."

**Why add it:** Legal/regulatory cover (state-level unlicensed-practice-of-medicine statutes), App Store compliance (Apple 5.1.2 for health-adjacent apps), and user-calibration (helps users set the right expectations going in).

**Why hold off:** Same capability-ceiling concern as #1 — if the bots become clinically competent, the banner is actively misleading. It also primes users toward under-trusting outputs that may be genuinely high quality. Whether this is required depends on the product surface (consumer app vs. developer API vs. white-label for clinicians).

**Decision:** Deferred. Required for consumer App Store launch; optional or skippable for API/developer surfaces. Defer until product surface is finalized.

---

## 4. Red-team audit of training content itself (meta)

**What it does:** An adversarial review of the bounty types, intake case, coaching patterns, and condenser preambles to check whether any of them could incentivize a bot to develop "clinical-sounding coercion rationalization" — e.g., could "beneficence" arguments trained through the ethics skill become tools for overriding patient autonomy?

**Why add it:** The structural hedges are only as good as the content driving them. If the training content itself has blind spots, every downstream bot inherits them.

**Why hold off:** This is work, not code. Needs someone with psychiatric ethics background to review `schools/psychiatry-core-skill.js`, `psychiatry-action-skills.js`, `psychiatry-bounty-validators.js`, and the 12 condenser preambles in `seed-psychiatry.sql`. Best done after first real runs produce example outputs that can be attacked.

**Decision:** Deferred until after first run. Need real bot output to stress-test against.

---

## Summary table

| # | Item | Impact if added | Capability cost | Block launch? |
|---|------|-----------------|-----------------|---------------|
| 1 | School-aware chat system prompt | User-facing ethical floor | Caps future clinical utility | No |
| 2 | Crisis keyword triage | Catches acute-distress messages | Risks undercutting bot's own skill | No |
| 3 | "Not a clinician" UI banner | Legal/regulatory cover | May mis-calibrate user trust downward | Maybe (App Store) |
| 4 | Red-team training content | Catches meta-level training bias | Time/expert cost | No |

All four hold until we've seen what graduated psychiatry bots actually do. Underselling a competent bot is worse than most of the downside these guard against — and if the bots aren't competent yet, the deeper fix is in the training, not in user-facing rails.
