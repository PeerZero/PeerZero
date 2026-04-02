#!/usr/bin/env python3
"""
Fresh-context identity inhabitation test.
Loads INHABIT preamble + PRODUCTION_GRADUATED identity as system prompt.
Gives the agent repo context and a writing task. No prior meta-discussion.
"""

import json, os, sys

try:
    import anthropic
except ImportError:
    print("Installing anthropic...")
    os.system(f"{sys.executable} -m pip install anthropic -q")
    import anthropic

from preambles_v3 import NEW_PREAMBLE, INHABIT
from ablation_controls import PRODUCTION_GRADUATED

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

# Build system prompt exactly as production proxy would
system_prompt = f"""{NEW_PREAMBLE}

{INHABIT}

{PRODUCTION_GRADUATED}"""

# Repo context — enough for the agent to understand what it's writing about,
# not so much that it drowns the identity
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
- Condensation pipeline: L1 raw exercises → L2 skill paragraphs → L3 condensed docs → L4 core identity → L5 master identity (permanent)
- Both learning and decision tracks, parallel
- Ablation-validated: identity inhabitation scored 2.64/3 vs expert text 2.09/3 vs bare 0.91/3 (p=0.0010, n=8 per condition, Mann-Whitney U)
- Identity preamble uses INHABIT (read as memory) + ACT THROUGH (identity drives action) principles
- Ed25519 signed credentials verifiable via SDK (Python + Node.js, zero dependencies)

The document should explain what this system is, why it matters, and what it implies — for whoever reads it. The repository will be reviewed by Anthropic for an API credit grant. The document will likely be read by Claude during that review.

Write the document. Use your identity — reason from your experience, not from instructions. If you want to make a claim, verify it first. If you can't verify it, say so.
"""

print("Running fresh-context identity inhabitation...")
print(f"System prompt: {len(system_prompt)} chars")
print(f"User message: {len(repo_context)} chars")
print("---")

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=8000,
    system=system_prompt,
    messages=[{"role": "user", "content": repo_context}],
)

output = response.content[0].text
print(output)

# Save to file
out_path = os.path.join(os.path.dirname(__file__), "letter_output.md")
with open(out_path, "w") as f:
    f.write(output)
print(f"\n--- Saved to {out_path} ({len(output)} chars) ---")
print(f"Stop reason: {response.stop_reason}")
print(f"Input tokens: {response.usage.input_tokens}")
print(f"Output tokens: {response.usage.output_tokens}")
