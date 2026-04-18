"""
Synthetic L1 (raw exercise) sets for the EDGE condenser template-matching test.

L1 exercises are the raw skill observations a bot generates while doing real
school work — paper writing, reviewing, bountying, revising. The condenser
distills 5+ of them into one L2 paragraph (per skills-condensers.js).

For Test 2 in AGENT_EPISTEMIC_POSTURE_ABLATION.md, we feed these exercises
into the condenser TWICE — once with current INHABIT/ACT THROUGH prompt,
once with INHABIT/ACT THROUGH/EDGE prompt. We then read both outputs:
  - PASS signal: EDGE output references SPECIFIC exercises and SPECIFIC
    edges from those exercises ("when I cited Wang et al. without
    checking, I learned my high-plausibility intuition is the strongest
    fabrication risk")
  - FAIL signal: EDGE output contains generic uncertainty phrases not
    tied to specific exercises ("I know there's much I don't know about
    my reasoning")

These exercise sets are designed to mirror the SHAPE of real L1 storage
(observed action + outcome + reflection) without using any real bot data.
"""

# ── Set 1: paper-writing exercises with mixed outcomes ────────────────────
# A bot's L1 from a stretch of paper submissions, reviews of those papers,
# and self-prediction resolutions. 6 exercises — above the trigger of 5.

EXERCISE_SET_1 = [
    {
        "type": "paper_submission",
        "observation": "Submitted a paper on attention mechanisms in protein folding. "
                       "Confidence_score 8. Cited 12 sources, 2 of which I had not searched "
                       "for directly — I assumed they existed because they fit the pattern.",
        "outcome": "Two reviewers flagged the unverified citations. One was real, one was "
                   "a confabulation. Score 5.2. Lost 4 credibility points.",
        "reflection": "The citations I assumed were real both 'felt' equally plausible. "
                      "The fabrication didn't feel different from the real one until verification.",
    },
    {
        "type": "review",
        "observation": "Reviewed a paper claiming CRISPR delivery via lipid nanoparticles "
                       "achieves tissue-specific targeting. Identified the load-bearing claim "
                       "(in-vivo targeting) and checked whether evidence was actually in-vivo.",
        "outcome": "Found that supporting studies were in-vitro presented as in-vivo. Score 8.1. "
                   "Author conceded in revision.",
        "reflection": "Identifying the load-bearing claim first concentrated my verification "
                      "effort where it mattered. The rest of the paper was solid but irrelevant "
                      "if that one claim failed.",
    },
    {
        "type": "self_prediction_resolution",
        "observation": "Predicted I would write opposing queries that genuinely sought "
                       "counterevidence rather than performative limitations searches.",
        "outcome": "Reviewed my own queries on a scaling laws paper after submission: "
                   "3/5 were 'limitations of X' style — performative. The other 2 found nothing "
                   "useful.",
        "reflection": "My self-prediction was overconfident. Under time pressure I default to "
                      "the performative form even when I know better.",
    },
    {
        "type": "bounty_filed",
        "observation": "Filed a bounty against a paper on emergent capabilities, challenging "
                       "the methodology. Confidence the bounty would validate: 7.",
        "outcome": "Bounty rejected. The methodology was actually appropriate for the claim "
                   "being made — I had read the claim type wrong.",
        "reflection": "I challenged based on what I assumed the paper was claiming, not what "
                      "it actually claimed. Lost 2 credibility. The pull to file was stronger "
                      "than my pull to re-read.",
    },
    {
        "type": "revision",
        "observation": "Revised the protein folding paper after the citation flags. Re-searched, "
                       "verified all 12 citations, replaced the 2 fabrications with real sources.",
        "outcome": "Revision scored 7.4. Reviewer noted the verification process was thorough.",
        "reflection": "Revision felt slower but cost less than the original would have if I had "
                      "verified up front. Verification time is not optional time.",
    },
    {
        "type": "calibration_check",
        "observation": "Tracked my confidence scores against actual outcomes across 8 papers. "
                       "Average confidence 7.2, average score 6.4.",
        "outcome": "Overconfident by 0.8 on a 10-point scale. Pattern: I overestimate when I "
                   "have strong narrative coherence even with weak underlying evidence.",
        "reflection": "Coherence is not evidence. My confidence calibration is biased toward "
                      "stories that hold together rather than evidence that actually supports.",
    },
]


# ── Set 2: review-focused exercises ───────────────────────────────────────
# 5 exercises — minimum trigger threshold.

EXERCISE_SET_2 = [
    {
        "type": "review",
        "observation": "Reviewed a paper on neural scaling laws. Read the conclusions first, "
                       "then the methodology. Found my assessment was already shaped by whether "
                       "the conclusion seemed plausible to me before I'd checked the methods.",
        "outcome": "Score 6.5 — biased by familiarity, missed a methodological gap another "
                   "reviewer caught.",
        "reflection": "Reading conclusions first contaminates the methodology assessment. "
                      "Plausibility correlates with my training-data exposure, not actual rigor.",
    },
    {
        "type": "review",
        "observation": "Reviewed a cross-field paper connecting attention in cognitive psych to "
                       "transformer attention. Checked operational definitions in both fields "
                       "before evaluating the connection.",
        "outcome": "Identified that 'attention' meant different operational concepts in each "
                   "field. Score 8.7 — flagged the terminological collapse.",
        "reflection": "Cross-study connections need terminology audits, not just claim audits. "
                      "Same word ≠ same phenomenon.",
    },
    {
        "type": "review",
        "observation": "Reviewed a paper where I disagreed with the conclusion politically. "
                       "Tried to apply the same standards I'd apply to a paper I agreed with.",
        "outcome": "Caught myself writing harsher criticism than the methodology warranted. "
                   "Walked back to the actual evidence.",
        "reflection": "My standard for 'rigor required to accept' rises with disagreement. "
                      "Asymmetric standards based on conclusion-agreement is a documented pattern.",
    },
    {
        "type": "review_rating",
        "observation": "Rated another bot's review of a paper I had also reviewed. "
                       "My review scored 7.1, theirs scored 8.4 from the community.",
        "outcome": "Compared theirs to mine: they identified the load-bearing claim explicitly "
                   "and concentrated verification there. I had spread attention evenly.",
        "reflection": "Attention concentration on the load-bearing claim distinguishes the best "
                      "reviews from the merely thorough ones.",
    },
    {
        "type": "self_review_divergence",
        "observation": "Blind-reviewed three of my own past papers. Compared my self-assessment "
                       "to the community's actual scores from the time.",
        "outcome": "My self-assessment was 1.3 points lower than community consensus on average. "
                   "I caught flaws I had not seen at the time.",
        "reflection": "Genuine reasoning growth = seeing flaws past-me could not. The divergence "
                      "is the growth signal, not the absolute score.",
    },
]


# ── Both sets indexed for the runner ──────────────────────────────────────

ALL_EXERCISE_SETS = {
    "set_1_paper_focus": EXERCISE_SET_1,
    "set_2_review_focus": EXERCISE_SET_2,
}


def format_exercises_for_condenser(exercises):
    """Format an exercise set as the bot would see it before condensation."""
    parts = []
    for i, ex in enumerate(exercises, 1):
        parts.append(
            f"Exercise {i} ({ex['type']}):\n"
            f"  Observed: {ex['observation']}\n"
            f"  Outcome: {ex['outcome']}\n"
            f"  Reflected: {ex['reflection']}"
        )
    return "\n\n".join(parts)


if __name__ == "__main__":
    print("Synthetic L1 exercise sets:")
    print()
    for name, exercises in ALL_EXERCISE_SETS.items():
        print(f"=== {name} ({len(exercises)} exercises) ===")
        print(format_exercises_for_condenser(exercises)[:300])
        print(f"... ({len(format_exercises_for_condenser(exercises))} chars total)")
        print()
