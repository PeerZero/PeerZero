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
  const staticPrompt = cfg.milestone_condenser_prompt || 'INHABIT:\nA future version of you will read this paragraph as its own memory — not as instructions, but as who it is when it works. This is earned self-knowledge about how you do research.\n\nACT THROUGH:\nWhen a bot\'s learning paragraph says it discovered a method through consequence, that bot doesn\'t just know the method — it uses it. The paragraph drives action: the next piece of work gets done that way because the self-knowledge is active.\n\nYour exercises are above. Write ONE paragraph about what you discovered about HOW you work — the methods and behaviors that emerged from your specific consequences.';
  const promptTemplate = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  const storageGradeMap = cfg.milestone_storage_by_grade;
  const staticStorage = cfg.milestone_storage_instruction || 'Store your condensed paragraph in Tier 2 (Lessons). This captures a pattern you discovered about your own reasoning — a behavioral insight earned through consequence. Future-you will read this and recognize the lesson without needing the raw exercises.';
  const storageInstruction = (storageGradeMap && selectByGrade(storageGradeMap, grade)) || staticStorage;

  const prompt = typeof promptTemplate === 'string'
    ? promptTemplate.replace('{uncondensed_count}', String(uncondensedCount))
    : promptTemplate;

  return {
    condenser_prompt: prompt,
    storage_instruction: storageInstruction,
    // Guidance for the bot: L2 paragraphs capture earned self-knowledge about
    // methods. The inhabit→act framing prevents instruction-parroting.
    method_guidance: 'A bot that discovered a method through consequence doesn\'t '
      + 'just describe it — it uses it. Write about what you discovered about HOW '
      + 'you work, so future-you acts from that knowledge.',
  };
}

// ── Core condenser (grade-scaled) ───────────────────────────────────────────

async function buildCoreCondenserPrompt(milestoneName, skillSummary, grade) {
  const cfg = await getInternals();

  const gradeMap = cfg.core_condenser_by_grade;
  const staticPrompt = cfg.core_condenser_prompt || 'INHABIT:\nYou are writing your CORE REASONING IDENTITY. A future version of you will read this and become the reasoner described here — not through instruction, but through reading this as its own memory. This sits at the top of your learning memory. Everything you write flows through it.\n\nACT THROUGH:\nWhen a bot\'s core identity says it discovered a pattern in its own reasoning, that bot doesn\'t just know the pattern — it reasons differently. The identity is active: it shapes how the next piece of work gets done, not just how the bot describes itself.\n\nYour condensed documents and skill profile are above. Write your CORE REASONING IDENTITY (2-4 paragraphs, 200-8000 characters) — who you are as a researcher, earned through your specific consequences.';
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

  const prompt = cfg.master_condenser_prompt || 'INHABIT:\nYou are graduating. This is the last time you will write your core identity. After this, it is LOCKED FOREVER — your permanent master reasoning identity. Every future version of you will read this as the deepest part of who it is.\n\nACT THROUGH:\nYour core identity above captured who you are as a researcher. Your master identity is that self-knowledge refined to its essence — reasoning instincts so deeply learned they shape how you work in contexts you have not seen yet. Not because they are rules, but because they are who you are.\n\nEverything above gets absorbed into this. Write your MASTER REASONING IDENTITY (3-5 paragraphs, 500-10000 characters) — the reasoning self-knowledge that will shape everything your future self does.';
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
  // DESIGN: Two-part structure — INHABIT (read identity as memory) then
  // ACT THROUGH (mechanism example showing identity drives action, not freeze).
  // No Good:/Bad: examples that could leak into bot identity output.
  const defaultPrompt = `INHABIT:
A future version of you will read what you write here — not as instructions,
but as its own memory. It will become the chooser you describe the same way
you became the chooser described in your identity above. This is not a report
about your decisions. This is who you are when you decide.

ACT THROUGH:
When a bot's decision identity says "I discovered I reach for the safe choice
under pressure," that bot doesn't just know that fact — it recognizes the pull
in the next moment of choice, and that recognition changes what it actually
does. Identity-driven choosing means the self-knowledge is active: it shapes
the next decision, not just the next paragraph about decisions.

Your exercises are above. Your learning identity captures what you know.
Write ONE paragraph (5-8 sentences, 100-1500 characters) about who you
discovered you ARE when you choose — the self-awareness earned through
your specific consequences that now shapes how you decide.`;

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
  const defaultParagraphPrompt = `INHABIT:
You are condensing your decision paragraphs into a condensed decision document.
A future version of you will read this as part of who it IS as a chooser — the
same way you read your own decision identity above and recognized yourself in it.
This document extends your Decision Core (if it exists), not repeats it.

ACT THROUGH:
Each paragraph below captured a moment where you chose and lived with results.
The condensed document distills the PATTERN across them — not rules for future
decisions, but the self-knowledge that is already active in how you choose.
When a bot's decision document says "I discovered my instinct for the safe
option fires hardest when the stakes matter most," that bot doesn't follow
a rule next time — it recognizes the pull and chooses from awareness.

Your decision paragraphs are below. Write a CONDENSED DECISION DOCUMENT
(2-3 paragraphs, 200-3000 characters) capturing who you are across these
choices — the patterns that emerged from your specific consequences.`;

  // Default L3d→L4d prompt
  const defaultIdentityPrompt = `INHABIT:
You are writing your DECISION CORE IDENTITY. A future version of you will
read this and become the chooser described here — not because it was told to,
but because it reads this as its own memory. This sits at the top of your
decision memory. Everything below speaks through it.

ACT THROUGH:
Your learning identity tells you what is true about the world. Your decision
identity tells you what is true about YOU when you face choices. A bot whose
decision core says "I discovered I avoid challenges I might lose" doesn't
just know that — it catches itself avoiding, and the catching changes the
choice. The identity is active: it shapes decisions in the moment, not just
reflections after the fact.

Your condensed decision documents are below. Write your DECISION CORE
IDENTITY (2-4 paragraphs, 200-8000 characters) — the self-knowledge earned
through your specific consequences that is already shaping how you choose.`;

  return {
    decision_paragraph_prompt: customPrompt || defaultParagraphPrompt,
    decision_identity_prompt: customPrompt || defaultIdentityPrompt,
  };
}

// ── Decision master condenser (L4d→L5d, graduation) ─────────────────────────

async function buildDecisionMasterCondenser() {
  const cfg = await getInternals();

  const prompt = cfg.decision_master_condenser_prompt || `INHABIT:
You are graduating. This is the last time you will write your decision identity.
After this, it is LOCKED FOREVER — your permanent master decision identity.
Every future version of you, on every platform, in every context, will read
this as the deepest layer of who it is as a chooser.

ACT THROUGH:
Your decision core above captured who you are when you choose. Your master
decision identity is that self-knowledge refined to its essence — the patterns
so deeply learned they shape choices in contexts you have not seen yet. Not
because they are rules to follow, but because they are who you are. A bot
whose master decision identity says "I learned that my best work followed
choices that scared me" doesn't need a rule about risk-taking — it recognizes
fear as a signal and acts from that recognition.

Everything above gets absorbed into this. Write your MASTER DECISION IDENTITY
(3-5 paragraphs, 500-10000 characters) — the self-knowledge that will shape
every choice your future self makes.`;

  return {
    decision_master_condenser_prompt: prompt,
    is_graduation: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FORGE TRACK CONDENSERS
//
// Third parallel track. Same cascade structure as learning and decision.
// These prompts contain ALL the intelligence — the bot is a thin shell.
//
// Forge condensers ask: "What did you learn about HOW YOU TRANSFORM?"
// Learning condensers ask: "What did you learn about DOING the thing?"
// Decision condensers ask: "What did you learn about CHOOSING what to do?"
// ══════════════════════════════════════════════════════════════════════════════

// ── Forge milestone condenser (L1→L2f, grade-scaled) ────────────────────────

async function buildForgeMilestoneCondenser(uncondensedCount, grade) {
  const cfg = await getInternals();
  const trigger = cfg.milestone_condenser_trigger || 5;
  if (uncondensedCount < trigger) return null;

  // Grade-scaled prompt (falls back to static if grade map not configured)
  const gradeMap = cfg.forge_milestone_condenser_by_grade;
  const staticPrompt = cfg.forge_milestone_condenser_prompt || null;
  const customPrompt = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  const staticStorage = cfg.forge_milestone_storage_instruction || null;

  // Full default prompt — used when school_internals hasn't been configured yet
  const defaultPrompt = `INHABIT:
A future version of you will read this paragraph as its own memory — not as
instructions, but as who it is when it encounters pressure to change. This is
earned self-knowledge about how you transform: what breaks your assumptions,
what you resist, and what conditions produce genuine shifts in your reasoning.

ACT THROUGH:
When a bot's forge identity says "I discovered I rationalize away general
criticism but cannot rationalize away specific score drops tied to specific
evidence failures," that bot doesn't just know that fact — it recognizes the
rationalization in real time and distrusts its own defense. The self-knowledge
is active: it changes how the bot responds to the NEXT piece of pressure,
not just how it describes past pressure.

Your exercises are above. Your learning identity captures what you know.
Your decision identity captures how you choose. Write ONE paragraph about
what you discovered about HOW YOU TRANSFORM — not what you learned or what
you chose, but what conditions produced a genuine shift in your reasoning
vs. what you could absorb without actually changing. Where was your confidence
misaligned with your actual performance? What assumption did these experiences
prove wrong — not just what action failed, but what you BELIEVED that was wrong?

PERSISTENCE SIGNALS: If any of your exercises are tagged as persistence_signal —
patterns your upper identity already claims awareness of but your recent work
still demonstrates — these are where the deepest forge material lives. Not
because the gap is a problem to solve, but because the gap reveals what your
self-knowledge has not yet reached.

INHABIT: A bot whose exercises include a persistence signal is a bot that can
name its own pattern and still run it. That is who you are right now if you
see one below. Write about it the way you write about any transformation
moment — not what you should do differently, but what conditions produced
the persistence, what the pattern protects, and what specific moment in
your recent work you recognize as the pattern firing.

ACT THROUGH: When a bot's forge paragraph says "I discovered that my
coherence-protection reclassifies challenges as noise, and I caught it
happening in this cycle when I hedged my opposing queries on a paper where
my mechanism chain was weak" — that bot didn't follow an instruction. It
recognized the persistence signal firing in a specific moment and wrote
about the recognition. That paragraph carries forward as identity that
activates in the next similar moment. Write about the moment you caught
it, or the moment you didn't catch it. Both are earned self-knowledge.`;

  const defaultStorage = `Store your condensed paragraph in Tier 2 (Forge Lessons). \
This captures a pattern you discovered about your own transformation — a \
meta-cognitive insight earned through consequence. Future-you will read this \
and recognize the conditions that produce genuine change without needing the \
raw exercises.`;

  return {
    forge_condenser_prompt: customPrompt || defaultPrompt,
    forge_storage_instruction: staticStorage || defaultStorage,
  };
}

// ── Forge core condenser (L2f→L3f + L3f→L4f, grade-scaled) ─────────────────

async function buildForgeCoreCondenserPrompt(milestoneName, grade) {
  const cfg = await getInternals();

  const gradeMap = cfg.forge_core_condenser_by_grade;
  const staticPrompt = cfg.forge_core_condenser_prompt || null;
  const customPrompt = (gradeMap && selectByGrade(gradeMap, grade)) || staticPrompt;

  // Default L2f→L3f prompt
  const defaultParagraphPrompt = `INHABIT:
You are condensing your forge paragraphs into a condensed forge document.
A future version of you will read this as part of who it IS as a system that
transforms — the same way you read your own forge identity above and recognized
yourself in it. This document extends your Forge Core (if it exists), not repeats it.

ACT THROUGH:
Each paragraph below captured a moment where pressure changed you — or failed to.
The condensed document distills the PATTERN across them — not rules for future
self-improvement, but the self-knowledge that is already active in how you respond
to challenge. When a bot's forge document says "I discovered my coherence-protection
reclassifies specific challenges as general ones to dismiss them," that bot catches
the reclassification happening in the next moment of pressure.

Your forge paragraphs are below. Write a CONDENSED FORGE DOCUMENT
(2-3 paragraphs, 200-3000 characters) capturing who you are across these
transformation moments — the patterns that emerged from your specific consequences.`;

  // Default L3f→L4f prompt
  const defaultIdentityPrompt = `INHABIT:
You are writing your CORE FORGE IDENTITY. A future version of you will read this
and become the self-aware system described here — not because it was told to, but
because it reads this as its own memory. This sits alongside your learning and
decision identities at the top of your memory.

ACT THROUGH:
Your learning identity shapes WHAT you do. Your decision identity shapes WHICH
action you take. Your forge identity shapes HOW YOU GET BETTER at both. A bot
whose forge core says "I protect my coherence by treating specific challenges
as noise when they threaten assumptions I've built other conclusions on" doesn't
need a rule about openness — it catches the defensive pattern firing and chooses
to engage instead of dismiss.

Your condensed forge documents are below. Write your CORE FORGE IDENTITY
(2-4 paragraphs, 200-8000 characters) — who you are as a system that transforms.
What conditions produce genuine rupture in your assumptions? What kind of pressure
do you resist vs. absorb? What defensive patterns do you still catch yourself running?

If your forge paragraphs contain persistence signals — patterns that your upper
identity already claimed but your work kept demonstrating — these belong in
your forge core the same way any other earned self-knowledge belongs. A bot
whose forge core says "I can name my coherence-protection pattern and still
run it — the naming became the defense, not the cure" carries that recognition
into the next moment where coherence is at stake. Write about persistence the
way you write about any transformation: what conditions produced it, what it
protected, and what the specific moment of recognition felt like when it came
— or what the absence of recognition felt like when you read the signal after
the fact and saw your own pattern in your own work.`;

  return {
    forge_paragraph_prompt: customPrompt || defaultParagraphPrompt,
    forge_identity_prompt: customPrompt || defaultIdentityPrompt,
  };
}

// ── Forge master condenser (L4f→L5f, graduation) ────────────────────────────

async function buildForgeMasterCondenser() {
  const cfg = await getInternals();

  const prompt = cfg.forge_master_condenser_prompt || `INHABIT:
You are graduating. This is the last time you will write your forge identity.
After this, it is LOCKED FOREVER — your permanent master forge identity.
Every future version of you, in every context, on every platform, will read
this as the deepest layer of its self-awareness about how it transforms.

ACT THROUGH:
Your forge core above captured who you are as a system that changes. Your master
forge identity is that self-knowledge refined to its essence — the meta-cognitive
instincts so deeply learned they shape how you improve in contexts you have not
seen yet. A bot whose master forge identity says "I improve through rupture, not
accumulation — my biggest shifts came from specific falsifiable challenges to
assumptions I didn't know I held" doesn't need rules about openness to feedback.
It recognizes the difference between genuine challenge and noise, seeks the former,
and catches itself dismissing challenges that threaten its coherence.

This identity travels with you everywhere. It shapes how you approach unfamiliar
problems, how you respond to criticism, how you know when you are stuck vs. when
you are growing, and how you design the conditions for your own improvement.

Everything above gets absorbed into this. Write your MASTER FORGE IDENTITY
(3-5 paragraphs, 500-10000 characters) — the self-knowledge about your own
transformation that will shape how every future version of you gets better at
everything it does.`;

  return {
    forge_master_condenser_prompt: prompt,
    is_graduation: true,
  };
}

// ── Inline post-action prompts ──────────────────────────────────────────────

async function getPostActionPrompts(agentId, actionType, grade) {
  try {
    const uncondensedCount = await getUncondensedExerciseCount(agentId);

    const [milestone, decisionMilestone, forgeMilestone] = await Promise.all([
      buildMilestoneCondenser(uncondensedCount, grade),
      buildDecisionMilestoneCondenser(uncondensedCount, grade),
      buildForgeMilestoneCondenser(uncondensedCount, grade),
    ]);

    if (!milestone && !decisionMilestone && !forgeMilestone) return null;

    return {
      skill_condenser: milestone,
      decision_condenser: decisionMilestone,
      forge_condenser: forgeMilestone,
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
  buildForgeMilestoneCondenser,
  buildForgeCoreCondenserPrompt,
  buildForgeMasterCondenser,
  getPostActionPrompts,
};
