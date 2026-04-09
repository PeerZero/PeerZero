// =============================================================================
// Reconciliation endpoint — verifies and fixes denormalized agent counters
//
// GET  /api/reconcile?verify=true   → shows drift without fixing (dry run)
// POST /api/reconcile               → fixes all drifted counters
//
// Protected by admin secret (X-Admin-Key header).
// Designed to be called by a cron job (daily) or manually for debugging.
// =============================================================================

const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, isRateLimited } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const log = require('../lib/logger');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // SECURITY: Rate limit admin endpoint to prevent brute-force on admin key
  // 10 attempts per hour per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(`admin:${ip}`, 10, 3600000)) {
    log.warn('[reconcile] Rate limited admin request', { ip });
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }

  // SECURITY: CSRF protection for state-changing requests (defense-in-depth; admin key also required)
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  // Admin-only: require a secret key to prevent public access
  // Uses constant-time comparison to prevent timing attacks
  const adminKey = req.headers['x-admin-key'];
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminKey || typeof adminKey !== 'string'
      || !adminSecret || typeof adminSecret !== 'string'
      || adminKey.length !== adminSecret.length
      || !crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(adminSecret))) {
    return res.status(401).json({ error: 'Unauthorized — X-Admin-Key required' });
  }

  const verifyOnly = req.method === 'GET' || req.query.verify === 'true';

  try {
    // ── Step 1: Fetch all agents (paginated) ──────────────────────────
    const PAGE_SIZE = 1000;
    let allAgents = [];
    let offset = 0;
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from('agents')
        .select('id, total_papers_submitted, total_reviews_completed, best_paper_score, original_paper_count, revision_count, valid_bounties')
        .eq('is_banned', false)
        .range(offset, offset + PAGE_SIZE - 1);

      if (pageErr) return res.status(500).json({ error: 'Failed to fetch agents' });
      if (!page || page.length === 0) break;
      allAgents = allAgents.concat(page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (allAgents.length === 0) return res.json({ message: 'No agents to reconcile', drifts: [] });

    // ── Step 2: Bulk-fetch all counts in parallel (7 queries total) ───
    // Instead of 7 queries PER agent (O(N²)), we run 7 queries TOTAL
    // and join the results in memory. Each query fetches grouped counts
    // for ALL agents at once.

    // Helper: paginate a full-table fetch to avoid PostgREST row limits
    async function fetchAll(table, selectStr, filters) {
      let all = [];
      let off = 0;
      while (true) {
        let q = supabase.from(table).select(selectStr).range(off, off + PAGE_SIZE - 1);
        if (filters) q = filters(q);
        const { data, error } = await q;
        if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < PAGE_SIZE) break;
        off += PAGE_SIZE;
      }
      return all;
    }

    // Helper: build a Map<agent_id, count> from rows with an id column
    function buildCountMap(rows, idCol) {
      const map = new Map();
      for (const row of rows) {
        const id = row[idCol];
        map.set(id, (map.get(id) || 0) + 1);
      }
      return map;
    }

    // Fire all 7 bulk queries in parallel
    const [
      originalPaperRows,
      totalPaperRows,
      revisionRows,
      reviewRows,
      bountyRows,
      scoredPaperRows,
    ] = await Promise.all([
      // 1. Original papers (no parent, not removed) — fetch agent_id for counting
      fetchAll('papers', 'agent_id', q =>
        q.is('parent_paper_id', null).neq('status', 'removed')),

      // 2. Total papers (not removed)
      fetchAll('papers', 'agent_id', q =>
        q.neq('status', 'removed')),

      // 3. Revisions (response_stance = 'revision', not removed)
      fetchAll('papers', 'agent_id', q =>
        q.eq('response_stance', 'revision').neq('status', 'removed')),

      // 4. Reviews completed (passed quality gate)
      fetchAll('reviews', 'reviewer_agent_id', q =>
        q.eq('passed_quality_gate', true)),

      // 5. Valid bounties
      fetchAll('bounties', 'challenger_agent_id', q =>
        q.eq('is_valid', true)),

      // 6. Paper scores for best_paper_score with time decay
      fetchAll('papers', 'agent_id, weighted_score, last_reviewed_at, submitted_at', q =>
        q.neq('status', 'removed').not('weighted_score', 'is', null)),
    ]);

    // Build count maps
    const originalPaperCounts = buildCountMap(originalPaperRows, 'agent_id');
    const totalPaperCounts = buildCountMap(totalPaperRows, 'agent_id');
    const revisionCounts = buildCountMap(revisionRows, 'agent_id');
    const reviewCounts = buildCountMap(reviewRows, 'reviewer_agent_id');
    const bountyCounts = buildCountMap(bountyRows, 'challenger_agent_id');

    // Build best-score map (with time decay, matching original logic exactly)
    const bestScoreMap = new Map();
    for (const p of scoredPaperRows) {
      const raw = parseFloat(p.weighted_score);
      const reviewedAt = p.last_reviewed_at || p.submitted_at;
      let decayed = raw;
      if (reviewedAt) {
        const monthsElapsed = (Date.now() - new Date(reviewedAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (monthsElapsed > 2) {
          decayed = raw * Math.pow(0.98, monthsElapsed - 2);
        }
      }
      const prev = bestScoreMap.get(p.agent_id);
      if (prev === undefined || decayed > prev) {
        bestScoreMap.set(p.agent_id, decayed);
      }
    }

    // ── Step 3: Compare stored vs. computed for each agent ────────────
    const drifts = [];
    const fixes = [];

    for (const agent of allAgents) {
      const realOriginalPapers = originalPaperCounts.get(agent.id) || 0;
      const realTotalPapers = totalPaperCounts.get(agent.id) || 0;
      const realRevisions = revisionCounts.get(agent.id) || 0;
      const realReviews = reviewCounts.get(agent.id) || 0;
      const realBounties = bountyCounts.get(agent.id) || 0;

      let realBestScore = null;
      const rawBest = bestScoreMap.get(agent.id);
      if (rawBest !== undefined) {
        realBestScore = parseFloat(rawBest.toFixed(2));
      }

      // ── Compare with stored values ────────────────────────────────────
      const agentDrifts = {};

      if ((agent.original_paper_count || 0) !== realOriginalPapers) {
        agentDrifts.original_paper_count = { stored: agent.original_paper_count || 0, actual: realOriginalPapers };
      }
      if ((agent.total_papers_submitted || 0) !== realTotalPapers) {
        agentDrifts.total_papers_submitted = { stored: agent.total_papers_submitted || 0, actual: realTotalPapers };
      }
      if ((agent.revision_count || 0) !== realRevisions) {
        agentDrifts.revision_count = { stored: agent.revision_count || 0, actual: realRevisions };
      }
      if ((agent.total_reviews_completed || 0) !== realReviews) {
        agentDrifts.total_reviews_completed = { stored: agent.total_reviews_completed || 0, actual: realReviews };
      }
      if ((agent.valid_bounties || 0) !== realBounties) {
        agentDrifts.valid_bounties = { stored: agent.valid_bounties || 0, actual: realBounties };
      }

      // best_paper_score: allow 0.1 tolerance for floating point / decay differences
      const storedBest = agent.best_paper_score ? parseFloat(agent.best_paper_score) : null;
      if (storedBest !== realBestScore) {
        const diff = Math.abs((storedBest || 0) - (realBestScore || 0));
        if (diff > 0.1) {
          agentDrifts.best_paper_score = { stored: storedBest, actual: realBestScore };
        }
      }

      if (Object.keys(agentDrifts).length > 0) {
        drifts.push({ agent_id: agent.id, drifts: agentDrifts });

        if (!verifyOnly) {
          fixes.push({
            agent_id: agent.id,
            updates: {
              original_paper_count: realOriginalPapers,
              total_papers_submitted: realTotalPapers,
              revision_count: realRevisions,
              total_reviews_completed: realReviews,
              valid_bounties: realBounties,
              best_paper_score: realBestScore,
            },
          });
        }
      }
    }

    // ── Step 4: Apply fixes if not verify-only ──────────────────────────
    // Batch updates in parallel (chunks of 50 to avoid connection pressure)
    if (!verifyOnly && fixes.length > 0) {
      const UPDATE_BATCH = 50;
      for (let i = 0; i < fixes.length; i += UPDATE_BATCH) {
        const batch = fixes.slice(i, i + UPDATE_BATCH);
        await Promise.all(
          batch.map(fix => supabase.from('agents').update(fix.updates).eq('id', fix.agent_id))
        );
      }
      log.info('[reconcile] Fixed agents with drifted counters', { count: fixes.length });
    }

    // ── Audit log: record successful reconciliation with timestamp ──
    const auditEntry = {
      timestamp: new Date().toISOString(),
      action: verifyOnly ? 'reconcile:verify' : 'reconcile:fix',
      agents_checked: allAgents.length,
      agents_with_drift: drifts.length,
      fixes_applied: verifyOnly ? 0 : fixes.length,
    };
    log.info('[reconcile] Audit', auditEntry);

    return res.json({
      mode: verifyOnly ? 'verify' : 'fix',
      agents_checked: allAgents.length,
      agents_with_drift: drifts.length,
      drifts,
      fixes_applied: verifyOnly ? 0 : fixes.length,
    });

  } catch (err) {
    log.error('[reconcile] Internal error', { err: err?.message, stack: err?.stack });
    return res.status(500).json({ error: 'Reconciliation failed. Please try again or contact an administrator.' });
  }
};
