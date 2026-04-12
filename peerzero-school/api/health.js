/**
 * GET /api/health — Health check endpoint for monitoring and uptime probes.
 *
 * Tests downstream dependencies (Supabase) and returns status.
 * No authentication required — this must be callable by uptime monitors.
 */

const { getSupabase, setCorsHeaders } = require('../lib/shared');
const log = require('../lib/logger');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const checks = { database: 'unknown' };
  let healthy = true;

  // Test Supabase connectivity with a lightweight query
  try {
    const supabase = getSupabase();
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

  const status = healthy ? 200 : 503;
  return res.status(status).json({
    status: healthy ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks,
  });
};
