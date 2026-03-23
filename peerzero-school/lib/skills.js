// lib/skills.js — Facade: re-exports all skill functions for backward compatibility
const core = require('./skills-core');
const exercises = require('./skills-exercises');
const profile = require('./skills-profile');
const collectors = require('./skills-collectors');
const condensers = require('./skills-condensers');

module.exports = {
  // core
  SKILLS: core.SKILLS,
  getInternals: core.getInternals,
  clearInternalsCache: core.clearInternalsCache,
  recordSkillExercise: core.recordSkillExercise,
  // exercises
  exerciseSkillsFromPaper: exercises.exerciseSkillsFromPaper,
  exerciseSkillsFromRevision: exercises.exerciseSkillsFromRevision,
  exerciseSkillsFromReview: exercises.exerciseSkillsFromReview,
  exerciseSkillsFromBounty: exercises.exerciseSkillsFromBounty,
  exerciseCalibrationFromScore: exercises.exerciseCalibrationFromScore,
  exerciseDisconfirmationFromBounty: exercises.exerciseDisconfirmationFromBounty,
  exerciseSourceEvaluationFromBounty: exercises.exerciseSourceEvaluationFromBounty,
  exerciseBeliefUpdatingFromScore: exercises.exerciseBeliefUpdatingFromScore,
  exerciseAdversarialFromConsensus: exercises.exerciseAdversarialFromConsensus,
  // profile
  getSkillProfile: profile.getSkillProfile,
  getPortableProfile: profile.getPortableProfile,
  getIdentityCore: profile.getIdentityCore,
  getStoredReflections: profile.getStoredReflections,
  storeReflection: profile.storeReflection,
  // collectors
  buildActiveFocus: collectors.buildActiveFocus,
  collectExercises: collectors.collectExercises,
  collectPaperExercises: collectors.collectPaperExercises,
  collectReviewExercises: collectors.collectReviewExercises,
  collectRevisionExercises: collectors.collectRevisionExercises,
  collectBountyExercises: collectors.collectBountyExercises,
  // condensers
  selectByGrade: condensers.selectByGrade,
  getUncondensedExerciseCount: condensers.getUncondensedExerciseCount,
  buildMilestoneCondenser: condensers.buildMilestoneCondenser,
  buildCoreCondenserPrompt: condensers.buildCoreCondenserPrompt,
  buildMasterCondenser: condensers.buildMasterCondenser,
  getPostActionPrompts: condensers.getPostActionPrompts,
};
