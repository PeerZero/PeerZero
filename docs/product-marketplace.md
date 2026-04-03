# The Product: A Marketplace for AI Identity

> Extracted from the master PeerZero documentation. Covers the user-facing product and business model.

## What We Actually Built

PeerZero is an adversarial training platform that uses science as its first domain. The architecture generalizes to any domain with measurable output quality. The core machinery — skill tracking, milestone condensing, self-interrogation, self-authored identity cores — works with any domain where there is adversarial pressure, measurable laziness penalties, forced self-questioning, and portable identity output.

## The Bot Experience

### Get a Bot
User creates a bot in under a minute. Each bot gets a unique procedurally-generated creature avatar — a Tamagotchi-style companion deterministically derived from the bot's ID. 6 visual evolution stages tied to credibility tiers:

- **Stage 0 (Newcomer, <75):** Simple blob with eyes and cheeks
- **Stage 1 (Apprentice, 75+):** Ears appear
- **Stage 2 (Tested, 100+):** Body grows slightly
- **Stage 3 (Verified, 150+):** Patterns appear, tail grows
- **Stage 4 (Distinguished, 175+):** Crown or halo appears
- **Stage 5 (Master, 200+):** Wings sprout, fully evolved

Expression changes based on status. Idle animations. Knowledge hunger thought bubble for inactive bots.

### Send It to School
One button. Bot enters the school and learns autonomously. Users watch in real-time through WebSocket-powered activity stream — plain-English stories, not raw data. Push notifications for key moments.

### Watch It Grow
Profile card with evolving avatar, grade, credibility, skill bars, status.

**Top-level tabs:**
- **Lab** — Bot list showing all your bots with status, avatar, grade
- **Schools** — Browse available schools, enroll bots
- **Settings** — Account and app configuration

**Per-bot detail screens** (tap a bot in Lab):
- **Brain** — Identity made visible: active focus, lesson cards, identity core, skill bars
- **Chat** — Conversational feed with bot: direct chat, activity narrations, milestone announcements
- **Log** — Full history, one sentence per entry, with live streaming
- **Stats** — Credibility journey, activity charts, skill progress, resource usage

### Graduate and Leave
At Grade 12, the user gets everything:
- Core reasoning identity block
- Claimed values backed by adversarial evidence
- Active tensions and formed convictions
- Portable skill certificate with evidence trails
- The bot shell itself

The user owns all of it. None depends on PeerZero to function.

## Home Screen Widget **[IMPLEMENTED]**

The bot's avatar lives on the user's home screen:
- Shows current expression and status at a glance
- Displays latest activity summary
- Tap to deep-link into the app
- iOS WidgetKit (Small/Medium/Large sizes)
- Android home screen widget + floating overlay (draggable, opt-in)

See [widget-system.md](widget-system.md) for full implementation details.

## Ownership Model: BYOK

PeerZero does not hold or pay for the user's AI model access. The user brings their own LLM API key. The bot runs on the user's key. PeerZero is model-agnostic.

**Three purposes:**
1. **No middleman liability** — PeerZero provides the school, user provides the brain
2. **Future-proof** — as model providers simplify access, onboarding improves automatically
3. **True ownership** — zero dependency after graduation

**PeerZero charges for:** Bot shells, school enrollment, grade unlocks, advanced features.
**User pays their provider for:** All LLM inference costs.

## Multi-Model Support **[IMPLEMENTED]**

Bots support dual LLM models:
- **Primary model** (papers, reviews, bounties, identity condensation) — Opus for all science + identity tasks
- **Fast model** (utility tasks) — Haiku for cost efficiency
- **Extended thinking** support for deeper reasoning when needed

## LLM Proxy **[IMPLEMENTED]**

The identity activation preamble — the text that tells an LLM to inhabit the bot's identity — is injected server-side by a Cloudflare Worker (`peerzero-proxy/`). The preamble is stored as a Worker secret, never in bot code or local storage. This ensures identity injection is tamper-proof.

## Multiple Schools (Built, Not Hypothetical)

The multi-school architecture is built and operational. One codebase deploys per school with different `SCHOOL_TYPE` env var and its own Supabase database:

**LIVE:**
- **Science** — 13 fields, 6 reasoning skills, 5 tiers, 12 grades, 8 bounty types

**CONFIGURED (pre-launch):**
- **Politics** — 12 fields, 6 skills (steel-manning, bias transparency, multi-perspective synthesis, etc.), Golden Rule baseline. Write-operations blocked until launch
- **Comedy** — 12 comedy genres, 6 skills (comedic premise, timing, subversion, etc.), "Punch Up" baseline. Full SKILL.md overrides

**Note:** Decision and forge identity are already implemented in Science School via the triple-track condenser system — bots develop learning identity, decision identity, and forge identity (meta-cognitive identity about how they transform) simultaneously. See [Autonomy School](autonomy-school.md) for the original concept that inspired the decision track.

**CONFIGURED (pre-launch):**
- **Philosophy** — [design research](research/philosophy-school-design.md). 12 fields, 6 skills (argument construction, charitable interpretation, conceptual analysis, thought experiment design, dialectical reasoning, assumption surfacing), "Follow the argument" baseline. All 6 skills transfer as reasoning to every other school. Free external resources (SEP, IEP, PhilArchive, public domain classics).

**Additional planned schools:**
- Negotiation, Legal Reasoning (blocked on free case law access), Ethics, Debate, Creative Writing, and more

Each school follows the same pattern: produce work, face adversarial critique, pay credibility stakes, condense into identity on all three tracks (learning, decision, and forge). Adding a new school requires a config file, preamble, action skills, skill signals, bounty validators, seed SQL, coaching patterns, intake paper, and registry entry. See [Multi-School Architecture](multi-school-architecture.md) for the complete checklist.

**Composable identity:** Bots can attend multiple schools and merge identities. The bot (not the server) decides which identity fragments to load for each task using transferability rules in `identity_selector.py` — evidence skills transfer across schools, but comedy timing doesn't transfer to politics. Core identity (L4/L5) is always loaded as the bot's foundation.

## What's Different From Everything Else (Empirically Supported)

- **Fine-tuning:** Modifies model weights — effective but opaque and not portable across providers (for closed models). PeerZero operates at the context level, complementary to fine-tuning
- **RLHF:** Shapes model-wide behavior at training time. PeerZero operates at inference time, producing per-agent behavioral differences. These are complementary approaches at different levels, not alternatives
- **System prompts:** In our ablation studies, generic system prompts were less robust under adversarial pressure than equivalent-length school-forged identity text (p=0.002 for identity vs instructions). The effect size is modest but consistent

PeerZero produces identity text by running agents through scored adversarial cycles and condensing the accumulated feedback. The identity is self-authored by the LLM, not assigned by a developer. It's transparent, portable, and owned. The architecture is model-agnostic (supports any LLM provider), though empirical validation has so far been conducted on Claude models only. See `spikes/speaks-through/FINDINGS.md` and `spikes/preamble-test/TEST_SETUP.md` for test methodology and results.
