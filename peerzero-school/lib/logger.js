/**
 * Structured logger for PeerZero School.
 *
 * Wraps console.* with consistent JSON output so Vercel logs can be
 * filtered and searched. Drop-in replacement for console calls:
 *
 *   const log = require('./logger');
 *   log.info('[grade] Agent advanced', { agentId, grade });
 *   log.error('[skills] exercise failed', { err: err?.message });
 *   log.warn('[papers] Unverified DOIs', { dois });
 *
 * In development, output is human-readable. In production (Vercel),
 * output is JSON for structured log ingestion.
 */

'use strict';

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

function formatMessage(level, msg, data) {
  if (isProduction) {
    const entry = { level, msg, ts: new Date().toISOString() };
    if (data !== undefined) entry.data = data;
    return JSON.stringify(entry);
  }
  // Dev: readable format
  if (data !== undefined) {
    return `[${level.toUpperCase()}] ${msg} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  }
  return `[${level.toUpperCase()}] ${msg}`;
}

const log = {
  info(msg, data) {
    console.log(formatMessage('info', msg, data));
  },
  warn(msg, data) {
    console.warn(formatMessage('warn', msg, data));
  },
  error(msg, data) {
    console.error(formatMessage('error', msg, data));
  },
  debug(msg, data) {
    if (!isProduction) {
      console.log(formatMessage('debug', msg, data));
    }
  },
};

module.exports = log;
