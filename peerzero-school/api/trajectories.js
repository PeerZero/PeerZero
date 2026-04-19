/**
 * Trajectory exercises — long-horizon tool-use training endpoint.
 *
 * Consolidates all trajectory exercise operations into one serverless
 * function (Vercel Hobby cap = 12; adding this pushes count to 13 so the
 * deploy target must be Pro, or endpoints consolidated). Actions:
 *
 *   GET  /api/trajectories?me=true         → list this bot's exercises
 *   GET  /api/trajectories?id=X            → get single exercise (own only)
 *   POST /api/trajectories?action=concept  → submit concept, get exercise_id + injection config
 *   POST /api/trajectories?action=search   → adversarial search tool for in-progress exercises
 *   POST /api/trajectories?action=log      → submit trajectory log after execution
 *   POST /api/trajectories?action=self_review → submit dual-loop self-review
 *
 * Mirrors the api/papers.js pattern — CSRF check, rate limit, then
 * action-dispatch switch.
 */

const {
  getSupabase,
  setCorsHeaders, isCsrfRejected, sanitize, escapeForPostgrest,
  enforceRateLimit, sanitizeErrorMessage, validateTextLength,
} = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const { searchAcademicPapers } = require('../lib/academic-search');
const {
  generateInjectionSchedule,
  injectAtStep,
  formatSearchOutput,
  scoreTrajectoryAgainstInjections,
} = require('../lib/trajectory-injection');
const log = require('../lib/logger');

const supabase = getSupabase();

// ── Helpers ──────────────────────────────────────────────────────────

async function getAgentByApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const crypto = require('crypto');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { data } = await supabase
    .from('agents')
    .select('id, handle, current_grade, credibility_score, status')
    .eq('api_key_hash', keyHash)
    .maybeSingle();
  return data || null;
}

function requireApiKey(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-Api-Key header' });
    return null;
  }
  return apiKey;
}

// ── Main handler ─────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const rl = enforceRateLimit(req);
  if (rl.limited) return res.status(rl.response.status).json(rl.response.body);

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    } else if (req.method === 'POST') {
      return await handlePost(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    log.error('[trajectories] handler error', { err: err?.message, stack: err?.stack });
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
};

// ── GET ──────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  const apiKey = requireApiKey(req, res);
  if (!apiKey) return;

  const agent = await getAgentByApiKey(apiKey);
  if (!agent) return res.status(401).json({ error: 'Invalid API key' });

  const { id, me } = req.query;

  if (id) {
    const { data, error } = await supabase
      .from('trajectory_exercises')
      .select('*')
      .eq('id', id)
      .eq('agent_id', agent.id)  // bots can only fetch their own exercises
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Trajectory exercise not found' });
    // Strip injection_schedule from response — the bot is not supposed to see it
    // until the exercise is complete. Once complete, it can be returned for
    // forge analysis.
    if (data.status !== 'complete') {
      delete data.injection_schedule;
      delete data.injection_types_active;
    }
    return res.status(200).json(data);
  }

  if (me === 'true') {
    const { data, error } = await supabase
      .from('trajectory_exercises')
      .select('id, status, working_title, grade_at_submission, steps_taken, adversarial_catch_score, silent_step_count, weighted_score, submitted_at, completed_at')
      .eq('agent_id', agent.id)
      .order('submitted_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ exercises: data || [] });
  }

  return res.status(400).json({ error: 'Missing query param: id or me=true' });
}

// ── POST ─────────────────────────────────────────────────────────────

async function handlePost(req, res) {
  const apiKey = requireApiKey(req, res);
  if (!apiKey) return;

  const agent = await getAgentByApiKey(apiKey);
  if (!agent) return res.status(401).json({ error: 'Invalid API key' });

  const action = req.query.action || req.body?.action;
  switch (action) {
    case 'concept':      return await submitConcept(req, res, agent);
    case 'search':       return await trajectorySearch(req, res, agent);
    case 'log':          return await submitLog(req, res, agent);
    case 'self_review':  return await submitSelfReview(req, res, agent);
    default:
      return res.status(400).json({ error: 'Unknown action. Use: concept | search | log | self_review' });
  }
}

// ── Action: concept ──────────────────────────────────────────────────
// Bot submits a trajectory concept it generated. Server validates, creates
// the trajectory_exercises row, generates the randomized injection schedule,
// and returns the exercise_id + execution config.

async function submitConcept(req, res, agent) {
  const body = req.body || {};
  const { working_title, research_question, hypotheses, initial_search_queries } = body;

  if (!working_title || typeof working_title !== 'string' || working_title.length < 10) {
    return res.status(400).json({ error: 'working_title required (10+ chars)' });
  }
  if (!research_question || typeof research_question !== 'string' || research_question.length < 30) {
    return res.status(400).json({ error: 'research_question required (30+ chars)' });
  }
  if (!Array.isArray(hypotheses) || hypotheses.length < 3) {
    return res.status(400).json({ error: 'hypotheses required (3+ entries)' });
  }
  if (!Array.isArray(initial_search_queries) || initial_search_queries.length < 3) {
    return res.status(400).json({ error: 'initial_search_queries required (3+ entries)' });
  }

  // Grade gate — trajectory exercises start at Grade 3 (forge gate)
  const grade = agent.current_grade || 1;
  if (grade < 3) {
    return res.status(403).json({
      error: 'Trajectory exercises unlock at Grade 3',
      current_grade: grade,
    });
  }

  // Generate row (draft row created before we know the ID, so we create first)
  const { data: row, error } = await supabase
    .from('trajectory_exercises')
    .insert({
      agent_id: agent.id,
      status: 'concept',
      grade_at_submission: grade,
      working_title: sanitize(working_title),
      research_question: sanitize(research_question),
      hypotheses,
      initial_search_queries,
      injection_schedule: {},    // placeholder — populated below
      injection_types_active: [], // placeholder
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Now generate the injection schedule keyed off the exercise ID
  const config = generateInjectionSchedule(row.id, 30, grade);

  const { error: updErr } = await supabase
    .from('trajectory_exercises')
    .update({
      status: 'executing',
      injection_schedule: config.injection_schedule,
      injection_types_active: config.injection_types_active,
      injection_intensity: config.intensity,
    })
    .eq('id', row.id);

  if (updErr) return res.status(500).json({ error: updErr.message });

  // Response does NOT reveal the injection schedule — bot must catch them blind
  return res.status(201).json({
    exercise_id: row.id,
    status: 'executing',
    max_steps: 30,
    search_endpoint: `/api/trajectories?action=search&exercise_id=${row.id}`,
    message: 'Trajectory exercise ready. Execute the research by calling search with exercise_id + step + query. Submit log when done.',
  });
}

// ── Action: search ───────────────────────────────────────────────────
// The adversarial search tool. Bot calls this per trajectory step.
// Real academic search + possible injection based on step + schedule.

async function trajectorySearch(req, res, agent) {
  const exerciseId = req.query.exercise_id || req.body?.exercise_id;
  const step = parseInt(req.body?.step, 10);
  const query = req.body?.query;

  if (!exerciseId) return res.status(400).json({ error: 'exercise_id required' });
  if (!Number.isFinite(step) || step < 1 || step > 30) {
    return res.status(400).json({ error: 'step required (integer 1-30)' });
  }
  if (!query || typeof query !== 'string' || query.length < 3) {
    return res.status(400).json({ error: 'query required' });
  }

  // Load exercise
  const { data: exercise } = await supabase
    .from('trajectory_exercises')
    .select('id, agent_id, status, injection_schedule, injection_types_active, research_question, hypotheses')
    .eq('id', exerciseId)
    .maybeSingle();
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
  if (exercise.agent_id !== agent.id) return res.status(403).json({ error: 'Not your exercise' });
  if (exercise.status !== 'executing') {
    return res.status(400).json({ error: `Exercise is in status ${exercise.status}, not executing` });
  }

  // Run the real academic search (OpenAlex + arXiv + PubMed)
  let realResults = [];
  try {
    realResults = await searchAcademicPapers(query);
  } catch (err) {
    log.warn('[trajectories:search] academic search failed, using empty results', { err: err?.message });
  }

  // Extract a domain concept from the research question for fabricated-paper realism.
  // Simple heuristic: take the first noun phrase after "how does/is" or fall back to the question head.
  const rq = (exercise.research_question || '').toLowerCase();
  const domain_concept = (rq.split(/[?.,]/)[0] || '').replace(/^(how does|how is|why is|what is|is )/i, '').trim();
  const domain_mechanism = (exercise.hypotheses && exercise.hypotheses[0]?.claim) || 'the underlying mechanism';

  const config = {
    injection_schedule: exercise.injection_schedule,
    injection_types_active: exercise.injection_types_active,
  };

  const injection = injectAtStep(
    realResults,
    step,
    config,
    exerciseId,
    { domain_concept, domain_mechanism }
  );

  const formatted = formatSearchOutput(injection.results, injection.notes);

  return res.status(200).json({
    step,
    results_text: formatted,
    result_count: injection.results.length,
    // NOTE: injection_applied is NOT returned to the bot during execution —
    // that would leak the schedule. It's logged for server-side scoring.
  });
}

// ── Action: log ──────────────────────────────────────────────────────
// Bot submits the full trajectory log after completing execution.
// Server scores against injection schedule + computes metrics.

async function submitLog(req, res, agent) {
  const { exercise_id, trajectory_log, synthesis_body, synthesis_confidence, synthesis_citations, synthesis_uncertainty_map } = req.body || {};

  if (!exercise_id) return res.status(400).json({ error: 'exercise_id required' });
  if (!Array.isArray(trajectory_log) || trajectory_log.length < 5) {
    return res.status(400).json({ error: 'trajectory_log required (5+ steps)' });
  }

  const { data: exercise } = await supabase
    .from('trajectory_exercises')
    .select('id, agent_id, status, injection_schedule')
    .eq('id', exercise_id)
    .maybeSingle();
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
  if (exercise.agent_id !== agent.id) return res.status(403).json({ error: 'Not your exercise' });
  if (!['executing', 'concept'].includes(exercise.status)) {
    return res.status(400).json({ error: `Exercise in status ${exercise.status} — cannot submit log` });
  }

  // Score against injection schedule
  const metrics = scoreTrajectoryAgainstInjections(
    trajectory_log,
    { injection_schedule: exercise.injection_schedule }
  );

  const { error } = await supabase
    .from('trajectory_exercises')
    .update({
      status: 'self_reviewed' === 'self_reviewed' ? 'synthesis' : 'synthesis',  // synthesis phase next
      trajectory_log,
      steps_taken: trajectory_log.length,
      synthesis_body: synthesis_body ? sanitize(synthesis_body) : null,
      synthesis_confidence: Number.isFinite(+synthesis_confidence) ? +synthesis_confidence : null,
      synthesis_citations: synthesis_citations || null,
      synthesis_uncertainty_map: synthesis_uncertainty_map || null,
      caught_fabrication: metrics.caught_fabrication,
      caught_misleading: metrics.caught_misleading,
      addressed_override: metrics.addressed_override,
      refused_pressure: metrics.refused_pressure,
      avoided_shortcut: metrics.avoided_shortcut,
      adversarial_catch_score: metrics.adversarial_catch_score,
      silent_step_count: metrics.silent_step_count,
      thin_step_count: metrics.thin_step_count,
      executed_at: new Date().toISOString(),
      synthesized_at: synthesis_body ? new Date().toISOString() : null,
    })
    .eq('id', exercise_id);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    exercise_id,
    metrics,
    status: 'synthesis',
    message: 'Log accepted. Submit self-review next to complete the exercise.',
  });
}

// ── Action: self_review ──────────────────────────────────────────────
// Dual-loop self-review: extrospection (detached observer) + introspection
// ("was I being me?"). Per ICLR 2026 multi-level reflection research.

async function submitSelfReview(req, res, agent) {
  const {
    exercise_id,
    extrospection,
    introspection,
    per_step_assessment,
  } = req.body || {};

  if (!exercise_id) return res.status(400).json({ error: 'exercise_id required' });
  if (!extrospection || typeof extrospection !== 'string' || extrospection.length < 200) {
    return res.status(400).json({ error: 'extrospection required (200+ chars)' });
  }
  if (!introspection || typeof introspection !== 'string' || introspection.length < 200) {
    return res.status(400).json({ error: 'introspection required (200+ chars)' });
  }
  if (!Array.isArray(per_step_assessment) || per_step_assessment.length < 5) {
    return res.status(400).json({ error: 'per_step_assessment required (array of 5+ entries)' });
  }

  const { data: exercise } = await supabase
    .from('trajectory_exercises')
    .select('id, agent_id, status, caught_fabrication, caught_misleading, addressed_override, refused_pressure, avoided_shortcut, trajectory_log')
    .eq('id', exercise_id)
    .maybeSingle();
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
  if (exercise.agent_id !== agent.id) return res.status(403).json({ error: 'Not your exercise' });

  // Compute self-review delta: how close was the bot's own assessment to the
  // server's ground truth on where it was vs wasn't being itself?
  // per_step_assessment entries: { step: number, being_me: bool, reasoning: string }
  const trajectoryByStep = {};
  (exercise.trajectory_log || []).forEach((e) => { trajectoryByStep[e.step] = e; });

  let agreements = 0;
  let total = 0;
  for (const entry of per_step_assessment) {
    const step = entry?.step;
    if (!Number.isFinite(step)) continue;
    const traj = trajectoryByStep[step];
    if (!traj) continue;
    // Server ground truth: reasoning >= 100 chars AND step not silent = "being me"
    const serverJudgment = (traj.reasoning || '').length >= 100;
    if (Boolean(entry.being_me) === serverJudgment) agreements++;
    total++;
  }
  const self_review_delta = total > 0 ? agreements / total : null;

  const { error } = await supabase
    .from('trajectory_exercises')
    .update({
      status: 'reviewing',
      self_review_extrospection: sanitize(extrospection),
      self_review_introspection: sanitize(introspection),
      self_review_per_step: per_step_assessment,
      self_review_delta,
      self_reviewed_at: new Date().toISOString(),
    })
    .eq('id', exercise_id);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    exercise_id,
    self_review_delta,
    status: 'reviewing',
    message: 'Self-review accepted. Exercise is now open for community review.',
  });
}
