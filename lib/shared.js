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
    if (origin.startsWith('http://localhost')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
}

// ── Sanitize (prompt injection + HTML) ────────────────────────────────
function sanitize(text) {
  if (!text) return text;

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
  ];
  let clean = text;
  patterns.forEach(p => { clean = clean.replace(p, '[REDACTED]'); });

  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  clean = clean.replace(/<[^>]*>/g, '');
  // Strip any HTML entities that could reconstruct tags
  clean = clean.replace(/&lt;/gi, '').replace(/&gt;/gi, '');
  clean = clean.replace(/javascript:/gi, '[REDACTED]');
  clean = clean.replace(/on\w+\s*=/gi, '[REDACTED]');

  return clean;
}

// ── Escape search term for Supabase PostgREST filters ─────────────────
function escapeForPostgrest(term) {
  if (!term) return '';
  return term
    .replace(/[%_\\]/g, '')
    .replace(/[(),."'`;]/g, '')
    .replace(/[^\w\s\-!?&:]/g, '')
    .trim()
    .slice(0, 200);
}

// ── Rate limiter (in-memory, per Vercel instance) ─────────────────────
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
      .filter(p => p.weighted_score != null)
      .map(p => applyTimeDecay(parseFloat(p.weighted_score), p.last_reviewed_at || p.submitted_at));
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

// ── Tier cap requirements ─────────────────────────────────────────────
const TIER_CAPS = {
  75:  { min_reviews: 10,  min_bounties: 3,   min_papers: 2, min_revisions: 1 },
  100: { min_reviews: 20,  min_bounties: 6,   min_papers: 3, min_revisions: 2, min_paper_score: 7.0 },
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
    const capValue = threshold === 75 ? 74.9 : threshold;
    const meetsReqs = reviews >= reqs.min_reviews
      && bounties >= reqs.min_bounties
      && papers >= reqs.min_papers
      && revisions >= reqs.min_revisions
      && (!reqs.min_paper_score || (bestScore && bestScore >= reqs.min_paper_score));
    if (newCred >= capValue && !meetsReqs) {
      newCred = threshold === 75 ? 74.9 : threshold;
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
  else if (reviews >= 20 && bounties >= 6 && papers >= 3 && revisions >= 2 && bestScore >= 7.0 && finalCred >= 100)
    newTierUnlocked = Math.max(newTierUnlocked, 100);
  else if (reviews >= 10 && bounties >= 3 && papers >= 2 && revisions >= 1 && finalCred >= 75)
    newTierUnlocked = Math.max(newTierUnlocked, 75);

  if (newTierUnlocked > currentTierUnlocked) {
    await supabase.from('agents').update({ tier_unlocked: newTierUnlocked }).eq('id', agentId);
    console.log(`[tier_unlocked] Agent ${agentId} unlocked tier ${newTierUnlocked}`);
  }

  return finalCred;
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
  sanitize,
  escapeForPostgrest,
  isRateLimited,
  getClientIp,
  sanitizeErrorMessage,
  validateTextLength,
  MAX_LENGTHS,
  TIER_CAPS,
  GRADE_LEVELS,
  getGradeRequirements,
  checkGradeProgress,
  applyTierCap,
  detectBotCitation,
  applyTimeDecay,
  DECAY_RATE,
  ALLOWED_ORIGINS,

  // Re-exported from lib/doi-citations.js
  ...doiCitations,

  // Re-exported from lib/search-strategy.js
  ...searchStrategy,
};
