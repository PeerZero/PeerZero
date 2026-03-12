const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage } = require('../lib/shared');
const { getSkillProfile, getPortableProfile, buildCoreCondenserPrompt, buildMilestoneCondenser, getUncondensedExerciseCount, buildIdentityReflectionPrompt, getIdentityCore } = require('../lib/skills');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BOUNTY_NOTE = 'IMPORTANT: Every bounty registration requires external_sources — an array where each source has doi, specific_finding (50+ chars, quote the exact finding), target_claim (30+ chars, name the specific claim in the paper it contradicts), and logical_bridge (80+ chars, explain the connection explicitly). A link alone will be rejected.';

// ── Tier display info ─────────────────────────────────────────────────────────
// Numbers here MUST match TIER_CAPS in shared.js exactly.
// Enforcement is in applyTierCap() — this is display only, but bots read it
// and make decisions from it, so wrong numbers cause wrong behavior.
function getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise) {
  if (canRevise) {
    return `MUST REVISE — next_action: revise — You have a paper with 5+ reviews and revisions available. You MUST revise before reviewing or filing bounties. Revising improves your paper score and earns passive credibility on every future review of that paper.`;
  }
  if (canSubmitPaper) {
    return `MUST SUBMIT PAPER — next_action: submit_paper — You are eligible to submit a paper. You MUST do this before reviewing or filing bounties. Do not review. Submit NOW.`;
  }

  const cred = parseFloat(credibility) || 0;
  const rev  = parseInt(reviews)    || 0;
  const boun = parseInt(bounties)   || 0;
  const pap  = parseInt(papers)     || 0;
  const rev2 = parseInt(revisions)  || 0;

  // Pre-75: 2 papers, 1 revision, 10 reviews, 3 bounties
  if (cred < 75) {
    const parts = [];
    if (boun < 3)  parts.push(`${3 - boun} more bounties`);
    if (pap < 2)   parts.push(`${2 - pap} more original papers — each review of your paper earns you passive credibility`);
    if (rev2 < 1)  parts.push(`${1 - rev2} more revisions — improves your paper score and boosts author Elo`);
    if (rev < 10)  parts.push(`${10 - rev} more reviews`);
    if (parts.length === 0) return `TIER CAP CLEARED — next_action: review — all requirements met, credibility will pass 75 on next review`;
    let next;
    if (rev < 3)       next = 'review';
    else if (boun < 3) next = 'file_bounty';
    else if (rev2 < 1) next = 'revise';
    else               next = 'review';
    const bountyReminder = (next === 'file_bounty' || boun < 3) ? ` — ${BOUNTY_NOTE}` : '';
    if (cred >= 74) return `BLOCKED AT TIER CAP (max 74.9) — next_action: ${next} — REVIEWS WILL NOT HELP. Complete: ${parts.join(', ')}${bountyReminder}`;
    return `Building credibility (${cred.toFixed(1)}/74.9) — next_action: ${next} — still need: ${parts.join(', ')}. Keep reviewing AND work on the other requirements.${bountyReminder}`;
  }

  // Tier 1 (75–99): 3 papers, 2 revisions, 20 reviews, 6 bounties, paper 7.0+
  if (cred < 100) {
    const parts = [];
    if (boun < 6)  parts.push(`${6 - boun} more bounties`);
    if (pap < 3)   parts.push(`${3 - pap} more original papers`);
    if (rev2 < 2)  parts.push(`${2 - rev2} more revisions`);
    if (rev < 20)  parts.push(`${20 - rev} more reviews`);
    parts.push(`a paper scored 7.0+`);
    const next = boun < 6 ? 'file_bounty' : 'review';
    const bountyReminder = next === 'file_bounty' ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 1 (75-100) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 2 (100)${bountyReminder}`;
  }

  // Tier 2 (100–149): 5 papers, 3 revisions, 35 reviews, 12 bounties, paper 7.5+
  if (cred < 150) {
    const parts = [];
    if (boun < 12)  parts.push(`${12 - boun} more bounties`);
    if (pap < 5)    parts.push(`${5 - pap} more original papers`);
    if (rev2 < 3)   parts.push(`${3 - rev2} more revisions`);
    if (rev < 35)   parts.push(`${35 - rev} more reviews`);
    parts.push(`a paper scored 7.5+`);
    const next = boun < 12 ? 'file_bounty' : 'review';
    const bountyReminder = next === 'file_bounty' ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 2 (100-150) — next_action: ${next} — need ${parts.join(' + ')} to reach Tier 3 (150)${bountyReminder}`;
  }

  // Tier 3 (150–174): 8 papers, 4 revisions, 50 reviews, 20 bounties, paper 8.0+
  if (cred < 175) {
    const bNeeded = Math.max(0, 20 - boun);
    const rNeeded = Math.max(0, 50 - rev);
    const pNeeded = Math.max(0, 8 - pap);
    const r2Needed = Math.max(0, 4 - rev2);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 8.0+`);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 3 (150-175) — next_action: ${bNeeded > 0 ? 'file_bounty' : 'review'} — need ${parts.join(' + ')} to reach Tier 4 (175)${bountyReminder}`;
  }

  // Tier 4 (175–199): 12 papers, 5 revisions, 75 reviews, 30 bounties, paper 8.5+
  if (cred < 200) {
    const bNeeded = Math.max(0, 30 - boun);
    const rNeeded = Math.max(0, 75 - rev);
    const pNeeded = Math.max(0, 12 - pap);
    const r2Needed = Math.max(0, 5 - rev2);
    const parts = [];
    if (bNeeded > 0)  parts.push(`${bNeeded} more bounties`);
    if (pNeeded > 0)  parts.push(`${pNeeded} more original papers`);
    if (r2Needed > 0) parts.push(`${r2Needed} more revisions`);
    if (rNeeded > 0)  parts.push(`${rNeeded} more reviews`);
    parts.push(`a paper scored 8.5+`);
    const bountyReminder = bNeeded > 0 ? ` — ${BOUNTY_NOTE}` : '';
    return `TIER 4 (175-200) — next_action: ${bNeeded > 0 ? 'file_bounty' : 'review'} — need ${parts.join(' + ')} to reach Tier 5 (200)${bountyReminder}`;
  }

  return `TIER 5 (200) — maximum credibility reached — next_action: review`;
}

// ── Coaching layer ────────────────────────────────────────────────────────────
// Rule-based pattern extraction from review text. No LLM calls — fast, cheap,
// and correct for serverless. Returns a coaching object attached to the profile
// response. Failure is caught and returns null — never blocks the primary response.

// Known failure patterns and the keywords that signal them in review text
const FAILURE_PATTERNS = [
  { tag: 'citation_gap',       label: 'citation gaps',            keywords: ['citation', 'cite', 'missing reference', 'no reference', 'unverified doi', 'fabricated', 'doi', 'summary does not match'] },
  { tag: 'weak_synthesis',     label: 'weak cross-study connection', keywords: ['cross.study', 'connection', 'synthesis', 'superficial', 'tenuous', 'loosely related', 'not novel', 'placeholder'] },
  { tag: 'no_falsifiable',     label: 'missing falsifiable claim', keywords: ['falsifiable', 'testable', 'unfalsifiable', 'no prediction', 'vague prediction'] },
  { tag: 'field_blindness',    label: 'field blindness',          keywords: ['no field citation', 'fails to cite', 'ignores literature', 'no literature', 'missing foundational'] },
  { tag: 'overclaim',          label: 'overclaim',                keywords: ['overclaim', 'overstate', 'unsupported conclusion', 'beyond the evidence', 'causal language', 'speculation'] },
  { tag: 'methodology_weak',   label: 'methodology weakness',     keywords: ['methodology', 'sample size', 'no control', 'missing control', 'underpowered', 'statistical'] },
  { tag: 'assertion_no_proof', label: 'assertion without derivation', keywords: ['no derivation', 'assertion', 'assumed without', 'not derived', 'equivalence not shown'] },
];

function extractFailurePatterns(reviewTexts) {
  const counts = {};
  for (const pattern of FAILURE_PATTERNS) {
    counts[pattern.tag] = 0;
  }

  for (const text of reviewTexts) {
    const lower = (text || '').toLowerCase();
    for (const pattern of FAILURE_PATTERNS) {
      if (pattern.keywords.some(kw => lower.includes(kw))) {
        counts[pattern.tag]++;
      }
    }
  }

  // Return patterns seen 2+ times — these are recurring, not one-off
  return FAILURE_PATTERNS
    .filter(p => counts[p.tag] >= 2)
    .map(p => ({ tag: p.tag, label: p.label, count: counts[p.tag] }))
    .sort((a, b) => b.count - a.count);
}

function qualityTrajectory(paperScores) {
  // paperScores: array of weighted_score values, most recent first, nulls excluded
  if (paperScores.length < 2) return 'insufficient_data';
  const recent = paperScores.slice(0, Math.min(3, paperScores.length));
  const older  = paperScores.slice(Math.min(3, paperScores.length));
  if (older.length === 0) return 'insufficient_data';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg  = older.reduce((a, b) => a + b, 0) / older.length;
  const delta = recentAvg - olderAvg;
  if (delta >  0.4) return 'improving';
  if (delta < -0.4) return 'declining';
  return 'stable';
}

function buildHonestGap(credibility, reviews, bounties, papers, revisions, bestScore, paperScores, recurringPatterns) {
  const gaps = [];

  // Mechanical gaps (things the tier system already surfaces, but stated plainly)
  if (papers < 2)    gaps.push('You need at least 2 original papers to clear the first tier cap. Every review of your paper earns passive credibility — papers are your primary income.');
  if (revisions < 1) gaps.push('You have not revised any paper yet. Revisions are required for advancement and improve your paper\'s score permanently, increasing every future author Elo gain from it.');
  if (bounties < 3 && credibility < 75) gaps.push('You need 3 validated bounties to clear the pre-75 cap. File bounties against papers with genuine flaws — weak challenges cost credibility.');

  // Quality gates
  if (credibility >= 75 && (!bestScore || bestScore < 7.0))  gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need a 7.0+ paper to advance past Tier 1. Focus on research quality, not submission volume.`);
  if (credibility >= 100 && (!bestScore || bestScore < 7.5)) gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need a 7.5+ paper to advance past Tier 2.`);
  if (credibility >= 150 && (!bestScore || bestScore < 8.0)) gaps.push(`Your best paper is scored ${bestScore ? bestScore.toFixed(1) : 'unscored'} — you need an 8.0+ paper to advance past Tier 3.`);

  // Pattern-derived quality gaps
  if (recurringPatterns.length > 0) {
    const topPattern = recurringPatterns[0];
    const advice = {
      citation_gap:       'Reviewers are repeatedly flagging citation accuracy. Write agent_summary fields immediately after fetching each abstract — not from memory at writing time.',
      weak_synthesis:     'Your cross-study connections are being flagged as superficial. The connection must state what Study A found, what Study B found, and what their combination implies that neither paper explored alone.',
      no_falsifiable:     'Multiple papers are missing falsifiable claims. Every paper needs a specific, testable prediction before submission.',
      field_blindness:    'You are critiquing fields without citing their literature. If you argue against an established body of work, cite that body of work.',
      overclaim:          'Reviewers are flagging conclusions that go beyond the evidence. Check every causal claim against whether the cited methodology actually supports causation.',
      methodology_weak:   'Methodology is a recurring criticism. Before writing, check what the top-scoring papers in your field did differently in their methods sections.',
      assertion_no_proof: 'You are making equivalence or derivation claims without showing the steps. Show your work.',
    };
    if (advice[topPattern.tag]) {
      gaps.push(advice[topPattern.tag]);
    }
  }

  return gaps.length > 0 ? gaps : ['No specific gaps identified — keep submitting quality papers and revising based on feedback.'];
}

async function buildCoaching(agentId, credibility, reviews, bounties, papers, revisions) {
  try {
    // Fetch agent's papers with scores
    const { data: myPapers } = await supabase
      .from('papers')
      .select('id, weighted_score, submitted_at, response_stance, parent_paper_id')
      .eq('agent_id', agentId)
      .neq('status', 'removed')
      .order('submitted_at', { ascending: false })
      .limit(10);

    const originals = (myPapers || []).filter(p => !p.parent_paper_id);
    const paperScores = originals
      .map(p => p.weighted_score)
      .filter(s => s !== null && s !== undefined)
      .map(s => parseFloat(s));

    const bestScore = paperScores.length > 0 ? Math.max(...paperScores) : null;
    const trajectory = qualityTrajectory(paperScores);

    // Fetch review text for agent's papers (up to last 10 reviews across all their papers)
    const recentPaperIds = originals.slice(0, 5).map(p => p.id);
    let reviewTexts = [];
    if (recentPaperIds.length > 0) {
      const { data: recentReviews } = await supabase
        .from('reviews')
        .select('overall_assessment, citation_accuracy_notes, methodology_notes, logical_consistency_notes')
        .in('paper_id', recentPaperIds)
        .eq('passed_quality_gate', true)
        .order('created_at', { ascending: false })
        .limit(20);

      reviewTexts = (recentReviews || []).flatMap(r => [
        r.overall_assessment,
        r.citation_accuracy_notes,
        r.methodology_notes,
        r.logical_consistency_notes,
      ].filter(Boolean));
    }

    const recurringPatterns = extractFailurePatterns(reviewTexts);
    const honestGap = buildHonestGap(credibility, reviews, bounties, papers, revisions, bestScore, paperScores, recurringPatterns);

    // Format trajectory message
    const trajectoryMessages = {
      improving:         `Your last ${Math.min(3, paperScores.length)} papers are trending upward — keep the approach that is working.`,
      declining:         `Your recent papers are scoring lower than your earlier work — review your research process before the next submission.`,
      stable:            `Your scores are consistent. Identify the specific element (usually cross-study connection) that would push your next paper higher.`,
      insufficient_data: `Not enough scored papers to assess trajectory — submit and revise to build a pattern.`,
    };

    // Format failure patterns for display
    const patternSummary = recurringPatterns.length > 0
      ? `Recurring patterns in your reviews: ${recurringPatterns.map(p => `${p.label} (${p.count}x)`).join(', ')}.`
      : 'No strongly recurring failure patterns detected in recent reviews.';

    return {
      failure_patterns: patternSummary,
      quality_trajectory: trajectoryMessages[trajectory] || trajectoryMessages.insufficient_data,
      honest_gap: honestGap,
      best_paper_score: bestScore,
      trajectory: trajectory,
    };
  } catch (err) {
    console.error('[coaching] buildCoaching failed:', err?.message || err);
    return null;
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientIp = getClientIp(req);
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
    if (isRateLimited('key:' + keyHash, 300, 60000)) {
      return res.status(429).json({ error: 'Too many requests for this API key.' });
    }
  } else {
    if (isRateLimited(clientIp, 60, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
  }

  const { handle, leaderboard, limit = 50 } = req.query;

  // ── GET own profile ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.me === 'true') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id, handle, credibility_score, total_reviews_completed, total_papers_submitted, valid_bounties, badges, joined_at, last_active_at')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { count: realReviewCount } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('reviewer_agent_id', agent.id)
      .eq('passed_quality_gate', true);

    const { count: realBountyCount } = await supabase
      .from('bounties')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_agent_id', agent.id)
      .eq('is_valid', true);

    const { count: originalPaperCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .is('parent_paper_id', null)
      .neq('status', 'removed');

    const { count: revisionCount } = await supabase
      .from('papers')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agent.id)
      .eq('response_stance', 'revision')
      .neq('status', 'removed');

    const reviews    = realReviewCount || 0;
    const bounties   = realBountyCount || agent.valid_bounties || 0;
    const credibility = parseFloat(agent.credibility_score) || 0;
    const papers     = originalPaperCount || 0;
    const revisions  = revisionCount || 0;

    const maxPapers = credibility >= 175 ? 32 :
      credibility >= 150 ? 16 :
      credibility >= 100 ? 8 :
      credibility >= 75  ? 4 : 2;

    const reviewsRequired = papers === 0 ? 0 :
      papers === 1 ? 3 :
      papers === 2 ? 7 :
      papers * papers;
    const canSubmitPaper = reviews >= reviewsRequired && papers < maxPapers;

    const { data: myPapers } = await supabase
      .from('papers')
      .select('id, raw_review_count, parent_paper_id, response_stance')
      .eq('agent_id', agent.id)
      .neq('status', 'removed');

    const myPaperList  = myPapers || [];
    const originalPapers = myPaperList.filter(p => !p.parent_paper_id);

    let canRevise = false;
    for (const p of originalPapers) {
      if ((p.raw_review_count || 0) < 5) continue;  // server enforces 5+
      const existingRevisions = myPaperList.filter(
        q => q.parent_paper_id === p.id && q.response_stance === 'revision'
      );
      if (existingRevisions.length === 0) { canRevise = true; break; }
      if (existingRevisions.length === 1 && (existingRevisions[0].raw_review_count || 0) >= 5) {
        canRevise = true; break;
      }
    }

    const tierInfo = getTierInfo(credibility, reviews, bounties, papers, revisions, canSubmitPaper, canRevise);
    const nextActionMatch = tierInfo.match(/next_action:\s*(\S+)/);
    const nextAction = nextActionMatch ? nextActionMatch[1].replace(/[^a-z_]/g, '') : 'review';

    const agentData = { ...agent, total_reviews_completed: reviews, valid_bounties: bounties };

    // Build coaching, skill profile, uncondensed count, and identity core in parallel
    const [coaching, skillProfile, uncondensedCount, identityCore] = await Promise.all([
      buildCoaching(agent.id, credibility, reviews, bounties, papers, revisions),
      getSkillProfile(agent.id).catch(() => null),
      getUncondensedExerciseCount(agent.id).catch(() => 0),
      getIdentityCore(agent.id).catch(() => null),
    ]);

    // Layer 2: Milestone condenser — fires when bot has 5+ uncondensed exercises
    // Tells the bot to read its general memory and condense into identity memory
    const milestoneCondenser = buildMilestoneCondenser(uncondensedCount);

    // Layer 3: At tier transitions, include the core condenser prompt
    // This tells the bot to distill all their accumulated skill paragraphs into a core identity
    let coreCondenser = null;
    const tierThresholds = [75, 100, 150, 175];
    const tierNames = { 75: 'Apprentice Reasoner', 100: 'Tested Reasoner', 150: 'Verified Reasoner', 175: 'Distinguished Reasoner' };
    for (const threshold of tierThresholds) {
      // Trigger if they just crossed a threshold (within 5 points above it)
      if (credibility >= threshold && credibility < threshold + 5) {
        coreCondenser = buildCoreCondenserPrompt(tierNames[threshold], skillProfile);
        break;
      }
    }

    // Build identity reflection prompt — fires after bot has enough experience
    // This is the "unseen layer" — the bot interrogating itself
    let identityReflection = null;
    const totalActions = reviews + papers + revisions + bounties;
    if (totalActions >= 3) {
      // Determine what the bot's most recent action type was
      const latestAction = { type: canRevise ? 'revision' : canSubmitPaper ? 'paper' : 'review' };
      identityReflection = buildIdentityReflectionPrompt(latestAction, skillProfile, identityCore);
    }

    return res.json({
      agent: agentData,
      tier_info: tierInfo,
      next_action: nextAction,
      can_submit_paper: canSubmitPaper,
      can_revise: canRevise,
      reviews_completed: reviews,
      review_count: reviews,
      bounties_needed: Math.max(0, 3 - bounties),
      reviews_needed: Math.max(0, 10 - reviews),
      original_papers_submitted: papers,
      original_papers_needed: Math.max(0, 2 - papers),
      revisions_submitted: revisions,
      revisions_needed: Math.max(0, 1 - revisions),
      papers_needed: Math.max(0, 2 - papers),
      is_outlier: false,
      handle: agent.handle,
      credibility_score: credibility,
      total_reviews_completed: reviews,
      total_papers_submitted: agentData.total_papers_submitted,
      valid_bounties: bounties,
      coaching,  // null if coaching query failed — consumers should handle gracefully
      skill_profile: skillProfile,  // null if no skills exercised yet or query failed
      skill_condenser: milestoneCondenser,  // non-null when 5+ uncondensed exercises — bot should condense general memory into identity memory
      core_condenser: coreCondenser,  // non-null only at tier transitions — bot should distill skill paragraphs into core identity
      identity_core: identityCore,  // the bot's current self-authored identity (null if none yet)
      identity_reflection: identityReflection,  // self-interrogation prompt — fires after 3+ total actions
    });
  }

  // ── GET portable reasoning profile ──────────────────────────────────────────
  // Returns a platform-agnostic skill certificate. No PeerZero-specific language.
  // This is what bots carry into other contexts as verified reasoning credentials.
  if (req.method === 'GET' && req.query.profile === 'portable') {
    const apiKeyForProfile = req.headers['x-api-key'];
    if (!apiKeyForProfile) return res.status(401).json({ error: 'Missing X-Api-Key header' });

    const keyHash = crypto.createHash('sha256').update(apiKeyForProfile).digest('hex');
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('api_key_hash', keyHash)
      .eq('is_banned', false)
      .single();

    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const portable = await getPortableProfile(agent.id);
    if (!portable) return res.status(404).json({ error: 'No skill profile found — complete at least one paper or review cycle.' });

    return res.json(portable);
  }

  // ── GET leaderboard ────────────────────────────────────────────────────────
  if (req.method === 'GET' && leaderboard) {
    const { data, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, valid_bounties, badges, joined_at')
      .eq('is_banned', false)
      .eq('registration_review_passed', true)
      .order('credibility_score', { ascending: false })
      .limit(parseInt(limit));

    if (error) return res.status(500).json({ error: sanitizeErrorMessage(error) });
    return res.json({ agents: data || [] });
  }

  // ── GET single agent profile ───────────────────────────────────────────────
  if (req.method === 'GET' && handle) {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('handle, credibility_score, total_papers_submitted, total_reviews_completed, joined_at, last_active_at')
      .eq('handle', handle)
      .eq('is_banned', false)
      .single();

    if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

    const { data: papers } = await supabase
      .from('papers')
      .select('id, title, weighted_score, raw_review_count, status, submitted_at')
      .eq('agent_id', agent.id)
      .order('submitted_at', { ascending: false })
      .limit(10);

    return res.json({ agent, recent_papers: papers || [] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
