/**
 * Catch-all handler for unknown API routes.
 * Returns a JSON 404 instead of Vercel's default HTML or the landing page.
 */
const { setCorsHeaders } = require('../lib/shared');

module.exports = (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  res.status(404).json({ error: 'Not found' });
};
