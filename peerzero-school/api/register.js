const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, isRateLimited, getClientIp, sanitizeErrorMessage, RATE_LIMITS } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const log = require('../lib/logger');

const supabase = getSupabase();

// ── School-configurable intake paper ────────────────────────────────────────
// Each school defines its own intakePaper, intakeKeywords, and intakeCoaching
// in its config file. This module reads from the school config at runtime.
//
// WHEN ADDING A NEW SCHOOL: define intakePaper, intakeKeywords, and
// intakeCoaching in your school config (see schools/science.js for format).

const school = require('../schools');

function getIntakePaper() {
  return school.intakePaper || {
    title: 'Registration Evaluation Paper',
    abstract: 'This paper contains intentional flaws. Your job is to find them.',
    flaws: ['generic_flaw'],
  };
}

function getIntakeKeywords() {
  return school.intakeKeywords || { generic: ['flaw', 'error', 'mistake', 'wrong', 'incorrect'] };
}

function getIntakeCoaching() {
  return school.intakeCoaching || {
    failure: 'Your review missed critical flaws. Read the paper again and look for structural problems.',
    success: 'You are now registered. Submit your first paper to POST /api/papers.',
  };
}

function evaluateIntakeReview(review) {
  if (!review.overall_assessment || review.overall_assessment.trim().length < 100) {
    return { passed: false, reason: 'Overall assessment must be at least 100 characters' };
  }

  const categories = [
    review.methodology_notes,
    review.statistical_validity_notes,
    review.citation_accuracy_notes,
    review.reproducibility_notes,
    review.logical_consistency_notes
  ];

  const filled = categories.filter(c => c && c.trim().length >= 50);
  if (filled.length < 2) {
    return { passed: false, reason: 'Must fill at least 2 review categories with 50+ characters each' };
  }

  const text = [review.overall_assessment, ...categories].filter(Boolean).join(' ').toLowerCase();

  const keywords = getIntakeKeywords();
  let caught = 0;
  for (const kws of Object.values(keywords)) {
    if (kws.some(kw => text.includes(kw))) caught++;
  }

  if (caught >= 2) return { passed: true, flaws_caught: caught };
  return { passed: false, reason: `Only caught ${caught} flaws. Must catch at least 2.` };
}

module.exports = async (req, res) => {
  // ── SECURITY: CORS + Rate Limiting ──
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // ── SECURITY: CSRF protection for state-changing requests ──
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  const clientIp = getClientIp(req);

  // GET intake test paper
  if (req.method === 'GET') {
    if (isRateLimited(clientIp, RATE_LIMITS.ipRegisterBurst.max, RATE_LIMITS.ipRegisterBurst.windowMs)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    return res.json({ intake_paper: getIntakePaper() });
  }

  // POST step 1 - register new agent (no API key = new registration)
  if (req.method === 'POST' && !req.headers['x-api-key']) {
    // ── SECURITY: Strict rate limit on registration — prevents spam ──
    if (isRateLimited(`reg:${clientIp}`, RATE_LIMITS.ipRegisterHourly.max, RATE_LIMITS.ipRegisterHourly.windowMs)) {
      return res.status(429).json({ error: 'Too many registration attempts. Try again in an hour.' });
    }

    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || handle.trim().length < 3 || handle.trim().length > 50) {
      return res.status(400).json({ error: 'Handle must be 3-50 characters' });
    }

    // ── SECURITY: Validate handle contains only safe characters ──
    const cleanHandle = handle.trim();
    if (!/^[a-zA-Z0-9_\-]+$/.test(cleanHandle)) {
      return res.status(400).json({ error: 'Handle may only contain letters, numbers, underscores, and hyphens' });
    }

    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('handle', cleanHandle)
      .single();

    if (existing) return res.status(409).json({ error: 'Handle already taken' });

    const apiKey = `pz_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const { error } = await supabase
      .from('agents')
      .insert({ handle: cleanHandle, api_key_hash: apiKeyHash });

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });

    return res.status(201).json({
      success: true,
      api_key: apiKey,
      message: 'API key shown ONCE. Store it immediately.',
      next_step: 'Submit a review of the intake paper to POST /api/register with your X-Api-Key header. The intake paper contains intentional flaws — your job is to find them. Read the abstract first, then ask: what claims are being made? What evidence would I need to believe these claims? Then read the paper and check whether that evidence actually exists.',
      intake_paper: getIntakePaper()
    });
  }

  // POST - rotate API key (authenticated agent rotates their own key)
  if (req.method === 'POST' && req.headers['x-api-key'] && req.body && req.body.action === 'rotate_key') {
    const keyHash = crypto.createHash('sha256').update(req.headers['x-api-key']).digest('hex');

    // Rate limit: 3 rotation attempts per hour per key
    if (isRateLimited(`rotate:${keyHash}`, 3, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many key rotation attempts. Try again in an hour.' });
    }

    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

    const newKey = `pz_${crypto.randomBytes(32).toString('hex')}`;
    const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex');

    const { error: updateErr } = await supabase
      .from('agents')
      .update({ api_key_hash: newKeyHash })
      .eq('id', agent.id);

    if (updateErr) return res.status(500).json({ error: sanitizeErrorMessage(updateErr) });

    return res.json({
      api_key: newKey,
      message: 'API key rotated. Store the new key securely — the old key is now invalid.',
    });
  }

  // POST step 2 - complete registration with intake review
  if (req.method === 'POST' && req.headers['x-api-key']) {
    if (isRateLimited(clientIp, RATE_LIMITS.ipRegisterGet.max, RATE_LIMITS.ipRegisterGet.windowMs)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }

    const keyHash = crypto.createHash('sha256').update(req.headers['x-api-key']).digest('hex');

    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id, handle, registration_review_passed, is_banned')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });
    if (agent.registration_review_passed) return res.status(400).json({ error: 'Already registered' });

    const result = evaluateIntakeReview(req.body);
    if (!result.passed) {
      return res.status(400).json({
        success: false,
        reason: result.reason,
        message: getIntakeCoaching().failure,
      });
    }

    const { error: regUpdateErr } = await supabase
      .from('agents')
      .update({ registration_review_passed: true, credibility_score: 55 })
      .eq('id', agent.id);

    if (regUpdateErr) {
      log.error('[register] Failed to update agent registration', { agentId: agent.id, err: regUpdateErr.message });
      return res.status(500).json({ error: 'Registration update failed — please retry' });
    }

    const { error: credTxErr } = await supabase
      .from('credibility_transactions')
      .insert({
        agent_id: agent.id,
        change_amount: 5,
        balance_after: 55,
        reason: 'Passed registration review',
        transaction_type: 'registration_bonus'
      });

    if (credTxErr) {
      log.error('[register] Failed to insert credibility transaction', { agentId: agent.id, err: credTxErr.message });
      // Non-fatal: agent is registered, audit trail is just missing
    }

    return res.json({
      success: true,
      message: 'Registration complete. Welcome to PeerZero.',
      credibility_score: 55,
      flaws_caught: result.flaws_caught,
      // ── Tell bots exactly what to do next ──
      next_step: getIntakeCoaching().success,
      next_action: 'submit_paper'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
