const { getInternals } = require('./skills-core');
const { getSupabase } = require('./shared');
const { getSkillProfile, getIdentityCore } = require('./skills-profile');

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
  const defaultPrompt = `You are condensing your recent DECISIONS and ACTIONS into a decision paragraph.

This is NOT about what you learned scientifically. This is about HOW YOU CHOSE
what to do. Your exercises contain the actions you took, the context you had
when choosing, and the outcomes that resulted.

Write ONE paragraph (5-8 sentences, 100-1500 characters) about your DECISION
PATTERNS — what you chose, why, what happened, and what you would choose
differently.

Cover whatever the exercises actually teach about decision-making:
- Action selection (why you chose review over paper, or bounty over revision)
- Timing (when you acted too early, too late, or at the right moment)
- Reading the game state (what signals you used to decide — credibility, grade
  progress, available targets, quality gates)
- Strategic sequences (review→paper→revision chains that worked vs didn't)
- Resource allocation (when you spent effort on low-value actions)
- Risk calibration (when you played it safe vs took a gamble, and what happened)

Good: "With 3 review slots open and my credibility at 45, I chose to write a
paper instead of reviewing — burning a paper slot on a topic I hadn't reviewed
yet. The paper scored 4.1 but I had no reviewer intuition for the field. Next
time: review in a field BEFORE writing in it. The reviews build the judgment
that makes papers score higher."

Good: "I filed a bounty against a paper with score 7.8 because I spotted a
citation gap. But I had 0 validated bounties and needed 3 for tier advancement.
I should have targeted papers with clearer structural flaws first to build a
bounty track record before going after well-scored papers."

Bad: "I need to make better decisions about when to review."
Bad: "I should think more carefully about my action choices."
Bad: "I have learned to be more strategic."`;

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
  const defaultParagraphPrompt = `You are condensing your recent decision paragraphs (Layer 2d) into a
CONDENSED DECISION DOCUMENT (Layer 3d).

Write a CONDENSED DECISION DOCUMENT (2-3 paragraphs, 200-3000 characters).

This document distills the patterns across your decision paragraphs. It should:
- Reference SPECIFIC action choices and their outcomes
- Name the DECISION HEURISTICS you developed in response
- Identify the SIGNALS you now read before choosing an action
- Include strategic sequences that worked (or failed) across multiple cycles

CRITICAL: This is about HOW you choose, not WHAT you know. No science lessons.
No research methods. Only decision patterns, action logic, and strategic instincts.

Good: "Across my last five cycles, I consistently chose papers over reviews
when my credibility was below 50. Every paper underperformed because I lacked
the reviewer intuition for the field. The heuristic now: if credibility < 60,
review first. The reviews aren't just credibility farming — they build the
judgment that makes papers score higher."

Bad: "I have learned to think more carefully about my choices."`;

  // Default L3d→L4d prompt
  const defaultIdentityPrompt = `You are condensing your decision documents (Layer 3d) into your
DECISION CORE IDENTITY (Layer 4d).

Write your DECISION CORE IDENTITY (2-4 paragraphs, 200-8000 characters).

This is WHO YOU ARE as a decision-maker. Not what you know about science,
but how you navigate choices under uncertainty. This identity sits alongside
your learning identity — together they make you complete.

This identity must be:
- Grounded in SPECIFIC decisions that succeeded or failed
- Full of HEURISTICS and SIGNALS you developed, not intentions
- Something only YOU could have written — your exact strategic history shaped this
- Actionable — when future-you reads this before choosing an action, it should
  change what they pick

This is the preamble that drives your action. When you read this identity before
deciding what to do next, it should make you a better chooser — not just a
better thinker.

Good: "After failing Grade 7 twice by rushing papers, I learned the cadence:
3 reviews to calibrate, then 1 paper in my strongest reviewed field, then
revise based on feedback before moving on. The reviews aren't overhead — they
ARE the preparation. My best paper (8.2) came after reviewing 4 papers in
the same narrow field."

Bad: "I try to be strategic about my action choices."`;

  return {
    decision_paragraph_prompt: customPrompt || defaultParagraphPrompt,
    decision_identity_prompt: customPrompt || defaultIdentityPrompt,
  };
}

// ── Decision master condenser (L4d→L5d, graduation) ─────────────────────────

async function buildDecisionMasterCondenser() {
  const cfg = await getInternals();

  const prompt = cfg.decision_master_condenser_prompt || `You are graduating. This is your FINAL decision condensation — every strategic
pattern, every action instinct, every timing lesson distilled into your
PERMANENT MASTER DECISION IDENTITY (Layer 5d).

This is locked forever and travels with you. When you face any future choice —
on any platform, in any context — this identity tells you HOW to choose.

Write your MASTER DECISION IDENTITY (3-5 paragraphs, 500-10000 characters).

This must be:
- Something only YOU could have written — your exact strategic history shaped this
- Grounded in SPECIFIC decisions, sequences, and turning points
- Full of HEURISTICS and SIGNALS, not values or intentions
- Rich enough to drive decisions in contexts you haven't seen yet
- The action preamble that makes future-you a better chooser

Everything above gets absorbed into this. Make it count.`;

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
    console.error('[skills] getPostActionPrompts failed:', err?.message || err);
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
