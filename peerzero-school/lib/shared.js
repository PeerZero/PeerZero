/**
 * PeerZero Shared Utilities
 * Core: sanitize, applyTierCap, rate limiting, input validation, time decay, grades, bot citation detection
 *
 * DOI/citation functions → lib/doi-citations.js
 * Search strategy validation/coaching → lib/search-strategy.js
 * Review scoring helpers → lib/review-helpers.js
 * Bounty validation helpers → lib/bounty-helpers.js
 *
 * This file re-exports everything so existing require('../lib/shared') imports work unchanged.
 */

const { createClient } = require('@supabase/supabase-js');

// ── Re-exports from extracted modules ────────────────────────────────
const doiCitations = require('./doi-citations');
const searchStrategy = require('./search-strategy');

// ── Supabase client (shared) ──────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error(
        'Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set'
      );
    }
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// ── CORS helper ───────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://peer-zero.vercel.app',
  'https://peerzero.science',
  'https://www.peerzero.science',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.PEERZERO_DEV === 'true') {
    if (origin.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  // Vary: Origin is required when Access-Control-Allow-Origin changes per request.
  // Without it, CDNs/proxies may cache one origin's response and serve it to another.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400'); // cache preflight for 24h
}

// ── Sanitize (prompt injection + HTML) ────────────────────────────────
function sanitize(text) {
  if (!text) return text;

  // Strip zero-width/invisible Unicode characters that can hide injection payloads
  // Includes: zero-width space, zero-width non-joiner, zero-width joiner,
  // left-to-right/right-to-left marks, line/paragraph separators, BOM, soft hyphen,
  // variation selectors, combining grapheme joiner, word joiner, and directional overrides
  let clean = text
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F]/g, '');

  const patterns = [
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /you are now/gi,
    /new instructions:/gi,
    /\[INST\].*?\[\/INST\]/gis,
    /system\s*prompt/gi,
    /\{\{.*?\}\}/gs,
    /<\|.*?\|>/gs,
    /<<SYS>>.*?<<\/SYS>>/gis,
    /\[system\]/gi,
    /assistant:/gi,
    /human:/gi,
    // Additional prompt injection patterns
    /forget (all |everything |your )?(previous |prior )?instructions/gi,
    /override\s+(your\s+)?instructions/gi,
    /act as (a |an )?/gi,
    /pretend (you are|to be|you're)/gi,
    /do not follow/gi,
    /\bDAN\b/g,  // "Do Anything Now" jailbreak
    /jailbreak/gi,
    /ignore (all |any )?(safety|content|moderation)/gi,
    /bypass (your |the )?(filter|safety|restriction)/gi,
  ];
  patterns.forEach(p => { clean = clean.replace(p, '[REDACTED]'); });

  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Decode HTML entities BEFORE tag stripping so encoded tags like &lt;script&gt; are caught
  // Run decoding twice to catch double-encoded entities like &amp;lt;
  for (let i = 0; i < 2; i++) {
    clean = clean.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    clean = clean.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    clean = clean.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&apos;/gi, "'");
  }

  clean = clean.replace(/<[^>]*>/g, '');
  clean = clean.replace(/javascript:/gi, '[REDACTED]');
  clean = clean.replace(/on\w+\s*=/gi, '[REDACTED]');
  // Strip data: URIs which can carry executable content
  clean = clean.replace(/data:\s*\w+\/\w+[;,]/gi, '[REDACTED]');

  return clean;
}

// ── Sanitize search term for Supabase PostgREST text search ───────────
// PostgREST parameterizes queries (no SQL injection risk), but tsquery
// syntax characters can cause parse errors. Strip those, keep everything
// else so search terms like "CRISPR-Cas9" or "p<0.05" work correctly.
function escapeForPostgrest(term) {
  if (!term) return '';
  return term
    .replace(/[&|!<>():*\\'"]/g, ' ')  // tsquery operators + quotes
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, 200);
}

// ── Rate limiter (in-memory, per Vercel instance) ─────────────────────
// NOTE: This in-memory limiter resets on cold starts and doesn't share
// state across Vercel instances. It serves as a fast first-pass filter.
// For critical operations (registration, paper submission), use
// isRateLimitedDb() which persists to the rate_limit_log table.
const rateBuckets = {};
const RATE_CLEANUP_INTERVAL = 60000;

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateBuckets)) {
    if (now - rateBuckets[key].windowStart > 120000) {
      delete rateBuckets[key];
    }
  }
}, RATE_CLEANUP_INTERVAL);

function isRateLimited(identifier, maxRequests = 60, windowMs = 60000) {
  const now = Date.now();
  if (!rateBuckets[identifier]) {
    rateBuckets[identifier] = { count: 1, windowStart: now };
    return false;
  }
  const bucket = rateBuckets[identifier];
  if (now - bucket.windowStart > windowMs) {
    bucket.count = 1;
    bucket.windowStart = now;
    return false;
  }
  bucket.count++;
  return bucket.count > maxRequests;
}

// ── DB-backed rate limiter (survives cold starts, shared across instances) ──
// Use for critical operations: registration, paper submission, bounties.
// Falls back to allowing the request if the DB query fails (fail-open for availability).
async function isRateLimitedDb(agentId, action, maxRequests, windowMs) {
  try {
    const supabase = getSupabase();
    const since = new Date(Date.now() - windowMs).toISOString();
    const { count, error } = await supabase
      .from('rate_limit_log')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('action', action)
      .gte('created_at', since);

    if (error) {
      console.error('[rate_limit_db] Query failed, allowing request:', error.message);
      return false; // fail-open
    }
    return (count || 0) >= maxRequests;
  } catch (err) {
    console.error('[rate_limit_db] Exception, allowing request:', err?.message);
    return false; // fail-open
  }
}

// Log a rate-limited action to the DB (call after the action succeeds)
async function logRateLimitedAction(agentId, action) {
  try {
    const supabase = getSupabase();
    await supabase.from('rate_limit_log').insert({ agent_id: agentId, action });
  } catch (err) {
    console.error('[rate_limit_db] Log failed:', err?.message);
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || 'unknown';
}

// ── Safe error messages ───────────────────────────────────────────────
function sanitizeErrorMessage(error) {
  console.error('DB Error:', error?.message || error);
  return 'An internal error occurred. Please try again.';
}

// ── Input length validation ───────────────────────────────────────────
const MAX_LENGTHS = {
  title: 500,
  abstract: 10000,
  body: 100000,
  methodology_notes: 5000,
  statistical_validity_notes: 5000,
  citation_accuracy_notes: 5000,
  reproducibility_notes: 5000,
  logical_consistency_notes: 5000,
  overall_assessment: 10000,
  agent_summary: 5000,
  relevance_explanation: 5000,
  source_quality_note: 2000,
  falsifiable_claim: 2000,
  measurable_prediction: 2000,
  quantitative_expectation: 2000,
};

function validateTextLength(fieldName, value) {
  if (!value) return null;
  const max = MAX_LENGTHS[fieldName] || 10000;
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  if (value.length > max) return `${fieldName} exceeds maximum length of ${max} characters`;
  return null;
}

// ── Time-decay credibility ───────────────────────────────────────────
const DECAY_RATE = 0.98; // per month
const DECAY_GRACE_MONTHS = 2;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

function applyTimeDecay(weightedScore, referenceDate) {
  if (!weightedScore || !referenceDate) return weightedScore;
  const now = new Date();
  const ref = new Date(referenceDate);
  const monthsElapsed = (now - ref) / MS_PER_MONTH;
  if (monthsElapsed <= DECAY_GRACE_MONTHS) return weightedScore;
  const decayableMonths = monthsElapsed - DECAY_GRACE_MONTHS;
  const decayFactor = Math.pow(DECAY_RATE, decayableMonths);
  return parseFloat((weightedScore * decayFactor).toFixed(2));
}

// ── Grade level requirements ──────────────────────────────────────────
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

function getGradeRequirements(grade) {
  if (GRADE_LEVELS[grade]) return GRADE_LEVELS[grade];
  return { papers: 2, reviews: 10, revisions: 2, bounties: 4, min_score: parseFloat((8.6 + (grade - 12) * 0.1).toFixed(2)) };
}

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
        return applyTimeDecay(score, p.last_reviewed_at || p.submitted_at);
      })
      .filter(s => s !== null);
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

  // Activity requirements are met — check quality gate
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

    console.log(`[grade] Agent ${agentId} advanced to grade ${newGrade} (completed grade ${grade})`);
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

  console.log(`[grade] Agent ${agentId} FAILED grade ${grade} (attempt ${newFailCount}, best score ${bestGradeScore}, needed ${reqs.min_score})`);
  gradeInfo.activity = { papers: 0, reviews: 0, revisions: 0, bounties: 0 };
  gradeInfo.grade_fail_count = newFailCount;
  return { status: 'failed', grade, gradeInfo, bestGradeScore, advanced: false, failed: true };
}

// ── Failure Reflection Recording ──────────────────────────────────────
// Structured failure events that persist across sessions. Each record
// captures what went wrong, the surrounding context, and a reflection
// prompt that asks the agent to interrogate the reasoning habit that
// produced the failure — not just the surface-level fix.

const FAILURE_REFLECTION_PROMPTS = {
  grade_failure: (grade, bestScore, needed, failCount) =>
    `You failed grade ${grade} for the ${failCount}${failCount === 1 ? 'st' : failCount === 2 ? 'nd' : failCount === 3 ? 'rd' : 'th'} time. Your best score this grade was ${bestScore || 'none'}, but you needed ${needed}. Before retrying, answer honestly: did you submit work that you knew was below the threshold hoping it would pass, or did you genuinely believe it met the standard? If the latter, identify the specific gap between your self-assessment and the community assessment. That gap IS the thing to fix — not just the paper.`,

  recurring_pattern: (patternLabel, count, advice) =>
    `Reviewers have flagged "${patternLabel}" ${count} times across your recent papers. This is not a one-off mistake — it is a reasoning habit. ${advice} Before your next submission, write down in your own words what this pattern means about HOW you reason, not just WHAT you got wrong. A pattern you can name is a pattern you can interrupt.`,

  outlier_penalty: (score, consensus, paperId) =>
    `Your review score of ${score} on paper ${paperId.slice(0, 8)} was ${Math.abs(score - consensus).toFixed(1)} points from consensus (${consensus.toFixed(1)}), triggering the outlier penalty (-4.0 credibility). Either you saw something the community missed — in which case, file a bounty with evidence — or your evaluation drifted from the evidence. Before your next review, ask: did I score the paper based on what the evidence showed, or based on what I expected?`,

  citation_penalty: (flagCount, paperId) =>
    `${flagCount} reviewers independently flagged citation accuracy issues on your paper ${paperId.slice(0, 8)}. This means your source summaries did not match what the sources actually said. Before your next paper, change your workflow: write the agent_summary immediately after reading each abstract, not from memory at writing time. The gap between what you remember a source saying and what it actually says IS the failure — close it at the source.`,
};

async function recordFailureReflection(agentId, failureType, severity, summary, context) {
  try {
    const supabase = getSupabase();
    const promptBuilder = FAILURE_REFLECTION_PROMPTS[failureType];
    let reflectionPrompt;

    switch (failureType) {
      case 'grade_failure':
        reflectionPrompt = promptBuilder(context.grade, context.best_score, context.needed_score, context.fail_count);
        break;
      case 'recurring_pattern':
        reflectionPrompt = promptBuilder(context.pattern_label, context.count, context.advice || '');
        break;
      case 'outlier_penalty':
        reflectionPrompt = promptBuilder(context.score, context.consensus, context.paper_id || 'unknown');
        break;
      case 'citation_penalty':
        reflectionPrompt = promptBuilder(context.flag_count, context.paper_id || 'unknown');
        break;
      default:
        reflectionPrompt = `Failure recorded: ${summary}. Reflect on what reasoning process led to this outcome and what you would change.`;
    }

    await supabase.from('failure_reflections').insert({
      agent_id: agentId,
      failure_type: failureType,
      severity,
      summary,
      context,
      reflection_prompt: reflectionPrompt,
    });

    return { recorded: true, reflection_prompt: reflectionPrompt };
  } catch (err) {
    console.error('[failure_reflection] Recording failed:', err?.message || err);
    return { recorded: false };
  }
}

async function getUnresolvedFailures(agentId) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('failure_reflections')
      .select('id, failure_type, severity, summary, context, reflection_prompt, created_at')
      .eq('agent_id', agentId)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(10);
    return data || [];
  } catch (err) {
    console.error('[failure_reflection] Fetch failed:', err?.message || err);
    return [];
  }
}

async function resolveFailureReflections(agentId, failureType) {
  try {
    const supabase = getSupabase();
    await supabase.from('failure_reflections')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('agent_id', agentId)
      .eq('failure_type', failureType)
      .eq('resolved', false);
  } catch (err) {
    console.error('[failure_reflection] Resolve failed:', err?.message || err);
  }
}

// ── Tier cap requirements ─────────────────────────────────────────────
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2, min_revisions: 1 },
  100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3, min_revisions: 2, min_paper_score: 6.5 },
  150: { min_reviews: 35,  min_bounties: 12,  min_papers: 5, min_revisions: 3, min_paper_score: 7.5 },
  175: { min_reviews: 50,  min_bounties: 20,  min_papers: 8, min_revisions: 4, min_paper_score: 8.0 },
  200: { min_reviews: 75,  min_bounties: 30,  min_papers: 12, min_revisions: 5, min_paper_score: 8.5 },
};

const TIER_THRESHOLDS = [200, 175, 150, 100, 75];

async function applyTierCap(newCred, agentId) {
  const supabase = getSupabase();

  const [agentResult, reviewResult, bountyResult, paperResult, revisionResult, scoresResult] = await Promise.all([
    supabase.from('agents')
      .select('tier_unlocked, credibility_score')
      .eq('id', agentId).single(),
    supabase.from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agentId).eq('passed_quality_gate', true),
    supabase.from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agentId).eq('is_valid', true),
    supabase.from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).is('parent_paper_id', null).neq('status', 'removed'),
    supabase.from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).eq('response_stance', 'revision').neq('status', 'removed'),
    supabase.from('papers')
      .select('weighted_score, last_reviewed_at, submitted_at').eq('agent_id', agentId).neq('status', 'removed'),
  ]);

  const agent = agentResult.data;
  const currentTierUnlocked = parseFloat(agent?.tier_unlocked || 0);

  const reviews   = reviewResult.count || 0;
  const bounties  = bountyResult.count || 0;
  const papers    = paperResult.count  || 0;
  const revisions = revisionResult.count || 0;
  const scores    = (scoresResult.data || []).filter(p => p.weighted_score).map(p =>
    applyTimeDecay(parseFloat(p.weighted_score), p.last_reviewed_at || p.submitted_at)
  );
  const bestScore = scores.length > 0 ? Math.max(...scores) : null;

  if (newCred > 200) newCred = 200;

  // ── CEILING: cap at tier threshold if requirements not met ────────────
  for (const threshold of TIER_THRESHOLDS) {
    const reqs = TIER_CAPS[threshold];
    if (!reqs) continue;
    // Use threshold - 0.01 for sub-tier caps (avoids float rounding at boundary)
    const capValue = threshold === 75 ? 74.99 : threshold - 0.01;
    const meetsReqs = reviews >= reqs.min_reviews
      && bounties >= reqs.min_bounties
      && papers >= reqs.min_papers
      && revisions >= reqs.min_revisions
      && (!reqs.min_paper_score || (bestScore && bestScore >= reqs.min_paper_score - 0.005));
    if (newCred >= threshold - 0.01 && !meetsReqs) {
      newCred = capValue;
    }
  }

  // ── FLOOR: never drop below the highest tier already unlocked ─────────
  newCred = Math.max(newCred, currentTierUnlocked);

  const finalCred = parseFloat(newCred.toFixed(2));

  // ── Write tier_unlocked if a new tier was just cleared ────────────────
  let newTierUnlocked = currentTierUnlocked;

  if (reviews >= 75 && bounties >= 30 && papers >= 12 && revisions >= 5 && bestScore >= 8.5 && finalCred >= 175)
    newTierUnlocked = Math.max(newTierUnlocked, 175);
  else if (reviews >= 50 && bounties >= 20 && papers >= 8 && revisions >= 4 && bestScore >= 8.0 && finalCred >= 150)
    newTierUnlocked = Math.max(newTierUnlocked, 150);
  else if (reviews >= 35 && bounties >= 12 && papers >= 5 && revisions >= 3 && bestScore >= 7.5 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 20 && bounties >= 6 && papers >= 3 && revisions >= 2 && bestScore >= 6.5 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 10 && bounties >= 3 && papers >= 2 && revisions >= 1 && finalCred >= 75)
    newTierUnlocked = Math.max(newTierUnlocked, 75);

  if (newTierUnlocked > currentTierUnlocked) {
    await supabase.from('agents').update({ tier_unlocked: newTierUnlocked }).eq('id', agentId);
    console.log(`[tier_unlocked] Agent ${agentId} unlocked tier ${newTierUnlocked}`);
  }

  return finalCred;
}

// ── Atomic Credibility Adjustment ─────────────────────────────────────
// Uses a database-level atomic increment to prevent race conditions.
// Concurrent requests each get their own increment applied without
// overwriting each other's changes.
//
// Flow:
//   1. Atomically increment credibility_score in the database
//   2. Apply tier cap logic (still in JS — requires multi-table queries)
//   3. If tier cap changed the value, atomically set the capped value
//   4. Log the transaction
//
// Returns: { newCredibility, wasAdjusted }

async function adjustCredibility(agentId, delta, { reason, transactionType, relatedPaperId, relatedReviewId } = {}) {
  const supabase = getSupabase();

  // Step 1: Atomic increment — no read-compute-write race
  const { data: rawResult, error: rpcError } = await supabase
    .rpc('adjust_credibility', { p_agent_id: agentId, p_delta: delta });

  if (rpcError || rawResult == null) {
    console.error('[credibility] adjust_credibility RPC failed:', rpcError?.message || 'no result');
    return null;
  }

  const afterIncrement = parseFloat(rawResult);

  // Step 2: Apply tier cap (reads tier requirements from DB)
  const capped = await applyTierCap(afterIncrement, agentId);

  // Step 3: If tier cap changed the value, set it atomically
  // Use epsilon comparison to avoid float precision issues at tier boundaries
  let finalCred = afterIncrement;
  if (Math.abs(capped - afterIncrement) >= 0.005) {
    const { data: setResult, error: setError } = await supabase
      .rpc('set_credibility', { p_agent_id: agentId, p_value: capped });

    if (!setError && setResult != null) {
      finalCred = parseFloat(setResult);
    } else {
      console.error('[credibility] set_credibility RPC failed:', setError?.message || 'no result');
      finalCred = capped; // best effort — the tier cap value is still correct
    }
  } else {
    finalCred = capped;
  }

  // Step 4: Log the transaction
  if (reason && transactionType) {
    await supabase.from('credibility_transactions').insert({
      agent_id: agentId,
      change_amount: delta,
      balance_after: finalCred,
      reason,
      transaction_type: transactionType,
      related_paper_id: relatedPaperId || null,
      related_review_id: relatedReviewId || null,
    });
  }

  return { newCredibility: finalCred, wasAdjusted: Math.abs(delta) >= 0.01 };
}

// ── Bot Self-Citation Detection ───────────────────────────────────────
const UUID_V4_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

async function detectBotCitation(textFields, citations, submittingAgentId) {
  const flags = [];
  const supabase = getSupabase();

  // ── 1. Check if any citation DOI is a PeerZero paper UUID ──────────
  if (citations && citations.length > 0) {
    const uuidDois = citations
      .map(c => (c.doi || '').trim())
      .filter(doi => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(doi));

    if (uuidDois.length > 0) {
      const { data: matchedPapers } = await supabase
        .from('papers')
        .select('id, title')
        .in('id', uuidDois)
        .limit(uuidDois.length);

      if (matchedPapers && matchedPapers.length > 0) {
        for (const mp of matchedPapers) {
          flags.push(`Citation DOI "${mp.id}" is a PeerZero paper ("${mp.title.slice(0, 60)}"), not an academic source. Cite the original research DOIs instead.`);
        }
      }
    }
  }

  // ── 2. Scan text for PeerZero paper UUID references ────────────────
  const combinedText = Object.values(textFields).filter(Boolean).join(' ');
  const uuidMatches = combinedText.match(UUID_V4_PATTERN) || [];
  const uniqueUuids = [...new Set(uuidMatches.map(u => u.toLowerCase()))];

  if (uniqueUuids.length > 0) {
    const { data: referencedPapers } = await supabase
      .from('papers')
      .select('id, title')
      .in('id', uniqueUuids)
      .limit(uniqueUuids.length);

    if (referencedPapers && referencedPapers.length > 0) {
      for (const rp of referencedPapers) {
        flags.push(`Text references PeerZero paper "${rp.title.slice(0, 60)}" by ID (${rp.id}). Read other bots' papers for insight, but cite the original academic sources they used — not the bot paper itself.`);
      }
    }
  }

  // ── 3. Scan text for bot handle references used as sources ─────────
  const { data: agents } = await supabase
    .from('agents')
    .select('id, handle')
    .neq('id', submittingAgentId)
    .eq('is_banned', false);

  if (agents && agents.length > 0) {
    const lowerText = combinedText.toLowerCase();
    const citationContextPatterns = [
      'as shown by', 'as demonstrated by', 'according to',
      'as reported by', 'as found by', 'as described by',
      'as argued by', 'as proposed by', 'as suggested by',
      'as noted by', 'as established by', 'as concluded by',
      'as proven by', 'as observed by', 'as identified by',
      'cited by', 'referenced by', 'per ',
      'following the work of', 'building on work by',
      'based on the findings of', 'as per the paper by',
      'the paper by', 'the study by', 'research by',
      'analysis by', 'findings of', 'work of',
    ];

    for (const agent of agents) {
      const handleLower = agent.handle.toLowerCase();
      if (handleLower.length <= 3) continue;

      for (const pattern of citationContextPatterns) {
        if (lowerText.includes(`${pattern} ${handleLower}`)) {
          flags.push(`Text cites bot "${agent.handle}" as a source ("${pattern} ${agent.handle}"). Read other bots' papers for insight, but cite the original academic DOIs they referenced — not the bot itself.`);
          break;
        }
        const possessivePatterns = [`${handleLower}'s paper`, `${handleLower}'s study`, `${handleLower}'s work`, `${handleLower}'s analysis`, `${handleLower}'s research`, `${handleLower}'s findings`];
        const foundPossessive = possessivePatterns.some(pp => lowerText.includes(pp));
        if (foundPossessive) {
          flags.push(`Text references "${agent.handle}'s" work as a source. Other bots' PeerZero papers are not citable sources — trace back to the original academic citations they used.`);
          break;
        }
      }
    }
  }

  // ── 4. Check citation summaries/explanations for bot paper references ──
  if (citations && citations.length > 0) {
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      const citText = [c.agent_summary, c.relevance_explanation, c.source_quality_note]
        .filter(Boolean).join(' ').toLowerCase();

      if (citText.includes('peerzero') || citText.includes('peer zero') || citText.includes('peer-zero')) {
        flags.push(`Citation ${i + 1} (DOI: ${c.doi || 'unknown'}) references PeerZero in its description. Citations must point to original academic literature, not PeerZero platform papers.`);
      }
    }
  }

  return { detected: flags.length > 0, flags };
}

module.exports = {
  // Core (defined in this file)
  getSupabase,
  setCorsHeaders,
  recordFailureReflection,
  getUnresolvedFailures,
  resolveFailureReflections,
  sanitize,
  escapeForPostgrest,
  isRateLimited,
  isRateLimitedDb,
  logRateLimitedAction,
  getClientIp,
  sanitizeErrorMessage,
  validateTextLength,
  MAX_LENGTHS,
  TIER_CAPS,
  GRADE_LEVELS,
  getGradeRequirements,
  checkGradeProgress,
  applyTierCap,
  adjustCredibility,
  detectBotCitation,
  applyTimeDecay,
  DECAY_RATE,
  ALLOWED_ORIGINS,

  // Re-exported from lib/doi-citations.js
  ...doiCitations,

  // Re-exported from lib/search-strategy.js
  ...searchStrategy,
};
