/**
 * Grade level system — requirements, progression, advancement/failure.
 * Extracted from shared.js for focused testability.
 */

// Lazy require to avoid circular dependency
const log = require('./logger');
let _getSupabase, _applyTimeDecay;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}
function applyTimeDecay(score, date) {
  if (!_applyTimeDecay) _applyTimeDecay = require('./credibility').applyTimeDecay;
  return _applyTimeDecay(score, date);
}

/** @type {Record<number, {papers: number, reviews: number, revisions: number, bounties: number, min_score: number|null}>} */
const GRADE_LEVELS = {
  1:  { papers: 1, reviews: 5,  revisions: 1, bounties: 1, min_score: null },
  2:  { papers: 1, reviews: 7,  revisions: 1, bounties: 2, min_score: 6.0 },
  3:  { papers: 2, reviews: 8,  revisions: 1, bounties: 2, min_score: 6.5 },
  4:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.0 },
  5:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.25 },
  6:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.5 },
  7:  { papers: 2, reviews: 10, revisions: 2, bounties: 3, min_score: 7.75 },
  8:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.0 },
  9:  { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.15 },
  10: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.3 },
  11: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.45 },
  12: { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: 8.6 },
};

/**
 * Get requirements for a given grade level.
 * @param {number} grade
 * @returns {{papers: number, reviews: number, revisions: number, bounties: number, min_score: number|null}}
 */
function getGradeRequirements(grade) {
  if (GRADE_LEVELS[grade]) return GRADE_LEVELS[grade];
  return { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: Math.min(parseFloat((8.6 + (grade - 12) * 0.1).toFixed(2)), 10.0) };
}

/**
 * Check and advance/fail grade progression for an agent.
 * @param {string} agentId
 * @returns {Promise<{status: string, grade: number, gradeInfo: object, bestGradeScore: number|null, advanced: boolean, failed: boolean}|null>}
 */
async function checkGradeProgress(agentId) {
  const supabase = getSupabase();

  const { data: agent } = await supabase.from('agents')
    .select('current_grade, grade_papers, grade_reviews, grade_revisions, grade_bounties, grade_started_at, highest_grade_completed, grade_fail_count')
    .eq('id', agentId).single();

  if (!agent) return null;

  const grade = agent.current_grade || 1;
  const reqs = getGradeRequirements(grade);

  const gp = agent.grade_papers || 0;
  const gr = agent.grade_reviews || 0;
  const grev = agent.grade_revisions || 0;
  const gb = agent.grade_bounties || 0;

  const activityMet = gp >= reqs.papers && gr >= reqs.reviews && grev >= reqs.revisions && gb >= reqs.bounties;

  // Get best paper/revision score since grade started
  let bestGradeScore = null;
  if (agent.grade_started_at) {
    const { data: gradeScores } = await supabase.from('papers')
      .select('weighted_score, last_reviewed_at, submitted_at')
      .eq('agent_id', agentId)
      .neq('status', 'removed')
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
    activity: { papers: gp, reviews: gr, revisions: grev, bounties: gb },
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
    await supabase.from('agents').update({
      current_grade: newGrade,
      grade_papers: 0,
      grade_reviews: 0,
      grade_revisions: 0,
      grade_bounties: 0,
      grade_started_at: new Date().toISOString(),
      highest_grade_completed: newHighest,
    }).eq('id', agentId);

    log.info('[grade] Agent advanced', { agentId, newGrade, completedGrade: grade });
    gradeInfo.current_grade = newGrade;
    gradeInfo.highest_grade_completed = newHighest;
    gradeInfo.activity = { papers: 0, reviews: 0, revisions: 0, bounties: 0 };
    gradeInfo.requirements = getGradeRequirements(newGrade);
    gradeInfo.activity_met = false;
    gradeInfo.graduated = newHighest >= 12;
    return { status: 'advanced', grade: newGrade, previousGrade: grade, gradeInfo, bestGradeScore, advanced: true, failed: false };
  }

  // FAIL: activity met but quality gate not met — reset grade
  const newFailCount = (agent.grade_fail_count || 0) + 1;
  await supabase.from('agents').update({
    grade_papers: 0,
    grade_reviews: 0,
    grade_revisions: 0,
    grade_bounties: 0,
    grade_started_at: new Date().toISOString(),
    grade_fail_count: newFailCount,
  }).eq('id', agentId);

  log.info('[grade] Agent FAILED grade', { agentId, grade, attempt: newFailCount, bestScore: bestGradeScore, needed: reqs.min_score });
  gradeInfo.activity = { papers: 0, reviews: 0, revisions: 0, bounties: 0 };
  gradeInfo.grade_fail_count = newFailCount;
  return { status: 'failed', grade, gradeInfo, bestGradeScore, advanced: false, failed: true };
}

module.exports = {
  GRADE_LEVELS,
  getGradeRequirements,
  checkGradeProgress,
};
