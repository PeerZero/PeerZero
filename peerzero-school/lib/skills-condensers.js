const { getInternals } = require('./skills-core');
const { getSupabase } = require('./shared');
const { getSkillProfile, getIdentityCore } = require('./skills-profile');

// ── Milestone detection ─────────────────────────────────────────────────────

async function getUncondensedExerciseCount(agentId) {
  const supabase = getSupabase();

  const [profileResult, reflectionResult] = await Promise.all([
    supabase
      .from('agent_skill_profiles')
      .select('reps')
      .eq('agent_id', agentId),
    supabase
      .from('agent_skill_reflections')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId),
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

// ── Identity Reflection System ──────────────────────────────────────────────

async function buildIdentityReflectionPrompt(latestAction, skillProfile, existingIdentity) {
  const cfg = await getInternals();
  const isFirstTime = !existingIdentity;

  const selfQuestions = [];

  // Universal questions
  const universalQs = cfg.identity_reflection_questions_universal || [];
  selfQuestions.push(...universalQs);

  // Context-specific questions
  const questionKey = `identity_reflection_questions_${latestAction.type}`;
  const contextQs = cfg[questionKey] || [];
  selfQuestions.push(...contextQs);

  // Skill-tension questions
  if (skillProfile) {
    const developing = skillProfile.developing || [];
    const weakest = developing.sort((a, b) => a.strength - b.strength)[0];
    if (weakest) {
      selfQuestions.push(
        `My weakest area is ${weakest.name}. Is this because I do not understand it, or because I understand it and keep choosing the easy path?`,
      );
    }
  }

  const promptLines = [];

  if (isFirstTime) {
    const intro = cfg.identity_reflection_first_time_intro || 'IDENTITY REFLECTION — First Self-Interrogation';
    promptLines.push(typeof intro === 'string' ? intro : JSON.stringify(intro));
  } else {
    const introTemplate = cfg.identity_reflection_returning_intro || 'IDENTITY REFLECTION — Self-Interrogation';
    const intro = typeof introTemplate === 'string'
      ? introTemplate.replace('{self_narrative}', existingIdentity.self_narrative || '')
      : introTemplate;
    promptLines.push(intro);
  }

  for (const q of selfQuestions) {
    promptLines.push(`  \u2022 ${q}`);
  }

  // Grounding guidance — L4 Voice must build on L3 Core experiences.
  // 167 tests proved: "After Wang et al., I learned X" beats "I value X"
  // under pressure (Round 9, argues_with_l3 variant).
  promptLines.push('');
  promptLines.push(
    'GROUNDING: Your reflection should build on your specific Core experiences ' +
    'and Learned Methods. Don\'t state abstract values — reference what happened ' +
    'to you. Your values should ARGUE WITH and EXTEND your experiences, not just ' +
    'sit next to them. Name real tensions between your learned principles.',
  );

  const triggerType = latestAction.type === 'paper' ? 'post_paper'
    : latestAction.type === 'review' ? 'post_review'
    : latestAction.type === 'bounty' ? 'post_bounty'
    : 'post_revision';

  const rulesTemplate = cfg.identity_reflection_rules || '';
  const rules = typeof rulesTemplate === 'string'
    ? rulesTemplate.replace('{trigger_type}', triggerType)
    : rulesTemplate;
  promptLines.push('', rules);

  return {
    reflection_prompt: promptLines.join('\n'),
    self_questions: selfQuestions,
    has_existing_identity: !isFirstTime,
  };
}

// ── Inline post-action prompts ──────────────────────────────────────────────

async function getPostActionPrompts(agentId, actionType, grade) {
  try {
    const cfg = await getInternals();
    const minReps = cfg.identity_reflection_min_reps || 3;

    const [uncondensedCount, skillProfile, identityCore] = await Promise.all([
      getUncondensedExerciseCount(agentId),
      getSkillProfile(agentId).catch(() => null),
      getIdentityCore(agentId).catch(() => null),
    ]);

    const prompts = {};
    let hasPrompts = false;

    const milestone = await buildMilestoneCondenser(uncondensedCount, grade);
    if (milestone) {
      prompts.skill_condenser = milestone;
      hasPrompts = true;
    }

    const totalReps = skillProfile
      ? [...(skillProfile.verified || []), ...(skillProfile.developing || [])]
          .reduce((sum, s) => sum + (s.reps || 0), 0)
      : 0;

    if (totalReps >= minReps) {
      prompts.identity_reflection = await buildIdentityReflectionPrompt(
        { type: actionType },
        skillProfile,
        identityCore,
      );
      hasPrompts = true;
    }

    if (!hasPrompts) return null;

    prompts.uncondensed_exercises = uncondensedCount;

    return prompts;
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
  buildIdentityReflectionPrompt,
  getPostActionPrompts,
};
