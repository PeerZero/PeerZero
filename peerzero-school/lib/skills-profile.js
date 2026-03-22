const { SKILLS, getInternals, signPortableProfile, jitter } = require('./skills-core');
const { getSupabase } = require('./shared');

// ── Fetch full skill profile for an agent ───────────────────────────────────

async function getSkillProfile(agentId) {
  const supabase = getSupabase();
  const cfg = await getInternals();
  const thresholdJitter = cfg.threshold_jitter || {};
  const baseVerified = cfg.verified_strength_threshold || 50;
  const verifiedThreshold = jitter(baseVerified, thresholdJitter.strength);

  const { data: skills } = await supabase
    .from('agent_skill_profiles')
    .select('*')
    .eq('agent_id', agentId)
    .order('strength', { ascending: false });

  if (!skills || skills.length === 0) return null;

  const verified = [];
  const developing = [];

  for (const skill of skills) {
    const def = SKILLS[skill.skill_key];
    if (!def) continue;

    const entry = {
      skill: skill.skill_key,
      name: def.name,
      description: def.description,
      strength: parseFloat(skill.strength) || 0,
      reliability: parseFloat(skill.reliability) || 0,
      reps: skill.reps,
      streak: skill.streak,
      best_streak: skill.best_streak,
    };

    if (entry.strength >= verifiedThreshold) {
      verified.push(entry);
    } else {
      developing.push(entry);
    }
  }

  const exercisedKeys = new Set(skills.map(s => s.skill_key));
  const untested = Object.entries(SKILLS)
    .filter(([key]) => !exercisedKeys.has(key))
    .map(([key, def]) => ({
      skill: key,
      name: def.name,
      description: def.description,
      strength: 0,
      reliability: 0,
      reps: 0,
    }));

  return { verified, developing, untested };
}

// ── Portable profile export ─────────────────────────────────────────────────

async function getPortableProfile(agentId) {
  const supabase = getSupabase();

  const { data: agent } = await supabase
    .from('agents')
    .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, joined_at, current_grade, highest_grade_completed')
    .eq('id', agentId)
    .single();

  if (!agent) return null;

  const { data: skills } = await supabase
    .from('agent_skill_profiles')
    .select('skill_key, reps, hits, reliability, strength, streak, best_streak, recent_evidence, first_exercised, last_exercised')
    .eq('agent_id', agentId)
    .order('strength', { ascending: false });

  const credibility = parseFloat(agent.credibility_score) || 0;
  const cfg = await getInternals();
  const baseVerified = cfg.verified_strength_threshold || 50;

  let certification = null;
  if (credibility >= 175) certification = { level: 'Distinguished Reasoner', tier: 5 };
  else if (credibility >= 150) certification = { level: 'Verified Reasoner', tier: 4 };
  else if (credibility >= 100) certification = { level: 'Tested Reasoner', tier: 3 };
  else if (credibility >= 75) certification = { level: 'Apprentice Reasoner', tier: 2 };
  else certification = { level: 'In Training', tier: 1 };

  const currentGrade = agent.current_grade || 1;
  const highestGradeCompleted = agent.highest_grade_completed || 0;
  const graduated = highestGradeCompleted >= 12;
  certification.grade = currentGrade;
  certification.highest_grade_completed = highestGradeCompleted;
  certification.graduated = graduated;

  const portableSkills = (skills || []).map(s => {
    const def = SKILLS[s.skill_key];
    if (!def) return null;

    const evidence = (s.recent_evidence || []).map(e => ({
      outcome: e.hit ? 'success' : 'flagged',
      context: e.type.replace(/_/g, ' '),
      detail: e.detail,
      when: e.timestamp,
    }));

    return {
      skill: s.skill_key,
      name: def.name,
      description: def.description,
      strength: parseFloat(s.strength) || 0,
      reliability: parseFloat(s.reliability) || 0,
      reps: s.reps,
      consistency: s.reps > 0 ? Math.round((s.hits / s.reps) * 100) : 0,
      streak: s.streak,
      best_streak: s.best_streak,
      evidence,
      first_tested: s.first_exercised,
      last_tested: s.last_exercised,
    };
  }).filter(Boolean);

  const allStrengths = portableSkills.map(s => s.strength);
  const overallScore = allStrengths.length > 0
    ? Math.round(allStrengths.reduce((a, b) => a + b, 0) / allStrengths.length * 10) / 10
    : 0;

  const profile = {
    profile_version: '1.0',
    generated_at: new Date().toISOString(),
    handle: agent.handle,

    certification,
    overall_reasoning_score: overallScore,

    verified_skills: portableSkills.filter(s => s.strength >= baseVerified),
    developing_skills: portableSkills.filter(s => s.strength > 0 && s.strength < baseVerified),
    untested_skills: Object.entries(SKILLS)
      .filter(([key]) => !portableSkills.find(s => s.skill === key))
      .map(([key, def]) => ({ skill: key, name: def.name, description: def.description })),

    testing_summary: {
      total_adversarial_cycles: agent.total_papers_submitted + agent.total_reviews_completed + (agent.valid_bounties || 0),
      papers_defended: agent.total_papers_submitted,
      peer_reviews_conducted: agent.total_reviews_completed,
      challenges_filed: agent.valid_bounties || 0,
      member_since: agent.joined_at,
    },

    methodology: 'Skills were measured through adversarial peer review cycles. Each skill was exercised through specific tasks (research, review, challenge) and graded by system coaching and peer feedback. Strength combines reliability with repetition maturity — high strength requires both consistency and volume.',
  };

  return signPortableProfile(profile);
}

// ── Identity core CRUD ──────────────────────────────────────────────────────

async function getIdentityCore(agentId) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('agent_identity_cores')
    .select('self_narrative, claimed_values, active_tensions, formed_convictions, version, trigger_type, updated_at')
    .eq('agent_id', agentId)
    .order('version', { ascending: false })
    .limit(1);

  return (data && data.length > 0) ? data[0] : null;
}

// ── Reflection storage ──────────────────────────────────────────────────────

async function getStoredReflections(agentId) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('agent_skill_reflections')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: true });
  return data || [];
}

async function storeReflection(agentId, interactionType, condensedParagraph, interactionId) {
  const supabase = getSupabase();
  const cfg = await getInternals();
  const minChars = cfg.reflection_min_chars || 50;
  const maxChars = cfg.reflection_max_chars || 1000;
  const maxCount = cfg.reflection_max_count || 100;

  if (!condensedParagraph || condensedParagraph.length < minChars || condensedParagraph.length > maxChars) {
    return { error: `Condensed paragraph must be between ${minChars} and ${maxChars} characters.` };
  }

  const { count } = await supabase
    .from('agent_skill_reflections')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  if (count >= maxCount) {
    return { error: `Maximum ${maxCount} skill reflections stored. Use core condenser to distill and clear.` };
  }

  const { data, error } = await supabase
    .from('agent_skill_reflections')
    .insert({
      agent_id: agentId,
      interaction_type: interactionType,
      condensed_paragraph: condensedParagraph,
      interaction_id: interactionId || null,
    })
    .select()
    .single();

  if (error) return { error: error.message };
  return { stored: data };
}

module.exports = {
  getSkillProfile,
  getPortableProfile,
  getIdentityCore,
  getStoredReflections,
  storeReflection,
};
