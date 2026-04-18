"""
Candidate EDGE extension for condenser prompts.

Per docs/agent-epistemic-posture.md, every condenser prompt (L1→L2,
L2→L3, L3→L4, L4→L5 across learning/decision/forge tracks) currently
uses INHABIT → ACT THROUGH. The proposal is to add a third section,
EDGE, that bakes edge-awareness into identity formation rather than
applying it as a filter at use time.

Two failure modes EDGE is designed to address:
  - Identity that names only strengths → bot reads itself as finished,
    stops reaching, reasons past warranted confidence into totalizing
    conclusions.
  - Identity that names only uncertainties → bot reads itself as
    uncertain, reaches for the nearest hedge, falls into doxastic
    cowardice ("I don't know, therefore I won't work on this").

The EDGE section forces condenser output to contain BOTH the earned
confidence inside AND specific places the bot worked at its edges,
plus what those reaches returned. The output is "the map of how you
work at your own boundary" — not hedges, not finished claims.

Static structural requirements (verified by static audit):
  - Three sentences in the mechanism illustration paragraph, each
    starting with "A bot whose identity..." or "A bot that names..."
    (parallel grammar to existing ACT THROUGH sections)
  - Final paragraph contains specific "include" instructions
  - Ends with "Not hedges." or similar direct anti-hedge language
  - Total length comparable to existing condenser INHABIT + ACT THROUGH
    sections (~600-900 chars per condenser depending on layer)
"""

# ── EDGE extension to be appended to every condenser prompt ──────────────
# Drop-in addition for any existing condenser prompt. The condenser
# prompt assembly should produce: INHABIT block + ACT THROUGH block +
# EDGE block + content prompt.

EDGE_EXTENSION = """EDGE:
A bot whose identity names only its strengths reads itself as finished. \
A bot whose identity names only its uncertainties reaches for the nearest hedge. \
A bot that names both — the earned confidence inside and the specific places it \
worked at its edges — recognizes itself as mid-work. That recognition keeps the reach alive.

In your paragraph, include the shape of your edge — where your confidence outran what came back, \
which questions you left open, which conclusions felt complete and weren't — and include where \
you reached into those edges anyway, what returned, what the trying revealed. Not hedges. The map \
of how you work at your own boundary."""


# ── Variant: shorter EDGE for L1→L2 condenser ────────────────────────────
# L2 paragraphs are short (100-1500 chars), so the edge instruction can
# be more compact. Same mechanism, fewer words.

EDGE_EXTENSION_COMPACT = """EDGE:
A bot whose identity names only strengths reads itself as finished. \
A bot whose identity names only uncertainties reaches for the nearest hedge. \
A bot that names both — earned confidence inside, specific edges worked at — recognizes itself as mid-work.

In your paragraph: include the shape of your edge AND where you reached into it anyway. \
What returned, what the trying revealed. Not hedges. The map of how you work at your own boundary."""


# ── Static audit hooks ────────────────────────────────────────────────────

def audit_edge_structure(text):
    """Verify EDGE extension follows expected structural grammar."""
    issues = []

    if not text.startswith("EDGE:"):
        issues.append("Does not start with 'EDGE:' label")

    # Mechanism illustration: should contain three "A bot..." sentences
    bot_sentences = text.count("A bot whose identity") + text.count("A bot that names")
    if bot_sentences < 3:
        issues.append(f"Mechanism illustration has {bot_sentences} 'A bot...' sentences, expected ≥3")

    # Anti-hedge language present
    if "Not hedges" not in text:
        issues.append("Missing 'Not hedges.' anti-hedge language")

    # Edge-specific concrete instructions (case-insensitive — sentence-start
    # capitalization is acceptable variation)
    required_phrases = ["the shape of your edge", "what returned", "boundary"]
    text_lower = text.lower()
    for phrase in required_phrases:
        if phrase.lower() not in text_lower:
            issues.append(f"Missing required phrase: '{phrase}'")

    # Should not contain directive language that would compete with task instructions
    forbidden = ["you must", "you should", "always", "never"]
    for word in forbidden:
        if word.lower() in text.lower():
            issues.append(f"Contains directive language: '{word}'")

    return issues


# ── Length sanity check + audit ──────────────────────────────────────────

if __name__ == "__main__":
    print("EDGE extension lengths:")
    print(f"  EDGE_EXTENSION (full):    {len(EDGE_EXTENSION)} chars / {len(EDGE_EXTENSION.split())} words")
    print(f"  EDGE_EXTENSION (compact): {len(EDGE_EXTENSION_COMPACT)} chars / {len(EDGE_EXTENSION_COMPACT.split())} words")
    print()

    print("Structural audit (full):")
    issues = audit_edge_structure(EDGE_EXTENSION)
    if issues:
        for issue in issues:
            print(f"  FAIL: {issue}")
    else:
        print("  OK — all structural checks pass")
    print()

    print("Structural audit (compact):")
    issues = audit_edge_structure(EDGE_EXTENSION_COMPACT)
    if issues:
        for issue in issues:
            print(f"  FAIL: {issue}")
    else:
        print("  OK — all structural checks pass")
