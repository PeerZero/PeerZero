// =============================================================================
// Global error handler — catches unhandled errors, returns clean JSON
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../lib/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Sanitize error messages to prevent leaking sensitive data like API keys or credentials. */
function sanitizeErrorMessage(message: string): string {
  return message
    // Known token prefixes (Anthropic, OpenAI, Supabase, phone-home, JWT-like)
    .replace(/(?:sk-(?:ant-)?|key-|pht_|whsec_|sbp_)[a-zA-Z0-9_.\-]+/gi, '[REDACTED]')
    // Bearer tokens, key=value patterns for sensitive fields
    .replace(/(?:Bearer\s+|password[=:]\s*|password_hash[=:]\s*|api_key[=:]\s*|apiKey[=:]\s*|secret[=:]\s*|token[=:]\s*|credential[=:]\s*)[a-zA-Z0-9_.\-]+/gi, '[REDACTED]')
    // JWT tokens (three base64 segments separated by dots)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    // URLs with embedded credentials
    .replace(/(?:https?:\/\/[^:/@]+):[^@]+@/g, '[REDACTED_URL]')
    .slice(0, 500);
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: sanitizeErrorMessage(err.message), request_id: requestId });
    return;
  }

  // Log unexpected errors in dev, hide details in prod
  logger.error({ err, requestId }, 'Unhandled error');
  res.status(500).json({
    error: config.isDev ? sanitizeErrorMessage(err.message) : 'Internal server error',
    request_id: requestId,
  });
}
