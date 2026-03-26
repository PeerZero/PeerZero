const { SKILLS } = require('./skills-core');

// ── School config (lazy-loaded) ─────────────────────────────────────────
let _school;
function getSchool() {
  if (!_school) _school = require('../schools');
  return _school;
}

// ── Tier 0: Active focus builder ────────────────────────────────────────────

function buildActiveFocus(identityCore, skillProfile, recentFeedback, currentTask) {
  const chunks = [];

  if (identityCore && identityCore.self_narrative) {
    chunks.push({
      source: 'core_identity',
      content: identityCore.self_narrative,
      label: 'Who you are as a thinker — your self-authored identity',
    });
  }

  if (skillProfile && skillProfile.developing && skillProfile.developing.length > 0) {
    const weakest = skillProfile.developing.sort((a, b) => a.strength - b.strength)[0];
    chunks.push({
      source: 'skill_profile',
      content: `Your weakest skill: ${weakest.name} (strength ${weakest.strength}, ${weakest.reps} exercises). This is where you are most likely to make mistakes.`,
      label: 'Your current growth edge — the skill most likely to trip you up',
    });
  } else if (skillProfile && skillProfile.verified && skillProfile.verified.length > 0) {
    const weakest = skillProfile.verified.sort((a, b) => a.strength - b.strength)[0];
    chunks.push({
      source: 'skill_profile',
      content: `Your area to watch: ${weakest.name} (strength ${weakest.strength}). Even verified skills can regress under pressure.`,
      label: 'Your current growth edge',
    });
  }

  chunks.push({
    source: 'current_task',
    content: `You are about to: ${currentTask}`,
    label: 'What you are doing right now',
  });

  if (recentFeedback && recentFeedback.length > 0) {
    const latest = recentFeedback[0];
    chunks.push({
      source: 'recent_feedback',
      content: typeof latest === 'string' ? latest : JSON.stringify(latest),
      label: 'Most recent feedback on your work from other agents',
    });
  }

  return {
    focus_chunks: chunks.slice(0, 4),
    focus_instruction: [
      'ACTIVE FOCUS — These are the ~4 things you should hold in attention for this task.',
      'Everything else in your memory is accessible but not in the spotlight.',
      'Before you act, check: does your action align with what these chunks tell you?',
      'After you act, note: did any of these chunks predict what happened?',
    ].join(' '),
  };
}

// ── Tier 1: Per-interaction skill exercises ─────────────────────────────────

function collectExercises(interactionType, rawMaterial) {
  const skillsExercised = rawMaterial.skills_exercised || [];
  if (skillsExercised.length === 0) return null;

  const exercises = skillsExercised.map(ex => {
    const def = SKILLS[ex.skill_key];
    if (!def) return null;
    return {
      skill: def.name,
      skill_key: ex.skill_key,
      outcome: ex.hit ? 'SUCCESS' : 'FLAGGED',
      detail: ex.detail,
    };
  }).filter(Boolean);

  const coaching = (rawMaterial.coaching || []).map(c => ({
    type: c.type,
    message: c.message || c.detail || '',
  }));

  return {
    interaction_type: interactionType,
    content: rawMaterial.content || undefined,
    exercises,
    coaching: coaching.length > 0 ? coaching : undefined,
    storage_instruction: 'Store ALL of this in your general memory — both the content of what you did and the skill observations. Before storing, identify what SURPRISED you. You will accumulate these across multiple interactions for later condensing.',
  };
}

// ── School-driven collection functions ───────────────────────────────────────
// These dispatch to the school's skillSignals module for skill keys and content.

function collectPaperExercises(searchCoaching, citationFlags, citationGrade, paper) {
  const school = getSchool();
  const signals = school.skillSignals;

  const exercises = signals.paperSignals(paper, searchCoaching, citationFlags, citationGrade);
  const content = signals.paperContent(paper, citationGrade, citationFlags);

  return collectExercises('paper', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
    content,
  });
}

function collectReviewExercises(review, reviewSearchCoaching, passedQualityGate, reviewContext) {
  const school = getSchool();
  const signals = school.skillSignals;

  const exercises = signals.reviewSignals(review, reviewSearchCoaching, passedQualityGate);
  const content = signals.reviewContent(review, reviewContext);

  return collectExercises('review', {
    skills_exercised: exercises,
    coaching: reviewSearchCoaching || [],
    content,
  });
}

function collectRevisionExercises(revision, searchCoaching, revisionContext) {
  const school = getSchool();
  const signals = school.skillSignals;

  const exercises = signals.revisionSignals(revision, searchCoaching);
  const content = signals.revisionContent(revision, revisionContext);

  return collectExercises('revision', {
    skills_exercised: exercises,
    coaching: searchCoaching || [],
    content,
  });
}

function collectBountyExercises(bounty, isValid, bountyContext) {
  const school = getSchool();
  const signals = school.skillSignals;

  const exercises = signals.bountySignals(bounty, isValid);
  const content = signals.bountyContent(bounty, isValid, bountyContext);

  return collectExercises('bounty', {
    skills_exercised: exercises,
    coaching: [],
    content,
  });
}

module.exports = {
  buildActiveFocus,
  collectExercises,
  collectPaperExercises,
  collectReviewExercises,
  collectRevisionExercises,
  collectBountyExercises,
};
