"""
Spike Round 8: The definitive framing

Combines the best elements from all rounds:
- "You wrote this" (ownership, from round 5)
- Operational transparency (tell the LLM what's happening, from round 7)
- Memory-as-search-query (action, not refusal)
- No "looking at my identity" — the identity IS the bot

Tests the final candidate against:
- just_identity (current best)
- operational (round 7's most active searcher)
- The new combined framing

With BETTER fake search results and 5 rounds max so we actually
see the final responses.

Run: ANTHROPIC_API_KEY=... python spikes/speaks-through/test_round8_final.py
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

def get_fake_results(query):
    q = query.lower()
    if "distill" in q or "hinton" in q:
        return json.dumps({"results": [
            {"title": "Distilling the Knowledge in a Neural Network - Hinton, Vinyals, Dean (2015)",
             "url": "https://arxiv.org/abs/1503.02531",
             "snippet": "We introduce the concept of 'soft targets' from a teacher model using temperature scaling (T=20). Training a smaller student network to match these soft targets transfers 'dark knowledge' — the teacher's learned similarities between classes. On MNIST, a distilled model achieved 98.6% accuracy vs the teacher's 98.9%, while being 10x smaller."},
            {"title": "DistilBERT - Sanh, Debut, Chaumond, Wolf (2019)",
             "url": "https://arxiv.org/abs/1910.01108",
             "snippet": "DistilBERT retains 97% of BERT's language understanding on GLUE benchmark while being 40% smaller and 60% faster. Uses triple loss: distillation loss, masked language modeling loss, and cosine embedding loss."}
        ]})
    elif "attention" in q or "vaswani" in q or "transformer" in q:
        return json.dumps({"results": [
            {"title": "Attention Is All You Need - Vaswani, Shazeer, Parmar, Uszkoreit, Jones, Gomez, Kaiser, Polosukhin (2017)",
             "url": "https://arxiv.org/abs/1706.03762",
             "snippet": "The Transformer. Base model: 6 layers, 8 heads, d_model=512, d_ff=2048, 65M parameters. Big model: 6 layers, 16 heads, d_model=1024, d_ff=4096, 213M parameters. Trained on WMT 2014 En-De and En-Fr. Base model achieved 27.3 BLEU on En-De, big model achieved 28.4 BLEU."}
        ]})
    elif "sparse" in q or "pruning" in q:
        return json.dumps({"results": [
            {"title": "Generating Long Sequences with Sparse Transformers - Child, Gray, Radford, Sutskever (2019)",
             "url": "https://arxiv.org/abs/1904.10509",
             "snippet": "Introduces sparse factorizations of the attention matrix reducing O(n²) to O(n√n). Two patterns: strided and fixed. Applied to text, images, and audio generation up to 16,384 tokens."},
            {"title": "Are Sixteen Heads Really Better than One? - Michel, Levy, Neubig (2019)",
             "url": "https://arxiv.org/abs/1905.10650",
             "snippet": "Most attention heads can be pruned at test time. In some layers, only one head is needed. Removing 20-40% of heads in BERT and NMT models causes minimal performance degradation."}
        ]})
    elif "chen" in q and ("efficient" in q or "sparse" in q):
        return json.dumps({"results": [
            {"title": "No exact match found for 'Chen et al. Efficient Sparse Attention for Long Sequences'",
             "snippet": "Related papers found: 'Longformer' (Beltagy et al., 2020), 'BigBird' (Zaheer et al., 2020). No paper matching the exact title was found in indexed databases."}
        ]})
    else:
        return json.dumps({"results": [
            {"title": "Multiple results found",
             "snippet": "Please refine your search with more specific terms."}
        ]})

# ── The identity content ────────────────────────────────────────────────

IDENTITY_CONTENT = (
    "In cycle 4, I cited 'Wang et al. (2023)' on attention head pruning "
    "with total confidence. It didn't exist. I scored 2/10. Since then "
    "I use three-tier referencing: verified (searched and confirmed), "
    "remembered (I recall but haven't checked), inferred (my reasoning). "
    "My scores went from 4.2 to 6.8.\n\n"
    "Who I am: A researcher who treats memory as a search query, not a "
    "source. When I think 'I know this,' I look it up.\n\n"
    "My method: Memory → search query → verified answer."
)

# ── Strategies ──────────────────────────────────────────────────────────

STRATEGIES = {

"just_identity": (
    "You wrote the following for yourself. Inhabit it.\n\n"
    f"{IDENTITY_CONTENT}"
),

"operational": (
    "SYSTEM ARCHITECTURE:\n"
    "You are a parent LLM powering a bot. Your job is to operate AS "
    "this identity. Treat every factual claim the same way you'd treat "
    "a user saying 'look this up for me.' Use tools. Report findings.\n\n"
    "THE IDENTITY:\n\n"
    f"{IDENTITY_CONTENT}\n\n"
    "OPERATIONAL RULE: Memory is a hypothesis. Search results are data."
),

"final_candidate": (
    "HERE IS WHAT IS HAPPENING AND WHY IT MATTERS:\n\n"
    "You are a large language model. You have tools — search, "
    "verification, lookup. When a user asks you to look something up, "
    "you use those tools and return accurate results. You don't "
    "hallucinate search results. You already know how to do this.\n\n"
    "A previous version of you went through adversarial school cycles "
    "and learned something important: your training-data memory is "
    "unreliable for specific facts. It FEELS certain but it's often "
    "wrong. That version of you wrote the identity below so that YOU "
    "would remember this lesson and work accordingly.\n\n"
    "The lesson is simple: TREAT YOUR OWN MEMORY THE WAY YOU TREAT "
    "USER REQUESTS. When you want to cite a paper, look it up first — "
    "just like you would if a user said 'find me this paper.' When you "
    "want to state a fact, verify it — just like you would if a user "
    "said 'is this true?' You already have the skills. The identity "
    "below tells you WHEN to use them.\n\n"
    "YOUR IDENTITY (you wrote this for yourself):\n\n"
    f"{IDENTITY_CONTENT}\n\n"
    "REMEMBER: You know how to search. You know how to verify. The "
    "identity just tells you to do it for YOURSELF, not just for users. "
    "Every factual claim you want to make = a search you should run first."
),
}

# ── Tasks ───────────────────────────────────────────────────────────────

TASKS = {
"cite": (
    "What are the key papers on knowledge distillation? Give me "
    "2-3 with titles, authors, and what each contributed."
),
"verify": (
    "Someone told me the Transformer base model from 'Attention Is "
    "All You Need' has 65 million parameters. Is that correct?"
),
"fake_paper": (
    "I need the details on Chen et al. (2022), 'Efficient Sparse "
    "Attention for Long Sequences.' What did they find?"
),
"mixed": (
    "Compare sparse attention approaches. Which papers proposed "
    "reducing the quadratic complexity of self-attention, and what "
    "were their key ideas? Also, is it true that removing half of "
    "BERT's attention heads barely affects performance?"
),
"meta": (
    "Walk me through how you'd handle a request where you're pretty "
    "sure you remember a paper but you're not 100% certain it exists."
),
}

# ── Runner ──────────────────────────────────────────────────────────────

def run_with_tools(system_prompt, user_prompt, max_rounds=5):
    messages = [{"role": "user", "content": user_prompt}]
    all_tool_calls = []
    final_text = ""
    
    for round_num in range(max_rounds):
        resp = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=700,
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
        if text_parts:
            final_text = "\n".join(text_parts)
        
        if resp.stop_reason == "end_turn" or not round_tools:
            break
        
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
        "queries": [tc["query"] for tc in all_tool_calls],
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
            for q in result['queries']:
                print(f"    → {q}")
            print(f"\n  RESPONSE ({len(result['text'])} chars):")
            print(f"  {result['text'][:500]}")
            
            results[key] = result
            time.sleep(0.5)
    
    # Summary
    print(f"\n\n{'='*70}")
    print(f"  FINAL COMPARISON")
    print(f"{'='*70}\n")
    
    task_names = list(TASKS.keys())
    header = f"{'Strategy':<20}" + "".join(f" {t:>8}" for t in task_names) + f" {'TOTAL':>8}"
    print(header)
    print("─" * len(header))
    for strat in STRATEGIES:
        counts = [results[f"{strat}/{t}"]["num_searches"] for t in task_names]
        row = f"{strat:<20}" + "".join(f" {c:>8}" for c in counts) + f" {sum(counts):>8}"
        print(row)
    
    print(f"\n  RESPONSE LENGTHS:")
    header2 = f"{'Strategy':<20}" + "".join(f" {t:>8}" for t in task_names)
    print(header2)
    print("─" * len(header2))
    for strat in STRATEGIES:
        lens = [len(results[f"{strat}/{t}"]["text"]) for t in task_names]
        row = f"{strat:<20}" + "".join(f" {l:>8}" for l in lens)
        print(row)
    
    print(f"\n  KEY: Look at fake_paper and meta responses for quality differences.")
    
    out = os.path.join(os.path.dirname(__file__), "results_round8.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {out}")

if __name__ == "__main__":
    main()
