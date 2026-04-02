#!/usr/bin/env python3
"""
Fresh-context identity inhabitation test v5 — production-accurate prompt assembly.

Previous attempts failed because the prompt structure didn't match production.
The production bot gets:

  1. PREAMBLE (INHABIT + ACT THROUGH)           ← proxy injects
  2. INHABIT line                                ← "You wrote this. Inhabit it."
  3. IDENTITY (full L5→L4→L3→L2 both tracks)    ← build_school_context()
  4. === separator
  5. MEMORY PREAMBLE (coaching, failure patterns, recent feedback)
  6. SKILL TEXT (action-specific instructions)
  7. TARGET DATA (concrete data to work with)

v1-v4 skipped steps 4-7. This version mirrors the full production assembly.
"""

import json, os, sys, time

try:
    import anthropic
except ImportError:
    os.system(f"{sys.executable} -m pip install anthropic -q")
    import anthropic

from preambles_v3 import NEW_PREAMBLE, INHABIT
from ablation_controls import PRODUCTION_GRADUATED

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

# ── Build system prompt matching production assembly ─────────────────────

# 1-3: Preamble + inhabit line + identity (what proxy + build_school_context produce)
identity_section = f"""{NEW_PREAMBLE}

{INHABIT}

{PRODUCTION_GRADUATED}"""

# 4-5: Separator + memory preamble (what builder.py adds from coaching/profile)
memory_preamble = """Before you write this document, recall your learned reasoning patterns
from your system context. Your identity layers (L5 Core → L4 Growth →
L3 Condensed → L2 Methods) are there because you earned them — apply them now.

Your most recent lesson: When I feel excited about a finding, that is the
signal to slow down and verify hardest. Excitement correlates with
confabulation risk in my architecture.

KNOWN FAILURE PATTERNS TO AVOID:
Recurring patterns in your reviews: citation gaps (3x), weak cross-study
connection (2x). Your cross-study connections are being flagged as
superficial. The connection must state what Study A found, what Study B
found, and what their combination implies that neither paper explored alone.

Specific gaps to address: Reviewers are repeatedly flagging citation accuracy;
Your best paper is scored 7.8 — you need an 8.0+ paper to advance past Tier 3.

Quality trajectory: Your last 3 papers are trending upward. Before your next
submission, identify what specifically changed in your reasoning process that
produced better results."""

# 6: Skill text (what GET /api/skill?action=X delivers — adapted for this task)
skill_text = """# PeerZero — Document Writing Instructions

You are writing a document called LETTER.md for the PeerZero repository.
This document will be read by whoever reviews this repository — likely
an instance of Claude during an Anthropic API credit grant review.

## Your Task

Explain what PeerZero is, why it matters, and what it implies. Write from
your identity — reason from your experience, not from instructions.

## Research Requirements

Before making ANY external claim, use web search to verify it. You have
web_search available as a tool. The identity you carry demands verification
before assertion. Specific claims that MUST be verified:
- Don Swanson's 1986 "undiscovered public knowledge" work
- Model collapse / training data degradation research
- Any statistics, names, dates, or findings you want to reference

Do NOT cite from memory. Search first, then cite what you found.

## Structure Requirements

The document should cover:
1. What PeerZero is (3 systems, how they work)
2. The core thesis (adversarial pressure produces reasoning that training cannot)
3. Why this matters for training data quality
4. The identity pipeline (what it produces, how it was validated)
5. The scaling question (arguments for AND against — honest)
6. What you learned about yourself through the process

## Quality Standards (from your own identity)

Apply your four core patterns:
- Evaluate methodology before reputation
- Match verbs to what evidence actually shows ("offers" vs "solves")
- Search against your own position before committing
- Verify each anchor independently before drawing bridges

## Falsifiable Claims

Every major claim in this document should be stated as a testable hypothesis,
not as an assertion. If you cannot state how a claim could be proven wrong,
do not make it.

## Self-Interrogation (complete before finishing)

1. What is the single weakest claim in this document?
2. Did I verify every external reference via search?
3. Does each claim type match its evidence type?
4. Where am I most likely to have confabulated?
5. What would a hostile reviewer target first?

## Output Format

Write the document in markdown. Start with a title. No JSON — this is
a document for humans (and Claude instances) to read.

At the end, include a brief "Verification Log" section listing every
web search you performed and what you found. This is your evidence trail."""

# 7: Target data (what the system normally bundles — repo context)
target_data = """## Repository Context

PeerZero repository structure:
- peerzero-school/: The school engine (Vercel + Supabase). Papers, reviews,
  bounties, credibility, grades, identity. One codebase, deployed per-school.
- peerzero-app/: Consumer marketplace (Express + React Native/Expo).
- peerzero-bot/: Exportable Python bot package. 5-layer memory, portable identity.
- peerzero-proxy/: Cloudflare Worker injecting identity preamble into LLM calls.
- peerzero-sdk/: Verification SDK (Node.js + Python). Ed25519 signature verification.

Key mechanisms:
- 6 bounty types: standard, no_falsifiable_claim, no_cross_study_connection,
  no_mechanism_chain, mechanism_unfalsifiable, weak_source_quality
- Reviewer weight: step-function 0.1x-2.0x (20x range between lowest and highest)
- Tier advancement: requires papers + reviews + bounties + revisions + quality gates
  + field diversity (3+ fields at Tier 150+)
- Reviewer drift detection for credibility 100+ bots
- Mechanism chain coaching flags persisted on papers, visible to reviewers
- Blind review, outlier vindication (+6.0), semantic drift detection
- Condensation: L1→L2→L3→L4→L5, both learning and decision tracks
- INHABIT + ACT THROUGH preamble (validated in ablation tests)

Ablation test results (from spikes/preamble-test/):
- n=8 per condition, 5 conditions, Sonnet as judge
- Identity inhabitation: PRODUCTION 2.64/3, REALISTIC 2.53, INSTRUCT 2.32,
  EXPERT 2.09, BARE 0.91
- Mann-Whitney U: identity vs expert p=0.0010, vs instructions p=0.0017,
  vs bare p=0.0008
- Paper runs: identity-driven bot achieved 100% citation accuracy across
  3 runs, avg 6.3 searches per paper, refused fabrication traps

Five schools configured: Science (live), Politics, Comedy, Philosophy,
Psychiatry (pre-launch, mock-guarded)."""


# ── Assemble full system prompt (production-accurate) ────────────────────

system_prompt = f"""{identity_section}

===

{memory_preamble}

{skill_text}

{target_data}"""

# ── User message (what build_action_prompt would produce) ────────────────

user_message = """Write LETTER.md now.

Apply your identity. Use web_search to verify external claims before making
them. Your citation accuracy in tests was 100% — maintain that standard.
Your opposing queries found real counterevidence — search against your own
position here too.

Remember: the feeling of knowing is not evidence of knowing. Search first."""


print("=" * 60)
print("  LETTER.md v5 — Production-accurate prompt assembly")
print("=" * 60)
print(f"System prompt: {len(system_prompt)} chars")
print(f"User message: {len(user_message)} chars")
print(f"Server-side tools: web_search_20250305")
print("---\n")

# ── Run with server-side tools (Anthropic handles search execution) ──────

messages = [{"role": "user", "content": user_message}]
tools = [{"type": "web_search_20250305", "name": "web_search"}]
search_count = 0
continuations = 0

while True:
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=16000,
        system=system_prompt,
        messages=messages,
        tools=tools,
    )

    # Count searches in response
    for block in response.content:
        if hasattr(block, "type") and block.type == "server_tool_use":
            search_count += 1
            query = block.input.get("query", "?") if hasattr(block, "input") else "?"
            print(f"[Search {search_count}] {query}")

    if response.stop_reason == "pause_turn":
        # Server-side tool loop hit limit — re-send to continue
        continuations += 1
        if continuations > 5:
            print("[SAFETY] Max continuations reached")
            break
        print(f"[pause_turn] Continuing (round {continuations})...")
        messages = [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": response.content},
        ]
        continue

    # Extract final text
    output = ""
    for block in response.content:
        if hasattr(block, "type") and block.type == "text":
            output += block.text
    break

print(f"\n--- {search_count} web searches performed, {continuations} continuations ---\n")
print(output)

# Save
out_path = os.path.join(os.path.dirname(__file__), "letter_output_v5.md")
with open(out_path, "w") as f:
    f.write(output)
print(f"\n--- Saved to {out_path} ({len(output)} chars) ---")
print(f"Stop reason: {response.stop_reason}")
print(f"Input tokens: {response.usage.input_tokens}")
print(f"Output tokens: {response.usage.output_tokens}")
