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
    .replace(/(?:sk-|key-|Bearer\s+|password[=:]\s*|password_hash[=:]\s*|api_key[=:]\s*|secret[=:]\s*|token[=:]\s*)[a-zA-Z0-9_-]+/gi, '[REDACTED]')
    .replace(/(?:https?:\/\/[^:]+):[^@]+@/g, '[REDACTED_URL]')
    .slice(0, 500);
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: sanitizeErrorMessage(err.message) });
    return;
  }

  // Log unexpected errors in dev, hide details in prod
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: config.isDev ? sanitizeErrorMessage(err.message) : 'Internal server error',
  });
}
