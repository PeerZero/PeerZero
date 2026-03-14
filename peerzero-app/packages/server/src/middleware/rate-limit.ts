// =============================================================================
// Rate limiting — per-IP limits for auth routes, per-user for API routes
// =============================================================================

import rateLimit from 'express-rate-limit';

/** Strict limit for auth endpoints (login, register) — 10 req / 15 min */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

/** General API limit — 100 req / min */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded.' },
});
