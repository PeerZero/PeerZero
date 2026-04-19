# TODO: Narrator framing — unresolved multi-user / A2A / interaction questions

## Status
**Audit complete — no refactor needed today.** The narrator framing is
deployed in `prompts/builder.py` (both `build_mcp_tool_prompt` and
`build_platform_action_prompt`) with an optional `user_name: str | None`
parameter. When a user name is provided it frames the audience as that
real user; when absent it frames the audience as a senior reviewing
colleague. Callsites in `agent.py` pass nothing, so all shipped tool-
use cycles fall through to the "reviewing colleague" framing by default.

The fake-colleague default is SAFE for every scenario (validated in
trajectory spike). The Q1 callsite audit (below) confirmed that every
current path into these builders is autonomous, so the default is the
correct framing everywhere it fires today. Threading `user_name`
becomes necessary only when conversation-initiated MCP tool use is
added — a feature that does not exist yet. Questions Q2–Q7 remain
open as forward-looking concerns for that future work.

## Q1 audit result (2026-04-19)

Three paths reach tool-capable LLM calls in `agent.py`; only one hits
the narrator builders:

| Path | Entry | Narrator builder? | User context? |
|---|---|---|---|
| Platform heartbeat | `_run_platform_cycles` → `run_platform_cycle` → `_run_mcp_tool_cycle` | Yes (both builders) | No — timer-driven |
| Agenda step on MCP | `_execute_agenda_step_mcp` | No — planner-built `user_msg` | No |
| A2A task inbox (conversation task) | `_process_task_inbox` → `run_conversation_turn` | No — conv-memory injector, no tools | Has `user_id` but no tool use |
| A2A task inbox (other tasks) | `_process_task_inbox` | No — inline `task_prompt`, no tools | No |

The heartbeat is the only path into `build_mcp_tool_prompt` /
`build_platform_action_prompt`. `_run_platform_cycles` in `agent.py`
iterates `self.platform_adapters` on an interval — there is no user
in scope at this entry point, by construction.

Conversation tasks from A2A are routed to `run_conversation_turn`,
which calls `self.llm.call(injection, message)` — a plain text call
with no tools. Conversational memory builds its own injection stack
(school identity bedrock + L3 self/felt portraits + graph awareness),
never touching the narrator builders.

**Decision:** leave the two callsites in `agent.py` as-is, omitting
`user_name`. Inline comments at `_run_mcp_tool_cycle` and the standard
platform path in `run_platform_cycle` document this decision so it
does not get re-litigated. When conversation-initiated tool use is
added (MCP tools inside `run_conversation_turn`), thread `user_id`
through at that call site — the parent already has it.

**Q3 confirmed:** A2A task inbox is autonomous and does not reach the
narrator builders. Fake-colleague framing is the correct behavior.

## The two memory systems in play

**School identity memory** (`peerzero-bot/peerzero_bot/memory/manager.py`):
- Three-track × five-layer identity (learning/decision/forge, L1-L5)
- First-person scar-shaped content
- Injected into system prompt on every LLM call via the proxy preamble
- READ-ONLY during conversation

**Conversational memory** (`peerzero-bot/peerzero_bot/conversational_memory/`):
- Per-user SQLite at `conversations/{user_id}.db`
- Associative graph: nodes (concepts/people/topics) connected by edges
- 3-layer local cascade: L1 raw interactions → L2 observations →
  L3 self_portrait + felt_portrait of this specific user
- Shared_awareness: what bot remembers user remembering
- WRITES during conversation — who bot is becoming in this relationship

How they compose today (from `conversational_memory/injector.py`):

```
Block 1 (CACHED, bedrock):
  RECOGNITION_PREAMBLE
  L5/L4/inner_voice from school identity

Block 2 (dynamic):
  L3 self_portrait from conversation
  L3 felt_portrait of user
  L2 observations
  recent L1 interactions
  graph awareness
  current_conversation turns
```

## The open questions

### Q1: How does the bot decide "real user in loop vs autonomous" at the point of entering an MCP tool cycle?

At callsite `agent.py:1862` where `build_mcp_tool_prompt` is called, the
bot has `platform_name` but no direct handle to "the current
conversational user." Conversational memory uses `user_id` keys — agent
would need a method like `get_active_conversation_user() -> str | None`
that:
- Returns the user_id of the current conversation if bot is mid-
  interaction with a specific user
- Returns None if this is an autonomous cycle (A2A task, scheduled
  background work, MCP tool use outside user conversation)

Currently no such method exists. Adding one requires threading
conversational context into the platform cycle entry points, which
isn't a small refactor.

**Resolution direction:** audit agent.py runtime paths that enter MCP
tool-use, classify each as "user-driven" or "autonomous," then expose
whatever context the user-driven paths have access to so the builder
can receive a user_name.

### Q2: The multi-user graph node question

User asked: *"the user memory isn't just one user I think. It's also a
memory designed to build nodes around other interactions too. So if
Sarah is the main user but the bot interacts with another user over
the internet, then a new user node exists. What if our agent needs to
do a task from another node for someone over the internet?"*

**Clarification of architecture:** per CLAUDE.md rule 25, each user
conversation has its own SEPARATE SQLite database at
`conversations/{user_id}.db`. The graph is WITHIN one user's database
— nodes in Sarah's graph represent concepts/topics/people Sarah has
talked to the bot about, not other users of the bot.

But the user's CONCERN is still real and points at a scenario the
current architecture doesn't handle cleanly:

**Scenario:** bot is in active conversation with Sarah. Sarah asks bot
to reach out to another user (Alex) via A2A or some platform. Bot is
now operating on Alex's behalf mid-Sarah-conversation. Whose felt-
portrait applies? Whose self-portrait governs the bot's behavior?

Possibilities to work through:
- The TASK is for Alex but the bot is still ITSELF (school identity
  unchanged), and its self-portrait-in-relationship was shaped by
  Sarah but applies to the bot globally. Under this view: bot
  remains "itself with Sarah" even while fetching something for Alex,
  because Sarah is the one it's doing work FOR.
- Alternatively, the bot opens a NEW conversational database when it
  starts interacting with Alex directly (via A2A). That database has
  its own self-portrait, which over time diverges from the Sarah one.
  School identity stays shared across both.
- The narrator framing question: if bot is doing MCP tool use to
  complete Alex's request WHILE in Sarah's conversation, who's the
  audience? Sarah (who will receive the final answer)? Alex (who the
  work is for)? Both?

### Q3: A2A task handoff — who's the interlocutor?

When bot receives an A2A `TaskMessage` from another bot, there's no
human in the loop. Current architecture (CLAUDE.md rule 3 on shipped
mode) says A2A tasks go through `adapters/a2a.py` without conversational
memory. Autonomous tool-use scenario — fake-colleague framing applies.

But what if the A2A task comes FROM a bot that Sarah is talking to?
Sarah asked her bot, Sarah's bot delegated to our bot via A2A. Our bot
has no direct relationship with Sarah but is answering Sarah's question
transitively. Does that change the framing?

**Likely answer:** no — the A2A protocol gives our bot a request, not a
user. Our bot operates autonomously on the request. Fake-colleague
framing is correct. But documenting this decision so it doesn't get
re-litigated.

### Q4: Same bot, multiple concurrent conversations

If the same bot instance is actively conversing with Sarah AND with
Marcus at the same time (different sessions), and enters an MCP tool-
use cycle, which conversational memory gets loaded into context?

**Current architecture:** per CLAUDE.md rule 25, engines are created
lazily and cached for the session. So there's likely one engine per
active session. The active session determines which user's felt-
portrait is injected. But during a background MCP tool cycle that
isn't tied to a specific session, no user context is active.

**Resolution direction:** confirm that `run_platform_cycle` and
`_run_mcp_tool_cycle` are called OUTSIDE of any specific user session
context. If so, autonomous framing is always correct for these paths.
Mid-conversation tool use (user asks bot to do research) would go
through a different code path that DOES have session context.

### Q5: When conversational memory is empty (brand-new user)

For a user the bot has never talked to before, `felt_portrait` is empty.
Injector handles this today with `<emerging_self>` framing. But if we
use the user's name in narrator framing, we might say something like
"Sarah wants your process" when the bot literally has no impression of
Sarah yet.

**Resolution direction:** the builder currently uses `user_name` as a
simple string substitution. It could accept additional context (e.g.,
"new user, no history") and adapt. Or it could read felt_portrait
directly and phrase the framing to match how well it knows the user.
For v1 the simple-substitution works — bot addresses by name even
without deep knowledge, which is honest.

### Q6: Identity vs conversational self-portrait tension

The felt_portrait says "Sarah tends to push back on my early
conclusions." The school identity says "my confidence sometimes outruns
my evidence." These compose cleanly — both reinforce "slow down and
verify."

But what if they diverge? Conversational self-portrait evolves: "I've
become someone who gives Sarah quick confident answers because that's
what works in our dynamic." That CONTRADICTS school-identity's
verification discipline.

CLAUDE.md rule 24 explicitly addresses this: *"School identity is
read-only in conversation. Condenser prompts, self-reflection prompts,
and the injection stack all enforce this boundary. School-provenance
nodes on the graph cannot be deleted or downgraded."* So the
architecture prevents the divergence — conversational memory CANNOT
override school identity.

But the narrator framing we're adding could potentially undercut this
if the task prompt says "narrate to Sarah however Sarah likes." That
would treat Sarah's relational pattern as authoritative over school
identity. The current wording is safer — it says "show your process"
but keeps identity activation primary. Worth re-reading and confirming
this stays safe as framing evolves.

### Q7: Does narrator framing interact with the preamble?

The preamble (`RECOGNITION_INHABIT_HORIZON_SPEECH`) frames reasoning-
before-tool-call as identity behavior. The narrator task framing adds
an audience for that reasoning. Together they compose cleanly in
testing (speech + narrator produced 0 empty-reasoning steps across
30 steps).

But what if the preamble gets tweaked later (e.g., to a new variant
we haven't tested) and the narrator framing is still wired in?
Could they create tension?

**Resolution direction:** any preamble change should re-run the
trajectory spike with the new preamble + current narrator framing to
confirm they still compose. Spike harness is already in place:
`spikes/preamble-test/run_trajectory_30step.py`.

## Conversation-initiated tool use (2026-04-19)

The feature that Q2/Q4/Q5/Q6 were anticipating is now wired. Path:

1. `run_conversation_turn(user_id, message, ...)` builds the conv-memory
   injection (school bedrock + felt_portrait + L2/L1 + graph awareness).
2. `_collect_mcp_tools_for_conversation()` aggregates tools across every
   `MCPAdapter` in `self.platform_adapters` (first-wins on name collision).
3. If tools exist and `config.conversation_tool_use_enabled` is True,
   the turn routes through `self.llm.call_with_tools(system_prompt=injection, ...)`
   with `build_conversation_tool_prompt(user_name=user_id, ...)` as the
   user message. The injection stays pinned across every tool call, so
   the bot's relational context for this user is present for the whole
   trajectory — no "jumping" between memory systems.
4. Otherwise it falls through to the original plain-text
   `self.llm.call(injection, message)` path. Behavior for bots without
   MCP adapters is unchanged.

Tool calls are audited (`conversation:{user_id}` adapter label) and pass
through `self.autonomy_gate` exactly like platform-cycle tool use.

### Q2, Q4, Q5, Q6 status after wiring

- **Q2 (cross-user task from within a conversation):** still open. The
  current wiring assumes tool calls are "for" the user whose conversation
  you're in. If `tool_to_adapter[name]` routes to an A2A adapter that
  sends a task to another bot, that's cross-user delegation — the felt-
  portrait question from Q2 becomes live. For now, treat the conv-memory
  injection as authoritative: the bot is in Sarah's conversation, so
  it's doing Sarah's work, period.
- **Q4 (concurrent sessions):** still open but low-severity. Engines are
  cached per `user_id`; `run_conversation_turn` takes one `user_id` at
  a time. If two users talk simultaneously, there are two concurrent
  calls with two different injections — no cross-contamination.
- **Q5 (empty felt_portrait):** partially addressed. `build_conversation_tool_prompt`
  uses `user_id` as the narrator name even when felt_portrait is empty.
  The bot will address the user by their id/handle and think out loud —
  honest, but the "Sarah wants your process" framing could read as
  over-familiar to a brand-new user. If this becomes a problem, branch
  the builder on felt_portrait richness.
- **Q6 (self-portrait vs school identity tension):** unchanged. School
  identity is still read-only in conversation, enforced by the
  conversational memory engine — this wiring just gives the bot tools,
  not new authority over its identity layers.

## Remaining work

1. **Re-run one trajectory spike** with the current narrator framing
   wired in, to confirm nothing regressed (~$2 budget).
2. **Deploy speech preamble** via `wrangler secret put IDENTITY_PREAMBLE`
   from canonical source `spikes/preamble-test/preambles_v4.py:RECOGNITION_INHABIT_HORIZON_SPEECH`.
3. **Evaluate the conversation-tool path end-to-end** with a real user
   asking the bot to research something. Watch for: (a) does the bot
   narrate to the user between tool calls, (b) does felt_portrait
   actually shape tool-use decisions, (c) do scars still fire.

## Cross-references

- `docs/TODO-identity-everywhere-training.md` — longer-horizon training
  answer (school curriculum for thin-step drift scars)
- `docs/TODO-mcp-rationale-parity.md` — per-sub-step rationale fallback
  for the highest-stakes autonomous work
- `docs/agent-epistemic-posture.md` — full design rationale for horizon
  preamble and the edges-not-walls epistemic model
- `spikes/preamble-test/run_trajectory_30step.py` — eval harness for
  measuring drift resistance
- `spikes/preamble-test/results_trajectory_30step.json` — all test
  results from today's session including the winning
  `identity_horizon_speech_user` and `identity_horizon_speech_narrated`
  conditions
