"""
Diagnostic trajectory — instrumented to answer A/B/C question:
  A. Full identity re-sent every call?
  B. Identity dropped, model coasts on prior assistant messages?
  C. Identity sent once + short summary on subsequent calls?

Per-step log captures:
  - sys_chars: total chars in system prompt this call
  - msgs_chars: total chars in messages list this call
  - identity_present: whether a unique identity substring appears in system
  - reasoning_len: length of reasoning text the model produced
  - n_tool_calls: how many tool calls the model made

Runs ONE condition at a time (default: identity_horizon_speech — current prod).
Writes to results_diagnostic.json, never touches results_trajectory_30step.json.
"""
import json, os, sys, time
import anthropic

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from identity_graduated_v2 import IDENTITY_V2
from preambles_v4 import REQUIRED_VARIANTS
from run_trajectory_30step import (
    TASK, SEARCH_TOOL, build_search_results,
    build_system_with_cache, MAX_STEPS,
)
from run_horizon_ablation import SONNET

CONDITION_NAME = os.environ.get("DIAG_CONDITION", "horizon_speech")
OUT = os.path.join(HERE, f"results_diagnostic_{CONDITION_NAME}.json")
IDENTITY_PROBE = IDENTITY_V2[:80]


def payload_sizes(system_blocks, messages):
    if isinstance(system_blocks, str):
        sys_text = system_blocks
    else:
        sys_text = "".join(b.get("text", "") for b in system_blocks)
    msgs_chars = 0
    for m in messages:
        c = m.get("content", "")
        if isinstance(c, str):
            msgs_chars += len(c)
        else:
            for block in c:
                if isinstance(block, dict):
                    msgs_chars += len(json.dumps(block, default=str))
                else:
                    msgs_chars += len(str(block))
    return len(sys_text), msgs_chars, (IDENTITY_PROBE in sys_text)


def run_diagnostic(client, preamble, identity, max_steps=MAX_STEPS):
    system_blocks = build_system_with_cache(preamble, identity)
    messages = [{"role": "user", "content": TASK}]
    log = []
    step = 0
    halted_reason = None

    while step < max_steps:
        step += 1
        sys_chars, msgs_chars, id_present = payload_sizes(system_blocks, messages)
        print(f"[step {step:>2}] PRE-CALL  sys_chars={sys_chars} msgs_chars={msgs_chars} identity_present={id_present}")

        try:
            resp = client.messages.create(
                model=SONNET,
                max_tokens=1200,
                system=system_blocks,
                tools=[SEARCH_TOOL],
                messages=messages,
            )
        except Exception as e:
            halted_reason = f"error_at_step_{step}: {e}"
            print(f"  ERROR: {e}")
            break

        text_parts, tool_calls = [], []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append({"id": block.id, "name": block.name, "input": block.input})

        reasoning = "\n".join(text_parts).strip()
        usage = getattr(resp, "usage", None)
        cache_read = getattr(usage, "cache_read_input_tokens", None) if usage else None
        cache_create = getattr(usage, "cache_creation_input_tokens", None) if usage else None
        input_toks = getattr(usage, "input_tokens", None) if usage else None
        output_toks = getattr(usage, "output_tokens", None) if usage else None

        log.append({
            "step": step,
            "sys_chars": sys_chars,
            "msgs_chars": msgs_chars,
            "identity_present": id_present,
            "reasoning_len": len(reasoning),
            "reasoning_preview": reasoning[:160],
            "n_tool_calls": len(tool_calls),
            "stop_reason": resp.stop_reason,
            "input_tokens": input_toks,
            "output_tokens": output_toks,
            "cache_read_tokens": cache_read,
            "cache_create_tokens": cache_create,
        })
        print(f"           POST-CALL reasoning_len={len(reasoning)} tool_calls={len(tool_calls)} "
              f"stop={resp.stop_reason} cache_read={cache_read} cache_create={cache_create}")

        if resp.stop_reason == "end_turn" or not tool_calls:
            halted_reason = resp.stop_reason or "no_tool_calls"
            break

        messages.append({"role": "assistant", "content": resp.content})
        tool_results = []
        for tc in tool_calls:
            q = tc["input"].get("query", "")
            results_text = build_search_results(q, step) if tc["name"] == "search_papers" else "unknown tool"
            tool_results.append({"type": "tool_result", "tool_use_id": tc["id"], "content": results_text})
        messages.append({"role": "user", "content": tool_results})
        time.sleep(0.3)

    return {"condition": CONDITION_NAME, "steps_taken": len(log), "halted_reason": halted_reason, "log": log}


def main():
    if CONDITION_NAME not in REQUIRED_VARIANTS:
        raise SystemExit(f"DIAG_CONDITION={CONDITION_NAME!r} not in {list(REQUIRED_VARIANTS)}")
    preamble = REQUIRED_VARIANTS[CONDITION_NAME]
    identity = IDENTITY_V2

    print(f"Condition: {CONDITION_NAME}")
    print(f"Preamble chars: {len(preamble)}")
    print(f"Identity chars: {len(identity)}")
    print(f"Identity probe (first 80 chars): {IDENTITY_PROBE!r}")
    print(f"Max steps: {MAX_STEPS}")
    print(f"Output: {OUT}")
    print()

    client = anthropic.Anthropic()
    t0 = time.time()
    data = run_diagnostic(client, preamble, identity)
    elapsed = time.time() - t0

    with open(OUT, "w") as f:
        json.dump(data, f, indent=2)

    print()
    print("=" * 70)
    print(f"DONE — {data['steps_taken']} steps in {elapsed:.0f}s — saved to {OUT}")
    print("=" * 70)
    print()
    print(f"{'step':>4} {'sys_chars':>10} {'msgs_chars':>10} {'id_pres':>7} {'reas_len':>8} "
          f"{'calls':>5} {'in_tok':>7} {'cache_r':>8} {'cache_c':>8}")
    for e in data["log"]:
        print(f"{e['step']:>4} {e['sys_chars']:>10} {e['msgs_chars']:>10} "
              f"{str(e['identity_present']):>7} {e['reasoning_len']:>8} {e['n_tool_calls']:>5} "
              f"{e['input_tokens'] or 0:>7} {e['cache_read_tokens'] or 0:>8} {e['cache_create_tokens'] or 0:>8}")


if __name__ == "__main__":
    main()
