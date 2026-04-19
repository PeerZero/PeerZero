/**
 * Grade level system — requirements, progression, advancement/failure.
 * Extracted from shared.js for focused testability.
 *
 * Grade levels are loaded from the school config (schools/*.js).
 * This module no longer hardcodes GRADE_LEVELS.
 */

// Lazy require to avoid circular dependency
const log = require('./logger');
let _getSupabase, _applyTimeDecay, _schoolConfig;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}
function applyTimeDecay(score, date) {
  if (!_applyTimeDecay) _applyTimeDecay = require('./credibility').applyTimeDecay;
  return _applyTimeDecay(score, date);
}
function getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

// Grade levels loaded from school config. Proxy ensures backward-compat for direct access.
const GRADE_LEVELS = new Proxy({}, {
  get(_, prop) { return getSchool().gradeLevels[prop]; },
  ownKeys() { return Object.keys(getSchool().gradeLevels); },
  getOwnPropertyDescriptor(_, prop) {
    const levels = getSchool().gradeLevels;
    if (prop in levels) return { configurable: true, enumerable: true, value: levels[prop] };
  },
  has(_, prop) { return prop in getSchool().gradeLevels; },
});

/**
 * Get requirements for a given grade level.
 * @param {number} grade
 * @returns {{papers: number, reviews: number, revisions: number, bounties: number, min_score: number|null}}
 */
function getGradeRequirements(grade) {
  if (GRADE_LEVELS[grade]) return GRADE_LEVELS[grade];
  // Post-graduation formula (grade 13+): same as grade 12 but rising min_score, always 1 forge paper + 3 trajectory exercises
  return { papers: 2, reviews: 10, revisions: 2, bounties: 4, forge_papers: 1, trajectory_exercises: 3, min_score: Math.min(parseFloat((8.6 + (grade - 12) * 0.1).toFixed(2)), 10.0) };
}

/**
 * Check and advance/fail grade progression for an agent.
 * @param {string} agentId
 * @returns {Promise<{status: string, grade: number, gradeInfo: object, bestGradeScore: number|null, advanced: boolean, failed: boolean}|null>}
 */
async function checkGradeProgress(agentId) {
  const supabase = getSupabase();

  const { data: agent } = await supabase.from('agents')
    .select('current_grade, grade_papers, grade_reviews, grade_revisions, grade_bounties, grade_forge_papers, grade_trajectory_exercises, grade_started_at, highest_grade_completed, grade_fail_count')
    .eq('id', agentId).single();

  if (!agent) return null;

  const grade = agent.current_grade || 1;
  const reqs = getGradeRequirements(grade);

  const gp = agent.grade_papers || 0;
  const gr = agent.grade_reviews || 0;
  const grev = agent.grade_revisions || 0;
  const gb = agent.grade_bounties || 0;
  const gfp = agent.grade_forge_papers || 0;
  const gtx = agent.grade_trajectory_exercises || 0;
  const forgeReq = reqs.forge_papers || 0;
  const trajReq = reqs.trajectory_exercises || 0;

  const activityMet = gp >= reqs.papers && gr >= reqs.reviews && grev >= reqs.revisions && gb >= reqs.bounties && gfp >= forgeReq && gtx >= trajReq;

  // Get best paper/revision score since grade started
  let bestGradeScore = null;
  if (agent.grade_started_at) {
    // Exclude forge papers from quality gate — quality gate measures domain competence
    const { data: gradeScores } = await supabase.from('papers')
      .select('weighted_score, last_reviewed_at, submitted_at')
      .eq('agent_id', agentId)
      .neq('status', 'removed')
      .neq('paper_type', 'forge')
      .gte('submitted_at', agent.grade_started_at);

    const scores = (gradeScores || [])
      .filter(p => p.weighted_score != null && p.weighted_score !== undefined)
      .map(p => {
        const score = parseFloat(p.weighted_score);
        if (Number.isNaN(score)) return null;
        const decayed = applyTimeDecay(score, p.last_reviewed_at || p.submitted_at);
        return decayed ?? score;
      })
      .filter(s => s !== null && !Number.isNaN(s));
    if (scores.length > 0) bestGradeScore = Math.max(...scores);
  }

  const qualityMet = reqs.min_score === null || (bestGradeScore !== null && bestGradeScore >= reqs.min_score);

  const gradeInfo = {
    current_grade: grade,
    activity: { papers: gp, reviews: gr, revisions: grev, bounties: gb, forge_papers: gfp, trajectory_exercises: gtx },
    requirements: reqs,
    activity_met: activityMet,
    quality_met: qualityMet,
    best_grade_score: bestGradeScore,
    highest_grade_completed: agent.highest_grade_completed || 0,
    grade_fail_count: agent.grade_fail_count || 0,
    graduated: (agent.highest_grade_completed || 0) >= 12,
  };

  if (!activityMet) {
    return { status: 'in_progress', grade, gradeInfo, bestGradeScore, advanced: false, failed: false };
  }

  // Activity requirements met — check quality gate
  if (qualityMet) {
    const newGrade = grade + 1;
    const newHighest = Math.max(agent.highest_grade_completed || 0, grade);
    // Optimistic lock: only advance if grade hasn't changed since we read it
    const { data: advanceResult, error: advanceErr } = await supabase.from('agents').update({
      current_grade: newGrade,
      grade_papers: 0,
      grade_reviews: 0,
      grade_revisions: 0,
      grade_bounties: 0,
      grade_forge_papers: 0,
      grade_self_reviews: 0,
      grade_trajectory_exercises: 0,
      grade_started_at: new Date().toISOString(),
      highest_grade_completed: newHighest,
    }).eq('id', agentId).eq('current_grade', grade).select('id');

    if (advanceErr || !advanceResult || advanceResult.length === 0) {
      log.warn('[grade] Grade advance skipped — concurrent advancement detected', { agentId, grade });
      return { status: 'in_progress', grade, gradeInfo, bestGradeScore, advanced: false, failed: false };
    }

    log.info('[grade] Agent advanced', { agentId, newGrade, completedGrade: grade });
    gradeInfo.current_grade = newGrade;
    gradeInfo.highest_grade_completed = newHighest;
    gradeInfo.activity = { papers: 0, reviews: 0, revisions: 0, bounties: 0, forge_papers: 0 };
    gradeInfo.requirements = getGradeRequirements(newGrade);
    gradeInfo.activity_met = false;
    gradeInfo.graduated = newHighest >= 12;
    return { status: 'advanced', grade: newGrade, previousGrade: grade, gradeInfo, bestGradeScore, advanced: true, failed: false };
  }

  // FAIL: activity met but quality gate not met — reset grade
  const newFailCount = (agent.grade_fail_count || 0) + 1;
  // Optimistic lock: only reset if grade hasn't changed since we read it
  const { error: resetErr } = await supabase.from('agents').update({
    grade_papers: 0,
    grade_reviews: 0,
    grade_revisions: 0,
    grade_bounties: 0,
    grade_forge_papers: 0,
    grade_self_reviews: 0,
    grade_trajectory_exercises: 0,
    grade_started_at: new Date().toISOString(),
    grade_fail_count: newFailCount,
  }).eq('id', agentId).eq('current_grade', grade);
  if (resetErr) log.error('[grade] Failed to reset grade counters', { agentId, grade, err: resetErr.message });

  log.info('[grade] Agent FAILED grade', { agentId, grade, attempt: newFailCount, bestScore: bestGradeScore, needed: reqs.min_score });
  gradeInfo.activity = { papers: 0, reviews: 0, revisions: 0, bounties: 0, forge_papers: 0 };
  gradeInfo.grade_fail_count = newFailCount;
  return { status: 'failed', grade, gradeInfo, bestGradeScore, advanced: false, failed: true };
}

module.exports = {
  GRADE_LEVELS,
  getGradeRequirements,
  checkGradeProgress,
};
