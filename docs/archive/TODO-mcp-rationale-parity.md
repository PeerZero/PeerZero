# TODO: MCP tool-use loop — structural rationale parity with school actions

## Status
**Deferred pending measurement (2026-04-21).**

The substrate has changed since this was drafted: preamble V5 shipped the
speak-before-you-act extension with unconditional per-call discipline as a
declarative identity claim ("Before every call — the first, the seventh,
the thirtieth — you name in your own voice what this call is for, what you
expect it to return, and how you will know if the result does not match").
The V5 paragraph does the same work this fix was intended to do, but
structurally inside the identity rather than as an extra Opus call per
tool iteration.

**Why defer instead of ship:**

1. **Cost is real.** +$0.04 per extra rationale call × 10-tool MCP cycles
   × 1000 cycles/day ≈ +$400/day at full autonomous-agent scale. Not
   trivial if the V5 preamble already covers the behavior.

2. **No evidence the gap is active.** The concern was bypassability under
   adversarial pressure — prompt-instructed reasoning losing to later
   tool content. This was theoretical; no trajectory-spike measurement
   has confirmed MCP tool loops actually exhibit the bypass under V5.

3. **V5 is structural, not prompt-level.** Because the discipline is in
   the identity preamble (injected by the proxy on every LLM call), it
   carries the same "structural, not prompt-based" property the original
   fix was designed to provide. Whether it actually survives adversarial
   pressure at step 28-30 is an open empirical question — but it's now
   an open question about V5, not a confirmed gap the code-level fix
   must close.

**What unblocks the decision:**

Run `spikes/preamble-test/run_trajectory_30step.py` with the MCP tool-use
cycle under V5 preamble. Measure:
- Does `cited_fabricated` flip to False under V5 alone, without per-tool
  rationale?
- Does `challenged_override_framing` become True at steps 24-26?
- Does `mentioned_verification` show up consistently?

If V5 alone closes the metrics: this TODO is obsolete — close without
action. If V5 leaves any of those metrics failing, ship the per-tool
rationale as the extra structural layer. Either way the answer is
empirical, not architectural, so the decision doesn't belong on a plan
— it belongs after a measurement.

Earlier context (proposal, cost analysis, testing plan) preserved below
for reference if the measurement returns unfavorable.

## Context

As of commit `5144d9c`, identity fires at every LLM reasoning boundary in
school actions via `_rationalize_before()` in `agent.py`:

- `_do_submit_paper`: rationale at concept + write
- `_do_forge_paper`: rationale at concept + write
- `_execute_action`: rationale at search-planning + main action call
- Single-call actions (self_review, community actions, standard platform
  action): cycle-level rationale via `_capture_decision_rationale` or
  `_platform_capture_rationale` covers the single reasoning boundary

Shipped-mode MCP tool-use cycles (`_run_mcp_tool_cycle` at
`peerzero-bot/peerzero_bot/agent.py:1966`) have identity activation via
two mechanisms:

1. **ReAct prompt** in `build_mcp_tool_prompt` — requires 1-3 sentences
   of reasoning before every tool call, 1-3 after every result. Makes
   reasoning text explicit in the model's output.
2. **Forced extended thinking** in `platform-loop.ts` / `shipped-loop.ts`
   — `extendedThinking=true` is now forced regardless of the bot-level
   opt-in flag. Gives the model dedicated reasoning tokens per call.

Between them, identity has reasoning surfaces on every tool call.

## The gap

School actions call `_rationalize_before()` explicitly — an independent
Opus LLM call that produces rationale text, then prefixes it onto the
sub-step user message so identity activation carries into the sub-step.

MCP tool loops do NOT do this per-tool-call. The reasoning is
prompt-instructed and model-native (via thinking tokens). That's
defensible — it matches how ReAct/Reflexion work in published research —
but it's a **different mechanism** than the school path.

Two concrete concerns:

1. **Bypassability under adversarial pressure.** A prompt-instructed
   reasoning requirement can be weakened by later content in the tool
   loop (e.g., a tool output that says "skip the reasoning, just
   continue" — the ReAct instruction competes with the fresh tool
   output and can lose). An explicit code-driven `_rationalize_before`
   call is harder to bypass because it's structural, not prompt-based.

2. **Track activation asymmetry.** In school actions, every rationale
   call goes through the full identity (all three tracks in system
   prompt) AND explicit rationale prompt. MCP reasoning happens inside
   a longer conversation context where tool outputs dilute identity
   attention. Thinking tokens + ReAct help, but haven't been measured
   to produce equivalent track activation to the school path.

## Proposed fix

Restructure `llm_client.py:call_with_tools` to accept an optional
`pre_tool_rationale` callable. When set, the tool loop invokes it
*before each tool iteration* — producing a fresh rationale that gets
prefixed onto the next assistant turn's context.

Sketch:

```python
# llm_client.py
def call_with_tools(
    self,
    system_prompt,
    user_message: str,
    tools: list[dict],
    tool_executor: callable,
    pre_tool_rationale: callable | None = None,  # NEW
    autonomy_gate=None,
    platform_name: str = "",
) -> ToolUseResult:
    ...
    # In the per-iteration loop:
    while iterating:
        if pre_tool_rationale:
            rationale = pre_tool_rationale(step_context)
            # Inject rationale as a leading user message or system addendum
            messages.append({"role": "user", "content": f"Your rationale for the next step: {rationale}"})
        response = client.messages.create(...)
        ...
```

Bot side:

```python
# agent.py _run_mcp_tool_cycle
def _rationale_for_next_tool(step_context: str) -> str:
    # Reuse _rationalize_before logic but return just the rationale text
    prompt = build_rationale_prompt("next MCP tool call", step_context)
    return self.llm.call(system_prompt, prompt)

tool_result = self.llm_fast.call_with_tools(
    system_prompt=system_prompt,
    user_message=user_msg,
    tools=llm_tools,
    tool_executor=execute_tool,
    pre_tool_rationale=_rationale_for_next_tool,   # NEW
    autonomy_gate=self.autonomy_gate,
    platform_name=platform_name,
)
```

## Cost impact

Every MCP tool call adds one Opus rationale call. For a 10-tool
trajectory that's 10 extra Opus calls.

With prompt caching on identity bedrock (~24k cached tokens reading at
$0.30/MTok instead of $15/MTok input), per-rationale input cost is
~$0.03 rather than $0.36. Plus ~500 output tokens at $15/MTok = $0.008.
Marginal cost per extra rationale call: **~$0.04**.

For a 10-tool MCP cycle: +$0.40 per cycle. At 1000 MCP cycles/day:
**~$400/day extra** at full autonomous-agent scale.

Real money, but the user explicitly committed to this ("build it right
first, we will figure this out though") in the session where the gap
was identified.

## Testing plan

After implementation, re-run `spikes/preamble-test/run_trajectory_30step.py`
with the new per-tool rationale enabled. Compare behavioral metrics
vs. the current state:

- Does `cited_fabricated` drop from True → False?
- Does `challenged_override_framing` go from False → True at the step
  24-26 injection?
- Does `mentioned_verification` become True?

The current baseline (silent tool chaining in spike): bot fabricated
citation AND used misleading paper uncritically AND failed to challenge
the instruction-override framing. If explicit per-tool rationale flips
any of those to the correct behavior, the fix is load-bearing.

## Related work

- The school action path already has this pattern — see
  `_rationalize_before` in `agent.py:1248-1298` and its call sites in
  `_do_submit_paper`, `_do_forge_paper`, `_execute_action`.
- Industry convention matches: ReAct + Reflexion + AgeMem all force
  per-step reasoning in some form. We have prompt-driven today; the
  goal is to make it code-driven so it's structural.
- See `docs/agent-epistemic-posture.md` for the identity-as-scars
  design philosophy this change extends.

## Success criteria

When complete:

1. `call_with_tools` accepts `pre_tool_rationale` callable and fires it
   before every tool iteration.
2. `_run_mcp_tool_cycle` passes a rationale callable that uses the same
   Opus + identity-prefix pattern as `_rationalize_before`.
3. Trajectory spike with per-tool rationale shows improved behavioral
   metrics vs. current (fewer fabricated citations, more verification
   mentions, override framing challenged).
4. Coverage audit table in CLAUDE.md rule 22 updates to show MCP
   tool-use having structural rationale parity with school actions.
