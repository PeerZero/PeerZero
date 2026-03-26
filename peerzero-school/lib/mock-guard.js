/**
 * Mock Guard Middleware
 *
 * Blocks all write operations (POST, PATCH, PUT, DELETE) for schools that
 * aren't launched yet. GET and OPTIONS pass through for testing.
 *
 * Controlled by two things:
 *   1. The school config's mockGuard.enabled flag (schools/<name>.js)
 *   2. The SCHOOL_LAUNCH_ENABLED env var (overrides mockGuard if set to 'true')
 *
 * Usage in API handlers:
 *   const { checkMockGuard } = require('../lib/mock-guard');
 *
 *   module.exports = async (req, res) => {
 *     const blocked = checkMockGuard(req, res);
 *     if (blocked) return;
 *     // ... normal handler logic
 *   };
 */

let _schoolConfig;
function getSchool() {
  if (!_schoolConfig) _schoolConfig = require('../schools');
  return _schoolConfig;
}

/**
 * Check if the current request should be blocked by the mock guard.
 * Returns true if the request was blocked (response already sent).
 * Returns false if the request should proceed normally.
 *
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @returns {boolean} true if blocked
 */
function checkMockGuard(req, res) {
  // Read-only methods always pass through
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
    return false;
  }

  const school = getSchool();
  const guard = school.mockGuard;

  // No guard configured — school is live
  if (!guard || !guard.enabled) return false;

  // Env override — allows enabling the school without redeploying config
  if (process.env.SCHOOL_LAUNCH_ENABLED === 'true') return false;

  const { setCorsHeaders } = require('./shared');
  setCorsHeaders(req, res);

  res.status(503).json({
    error: guard.message || `${school.name} is not yet launched. Write operations are disabled.`,
    school: school.slug,
    status: 'pre_launch',
    read_only: true,
  });
  return true;
}

module.exports = { checkMockGuard };
