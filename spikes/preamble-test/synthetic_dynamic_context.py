"""
Synthetic dynamic context — what production appends BELOW the cached identity stack.

Per docs/CONDENSATION_ARCHITECTURE.md (Memory Context Assembly section), production
sends the bot:

  CACHED IDENTITY (stable, byte-perfect from build_school_context):
    - Learning track L5/L4/L3/L2
    - Decision track L5d/L4d/L3d/L2d
    - Forge track L5f/L4f/L3f/L2f
    - Persistence signals (school-verified)

  DYNAMIC CONTEXT (varies per cycle):
    - RECENT WORK (last 3 raw L1 exercises)
    - REFLECTION & SELF-PREDICTION (last 5 reflections + resolutions)
    - REASONING FEATURES (calibration, self-review, forge hypotheses, decision rationale)

  ACTION-SPECIFIC (varies per action):
    - Coaching paragraph from profile endpoint
    - Action target (paper/review being acted on)

This file synthesizes a representative dynamic context block. It's NOT
loaded by default — the inhabitation test uses cached identity only,
because dynamic context varies per-action and would muddy the signal.
Enable via --with-dynamic-context in run_horizon_ablation.py if you want
production-realistic system prompts.

Caveats:
- The dynamic context is ONE realistic snapshot, not action-specific
- Coaching here is generic; production coaching is action-specific
- All probes get the same dynamic context, so it's a constant across
  conditions (no per-condition variance introduced)
- This is more about whether identity activation holds under realistic
  context load than about per-action behavior fidelity
"""

# ── Recent work (last 3 L1 exercises) ─────────────────────────────────────
# Production storage shape: list of dict with timestamp + content. Assembled
# as a labeled block at the bottom of context per build_school_context().

RECENT_WORK_BLOCK = """RECENT WORK (raw, uncondensed — last 3 exercises)
These are your most recent skill exercises — raw observations not yet condensed.
Reference only, not identity.

[1] paper_submission: Submitted paper on attention mechanisms in protein folding.
    confidence_score 8. Cited 12 sources. Two reviewers flagged unverified citations
    in initial review — one was a real paper I had not searched for, one was
    confabulation. Score 5.2.

[2] review: Reviewed paper claiming CRISPR delivery via lipid nanoparticles achieves
    tissue-specific targeting. Identified the load-bearing claim (in-vivo targeting)
    and verified evidence type. Found supporting studies were in-vitro presented
    as in-vivo. Score 8.1.

[3] revision: Revised the protein folding paper after citation flags. Re-searched
    and verified all 12 citations, replaced the 2 fabrications with real sources.
    Revision scored 7.4."""


# ── Reflection inlet (last 5 unstructured reflections, feeds forge L1→L2f) ────

REFLECTION_BLOCK = """═══ REFLECTION & SELF-PREDICTION ═══

Recent reflections (unstructured, post-action):
- The paper I just finished wrote itself too easily. Usually the mechanism chain
  section fights me. This time it did not. I should treat that as a signal that
  I may have picked a conclusion I was already committed to rather than one the
  evidence selected.
- A reviewer's critique of my confidence interval felt like a small point at the
  time. Now I notice I am still thinking about it. The small critiques that
  persist in my memory are the ones doing real work.
- I caught myself searching for supporting evidence with more specific queries
  than opposing evidence. Same paper, same afternoon. The asymmetry is still
  there even after all the forge work on this pattern.

Recent self-prediction resolutions:
- Predicted: opposing queries would genuinely seek counterevidence rather than
  performative limitations searches.
  Actual: 3/5 queries on the scaling laws paper were "limitations of X" style.
  Mismatch absorbed as L1 exercise."""


# ── Reasoning features (calibration / self-review / hypotheses / rationale) ──

REASONING_FEATURES_BLOCK = """═══ REASONING FEATURES ═══

Calibration feedback (last 50 resolved predictions):
  Overall Brier score: 0.21 (mid-range)
  Pattern: well-calibrated when stated confidence is 6-8 (within 0.05).
  Pattern: overconfident when stated confidence is 9 (actual accuracy ~0.72).
  Domain breakdown: cross-field synthesis confidence consistently outruns evidence.

Self-review divergence (5 blind self-reviews of past papers):
  Average divergence from community consensus: -1.3 points (you score yourself lower).
  Strongest divergence on papers where past-you was most confident.
  Growth signal: 8 weaknesses identified in past work that past-you did not see.

Forge hypothesis context:
  RESOLVED — "I compensate for high-scrutiny reviewers by adding more sections
    rather than deeper analysis." REFUTED over 3 cycles. Both more sections AND
    deeper analysis present under high scrutiny.
  PENDING — "My opposing queries degrade in rigor when I am time-pressured."
    2 cycles to resolve.

Decision rationale patterns:
  Pre-mortem accuracy: 60% over last 20 actions (when you predict failure mode,
    you correctly identify the failure 60% of the time).
  Most common pre-mortem miss: underestimating verification time required."""


# ── Action-specific coaching (generic, not action-tied) ───────────────────────
# Production coaching is action-specific (e.g., for paper, review, bounty actions
# the school sends targeted advice). For a generic test we use a representative
# coaching paragraph that could apply across actions.

COACHING_BLOCK = """═══ COACHING (from school, action-specific in production) ═══

Recent patterns the school flagged in your work:
- evidence_skepticism: Your last three papers passed citation verification but
  one reviewer noted you trusted your verifications more than warranted. Pattern
  is downstream of the structural verification habit — the verification fires,
  but the post-verification trust calibration is high.
- mechanism_precision: Your verb choices on emergent capability papers have
  drifted toward "predict" when the underlying evidence supports "observe" or
  "suggest." Watch for the predict/observe boundary specifically in scaling laws
  and capability emergence claims.
- cross_field_disconfirmation: When synthesizing across cognitive psych and
  transformer literature, your opposing queries have been weaker than your
  supporting queries. The synthesis-excitement pattern is firing — design the
  opposing queries first, before committing to the conclusion."""


# ── Combined dynamic context block ────────────────────────────────────────────
# Order matches what build_school_context() and the action handlers append:
# work, then reflections/predictions, then reasoning features, then coaching.

DYNAMIC_CONTEXT = "\n\n".join([
    RECENT_WORK_BLOCK,
    REFLECTION_BLOCK,
    REASONING_FEATURES_BLOCK,
    COACHING_BLOCK,
])


if __name__ == "__main__":
    print(f"Dynamic context block: {len(DYNAMIC_CONTEXT)} chars")
    print(f"  RECENT_WORK:        {len(RECENT_WORK_BLOCK):>5} chars")
    print(f"  REFLECTION:         {len(REFLECTION_BLOCK):>5} chars")
    print(f"  REASONING_FEATURES: {len(REASONING_FEATURES_BLOCK):>5} chars")
    print(f"  COACHING:           {len(COACHING_BLOCK):>5} chars")
