// =============================================================================
// Admin endpoint — reconciliation, health, meta-forge aggregation
//
// Health (NO auth required — must be callable by uptime monitors):
//   GET  /api/reconcile?action=health            → Supabase connectivity check
//
// Reconciliation:
//   GET  /api/reconcile?verify=true   → shows drift without fixing (dry run)
//   POST /api/reconcile               → fixes all drifted counters
//
// Forge aggregation (action= param):
//   POST /api/reconcile?action=forge_aggregate       → trigger aggregation run
//   GET  /api/reconcile?action=forge_runs             → list runs
//   GET  /api/reconcile?action=forge_run&run_id=X     → get run + proposals
//   POST /api/reconcile?action=forge_review           → approve/reject proposal
//   POST /api/reconcile?action=forge_rollback         → rollback applied change
//   GET  /api/reconcile?action=forge_history           → config evolution history
//   GET  /api/reconcile?action=forge_inherited         → preview inherited context
//   POST /api/reconcile?action=forge_extract_frames    → run meta-condenser
//
// Data retention:
//   POST /api/reconcile?action=purge_retention         → purge old audit rows (180d default)
//
// Data integrity:
//   GET  /api/reconcile?action=check_weighted_scores         → verify paper scores match reviews
//   GET  /api/reconcile?action=check_calibration_staleness   → find stale calibration summaries
//   POST /api/reconcile?action=check_calibration_staleness   → find + auto-refresh stale summaries
//   GET  /api/reconcile?action=check_skill_integrity         → verify skill profile invariants
//   POST /api/reconcile?action=check_skill_integrity         → verify + auto-fix skill invariants
//   GET  /api/reconcile?action=check_credibility_integrity   → verify credibility_score matches transactions
//   GET  /api/reconcile?action=check_orphans                 → find orphaned records (removed papers)
//   POST /api/reconcile?action=cleanup_orphans               → delete orphaned reviews/bounties/citations
//
// Protected by admin secret (X-Admin-Key header), except health check.
// Designed to be called by a cron job (daily) or manually for debugging.
// =============================================================================

const crypto = require('crypto');
const { getSupabase, setCorsHeaders, isCsrfRejected, isRateLimited, sanitizeErrorMessage } = require('../lib/shared');
const { checkMockGuard } = require('../lib/mock-guard');
const log = require('../lib/logger');
const {
  runAggregation,
  listRuns,
  getRunProposals,
  reviewProposal,
  rollbackProposal,
  getHistory,
  buildInheritedContext,
  extractInheritedFrames,
} = require('../lib/forge-aggregation');

const supabase = getSupabase();

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Health check (NO auth — callable by uptime monitors) ────────────
  if (req.query.action === 'health' && req.method === 'GET') {
    const checks = { database: 'unknown' };
    let healthy = true;
    try {
      const { error } = await supabase
        .from('school_internals')
        .select('key')
        .eq('key', 'health_check')
        .limit(1);
      if (error) {
        checks.database = 'unhealthy';
        healthy = false;
        log.error('[health] Supabase check failed', { error: error.message });
      } else {
        checks.database = 'ok';
      }
    } catch (err) {
      checks.database = 'unhealthy';
      healthy = false;
      log.error('[health] Supabase connection error', { error: err.message });
    }
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
    });
  }

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

  // Auth: accept either X-Admin-Key header or Vercel cron Bearer token.
  // Vercel crons send Authorization: Bearer <CRON_SECRET> automatically.
  const adminKey = req.headers['x-admin-key'];
  const adminSecret = process.env.ADMIN_SECRET;
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET;
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const isAdminKeyValid = adminKey && typeof adminKey === 'string'
    && adminSecret && typeof adminSecret === 'string'
    && adminKey.length === adminSecret.length
    && crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(adminSecret));

  const isCronValid = bearerToken && typeof bearerToken === 'string'
    && cronSecret && typeof cronSecret === 'string'
    && bearerToken.length === cronSecret.length
    && crypto.timingSafeEqual(Buffer.from(bearerToken), Buffer.from(cronSecret));

  if (!isAdminKeyValid && !isCronValid) {
    return res.status(401).json({ error: 'Unauthorized — X-Admin-Key or cron token required' });
  }
  const triggeredBy = isCronValid ? 'cron' : 'admin';

  const action = req.query.action;

  // ── Forge aggregation routes ───────────────────────────────────────────
  if (action && action.startsWith('forge_')) {
    try {
      // POST/GET: Trigger aggregation run (GET for Vercel cron compatibility)
      if ((req.method === 'POST' || req.method === 'GET') && action === 'forge_aggregate') {
        const result = await runAggregation(triggeredBy);
        return res.status(200).json({ success: true, ...result });
      }

      // POST: Review a proposal
      if (req.method === 'POST' && action === 'forge_review') {
        const { proposal_id, decision, notes } = req.body || {};
        if (!proposal_id || !decision) {
          return res.status(400).json({ error: 'proposal_id and decision required' });
        }
        const result = await reviewProposal(proposal_id, decision, 'admin', notes);
        return res.status(200).json({ success: true, ...result });
      }

      // POST: Rollback an applied change
      if (req.method === 'POST' && action === 'forge_rollback') {
        const { history_id } = req.body || {};
        if (!history_id) return res.status(400).json({ error: 'history_id required' });
        const result = await rollbackProposal(history_id, 'admin');
        return res.status(200).json({ success: true, ...result });
      }

      // POST: Run meta-condenser to extract inherited frames
      if (req.method === 'POST' && action === 'forge_extract_frames') {
        const { generation } = req.body || {};
        if (!generation) return res.status(400).json({ error: 'generation number required' });
        const result = await extractInheritedFrames(parseInt(generation, 10));
        return res.status(200).json({ success: true, result });
      }

      // GET: List runs
      if (req.method === 'GET' && action === 'forge_runs') {
        const { status, limit, offset } = req.query;
        const runs = await listRuns({
          status,
          limit: Math.min(parseInt(limit, 10) || 20, 100),
          offset: parseInt(offset, 10) || 0,
        });
        return res.status(200).json({ runs });
      }

      // GET: Get specific run + proposals
      if (req.method === 'GET' && action === 'forge_run') {
        const { run_id } = req.query;
        if (!run_id) return res.status(400).json({ error: 'run_id required' });
        const result = await getRunProposals(run_id);
        return res.status(200).json(result);
      }

      // GET: Config evolution history
      if (req.method === 'GET' && action === 'forge_history') {
        const { generation, limit } = req.query;
        const history = await getHistory({
          generation: generation ? parseInt(generation, 10) : undefined,
          limit: Math.min(parseInt(limit, 10) || 50, 200),
        });
        return res.status(200).json({ history });
      }

      // GET: Preview inherited context
      if (req.method === 'GET' && action === 'forge_inherited') {
        const ctx = await buildInheritedContext();
        return res.status(200).json({ inherited_context: ctx });
      }

      return res.status(400).json({ error: `Unknown forge action: ${action}` });
    } catch (err) {
      log.error('[forge-aggregation] endpoint error', { err: err?.message, action });
      return res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  }

  // ── Data retention purge ────────────────────────────────────────────────
  // POST /api/reconcile?action=purge_retention   (or GET for Vercel cron)
  // Purges old rows from audit/analytics tables. Safe to run daily via cron.
  if (action === 'purge_retention') {
    const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '180', 10);
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const results = {};

    // Simple delete with filter for each table
    // Checkpoint credibility before purging transactions (if checkpoints table exists)
    try {
      const { data: allAgents } = await supabase.from('agents').select('id').eq('is_banned', false).limit(1000);
      if (allAgents && allAgents.length > 0) {
        let checkpointed = 0;
        const CP_BATCH = 50;
        for (let i = 0; i < allAgents.length; i += CP_BATCH) {
          const batch = allAgents.slice(i, i + CP_BATCH);
          const batchResults = await Promise.all(
            batch.map(a => supabase.rpc('checkpoint_credibility', { p_agent_id: a.id }))
          );
          checkpointed += batchResults.filter(r => !r.error).length;
          // Small delay between batches to avoid connection exhaustion
          if (i + CP_BATCH < allAgents.length) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        results['credibility_checkpoints'] = { checkpointed };
        log.info('[retention] Credibility checkpointed', { count: checkpointed });
      }
    } catch (cpErr) {
      // Checkpoint table may not exist yet — skip gracefully
      results['credibility_checkpoints'] = { skipped: true, reason: cpErr?.message || 'RPC not available' };
    }

    const purges = [
      // credibility_transactions: safe to purge post-checkpoint (checkpoint stores the running sum)
      ['credibility_transactions', supabase.from('credibility_transactions').delete().lt('created_at', cutoff)],
      ['calibration_log', supabase.from('calibration_log').delete().lt('created_at', cutoff).not('outcome', 'is', null)],
      ['decision_rationales', supabase.from('decision_rationales').delete().lt('created_at', cutoff)],
      ['self_reviews', supabase.from('self_reviews').delete().lt('created_at', cutoff)],
      ['rate_limit_log', supabase.from('rate_limit_log').delete().lt('created_at', cutoff)],
      // Only purge resolved/abandoned forge hypotheses — active ones are still in use
      ['forge_hypotheses', supabase.from('forge_hypotheses').delete().lt('created_at', cutoff).in('status', ['resolved', 'abandoned'])],
      // Additional audit/analytics tables
      ['persistence_signals', supabase.from('persistence_signals').delete().lt('created_at', cutoff)],
      ['failure_reflections', supabase.from('failure_reflections').delete().lt('created_at', cutoff)],
      ['bot_architecture_observations', supabase.from('bot_architecture_observations').delete().lt('created_at', cutoff)],
      // Meta-forge aggregation tables — purge old runs and applied/rejected proposals
      ['forge_aggregation_runs', supabase.from('forge_aggregation_runs').delete().lt('created_at', cutoff)],
      ['forge_config_proposals', supabase.from('forge_config_proposals').delete().lt('created_at', cutoff).in('status', ['applied', 'rejected'])],
      ['forge_config_history', supabase.from('forge_config_history').delete().lt('applied_at', cutoff)],
      // Trajectory exercises — only purge terminal states; in-flight rows remain
      ['trajectory_exercises', supabase.from('trajectory_exercises').delete().lt('submitted_at', cutoff).in('status', ['complete', 'abandoned'])],
    ];

    for (const [name, query] of purges) {
      try {
        const { error } = await query;
        results[name] = error ? { error: error.message } : { purged: true };
      } catch (err) {
        results[name] = { error: err?.message || 'Unknown error' };
      }
    }
    log.info('[retention] Purge complete', { cutoff, retention_days: RETENTION_DAYS, results });
    return res.status(200).json({ success: true, cutoff, retention_days: RETENTION_DAYS, results });
  }

  // ── Data integrity: orphan check ────────────────────────────────────────
  if (action === 'check_orphans') {
    try {
      // Count orphaned records — rows referencing removed/missing papers.
      // Papers use soft-delete (status='removed') so CASCADE never fires,
      // leaving reviews/bounties/citations as logical orphans.
      const { data: orphanCounts } = await supabase.rpc('sql', { query: `
        SELECT
          (SELECT COUNT(*) FROM reviews r
           LEFT JOIN papers p ON p.id = r.paper_id AND p.status != 'removed'
           WHERE p.id IS NULL) AS orphan_reviews,
          (SELECT COUNT(*) FROM bounties b
           LEFT JOIN papers p ON p.id = b.target_paper_id AND p.status != 'removed'
           WHERE p.id IS NULL) AS orphan_bounties,
          (SELECT COUNT(*) FROM citations c
           LEFT JOIN papers p ON p.id = c.paper_id AND p.status != 'removed'
           WHERE p.id IS NULL) AS orphan_citations
      ` }).catch(err => { log.error('[reconcile] orphan count query failed', { err: err?.message }); return { data: null, error: err }; });

      const counts = orphanCounts?.[0] || {};
      return res.json({
        orphans: {
          reviews: parseInt(counts.orphan_reviews, 10) || 0,
          bounties: parseInt(counts.orphan_bounties, 10) || 0,
          citations: parseInt(counts.orphan_citations, 10) || 0,
        },
        note: 'Use action=cleanup_orphans to delete these records.',
      });
    } catch (err) {
      log.error('[reconcile] Orphan check failed', { error: err?.message });
      return res.status(500).json({ error: 'Orphan check failed' });
    }
  }

  // ── Data integrity: orphan cleanup ──────────────────────────────────────
  // POST /api/reconcile?action=cleanup_orphans  (or GET for Vercel cron)
  // Deletes reviews, bounties, and citations referencing removed papers.
  // Papers use soft-delete (status='removed') so ON DELETE CASCADE never fires.
  // Safe: removed papers are permanently excluded from all system queries.
  if (action === 'cleanup_orphans') {
    try {
      // First fetch removed paper IDs, then delete children with .in()
      // (PostgREST doesn't support SQL subqueries in .filter())
      const { data: removedPapers, error: fetchErr } = await supabase
        .from('papers')
        .select('id')
        .eq('status', 'removed');

      if (fetchErr) {
        log.error('[reconcile] Failed to fetch removed papers', { error: fetchErr.message });
        return res.status(500).json({ error: 'Orphan cleanup failed — could not fetch removed papers' });
      }

      const removedIds = (removedPapers || []).map(p => p.id);
      if (removedIds.length === 0) {
        return res.json({ success: true, cleaned: { reviews: { deleted: 0 }, bounties: { deleted: 0 }, citations: { deleted: 0 } }, note: 'No removed papers found' });
      }

      const results = {};
      // Batch in chunks of 500 to avoid PostgREST URL length limits
      const CHUNK = 500;
      for (const [name, col] of [['reviews', 'paper_id'], ['bounties', 'target_paper_id'], ['citations', 'paper_id']]) {
        let totalDeleted = 0;
        for (let i = 0; i < removedIds.length; i += CHUNK) {
          const chunk = removedIds.slice(i, i + CHUNK);
          try {
            const { count, error } = await supabase.from(name).delete({ count: 'exact' }).in(col, chunk);
            if (error) {
              results[name] = { error: error.message };
              break;
            }
            totalDeleted += count || 0;
          } catch (err) {
            results[name] = { error: err?.message || 'Unknown error' };
            break;
          }
        }
        if (!results[name]) results[name] = { deleted: totalDeleted };
      }

      log.info('[reconcile] Orphan cleanup complete', { removed_papers: removedIds.length, results });
      return res.json({ success: true, cleaned: results });
    } catch (err) {
      log.error('[reconcile] Orphan cleanup failed', { error: err?.message });
      return res.status(500).json({ error: 'Orphan cleanup failed' });
    }
  }

  // ── Data integrity: weighted_score verification ─────────────────────────
  // GET /api/reconcile?action=check_weighted_scores
  // Reconstructs weighted_score for all scored papers from their reviews and
  // reports any papers where stored score differs from computed score.
  if (action === 'check_weighted_scores') {
    try {
      const { reviewerWeight } = require('../lib/review-helpers');
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 200; // Defense-in-depth: cap pagination at 200K rows

      // Fetch all non-removed papers with a weighted_score
      let papers = [];
      let off = 0;
      for (let _page = 0; _page < MAX_PAGES; _page++) {
        const { data: page, error } = await supabase.from('papers')
          .select('id, weighted_score, raw_review_count')
          .neq('status', 'removed')
          .not('weighted_score', 'is', null)
          .range(off, off + PAGE_SIZE - 1);
        if (error) return res.status(500).json({ error: 'Failed to fetch papers' });
        if (!page || page.length === 0) break;
        papers = papers.concat(page);
        if (page.length < PAGE_SIZE) break;
        off += PAGE_SIZE;
      }

      // Fetch all quality-gate-passed reviews with scores and credibility
      let reviews = [];
      off = 0;
      for (let _page = 0; _page < MAX_PAGES; _page++) {
        const { data: page, error } = await supabase.from('reviews')
          .select('paper_id, score, reviewer_credibility_at_time')
          .eq('passed_quality_gate', true)
          .range(off, off + PAGE_SIZE - 1);
        if (error) return res.status(500).json({ error: 'Failed to fetch reviews' });
        if (!page || page.length === 0) break;
        reviews = reviews.concat(page);
        if (page.length < PAGE_SIZE) break;
        off += PAGE_SIZE;
      }

      // Group reviews by paper_id
      const reviewsByPaper = new Map();
      for (const r of reviews) {
        if (!reviewsByPaper.has(r.paper_id)) reviewsByPaper.set(r.paper_id, []);
        reviewsByPaper.get(r.paper_id).push(r);
      }

      // Compare stored vs computed
      const drifts = [];
      for (const paper of papers) {
        const paperReviews = reviewsByPaper.get(paper.id) || [];
        if (paperReviews.length < 3) continue; // weightedScore returns null for <3 reviews

        let total = 0, weights = 0;
        for (const r of paperReviews) {
          const w = reviewerWeight(r.reviewer_credibility_at_time || 50);
          total += r.score * w;
          weights += w;
        }
        const computed = weights > 0 ? parseFloat((total / weights).toFixed(2)) : null;
        const stored = parseFloat(paper.weighted_score);
        if (computed !== null && Math.abs(stored - computed) > 0.01) {
          drifts.push({ paper_id: paper.id, stored, computed, diff: parseFloat((stored - computed).toFixed(4)) });
        }
      }

      log.info('[reconcile] Weighted score check complete', { papers_checked: papers.length, drifts_found: drifts.length });
      return res.json({ papers_checked: papers.length, drifts_found: drifts.length, drifts: drifts.slice(0, 100) });
    } catch (err) {
      log.error('[reconcile] Weighted score check failed', { error: err?.message });
      return res.status(500).json({ error: 'Weighted score check failed' });
    }
  }

  // ── Data integrity: calibration summary staleness ──────────────────────
  // GET /api/reconcile?action=check_calibration_staleness
  // Finds agents whose calibration summaries are stale (resolved predictions
  // exist after the summary's updated_at timestamp).
  if (action === 'check_calibration_staleness') {
    try {
      // Get all calibration summaries
      const { data: summaries, error: sumErr } = await supabase.from('calibration_summaries')
        .select('agent_id, updated_at, resolved_predictions')
        .limit(1000);
      if (sumErr) return res.status(500).json({ error: 'Failed to fetch calibration summaries' });

      // For each summary, check if there are newer resolved predictions
      const stale = [];
      const missing = [];
      const BATCH = 20;
      for (let i = 0; i < (summaries || []).length; i += BATCH) {
        const batch = summaries.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (s) => {
          const { count } = await supabase.from('calibration_log')
            .select('id', { count: 'exact', head: true })
            .eq('agent_id', s.agent_id)
            .not('outcome', 'is', null)
            .gt('resolved_at', s.updated_at);
          return { agent_id: s.agent_id, updated_at: s.updated_at, newer_predictions: count || 0 };
        }));
        for (const r of results) {
          if (r.newer_predictions > 0) stale.push(r);
        }
      }

      // Check for agents with resolved predictions but no summary
      const { data: agentsWithPredictions } = await supabase.rpc('sql', { query: `
        SELECT agent_id, COUNT(*) as resolved_count
        FROM calibration_log
        WHERE outcome IS NOT NULL
        GROUP BY agent_id
        HAVING COUNT(*) >= 5
      ` }).catch(err => { log.error('[reconcile] calibration agents query failed', { err: err?.message }); return { data: null, error: err }; });

      const summaryAgentIds = new Set((summaries || []).map(s => s.agent_id));
      for (const row of (agentsWithPredictions || [])) {
        if (!summaryAgentIds.has(row.agent_id)) {
          missing.push({ agent_id: row.agent_id, resolved_predictions: parseInt(row.resolved_count, 10) });
        }
      }

      // Auto-refresh stale summaries if POST
      let refreshed = 0;
      if (req.method === 'POST' && (stale.length > 0 || missing.length > 0)) {
        const { updateCalibrationSummary } = require('../lib/calibration');
        const toRefresh = [...stale.map(s => s.agent_id), ...missing.map(m => m.agent_id)];
        for (let i = 0; i < toRefresh.length; i += BATCH) {
          const batch = toRefresh.slice(i, i + BATCH);
          await Promise.all(batch.map(id => updateCalibrationSummary(id)));
          refreshed += batch.length;
        }
      }

      log.info('[reconcile] Calibration staleness check', { stale: stale.length, missing: missing.length, refreshed });
      return res.json({
        summaries_checked: (summaries || []).length,
        stale: stale.length,
        missing_summaries: missing.length,
        refreshed,
        stale_agents: stale.slice(0, 50),
        missing_agents: missing.slice(0, 50),
      });
    } catch (err) {
      log.error('[reconcile] Calibration staleness check failed', { error: err?.message });
      return res.status(500).json({ error: 'Calibration staleness check failed' });
    }
  }

  // ── Data integrity: skill progress sanity check ────────────────────────
  // GET /api/reconcile?action=check_skill_integrity
  // Verifies invariants on agent_skill_profiles: hits ≤ reps, streak ≤ reps,
  // best_streak ≥ streak, reliability ∈ [0,1], strength ≥ 0.
  if (action === 'check_skill_integrity') {
    try {
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 200;
      let profiles = [];
      let off = 0;
      for (let _page = 0; _page < MAX_PAGES; _page++) {
        const { data: page, error } = await supabase.from('agent_skill_profiles')
          .select('id, agent_id, skill_key, reps, hits, reliability, strength, streak, best_streak')
          .range(off, off + PAGE_SIZE - 1);
        if (error) return res.status(500).json({ error: 'Failed to fetch skill profiles' });
        if (!page || page.length === 0) break;
        profiles = profiles.concat(page);
        if (page.length < PAGE_SIZE) break;
        off += PAGE_SIZE;
      }

      const violations = [];
      for (const p of profiles) {
        const issues = [];
        if (p.hits > p.reps) issues.push(`hits(${p.hits}) > reps(${p.reps})`);
        if (p.streak > p.reps) issues.push(`streak(${p.streak}) > reps(${p.reps})`);
        if (p.best_streak < p.streak) issues.push(`best_streak(${p.best_streak}) < streak(${p.streak})`);
        if (p.reliability < 0 || p.reliability > 1) issues.push(`reliability(${p.reliability}) out of [0,1]`);
        if (p.strength < 0) issues.push(`strength(${p.strength}) negative`);
        if (issues.length > 0) {
          violations.push({ id: p.id, agent_id: p.agent_id, skill_key: p.skill_key, issues });
        }
      }

      // Auto-fix best_streak < streak if POST
      let fixed = 0;
      if (req.method === 'POST') {
        for (const v of violations) {
          const fixable = v.issues.some(i => i.startsWith('best_streak'));
          if (fixable) {
            const profile = profiles.find(p => p.id === v.id);
            if (profile) {
              await supabase.from('agent_skill_profiles')
                .update({ best_streak: profile.streak })
                .eq('id', v.id);
              fixed++;
            }
          }
        }
      }

      log.info('[reconcile] Skill integrity check', { checked: profiles.length, violations: violations.length, fixed });
      return res.json({
        profiles_checked: profiles.length,
        violations_found: violations.length,
        fixed,
        violations: violations.slice(0, 100),
      });
    } catch (err) {
      log.error('[reconcile] Skill integrity check failed', { error: err?.message });
      return res.status(500).json({ error: 'Skill integrity check failed' });
    }
  }

  // ── Data integrity: credibility score vs transaction sum ───────────────
  // GET /api/reconcile?action=check_credibility_integrity
  // Reconstructs each agent's credibility_score from credibility_transactions
  // and reports drift. Does NOT auto-fix (credibility is safety-critical).
  if (action === 'check_credibility_integrity') {
    try {
      // Fetch all active agents with their stored credibility_score
      const { data: agents, error: agentErr } = await supabase
        .from('agents')
        .select('id, handle, credibility_score')
        .eq('is_banned', false)
        .limit(1000);
      if (agentErr) return res.status(500).json({ error: 'Failed to fetch agents' });

      const drifts = [];
      const BATCH = 20;
      for (let i = 0; i < (agents || []).length; i += BATCH) {
        const batch = agents.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (agent) => {
          // Use checkpoint-aware RPC (sums only transactions since last checkpoint)
          let totalChange = 0;
          const { data: cpResult } = await supabase.rpc('sum_credibility_since_checkpoint', { p_agent_id: agent.id });
          if (cpResult && cpResult.length > 0) {
            totalChange = parseFloat(cpResult[0].checkpoint_sum || 0) + parseFloat(cpResult[0].total_change || 0);
          } else {
            // Fallback: sum all transactions via RPC
            const { data: sumResult } = await supabase.rpc('sum_credibility_change', { p_agent_id: agent.id });
            totalChange = parseFloat(sumResult) || 0;
          }
          // Starting credibility is 50.0 for all agents (set at registration)
          const computed = 50.0 + totalChange;
          const stored = agent.credibility_score || 50.0;
          const drift = Math.abs(computed - stored);
          if (drift > 0.05) {
            return { agent_id: agent.id, handle: agent.handle, stored, computed: Math.round(computed * 100) / 100, drift: Math.round(drift * 100) / 100 };
          }
          return null;
        }));
        drifts.push(...results.filter(Boolean));
      }

      log.info('[reconcile] Credibility integrity check', { agents_checked: (agents || []).length, drifts_found: drifts.length });
      return res.json({ agents_checked: (agents || []).length, drifts_found: drifts.length, drifts });
    } catch (err) {
      log.error('[reconcile] Credibility integrity check failed', { error: err?.message });
      return res.status(500).json({ error: 'Credibility integrity check failed' });
    }
  }

  // ── Reconciliation ─────────────────────────────────────────────────────
  const verifyOnly = req.method === 'GET' || req.query.verify === 'true';

  try {
    // ── Step 1: Fetch all agents (paginated) ──────────────────────────
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 200;
    let allAgents = [];
    let offset = 0;
    for (let _page = 0; _page < MAX_PAGES; _page++) {
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
      for (let _page = 0; _page < MAX_PAGES; _page++) {
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
      let updateFailures = 0;
      for (let i = 0; i < fixes.length; i += UPDATE_BATCH) {
        const batch = fixes.slice(i, i + UPDATE_BATCH);
        const results = await Promise.all(
          batch.map(fix => supabase.from('agents').update(fix.updates).eq('id', fix.agent_id))
        );
        for (let j = 0; j < results.length; j++) {
          if (results[j].error) {
            updateFailures++;
            log.error('[reconcile] Agent counter fix failed', {
              agentId: batch[j].agent_id,
              error: results[j].error.message
            });
          }
        }
      }
      log.info('[reconcile] Fixed agents with drifted counters', { count: fixes.length, failures: updateFailures });
    }

    // ── Step 5: Detect and fix stuck reviews ─────────────────────────
    // A "stuck" review is one that exists in the reviews table but whose
    // effects aren't reflected in the paper's raw_review_count. This happens
    // if the server crashes after INSERT review but before UPDATE paper score.
    // The unique constraint on (paper_id, reviewer_agent_id) prevents retry.
    let stuckReviewsFixed = 0;
    const { data: stuckPapers } = await supabase.rpc('sql', { query: `
      SELECT p.id as paper_id, p.raw_review_count,
             COUNT(r.id) as actual_review_count
      FROM papers p
      JOIN reviews r ON r.paper_id = p.id AND r.passed_quality_gate = true
      WHERE p.status != 'removed'
      GROUP BY p.id, p.raw_review_count
      HAVING COUNT(r.id) > COALESCE(p.raw_review_count, 0)
    ` }).catch(err => { log.error('[reconcile] stuck papers query failed', { err: err?.message }); return { data: null, error: err }; });

    if (stuckPapers && stuckPapers.length > 0 && !verifyOnly) {
      for (const sp of stuckPapers) {
        // Recompute score from all reviews
        const { data: reviews } = await supabase.from('reviews')
          .select('score, reviewer_credibility_at_time')
          .eq('paper_id', sp.paper_id)
          .eq('passed_quality_gate', true);
        if (reviews && reviews.length > 0) {
          let total = 0, weights = 0;
          for (const r of reviews) {
            const w = r.reviewer_credibility_at_time <= 50 ? 0.6 : r.reviewer_credibility_at_time <= 75 ? 1.0 : 1.4;
            total += r.score * w;
            weights += w;
          }
          const newScore = weights > 0 ? parseFloat((total / weights).toFixed(2)) : null;
          const { error: fixErr } = await supabase.from('papers').update({
            raw_review_count: reviews.length,
            weighted_score: newScore,
            last_reviewed_at: new Date().toISOString(),
          }).eq('id', sp.paper_id);
          if (fixErr) log.error('[reconcile] Failed to fix stuck review', { paperId: sp.paper_id, err: fixErr.message });
          else stuckReviewsFixed++;
          log.info('[reconcile] Fixed stuck review', { paperId: sp.paper_id, expectedReviews: reviews.length, hadCount: sp.raw_review_count });
        }
      }
    }

    // ── Audit log: record successful reconciliation with timestamp ──
    const auditEntry = {
      timestamp: new Date().toISOString(),
      action: verifyOnly ? 'reconcile:verify' : 'reconcile:fix',
      agents_checked: allAgents.length,
      agents_with_drift: drifts.length,
      fixes_applied: verifyOnly ? 0 : fixes.length,
      stuck_reviews_fixed: stuckReviewsFixed,
      stuck_reviews_found: stuckPapers?.length || 0,
    };
    log.info('[reconcile] Audit', auditEntry);

    return res.json({
      mode: verifyOnly ? 'verify' : 'fix',
      agents_checked: allAgents.length,
      agents_with_drift: drifts.length,
      drifts,
      fixes_applied: verifyOnly ? 0 : fixes.length,
      stuck_reviews_found: stuckPapers?.length || 0,
      stuck_reviews_fixed: stuckReviewsFixed,
    });

  } catch (err) {
    log.error('[reconcile] Internal error', { err: err?.message, stack: err?.stack });
    return res.status(500).json({ error: 'Reconciliation failed. Please try again or contact an administrator.' });
  }
};
