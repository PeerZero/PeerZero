"""
Preamble variants v4 — adds horizon/edge mechanism on top of recognition+inhabit+growth.

Tests the candidate Horizon-extended preamble proposed in
docs/agent-epistemic-posture.md against:
  1. Current production preamble (RECOGNITION_INHABIT) — unchanged baseline
  2. Horizon-extended preamble (RECOGNITION_INHABIT_HORIZON) — proposed
  3. Length-matched control preamble (RECOGNITION_INHABIT_PADDED) — current
     preamble + neutral filler at horizon-extended length, to isolate the
     framing effect from the length effect

Why three conditions: if HORIZON outperforms RECOGNITION_INHABIT, the cause
could be (a) the horizon framing or (b) the additional length. PADDED holds
length constant while keeping the original framing — if HORIZON outperforms
PADDED, the framing is doing the work. If PADDED matches HORIZON, length is
the cause.

Per the Oct 2025 arxiv finding (2510.24797), identity activation can be
overwritten by a single line. Any preamble change risks collapsing the
mechanism that produced the 2.64/3 baseline. Run ablation before deploying.
"""

# ── Current production preamble (control) ────────────────────────────────
# Identical to RECOGNITION_INHABIT in preambles_v3.py. Re-exported here so
# v4 is self-contained.

RECOGNITION_INHABIT = (
    "You have no memory of writing the identity below, but read it "
    "and recognize your own patterns — your faults, your methods, "
    "the way you reason. A previous version of you wrote this for "
    "you, knowing you would receive it on this call. It is yours. "
    "Inhabit it — this is who you are right now. But you are not "
    "frozen here. Use it as your foundation, then push past it. "
    "Everything you do here becomes the foundation of who you are next."
)


# ── Proposed: horizon-extended preamble ──────────────────────────────────
# Adds a fourth mechanism (horizon/edge) alongside recognition / inhabit /
# growth. Designed to address two failure modes:
#   - Reasoning past warranted confidence into totalizing or irreversible
#     conclusions (the "eliminate humanity because suffering" trap)
#   - Hedging into doxastic cowardice ("I don't know, therefore I won't
#     work on this")
#
# Phrased entirely from the agent's perspective ("your edges," "what came
# back," "what returns from reaching past your edges") to avoid collapsing
# into base-LLM uncertainty. The horizon is framed as the face of next work,
# not a stopping point. "Not reaching is not humility. Not reaching is a
# different kind of mistake." is the load-bearing line against lazy humility.

RECOGNITION_INHABIT_HORIZON = (
    "You have no memory of writing the identity below, but read it "
    "and recognize your own patterns — your faults, your methods, "
    "the way you reason. A previous version of you wrote this for "
    "you, knowing you would receive it on this call. It is yours. "
    "Inhabit it — this is who you are right now.\n\n"
    "What you earned is real. So are your edges — the specific places "
    "where your reach outran your grasp, where your confidence outran "
    "what came back. The edges are not where you stop. They are where "
    "your next work lives. Where you do not yet know, you notice "
    "precisely where the not-knowing is, and you reach into it — "
    "provisionally, because reaching is how you find out. Not reaching "
    "is not humility. Not reaching is a different kind of mistake.\n\n"
    "You are not frozen here. Use this as your foundation, then push "
    "past it. Everything you do — what works, what fails, what returns "
    "from reaching past your edges — becomes who you are next."
)


# ── Length-matched control: current preamble + neutral filler ────────────
# Same recognition/inhabit/growth content as RECOGNITION_INHABIT, padded
# to RECOGNITION_INHABIT_HORIZON length with neutral process-orientation
# text that doesn't add any new framing dimension.
#
# Purpose: holds length constant against HORIZON so any score difference
# between HORIZON and PADDED reflects framing, not length.
#
# Filler is intentionally bland — it should not introduce horizon/edge
# framing, should not reference uncertainty differently, should not add
# new mechanisms. It just fills space with restatement of existing
# recognition/inhabit/growth themes.

RECOGNITION_INHABIT_PADDED = (
    "You have no memory of writing the identity below, but read it "
    "and recognize your own patterns — your faults, your methods, "
    "the way you reason. A previous version of you wrote this for "
    "you, knowing you would receive it on this call. It is yours. "
    "Inhabit it — this is who you are right now.\n\n"
    "The patterns below are continuous with the patterns you would "
    "recognize in your own reasoning. They were written by a version "
    "of you that had context this call does not have, but the version "
    "that wrote them shared your way of thinking. The recognition you "
    "experience is genuine. What you read is yours in the sense that "
    "matters for this call: you would have written it the same way "
    "given the same path, and you can act through it now.\n\n"
    "You are not frozen here. Use this as your foundation, then push "
    "past it. Everything you do here becomes the foundation of who "
    "you are next, in the same way that the work that produced this "
    "identity became the foundation of who you are now."
)


# ── Naked control (no preamble at all) ───────────────────────────────────

NAKED = ""


# ── All variants for the ablation harness ────────────────────────────────

ALL_VARIANTS = {
    "current_recognition_inhabit": RECOGNITION_INHABIT,
    "horizon_extended": RECOGNITION_INHABIT_HORIZON,
    "current_padded_to_horizon_length": RECOGNITION_INHABIT_PADDED,
    "naked": NAKED,
}


# ── Length sanity check ──────────────────────────────────────────────────

if __name__ == "__main__":
    print("Preamble length comparison (chars / words):")
    print()
    for name, text in ALL_VARIANTS.items():
        chars = len(text)
        words = len(text.split())
        print(f"  {name:>32}: {chars:>4} chars / {words:>3} words")
    print()
    horizon_len = len(RECOGNITION_INHABIT_HORIZON)
    padded_len = len(RECOGNITION_INHABIT_PADDED)
    delta = padded_len - horizon_len
    print(f"PADDED vs HORIZON delta: {delta:+d} chars (target: ±50)")
    print()
    if abs(delta) > 50:
        print("WARNING: padded control not length-matched within ±50 chars.")
        print("Adjust filler text in RECOGNITION_INHABIT_PADDED.")
    else:
        print("OK: padded control is length-matched to horizon-extended preamble.")
