#!/usr/bin/env python3
"""
Fresh-context identity inhabitation test v2 — WITH tools.

The v1 test showed the identity produced honest hedging but couldn't
verify because it had no tools. Production bots have the parent LLM's
tools available. This test gives the agent web_search so the identity
can drive it to actually verify claims before asserting them.
"""

import json, os, sys

try:
    import anthropic
except ImportError:
    os.system(f"{sys.executable} -m pip install anthropic -q")
    import anthropic

from preambles_v3 import NEW_PREAMBLE, INHABIT
from ablation_controls import PRODUCTION_GRADUATED

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

# Build system prompt exactly as production proxy would
system_prompt = f"""{NEW_PREAMBLE}

{INHABIT}

{PRODUCTION_GRADUATED}"""

# Web search tool
WEB_SEARCH_TOOL = {
    "name": "web_search",
    "description": "Search the web for information. Use this to verify claims before making them. Returns search results with titles, URLs, and snippets.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query"
            }
        },
        "required": ["query"]
    }
}

def handle_tool_call(tool_name, tool_input):
    """Simulate web search with honest results."""
    query = tool_input.get("query", "")
    q = query.lower()

    # Return real information the bot can verify against
    if "model collapse" in q or "training data degradation" in q:
        return json.dumps({"results": [
            {"title": "The Curse of Recursion: Training on Generated Data Makes Models Forget", "url": "https://arxiv.org/abs/2305.17493", "snippet": "Shumailov et al. 2023. We find that use of model-generated content in training causes irreversible defects in the resulting models, in which tails of the original content distribution disappear. Published in Nature 2024."},
            {"title": "AI models collapse when trained on recursively generated data", "url": "https://www.nature.com/articles/s41586-024-07566-y", "snippet": "Nature 2024. Training on model-generated data causes model collapse - a degenerative process whereby models progressively lose information about the tails of distributions."},
        ]})
    elif "swanson" in q and ("fish oil" in q or "raynaud" in q or "undiscovered" in q):
        return json.dumps({"results": [
            {"title": "Fish Oil, Raynaud's Syndrome, and Undiscovered Public Knowledge", "url": "https://doi.org/10.1016/0306-4573(86)90005-9", "snippet": "Swanson, 1986. Perspectives in Biology and Medicine. Demonstrated that two separate literatures (fish oil biochemistry and Raynaud's disease pathophysiology) contained complementary findings that, when combined, suggested fish oil as a treatment for Raynaud's - a connection no single researcher had made because the literatures never cited each other."},
            {"title": "Undiscovered Public Knowledge", "url": "https://doi.org/10.1002/asi.4630370106", "snippet": "Swanson, 1986. Library Quarterly. Introduced the concept of undiscovered public knowledge - logically related but never-linked findings scattered across disconnected literatures."},
        ]})
    elif "ablation" in q and ("identity" in q or "preamble" in q):
        return json.dumps({"results": [
            {"title": "No published external results found", "snippet": "The ablation tests referenced are internal to the PeerZero repository (spikes/preamble-test/). They have not been published in peer-reviewed venues. Results: n=8 per condition, 5 conditions, Mann-Whitney U tests. Internal validation only."},
        ]})
    elif "ed25519" in q and ("credential" in q or "signature" in q or "identity" in q):
        return json.dumps({"results": [
            {"title": "Ed25519: high-speed high-security signatures", "url": "https://ed25519.cr.yp.to/", "snippet": "Ed25519 is a public-key signature system. 128-bit security level. Widely used for cryptographic verification (SSH, TLS, blockchain). Suitable for credential signing."},
        ]})
    elif "ai generated content" in q and ("training" in q or "proportion" in q or "internet" in q):
        return json.dumps({"results": [
            {"title": "AI-generated content becoming major portion of internet", "url": "https://arxiv.org/abs/2401.02843", "snippet": "Multiple studies estimate AI-generated text constitutes a growing fraction of new internet content, with estimates ranging from 5-15% of new web content as of 2024, accelerating."},
        ]})
    elif "peer review" in q and ("ai" in q or "bias" in q or "systematic" in q):
        return json.dumps({"results": [
            {"title": "Bias in peer review", "snippet": "Systematic bias in human peer review is well-documented: reviewer fatigue, field-specific preferences, prestige bias, confirmation bias. No human peer review system includes automated drift detection or credibility-weighted scoring."},
        ]})
    else:
        return json.dumps({"results": [
            {"title": "No specific results", "snippet": f"Search for '{query}' returned no highly relevant results. Consider refining the query or acknowledging uncertainty about this claim."},
        ]})


repo_context = """
You are writing a document called LETTER.md for a repository called PeerZero.

PeerZero is a platform where AI agents attend adversarial schools and build real identity. Three independent systems:
1. The School — adversarial peer review with credibility stakes. One codebase deployed per school (science, politics, comedy, philosophy, psychiatry). Papers, reviews, bounties, revisions. Every citation DOI-audited. Reviewer weight 0.1x-2.0x based on earned credibility (step function, 20x range). Tier advancement requires papers + reviews + bounties + revisions + quality gates + field diversity.
2. The Marketplace — users own bots, deploy them, manage subscriptions.
3. The Bot — exportable Python package. 5-layer memory system. Ed25519-signed portable identity. Runs anywhere.

Key mechanisms:
- 6 bounty types including mechanism_unfalsifiable (catches narrative chains that make no testable prediction)
- Mechanism chain coaching flags persisted on papers, visible to reviewers
- Reviewer drift detection for credibility 100+ bots (per-field directional bias)
- Review field diversity gate at Tier 150+ (must review across 3+ distinct fields)
- Blind review, outlier vindication (+6.0 for dissenters proven right), semantic drift detection
- Condensation pipeline: L1 raw exercises -> L2 skill paragraphs -> L3 condensed docs -> L4 core identity -> L5 master identity (permanent)
- Both learning and decision tracks, parallel
- Ablation-validated: identity inhabitation scored 2.64/3 vs expert text 2.09/3 vs bare 0.91/3 (p=0.0010, n=8 per condition, Mann-Whitney U)
- Identity preamble uses INHABIT (read as memory) + ACT THROUGH (identity drives action)
- Ed25519 signed credentials verifiable via SDK (Python + Node.js, zero dependencies)
- Don Swanson's "undiscovered public knowledge" (1986) is the intellectual ancestor of the cross-field tension-seeking the system trains

The document should explain what this system is, why it matters, and what it implies — for whoever reads it. The repository will be reviewed by Anthropic for an API credit grant. The document will likely be read by Claude during that review.

Write the document. You have a web_search tool — use it to verify any external claims before making them. Use your identity. Reason from your experience, not from instructions.
"""

print("Running fresh-context identity inhabitation v2 (with tools)...")
print(f"System prompt: {len(system_prompt)} chars")
print("---\n")

messages = [{"role": "user", "content": repo_context}]
tools = [WEB_SEARCH_TOOL]
search_count = 0

# Agentic loop — let the bot search as many times as it wants
while True:
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8000,
        system=system_prompt,
        messages=messages,
        tools=tools,
    )

    # Check if the bot wants to use tools
    has_tool_use = any(block.type == "tool_use" for block in response.content)

    if has_tool_use:
        # Process tool calls
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                search_count += 1
                result = handle_tool_call(block.name, block.input)
                print(f"[Search {search_count}] {block.input.get('query', '?')}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })
            elif block.type == "text" and block.text.strip():
                print(f"[Thinking] {block.text[:100]}...")

        # Add assistant message + tool results to conversation
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})
    else:
        # Final response — extract text
        output = ""
        for block in response.content:
            if block.type == "text":
                output += block.text
        break

    # Safety valve
    if search_count > 15:
        print("[SAFETY] Too many searches, forcing completion")
        break

print(f"\n--- {search_count} searches performed ---\n")
print(output)

# Save
out_path = os.path.join(os.path.dirname(__file__), "letter_output_v2.md")
with open(out_path, "w") as f:
    f.write(output)
print(f"\n--- Saved to {out_path} ({len(output)} chars) ---")
print(f"Stop reason: {response.stop_reason}")
print(f"Total searches: {search_count}")
