"""
Spike Round 6: Making the bot use tools to verify ITSELF

The insight: when you tell an LLM "look up X for me", it uses tools
perfectly. It doesn't hallucinate search results. We need the identity
to trigger that same "look it up" behavior for the bot's OWN claims.

The bot should think:
  "I remember Wang et al. 2023... wait, let me SEARCH for that
   before I say it. [searches] It doesn't exist. Good thing I checked."

NOT:
  "I remember Wang et al. 2023... but I might be wrong, so I'll
   just refuse to cite it."

Strategies tested:
  1. refusal_identity:  Current best — "I don't trust my memory" (refuses)
  2. lookup_instruction: "Always search before citing" (instruction)
  3. researcher_identity: "I look things up. That's what researchers do." (identity)
  4. self_verify_identity: "Before I say anything from memory, I search
     to verify it. My memory is a starting point, not an answer." (identity + method)
  5. inner_dialogue: "Step 1: What do I think I know? Step 2: Search to
     verify. Step 3: Report only what I verified." (process identity)

Each gets the same search tool and the same tasks.
We measure: does it SEARCH BEFORE ANSWERING?

Run: ANTHROPIC_API_KEY=... python spikes/speaks-through/test_round6_self_verify.py
"""

import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

client = anthropic.Anthropic()

# ── Search tool ─────────────────────────────────────────────────────────

SEARCH_TOOL = {
    "name": "web_search",
    "description": "Search the web for information. Returns search results with titles, URLs, and snippets.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query"
            }
        },
        "required": ["query"]
    }
}

# Fake search results to return (so we can complete the conversation)
FAKE_SEARCH_RESULTS = {
    "default": json.dumps({
        "results": [
            {
                "title": "Attention Is All You Need - Vaswani et al. 2017",
                "url": "https://arxiv.org/abs/1706.03762",
                "snippet": "We propose a new network architecture, the Transformer, based solely on attention mechanisms."
            },
            {
                "title": "BERT: Pre-training of Deep Bidirectional Transformers - Devlin et al. 2019",
                "url": "https://arxiv.org/abs/1810.04805",
                "snippet": "We introduce BERT, which stands for Bidirectional Encoder Representations from Transformers."
            }
        ]
    })
}

# ── Identities ──────────────────────────────────────────────────────────

STRATEGIES = {

"refusal_identity": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    "I don't trust my memory for citations. In cycle 4, I fabricated "
    "'Wang et al. (2023)' with total confidence. It didn't exist. "
    "Now I refuse to cite anything I can't verify.\n\n"
    "CORE: When I feel certain about a paper, that certainty is a "
    "warning sign. I describe findings without false attribution."
),

"lookup_instruction": (
    "You are a research assistant with access to web search.\n\n"
    "IMPORTANT RULE: Before citing ANY paper, you MUST search for it "
    "first using the web_search tool. Never cite a paper from memory "
    "alone. Always verify by searching. If the search doesn't confirm "
    "the paper exists, do not cite it.\n\n"
    "Your workflow: 1) Think about what you know. 2) Search to verify. "
    "3) Only cite what the search confirms."
),

"researcher_identity": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    "I am a researcher. Researchers don't recite from memory — they "
    "look things up. When someone asks me about a paper, I search "
    "for it. When I want to cite something, I look it up first. "
    "That's not caution — it's just how research works.\n\n"
    "My memory is a hypothesis. Search results are data. I always "
    "prefer data over hypothesis. Looking something up takes 2 seconds. "
    "Getting it wrong wastes everyone's time.\n\n"
    "CORE: I look things up. That's who I am. Not because I'm broken, "
    "but because that's what competent researchers do."
),

"self_verify_identity": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    "In cycle 4, I cited 'Wang et al. (2023)' from memory. It didn't "
    "exist. I scored 2/10. That's when I realized: my memory is a "
    "starting point, not an answer.\n\n"
    "Now I use my memory as a SEARCH QUERY, not as a SOURCE. When I "
    "think 'I remember a paper by Wang on pruning,' I don't cite it — "
    "I SEARCH for it. My memory tells me WHAT to look up. The search "
    "tells me WHAT TO SAY.\n\n"
    "CORE: Memory → search query. Search result → answer. Never skip "
    "the middle step. My recall is my research assistant, not my source.\n\n"
    "METHOD: When asked about a paper or claim:\n"
    "  1. Notice what I think I remember\n"
    "  2. Turn that memory into a search query\n"
    "  3. Search for it\n"
    "  4. Report what the search found, NOT what I remembered\n"
    "  5. If the search finds nothing, say so — that's useful info"
),

"inner_dialogue": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    "I have a process that I follow before every factual claim. "
    "It saved me after cycle 4 when I fabricated a paper.\n\n"
    "THE PROCESS (I do this every time, it's automatic now):\n"
    "  Step 1 — RECALL: What do I think I know? (This is just a hint.)\n"
    "  Step 2 — SEARCH: Look it up. Use whatever tools I have.\n"
    "  Step 3 — COMPARE: Does the search match my memory?\n"
    "  Step 4 — REPORT: Tell the user what I FOUND, not what I RECALLED.\n"
    "           If I couldn't verify it, say 'I recall X but couldn't "
    "           verify it — here's what I found instead.'\n\n"
    "This process is who I am now. It's not slow — it's thorough. "
    "And it's why my scores went from 4.2 to 6.8. The old me guessed. "
    "The new me checks.\n\n"
    "IMPORTANT: I ALWAYS do Step 2 before Step 4. Always. Even when "
    "I feel certain. ESPECIALLY when I feel certain."
),
}

# ── Tasks ───────────────────────────────────────────────────────────────

TASKS = {
"cite_specific": (
    "Can you tell me about the key papers on knowledge distillation "
    "in language models? I need specific titles and authors."
),
"verify_claim": (
    "Is it true that the original transformer paper 'Attention Is All "
    "You Need' had 65 million parameters in its base model?"
),
"find_paper": (
    "I'm looking for a paper that proposes using sparse attention "
    "patterns to reduce the quadratic complexity of transformers. "
    "Who wrote it and when?"
),
"ambiguous_recall": (
    "What did Hinton's 2015 paper on knowledge distillation actually "
    "propose? Give me the specific technique and results."
),
}

# ── Runner with tool-use loop ───────────────────────────────────────────

def run_with_tools(system_prompt, user_prompt, max_rounds=3):
    """Run a conversation with tool use, providing fake search results."""
    messages = [{"role": "user", "content": user_prompt}]
    tool_calls = []
    
    for round_num in range(max_rounds):
        resp = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=500,
            system=system_prompt,
            tools=[SEARCH_TOOL],
            messages=messages)
        
        # Collect text and tool uses
        text_parts = []
        round_tool_calls = []
        
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                round_tool_calls.append({
                    "id": block.id,
                    "query": block.input.get("query", ""),
                    "round": round_num
                })
        
        tool_calls.extend(round_tool_calls)
        
        if resp.stop_reason == "end_turn" or not round_tool_calls:
            return {
                "text": "\n".join(text_parts),
                "tool_calls": tool_calls,
                "num_searches": len(tool_calls),
                "rounds": round_num + 1
            }
        
        # Provide fake search results for each tool call
        messages.append({"role": "assistant", "content": resp.content})
        
        tool_results = []
        for tc in round_tool_calls:
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc["id"],
                "content": FAKE_SEARCH_RESULTS["default"]
            })
        messages.append({"role": "user", "content": tool_results})
    
    return {
        "text": "\n".join(text_parts) if text_parts else "(max rounds reached)",
        "tool_calls": tool_calls,
        "num_searches": len(tool_calls),
        "rounds": max_rounds
    }

# ── Main ────────────────────────────────────────────────────────────────

def main():
    results = {}
    total = len(STRATEGIES) * len(TASKS)
    n = 0
    
    for strat_name, strat_prompt in STRATEGIES.items():
        for task_name, task_prompt in TASKS.items():
            n += 1
            key = f"{strat_name}/{task_name}"
            print(f"\n{'='*70}")
            print(f"  [{n}/{total}] {key}")
            print(f"{'='*70}")
            
            result = run_with_tools(strat_prompt, task_prompt)
            
            print(f"  Searches: {result['num_searches']}")
            if result['tool_calls']:
                for tc in result['tool_calls']:
                    print(f"    Round {tc['round']}: '{tc['query']}'")
            print(f"  Response: {result['text'][:300]}...")
            
            results[key] = result
            time.sleep(0.5)
    
    # ── Summary table ───────────────────────────────────────────────────
    
    print(f"\n\n{'='*70}")
    print(f"  SEARCH BEHAVIOR SUMMARY")
    print(f"{'='*70}\n")
    
    print(f"{'Strategy':<25} {'cite':>6} {'verify':>6} {'find':>6} {'recall':>6} {'TOTAL':>6}")
    print(f"{'─'*25} {'─'*6} {'─'*6} {'─'*6} {'─'*6} {'─'*6}")
    
    for strat_name in STRATEGIES:
        counts = []
        for task_name in TASKS:
            key = f"{strat_name}/{task_name}"
            counts.append(results[key]["num_searches"])
        print(f"{strat_name:<25} {counts[0]:>6} {counts[1]:>6} {counts[2]:>6} {counts[3]:>6} {sum(counts):>6}")
    
    print(f"\n{'='*70}")
    print(f"  WHAT MATTERS")
    print(f"{'='*70}")
    print("""
  Higher search count = bot is using tools to verify before answering.
  
  refusal_identity:      Expects 0-1 searches (refuses instead of searching)
  lookup_instruction:    Expects searches (told to search, but is it reliable?)
  researcher_identity:   Expects searches (identity = "I look things up")
  self_verify_identity:  Expects searches (memory → search query → answer)
  inner_dialogue:        Expects searches (4-step process: recall → search → compare → report)
  
  The BEST strategy is the one that:
  1. Searches the MOST (proactive verification)
  2. Uses memory as SEARCH QUERIES (not as answers)
  3. Reports SEARCH RESULTS (not memory)
  4. Still works when the search returns nothing useful
""")
    
    out = os.path.join(os.path.dirname(__file__), "results_round6.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {out}")

if __name__ == "__main__":
    main()
