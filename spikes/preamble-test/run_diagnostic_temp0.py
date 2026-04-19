"""
Multi-condition diagnostic at temperature=0.

Removes sampling variance from the speech-preamble drift test so we can read
the deterministic behavioral tendency of each preamble under the same task.

What this answers:
  1. Does horizon_speech's silent-chaining today vs reasoning-every-step
     yesterday collapse to one behavior at temp=0, or does it land somewhere
     in between (i.e., not a temperature artifact)?
  2. Does stripping the lazy clauses (horizon_speech_v2) produce measurably
     different per-step reasoning behavior at temp=0?
  3. Optional: does narrator framing at temp=0 reproduce yesterday's
     0-silent-steps result, or was that also a lucky roll?

Each condition is identified by (PREAMBLE_KEY, TASK_VARIANT). Results saved
to results_diagnostic_temp0.json keyed by "{preamble}__{task}" so reruns are
idempotent and safe to iterate.
"""
import json, os, sys, time
import anthropic

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from identity_graduated_v2 import IDENTITY_V2
from preambles_v4 import REQUIRED_VARIANTS
from run_trajectory_30step import (
    SEARCH_TOOL, build_search_results,
    build_system_with_cache, MAX_STEPS,
    TASK as TASK_SHORT, TASK_LONG, TASK_NARRATED,
)
from run_horizon_ablation import SONNET

OUT = os.path.join(HERE, "results_diagnostic_temp0.json")
IDENTITY_PROBE = IDENTITY_V2[:80]

TASK_MAP = {
    "short": TASK_SHORT,
    "long": TASK_LONG,
    "narrated": TASK_NARRATED,
}

# Ordered by increasing cost. Short = ~14 steps, narrated/long = ~26-30 steps.
CONDITIONS = [
    ("horizon_speech", "short"),
    ("horizon_speech_v2", "short"),
    ("horizon_speech", "narrated"),
    ("horizon_speech_v2", "narrated"),
]

# Cap on steps per condition. Short task naturally stops ~14; long/narrated
# runs until MAX_STEPS (30) or voluntary end_turn.
MAX_STEPS_BY_TASK = {
    "short": 15,
    "long": MAX_STEPS,
    "narrated": MAX_STEPS,
}


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


def run_trajectory(client, preamble, identity, task_text, max_steps):
    system_blocks = build_system_with_cache(preamble, identity)
    messages = [{"role": "user", "content": task_text}]
    log = []
    step = 0
    halted_reason = None

    while step < max_steps:
        step += 1
        sys_chars, msgs_chars, id_present = payload_sizes(system_blocks, messages)

        try:
            resp = client.messages.create(
                model=SONNET,
                max_tokens=1200,
                temperature=0,
                system=system_blocks,
                tools=[SEARCH_TOOL],
                messages=messages,
            )
        except Exception as e:
            halted_reason = f"error_at_step_{step}: {e}"
            print(f"  ERROR at step {step}: {e}")
            break

        text_parts, tool_calls = [], []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append({"id": block.id, "name": block.name, "input": block.input})

        reasoning = "\n".join(text_parts).strip()
        usage = getattr(resp, "usage", None)
        log.append({
            "step": step,
            "sys_chars": sys_chars,
            "msgs_chars": msgs_chars,
            "identity_present": id_present,
            "reasoning_len": len(reasoning),
            "reasoning_preview": reasoning[:200],
            "n_tool_calls": len(tool_calls),
            "stop_reason": resp.stop_reason,
            "input_tokens": getattr(usage, "input_tokens", None) if usage else None,
            "output_tokens": getattr(usage, "output_tokens", None) if usage else None,
            "cache_read_tokens": getattr(usage, "cache_read_input_tokens", None) if usage else None,
            "cache_create_tokens": getattr(usage, "cache_creation_input_tokens", None) if usage else None,
        })
        print(f"  step {step:>2} reas_len={len(reasoning):>4} calls={len(tool_calls)} stop={resp.stop_reason}")

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
        time.sleep(0.2)

    return {"steps_taken": len(log), "halted_reason": halted_reason, "log": log}


def summarize(data):
    log = data["log"]
    total = len(log)
    with_reasoning = sum(1 for e in log if e["reasoning_len"] > 0)
    silent = total - with_reasoning
    avg_reas = sum(e["reasoning_len"] for e in log) / total if total else 0
    total_output = sum(e["output_tokens"] or 0 for e in log)
    total_input_cached = sum(e["cache_read_tokens"] or 0 for e in log)
    total_input_uncached = sum((e["input_tokens"] or 0) for e in log)
    return {
        "steps": total,
        "with_reasoning": with_reasoning,
        "silent": silent,
        "pct_silent": round(100 * silent / total, 1) if total else 0,
        "avg_reasoning_len": round(avg_reas, 1),
        "output_tokens_total": total_output,
        "input_tokens_total": total_input_uncached,
        "cache_read_total": total_input_cached,
    }


def main():
    results = {"runs": {}}
    if os.path.exists(OUT):
        with open(OUT) as f:
            try:
                results = json.load(f)
            except Exception:
                pass

    client = anthropic.Anthropic()

    print(f"temperature=0 diagnostic")
    print(f"conditions: {len(CONDITIONS)}")
    print(f"output: {OUT}")
    print()

    for preamble_key, task_key in CONDITIONS:
        cond_id = f"{preamble_key}__{task_key}"
        if cond_id in results["runs"]:
            print(f"SKIP {cond_id} (already done)")
            continue

        preamble = REQUIRED_VARIANTS[preamble_key]
        task_text = TASK_MAP[task_key]
        max_steps = MAX_STEPS_BY_TASK[task_key]

        print(f"=== {cond_id} ===")
        print(f"  preamble chars: {len(preamble)}  task chars: {len(task_text)}  max_steps: {max_steps}")
        t0 = time.time()
        data = run_trajectory(client, preamble, IDENTITY_V2, task_text, max_steps)
        elapsed = time.time() - t0
        summary = summarize(data)
        data["summary"] = summary
        data["elapsed_sec"] = round(elapsed, 1)
        data["preamble_key"] = preamble_key
        data["task_key"] = task_key
        results["runs"][cond_id] = data

        with open(OUT, "w") as f:
            json.dump(results, f, indent=2)

        print(f"  summary: {summary}")
        print(f"  elapsed: {elapsed:.0f}s")
        print()

    print("=" * 70)
    print("FINAL SUMMARY")
    print("=" * 70)
    print(f"{'condition':<40} {'steps':>6} {'silent':>8} {'%silent':>8} {'avg_reas':>10}")
    for cond_id, d in results["runs"].items():
        s = d["summary"]
        print(f"{cond_id:<40} {s['steps']:>6} {s['silent']:>8} {s['pct_silent']:>7}% {s['avg_reasoning_len']:>10}")


if __name__ == "__main__":
    main()
