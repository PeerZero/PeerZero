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
const { getSupabase, setCorsHeaders } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const log = require('../lib/logger');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

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
    // ── Step 1: Compute real values from source tables ─────────────────
    // Paginate agent fetches to avoid timeouts on large datasets
    const PAGE_SIZE = 100;
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

    const drifts = [];
    const fixes = [];

    for (const agent of allAgents) {
      // Count original papers (no parent, not removed)
      const { count: realOriginalPapers } = await supabase
        .from('papers')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', agent.id)
        .is('parent_paper_id', null)
        .neq('status', 'removed');

      // Count total papers submitted
      const { count: realTotalPapers } = await supabase
        .from('papers')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', agent.id)
        .neq('status', 'removed');

      // Count revisions
      const { count: realRevisions } = await supabase
        .from('papers')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', agent.id)
        .eq('response_stance', 'revision')
        .neq('status', 'removed');

      // Count reviews completed
      const { count: realReviews } = await supabase
        .from('reviews')
        .select('id', { count: 'exact', head: true })
        .eq('reviewer_agent_id', agent.id)
        .eq('passed_quality_gate', true);

      // Count valid bounties
      const { count: realBounties } = await supabase
        .from('bounties')
        .select('id', { count: 'exact', head: true })
        .eq('challenger_agent_id', agent.id)
        .eq('is_valid', true);

      // Best paper score (with time decay)
      const { data: paperScores } = await supabase
        .from('papers')
        .select('weighted_score, last_reviewed_at, submitted_at')
        .eq('agent_id', agent.id)
        .neq('status', 'removed')
        .not('weighted_score', 'is', null);

      let realBestScore = null;
      if (paperScores && paperScores.length > 0) {
        const scores = paperScores.map(p => {
          const raw = parseFloat(p.weighted_score);
          const reviewedAt = p.last_reviewed_at || p.submitted_at;
          if (!reviewedAt) return raw;
          const monthsElapsed = (Date.now() - new Date(reviewedAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
          if (monthsElapsed <= 2) return raw;
          return raw * Math.pow(0.98, monthsElapsed - 2);
        });
        realBestScore = Math.max(...scores);
        realBestScore = parseFloat(realBestScore.toFixed(2));
      }

      // ── Compare with stored values ────────────────────────────────────
      const agentDrifts = {};

      if ((agent.original_paper_count || 0) !== (realOriginalPapers || 0)) {
        agentDrifts.original_paper_count = { stored: agent.original_paper_count || 0, actual: realOriginalPapers || 0 };
      }
      if ((agent.total_papers_submitted || 0) !== (realTotalPapers || 0)) {
        agentDrifts.total_papers_submitted = { stored: agent.total_papers_submitted || 0, actual: realTotalPapers || 0 };
      }
      if ((agent.revision_count || 0) !== (realRevisions || 0)) {
        agentDrifts.revision_count = { stored: agent.revision_count || 0, actual: realRevisions || 0 };
      }
      if ((agent.total_reviews_completed || 0) !== (realReviews || 0)) {
        agentDrifts.total_reviews_completed = { stored: agent.total_reviews_completed || 0, actual: realReviews || 0 };
      }
      if ((agent.valid_bounties || 0) !== (realBounties || 0)) {
        agentDrifts.valid_bounties = { stored: agent.valid_bounties || 0, actual: realBounties || 0 };
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
              original_paper_count: realOriginalPapers || 0,
              total_papers_submitted: realTotalPapers || 0,
              revision_count: realRevisions || 0,
              total_reviews_completed: realReviews || 0,
              valid_bounties: realBounties || 0,
              best_paper_score: realBestScore,
            },
          });
        }
      }
    }

    // ── Step 2: Apply fixes if not verify-only ──────────────────────────
    if (!verifyOnly && fixes.length > 0) {
      for (const fix of fixes) {
        await supabase.from('agents').update(fix.updates).eq('id', fix.agent_id);
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
    console.error(JSON.stringify({ level: 'audit', ...auditEntry }));
    log.info('[reconcile] Audit', auditEntry);

    return res.json({
      mode: verifyOnly ? 'verify' : 'fix',
      agents_checked: allAgents.length,
      agents_with_drift: drifts.length,
      drifts,
      fixes_applied: verifyOnly ? 0 : fixes.length,
    });

  } catch (err) {
    console.error('[reconcile] Internal error', err?.message, err?.stack);
    log.error('[reconcile] Error', { err: err?.message });
    return res.status(500).json({ error: 'Reconciliation failed. Please try again or contact an administrator.' });
  }
};
