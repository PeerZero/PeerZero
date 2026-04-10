// =============================================================================
// Meta-Forge Aggregation endpoint
//
// POST /api/forge-aggregation                     → trigger aggregation run
// GET  /api/forge-aggregation                     → list runs
// GET  /api/forge-aggregation?run_id=X            → get run details + proposals
// POST /api/forge-aggregation?action=review       → approve/reject a proposal
// POST /api/forge-aggregation?action=rollback     → rollback an applied change
// GET  /api/forge-aggregation?action=history      → config evolution history
// GET  /api/forge-aggregation?action=inherited    → preview inherited context
//
// Protected by admin secret (X-Admin-Key header).
// =============================================================================

const crypto = require('crypto');
const { setCorsHeaders, isCsrfRejected, isRateLimited } = require('../lib/shared');
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
} = require('../lib/forge-aggregation');

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (checkMockGuard(req, res)) return;

  // Rate limit: 20 requests per hour per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(`forge-agg:${ip}`, 20, 3600000)) {
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }

  // CSRF protection
  if (isCsrfRejected(req)) {
    return res.status(403).json({ error: 'Forbidden — origin not allowed' });
  }

  // Admin-only: constant-time key comparison
  const adminKey = req.headers['x-admin-key'];
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminKey || typeof adminKey !== 'string'
      || !adminSecret || typeof adminSecret !== 'string'
      || adminKey.length !== adminSecret.length
      || !crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(adminSecret))) {
    return res.status(401).json({ error: 'Unauthorized — X-Admin-Key required' });
  }

  const action = req.query.action;

  try {
    // ── POST: Trigger aggregation run ─────────────────────────────────
    if (req.method === 'POST' && !action) {
      const result = await runAggregation('admin');
      return res.status(200).json({ success: true, ...result });
    }

    // ── POST: Review a proposal ───────────────────────────────────────
    if (req.method === 'POST' && action === 'review') {
      const { proposal_id, decision, notes } = req.body || {};
      if (!proposal_id || !decision) {
        return res.status(400).json({ error: 'proposal_id and decision required' });
      }
      const result = await reviewProposal(proposal_id, decision, 'admin', notes);
      return res.status(200).json({ success: true, ...result });
    }

    // ── POST: Rollback an applied change ──────────────────────────────
    if (req.method === 'POST' && action === 'rollback') {
      const { history_id } = req.body || {};
      if (!history_id) {
        return res.status(400).json({ error: 'history_id required' });
      }
      const result = await rollbackProposal(history_id, 'admin');
      return res.status(200).json({ success: true, ...result });
    }

    // ── GET: List runs or get specific run ────────────────────────────
    if (req.method === 'GET' && !action) {
      const { run_id, status, limit, offset } = req.query;

      if (run_id) {
        const result = await getRunProposals(run_id);
        return res.status(200).json(result);
      }

      const runs = await listRuns({
        status,
        limit: Math.min(parseInt(limit) || 20, 100),
        offset: parseInt(offset) || 0,
      });
      return res.status(200).json({ runs });
    }

    // ── GET: Config evolution history ─────────────────────────────────
    if (req.method === 'GET' && action === 'history') {
      const { generation, limit } = req.query;
      const history = await getHistory({
        generation: generation ? parseInt(generation) : undefined,
        limit: Math.min(parseInt(limit) || 50, 200),
      });
      return res.status(200).json({ history });
    }

    // ── GET: Preview inherited context ────────────────────────────────
    if (req.method === 'GET' && action === 'inherited') {
      const ctx = await buildInheritedContext();
      return res.status(200).json({ inherited_context: ctx });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    log.error('[forge-aggregation] endpoint error', { err: err?.message, action });
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};
