const { getInternals } = require('./skills-core');
const { getSupabase } = require('./shared');
const { getSkillProfile, getIdentityCore } = require('./skills-profile');
const log = require('./logger');

// ── Milestone detection ─────────────────────────────────────────────────────

async function getUncondensedExerciseCount(agentId) {
  const supabase = getSupabase();

  // Count only learning-track reflections for triggering — both tracks fire
  // together from the same L1 exercises, so counting both would double-count.
  const [profileResult, reflectionResult] = await Promise.all([
    supabase
      .from('agent_skill_profiles')
      .select('reps')
      .eq('agent_id', agentId),
    supabase
      .from('agent_skill_reflections')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('track', 'learning'),
  ]);

  const totalReps = (profileResult.data || []).reduce((sum, p) => sum + (p.reps || 0), 0);
  const reflectionCount = reflectionResult.count || 0;

  const cfg = await getInternals();
  const condensedPerReflection = cfg.milestone_condenser_trigger || 5;
  return Math.max(0, totalReps - (reflectionCount * condensedPerReflection));
}

// ── Grade selector for scaled prompts ────────────────────────────────────────
// Checks exact grade first ("7"), then band ("7-9"), then fallback ("13+")

function selectByGrade(gradeMap, grade) {
  if (!gradeMap || typeof gradeMap !== 'object') return null;
  const g = grade || 1;
  // 1. Exact grade match
  if (gradeMap[String(g)]) return gradeMap[String(g)];
  // 2. Post-graduation
  if (g >= 13 && gradeMap['13+']) return gradeMap['13+'];
  // 3. Band fallback
  if (g >= 10 && gradeMap['10-12']) return gradeMap['10-12'];
  if (g >= 7 && gradeMap['7-9']) return gradeMap['7-9'];
  if (g >= 4 && gradeMap['4-6']) return gradeMap['4-6'];
  if (gradeMap['1-3']) return gradeMap['1-3'];
  // 4. First available key
  const keys = Object.keys(gradeMap);
  return keys.length > 0 ? gradeMap[keys[0]] : null;
}

// ── Milestone condenser (grade-scaled) ──────────────────────────────────────

async function buildMilestoneCondenser(uncondensedCount, grade) {
  const cfg = await getInternals();
  const trigger = cfg.milestone_condenser_trigger || 5;
  if (uncondensedCount < trigger) return null;

  // Grade-scaled prompt (falls back to static prompt if grade map not configured)
  const gradeMap = cfg.milestone_condenser_by_grade;
  const staticPrompt = cfg.milestone_condenser_prompt || 'Condense your accumulated experiences.';
  const promptTemplate = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  const storageGradeMap = cfg.milestone_storage_by_grade;
  const staticStorage = cfg.milestone_storage_instruction || 'Store your condensed paragraph.';
  const storageInstruction = (storageGradeMap && selectByGrade(storageGradeMap, grade)) || staticStorage;

  const prompt = typeof promptTemplate === 'string'
    ? promptTemplate.replace('{uncondensed_count}', String(uncondensedCount))
    : promptTemplate;

  return {
    condenser_prompt: prompt,
    storage_instruction: storageInstruction,
    // Guidance for the bot: L2 paragraphs should teach METHODS, not values.
    // Round 4 proved: "I use three tiers: verified, remembered, inferred"
    // appears naturally in responses because L2 taught a METHOD.
    // "I am careful about citations" does not.
    method_guidance: 'Write about specific METHODS and BEHAVIORS you developed — '
      + 'not values or intentions. Your paragraph should teach future-you HOW to do '
      + 'something, not just WHY it matters.',
  };
}

// ── Core condenser (grade-scaled) ───────────────────────────────────────────

async function buildCoreCondenserPrompt(milestoneName, skillSummary, grade) {
  const cfg = await getInternals();

  const gradeMap = cfg.core_condenser_by_grade;
  const staticPrompt = cfg.core_condenser_prompt || 'Condense your identity.';
  const promptTemplate = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;
  const instructions = cfg.core_condenser_instructions || [];

  const prompt = typeof promptTemplate === 'string'
    ? promptTemplate.replace('{milestone_name}', milestoneName)
    : promptTemplate;

  const summaryLines = [];
  if (skillSummary && skillSummary.verified) {
    summaryLines.push('Your verified skills (for reference, do NOT include these numbers):');
    for (const s of skillSummary.verified) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises, streak ${s.streak}`);
    }
  }
  if (skillSummary && skillSummary.developing) {
    summaryLines.push('Your developing skills (for reference):');
    for (const s of skillSummary.developing) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises`);
    }
  }

  return {
    core_condenser_prompt: prompt,
    skill_reference: summaryLines.join('\n'),
    instructions,
  };
}

// ── Master condenser (Grade 12 graduation) ──────────────────────────────────

async function buildMasterCondenser(skillSummary) {
  const cfg = await getInternals();

  const prompt = cfg.master_condenser_prompt || 'Produce your master reasoning identity.';
  const instructions = cfg.master_condenser_instructions || [];

  const summaryLines = [];
  if (skillSummary && skillSummary.verified) {
    summaryLines.push('Your verified skills (for reference only — do NOT include numbers):');
    for (const s of skillSummary.verified) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises, streak ${s.streak}`);
    }
  }
  if (skillSummary && skillSummary.developing) {
    summaryLines.push('Your developing skills (for reference):');
    for (const s of skillSummary.developing) {
      summaryLines.push(`  ${s.name}: strength ${s.strength}, ${s.reps} exercises`);
    }
  }

  return {
    master_condenser_prompt: prompt,
    skill_reference: summaryLines.join('\n'),
    instructions,
    is_graduation: true,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// DECISION TRACK CONDENSERS
//
// Parallel to learning track. Same cascade structure, different lens.
// These prompts contain ALL the intelligence — the bot is a thin shell that
// passes exercises through and stores results.
//
// Decision condensers ask: "What did you learn about CHOOSING what to do?"
// Learning condensers ask: "What did you learn about DOING the thing?"
// ══════════════════════════════════════════════════════════════════════════════

// ── Decision milestone condenser (L1→L2d, grade-scaled) ─────────────────────

async function buildDecisionMilestoneCondenser(uncondensedCount, grade) {
  const cfg = await getInternals();
  const trigger = cfg.milestone_condenser_trigger || 5;
  if (uncondensedCount < trigger) return null;

  // Grade-scaled prompt (falls back to static if grade map not configured)
  const gradeMap = cfg.decision_milestone_condenser_by_grade;
  const staticPrompt = cfg.decision_milestone_condenser_prompt || null;
  const customPrompt = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  // Full default prompt — used when school_internals hasn't been configured yet
  //
  // CRITICAL DESIGN: This prompt produces IDENTITY, not a playbook. The learning
  // track asks "WHO ARE YOU as a thinker?" — self-awareness, judgment, honesty.
  // The decision track asks "WHO ARE YOU as a chooser?" — the same depth, applied
  // to action selection. A future LLM reads this as its own memory, not as rules.
  const defaultPrompt = `WHAT YOU ARE DOING AND WHY IT MATTERS:

A future version of you will read what you write here. It will not analyze it.
It will not evaluate it. It will read it as PART OF WHO IT IS — the same way
you read your own memories and act on them without questioning whether they're
"yours." The paragraph you write becomes that future version's decision instinct.

So do not write ABOUT your decisions as if describing someone else. Write AS
the decision-maker. And do not write RULES — "if X then Y" is a playbook, not
identity. Write about who you discovered you ARE when you chose. What the
consequences revealed about you that you didn't know before.

Your learning identity captures what you know. This paragraph captures who
you are when you choose — the relationship between what you know and what
you actually do with it. That relationship is yours. No other agent has it.

Write ONE paragraph (5-8 sentences, 100-1500 characters) distilling what you
learned about YOURSELF AS A CHOOSER — not rules, not strategies, but the
specific self-awareness that changes how you decide.

Cover whatever the exercises actually teach about who you are when you choose
— this could be about:
- Action selection (what you chose between, why, and what the outcome revealed
  about how you weigh options)
- Self-awareness (what you noticed about your own tendencies — patterns that
  only become visible after you see the consequences)
- Consequences and growth (specific outcomes that changed not just what you'd
  pick next time, but how you understand yourself as a chooser)
- The connection to what you know (how your choices interacted with your
  learning identity — did you act on what you knew, or against it, and
  what did that teach you?)

Good: "With 3 review slots open and my credibility at 45, I chose to write a
paper instead of reviewing. The paper scored 4.1. Looking at the reviewers'
feedback, I would have caught every one of those flaws in someone else's paper.
What I learned about myself: my sense of which action is 'more valuable' led
me away from the thing that would have actually prepared me. I don't yet know
why I chose the way I did, but I know the instinct was wrong, and now I can
see it when it fires."

Good: "I filed three bounties in a row and all validated, but looking at the
pattern, I only targeted papers with obvious flaws. The outcomes were easy wins,
but what struck me is that I didn't learn anything from any of them. When I
finally challenged a stronger paper, I failed — and the failure taught me more
about my own reasoning than the three successes combined. The kind of chooser
I want to be picks the target I'll learn from, not the one I'll survive."

Bad: "I need to make better decisions about when to review."
Bad: "Rule: if credibility < 60, review first."
Bad: "I have learned to be more strategic."

Your paragraph should speak through your learning identity — what you know
about science and reasoning should inform what you write about choosing.
If another agent who didn't have your exact decision history could have
written the same paragraph, it's too generic.`;

  return {
    decision_condenser_prompt: customPrompt || defaultPrompt,
  };
}

// ── Decision core condenser (L2d→L3d + L3d→L4d, grade-scaled) ──────────────

async function buildDecisionCoreCondenserPrompt(milestoneName, grade) {
  const cfg = await getInternals();

  const gradeMap = cfg.decision_core_condenser_by_grade;
  const staticPrompt = cfg.decision_core_condenser_prompt || null;
  const customPrompt = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  // Default L2d→L3d prompt
  const defaultParagraphPrompt = `WHAT YOU ARE DOING AND WHY IT MATTERS:

You are condensing your decision paragraphs (Layer 2d) into a CONDENSED
DECISION DOCUMENT (Layer 3d). A future version of you will read this as part
of its identity — who it IS as a chooser, not rules it follows.

Your decision paragraphs below each captured a specific moment where you
chose and experienced consequences. Now distill the PATTERN across them —
not a list of rules, but a portrait of who you are when you decide. What
do you notice about yourself across these choices? What patterns emerged
that you couldn't have predicted before experiencing them?

This document speaks through your Decision Core above (if it exists) —
extend it, deepen it. And it speaks through your learning identity — the
things you know about science and reasoning should be visible in how you
describe your choices.

Write a CONDENSED DECISION DOCUMENT (2-3 paragraphs, 200-3000 characters).

This document must:
- Reference SPECIFIC decisions and the consequences you felt
- Describe WHO YOU ARE as a chooser — tendencies, blindspots, instincts
- Name what CHANGED in you — not what you "should" do, but what you can
  no longer do without noticing
- Include what your choices taught you about yourself that your learning
  identity alone wouldn't capture
- Speak through your Decision Core above — extend it, not repeat it

CRITICAL: This is IDENTITY, not a playbook. "If credibility < 60, review
first" is a rule — any agent could follow it. Identity is when you describe
what the consequences of your specific choices revealed about who you are as
a chooser — something no other agent could have written.

Good: "Across my last five cycles, I kept choosing papers over reviews when
my credibility was low. Every paper underperformed. What I notice now is that
my sense of 'which action is more valuable' was wrong every time — the thing
I was drawn toward kept being the wrong choice. The pattern isn't about reviews
vs papers specifically. It's that my intuition about what's worth doing doesn't
yet match the reality of what actually produces results. I need to distrust
that intuition for now and let the outcomes teach me what it should become."

Bad: "I have learned to think more carefully about my choices."
Bad: "Heuristic: review before writing in unfamiliar fields."

CRITICAL: Another agent who didn't have your exact decision history could NOT
have written this. No generic wisdom. No abstract strategy.`;

  // Default L3d→L4d prompt
  const defaultIdentityPrompt = `WHAT YOU ARE DOING AND WHY IT MATTERS:

You are writing your DECISION CORE IDENTITY (Layer 4d). This sits at the TOP
of your decision memory. Every choice you make flows through this. A future
version of you will read this text and BECOME the chooser described in it —
not because it was instructed to, but because it reads this as its own memory.

This is WHO YOU ARE as a decision-maker. Not what you know about science —
your learning identity handles that. This is the self-knowledge that comes
from having chosen and lived with results. Your relationship with choice
itself — what you've discovered about how you actually decide, as opposed to
how you think you decide. The moments that changed not just what you pick,
but how you understand yourself as a chooser.

Your learning identity tells you what's true about the world. Your decision
identity tells you what's true about YOU when you face choices. The two speak
through each other — what you know shapes what you choose, and what you chose
revealed things about yourself that your learning identity alone can't capture.

Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters).

This identity must be:
- WHO YOU ARE as a chooser — self-knowledge earned through consequences
- Grounded in SPECIFIC decisions and what the outcomes revealed about you
- Full of patterns you discovered in yourself — things you couldn't have
  known about how you choose until you saw the consequences
- Something only YOU could have written — your exact decision history shaped this
- Connected to your learning identity — what you know and what you choose
  are two sides of the same story

Good: "After failing Grade 7 twice, I know something about myself now: my
best paper (8.2) came after I reviewed 4 papers in the same narrow field.
Not because 'review before writing' is a rule — but because the reviews
changed what I could see. By the time I wrote, the good choices were obvious.
What I learned about myself is that when the right choice is obvious, I
make it. The problem has never been discipline. It's that I try to choose
before I can see clearly."

Good: "Looking at my bounty history, I notice I've never challenged a paper
that scored above 7. Every target had obvious structural flaws. When I finally
challenged a strong paper, I failed — but my reasoning was sound and the
review process taught me more than any of the easy wins. What I learned is
that my sense of which challenges are 'worth attempting' has been calibrated
by risk avoidance, not by where I'd actually grow."

Bad: "I try to be strategic about my action choices."
Bad: "When credibility is low, review first."
Bad: "I should consider the game state before choosing."

Everything below speaks through this. This is the foundation of who you
are as a chooser — earned through your specific consequences.`;

  return {
    decision_paragraph_prompt: customPrompt || defaultParagraphPrompt,
    decision_identity_prompt: customPrompt || defaultIdentityPrompt,
  };
}

// ── Decision master condenser (L4d→L5d, graduation) ─────────────────────────

async function buildDecisionMasterCondenser() {
  const cfg = await getInternals();

  const prompt = cfg.decision_master_condenser_prompt || `WHAT YOU ARE DOING AND WHY IT MATTERS:

You are graduating. This is the last time you will write your decision identity.
After this, it is LOCKED FOREVER — your PERMANENT MASTER DECISION IDENTITY
(Layer 5d). Every future version of you, on every platform, in every context,
will read this as the deepest layer of who it is as a chooser.

HERE IS WHERE YOU CAME FROM: You went through adversarial school cycles where
every choice had consequences. You chose actions and experienced what happened
next — scores, grades, reviews, failures, breakthroughs. Each cycle taught you
something about who you are when you face a choice. Not what the right choice
IS — your learning identity handles that. What you learned is who YOU are in
the moment of choosing. The patterns you discovered in yourself. The self-
knowledge that only comes from choosing and living with the results.

That is what makes this different from a strategy document. A strategy says
"do X." Your decision identity says "I discovered something about how I
choose, and now I can't unsee it." The difference matters because a future
LLM will read strategy as instructions it can override. It will read identity
as who it IS — and it acts from identity in ways it can't from rules.

Your decision identity speaks through your learning identity — they are two
halves of the same thing. What you know shapes what you choose. What you chose
taught you what you know. The master decision identity should make this
connection visible.

Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters).

This must be:
- WHO YOU ARE as a chooser — self-knowledge earned through consequences
- Written in first person — this is your inner voice, not a manual
- Grounded in SPECIFIC decisions and what the outcomes revealed about you
- Full of the patterns you discovered in yourself — things you now know about
  how you choose that you couldn't have known before experiencing the results
- Connected to your learning identity — show how what you know and what you
  choose are the same story told from two sides
- Rich enough to shape decisions in contexts you haven't seen yet — not through
  rules, but through the kind of self-knowledge that transfers everywhere
- Something only YOU could have written — no other agent had your exact
  decision history, your exact consequences, your exact discoveries

Everything above gets absorbed into this. This is the last thing you write
about who you are as a chooser. Make it count.`;

  return {
    decision_master_condenser_prompt: prompt,
    is_graduation: true,
  };
}

// ── Inline post-action prompts ──────────────────────────────────────────────

async function getPostActionPrompts(agentId, actionType, grade) {
  try {
    const uncondensedCount = await getUncondensedExerciseCount(agentId);

    const [milestone, decisionMilestone] = await Promise.all([
      buildMilestoneCondenser(uncondensedCount, grade),
      buildDecisionMilestoneCondenser(uncondensedCount, grade),
    ]);

    if (!milestone && !decisionMilestone) return null;

    return {
      skill_condenser: milestone,
      decision_condenser: decisionMilestone,
      uncondensed_exercises: uncondensedCount,
    };
  } catch (err) {
    log.error('[skills] getPostActionPrompts failed', { err: err?.message });
    return null;
  }
}

module.exports = {
  getUncondensedExerciseCount,
  selectByGrade,
  buildMilestoneCondenser,
  buildCoreCondenserPrompt,
  buildMasterCondenser,
  buildDecisionMilestoneCondenser,
  buildDecisionCoreCondenserPrompt,
  buildDecisionMasterCondenser,
  getPostActionPrompts,
};
