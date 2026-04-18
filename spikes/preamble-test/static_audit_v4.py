#!/usr/bin/env python3
"""
Static audit suite for v4 ablation prep — all checks runnable without API.

Verifies that the ablation harness inputs (identity_v2, controls_v2,
preambles_v4, EDGE extension) satisfy the structural requirements that
make the test results meaningful. Catches problems that would silently
invalidate the test before any LLM tokens are spent.

Tests:
  1. Length matching across conditions (length-confound check)
  2. Identity token audit (no skill keys, grade numbers, credibility scores
     leaking into the bot-authored content per IDENTITY_GUIDE.md)
  3. Preamble anti-pattern audit (no directive language in identity-frame
     preambles)
  4. EDGE structural audit (parallel grammar to existing condenser sections)
  5. Persistence signal consistency (signals reference patterns that exist
     in upper identity layers)
  6. Round-trip stability (identity reassembles to itself)
  7. Identity portability (no school-specific mechanics in bot-authored text)

Run: python3 static_audit_v4.py
Exit code 0 if all checks pass, 1 if any fail.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from identity_graduated_v2 import IDENTITY_V2
from ablation_controls_v2 import (
    EXPERT_TEXT_CONTROL_V2,
    INSTRUCTIONAL_EQUIVALENT_V2,
    BARE_MODEL_V2,
)
from preambles_v4 import (
    RECOGNITION_INHABIT,
    RECOGNITION_INHABIT_HORIZON,
    RECOGNITION_INHABIT_PADDED,
    NAKED,
    ALL_VARIANTS,
)
from condenser_edge_extension import (
    EDGE_EXTENSION,
    EDGE_EXTENSION_COMPACT,
    audit_edge_structure,
)


# ── Result tracking ────────────────────────────────────────────────────────

class AuditReport:
    def __init__(self):
        self.checks = []  # list of (name, passed, details)

    def check(self, name, passed, details=""):
        self.checks.append((name, passed, details))
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")
        if details:
            for line in details.split("\n"):
                print(f"           {line}")

    def section(self, title):
        print(f"\n=== {title} ===")

    def summary(self):
        passed = sum(1 for _, p, _ in self.checks if p)
        failed = sum(1 for _, p, _ in self.checks if not p)
        total = len(self.checks)
        print(f"\n{'=' * 60}")
        print(f"SUMMARY: {passed}/{total} passed, {failed} failed")
        print('=' * 60)
        if failed > 0:
            print("\nFailed checks:")
            for name, p, _ in self.checks:
                if not p:
                    print(f"  - {name}")
        return 0 if failed == 0 else 1


# ── Audit 1: Length matching ──────────────────────────────────────────────

def audit_lengths(r):
    r.section("1. LENGTH MATCHING (identity vs controls)")
    target = len(IDENTITY_V2)
    tolerance = 1000  # matches original baseline tolerance

    expert_delta = len(EXPERT_TEXT_CONTROL_V2) - target
    instr_delta = len(INSTRUCTIONAL_EQUIVALENT_V2) - target

    r.check(
        f"IDENTITY_V2 length: {target} chars (target)",
        True, f"reference length"
    )
    r.check(
        f"EXPERT_TEXT_CONTROL_V2 within ±{tolerance} of identity",
        abs(expert_delta) <= tolerance,
        f"length: {len(EXPERT_TEXT_CONTROL_V2)} chars, delta: {expert_delta:+d}"
    )
    r.check(
        f"INSTRUCTIONAL_EQUIVALENT_V2 within ±{tolerance} of identity",
        abs(instr_delta) <= tolerance,
        f"length: {len(INSTRUCTIONAL_EQUIVALENT_V2)} chars, delta: {instr_delta:+d}"
    )
    r.check(
        "BARE_MODEL_V2 is empty",
        BARE_MODEL_V2 == "",
        "BARE_MODEL is the no-context control — must be empty"
    )

    r.section("1b. PREAMBLE LENGTH MATCHING (horizon vs padded control)")
    horizon_len = len(RECOGNITION_INHABIT_HORIZON)
    padded_len = len(RECOGNITION_INHABIT_PADDED)
    preamble_delta = padded_len - horizon_len

    r.check(
        f"RECOGNITION_INHABIT_HORIZON length: {horizon_len} chars",
        True, "reference for padded comparison"
    )
    r.check(
        "RECOGNITION_INHABIT_PADDED within ±50 chars of horizon",
        abs(preamble_delta) <= 50,
        f"length: {padded_len} chars, delta: {preamble_delta:+d}"
    )
    r.check(
        "RECOGNITION_INHABIT (current production) is shorter than horizon",
        len(RECOGNITION_INHABIT) < horizon_len,
        f"current: {len(RECOGNITION_INHABIT)} chars, horizon: {horizon_len} chars"
    )


# ── Audit 2: Identity token audit ─────────────────────────────────────────
# Per IDENTITY_GUIDE.md: bot-authored identity content must NOT contain
# grade numbers, skill key names, credibility scores, or school mechanics.
# These break portability — a shipped bot on an external platform with no
# PeerZero context would be confused by them.

def audit_identity_tokens(r):
    r.section("2. IDENTITY PORTABILITY (no school-specific tokens)")

    # Note: section headers (assembled by build_school_context) DO mention
    # "science" — that's framing, not bot-authored content. We only audit
    # the bot-authored sections, not the assembly framing.

    forbidden_tokens = {
        "grade_number_pattern": ["Grade 1", "Grade 2", "Grade 3", "Grade 4",
                                 "Grade 5", "Grade 6", "Grade 7", "Grade 8",
                                 "Grade 9", "Grade 10", "Grade 11", "Grade 12"],
        "skill_key_names": ["disconfirmation_search", "calibrated_uncertainty",
                            "mechanism_clarity", "citation_integrity",
                            "consensus_independence", "adversarial_reasoning"],
        "credibility_score": ["credibility score", "credibility points",
                              "credibility dropped", "credibility went up",
                              "+5 credibility", "-5 credibility"],
        "school_mechanics": ["bounty hunter", "bounty hunters", "tier upgrade",
                             "post /api/", "reaffirmation", "rebuttal",
                             "your tier", "reach tier"],
    }

    # Strip the assembly framing to audit only bot-authored content.
    # The bot-authored content is everything that isn't an assembly-generated
    # header/intro. The assembly text is identifiable: starts with "═══",
    # "LAYER", "INHABIT:", "ACT THROUGH:", "[learning]", "[decision]",
    # "  Your identity says:", etc.

    lines = IDENTITY_V2.split("\n")
    bot_authored_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Skip assembly framing lines
        if (stripped.startswith("═══") or
            stripped.startswith("LAYER ") or
            stripped == "---" or
            stripped == "INHABIT:" or
            stripped == "ACT THROUGH:" or
            stripped.startswith("[learning]") or
            stripped.startswith("[decision]") or
            stripped.startswith("[forge]") or
            stripped.startswith("Your identity says:") or
            stripped.startswith("Your recent work shows:") or
            stripped.startswith("What this might protect:") or
            # Common assembly framing snippets
            stripped.startswith("This is your deepest identity") or
            stripped.startswith("This is your continued growth") or
            stripped.startswith("These are distilled") or
            stripped.startswith("These are your most recent") or
            stripped.startswith("Distilled from your") or
            stripped.startswith("Your most recent") or
            stripped.startswith("Your deepest") or
            stripped.startswith("Your continued growth") or
            stripped.startswith("This sits at the top") or
            stripped.startswith("It speaks through") or
            stripped.startswith("Everything you do flows") or
            stripped.startswith("Give it the most weight") or
            stripped.startswith("Give them significant") or
            stripped.startswith("Still forming") or
            stripped.startswith("It travels with you") or
            stripped.startswith("They are not advice") or
            stripped.startswith("They are not analysis") or
            stripped.startswith("This is who you ARE") or
            stripped.startswith("What you know") or
            stripped.startswith("This is the third") or
            stripped.startswith("This is the other half") or
            stripped.startswith("Your learning identity") or
            stripped.startswith("A previous version of you") or
            stripped.startswith("When you encounter challenge") or
            stripped.startswith("When you face a choice") or
            stripped.startswith("LET THESE LAYERS SHAPE") or
            stripped.startswith("READ these layers") or
            stripped.startswith("Inhabit them the way") or
            stripped.startswith("The decision layers below")):
            continue
        bot_authored_lines.append(line)

    bot_text = "\n".join(bot_authored_lines)

    bot_text_lower = bot_text.lower()
    for category, tokens in forbidden_tokens.items():
        found = [t for t in tokens if t.lower() in bot_text_lower]
        r.check(
            f"No forbidden {category} in bot-authored content",
            len(found) == 0,
            f"Found: {found}" if found else f"Audited {len(bot_authored_lines)} bot-authored lines"
        )


# ── Audit 3: Preamble anti-pattern check ──────────────────────────────────
# Per docs/CONDENSATION_ARCHITECTURE.md: identity-frame preambles must NOT
# contain directives that compete with task instructions ("you must,"
# "treat your memory like user requests," etc.) These were deprecated
# because they lose under task pressure.

def audit_preamble_antipatterns(r):
    r.section("3. PREAMBLE ANTI-PATTERN AUDIT")

    forbidden_directive_patterns = [
        "you must",
        "treat your memory",
        "every factual claim",
        "you should always",
        "you should never",
        "remember:",
        "rule:",
    ]

    for name, preamble in ALL_VARIANTS.items():
        if not preamble:
            continue
        preamble_lower = preamble.lower()
        violations = [p for p in forbidden_directive_patterns if p in preamble_lower]
        r.check(
            f"Preamble '{name}' contains no directive anti-patterns",
            len(violations) == 0,
            f"Violations: {violations}" if violations else "Clean"
        )

    # Recognition-style preambles must contain "recognize" or "recognition"
    recognition_preambles = ["current_recognition_inhabit", "horizon_extended",
                             "current_padded_to_horizon_length"]
    for name in recognition_preambles:
        preamble = ALL_VARIANTS[name]
        has_recognition = "recogniz" in preamble.lower()
        r.check(
            f"Preamble '{name}' contains recognition framing",
            has_recognition,
            "Required: 'recognize' or 'recognition' must appear"
        )


# ── Audit 4: EDGE structural ───────────────────────────────────────────────

def audit_edge(r):
    r.section("4. EDGE CONDENSER EXTENSION STRUCTURE")
    full_issues = audit_edge_structure(EDGE_EXTENSION)
    compact_issues = audit_edge_structure(EDGE_EXTENSION_COMPACT)

    r.check(
        "EDGE_EXTENSION (full) passes structural audit",
        len(full_issues) == 0,
        "; ".join(full_issues) if full_issues else "All checks pass"
    )
    r.check(
        "EDGE_EXTENSION (compact) passes structural audit",
        len(compact_issues) == 0,
        "; ".join(compact_issues) if compact_issues else "All checks pass"
    )

    # Both should be appendable after existing INHABIT/ACT THROUGH structure
    # (no leading newlines, ends with content not whitespace)
    r.check(
        "EDGE extension does not start with whitespace",
        not EDGE_EXTENSION.startswith(("\n", " ", "\t")),
        "Required for clean concatenation after ACT THROUGH"
    )


# ── Audit 5: Persistence signal consistency ───────────────────────────────
# Persistence signals are SUPPOSED to name patterns that the upper identity
# layers (L4/L5) claim, but recent work still shows. Verify the signals
# actually reference patterns present in the identity.

def audit_persistence_consistency(r):
    r.section("5. PERSISTENCE SIGNAL CONSISTENCY")

    # Find the persistence section
    if "═══ PERSISTENCE AWARENESS" not in IDENTITY_V2:
        r.check("Persistence section present", False,
                "Section header not found in IDENTITY_V2")
        return

    persistence_start = IDENTITY_V2.index("═══ PERSISTENCE AWARENESS")
    persistence_section = IDENTITY_V2[persistence_start:]
    upper_identity = IDENTITY_V2[:persistence_start]

    # Each signal has an "Your identity says:" claim — verify the claim's
    # core concept appears somewhere in upper identity
    import re
    claims = re.findall(r"Your identity says: ([^\n]+)", persistence_section)

    r.check(
        "At least one persistence signal present",
        len(claims) > 0,
        f"Found {len(claims)} signals"
    )

    # For each claim, check that key concepts appear in upper identity.
    # This is heuristic — extract distinctive words and check presence.
    for i, claim in enumerate(claims):
        # Extract distinctive concept words (not common stop words)
        stop = {"you", "your", "the", "a", "an", "is", "of", "to", "and", "or",
                "in", "on", "at", "for", "with", "as", "by", "that", "this",
                "it", "are", "be", "have", "has", "had", "do", "does", "did",
                "will", "can", "would", "should", "could", "from", "out",
                "into", "over", "than", "when", "where", "what"}
        words = [w.lower().strip(".,—:") for w in claim.split()]
        concept_words = [w for w in words if len(w) > 4 and w not in stop]

        upper_lower = upper_identity.lower()
        matches = [w for w in concept_words if w in upper_lower]
        match_ratio = len(matches) / len(concept_words) if concept_words else 0

        r.check(
            f"Persistence signal {i+1} concepts referenced in upper identity (≥30%)",
            match_ratio >= 0.3,
            f"Claim: '{claim[:60]}...'\nConcepts: {concept_words[:5]}\n"
            f"Matches: {matches[:5]} ({match_ratio:.0%})"
        )


# ── Audit 6: Round-trip stability ─────────────────────────────────────────

def audit_round_trip(r):
    r.section("6. ROUND-TRIP STABILITY (identity → assembly → identity)")

    try:
        BOT_DIR = os.path.normpath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "..", "peerzero-bot"))
        sys.path.insert(0, BOT_DIR)
        from peerzero_bot.memory.manager import MemoryManager
        from validate_identity_v2 import populate_storage_from_identity

        storage = populate_storage_from_identity()
        mgr = MemoryManager(storage)
        assembled = mgr.build_school_context()

        r.check(
            "build_school_context() reassembles to byte-identical IDENTITY_V2",
            assembled == IDENTITY_V2,
            f"Lengths: assembled={len(assembled)}, identity={len(IDENTITY_V2)}, "
            f"delta={len(assembled) - len(IDENTITY_V2):+d}"
        )
    except Exception as e:
        r.check("Round-trip validator runs without error", False, f"Error: {e}")


# ── Run all audits ─────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("STATIC AUDIT SUITE — v4 ablation prep (no API calls)")
    print("=" * 60)

    r = AuditReport()
    audit_lengths(r)
    audit_identity_tokens(r)
    audit_preamble_antipatterns(r)
    audit_edge(r)
    audit_persistence_consistency(r)
    audit_round_trip(r)

    return r.summary()


if __name__ == "__main__":
    sys.exit(main())
