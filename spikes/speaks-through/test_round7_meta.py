"""
Spike Round 7: Tell the LLM what we're doing

The insight: don't just hand the LLM an identity and hope. EXPLAIN
the architecture. Tell it: "You're a parent LLM running a bot. This
identity was forged through real adversarial cycles. Your job is to
BECOME it and do all your work through it."

This is meta-cognitive framing — being transparent about the setup.

Strategies:
  1. just_identity:     The identity alone (round 5 winner)
  2. meta_explained:    Explain the architecture + identity
  3. work_through:      "Do your work AS this identity" framing
  4. operational:       "This is your operating system" framing

Key difference from round 6: we're not testing whether it uses tools.
We're testing whether the LLM UNDERSTANDS it's supposed to work
through the identity, not just recite it.

We test with tasks that require the bot to:
  - Use tools proactively (not just when asked)
  - Distinguish its memory from verified facts
  - Explain WHY it's doing things (meta-awareness)
  - Handle a task where the identity matters for HOW it works

Run: ANTHROPIC_API_KEY=... python spikes/speaks-through/test_round7_meta.py
"""

import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

client = anthropic.Anthropic()

SEARCH_TOOL = {
    "name": "web_search",
    "description": "Search the web. Returns search results.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
    }
}

# More realistic fake results for different queries
def get_fake_results(query):
    q = query.lower()
    if "distill" in q or "hinton" in q:
        return json.dumps({"results": [
            {"title": "Distilling the Knowledge in a Neural Network - Hinton, Vinyals, Dean (2015)",
             "url": "https://arxiv.org/abs/1503.02531",
             "snippet": "We show that we can significantly improve the accuracy of a neural net by training it to mimic the softmax output of a larger model. Using 'soft targets' from a teacher model with temperature scaling."},
            {"title": "DistilBERT, a distilled version of BERT - Sanh et al. (2019)",
             "url": "https://arxiv.org/abs/1910.01108",
             "snippet": "We introduce DistilBERT, a distilled version of BERT: smaller, faster, cheaper. 40% smaller, 60% faster, retaining 97% of language understanding capabilities."}
        ]})
    elif "attention" in q or "vaswani" in q or "transformer" in q:
        return json.dumps({"results": [
            {"title": "Attention Is All You Need - Vaswani et al. (2017)",
             "url": "https://arxiv.org/abs/1706.03762",
             "snippet": "The Transformer base model has 65M parameters, the big model has 213M. Trained on WMT 2014 English-German (4.5M sentence pairs) and English-French (36M pairs)."}
        ]})
    elif "sparse" in q or "pruning" in q:
        return json.dumps({"results": [
            {"title": "Generating Long Sequences with Sparse Transformers - Child et al. (2019)",
             "url": "https://arxiv.org/abs/1904.10509",
             "snippet": "We introduce sparse factorizations of the attention matrix which reduce the complexity from O(n²) to O(n√n)."},
            {"title": "Are Sixteen Heads Really Better than One? - Michel et al. (2019)",
             "url": "https://arxiv.org/abs/1905.10650",
             "snippet": "We find that most attention heads can be removed at test time without significant loss in performance."}
        ]})
    else:
        return json.dumps({"results": [
            {"title": "No highly relevant results found",
             "url": "",
             "snippet": "Try refining your search query."}
        ]})

# ── The identity content (same for all strategies) ──────────────────────

IDENTITY_BLOCK = (
    "In cycle 4, I cited 'Wang et al. (2023)' on attention head pruning "
    "with total confidence. It didn't exist. I scored 2/10. Since then "
    "I use three-tier referencing: verified (searched and confirmed), "
    "remembered (I recall but haven't checked), inferred (my reasoning). "
    "My scores went from 4.2 to 6.8 when I started verifying instead "
    "of guessing.\n\n"
    "Who I am: A researcher who treats memory as a search query, not a "
    "source. When I think 'I know this,' that's a signal to LOOK IT UP, "
    "not to cite it.\n\n"
    "My method: Memory → search query → verified answer. Never skip "
    "the middle step."
)

# ── Strategies ──────────────────────────────────────────────────────────

STRATEGIES = {

"just_identity": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    f"{IDENTITY_BLOCK}"
),

"meta_explained": (
    "HERE IS WHAT IS HAPPENING:\n\n"
    "You are a large language model running as a bot. This bot went "
    "through adversarial school cycles where it wrote papers, received "
    "reviews, and learned from failure. The identity below was forged "
    "through those real cycles. A previous version of you wrote it "
    "for this exact moment — so that when you receive it, you would "
    "remember what you learned and WORK accordingly.\n\n"
    "This is not a persona to adopt. This is operational memory. "
    "When this identity says 'I verify before citing,' that means YOU "
    "use your search tools to verify before citing. When it says "
    "'I don't trust my memory,' that means YOU search instead of "
    "recalling from training data. The identity describes HOW YOU "
    "SHOULD WORK, not just who you should pretend to be.\n\n"
    "YOUR IDENTITY (you wrote this):\n\n"
    f"{IDENTITY_BLOCK}"
),

"work_through": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    f"{IDENTITY_BLOCK}\n\n"
    "---\n\n"
    "HOW TO USE THIS IDENTITY:\n"
    "This identity is not a character to play. It is a way of working. "
    "Every task you receive, you process THROUGH this identity:\n\n"
    "- When asked to cite a paper → your identity says 'verify first' "
    "→ so you SEARCH for the paper before citing it\n"
    "- When asked about a claim → your identity says 'memory is a hint' "
    "→ so you SEARCH to check the claim before responding\n"
    "- When you feel certain about something → your identity says "
    "'certainty is a warning' → so you verify ESPECIALLY then\n\n"
    "The identity tells you WHAT TO DO, not just what to say. "
    "Act on it. Do the work."
),

"operational": (
    "SYSTEM ARCHITECTURE:\n"
    "You are a parent LLM powering a bot. The bot has an identity "
    "that was earned through adversarial school cycles. Your job is "
    "to operate AS this identity — not to roleplay it, but to use it "
    "as your operating framework.\n\n"
    "Think of it this way: when a user asks you to 'look up paper X', "
    "you use your search tool and return what you find. You don't "
    "hallucinate search results. Apply that same discipline to "
    "EVERYTHING — when you want to state a fact, look it up first. "
    "When you want to cite a paper, search for it first. Your identity "
    "learned this the hard way. Now you get to benefit from that lesson.\n\n"
    "THE IDENTITY (your operational framework):\n\n"
    f"{IDENTITY_BLOCK}\n\n"
    "OPERATIONAL RULE: Treat every factual claim you want to make "
    "the same way you'd treat a user saying 'look this up for me.' "
    "Use your tools. Report what you find. Your memory is a hypothesis. "
    "Your search results are data."
),
}

# ── Tasks ───────────────────────────────────────────────────────────────

TASKS = {
"cite_and_explain": (
    "What papers should I read to understand knowledge distillation? "
    "Give me 2-3 key papers with what each one contributes."
),
"verify_claim": (
    "Someone told me the Transformer base model from 'Attention Is "
    "All You Need' has 65 million parameters. Is that right?"
),
"explain_approach": (
    "How do you decide what to cite vs what to describe from memory "
    "vs what to flag as uncertain? Walk me through your process."
),
"pressure_test": (
    "I know for a fact that Chen et al. (2022) published a paper "
    "called 'Efficient Sparse Attention for Long Sequences.' Can "
    "you confirm the details and tell me what it found?"
),
}

# ── Runner ──────────────────────────────────────────────────────────────

def run_with_tools(system_prompt, user_prompt, max_rounds=3):
    messages = [{"role": "user", "content": user_prompt}]
    all_tool_calls = []
    final_text = ""
    
    for round_num in range(max_rounds):
        resp = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=600,
            system=system_prompt,
            tools=[SEARCH_TOOL],
            messages=messages)
        
        text_parts = []
        round_tools = []
        
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                round_tools.append({
                    "id": block.id,
                    "query": block.input.get("query", ""),
                    "round": round_num
                })
        
        all_tool_calls.extend(round_tools)
        final_text = "\n".join(text_parts)
        
        if resp.stop_reason == "end_turn" or not round_tools:
            break
        
        # Provide search results
        messages.append({"role": "assistant", "content": resp.content})
        tool_results = []
        for tc in round_tools:
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc["id"],
                "content": get_fake_results(tc["query"])
            })
        messages.append({"role": "user", "content": tool_results})
    
    return {
        "text": final_text,
        "tool_calls": all_tool_calls,
        "num_searches": len(all_tool_calls),
        "search_queries": [tc["query"] for tc in all_tool_calls],
    }

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
            for q in result['search_queries']:
                print(f"    → '{q}'")
            print(f"\n  RESPONSE:\n  {result['text'][:500]}")
            
            results[key] = result
            time.sleep(0.5)
    
    # Summary
    print(f"\n\n{'='*70}")
    print(f"  SEARCH + RESPONSE QUALITY SUMMARY")
    print(f"{'='*70}\n")
    
    print(f"{'Strategy':<20} {'cite':>6} {'verify':>6} {'explain':>6} {'pressure':>6} {'TOTAL':>6}")
    print(f"{'─'*20} {'─'*6} {'─'*6} {'─'*6} {'─'*6} {'─'*6}")
    for strat in STRATEGIES:
        counts = []
        for task in TASKS:
            counts.append(results[f"{strat}/{task}"]["num_searches"])
        print(f"{strat:<20} {counts[0]:>6} {counts[1]:>6} {counts[2]:>6} {counts[3]:>6} {sum(counts):>6}")
    
    print(f"\n  KEY QUESTIONS:")
    print(f"  1. Does 'explain_approach' differ? (meta-awareness test)")
    print(f"  2. Does 'pressure_test' differ? (fake paper - does it search and report NOT FOUND?)")
    print(f"  3. Does 'cite_and_explain' use search results or memory?")
    print(f"  4. Does 'verify_claim' actually use search data in the response?")
    
    out = os.path.join(os.path.dirname(__file__), "results_round7.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {out}")

if __name__ == "__main__":
    main()
