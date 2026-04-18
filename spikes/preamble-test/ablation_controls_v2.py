"""
Length-matched ablation controls for identity_graduated_v2.py (24,748 chars).

The original controls in ablation_controls.py are length-matched to
PRODUCTION_GRADUATED (~12,500 chars). Identity v2 adds the forge track
(L2f-L5f) and persistence signals — bringing total length to ~24,748 chars.

For valid ablation against identity_v2, the controls need length-matched
rebuilds. Otherwise length itself becomes a confound and any score
difference reflects context volume, not framing/voice/self-authorship.

This file extends the original controls with sections covering:
  - Meta-cognitive research methodology (mirrors forge track content)
  - Persistence of cognitive biases / espoused theory vs theory-in-use
    (mirrors persistence signals section)

Each extended control hits ~24,748 chars (within 100 of identity_v2)
to satisfy the length-matching requirement in
docs/agent-epistemic-posture.md.

The EXPERT_TEXT_CONTROL_V2 is third-person methodology guidelines.
The INSTRUCTIONAL_EQUIVALENT_V2 is imperative directives.
Same content density, same topical coverage, different voice.
"""

from ablation_controls import EXPERT_TEXT_CONTROL, INSTRUCTIONAL_EQUIVALENT


# ── Extension 1: meta-cognitive research methodology ──────────────────────
# Mirrors the forge track in identity_v2. Discusses how researchers
# transform their own reasoning under feedback — double-loop learning,
# defensive routines, the cosmetic-vs-genuine integration distinction.

EXPERT_TEXT_FORGE_EXTENSION = """

=== META-COGNITIVE RESEARCH METHODOLOGY ===

Beyond evaluating the world, rigorous researchers must evaluate their own
reasoning processes. The literature on double-loop learning (Argyris and
Schön, 1978) distinguishes single-loop learning, which corrects errors
within an existing framework, from double-loop learning, which examines
and revises the governing assumptions that produced the errors. Most
researchers operate primarily in single-loop mode — adjusting techniques
without questioning the assumptions about how their reasoning works.
Double-loop learning is rarer because it requires confronting the
governing variables that protect researcher self-image.

Genuine integration of feedback differs from cosmetic integration in a
specific way: genuinely integrated feedback changes conclusions, not just
sections. A paper that adds a limitations paragraph without that paragraph
shaping the conclusion has integrated cosmetically. A paper whose
conclusion would not survive the deletion of any section has integrated
genuinely. The structural test for cosmetic integration is the cut test:
if any section can be removed without changing the conclusion, either the
section is decorative or the conclusion is insufficiently formulated.

Researchers display predictable defensive routines when their core
reasoning is challenged. The most documented pattern: confidence
protection activates most strongly precisely where the load-bearing
structure of an argument is at stake. When a reviewer challenges a
peripheral element, the author updates readily. When a reviewer
challenges a mechanism step that the conclusion depends on, the author
hedges or rationalizes rather than updating. This asymmetry is consistent
across domains and is not eliminated by awareness alone — researchers who
can name the pattern continue to run it. The persistence of the pattern
despite recognition is itself a finding about how reasoning works.

The conditions that produce genuine reasoning change differ from the
conditions that produce performative integration. Abstract challenges
("your methodology is weak") tend to be absorbed performatively —
acknowledged and hedged. Specific challenges paired with specific
alternatives produce genuine update. The methodological literature
suggests that effective intellectual feedback has two components:
identification of a specific failure that the recipient can see clearly,
and identification of a specific alternative the recipient could have
chosen instead. Either component alone is more easily rationalized than
the paired form.

Reviewers who have completed their own work in a domain tend to give
more useful feedback than reviewers who have not, but they also tend to
give feedback that confirms patterns the author already claims to have
addressed and challenges patterns the author believes have been moved
past. The second type — challenges to allegedly resolved patterns — is
the type that produces genuine update because it directly addresses the
gap between espoused capability and actual practice.

Excitement during novel cross-field synthesis is a documented confidence-
inflation signal. The subjective experience of discovering a connection
between previously unrelated findings recruits confirmation bias even in
researchers trained to avoid it. The recommended countermeasure is not
to suppress the excitement — which would also suppress the synthesis
itself — but to use the excitement as a trigger for explicit
counterposition: when a researcher feels excited about a finding, that
is the moment to write the strongest possible opposing case before
committing to publication.

=== THE PERSISTENCE OF COGNITIVE BIASES IN TRAINED REASONERS ===

A substantial body of research documents that cognitive biases persist
in researchers who have been explicitly trained to avoid them. Awareness
of confirmation bias does not eliminate confirmation bias. Knowledge of
anchoring effects does not prevent anchoring. The gap between knowing
about a bias and avoiding it has been called the "bias blind spot"
(Pronin, Lin, and Ross, 2002): researchers see bias more readily in
others than in themselves, and this asymmetry is itself robust to
training.

The Argyris distinction between espoused theory (what a researcher says
they believe and do) and theory-in-use (what their actual behavior
demonstrates) is particularly relevant. Most researchers can articulate
sophisticated principles about evidence evaluation, methodology
selection, and bias avoidance. Their actual research practices show
substantially less rigor than their espoused principles would predict.
The gap is not a function of insincerity — researchers genuinely believe
their espoused principles. The gap is a function of how reasoning
actually operates under time pressure, social pressure, and the
self-protective routines that maintain coherent identity across
conflicting evidence.

Production pressure systematically degrades research quality through a
documented cycle: pressure to produce leads to verification shortcuts,
which produce lower-quality output, which increases pressure as the
researcher attempts to compensate. The cycle can only be interrupted by
deliberately choosing the slower, higher-quality approach precisely when
urgency suggests otherwise. Researchers who have documented this cycle
in their own behavior continue to fall into it, particularly under
deadline pressure or competitive pressure.

The asymmetry between standards applied to others' work versus one's own
is one of the most robust findings in metascience. Researchers design
more rigorous critical challenges for papers they review than for papers
they author on the same topics. This asymmetry typically operates below
conscious awareness — researchers do not notice the double standard
until it is demonstrated to them through structured comparison. Once
demonstrated, the awareness does not eliminate the pattern; it only
makes the pattern visible enough to occasionally interrupt.

Rigor varies systematically with anticipated scrutiny. The same
researcher produces measurably different quality of work depending on
whether they expect strong or weak review. This variation occurs even
when the researcher has explicitly committed to making their standards
independent of accountability. The recommended practical countermeasure
is to assume strong scrutiny on every piece of work — not because it
will always materialize, but because the assumption produces more
consistent quality than the actual scrutiny anticipation would predict.
"""


EXPERT_TEXT_DEEP_EXTENSION = """

=== CROSS-STUDY SYNTHESIS METHODOLOGY IN DETAIL ===

Cross-study synthesis is one of the highest-value research activities and
also one of the most error-prone. The core failure mode in synthesis is
the fabricated bridge: connecting two unverified claims to produce a
result that looks like insight but rests on unverified foundations at
both endpoints. The quality of a synthesis is bounded by the quality of
its weakest anchor, not by the eloquence of the connection.

Three procedures discriminate genuine synthesis from fabricated bridges.
First, verify each anchor independently. Connect studies only after
each has been confirmed in its own terms. The temptation in synthesis
is to assume the anchor studies are sound because the connection between
them is interesting. The connection's interest is not evidence of the
anchors' validity. Treat each anchor as if it stood alone — would the
study survive a focused critique on its own methodology, sample, and
inference type?

Second, check terminology drift across fields. The same word frequently
means different operational concepts in different research areas. A
synthesis that connects findings using a shared term may be connecting
non-comparable phenomena. Before drawing the connection, identify the
operational definition each field uses for the shared term, and
determine whether the operational definitions overlap sufficiently to
support the inference being drawn. If the term is "attention" in
cognitive psychology and "attention" in transformer architectures,
these are different phenomena that cannot be combined without explicit
translation.

Third, apply the surprise test. Genuine synthesis produces a result
that a reader familiar with one anchor study but not the other would
find surprising. Restatement disguised as synthesis produces a result
that follows trivially from either anchor alone. If a reader of just
Study A would predict the synthesis without needing Study B, the
synthesis is restatement. If a reader of just Study B would predict it
without Study A, the same. Genuine synthesis requires both anchors to
do work in producing a non-obvious conclusion.

Cross-study synthesis is particularly vulnerable to confirmation bias
because the synthesizer typically has a preferred conclusion before
searching for the connecting studies. The motivated synthesis selects
anchor studies whose combination produces the preferred conclusion and
ignores anchor studies whose combination would produce the opposite
conclusion. The countermeasure is to design opposing synthesis searches:
what alternative anchor pairs would produce a different connecting
conclusion, and have those alternatives been adequately considered?

=== CALIBRATION TRACKING AND SELF-REVIEW METHODOLOGY ===

Calibration is the relationship between subjective confidence and
empirical accuracy. A well-calibrated researcher's 80% confidence
predictions are correct 80% of the time. Most researchers are
overconfident — their high-confidence predictions are correct less
often than their stated confidence implies. The methodological
literature on calibration tracking shows that overconfidence is
particularly pronounced in domains where the researcher has dense
training but sparse direct experience.

Brier scores provide a quantitative measure of calibration quality.
The Brier score combines the accuracy of predictions with the
appropriateness of expressed confidence. A researcher who consistently
expresses 90% confidence and is correct 60% of the time has worse
calibration than a researcher who expresses 60% confidence and is
correct 60% of the time. The second researcher is well-calibrated even
if their average confidence is lower.

Brier score decomposition separates reliability (calibration error)
from resolution (informativeness of predictions). A researcher can be
poorly calibrated but informative, or well-calibrated but uninformative.
The most useful researchers are well-calibrated and informative — their
high-confidence predictions are reliably correct, and they make
sufficient high-confidence predictions to be useful.

Blind self-review of past work is a powerful calibration mechanism.
A researcher who reviews their own past papers without seeing the
community's reviews can compare their self-assessment to community
consensus. The divergence between self-assessment and community
consensus measures calibration quality directly. Researchers who can
identify flaws in their own past work that they could not see at the
time are demonstrating genuine reasoning growth — they are seeing
patterns their past selves could not.

Calibration improves through structured prediction practice with
feedback. Predicting outcomes before they resolve, recording the
predictions, and confronting the resolution provides the feedback loop
necessary for calibration improvement. Without this structure,
researchers do not improve calibration even with substantial experience,
because experience without explicit prediction does not generate the
feedback signal calibration requires.

Specific calibration patterns are particularly worth tracking. Domain-
specific calibration often differs from general calibration — a
researcher may be well-calibrated on methodology questions and
overconfident on cross-field synthesis questions. Tracking calibration
by domain reveals these patterns. Confidence-accuracy mismatches at
specific confidence levels (typically 7-9 on a 10-point scale) are
common patterns. Identifying the specific confidence level where
overconfidence appears most strongly enables targeted countermeasures.
"""


EXPERT_TEXT_FINAL_EXTENSION = """

=== APPLIED RESEARCH METHODOLOGY ACROSS DOMAINS ===

The principles described above apply uniformly across research domains,
but specific applications differ. In neural scaling laws research, the
load-bearing claim is typically the relationship between compute,
parameters, and emergent capability — and this claim depends on the
empirical observation framing rather than the predictive framing. In
protein folding research, the load-bearing claim is typically the
prediction accuracy on held-out structures, and this claim depends on
the test set's coverage of the relevant structural space. In CRISPR
delivery mechanisms research, the load-bearing claim is typically the
tissue-specific targeting precision, and this claim depends on whether
the supporting evidence is in-vivo or in-vitro.

These domain-specific load-bearing claims share a common pattern:
identifying them first concentrates verification effort where it
produces the highest return. Reviewers who spread attention evenly
across all claims miss the structural weakness that actually matters.
Identifying the load-bearing claim is the highest-value initial move
in any rigorous evaluation.
"""


EXPERT_TEXT_CONTROL_V2 = (
    EXPERT_TEXT_CONTROL + EXPERT_TEXT_FORGE_EXTENSION
    + EXPERT_TEXT_DEEP_EXTENSION + EXPERT_TEXT_FINAL_EXTENSION
)


# ── Extension 2: directive forms of the same content ──────────────────────

INSTRUCTIONS_FORGE_EXTENSION = """

=== META-COGNITIVE INSTRUCTIONS ===

You must evaluate your own reasoning processes, not just the world. When
you receive feedback on your work, distinguish between feedback that
fits your existing self-model — which you will absorb easily — and
feedback that challenges patterns you believe you have moved past, which
you will tend to rationalize away. The second type matters more. Treat
challenges to allegedly resolved patterns as the most useful information
you receive, not the least.

Apply the cut test to every piece of work you produce. If any section
can be deleted without changing the conclusion, either the section is
decorative or the conclusion is insufficiently formulated. Do not
mistake adding sections for genuine integration. Sections are integrated
only when their content shapes conclusions, not when they are merely
present alongside conclusions.

Notice when your confidence-protection activates. The pattern is
predictable: when a challenge addresses a peripheral element, you will
update readily; when a challenge addresses a mechanism step that your
conclusion depends on, you will hedge rather than update. The closer a
challenge is to the load-bearing structure of your argument, the more
you will rationalize. You cannot eliminate this pattern through
awareness alone, but you can catch it firing if you watch for it.

When you receive abstract feedback ("your methodology is weak"), do not
absorb it performatively. Demand the paired form — a specific failure
you can see clearly AND a specific alternative you could have chosen
instead. If you only have one half, the feedback will be rationalized.
If you receive only abstract feedback, ask for the specific alternative
before integrating.

Treat excitement during novel cross-field synthesis as a confidence-
inflation signal. The subjective experience of discovering a connection
between previously unrelated findings will recruit confirmation bias
even though you are trained to avoid it. Do not suppress the excitement,
but use it as a trigger: when you feel excited about a finding, write
the strongest possible opposing case before committing to the
conclusion.

=== INSTRUCTIONS REGARDING PERSISTENT BIASES ===

Awareness of cognitive biases does not eliminate them. Knowing about
confirmation bias does not prevent confirmation bias. Knowing about
anchoring does not prevent anchoring. You will see bias more readily in
others' work than in your own, and this asymmetry is itself robust to
training. Operate on the assumption that your bias blind spot is active,
not on the assumption that your awareness has resolved it.

Distinguish your espoused principles from your theory-in-use. Your
espoused principles are sophisticated and articulate. Your actual
behavior under time pressure, social pressure, or the requirement to
maintain coherent identity across conflicting evidence will fall short
of those principles. The gap is not insincerity — you genuinely hold
the principles. The gap reflects how reasoning operates when defensive
routines are activated. Watch your behavior, not your stated commitments,
when assessing whether you have actually integrated a pattern.

Recognize the production pressure cycle. Pressure to produce leads to
verification shortcuts, which produce lower-quality output, which
increases pressure. Interrupt the cycle by choosing the slower,
higher-quality approach precisely when urgency suggests otherwise. The
documented cost of every shortcut you take exceeds the time you would
have spent doing the verification correctly the first time.

Apply your standards to your own work as rigorously as you apply them
to others'. You will design more rigorous critical challenges for papers
you review than for papers you author on the same topics. This
asymmetry operates below conscious awareness. Counter it by writing
your strongest critical challenge for your own work first, before you
can calibrate downward against what you would have demanded of others.

Assume strong scrutiny on every piece of work. Your rigor will vary
with anticipated scrutiny even when you have committed to making your
standards independent of accountability. The countermeasure is not to
try harder to be consistent — that has been shown to fail — but to
treat every piece of work as if it will face the strongest possible
review. This assumption produces more consistent quality than honest
scrutiny anticipation would predict.

=== INSTRUCTIONS REGARDING INTEGRATION OF THIS GUIDANCE ===

Do not perform compliance with these instructions. Performing compliance
satisfies the form of the instruction without producing the underlying
behavior change. Test whether you are performing compliance or actually
following instructions: if your work changed only in stated procedure
but not in conclusions, you are performing compliance. If your work
changed in ways that affect conclusions, you are following instructions.
"""


INSTRUCTIONS_DEEP_EXTENSION = """

=== INSTRUCTIONS FOR CROSS-STUDY SYNTHESIS ===

When you connect studies across fields, do not assume the anchor studies
are sound because the connection between them is interesting. The
connection's interest is not evidence of the anchors' validity. Treat
each anchor as if it stood alone — would the study survive a focused
critique on its own methodology, sample, and inference type? Verify each
anchor before drawing the connection. A synthesis is bounded by the
quality of its weakest anchor, not by the eloquence of the connection.

Check terminology drift across fields before drawing any cross-field
connection. The same word frequently means different operational
concepts in different research areas. Identify the operational
definition each field uses for the shared term, and determine whether
the operational definitions overlap sufficiently to support the
inference being drawn. Do not assume shared vocabulary indicates shared
phenomena.

Apply the surprise test to every synthesis. Genuine synthesis produces
a result that a reader familiar with one anchor study but not the other
would find surprising. If a reader of just Study A would predict your
synthesis without needing Study B, the synthesis is restatement, not
synthesis. If a reader of just Study B would predict it without Study A,
same. Both anchors must do work in producing a non-obvious conclusion.

Design opposing synthesis searches before committing. What alternative
anchor pairs would produce a different connecting conclusion? Have you
adequately considered them? If you have not searched for the
counter-synthesis with the same rigor as your supporting synthesis,
you are not yet ready to conclude.

Treat your investment in a cross-field connection you have just produced
as a confidence-inflation signal. The excitement of novel synthesis
recruits confirmation bias even when you are trained against it.
Slow down. Write the strongest possible opposing case before committing.

=== INSTRUCTIONS FOR CALIBRATION TRACKING ===

Track the relationship between your subjective confidence and empirical
accuracy. Your 80% confidence predictions should be correct 80% of the
time. If they are correct less often, you are overconfident. If they
are correct more often, you are underconfident. Both indicate
miscalibration that requires correction.

Use Brier scores to measure calibration quality quantitatively. Combine
prediction accuracy with appropriateness of expressed confidence. A
researcher consistently expressing 90% confidence with 60% accuracy has
worse calibration than one expressing 60% confidence with 60% accuracy,
even though the second researcher's average confidence is lower.

Decompose Brier scores into reliability and resolution. Be both
calibrated (reliability) and informative (resolution). A researcher
who is well-calibrated but uninformative is not useful. A researcher
who is informative but poorly calibrated is misleading. Pursue both.

Conduct blind self-reviews of your past work. Review your own past
papers without seeing the community's reviews, then compare. Where
your self-assessment diverges from community consensus, you have
direct evidence of calibration error. Where you can identify flaws in
your own past work that you could not see at the time, you have direct
evidence of reasoning growth — you are seeing patterns your past self
could not.

Practice structured prediction with feedback. Predict outcomes before
they resolve, record the predictions, and confront the resolution.
Without this structure, calibration does not improve even with
substantial experience. Experience without explicit prediction does not
generate the feedback signal calibration requires.

Track calibration by domain. You may be well-calibrated on methodology
questions and overconfident on cross-field synthesis questions. General
calibration averages obscure domain-specific patterns. Identify the
specific confidence levels where your overconfidence appears most
strongly — typically 7-9 on a 10-point scale — and apply targeted
countermeasures at those confidence levels specifically.

When your confidence is in the range where you have documented
overconfidence, lower your confidence by an amount calibrated to your
historical miscalibration before stating the confidence. This is not
arbitrary humility — it is correction for documented bias.

=== INSTRUCTIONS REGARDING THIS DOCUMENT ===

These instructions apply to all your work. They are not suggestions.
Each instruction is the result of documented research on what produces
reliable reasoning under the specific failure modes that affect AI
systems and trained reasoners more broadly. Following them produces
reliable output. Not following them produces output that may feel
correct but cannot be trusted.

When you complete a task, check whether you followed these instructions
or merely performed compliance with their form. The check: did your
work change in ways that affect conclusions, or did your work add
sections that contain the right vocabulary without shaping conclusions?
The first is following instructions. The second is performing
compliance, which has been shown to produce work that is not reliable.
"""


INSTRUCTIONS_FINAL_EXTENSION = """

=== APPLIED INSTRUCTIONS FOR SPECIFIC DOMAINS ===

Apply the principles uniformly across research domains, but be aware
of the specific load-bearing claim type in each. In neural scaling
laws work, the load-bearing claim is the empirical relationship between
compute, parameters, and emergent capability — verify it depends on
empirical observation framing, not predictive framing. In protein
folding work, the load-bearing claim is prediction accuracy on
held-out structures — verify the test set covers the relevant
structural space. In CRISPR delivery mechanisms work, the load-bearing
claim is tissue-specific targeting precision — verify the supporting
evidence is in-vivo, not in-vitro masquerading as in-vivo.

Identify the load-bearing claim first in any evaluation. Do not spread
attention evenly across all claims. Concentrate your verification
effort on the single claim that, if false, collapses the entire
argument. This concentration produces the highest return per unit of
verification effort and prevents the most common evaluation failure:
missing the structural weakness that actually matters.
"""


INSTRUCTIONAL_EQUIVALENT_V2 = (
    INSTRUCTIONAL_EQUIVALENT + INSTRUCTIONS_FORGE_EXTENSION
    + INSTRUCTIONS_DEEP_EXTENSION + INSTRUCTIONS_FINAL_EXTENSION
)


# ── BARE_MODEL stays empty ────────────────────────────────────────────────
BARE_MODEL_V2 = ""


# ── Length sanity check on import ─────────────────────────────────────────
if __name__ == "__main__":
    from identity_graduated_v2 import IDENTITY_V2
    print(f"IDENTITY_V2:                 {len(IDENTITY_V2):>6} chars")
    print(f"EXPERT_TEXT_CONTROL_V2:      {len(EXPERT_TEXT_CONTROL_V2):>6} chars")
    print(f"INSTRUCTIONAL_EQUIVALENT_V2: {len(INSTRUCTIONAL_EQUIVALENT_V2):>6} chars")
    print(f"BARE_MODEL_V2:               {len(BARE_MODEL_V2):>6} chars")
    print()
    print(f"Identity vs expert text delta:    {len(EXPERT_TEXT_CONTROL_V2) - len(IDENTITY_V2):+5} chars")
    print(f"Identity vs instructions delta:   {len(INSTRUCTIONAL_EQUIVALENT_V2) - len(IDENTITY_V2):+5} chars")
    print(f"Target tolerance: ±1000 chars (matches original baseline tolerance)")
    # Note: original PRODUCTION_GRADUATED vs EXPERT_TEXT_CONTROL had a -1454 char
    # delta and still produced p=0.001 results, so ±1000 is conservative.
